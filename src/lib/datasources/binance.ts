// Real Binance public market-data client (server-side only).
//
// ALL data entering the research terminal comes from real HTTP requests
// against Binance's official public endpoints - no keys, no synthetic
// fallbacks:
//
//  1. https://data.binance.vision - Binance's official public data archive:
//       - USDT-M futures klines        (real perpetual OHLCV, monthly + daily
//                                       zip files containing CSV)
//       - USDT-M mark price klines     (the price series Binance actually
//                                       liquidates positions on)
//       - USDT-M funding rate history  (real settled funding rates -
//                                       published as MONTHLY files only; the
//                                       current month has no daily funding
//                                       files, verified by direct probing)
//     Monthly files cover completed months; the boundary month (and any
//     month whose monthly zip is not published yet) is filled from daily
//     files once the UTC day completes. Holes left by incomplete monthly
//     zips are detected after the merge and healed from daily files. A 404
//     simply means "file not published / symbol not listed yet" and is
//     skipped.
//
//  2. https://data-api.binance.vision - Binance spot market-data REST mirror
//     (real REST API) used for the live ticker strip. The USDT-M futures
//     REST domain (fapi.binance.com) is not reachable from this environment,
//     so futures REST history is served by the official archive above.
//
// Every archive file is cached on disk under .cache/binance/ so repeated
// ingests do not re-download history.

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Interval } from '@/lib/nprs/types';
import { archiveGate, spotGate } from '@/lib/net/hosts';
import { yieldToEventLoop } from './event-loop';
import {
  decodeFundingZip,
  decodeKlinesZip,
  FUNDING_FIELDS,
  FundingSeries,
  klineGapDays,
  KLINE_FIELDS,
  KlineSeries,
  mergeSeries,
} from './decode-pool';
import { RateLimitError, RequestBudget } from '@/lib/net/throttle';

const ARCHIVE_HOST = 'https://data.binance.vision';
const SPOT_API_HOST = 'https://data-api.binance.vision';
// Resolved from NPRS_ROOT (set by the start script): the standalone server chdirs
// into .next/standalone, and `next build` wipes .next, so a cwd-relative cache
// would be lost on every rebuild.
const CACHE_ROOT = path.join(process.env.NPRS_ROOT || process.cwd(), '.cache', 'binance');

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DOWNLOAD_CONCURRENCY = 3;

// Publication lags observed on the archive: monthly zips appear up to ~2 days
// after the month completes, daily zips within a few hours after the UTC day
// completes. Planning inside these windows falls back to daily files so a
// just-finished month never leaves a hole.
const MONTHLY_PUBLISH_LAG_MS = 2 * DAY_MS;
const DAILY_PUBLISH_LAG_MS = 6 * HOUR_MS;

// Ceiling on how many single-day files one kline fetch may pull in to patch
// holes left by incomplete monthly zips (e.g. BTCUSDT mark 2026-06-29).
const MAX_HEAL_DAYS = 62;

// Kline intervals this app ingests, in ms (used for gap detection).
const INTERVAL_STEP_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': HOUR_MS,
  '4h': 4 * HOUR_MS,
  '1d': DAY_MS,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Symbols and intervals are interpolated into archive URLs AND into on-disk
// cache paths. Validate at the data-source boundary too (not only in the API
// route), so a value like "../x" can never escape CACHE_ROOT.
const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;
export function assertArchiveArgs(symbol: string, interval?: string): void {
  if (!SYMBOL_RE.test(symbol)) throw new Error(`invalid symbol: ${JSON.stringify(symbol)}`);
  if (interval !== undefined && !(interval in INTERVAL_STEP_MS)) {
    throw new Error(`unsupported interval: ${JSON.stringify(interval)}`);
  }
}

/** Raised when the archive answers 404 (file not published / not listed). */
export class ArchiveNotFound extends Error {
  constructor(file: string) {
    super(`not published: ${file}`);
    this.name = 'ArchiveNotFound';
  }
}

// ---------------------------------------------------------------------------
// Archive files: disk cache and download. Decoding happens in the worker
// (decode-pool.ts), never on the request thread.
// ---------------------------------------------------------------------------

/** Where a given archive path lives in the local cache (exists or not). */
export function archiveCachePath(archivePath: string): string {
  return path.join(CACHE_ROOT, archivePath.replace(/^\/+/, ''));
}

/**
 * Raw archive zip bytes: disk-cached, with retries on transport errors. The bytes are not
 * unzipped here; a caller whose decode fails re-fetches with `force: true`.
 */
export async function fetchArchiveZip(
  archivePath: string,
  opts: { force?: boolean; budget?: RequestBudget } = {},
): Promise<{ buf: Buffer; cached: boolean }> {
  const url = `${ARCHIVE_HOST}${archivePath}`;
  const cachePath = path.join(CACHE_ROOT, archivePath.replace(/^\/+/, ''));

  // 1. disk cache
  if (!opts.force) {
    try {
      return { buf: await readFile(cachePath), cached: true };
    } catch {
      // not cached - fall through to download
    }
  }

  // 2. network. Only real downloads consume the per-request budget; the gate owns
  //    pacing, cooldowns and bounded retries for this host.
  opts.budget?.consume();
  const res = await archiveGate.fetch(url, {
    signal: AbortSignal.timeout(90_000),
    cache: 'no-store',
  });
  if (res.status === 404) {
    // remove any stale/corrupt cached copy of a file that no longer resolves
    await unlink(cachePath).catch(() => undefined);
    throw new ArchiveNotFound(archivePath);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from data.binance.vision`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, buf);
  return { buf, cached: false };
}

/**
 * Klines file (monthly or daily): bytes from the disk cache or the network, decoded in the
 * worker. A cached copy that no longer decodes is re-fetched once.
 */
async function loadKlinesFile(
  archivePath: string,
  startMs: number,
  endMs: number,
): Promise<{ series: KlineSeries; cached: boolean }> {
  const first = await fetchArchiveZip(archivePath);
  try {
    return { series: await decodeKlinesZip(first.buf, startMs, endMs), cached: first.cached };
  } catch {
    const again = await fetchArchiveZip(archivePath, { force: true });
    return { series: await decodeKlinesZip(again.buf, startMs, endMs), cached: false };
  }
}

/** Funding file (monthly): same cache and re-fetch rule as klines. */
async function loadFundingFile(
  archivePath: string,
  startMs: number,
  endMs: number,
): Promise<{ series: FundingSeries; cached: boolean }> {
  const first = await fetchArchiveZip(archivePath);
  try {
    return { series: await decodeFundingZip(first.buf, startMs, endMs), cached: first.cached };
  } catch {
    const again = await fetchArchiveZip(archivePath, { force: true });
    return { series: await decodeFundingZip(again.buf, startMs, endMs), cached: false };
  }
}

// ---------------------------------------------------------------------------
// Calendar helpers (monthly files for completed months + daily for current)
// ---------------------------------------------------------------------------

function utcMonthStart(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function utcDayStart(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const ymOf = (d: Date) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
const ymdOf = (d: Date) => `${ymOf(d)}-${pad2(d.getUTCDate())}`;

interface ArchiveTask {
  archivePath: string;
  file: string; // short name for logs
}

function klineTasks(
  symbol: string,
  interval: Interval,
  kind: 'last' | 'mark',
  startMs: number,
  endMs: number,
  nowMs: number,
): ArchiveTask[] {
  const family = kind === 'mark' ? 'markPriceKlines' : 'klines';
  return archiveTasks(
    startMs,
    endMs,
    nowMs,
    (ym) => `/data/futures/um/monthly/${family}/${symbol}/${interval}/${symbol}-${interval}-${ym}.zip`,
    (ym) => `${symbol}-${interval}-${ym}.zip`,
    (ymd) => `/data/futures/um/daily/${family}/${symbol}/${interval}/${symbol}-${interval}-${ymd}.zip`,
    (ymd) => `${symbol}-${interval}-${ymd}.zip`,
  );
}

/**
 * Funding rate history: MONTHLY files only. The archive does not publish
 * daily fundingRate zips (verified: data/futures/um/daily/fundingRate/... is
 * 404 for every probed date), so funding coverage always ends with the last
 * fully completed month. Months whose zip is not published yet are skipped.
 */
function fundingTasks(symbol: string, startMs: number, endMs: number, nowMs: number): ArchiveTask[] {
  const tasks: ArchiveTask[] = [];
  for (let m = utcMonthStart(startMs).getTime(); m <= endMs; ) {
    const nextMonth = new Date(m);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    if (nextMonth.getTime() + MONTHLY_PUBLISH_LAG_MS <= nowMs) {
      const ym = ymOf(new Date(m));
      tasks.push({
        archivePath: `/data/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${ym}.zip`,
        file: `${symbol}-fundingRate-${ym}.zip`,
      });
    }
    m = nextMonth.getTime();
  }
  return tasks;
}

/**
 * Shared month walk: a month resolves to ONE monthly zip when that zip should
 * already be published (month end + lag <= now), otherwise to per-day zips for
 * the completed days of that month (daily files exist for klines families).
 */
function archiveTasks(
  startMs: number,
  endMs: number,
  nowMs: number,
  monthlyPath: (ym: string) => string,
  monthlyFile: (ym: string) => string,
  dailyPath: (ymd: string) => string,
  dailyFile: (ymd: string) => string,
): ArchiveTask[] {
  const tasks: ArchiveTask[] = [];
  const dailyReady = nowMs - DAILY_PUBLISH_LAG_MS; // days ending before this are published

  for (let m = utcMonthStart(startMs).getTime(); m <= endMs; ) {
    const nextMonth = new Date(m);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const monthEnd = nextMonth.getTime();

    if (monthEnd + MONTHLY_PUBLISH_LAG_MS <= nowMs) {
      const ym = ymOf(new Date(m));
      tasks.push({ archivePath: monthlyPath(ym), file: monthlyFile(ym) });
    } else {
      // Boundary month: the monthly zip may not exist yet - use daily files
      // for every completed day that intersects the requested range.
      const firstDay = Math.max(m, utcDayStart(startMs).getTime());
      const lastDay = Math.min(monthEnd - 1, utcDayStart(endMs).getTime());
      for (let d = firstDay; d <= lastDay; d += DAY_MS) {
        if (d + DAY_MS > dailyReady) break; // day not complete/published yet
        const ymd = ymdOf(new Date(d));
        tasks.push({ archivePath: dailyPath(ymd), file: dailyFile(ymd) });
      }
    }
    m = monthEnd;
  }
  return tasks;
}

/** Bounded-concurrency map preserving input order. */
async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) break;
        out[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ArchiveEvents {
  /** Called once per archive file with its disposition. */
  onFile?: (
    file: string,
    status: 'downloaded' | 'cached' | 'missing' | 'healed',
    rows: number,
  ) => void;
}

/**
 * Real USDT-M futures klines from Binance's official public archive.
 * kind 'last' = execution candles (perp OHLCV), 'mark' = mark price klines.
 */
export async function fetchFuturesKlines(
  symbol: string,
  interval: Interval,
  startMs: number,
  endMs: number,
  kind: 'last' | 'mark' = 'last',
  events?: ArchiveEvents,
): Promise<KlineSeries> {
  assertArchiveArgs(symbol, interval);
  const tasks = klineTasks(symbol, interval, kind, startMs, endMs, Date.now());
  const slots = new Array<KlineSeries | undefined>(tasks.length);

  await pMap(
    tasks,
    async (task, i) => {
      try {
        const { series, cached } = await loadKlinesFile(task.archivePath, startMs, endMs);
        slots[i] = series;
        events?.onFile?.(task.file, cached ? 'cached' : 'downloaded', series.t.length);
        await yieldToEventLoop();
      } catch (e) {
        if (e instanceof ArchiveNotFound) {
          events?.onFile?.(task.file, 'missing', 0);
          return;
        }
        throw e;
      }
    },
    DOWNLOAD_CONCURRENCY,
  );

  // Task order, so the result does not depend on which download finished first.
  let merged = await mergeSeries(
    slots.filter((s): s is KlineSeries => s !== undefined),
    KLINE_FIELDS,
  );

  // Monthly zips occasionally miss whole days (observed: BTCUSDT 1h mark 2026-06-29 absent from
  // the June monthly zip while the daily zip has it). Holes between the first and last bar are
  // patched from daily files, bounded by MAX_HEAL_DAYS per fetch.
  const stepMs = INTERVAL_STEP_MS[interval];
  if (stepMs && merged.t.length > 1) {
    const gaps = await klineGapDays(merged, stepMs);
    if (gaps.length > 0) {
      const family = kind === 'mark' ? 'markPriceKlines' : 'klines';
      const days = Array.from(gaps).slice(0, MAX_HEAL_DAYS);
      if (gaps.length > MAX_HEAL_DAYS) {
        events?.onFile?.(`${gaps.length} gap days (heal cap ${MAX_HEAL_DAYS})`, 'missing', 0);
      }
      const healed = new Array<KlineSeries | undefined>(days.length);
      await pMap(
        days,
        async (day, i) => {
          const file = `${symbol}-${interval}-${ymdOf(new Date(day))}.zip`;
          try {
            const { series } = await loadKlinesFile(
              `/data/futures/um/daily/${family}/${symbol}/${interval}/${file}`,
              startMs,
              endMs,
            );
            healed[i] = series;
            events?.onFile?.(file, 'healed', series.t.length);
            await yieldToEventLoop();
          } catch (e) {
            if (e instanceof ArchiveNotFound) {
              events?.onFile?.(file, 'missing', 0);
              return;
            }
            throw e;
          }
        },
        DOWNLOAD_CONCURRENCY,
      );
      merged = await mergeSeries(
        [merged, ...healed.filter((s): s is KlineSeries => s !== undefined)],
        KLINE_FIELDS,
      );
    }
  }
  return merged;
}

/** Real USDT-M funding-rate history from Binance's official public archive. */
export async function fetchFundingHistory(
  symbol: string,
  startMs: number,
  endMs: number,
  events?: ArchiveEvents,
): Promise<FundingSeries> {
  assertArchiveArgs(symbol);
  const tasks = fundingTasks(symbol, startMs, endMs, Date.now());
  const slots = new Array<FundingSeries | undefined>(tasks.length);

  await pMap(
    tasks,
    async (task, i) => {
      try {
        const { series, cached } = await loadFundingFile(task.archivePath, startMs, endMs);
        slots[i] = series;
        events?.onFile?.(task.file, cached ? 'cached' : 'downloaded', series.t.length);
        await yieldToEventLoop();
      } catch (e) {
        if (e instanceof ArchiveNotFound) {
          events?.onFile?.(task.file, 'missing', 0);
          return;
        }
        throw e;
      }
    },
    DOWNLOAD_CONCURRENCY,
  );
  return mergeSeries(
    slots.filter((s): s is FundingSeries => s !== undefined),
    FUNDING_FIELDS,
  );
}

// --- Live spot REST (real Binance API, used for the market pulse strip) -----

export interface SpotTicker {
  symbol: string;
  price: number;
  changePct: number;
  high: number;
  low: number;
  quoteVolumeUsd: number;
}

const TICKER_TTL_MS = 15_000;
// Cache per requested symbol set: a single shared slot would return the wrong
// symbols to a caller that asks for a different list within the TTL.
const tickerCache = new Map<string, { at: number; data: SpotTicker[] }>();

/**
 * Live 24h statistics from the Binance spot REST API (data-api mirror). Cached per
 * symbol set, and during a cooldown the last good snapshot is served instead of
 * calling the host again.
 */
export async function fetchSpotTickers(symbols: string[]): Promise<SpotTicker[]> {
  const key = [...symbols].sort().join(',');
  const hit = tickerCache.get(key);
  if (hit && Date.now() - hit.at < TICKER_TTL_MS) return hit.data;

  const q = encodeURIComponent(JSON.stringify(symbols));
  let res: Response;
  try {
    res = await spotGate.fetch(`${SPOT_API_HOST}/api/v3/ticker/24hr?symbols=${q}`, {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
  } catch (e) {
    if (e instanceof RateLimitError && hit) return hit.data;
    throw e;
  }
  if (!res.ok) throw new Error(`ticker HTTP ${res.status} from data-api.binance.vision`);
  const rows = (await res.json()) as Array<{
    symbol: string;
    lastPrice: string;
    priceChangePercent: string;
    highPrice: string;
    lowPrice: string;
    quoteVolume: string;
  }>;
  const data: SpotTicker[] = rows.map((r) => ({
    symbol: r.symbol,
    price: Number(r.lastPrice),
    changePct: Number(r.priceChangePercent),
    high: Number(r.highPrice),
    low: Number(r.lowPrice),
    quoteVolumeUsd: Number(r.quoteVolume),
  }));
  tickerCache.set(key, { at: Date.now(), data });
  return data;
}

// Archive reachability is probed at most once a minute, however often the status
// endpoint is polled, and concurrent callers share one probe.
const PROBE_TTL_MS = 60_000;
let probeCache: { at: number; value: { ok: boolean; detail: string } } | null = null;
let probeInflight: Promise<{ ok: boolean; detail: string }> | null = null;

export async function probeArchive(): Promise<{ ok: boolean; detail: string }> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.value;
  if (probeInflight) return probeInflight;
  probeInflight = (async () => {
    let value: { ok: boolean; detail: string };
    try {
      const res = await archiveGate.fetch(`${ARCHIVE_HOST}/?prefix=data/futures/um/monthly/klines/BTCUSDT/1h/`, {
        signal: AbortSignal.timeout(10_000),
        cache: 'no-store',
      });
      value = {
        ok: res.ok,
        detail: res.ok ? 'data.binance.vision reachable' : `archive responded HTTP ${res.status}`,
      };
    } catch (e) {
      value = { ok: false, detail: e instanceof Error ? e.message : 'unreachable' };
    }
    probeCache = { at: Date.now(), value };
    probeInflight = null;
    return value;
  })();
  return probeInflight;
}
