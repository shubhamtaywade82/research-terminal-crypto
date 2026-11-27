// Background ingestion job manager (singleton per server process).
//
// Fetches REAL Binance USDT-M perpetual data via the official public archive
// (data.binance.vision, see lib/datasources/binance.ts) and persists it as a
// versioned dataset (replace per symbol+interval+kind):
//   - execution klines (kind 'last') : real perp OHLCV
//   - mark price klines (kind 'mark') : the series liquidation runs on
//   - funding rates                   : real settled rates, mark price joined
//
// Series travel as typed arrays (KlineSeries / FundingSeries) from the decode worker to the
// write, and rows are built per INSERT batch, so a large ingest never holds one JS object
// per candle.
//
// Every archive file is cached on disk, so re-ingests only download new files.

import {
  ArchiveEvents,
  fetchFundingHistory,
  fetchFuturesKlines,
} from '@/lib/datasources/binance';
import type { FundingSeries, KlineSeries } from '@/lib/datasources/decode-pool';
import { bumpDatasetVersion } from '@/lib/datasets-version';
import { writeDataset } from '@/lib/store/store-pool';
import { IngestJobState, Interval } from '@/lib/nprs/types';

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
export const DATA_SOURCE_LABEL = 'Binance USDT-M public archive (data.binance.vision)';

/** Funding events with the mark price joined in, as parallel arrays. */
export interface FundingJoined {
  t: Float64Array;
  rate: Float64Array;
  markPrice: Float64Array;
}

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

/**
 * Replace one symbol/interval dataset ATOMICALLY, in the store writer thread: the old candles
 * (both kinds) and funding rows are deleted and the fresh ones inserted in one transaction.
 * A failure anywhere rolls the whole replace back, so the store never holds a mix of new
 * candles with stale funding (or a half-written series).
 *
 * The series are transferred to the writer, so they are detached after this call: read
 * their lengths before calling.
 */
/** Diagnostic memory note (NPRS_DIAG=1): process RSS, JS heap and external buffers, in MB. */
export function memNote(): string {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1048576);
  return `rss ${mb(m.rss)} MB, heap ${mb(m.heapUsed)} MB, buffers ${mb(m.arrayBuffers)} MB`;
}

export async function replaceDataset(
  symbol: string,
  interval: string,
  last: KlineSeries,
  mark: KlineSeries,
  funding: FundingJoined,
): Promise<void> {
  const diag = process.env.NPRS_DIAG === '1';
  const stamp = (what: string) => {
    if (diag) console.log(`[diag] ${new Date().toISOString()} ${symbol} ${interval}: ${what}`);
  };
  stamp(`write start (${last.t.length} + ${mark.t.length} candles, ${funding.t.length} funding; ${memNote()})`);
  await writeDataset({ symbol, interval, last, mark, funding, onStage: stamp });
  bumpDatasetVersion();
  stamp(`committed (${memNote()})`);
}

/**
 * Attach a mark price to every funding event: the close of the latest mark
 * kline at or before the funding timestamp (falls back to execution klines).
 */
export function joinMarkPrice(funding: FundingSeries, mark: KlineSeries, last: KlineSeries): FundingJoined {
  const series = mark.t.length > 0 ? mark : last;
  const len = series.t.length;
  const markPrice = new Float64Array(funding.t.length);
  let j = 0;
  for (let i = 0; i < funding.t.length; i++) {
    const ft = funding.t[i];
    while (j + 1 < len && series.t[j + 1] <= ft) j += 1;
    // Before the first bar the first close is used; with no bars at all the price is 0.
    markPrice[i] = len === 0 ? 0 : series.t[j] <= ft ? series.c[j] : series.c[0];
  }
  return { t: funding.t, rate: funding.rate, markPrice };
}

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
      if (last.t.length < 50) {
        throw new Error(`${symbol}: only ${last.t.length} klines received from the archive`);
      }
      job.progress = base + step;
      if (process.env.NPRS_DIAG === '1') console.log(`[diag] ${symbol} klines fetched: ${last.t.length} rows; ${memNote()}`);

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
      if (mark.t.length === 0) {
        logLine(job, `${symbol}: no mark klines available - liquidation will fall back to last price`);
      }
      job.progress = base + 2 * step;
      if (process.env.NPRS_DIAG === '1') console.log(`[diag] ${symbol} mark klines fetched: ${mark.t.length} rows; ${memNote()}`);

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
      // Counts are read before the write: the writer takes ownership of the arrays.
      const lastRows = last.t.length;
      const markRows = mark.t.length;
      const fundingRows = funding.t.length;
      job.current = `${symbol}: storing ${lastRows} + ${markRows} candles, ${fundingRows} funding`;
      await replaceDataset(symbol, opts.interval, last, mark, funding);
      job.insertedCandles += lastRows + markRows;
      job.insertedFunding += fundingRows;
      job.progress = base + 3 * step;

      logLine(
        job,
        `${symbol}: stored ${lastRows} klines + ${markRows} mark klines + ${fundingRows} funding events`,
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
