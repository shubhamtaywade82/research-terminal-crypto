// Main-thread API for the store worker (see store-worker.ts). Every call posts work to one
// worker thread and resolves when the worker has answered. The worker starts on first use,
// is unref'd so it never holds the process open, and is replaced if it dies.

import { Worker } from 'node:worker_threads';
import { resolveDatabaseUrl } from '@/lib/db-url';
import type { FundingJoined } from '@/lib/ingest';
import type { KlineSeries } from '@/lib/datasources/decode-pool';
import { STORE_WORKER_SOURCE } from './store-worker';

export interface DatasetWrite {
  symbol: string;
  interval: string;
  last: KlineSeries;
  mark: KlineSeries;
  funding: FundingJoined;
  /** Progress inside the write transaction, for diagnostics. */
  onStage?: (what: string) => void;
}

export interface CandleCoverage {
  symbol: string;
  interval: string;
  kind: string;
  count: number;
  fromMs: number | null;
  toMs: number | null;
}

export interface StoreCoverage {
  candles: CandleCoverage[];
  funding: { symbol: string; count: number }[];
}

type Reply = { id: number; ok?: boolean; stage?: string; result?: unknown; error?: string };
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onStage?: (what: string) => void;
}

// Passed by name: an eval worker resolves `require` from the process working directory.
// That is the project root in dev and tests, and .next/standalone in the production
// server, where the traced node_modules sit. (require.resolve is not used here: the bundler
// rewrites it to a numeric module id.)
const LIBSQL_MODULE = '@libsql/client';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(error: Error): void {
  for (const p of pending.values()) p.reject(error);
  pending.clear();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(STORE_WORKER_SOURCE, { eval: true, workerData: { libsqlModule: LIBSQL_MODULE } });
  w.unref();
  w.on('message', (reply: Reply) => {
    const p = pending.get(reply.id);
    if (!p) return;
    if (reply.stage !== undefined) {
      p.onStage?.(reply.stage);
      return;
    }
    pending.delete(reply.id);
    if (reply.ok) p.resolve(reply.result);
    else p.reject(new Error(reply.error ?? 'store operation failed'));
  });
  const drop = (error: Error) => {
    if (worker === w) worker = null;
    failAll(error);
    void w.terminate().catch(() => undefined);
  };
  w.on('error', (e: unknown) => drop(e instanceof Error ? e : new Error(String(e))));
  w.on('exit', (code: number) => drop(new Error(`store worker exited with code ${code}`)));
  worker = w;
  return w;
}

/** Every distinct ArrayBuffer behind the series, for zero-copy transfer. */
function buffersOf(...arrays: ArrayBufferView[]): ArrayBuffer[] {
  return [...new Set(arrays.map((a) => a.buffer as ArrayBuffer))];
}

/**
 * Replace one symbol/interval dataset atomically in the store worker.
 *
 * The series are TRANSFERRED, not copied: the caller's typed arrays are detached when this
 * is called and must not be read afterwards. Capture any lengths first.
 */
export function writeDataset(w: DatasetWrite): Promise<void> {
  const url = resolveDatabaseUrl();
  const id = nextId++;
  const transfer = buffersOf(
    w.last.t, w.last.o, w.last.h, w.last.l, w.last.c, w.last.v,
    w.mark.t, w.mark.o, w.mark.h, w.mark.l, w.mark.c, w.mark.v,
    w.funding.t, w.funding.rate, w.funding.markPrice,
  );
  return new Promise<void>((resolve, reject) => {
    pending.set(id, { resolve: () => resolve(), reject, onStage: w.onStage });
    ensureWorker().postMessage(
      {
        id,
        op: 'replace',
        url,
        symbol: w.symbol,
        interval: w.interval,
        last: w.last,
        mark: w.mark,
        funding: w.funding,
      },
      transfer,
    );
  });
}

/** Per-dataset coverage, aggregated on the store worker (never on the server thread). */
export function storeCoverage(): Promise<StoreCoverage> {
  const url = resolveDatabaseUrl();
  const id = nextId++;
  return new Promise<StoreCoverage>((resolve, reject) => {
    pending.set(id, { resolve: (v) => resolve(v as StoreCoverage), reject });
    ensureWorker().postMessage({ id, op: 'coverage', url });
  });
}

/** Stop the store worker (tests and orderly shutdown). A later call starts a fresh one. */
export async function stopStoreWorker(): Promise<void> {
  const w = worker;
  worker = null;
  failAll(new Error('store worker stopped'));
  if (w) await w.terminate();
}
