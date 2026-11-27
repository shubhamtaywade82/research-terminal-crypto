import {
  FUNDING_FIELDS,
  KLINE_FIELDS,
  klineGapDays,
  mergeSeries,
  stopDecodeWorker,
  type FundingSeries,
  type KlineSeries,
} from '@/lib/datasources/decode-pool';

const H = 3_600_000;
const DAY = 86_400_000;
const JAN1 = Date.UTC(2025, 0, 1);

function klines(times: number[], close: (i: number) => number): KlineSeries {
  const n = times.length;
  const s = {
    t: Float64Array.from(times),
    o: new Float64Array(n),
    h: new Float64Array(n),
    l: new Float64Array(n),
    c: new Float64Array(n),
    v: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    s.o[i] = close(i);
    s.h[i] = close(i) + 1;
    s.l[i] = close(i) - 1;
    s.c[i] = close(i);
    s.v[i] = 1;
  }
  return s;
}

afterAll(() => stopDecodeWorker());

describe('mergeSeries (worker)', () => {
  it('sorts by time and keeps the LAST occurrence of a repeated timestamp', async () => {
    const a = klines([1, 2, 3], (i) => 10 * (i + 1)); // closes 10, 20, 30
    const b = klines([3, 4], (i) => 300 + 100 * i); // closes 300, 400
    const merged = await mergeSeries([a, b], KLINE_FIELDS);
    expect(Array.from(merged.t)).toEqual([1, 2, 3, 4]);
    expect(Array.from(merged.c)).toEqual([10, 20, 300, 400]);
    expect(Array.from(merged.h)).toEqual([11, 21, 301, 401]);
  });

  it('does not consume its inputs', async () => {
    const a = klines([5, 6], () => 1);
    await mergeSeries([a], KLINE_FIELDS);
    expect(Array.from(a.t)).toEqual([5, 6]);
    expect(a.c.length).toBe(2);
  });

  it('merges funding series on the rate field', async () => {
    const f1: FundingSeries = { t: Float64Array.of(1, 3), rate: Float64Array.of(0.1, 0.3) };
    const f2: FundingSeries = { t: Float64Array.of(2), rate: Float64Array.of(0.2) };
    const merged = await mergeSeries([f1, f2], FUNDING_FIELDS);
    expect(Array.from(merged.t)).toEqual([1, 2, 3]);
    expect(Array.from(merged.rate)).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('klineGapDays (worker)', () => {
  it('returns no days when the series is contiguous', async () => {
    const s = klines([0, H, 2 * H, 3 * H], () => 1);
    expect(Array.from(await klineGapDays(s, H))).toEqual([]);
  });

  it('reports the UTC day of each missing bar, once per day', async () => {
    // Missing hours 1..24: Jan 1 01:00 through Jan 2 00:00, touching two UTC days.
    const s = klines([JAN1, JAN1 + 25 * H], () => 1);
    expect(Array.from(await klineGapDays(s, H))).toEqual([JAN1, JAN1 + DAY]);
  });

  it('reports a single-bar hole in the middle of a day', async () => {
    const s = klines([JAN1, JAN1 + H, JAN1 + 3 * H], () => 1);
    expect(Array.from(await klineGapDays(s, H))).toEqual([JAN1]);
  });
});
