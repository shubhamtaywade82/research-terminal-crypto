import type { Candle, StrategyParams, TrendSignal } from '@/lib/nprs/types';
import { DEFAULT_PARAMS } from '@/lib/nprs/defaults';

// Signals are injected so every test decides exactly which bar fires an entry
// or exit. The engine still runs its real DCA / margin / fee / risk code.
let mockSignals: TrendSignal[] = [];
jest.mock('@/lib/nprs/strategies', () => ({
  getStrategy: () => ({ computeSignals: () => mockSignals }),
}));

// Imported after the mock declaration (jest hoists jest.mock above imports anyway).
import { runBacktest } from '@/lib/nprs/engine';

const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  t: T0 + i * H,
  o,
  h,
  l,
  c,
  v: 1,
});

/** Flat bar at a single price. */
const flat = (i: number, p: number): Candle => bar(i, p, p, p, p);

/** Friction-free baseline: 10x, 10% initial margin, 2% grid, no fees/funding. */
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

/** Deterministic synthetic path for property tests (fixture only, not product data). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomWalk(n: number, seed: number): Candle[] {
  const r = rng(seed);
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = Math.max(1, o + (r() - 0.5) * 2 * 0.012 * o);
    const h = Math.max(o, c) * (1 + r() * 0.004);
    const l = Math.min(o, c) * (1 - r() * 0.004);
    out.push(bar(i, o, h, l, c));
    p = c;
  }
  return out;
}

describe('engine: entry bar is fully managed', () => {
  it('fills a DCA level that is touched on the entry candle itself', () => {
    // Signal on bar 1 -> entry at bar 2 OPEN (100). Bar 2 dips to 97, through the
    // 98 grid level. Before the fix the entry bar skipped DCA fills entirely.
    mockSignals = ['FLAT', 'LONG', 'FLAT', 'FLAT', 'FLAT'];
    const candles = [
      flat(0, 100),
      flat(1, 100),
      bar(2, 100, 100, 97, 100),
      bar(3, 100, 100.2, 99.5, 100),
      bar(4, 100, 100.2, 99.5, 100),
    ];
    const res = runBacktest(candles, [], baseParams());
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0].dcaLayers).toBe(1);
    expect(res.trades[0].exitReason).toBe('END_OF_DATA');
  });
});

describe('engine: accounting and take-profit invariants', () => {
  const frictions = {
    feeMakerPct: 0.02,
    feeTakerPct: 0.05,
    slippagePct: 0.02,
    fundingMode: 'fixed' as const,
    fixedFundingPctPer8h: 0.01,
  };

  it.each([7, 42, 1234])(
    'sum of trade PnL equals the equity change (seed %i)',
    (seed) => {
      const candles = randomWalk(400, seed);
      mockSignals = ['FLAT', ...Array(candles.length - 1).fill('LONG')];
      const res = runBacktest(candles, [], baseParams(frictions));
      const sum = res.trades.reduce((s, t) => s + t.netPnl, 0);
      expect(Math.abs(sum - (res.metrics.finalEquity - 10_000))).toBeLessThan(1e-6);
    },
  );

  it.each([7, 42, 1234])(
    'every take-profit realises exactly the target ROI net of slippage and fees (seed %i)',
    (seed) => {
      const candles = randomWalk(400, seed);
      mockSignals = ['FLAT', ...Array(candles.length - 1).fill('SHORT')];
      const res = runBacktest(candles, [], baseParams(frictions));
      const tp = res.trades.filter((t) => t.exitReason === 'TAKE_PROFIT');
      expect(tp.length).toBeGreaterThan(0);
      for (const t of tp) {
        expect(Math.abs(t.roiOnMargin - 10)).toBeLessThan(1e-6);
      }
    },
  );

  it('a liquidation forfeits exactly the deployed margin, fees and funding', () => {
    mockSignals = ['FLAT', 'LONG', 'FLAT', 'FLAT'];
    // Entry at 100, liquidation boundary 100 * (1 - 1/10 + 0.5%) = 90.5. Mark low 88 breaches it.
    const candles = [flat(0, 100), flat(1, 100), bar(2, 100, 100.5, 88, 95), flat(3, 95)];
    const res = runBacktest(candles, [], baseParams());
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0];
    expect(t.exitReason).toBe('LIQUIDATION');
    expect(t.netPnl).toBeCloseTo(-1000, 6);
    expect(res.metrics.finalEquity).toBeCloseTo(9_000, 6);
    expect(res.metrics.liquidations).toBe(1);
    expect(res.riskEvents.map((e) => e.type)).toContain('LIQUIDATION');
  });
});

describe('engine: exit timing', () => {
  it('exits on a trend flip at the next bar OPEN and never re-enters on that bar', () => {
    // Entry at bar 2 open (signal from bar 1). Bar 3 opens with signal[2]=SHORT:
    // exit at bar 3 open = 100.5. signal[3] is FLAT so no SHORT is opened later.
    mockSignals = ['FLAT', 'LONG', 'SHORT', 'FLAT', 'FLAT', 'FLAT'];
    const candles = [
      flat(0, 100),
      flat(1, 100),
      bar(2, 100, 100.5, 99.8, 100),
      bar(3, 100.5, 100.8, 100.2, 100.6),
      flat(4, 100.6),
      flat(5, 100.6),
    ];
    const res = runBacktest(candles, [], baseParams({ exitOnTrendFlip: true }));
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0];
    expect(t.exitReason).toBe('TREND_FLIP');
    expect(t.closeTime).toBe(T0 + 3 * H);
    expect(t.exitPrice).toBeCloseTo(100.5, 9);
    expect(t.direction).toBe('LONG');
  });

  it('prices max-hold exits at the bar close and stamps the close time', () => {
    mockSignals = ['FLAT', ...Array(7).fill('LONG')];
    // Flat-ish market: no take-profit (needs 101), no DCA (98 never touched).
    const candles = Array.from({ length: 8 }, (_, i) => bar(i, 100, 100.2, 99.8, 100));
    const res = runBacktest(candles, [], baseParams({ maxHoldHours: 2 }));
    const t = res.trades[0];
    expect(t.exitReason).toBe('MAX_HOLD');
    // Opened at bar 2 open; 2h elapsed at bar 4, which closes at bar 4 + 1h.
    expect(t.closeTime).toBe(T0 + 5 * H);
    expect(t.holdMinutes).toBeCloseTo(180, 6);
  });
});

describe('engine: capital and signal controls', () => {
  it('skips new entries while the free balance is below the baseline allocation', () => {
    mockSignals = ['FLAT', 'LONG', 'FLAT', 'FLAT', 'FLAT', 'LONG', 'FLAT', 'FLAT'];
    const candles = [
      flat(0, 100),
      flat(1, 100),
      bar(2, 100, 100.5, 88, 95), // liquidated: wallet drops to 0
      flat(3, 95),
      flat(4, 95),
      flat(5, 95),
      flat(6, 95),
      flat(7, 95),
    ];
    const res = runBacktest(
      candles,
      [],
      baseParams({ startingEquity: 1000, initialAllocPct: 100 }),
    );
    expect(res.trades).toHaveLength(1);
    const skips = res.riskEvents.filter((e) => e.type === 'ENTRY_SKIPPED');
    expect(skips).toHaveLength(1);
  });

  it('respects directionMode: long-only never opens a SHORT', () => {
    mockSignals = ['FLAT', ...Array(9).fill('SHORT')];
    const candles = randomWalk(10, 99);
    const res = runBacktest(candles, [], baseParams({ directionMode: 'long' }));
    expect(res.trades.every((t) => t.direction === 'LONG')).toBe(true);
  });

  it('rejects input too short to simulate', () => {
    expect(() => runBacktest([flat(0, 100)], [], baseParams())).toThrow(/Not enough candles/);
  });
});

describe('engine: no lookahead', () => {
  it('decisions on bar i do not change when candles after bar i are altered', () => {
    const n = 120;
    const cut = 60;
    const base = randomWalk(n, 7);
    const altered = base.map((c, i) =>
      i <= cut ? c : bar(i, 50, 50, 50, 50),
    );
    mockSignals = ['FLAT', ...Array(n - 1).fill('LONG')];
    const a = runBacktest(base, [], baseParams());
    const b = runBacktest(altered, [], baseParams());
    const cutoff = base[cut].t;
    const before = (trades: typeof a.trades) => trades.filter((t) => t.closeTime <= cutoff);
    expect(before(b.trades)).toEqual(before(a.trades));
  });
});

describe('engine: sub-hourly bars', () => {
  const M = 60_000;

  it('times max-hold exits in real minutes on 1m bars', () => {
    // Signal on bar 1 -> entry at bar 2 open. Max hold 1h = 60 bars, so the exit
    // is at bar 62 close, stamped 63 minutes after the epoch-based t0.
    mockSignals = ['FLAT', ...Array(89).fill('LONG')];
    const candles = Array.from({ length: 90 }, (_, i) => ({
      t: T0 + i * M,
      o: 100,
      h: 100.1,
      l: 99.9,
      c: 100,
      v: 1,
    }));
    const res = runBacktest(candles, [], baseParams({ interval: '1m', maxHoldHours: 1 }));
    const t = res.trades[0];
    expect(t.exitReason).toBe('MAX_HOLD');
    expect(t.closeTime).toBe(T0 + 63 * M);
    expect(t.holdMinutes).toBeCloseTo(61, 6);
  });
});

