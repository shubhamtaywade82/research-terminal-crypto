import { liquidationPrice, marginRatioOf, riskStateOf, unrealizedPnl } from '@/lib/nprs/margin';
import { sanitizeParams } from '@/lib/nprs/validate';
import { DEFAULT_PARAMS } from '@/lib/nprs/defaults';
import {
  computeAtr,
  computeBollinger,
  computeDonchian,
  computeEma,
  computeRoc,
  computeRsi,
  computeSupertrend,
} from '@/lib/nprs/indicators';
import type { Candle } from '@/lib/nprs/types';

const candle = (t: number, o: number, h: number, l: number, c: number): Candle => ({
  t,
  o,
  h,
  l,
  c,
  v: 1,
});

describe('margin', () => {
  it('isolated liquidation boundary: LONG below entry, SHORT above', () => {
    expect(liquidationPrice(100, 10, 0.005, 'LONG')).toBeCloseTo(90.5, 9);
    expect(liquidationPrice(100, 10, 0.005, 'SHORT')).toBeCloseTo(109.5, 9);
  });

  it('unrealized PnL is signed by direction', () => {
    expect(unrealizedPnl('LONG', 2, 100, 110)).toBe(20);
    expect(unrealizedPnl('SHORT', 2, 100, 110)).toBe(-20);
  });

  it('margin ratio is capped at 10 once the balance is exhausted', () => {
    expect(marginRatioOf(0.005, 1, 100, 10, -10)).toBe(10);
    expect(marginRatioOf(0.005, 1, 100, 10, 0)).toBeCloseTo(0.5 / 10, 9);
  });

  it('risk state thresholds are inclusive at the boundary', () => {
    expect(riskStateOf(0.49, 0.5, 0.8)).toBe('SAFE');
    expect(riskStateOf(0.5, 0.5, 0.8)).toBe('WARNING');
    expect(riskStateOf(0.8, 0.5, 0.8)).toBe('CRITICAL');
  });
});

describe('validate.sanitizeParams', () => {
  it('returns the baseline for an empty payload', () => {
    const p = sanitizeParams({});
    expect(p.strategyId).toBe(DEFAULT_PARAMS.strategyId);
    expect(p.leverage).toBe(DEFAULT_PARAMS.leverage);
    expect(p.interval).toBe(DEFAULT_PARAMS.interval);
  });

  it('clamps numeric fields into their allowed ranges', () => {
    const p = sanitizeParams({ leverage: 500, maxDcaLayers: -4, startingEquity: 5 });
    expect(p.leverage).toBe(125);
    expect(p.maxDcaLayers).toBe(0);
    expect(p.startingEquity).toBe(100);
  });

  it('swaps an inverted EMA pair so trend rules keep their meaning', () => {
    const p = sanitizeParams({ emaFast: 200, emaSlow: 50 });
    expect(p.emaFast).toBe(50);
    expect(p.emaSlow).toBe(200);
  });

  it('keeps the risk ladder strictly increasing (WARNING < CRITICAL)', () => {
    const p = sanitizeParams({ riskWarningRatio: 0.9, riskCriticalRatio: 0.5 });
    expect(p.riskCriticalRatio).toBeGreaterThan(p.riskWarningRatio);
  });

  it('falls back to the default strategy for unknown ids and drops unknown keys', () => {
    expect(sanitizeParams({ strategyId: 'not-a-strategy' }).strategyId).toBe('ema-trend');
    const p = sanitizeParams({
      strategyId: 'ema-rsi',
      signalParams: { rsiPeriod: 500, injected: 1 },
    });
    expect(p.signalParams).toEqual({ rsiPeriod: 100, rsiLongMin: 50, rsiShortMax: 50 });
  });

  it('accepts the 1m interval and falls back to the default for unknown ones', () => {
    expect(sanitizeParams({ interval: '1m' }).interval).toBe('1m');
    expect(sanitizeParams({ interval: '2h' }).interval).toBe(DEFAULT_PARAMS.interval);
  });

  it('normalises the symbol', () => {
    expect(sanitizeParams({ symbol: '  ethusdt ' }).symbol).toBe('ETHUSDT');
  });
});

describe('indicators', () => {
  it('EMA is seeded with the SMA of the first window', () => {
    const ema = computeEma([1, 2, 3, 4], 2);
    expect(ema[0]).toBeNull();
    expect(ema[1]).toBeCloseTo(1.5, 9);
    expect(ema[2]).toBeCloseTo(2.5, 9);
  });

  it('RSI saturates at 100 for pure gains and 0 for pure losses', () => {
    expect(computeRsi([1, 2, 3, 4, 5], 2)[4]).toBe(100);
    expect(computeRsi([5, 4, 3, 2, 1], 2)[4]).toBe(0);
  });

  it('Bollinger uses the population standard deviation', () => {
    const b = computeBollinger([1, 2, 3, 4, 5], 5, 2);
    expect(b.mid[4]).toBeCloseTo(3, 9);
    expect(b.upper[4]).toBeCloseTo(3 + 2 * Math.SQRT2, 9);
  });

  it('Donchian channel excludes the current bar (no lookahead)', () => {
    const cs = [1, 2, 3, 10].map((h, i) => candle(i, h, h, h, h));
    expect(computeDonchian(cs, 3).upper[3]).toBe(3);
  });

  it('ATR of constant true range equals that range', () => {
    const cs = Array.from({ length: 10 }, (_, i) => candle(i, 100, 101, 100, 100.5));
    expect(computeAtr(cs, 3)[9]).toBeCloseTo(1, 9);
  });

  it('ROC is a percentage change over the look-back', () => {
    expect(computeRoc([100, 110], 1)[1]).toBeCloseTo(10, 9);
  });

  it('Supertrend turns bullish on a sustained rally', () => {
    const cs = Array.from({ length: 40 }, (_, i) => {
      const p = 100 + i * 2;
      return candle(i, p, p + 1, p - 1, p + 0.5);
    });
    const st = computeSupertrend(cs, 10, 3);
    expect(st.dir[39]).toBe(1);
  });
});
