// Indicator primitives used by the trend filter and ATR-based DCA spacing.
// All functions are pure and deterministic.

import { Candle, TrendSignal } from './types';

/** EMA seeded with SMA over the first `period` values; null before warmup. */
export function computeEma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  out[period - 1] = ema;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/** Wilder-smoothed ATR; null during warmup. */
export function computeAtr(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;

  const trs: number[] = [candles[0].h - candles[0].l];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].c;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)));
  }

  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trs[i];
  atr /= period;
  out[period] = atr;

  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = atr;
  }
  return out;
}

/**
 * Trend signal evaluated on each bar close:
 *   LONG  if fast EMA above slow EMA and close above fast EMA
 *   SHORT if fast EMA below slow EMA and close below fast EMA
 *   FLAT  otherwise (no trade)
 * Signals are consumed by the engine one bar later (no lookahead).
 */
export function computeTrendSignals(
  candles: Candle[],
  fast: (number | null)[],
  slow: (number | null)[],
): TrendSignal[] {
  return candles.map((c, i) => {
    const f = fast[i];
    const s = slow[i];
    if (f == null || s == null) return 'FLAT';
    if (f > s && c.c > f) return 'LONG';
    if (f < s && c.c < f) return 'SHORT';
    return 'FLAT';
  });
}

// ---------------------------------------------------------------------------
// Additional indicator primitives for the selectable entry strategies.
// ---------------------------------------------------------------------------

/** Wilder-smoothed RSI (0-100); null during warmup. */
export function computeRsi(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period + 1) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const rsiOf = (g: number, l: number) => {
    if (l === 0) return g === 0 ? 50 : 100;
    return 100 - 100 / (1 + g / l);
  };
  out[period] = rsiOf(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiOf(avgGain, avgLoss);
  }
  return out;
}

export interface MacdSeries {
  macd: (number | null)[];
  signal: (number | null)[];
  hist: (number | null)[];
}

/** Classic MACD (fast EMA - slow EMA) with EMA signal line; null during warmup. */
export function computeMacd(
  values: number[],
  fast: number,
  slow: number,
  signalPeriod: number,
): MacdSeries {
  const n = values.length;
  const macd: (number | null)[] = new Array(n).fill(null);
  const signal: (number | null)[] = new Array(n).fill(null);
  const hist: (number | null)[] = new Array(n).fill(null);

  const f = Math.max(2, Math.round(fast));
  const s = Math.max(3, Math.round(slow));
  const sg = Math.max(2, Math.round(signalPeriod));
  if (n < s + sg) return { macd, signal, hist };

  const emaFast = computeEma(values, f);
  const emaSlow = computeEma(values, s);
  for (let i = 0; i < n; i++) {
    const a = emaFast[i];
    const b = emaSlow[i];
    if (a != null && b != null) macd[i] = a - b;
  }

  const firstValid = s - 1;
  if (firstValid + sg - 1 < n) {
    let sum = 0;
    for (let k = 0; k < sg; k++) sum += macd[firstValid + k] as number;
    let sig = sum / sg;
    signal[firstValid + sg - 1] = sig;
    const k2 = 2 / (sg + 1);
    for (let i = firstValid + sg; i < n; i++) {
      const m = macd[i] as number;
      sig = m * k2 + sig * (1 - k2);
      signal[i] = sig;
    }
  }
  for (let i = 0; i < n; i++) {
    const m = macd[i];
    const sv = signal[i];
    if (m != null && sv != null) hist[i] = m - sv;
  }
  return { macd, signal, hist };
}

export interface DonchianSeries {
  /** rolling max of the highs over the PRIOR `period` bars (current excluded) */
  upper: (number | null)[];
  /** rolling min of the lows over the PRIOR `period` bars (current excluded) */
  lower: (number | null)[];
}

/** Donchian channel of completed bars only (no lookahead at the current bar). */
export function computeDonchian(candles: Candle[], period: number): DonchianSeries {
  const n = candles.length;
  const upper: (number | null)[] = new Array(n).fill(null);
  const lower: (number | null)[] = new Array(n).fill(null);
  const p = Math.max(1, Math.round(period));
  for (let i = p; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - p; k < i; k++) {
      if (candles[k].h > hi) hi = candles[k].h;
      if (candles[k].l < lo) lo = candles[k].l;
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

export interface BollingerSeries {
  mid: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
}

/** Bollinger bands (SMA +/- mult * POPULATION stddev, n); null during warmup. */
export function computeBollinger(
  values: number[],
  period: number,
  stdMult: number,
): BollingerSeries {
  const n = values.length;
  const mid: (number | null)[] = new Array(n).fill(null);
  const upper: (number | null)[] = new Array(n).fill(null);
  const lower: (number | null)[] = new Array(n).fill(null);
  const p = Math.max(2, Math.round(period));
  if (n < p) return { mid, upper, lower };

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    sumSq += values[i] * values[i];
    if (i >= p) {
      const outVal = values[i - p];
      sum -= outVal;
      sumSq -= outVal * outVal;
    }
    if (i >= p - 1) {
      const m = sum / p;
      // population variance (divide by n) - the canonical Bollinger
      // definition, matching Binance's own chart bands
      const variance = Math.max(0, sumSq / p - (m * m));
      const sd = Math.sqrt(variance);
      mid[i] = m;
      upper[i] = m + stdMult * sd;
      lower[i] = m - stdMult * sd;
    }
  }
  return { mid, upper, lower };
}

/** Rate of change in percent over `period` bars; null during warmup. */
export function computeRoc(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const p = Math.max(1, Math.round(period));
  for (let i = p; i < values.length; i++) {
    const base = values[i - p];
    if (base !== 0) out[i] = ((values[i] - base) / base) * 100;
  }
  return out;
}

export interface SupertrendSeries {
  /** supertrend line (lower band in uptrend, upper band in downtrend) */
  line: (number | null)[];
  /** +1 = uptrend, -1 = downtrend, 0 = warmup */
  dir: number[];
}

/** Classic Supertrend on Wilder ATR with band carry-over rules. */
export function computeSupertrend(
  candles: Candle[],
  atrPeriod: number,
  mult: number,
): SupertrendSeries {
  const n = candles.length;
  const atr = computeAtr(candles, Math.max(2, Math.round(atrPeriod)));
  const line: (number | null)[] = new Array(n).fill(null);
  const dir: number[] = new Array(n).fill(0);

  let finalUpper = NaN;
  let finalLower = NaN;
  for (let i = 0; i < n; i++) {
    const a = atr[i];
    if (a == null) continue;
    const mid = (candles[i].h + candles[i].l) / 2;
    const basicUpper = mid + mult * a;
    const basicLower = mid - mult * a;
    const c = candles[i].c;

    if (!Number.isFinite(finalUpper)) {
      // Seed on the first bar with a valid ATR.
      finalUpper = basicUpper;
      finalLower = basicLower;
      const d = c > finalUpper ? 1 : c < finalLower ? -1 : c >= mid ? 1 : -1;
      dir[i] = d;
      line[i] = d === 1 ? finalLower : finalUpper;
      continue;
    }

    const prevClose = candles[i - 1].c;
    finalUpper = basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
    finalLower = basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;

    const prevDir = dir[i - 1];
    const d = prevDir === 1 ? (c < finalLower ? -1 : 1) : c > finalUpper ? 1 : -1;
    dir[i] = d;
    line[i] = d === 1 ? finalLower : finalUpper;
  }
  return { line, dir };
}
