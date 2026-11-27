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
import { unzipSync } from 'fflate';
import { FundingRow, Interval, RawKline } from '@/lib/nprs/types';

const ARCHIVE_HOST = 'https://data.binance.vision';
const SPOT_API_HOST = 'https://data-api.binance.vision';
// Resolved from NPRS_ROOT (set by the start script): the standalone server chdirs
// into .next/standalone, and `next build` wipes .next, so a cwd-relative cache
// would be lost on every rebuild.
const CACHE_ROOT = path.join(process.env.NPRS_ROOT || process.cwd(), '.cache', 'binance');

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DOWNLOAD_CONCURRENCY = 3;
const FETCH_ATTEMPTS = 3;

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
// Low-level zip + CSV helpers
// ---------------------------------------------------------------------------

function decompressZip(buf: Buffer): string {
  const entries = unzipSync(new Uint8Array(buf));
  const name =
    Object.keys(entries).find((n) => n.toLowerCase().endsWith('.csv')) ??
    Object.keys(entries)[0];
  if (!name) throw new Error('zip archive contains no files');
  return new TextDecoder().decode(entries[name]);
}

/**
 * Raw archive zip bytes: disk-cached, with retries on transport errors. A cached
 * copy that no longer unzips is treated as missing and downloaded again.
 */
export async function fetchArchiveZip(
  archivePath: string,
  opts: { validateCache?: boolean; force?: boolean } = {},
): Promise<{ buf: Buffer; cached: boolean }> {
  const url = `${ARCHIVE_HOST}${archivePath}`;
  const cachePath = path.join(CACHE_ROOT, archivePath.replace(/^\/+/, ''));
  const validateCache = opts.validateCache ?? true;

  // 1. disk cache. By default it is unzip-validated so a corrupt copy self-heals;
  //    callers that unzip the bytes themselves pass validateCache: false and
  //    re-fetch with force: true if their own unzip fails.
  if (!opts.force) {
    try {
      const cached = await readFile(cachePath);
      if (validateCache) unzipSync(new Uint8Array(cached));
      return { buf: cached, cached: true };
    } catch {
      // not cached (or corrupt) - fall through to download
    }
  }

  // 2. live download with retries (transport errors only; 404 aborts)
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(attempt === 2 ? 800 : 2_000);
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(90_000),
        cache: 'no-store',
      });
      if (res.status === 404) throw new ArchiveNotFound(archivePath);
      if (!res.ok) throw new Error(`HTTP ${res.status} from data.binance.vision`);
      const buf = Buffer.from(await res.arrayBuffer());
      unzipSync(new Uint8Array(buf)); // validate before caching
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, buf);
      return { buf, cached: false };
    } catch (e) {
      if (e instanceof ArchiveNotFound) {
        // remove any stale/corrupt cached copy of a file that no longer resolves
        await unlink(cachePath).catch(() => undefined);
        throw e;
      }
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`download failed: ${archivePath}`);
}

/** Download one archive zip and return its CSV text (disk-cached). */
async function fetchArchiveCsv(archivePath: string): Promise<{ text: string; cached: boolean }> {
  const { buf, cached } = await fetchArchiveZip(archivePath);
  return { text: decompressZip(buf), cached };
}

function parseKlinesCsv(
  text: string,
  startMs: number,
  endMs: number,
  out: Map<number, RawKline>,
): number {
  const lines = text.split('\n');
  let n = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) continue;
    if (li === 0 && line.startsWith('open_time')) continue; // header
    const f = line.split(',');
    const t = Number(f[0]);
    if (!Number.isFinite(t) || t < startMs || t > endMs) continue;
    const open = Number(f[1]);
    const high = Number(f[2]);
    const low = Number(f[3]);
    const close = Number(f[4]);
    const volume = Number(f[5]);
    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }
    out.set(t, { openTime: t, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
    n += 1;
  }
  return n;
}

/**
 * Funding CSV: `calc_time[,funding_interval_hours],last_funding_rate`.
 * calc_time carries a small +ms offset on some rows; normalized to the UTC
 * hour boundary. Rate is the last field so both the old 2-column and the
 * current 3-column layouts parse identically.
 */
function parseFundingCsv(
  text: string,
  startMs: number,
  endMs: number,
  out: Map<number, FundingRow>,
): number {
  const lines = text.split('\n');
  let n = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) continue;
    if (li === 0 && line.startsWith('calc_time')) continue; // header
    const f = line.split(',');
    const raw = Number(f[0]);
    if (!Number.isFinite(raw)) continue;
    const rate = Number(f[f.length - 1]);
    if (!Number.isFinite(rate)) continue;
    const t = Math.floor(raw / HOUR_MS) * HOUR_MS;
    if (t < startMs || t > endMs) continue;
    out.set(t, { fundingTime: t, rate, markPrice: 0 }); // mark joined by the ingest from mark klines
    n += 1;
  }
  return n;
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

/**
 * Missing bar timestamps strictly between the first and last stored bar
 * (never outside - pre-listing ranges would just 404). Grouped by UTC day so
 * each hole costs at most one daily zip.
 */
function detectGapDays(merged: Map<number, RawKline>, stepMs: number): Set<number> {
  if (merged.size < 2) return new Set();
  const days = new Set<number>();
  const stamps = Array.from(merged.keys()).sort((a, b) => a - b);
  const first = stamps[0];
  const last = stamps[stamps.length - 1];
  for (let t = first + stepMs; t < last; t += stepMs) {
    if (!merged.has(t)) days.add(utcDayStart(t).getTime());
  }
  return days;
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
): Promise<RawKline[]> {
  assertArchiveArgs(symbol, interval);
  const tasks = klineTasks(symbol, interval, kind, startMs, endMs, Date.now());
  const merged = new Map<number, RawKline>();

  await pMap(
    tasks,
    async (task) => {
      try {
        const { text, cached } = await fetchArchiveCsv(task.archivePath);
        const rows = parseKlinesCsv(text, startMs, endMs, merged);
        events?.onFile?.(task.file, cached ? 'cached' : 'downloaded', rows);
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

  // --- gap healing -----------------------------------------------------------
  // Monthly zips occasionally miss whole days (observed: BTCUSDT 1h mark
  // 2026-06-29 absent from the June monthly zip while the daily zip has it).
  // Detect holes between the first and last bar and patch them from daily
  // files, bounded by MAX_HEAL_DAYS per fetch.
  const stepMs = INTERVAL_STEP_MS[interval];
  if (stepMs) {
    const gapDays = detectGapDays(merged, stepMs);
    if (gapDays.size > 0) {
      const family = kind === 'mark' ? 'markPriceKlines' : 'klines';
      const days = Array.from(gapDays).sort((a, b) => a - b).slice(0, MAX_HEAL_DAYS);
      if (gapDays.size > MAX_HEAL_DAYS) {
        events?.onFile?.(
          `${gapDays.size} gap days (heal cap ${MAX_HEAL_DAYS})`,
          'missing',
          0,
        );
      }
      await pMap(
        days,
        async (day) => {
          const ymd = ymdOf(new Date(day));
          try {
            const { text } = await fetchArchiveCsv(
              `/data/futures/um/daily/${family}/${symbol}/${interval}/${symbol}-${interval}-${ymd}.zip`,
            );
            const before = merged.size;
            parseKlinesCsv(text, startMs, endMs, merged);
            events?.onFile?.(`${symbol}-${interval}-${ymd}.zip`, 'healed', merged.size - before);
          } catch (e) {
            if (e instanceof ArchiveNotFound) {
              events?.onFile?.(`${symbol}-${interval}-${ymd}.zip`, 'missing', 0);
              return;
            }
            throw e;
          }
        },
        DOWNLOAD_CONCURRENCY,
      );
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.openTime - b.openTime);
}

/** Real USDT-M funding-rate history from Binance's official public archive. */
export async function fetchFundingHistory(
  symbol: string,
  startMs: number,
  endMs: number,
  events?: ArchiveEvents,
): Promise<FundingRow[]> {
  assertArchiveArgs(symbol);
  const tasks = fundingTasks(symbol, startMs, endMs, Date.now());
  const merged = new Map<number, FundingRow>();

  await pMap(
    tasks,
    async (task) => {
      try {
        const { text, cached } = await fetchArchiveCsv(task.archivePath);
        const rows = parseFundingCsv(text, startMs, endMs, merged);
        events?.onFile?.(task.file, cached ? 'cached' : 'downloaded', rows);
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

  return Array.from(merged.values()).sort((a, b) => a.fundingTime - b.fundingTime);
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

/** Live 24h statistics from the Binance spot REST API (data-api mirror). */
export async function fetchSpotTickers(symbols: string[]): Promise<SpotTicker[]> {
  const key = [...symbols].sort().join(',');
  const hit = tickerCache.get(key);
  if (hit && Date.now() - hit.at < TICKER_TTL_MS) return hit.data;
  const q = encodeURIComponent(JSON.stringify(symbols));
  const res = await fetch(`${SPOT_API_HOST}/api/v3/ticker/24hr?symbols=${q}`, {
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
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

/** Archive reachability probe used by the status endpoint. */
export async function probeArchive(): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${ARCHIVE_HOST}/?prefix=data/futures/um/monthly/klines/BTCUSDT/1h/`, {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    return {
      ok: res.ok,
      detail: res.ok
        ? 'data.binance.vision reachable'
        : `archive responded HTTP ${res.status}`,
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : 'unreachable' };
  }
}
