// ---------------------------------------------------------------------------
// NPRS - Entry signal strategy registry.
//
// The research question of NPRS is "does progressive averaging rescue a
// leveraged trend entry before liquidation?" - the entry signal is a
// controlled variable. Every strategy below produces the same TrendSignal[]
// contract the engine consumes (evaluated on close, consumed one bar
// later - no lookahead), so the DCA / margin / liquidation / funding
// machinery stays identical across strategies.
//
//   state-style strategies stay signaled while their regime holds
//     -> the engine can re-enter immediately after a take-profit.
//   event-style strategies fire only on the crossing/breakout bar
//     -> entries happen exactly at signal events.
// ---------------------------------------------------------------------------

import { Candle, StrategyParams, TrendSignal } from './types';
import {
  computeBollinger,
  computeDonchian,
  computeEma,
  computeMacd,
  computeRoc,
  computeRsi,
  computeSupertrend,
  computeTrendSignals,
} from './indicators';

export type StrategyCategory = 'trend' | 'momentum' | 'breakout' | 'volatility';

/** How the engine should treat the signal stream. */
export type SignalStyle = 'state' | 'event';

export interface SignalParamDef {
  key: string;
  label: string;
  /** compact token used in auto labels, e.g. "RSI 14 / L≥50" */
  short?: string;
  default: number;
  min: number;
  max: number;
  step: number;
  hint?: string;
}

export interface SignalStrategy {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: StrategyCategory;
  style: SignalStyle;
  /** strategy reads the shared emaFast / emaSlow fields of StrategyParams */
  usesEma?: boolean;
  params: SignalParamDef[];
  computeSignals(candles: Candle[], p: StrategyParams): TrendSignal[];
}

/** Read a strategy param with its registered default. */
function sp(p: StrategyParams, def: SignalParamDef): number {
  const v = p.signalParams?.[def.key];
  return typeof v === 'number' && Number.isFinite(v) ? v : def.default;
}

const flat = (n: number): TrendSignal[] => new Array(n).fill('FLAT');

const closesOf = (candles: Candle[]): number[] => candles.map((c) => c.c);

const emaPair = (p: StrategyParams, values: number[]) => ({
  fast: computeEma(values, Math.max(2, Math.round(p.emaFast))),
  slow: computeEma(values, Math.max(3, Math.round(p.emaSlow))),
});

// --- 1. EMA Trend Filter (spec baseline) ------------------------------------

const emaTrend: SignalStrategy = {
  id: 'ema-trend',
  name: 'EMA Trend Filter',
  tagline: 'Regime filter: fast EMA above slow AND price beyond fast',
  description:
    'NPRS spec baseline. While the fast EMA is above the slow EMA and the close trades above the fast EMA the signal is LONG (mirrored for SHORT). State-based: it re-enters after a take-profit whenever the regime still holds.',
  category: 'trend',
  style: 'state',
  usesEma: true,
  params: [],
  computeSignals(candles, p) {
    const { fast, slow } = emaPair(p, closesOf(candles));
    return computeTrendSignals(candles, fast, slow);
  },
};

// --- 2. EMA Cross (classic golden / death cross) ------------------------------

const emaCross: SignalStrategy = {
  id: 'ema-cross',
  name: 'EMA Cross',
  tagline: 'Classic golden / death cross, entries only on the crossing bar',
  description:
    'LONG when the fast EMA crosses above the slow EMA, SHORT on the cross below. Event-based: entries occur exactly at the cross, never on later bars - the purest trend-entry control against the baseline filter.',
  category: 'trend',
  style: 'event',
  usesEma: true,
  params: [],
  computeSignals(candles, p) {
    const closes = closesOf(candles);
    const { fast, slow } = emaPair(p, closes);
    const out = flat(candles.length);
    for (let i = 1; i < candles.length; i++) {
      const f0 = fast[i - 1];
      const s0 = slow[i - 1];
      const f1 = fast[i];
      const s1 = slow[i];
      if (f0 == null || s0 == null || f1 == null || s1 == null) continue;
      if (f0 <= s0 && f1 > s1) out[i] = 'LONG';
      else if (f0 >= s0 && f1 < s1) out[i] = 'SHORT';
    }
    return out;
  },
};

// --- 3. EMA Cross + RSI confirmation -----------------------------------------

const emaRsi: SignalStrategy = {
  id: 'ema-rsi',
  name: 'EMA Cross + RSI Confirm',
  tagline: 'Golden / death cross filtered by RSI momentum side',
  description:
    'EMA cross entries confirmed by RSI: LONG crosses only fire when RSI is at or above the long threshold, SHORT crosses only when RSI is at or below the short threshold. Unconfirmed crosses are ignored entirely.',
  category: 'trend',
  style: 'event',
  usesEma: true,
  params: [
    { key: 'rsiPeriod', label: 'RSI period', short: 'RSI', default: 14, min: 2, max: 100, step: 1 },
    { key: 'rsiLongMin', label: 'RSI long min', short: 'L≥', default: 50, min: 1, max: 99, step: 1 },
    { key: 'rsiShortMax', label: 'RSI short max', short: 'S≤', default: 50, min: 1, max: 99, step: 1 },
  ],
  computeSignals(candles, p) {
    const closes = closesOf(candles);
    const { fast, slow } = emaPair(p, closes);
    const rsiPeriodDef = emaRsi.params[0];
    const longMinDef = emaRsi.params[1];
    const shortMaxDef = emaRsi.params[2];
    const rsi = computeRsi(closes, Math.round(sp(p, rsiPeriodDef)));
    const longMin = sp(p, longMinDef);
    const shortMax = sp(p, shortMaxDef);
    const out = flat(candles.length);
    for (let i = 1; i < candles.length; i++) {
      const f0 = fast[i - 1];
      const s0 = slow[i - 1];
      const f1 = fast[i];
      const s1 = slow[i];
      if (f0 == null || s0 == null || f1 == null || s1 == null) continue;
      const r = rsi[i];
      if (r == null) continue;
      if (f0 <= s0 && f1 > s1 && r >= longMin) out[i] = 'LONG';
      else if (f0 >= s0 && f1 < s1 && r <= shortMax) out[i] = 'SHORT';
    }
    return out;
  },
};

// --- 4. MACD signal cross -----------------------------------------------------

const macd: SignalStrategy = {
  id: 'macd',
  name: 'MACD Momentum',
  tagline: 'MACD / signal histogram flip with optional zero-line filter',
  description:
    'LONG when the MACD histogram (MACD line minus signal line) crosses above zero, SHORT on the cross below. The zero-line filter only takes longs while MACD is positive and shorts while negative, keeping entries on the momentum side of the baseline.',
  category: 'momentum',
  style: 'event',
  params: [
    { key: 'macdFast', label: 'MACD fast EMA', short: 'F', default: 12, min: 2, max: 200, step: 1 },
    { key: 'macdSlow', label: 'MACD slow EMA', short: 'S', default: 26, min: 3, max: 400, step: 1 },
    { key: 'macdSignal', label: 'MACD signal EMA', short: 'Sig', default: 9, min: 2, max: 100, step: 1 },
    {
      key: 'macdZeroFilter',
      label: 'Zero-line filter (0/1)',
      short: 'ZF',
      default: 1,
      min: 0,
      max: 1,
      step: 1,
      hint: '1 = long only above zero, short only below',
    },
  ],
  computeSignals(candles, p) {
    const closes = closesOf(candles);
    const fastP = sp(p, macd.params[0]);
    const slowP = sp(p, macd.params[1]);
    const sigP = sp(p, macd.params[2]);
    const zeroFilter = sp(p, macd.params[3]) >= 0.5;
    const { macd: line, hist } = computeMacd(closes, fastP, slowP, sigP);
    const out = flat(candles.length);
    for (let i = 1; i < candles.length; i++) {
      const h0 = hist[i - 1];
      const h1 = hist[i];
      if (h0 == null || h1 == null) continue;
      const m1 = line[i];
      if (h0 <= 0 && h1 > 0 && (!zeroFilter || (m1 != null && m1 > 0))) out[i] = 'LONG';
      else if (h0 >= 0 && h1 < 0 && (!zeroFilter || (m1 != null && m1 < 0))) out[i] = 'SHORT';
    }
    return out;
  },
};

// --- 5. Donchian channel breakout ---------------------------------------------

const donchian: SignalStrategy = {
  id: 'donchian',
  name: 'Donchian Breakout',
  tagline: 'Close breaks the prior N-bar high / low',
  description:
    'LONG when the close crosses above the high of the previous N bars, SHORT when it crosses below the low of the previous N bars. Channel is computed on completed bars only (the current bar never widens its own breakout level).',
  category: 'breakout',
  style: 'event',
  params: [
    {
      key: 'donchianPeriod',
      label: 'Channel period',
      short: 'N',
      default: 20,
      min: 2,
      max: 400,
      step: 1,
      hint: 'breakout above/below the prior N-bar range',
    },
  ],
  computeSignals(candles, p) {
    const period = Math.round(sp(p, donchian.params[0]));
    const { upper, lower } = computeDonchian(candles, period);
    const out = flat(candles.length);
    for (let i = 1; i < candles.length; i++) {
      const u0 = upper[i - 1];
      const l0 = lower[i - 1];
      const u1 = upper[i];
      const l1 = lower[i];
      if (u0 == null || l0 == null || u1 == null || l1 == null) continue;
      const c0 = candles[i - 1].c;
      const c1 = candles[i].c;
      if (c0 <= u0 && c1 > u1) out[i] = 'LONG';
      else if (c0 >= l0 && c1 < l1) out[i] = 'SHORT';
    }
    return out;
  },
};

// --- 6. Supertrend ---------------------------------------------------------------

const supertrend: SignalStrategy = {
  id: 'supertrend',
  name: 'Supertrend',
  tagline: 'ATR trailing-stop regime, flips define the signal',
  description:
    'Classic Supertrend on Wilder ATR: the signal is LONG while price holds above the trailing lower band and SHORT while below the upper band. State-based: like the EMA trend filter it re-enters while the regime holds, but exits (flip detection) react to volatility rather than moving averages.',
  category: 'volatility',
  style: 'state',
  params: [
    { key: 'stAtrPeriod', label: 'ATR period', short: 'ATR', default: 10, min: 2, max: 200, step: 1 },
    { key: 'stMultiplier', label: 'ATR multiplier', short: 'x', default: 3, min: 0.5, max: 20, step: 0.1 },
  ],
  computeSignals(candles, p) {
    const atrPeriod = sp(p, supertrend.params[0]);
    const mult = sp(p, supertrend.params[1]);
    const { dir } = computeSupertrend(candles, atrPeriod, mult);
    return dir.map((d) => (d === 1 ? 'LONG' : d === -1 ? 'SHORT' : 'FLAT'));
  },
};

// --- 7. Bollinger band breakout (momentum) ---------------------------------------

const bollinger: SignalStrategy = {
  id: 'bollinger',
  name: 'Bollinger Breakout',
  tagline: 'Close breaks the upper / lower band with volatility expansion',
  description:
    'Momentum breakout: LONG when the close crosses above the upper Bollinger band, SHORT when it crosses below the lower band. Band-touch breakouts only (event-based), so entries coincide with volatility expansion rather than mean reversion.',
  category: 'volatility',
  style: 'event',
  params: [
    { key: 'bbPeriod', label: 'Band period', short: 'N', default: 20, min: 2, max: 400, step: 1 },
    { key: 'bbStd', label: 'Standard deviations', short: 'σ', default: 2, min: 0.5, max: 5, step: 0.1 },
  ],
  computeSignals(candles, p) {
    const closes = closesOf(candles);
    const period = sp(p, bollinger.params[0]);
    const stdMult = sp(p, bollinger.params[1]);
    const { upper, lower } = computeBollinger(closes, period, stdMult);
    const out = flat(candles.length);
    for (let i = 1; i < candles.length; i++) {
      const u0 = upper[i - 1];
      const l0 = lower[i - 1];
      const u1 = upper[i];
      const l1 = lower[i];
      if (u0 == null || l0 == null || u1 == null || l1 == null) continue;
      const c0 = closes[i - 1];
      const c1 = closes[i];
      if (c0 <= u0 && c1 > u1) out[i] = 'LONG';
      else if (c0 >= l0 && c1 < l1) out[i] = 'SHORT';
    }
    return out;
  },
};

// --- 8. ROC momentum threshold -----------------------------------------------------

const roc: SignalStrategy = {
  id: 'roc',
  name: 'ROC Momentum',
  tagline: 'Rate-of-change crosses a +/- threshold',
  description:
    'LONG when the N-bar rate of change crosses above +threshold percent, SHORT when it crosses below -threshold. Captures momentum ignition while ignoring drift below the threshold - a deliberately different entry family from moving-average crosses.',
  category: 'momentum',
  style: 'event',
  params: [
    { key: 'rocPeriod', label: 'ROC period', short: 'N', default: 14, min: 2, max: 400, step: 1 },
    {
      key: 'rocThreshold',
      label: 'Threshold (%)',
      short: 'thr',
      default: 2,
      min: 0.1,
      max: 50,
      step: 0.1,
      hint: 'fires when ROC crosses +/- this level',
    },
  ],
  computeSignals(candles, p) {
    const closes = closesOf(candles);
    const period = sp(p, roc.params[0]);
    const thr = sp(p, roc.params[1]);
    const series = computeRoc(closes, period);
    const out = flat(candles.length);
    for (let i = 1; i < candles.length; i++) {
      const r0 = series[i - 1];
      const r1 = series[i];
      if (r0 == null || r1 == null) continue;
      if (r0 <= thr && r1 > thr) out[i] = 'LONG';
      else if (r0 >= -thr && r1 < -thr) out[i] = 'SHORT';
    }
    return out;
  },
};

// --- Registry ------------------------------------------------------------------------

export const STRATEGIES: SignalStrategy[] = [
  emaTrend,
  emaCross,
  emaRsi,
  macd,
  donchian,
  supertrend,
  bollinger,
  roc,
];

export const STRATEGY_IDS: string[] = STRATEGIES.map((s) => s.id);

export function getStrategy(id: string | null | undefined): SignalStrategy {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0];
}

/** Default signalParams for a strategy (its registered param defaults). */
export function defaultSignalParams(id: string): Record<string, number> {
  const s = getStrategy(id);
  const out: Record<string, number> = {};
  for (const def of s.params) out[def.key] = def.default;
  return out;
}

/** Compact param summary used in labels, e.g. "RSI 14 / L≥50 / S≤50". */
export function describeSignalParams(
  id: string,
  signalParams: Record<string, number> | undefined,
): string {
  const s = getStrategy(id);
  if (s.params.length === 0) return '';
  return s.params
    .map((def) => {
      const v = signalParams?.[def.key];
      const val = typeof v === 'number' && Number.isFinite(v) ? v : def.default;
      return `${def.short ?? def.label} ${val}`;
    })
    .join(' / ');
}

/** Compact summary of the shared EMA pair, for EMA-based strategies. */
export function describeEma(p: StrategyParams): string {
  return `EMA ${Math.round(p.emaFast)}/${Math.round(p.emaSlow)}`;
}
