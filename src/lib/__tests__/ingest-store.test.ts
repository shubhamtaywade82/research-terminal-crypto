import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { joinMarkPrice, replaceDataset, type FundingJoined } from '@/lib/ingest';
import type { FundingSeries, KlineSeries } from '@/lib/datasources/decode-pool';
import { stopStoreWorker, storeCoverage, writeDataset } from '@/lib/store/store-pool';

// A real SQLite file with the Prisma schema's tables and unique indexes, written through the
// writer thread exactly as in production. Nothing here touches the Prisma client.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nprs-store-'));
const file = path.join(dir, 'store.db');
process.env.DATABASE_URL = `file:${file}`;

const DDL = `
CREATE TABLE "Candle" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "symbol" TEXT NOT NULL, "interval" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'last', "openTime" DATETIME NOT NULL, "open" REAL NOT NULL, "high" REAL NOT NULL,
  "low" REAL NOT NULL, "close" REAL NOT NULL, "volume" REAL NOT NULL);
CREATE UNIQUE INDEX "Candle_symbol_interval_kind_openTime_key" ON "Candle"("symbol", "interval", "kind", "openTime");
CREATE INDEX "Candle_symbol_interval_kind_idx" ON "Candle"("symbol", "interval", "kind");
CREATE TABLE "FundingRate" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "symbol" TEXT NOT NULL, "fundingTime" DATETIME NOT NULL,
  "rate" REAL NOT NULL, "markPrice" REAL NOT NULL);
CREATE UNIQUE INDEX "FundingRate_symbol_fundingTime_key" ON "FundingRate"("symbol", "fundingTime");
`;

const T0 = Date.UTC(2026, 0, 1);
const H = 3_600_000;

let db: Client;

beforeAll(async () => {
  db = createClient({ url: `file:${file}` });
  await db.executeMultiple(DDL);
});

afterAll(async () => {
  await stopStoreWorker();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Fresh series per call: the writer takes ownership of the buffers. */
function klines(n: number, stepMs: number, base = 0): KlineSeries {
  const s: KlineSeries = {
    t: new Float64Array(n),
    o: new Float64Array(n),
    h: new Float64Array(n),
    l: new Float64Array(n),
    c: new Float64Array(n),
    v: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    s.t[i] = T0 + i * stepMs;
    s.o[i] = base + i;
    s.h[i] = base + i + 1;
    s.l[i] = base + i - 1;
    s.c[i] = base + 0.5 + i;
    s.v[i] = 10 + i;
  }
  return s;
}

function funding(n: number, base = 0): FundingJoined {
  return {
    t: Float64Array.from({ length: n }, (_, i) => T0 + i * 8 * H),
    rate: Float64Array.from({ length: n }, (_, i) => 0.0001 * (i + 1) + base),
    markPrice: Float64Array.from({ length: n }, (_, i) => 42_000 + i),
  };
}

async function candleCounts(symbol: string, interval: string): Promise<Record<string, number>> {
  const r = await db.execute({
    sql: 'SELECT kind, COUNT(*) AS n FROM Candle WHERE symbol = ? AND interval = ? GROUP BY kind',
    args: [symbol, interval],
  });
  return Object.fromEntries(r.rows.map((row) => [String(row.kind), Number(row.n)]));
}

async function fundingCount(symbol: string): Promise<number> {
  const r = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM FundingRate WHERE symbol = ?', args: [symbol] });
  return Number(r.rows[0].n);
}

describe('dataset writes (store writer thread)', () => {
  it('writes both kinds and the funding rows, and reads back the same values', async () => {
    const last = klines(3, H);
    const mark = klines(2, H, 500);
    await replaceDataset('SOLUSDT', '1h', last, mark, funding(2));

    expect(await candleCounts('SOLUSDT', '1h')).toEqual({ last: 3, mark: 2 });
    const rows = await db.execute({
      sql: "SELECT openTime, open, close FROM Candle WHERE symbol = 'SOLUSDT' AND interval = '1h' AND kind = 'last' ORDER BY openTime",
      args: [],
    });
    expect(rows.rows.map((r) => r.openTime)).toEqual([0, 1, 2].map((i) => new Date(T0 + i * H).toISOString()));
    expect(rows.rows.map((r) => r.close)).toEqual([0.5, 1.5, 2.5]);

    const fr = await db.execute({
      sql: "SELECT fundingTime, rate, markPrice FROM FundingRate WHERE symbol = 'SOLUSDT' ORDER BY fundingTime",
      args: [],
    });
    expect(fr.rows.map((r) => r.fundingTime)).toEqual([T0, T0 + 8 * H].map((t) => new Date(t).toISOString()));
    expect(fr.rows.map((r) => r.markPrice)).toEqual([42_000, 42_001]);
  });

  it('replaces only the symbol and interval it is given', async () => {
    await replaceDataset('ETHUSDT', '1h', klines(4, H), klines(0, H), funding(1));
    await replaceDataset('BTCUSDT', '1m', klines(5, 60_000), klines(5, 60_000), funding(1));

    await replaceDataset('BTCUSDT', '1h', klines(2, H), klines(2, H), funding(1));

    expect(await candleCounts('BTCUSDT', '1h')).toEqual({ last: 2, mark: 2 });
    expect(await candleCounts('BTCUSDT', '1m')).toEqual({ last: 5, mark: 5 });
    expect(await candleCounts('ETHUSDT', '1h')).toEqual({ last: 4 });
    expect(await fundingCount('ETHUSDT')).toBe(1);
  });

  it('rolls the whole replace back when one row is rejected, keeping the previous dataset', async () => {
    await replaceDataset('XRPUSDT', '1h', klines(3, H), klines(3, H), funding(2));
    const before = await candleCounts('XRPUSDT', '1h');

    // Duplicate open time in the execution series: the unique index rejects the insert,
    // after the old rows were already deleted inside the same transaction.
    const bad = klines(3, H);
    bad.t[2] = bad.t[1];
    await expect(replaceDataset('XRPUSDT', '1h', bad, klines(3, H), funding(2))).rejects.toThrow(/UNIQUE/i);

    expect(await candleCounts('XRPUSDT', '1h')).toEqual(before);
    expect(await fundingCount('XRPUSDT')).toBe(2);
  });

  it('writes more than one INSERT batch, in full', async () => {
    await replaceDataset('DOGEUSDT', '1m', klines(1201, 60_000), klines(0, 60_000), funding(0));
    expect(await candleCounts('DOGEUSDT', '1m')).toEqual({ last: 1201 });
  });

  it('reports the write stages in order', async () => {
    const stages: string[] = [];
    await writeDataset({
      symbol: 'ADAUSDT',
      interval: '1h',
      last: klines(1, H),
      mark: klines(1, H),
      funding: funding(1),
      onStage: (s) => stages.push(s),
    });
    expect(stages).toEqual([
      'deleted old rows',
      'inserted execution candles',
      'inserted mark candles',
      'inserted funding, committing',
    ]);
  });
});

describe('coverage (store worker)', () => {
  it('reports count and time bounds per symbol, interval and kind, plus funding counts', async () => {
    await replaceDataset('LINKUSDT', '4h', klines(3, 4 * H, 0), klines(2, 4 * H, 0), funding(2));
    const cov = await storeCoverage();

    const last = cov.candles.find((c) => c.symbol === 'LINKUSDT' && c.kind === 'last');
    const mark = cov.candles.find((c) => c.symbol === 'LINKUSDT' && c.kind === 'mark');
    expect(last).toEqual({
      symbol: 'LINKUSDT',
      interval: '4h',
      kind: 'last',
      count: 3,
      fromMs: T0,
      toMs: T0 + 2 * 4 * H,
    });
    expect(mark?.count).toBe(2);
    expect(cov.funding.find((f) => f.symbol === 'LINKUSDT')).toEqual({ symbol: 'LINKUSDT', count: 2 });
  });
});

describe('joinMarkPrice', () => {
  it('uses the latest mark close at or before each funding time', () => {
    const mark = klines(4, H); // closes 0.5, 1.5, 2.5, 3.5
    const last = klines(4, H, 100);
    const f: FundingSeries = {
      t: Float64Array.of(T0 - H, T0 + 2 * H, T0 + 2 * H + 1_800_000),
      rate: Float64Array.of(0.1, 0.2, 0.3),
    };
    const joined = joinMarkPrice(f, mark, last);
    expect(Array.from(joined.t)).toEqual(Array.from(f.t));
    expect(Array.from(joined.rate)).toEqual([0.1, 0.2, 0.3]);
    // Before the first bar: the first close. At 02:00 and at 02:30: the 02:00 close.
    expect(Array.from(joined.markPrice)).toEqual([0.5, 2.5, 2.5]);
  });

  it('falls back to execution closes when there are no mark klines', () => {
    const last = klines(3, H, 100); // closes 100.5, 101.5, 102.5
    const f: FundingSeries = { t: Float64Array.of(T0 + H), rate: Float64Array.of(0.1) };
    const joined = joinMarkPrice(f, klines(0, H), last);
    expect(Array.from(joined.markPrice)).toEqual([101.5]);
  });

  it('returns 0 for every funding event when there are no klines at all', () => {
    const f: FundingSeries = { t: Float64Array.of(T0), rate: Float64Array.of(0.1) };
    const joined = joinMarkPrice(f, klines(0, H), klines(0, H));
    expect(Array.from(joined.markPrice)).toEqual([0]);
  });
});
