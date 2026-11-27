import type { Candle, StrategyParams, TrendSignal } from '@/lib/nprs/types';
import { DEFAULT_PARAMS } from '@/lib/nprs/defaults';
import type { AggTradeSource } from '@/lib/datasources/aggtrades';
import { runBacktest, runRefinedBacktest } from '@/lib/nprs/engine';
import { runTickBacktest, TICK_MAX_DAYS } from '@/lib/nprs/tick-engine';

let mockSignals: TrendSignal[] = [];
jest.mock('@/lib/nprs/strategies', () => ({
  getStrategy: () => ({ computeSignals: () => mockSignals }),
}));

const H = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2025, 0, 1);

type Print = { t: number; p: number };

/** Prints for signal bar i: the prices in order, spread evenly across the hour. */
function barPrints(i: number, px: number[]): Print[] {
  return px.map((p, k) => ({ t: T0 + i * H + Math.round((k * H) / px.length), p }));
}

/** Candle derived from the prints (open = first print, close = last print). */
function candleFrom(i: number, prints: Print[]): Candle {
  const ps = prints.map((x) => x.p);
  return {
    t: T0 + i * H,
    o: ps[0],
    h: Math.max(...ps),
    l: Math.min(...ps),
    c: ps[ps.length - 1],
    v: 1,
  };
}

/** In-memory aggTrades source; `missing` days answer null like an unpublished day. */
function fakeSource(prints: Print[], missing: number[] = []): AggTradeSource {
  const sorted = [...prints].sort((a, b) => a.t - b.t);
  return {
    symbol: 'TEST',
    stats: { daysLoaded: 0, daysMissing: 0 },
    async day(d: number) {
      if (missing.includes(d)) return null;
      const sel = sorted.filter((x) => x.t >= d && x.t < d + DAY);
      return {
        t: Float64Array.from(sel, (x) => x.t),
        p: Float64Array.from(sel, (x) => x.p),
      };
    },
    async window(fromMs: number, toMs: number) {
      const sel = sorted.filter((x) => x.t >= fromMs && x.t < toMs);
      return {
        t: Float64Array.from(sel, (x) => x.t),
        p: Float64Array.from(sel, (x) => x.p),
      };
    },
  };
}

function baseParams(over: Partial<StrategyParams> = {}): StrategyParams {
  return {
    ...DEFAULT_PARAMS,
    interval: '1h',
    startingEquity: 10_000,
    initialAllocPct: 10,
    leverage: 10,
    dcaAllocPct: 5,
    maxDcaLayers: 3,
    maxMarginPct: 50,
    spacingMode: 'fixed',
    spacingPct: 2,
    targetRoiPct: 10,
    maxHoldHours: 0,
    feeMakerPct: 0,
    feeTakerPct: 0,
    slippagePct: 0,
    fundingMode: 'fixed',
    fixedFundingPctPer8h: 0,
    mmrPct: 0.5,
    directionMode: 'both',
    blockDcaOnFlip: false,
    blockDcaOnWarning: false,
    exitOnTrendFlip: false,
    forceCloseAtRisk: false,
    ...over,
  };
}

/** Build candles + prints from per-bar price lists; signals are injected. */
function scenario(bars: number[][], signals: TrendSignal[]) {
  const prints: Print[] = [];
  const candles: Candle[] = [];
  bars.forEach((px, i) => {
    const bp = barPrints(i, px);
    prints.push(...bp);
    candles.push(candleFrom(i, bp));
  });
  mockSignals = signals;
  return { candles, prints };
}

const range = (n: number) => ({ fromMs: T0, toMs: T0 + n * H });

describe('tick engine: print ordering inside one bar', () => {
  // Entry at bar 2 open (100). The 98 DCA limit and the ~101 take-profit are both
  // inside bar 2's range, so the order of the prints decides the outcome.
  const signals: TrendSignal[] = ['FLAT', 'LONG', 'FLAT', 'FLAT'];

  it('take-profit printed before the dip: no averaging fill', async () => {
    const { candles, prints } = scenario(
      [[100], [100], [100, 101.5, 97], [100]],
      signals,
    );
    const res = await runTickBacktest(baseParams(), { candles, funding: [], source: fakeSource(prints) }, range(4));
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0].exitReason).toBe('TAKE_PROFIT');
    expect(res.trades[0].dcaLayers).toBe(0);
  });

  it('dip printed before the rally: averaging fills, then take-profit', async () => {
    const { candles, prints } = scenario(
      [[100], [100], [100, 97, 101.5], [100]],
      signals,
    );
    const res = await runTickBacktest(baseParams(), { candles, funding: [], source: fakeSource(prints) }, range(4));
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0].exitReason).toBe('TAKE_PROFIT');
    expect(res.trades[0].dcaLayers).toBe(1);
    expect(Math.abs(res.trades[0].roiOnMargin - 10)).toBeLessThan(1e-6);
  });

  it('the bar engine cannot tell these two orders apart (dip-then-rally)', () => {
    // Same OHLC as the dip-first sequence: the bar engine always fills the dip first.
    const { candles } = scenario([[100], [100], [100, 97, 101.5], [100]], signals);
    const res = runBacktest(candles, [], baseParams());
    expect(res.trades[0].dcaLayers).toBe(1);
  });
});

describe('tick engine: events on individual prints', () => {
  it('liquidates on the print that breaches the boundary', async () => {
    // Liquidation boundary for an entry at 100 at 10x with mmr 0.5%: 90.5.
    const signals: TrendSignal[] = ['FLAT', 'LONG', 'FLAT', 'FLAT'];
    const { candles, prints } = scenario([[100], [100], [100, 88, 95], [95]], signals);
    const res = await runTickBacktest(baseParams(), { candles, funding: [], source: fakeSource(prints) }, range(4));
    expect(res.trades[0].exitReason).toBe('LIQUIDATION');
    expect(res.trades[0].netPnl).toBeCloseTo(-1000, 6);
    expect(res.metrics.finalEquity).toBeCloseTo(9000, 6);
  });

  it('max hold exits on the first print past the limit, not at the bar close', async () => {
    mockSignals = ['FLAT', ...Array(7).fill('LONG')];
    const bars = Array.from({ length: 8 }, () => [100, 100.1]);
    const { candles, prints } = scenario(bars, mockSignals);
    const res = await runTickBacktest(baseParams({ maxHoldHours: 2 }), { candles, funding: [], source: fakeSource(prints) }, range(8));
    const t = res.trades[0];
    expect(t.exitReason).toBe('MAX_HOLD');
    // Entry at bar 2 open; the first print of bar 4 is exactly 2h later.
    expect(t.closeTime).toBe(T0 + 4 * H);
    expect(t.holdMinutes).toBeCloseTo(120, 6);
  });

  it('applies historical funding at its timestamp to the held position', async () => {
    const signals: TrendSignal[] = ['FLAT', 'LONG', 'FLAT', 'FLAT'];
    const { candles, prints } = scenario([[100], [100], [100, 100.1], [100]], signals);
    const funding = [{ t: T0 + 2 * H + 30 * 60_000, rate: 0.0001, markPrice: 100 }];
    const res = await runTickBacktest(
      baseParams({ fundingMode: 'historical' }),
      { candles, funding, source: fakeSource(prints) },
      range(4),
    );
    // Long 100 units at 100 pays 0.0001 * 100 * 100 = 1 USDT once.
    expect(res.trades[0].funding).toBeCloseTo(1, 9);
  });
});

describe('tick engine: funding attribution', () => {
  it('does not charge funding that settled before the position was opened', async () => {
    const signals: TrendSignal[] = ['FLAT', 'LONG', 'FLAT', 'FLAT'];
    const { candles, prints } = scenario([[100], [100], [100, 100.1], [100]], signals);
    // Settles at T0 (before the window and before entry at bar 2): must not be charged.
    const funding = [{ t: T0, rate: 0.01, markPrice: 100 }];
    const res = await runTickBacktest(
      baseParams({ fundingMode: 'historical' }),
      { candles, funding, source: fakeSource(prints) },
      range(4),
    );
    expect(res.trades[0].funding).toBeCloseTo(0, 12);
    expect(res.trades[0].exitPrice).toBeGreaterThan(0);
  });
});

describe('tick engine: invariants and limits', () => {
  it.each([3, 17])('PnL reconciles and take-profits realise the target (seed %i)', async (seed) => {
    let s = seed;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const n = 240;
    const bars: number[][] = [];
    let p = 100;
    for (let i = 0; i < n; i++) {
      const px: number[] = [];
      for (let k = 0; k < 5; k++) {
        p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.004));
        px.push(p);
      }
      bars.push(px);
    }
    mockSignals = ['FLAT', ...Array(n - 1).fill('LONG')];
    const { candles, prints } = scenario(bars, mockSignals);
    const params = baseParams({ feeMakerPct: 0.02, feeTakerPct: 0.05, slippagePct: 0.02 });
    const res = await runTickBacktest(params, { candles, funding: [], source: fakeSource(prints) }, range(n));
    const sum = res.trades.reduce((acc, t) => acc + t.netPnl, 0);
    expect(Math.abs(sum - (res.metrics.finalEquity - 10_000))).toBeLessThan(1e-6);
    for (const t of res.trades.filter((x) => x.exitReason === 'TAKE_PROFIT')) {
      expect(Math.abs(t.roiOnMargin - 10)).toBeLessThan(1e-6);
    }
    expect(res.tickStats.prints).toBe(prints.length);
  });

  it('refuses a range that needs an unpublished aggTrades day', async () => {
    const { candles, prints } = scenario([[100], [100], [100], [100]], ['FLAT', 'FLAT', 'FLAT', 'FLAT']);
    const src = fakeSource(prints, [T0]);
    await expect(
      runTickBacktest(baseParams(), { candles, funding: [], source: src }, range(4)),
    ).rejects.toThrow(/not published/);
  });

  it('refuses ranges longer than the tick limit', async () => {
    const n = TICK_MAX_DAYS + 2;
    const candles: Candle[] = Array.from({ length: n }, (_, i) => ({
      t: T0 + i * DAY,
      o: 100,
      h: 100,
      l: 100,
      c: 100,
      v: 1,
    }));
    mockSignals = Array(n).fill('FLAT');
    await expect(
      runTickBacktest(
        baseParams({ interval: '1d' }),
        { candles, funding: [], source: fakeSource([]) },
        { fromMs: T0, toMs: T0 + n * DAY },
      ),
    ).rejects.toThrow(/limit/);
  });
});

describe('refined mode: exact order only where a DCA limit is reachable', () => {
  const signals: TrendSignal[] = ['FLAT', 'LONG', 'FLAT', 'FLAT'];

  it('replays the take-profit-first bar in print order', async () => {
    const { candles, prints } = scenario([[100], [100], [100, 101.5, 97], [100]], signals);
    const res = await runRefinedBacktest(candles, [], baseParams(), fakeSource(prints), undefined, range(4));
    expect(res.trades[0].dcaLayers).toBe(0);
    expect(res.metrics.intrabarRefinedBars).toBe(1);
    expect(res.metrics.intrabarFallbackBars).toBe(0);
  });

  it('falls back to the OHLC rule, and counts it, when trades are unavailable', async () => {
    const { candles, prints } = scenario([[100], [100], [100, 101.5, 97], [100]], signals);
    const src = { ...fakeSource(prints), window: async () => null };
    const res = await runRefinedBacktest(candles, [], baseParams(), src, undefined, range(4));
    expect(res.trades[0].dcaLayers).toBe(1); // dip-then-rally, as the bar engine
    expect(res.metrics.intrabarFallbackBars).toBe(1);
    expect(res.metrics.intrabarRefinedBars).toBe(0);
  });

  it('does not change bars where no DCA limit is reachable', async () => {
    const flatBars = Array.from({ length: 6 }, () => [100, 100.1]);
    const { candles, prints } = scenario(flatBars, ['FLAT', ...Array(5).fill('LONG')]);
    const bar = runBacktest(candles, [], baseParams());
    const refined = await runRefinedBacktest(candles, [], baseParams(), fakeSource(prints), undefined, range(6));
    expect(JSON.stringify(refined.trades)).toEqual(JSON.stringify(bar.trades));
    expect(refined.metrics.intrabarRefinedBars).toBe(0);
  });
});

