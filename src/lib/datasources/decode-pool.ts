// Main-thread API for the decode worker. Every call posts work to one worker thread and
// resolves with typed-array results. The worker is created on first use, kept alive
// without holding the process open, and replaced if it dies.

import { Worker } from 'node:worker_threads';
import { DECODE_WORKER_SOURCE } from './decode-worker';

/** Klines as parallel arrays, time-sorted, one row per open time. */
export interface KlineSeries {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
}

export interface FundingSeries {
  t: Float64Array;
  rate: Float64Array;
}

export interface TradeSeries {
  t: Float64Array;
  p: Float64Array;
}

export const KLINE_FIELDS = ['o', 'h', 'l', 'c', 'v'] as const;
export const FUNDING_FIELDS = ['rate'] as const;

type Reply = { id: number; ok: boolean; result?: unknown; error?: string };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(error: Error): void {
  for (const p of pending.values()) p.reject(error);
  pending.clear();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(DECODE_WORKER_SOURCE, { eval: true });
  w.unref();
  w.on('message', (reply: Reply) => {
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    if (reply.ok) p.resolve(reply.result);
    else p.reject(new Error(reply.error ?? 'decode failed'));
  });
  const drop = (error: Error) => {
    if (worker === w) worker = null;
    failAll(error);
    void w.terminate().catch(() => undefined);
  };
  w.on('error', (e: unknown) => drop(e instanceof Error ? e : new Error(String(e))));
  w.on('exit', (code: number) => drop(new Error(`decode worker exited with code ${code}`)));
  worker = w;
  return w;
}

function call<T>(message: Record<string, unknown>, transfer: ArrayBuffer[]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    ensureWorker().postMessage({ id, ...message }, transfer);
  });
}

/** Standalone copy of the bytes, so they can be transferred to the worker without detaching the caller's buffer. */
function copyBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Decode one klines zip (monthly or daily). Throws if the zip is malformed. */
export function decodeKlinesZip(bytes: Uint8Array, startMs: number, endMs: number): Promise<KlineSeries> {
  const buf = copyBytes(bytes);
  return call<KlineSeries>({ op: 'klines', bytes: buf, startMs, endMs }, [buf]);
}

/** Decode one funding-rate zip. Times are floored to the funding hour. */
export function decodeFundingZip(bytes: Uint8Array, startMs: number, endMs: number): Promise<FundingSeries> {
  const buf = copyBytes(bytes);
  return call<FundingSeries>({ op: 'funding', bytes: buf, startMs, endMs }, [buf]);
}

/** Decode one aggTrades zip (a whole UTC day of prints). */
export function decodeAggTradesZip(bytes: Uint8Array): Promise<TradeSeries> {
  const buf = copyBytes(bytes);
  return call<TradeSeries>({ op: 'aggtrades', bytes: buf }, [buf]);
}

/**
 * Merge series in list order: sorted by time, one row per timestamp, the LAST occurrence
 * winning. The inputs are copied, not consumed.
 */
export function mergeSeries<T extends { t: Float64Array }>(
  list: T[],
  fields: readonly string[],
): Promise<T> {
  // Fresh copies are created here and transferred, so the worker receives them without a
  // second structured-clone copy.
  const copies = list.map((s) => {
    const out: Record<string, Float64Array> = { t: s.t.slice() };
    for (const f of fields) out[f] = (s as unknown as Record<string, Float64Array>)[f].slice();
    return out;
  });
  const transfer = copies.flatMap((c) => Object.values(c).map((a) => a.buffer as ArrayBuffer));
  return call<T>({ op: 'merge', series: copies, fields: [...fields] }, transfer);
}

/** Whole UTC days (epoch ms, sorted) that contain at least one missing bar. */
export async function klineGapDays(series: { t: Float64Array }, stepMs: number): Promise<Float64Array> {
  const t = series.t.slice();
  const out = await call<{ days: Float64Array }>({ op: 'gapdays', t, stepMs }, [t.buffer as ArrayBuffer]);
  return out.days;
}

/** Stop the worker (tests and orderly shutdown). A later call starts a fresh one. */
export async function stopDecodeWorker(): Promise<void> {
  const w = worker;
  worker = null;
  failAll(new Error('decode worker stopped'));
  if (w) await w.terminate();
}
