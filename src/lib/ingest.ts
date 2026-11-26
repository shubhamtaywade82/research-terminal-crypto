// Background ingestion job manager (singleton per server process).
//
// Fetches REAL Binance USDT-M perpetual data via the official public archive
// (data.binance.vision, see lib/datasources/binance.ts) and persists it as a
// versioned dataset (replace per symbol+interval+kind):
//   - execution klines (kind 'last') : real perp OHLCV
//   - mark price klines (kind 'mark') : the series liquidation runs on
//   - funding rates                   : real settled rates, mark price joined
//
// Every archive file is cached on disk, so re-ingests only download new files.

import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import {
  ArchiveEvents,
  fetchFundingHistory,
  fetchFuturesKlines,
} from '@/lib/datasources/binance';
import { RawKline } from '@/lib/nprs/types';
import { Candle, FundingEvent, IngestJobState, Interval } from '@/lib/nprs/types';

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
export const DATA_SOURCE_LABEL = 'Binance USDT-M public archive (data.binance.vision)';

const g = globalThis as unknown as { __nprsIngestJob?: IngestJobState };

function jobDefaults(): IngestJobState {
  return {
    running: false,
    source: DATA_SOURCE_LABEL,
    symbols: [],
    interval: '1h',
    years: 3,
    startedAt: null,
    finishedAt: null,
    progress: 0,
    current: 'idle',
    log: [],
    error: null,
    insertedCandles: 0,
    insertedFunding: 0,
    filesDownloaded: 0,
    filesCached: 0,
  };
}

export function getJob(): IngestJobState {
  if (!g.__nprsIngestJob) g.__nprsIngestJob = jobDefaults();
  return g.__nprsIngestJob;
}

function logLine(job: IngestJobState, s: string) {
  job.log.push(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  if (job.log.length > 300) job.log.shift();
}

/** Archive events -> job counters + readable log lines. */
function archiveEvents(job: IngestJobState, kindLabel: string): ArchiveEvents {
  return {
    onFile: (file, status, rows) => {
      if (status === 'downloaded') {
        job.filesDownloaded += 1;
        logLine(job, `GET ${kindLabel}/${file} -> ${rows} rows`);
      } else if (status === 'cached') {
        job.filesCached += 1;
      } else if (status === 'healed') {
        job.filesDownloaded += 1;
        logLine(job, `PATCH ${kindLabel}/${file} -> ${rows} rows (gap healed from daily file)`);
      }
      // 'missing' (404): symbol not listed yet / file not published - skipped
    },
  };
}

type Tx = Prisma.TransactionClient;

const CHUNK = 1000;

async function insertCandles(
  tx: Tx,
  symbol: string,
  interval: string,
  kind: 'last' | 'mark',
  candles: Candle[],
): Promise<void> {
  for (let i = 0; i < candles.length; i += CHUNK) {
    await tx.candle.createMany({
      data: candles.slice(i, i + CHUNK).map((c) => ({
        symbol,
        interval,
        kind,
        openTime: new Date(c.t),
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        volume: c.v,
      })),
    });
  }
}

async function insertFunding(tx: Tx, symbol: string, funding: FundingEvent[]): Promise<void> {
  for (let i = 0; i < funding.length; i += CHUNK) {
    await tx.fundingRate.createMany({
      data: funding.slice(i, i + CHUNK).map((f) => ({
        symbol,
        fundingTime: new Date(f.t),
        rate: f.rate,
        markPrice: f.markPrice,
      })),
    });
  }
}

/**
 * Replace one symbol/interval dataset ATOMICALLY: the old candles (both kinds)
 * and funding rows are deleted and the fresh ones inserted in one transaction.
 * A failure anywhere rolls the whole replace back, so the store never holds a
 * mix of new candles with stale funding (or a half-written series).
 */
export async function replaceDataset(
  symbol: string,
  interval: string,
  last: Candle[],
  mark: Candle[],
  funding: FundingEvent[],
): Promise<void> {
  await db.$transaction(
    async (tx) => {
      await tx.candle.deleteMany({ where: { symbol, interval } });
      await tx.fundingRate.deleteMany({ where: { symbol } });
      await insertCandles(tx, symbol, interval, 'last', last);
      await insertCandles(tx, symbol, interval, 'mark', mark);
      await insertFunding(tx, symbol, funding);
    },
    { timeout: 600_000, maxWait: 15_000 },
  );
}

/**
 * Attach a mark price to every funding event: the close of the latest mark
 * kline at or before the funding timestamp (falls back to execution klines).
 */
function joinMarkPrice(
  funding: { fundingTime: number; rate: number }[],
  mark: RawKline[],
  last: RawKline[],
): FundingEvent[] {
  const series = mark.length > 0 ? mark : last;
  let j = 0;
  return funding.map((f) => {
    while (j + 1 < series.length && series[j + 1].openTime <= f.fundingTime) j += 1;
    const bar = series[j];
    const price =
      bar && bar.openTime <= f.fundingTime
        ? bar.close
        : (series[0]?.close ?? 0);
    return { t: f.fundingTime, rate: f.rate, markPrice: price };
  });
}

const toCandle = (r: RawKline): Candle => ({
  t: r.openTime,
  o: r.open,
  h: r.high,
  l: r.low,
  c: r.close,
  v: r.volume,
});

export async function startIngest(opts: {
  symbol: string; // 'ALL' or one of SYMBOLS
  interval: Interval;
  years: number;
}): Promise<{ started: boolean; message: string }> {
  const job = getJob();
  if (job.running) {
    return { started: false, message: 'An ingestion job is already running' };
  }
  const symbols = opts.symbol === 'ALL' ? [...SYMBOLS] : [opts.symbol];
  Object.assign(job, jobDefaults(), {
    running: true,
    source: DATA_SOURCE_LABEL,
    symbols,
    interval: opts.interval,
    years: opts.years,
    startedAt: Date.now(),
    current: 'starting',
  });
  logLine(job, `Ingestion started: ${symbols.join(', ')} ${opts.interval} x ${opts.years}y from ${DATA_SOURCE_LABEL}`);

  void runJob(job, opts, symbols).catch((e: unknown) => {
    job.error = e instanceof Error ? e.message : String(e);
    job.running = false;
    job.finishedAt = Date.now();
    logLine(job, `FAILED: ${job.error}`);
  });

  return { started: true, message: 'Ingestion started' };
}

async function runJob(
  job: IngestJobState,
  opts: { interval: Interval; years: number },
  symbols: string[],
) {
  const endMs = Date.now();
  const startMs = endMs - Math.round(opts.years * 365.25 * 24 * 3_600_000);
  const failures: string[] = [];

  for (let si = 0; si < symbols.length; si++) {
    const symbol = symbols[si];
    const base = si / symbols.length;
    const step = 1 / (3 * symbols.length);

    // All three series are fetched BEFORE anything is written, so a failure in
    // any of them leaves the previously stored dataset untouched. One bad symbol
    // (not listed that far back, archive hiccup, ...) is logged and skipped.
    try {
      // --- 1. execution klines (real perp OHLCV) ---------------------------
      job.current = `${symbol}: fetching ${opts.interval} futures klines`;
      logLine(job, job.current);
      const last = await fetchFuturesKlines(
        symbol,
        opts.interval,
        startMs,
        endMs,
        'last',
        archiveEvents(job, 'klines'),
      );
      if (last.length < 50) {
        throw new Error(`${symbol}: only ${last.length} klines received from the archive`);
      }
      job.progress = base + step;

      // --- 2. mark price klines (liquidation series) -----------------------
      job.current = `${symbol}: fetching ${opts.interval} mark price klines`;
      logLine(job, job.current);
      const mark = await fetchFuturesKlines(
        symbol,
        opts.interval,
        startMs,
        endMs,
        'mark',
        archiveEvents(job, 'mark'),
      );
      if (mark.length === 0) {
        logLine(job, `${symbol}: no mark klines available - liquidation will fall back to last price`);
      }
      job.progress = base + 2 * step;

      // --- 3. funding history (real settled rates) -------------------------
      // The archive publishes funding monthly only, so coverage ends with the
      // last completed month - trades opened after that accrue no funding in
      // the simulation (a small, documented cost understatement).
      job.current = `${symbol}: fetching funding rate history`;
      logLine(job, job.current);
      const fundingRaw = await fetchFundingHistory(
        symbol,
        startMs,
        endMs,
        archiveEvents(job, 'funding'),
      );
      const funding = joinMarkPrice(fundingRaw, mark, last);
      job.progress = base + 3 * step;

      // --- 4. persist atomically -------------------------------------------
      job.current = `${symbol}: storing ${last.length} + ${mark.length} candles, ${funding.length} funding`;
      await replaceDataset(
        symbol,
        opts.interval,
        last.map(toCandle),
        mark.map(toCandle),
        funding,
      );
      job.insertedCandles += last.length + mark.length;
      job.insertedFunding += funding.length;
      job.progress = base + 3 * step;

      logLine(
        job,
        `${symbol}: stored ${last.length} klines + ${mark.length} mark klines + ${funding.length} funding events`,
      );
    } catch (e) {
      failures.push(symbol);
      const msg = e instanceof Error ? e.message : String(e);
      logLine(job, `${symbol}: FAILED - ${msg} (existing stored data kept; continuing with remaining symbols)`);
      job.progress = base + 3 * step;
    }
  }

  job.current = failures.length === symbols.length ? 'failed' : 'done';
  job.running = false;
  job.finishedAt = Date.now();
  if (failures.length === symbols.length) {
    job.error = `all symbols failed: ${failures.join(', ')}`;
    logLine(job, `FAILED: ${job.error}`);
  } else if (failures.length > 0) {
    logLine(job, `Ingestion finished with warnings - failed symbols: ${failures.join(', ')}`);
  } else {
    logLine(
      job,
      `Ingestion complete: ${job.insertedCandles} candles, ${job.insertedFunding} funding rows (${job.filesDownloaded} files downloaded, ${job.filesCached} from cache)`,
    );
  }
}
