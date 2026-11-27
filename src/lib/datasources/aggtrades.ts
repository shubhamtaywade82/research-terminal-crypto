// Tick data: Binance USDT-M futures aggregated trades from the daily archive
// (data.binance.vision/data/futures/um/daily/aggTrades). One file per UTC day,
// time-ordered, each row an aggregated print (same-price fills merged by Binance).
//
// Only trade price and transact_time feed the simulator; quantities are not needed
// for fills, take-profit or excursions. Days are cached on disk as zips (via the
// shared archive client) and decoded into typed arrays, with a small LRU in memory:
// a backtest walks days in order, so each day is decoded once per run.

import { unzipSync } from 'fflate';
import { inflateRawSync } from 'node:zlib';
import { access } from 'node:fs/promises';
import { archiveCachePath, ArchiveNotFound, assertArchiveArgs, fetchArchiveZip } from './binance';
import { RequestBudget } from '@/lib/net/throttle';
import { DEFAULT_DOWNLOADS_PER_REQUEST } from '@/lib/net/hosts';
import type { IntrabarSource, IntrabarWindow } from '@/lib/nprs/types';

const DAY_MS = 86_400_000;

/**
 * First CSV entry of a zip, inflated with Node's native zlib (several times faster
 * than the pure-JS unzip on a 100 MB day file). Reads the central directory, so
 * the local header's data-descriptor flags do not matter. Returns null when the
 * layout is not one this reader handles; the caller then uses fflate.
 */
export function inflateFirstCsv(zip: Uint8Array): Uint8Array | null {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = (() => {
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
  })();
  if (eocd < 0) return null;
  let off = buf.readUInt32LE(eocd + 16); // central directory offset
  const entries = buf.readUInt16LE(eocd + 10);
  for (let e = 0; e < entries; e++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name.toLowerCase().endsWith('.csv')) {
      if (buf.readUInt32LE(localOff) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return new Uint8Array(data);
      if (method === 8) return new Uint8Array(inflateRawSync(data));
      return null;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Parse an aggTrades CSV into time-ordered (t, p) arrays. Malformed rows are skipped. */
export function parseAggTradesCsv(text: string): IntrabarWindow {
  const lines = text.split('\n');
  const t: number[] = [];
  const p: number[] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line) continue;
    if (li === 0 && line.startsWith('agg_trade_id')) continue; // header
    const f = line.split(',');
    const price = Number(f[1]);
    const time = Number(f[5]);
    if (!Number.isFinite(price) || !Number.isFinite(time) || price <= 0) continue;
    t.push(time);
    p.push(price);
  }

  // The archive is time-ordered; verify rather than assume, and sort stably if not.
  let sorted = true;
  for (let i = 1; i < t.length; i++) {
    if (t[i] < t[i - 1]) {
      sorted = false;
      break;
    }
  }
  if (!sorted) {
    const order = t.map((_, i) => i).sort((a, b) => t[a] - t[b] || a - b);
    return {
      t: Float64Array.from(order, (i) => t[i]),
      p: Float64Array.from(order, (i) => p[i]),
    };
  }
  return { t: Float64Array.from(t), p: Float64Array.from(p) };
}

/** CSV bytes of a day zip: native inflate when possible, fflate otherwise. */
export function fastCsv(zip: Buffer): Uint8Array {
  const native = inflateFirstCsv(new Uint8Array(zip));
  if (native) return native;
  const entries = unzipSync(new Uint8Array(zip));
  const name =
    Object.keys(entries).find((n) => n.toLowerCase().endsWith('.csv')) ?? Object.keys(entries)[0];
  if (!name) throw new Error('zip archive contains no files');
  return entries[name];
}

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
    let day: IntrabarWindow | null;
    try {
      const archivePath = `/data/futures/um/daily/aggTrades/${symbol}/${symbol}-aggTrades-${key}.zip`;
      // One unzip per day: the cache is not pre-validated; a corrupt copy is re-fetched.
      let { buf } = await fetchArchiveZip(archivePath, { validateCache: false, budget });
      let csv: Uint8Array;
      try {
        csv = fastCsv(buf);
      } catch {
        ({ buf } = await fetchArchiveZip(archivePath, { force: true, budget }));
        csv = fastCsv(buf);
      }
      day = parseAggTradesCsv(new TextDecoder().decode(csv));
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
