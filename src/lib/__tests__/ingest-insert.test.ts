import type { Tx } from '@/lib/ingest';
import { insertCandles, insertFunding } from '@/lib/ingest';

// The ingest module creates the database client at import. These tests only exercise
// SQL generation, so the client is replaced with a stub that is never queried.
jest.mock('@/lib/db', () => ({ db: {} }));

type Call = { sql: string; params: unknown[] };

/** Records every raw statement the ingest would send inside its transaction. */
function fakeTx(): { tx: Tx; calls: Call[] } {
  const calls: Call[] = [];
  const tx = {
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      calls.push({ sql, params });
      return 0;
    },
  } as unknown as Tx;
  return { tx, calls };
}

const candle = (i: number) => ({
  openTime: Date.UTC(2026, 0, 1) + i * 60_000,
  open: 100 + i,
  high: 101 + i,
  low: 99 + i,
  close: 100.5 + i,
  volume: 10 + i,
});

describe('ingest raw inserts', () => {
  it('writes candles as multi-row INSERTs in batches of 500, with values as parameters', async () => {
    const { tx, calls } = fakeTx();
    const rows = Array.from({ length: 1201 }, (_, i) => candle(i));
    await insertCandles(tx, 'BTCUSDT', '1m', 'mark', rows);

    expect(calls.map((c) => c.params.length / 9)).toEqual([500, 500, 201]);
    const first = calls[0];
    expect(first.sql).toBe(
      `INSERT INTO Candle (symbol, interval, kind, openTime, open, high, low, close, volume) VALUES ${Array(500).fill('(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    );
    // Row order and column mapping: symbol, interval, kind, ISO time, then OHLCV.
    expect(first.params.slice(0, 9)).toEqual([
      'BTCUSDT',
      '1m',
      'mark',
      new Date(rows[0].openTime).toISOString(),
      rows[0].open,
      rows[0].high,
      rows[0].low,
      rows[0].close,
      rows[0].volume,
    ]);
    // The last batch starts at row 1000 and ends at row 1200: the tail, not a repeat.
    const lastBatch = calls[2].params;
    expect(lastBatch[3]).toBe(new Date(rows[1000].openTime).toISOString());
    expect(lastBatch[lastBatch.length - 6]).toBe(new Date(rows[1200].openTime).toISOString());
  });

  it('writes funding in batches with the funding timestamp in ISO form', async () => {
    const { tx, calls } = fakeTx();
    const funding = [
      { t: Date.UTC(2026, 0, 1, 8), rate: 0.0001, markPrice: 42000 },
      { t: Date.UTC(2026, 0, 1, 16), rate: -0.0002, markPrice: 42100 },
    ];
    await insertFunding(tx, 'ETHUSDT', funding);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe('INSERT INTO FundingRate (symbol, fundingTime, rate, markPrice) VALUES (?, ?, ?, ?), (?, ?, ?, ?)');
    expect(calls[0].params).toEqual([
      'ETHUSDT',
      '2026-01-01T08:00:00.000Z',
      0.0001,
      42000,
      'ETHUSDT',
      '2026-01-01T16:00:00.000Z',
      -0.0002,
      42100,
    ]);
  });

  it('writes nothing for an empty series', async () => {
    const { tx, calls } = fakeTx();
    await insertCandles(tx, 'BTCUSDT', '1m', 'last', []);
    await insertFunding(tx, 'BTCUSDT', []);
    expect(calls).toHaveLength(0);
  });
});
