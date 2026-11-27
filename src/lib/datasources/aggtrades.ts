// Tick data: Binance USDT-M futures aggregated trades from the daily archive
// (data.binance.vision/data/futures/um/daily/aggTrades). One file per UTC day,
// time-ordered, each row an aggregated print (same-price fills merged by Binance).
//
// Only trade price and transact_time feed the simulator; quantities are not needed
// for fills, take-profit or excursions. Days are cached on disk as zips (via the
// shared archive client), decoded in the worker thread into typed arrays, and kept
// in a small LRU: a backtest walks days in order, so each day is decoded once per run.

import { access } from 'node:fs/promises';
import { archiveCachePath, ArchiveNotFound, assertArchiveArgs, fetchArchiveZip } from './binance';
import { decodeAggTradesZip, TradeSeries } from './decode-pool';
import { RequestBudget } from '@/lib/net/throttle';
import { DEFAULT_DOWNLOADS_PER_REQUEST } from '@/lib/net/hosts';
import type { IntrabarSource, IntrabarWindow } from '@/lib/nprs/types';

const DAY_MS = 86_400_000;

/** Day keys in [fromMs, toMs) whose aggTrades zip is NOT yet in the local cache. */
export async function uncachedAggTradeDays(symbol: string, fromMs: number, toMs: number): Promise<string[]> {
  assertArchiveArgs(symbol);
  const out: string[] = [];
  for (let d = utcDayStart(fromMs); d < toMs; d += DAY_MS) {
    const key = utcDayKey(d);
    const file = archiveCachePath(`/data/futures/um/daily/aggTrades/${symbol}/${symbol}-aggTrades-${key}.zip`);
    const cached = await access(file).then(() => true, () => false);
    if (!cached) out.push(key);
  }
  return out;
}

/** UTC calendar day (YYYY-MM-DD) containing epoch ms `t`. */
export function utcDayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Start (epoch ms) of the UTC day containing `t`. */
export function utcDayStart(t: number): number {
  return Math.floor(t / DAY_MS) * DAY_MS;
}

/** Index of the first element >= x in a sorted Float64Array. */
function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sliceWindow(day: IntrabarWindow, fromMs: number, toMs: number): IntrabarWindow {
  const i = lowerBound(day.t, fromMs);
  const j = lowerBound(day.t, toMs);
  return { t: day.t.subarray(i, j), p: day.p.subarray(i, j) };
}

function concatWindows(parts: IntrabarWindow[]): IntrabarWindow {
  if (parts.length === 1) return parts[0];
  const n = parts.reduce((s, w) => s + w.t.length, 0);
  const t = new Float64Array(n);
  const p = new Float64Array(n);
  let off = 0;
  for (const w of parts) {
    t.set(w.t, off);
    p.set(w.p, off);
    off += w.t.length;
  }
  return { t, p };
}

export interface AggTradeStats {
  /** Days decoded from the archive (or disk cache) during this source's lifetime. */
  daysLoaded: number;
  /** Days the archive does not publish (404). Windows touching them come back null. */
  daysMissing: number;
}

export interface AggTradeSource extends IntrabarSource {
  readonly symbol: string;
  readonly stats: AggTradeStats;
  /** All prints of one UTC day, or null when the day is not published. */
  day(dayStartMs: number): Promise<IntrabarWindow | null>;
}

/**
 * aggTrades for one symbol. `window` answers any [from, to) range from the cached
 * days; a range touching an unpublished day returns null so the caller can fall
 * back explicitly rather than simulate on partial tick data.
 */
export interface AggTradeSourceOptions {
  maxDaysInMemory?: number;
  /** New downloads this source may cause. Cache hits never consume it. */
  budget?: RequestBudget;
}

export function createAggTradeSource(symbol: string, opts: AggTradeSourceOptions = {}): AggTradeSource {
  assertArchiveArgs(symbol);
  const maxDaysInMemory = opts.maxDaysInMemory ?? 2;
  const budget = opts.budget ?? new RequestBudget(DEFAULT_DOWNLOADS_PER_REQUEST);
  const days = new Map<string, IntrabarWindow | null>();
  const stats: AggTradeStats = { daysLoaded: 0, daysMissing: 0 };

  const loadDay = async (key: string): Promise<IntrabarWindow | null> => {
    if (days.has(key)) {
      // LRU touch: re-insert so the most recent day is last.
      const cached = days.get(key) ?? null;
      days.delete(key);
      days.set(key, cached);
      return cached;
    }
    let day: TradeSeries | null;
    try {
      const archivePath = `/data/futures/um/daily/aggTrades/${symbol}/${symbol}-aggTrades-${key}.zip`;
      const first = await fetchArchiveZip(archivePath, { budget });
      try {
        day = await decodeAggTradesZip(first.buf);
      } catch {
        // A cached copy that no longer decodes is re-fetched once (budget applies again).
        const again = await fetchArchiveZip(archivePath, { force: true, budget });
        day = await decodeAggTradesZip(again.buf);
      }
      stats.daysLoaded += 1;
    } catch (e) {
      if (!(e instanceof ArchiveNotFound)) throw e;
      day = null;
      stats.daysMissing += 1;
    }
    days.set(key, day);
    while (days.size > maxDaysInMemory) {
      const oldest = days.keys().next().value as string;
      days.delete(oldest);
    }
    return day;
  };

  return {
    symbol,
    stats,
    day: (dayStartMs) => loadDay(utcDayKey(dayStartMs)),
    async window(fromMs: number, toMs: number): Promise<IntrabarWindow | null> {
      if (!(toMs > fromMs)) return null;
      const parts: IntrabarWindow[] = [];
      for (let d = utcDayStart(fromMs); d < toMs; d += DAY_MS) {
        const day = await loadDay(utcDayKey(d));
        if (day === null) return null;
        parts.push(sliceWindow(day, fromMs, toMs));
      }
      return concatWindows(parts);
    },
  };
}
