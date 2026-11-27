// NPRS event-driven tick engine ('tick' execution mode).
//
// Every aggregated trade print in the window is an event, in time order:
//   - historical funding applies at the exact funding timestamp;
//   - liquidation is checked on each print and on the finest mark bar (1m when
//     available) as it is entered;
//   - DCA limits fill on the print that crosses them, in the order reached;
//   - take-profit and max hold fire on the print that reaches them.
//
// Decisions stay on the signal bars (the dataset interval, default 1h), exactly as
// in the bar engine:
//   - a signal from bar k-1 acts at bar k's FIRST print (the open): entries and
//     trend-flip exits. The trend-health gate also applies there;
//   - the margin risk state is evaluated at the bar close on the mark close, and an
//     EMERGENCY_RISK close fills at the bar's last print.
//
// Limits, stated plainly:
//   - The archive has no mark-price ticks, so liquidation timing is bounded by the
//     finest mark bar. A breach of the mark bar's extreme counts as a liquidation at
//     the first print inside that mark bar (conservative).
//   - Fixed-rate funding is accrued per signal bar, not per print.
//   - Every day in the window must have aggTrades, or the run fails. Partial tick
//     data is never simulated silently.

import {
  BacktestResult,
  Candle,
  EquitySeriesPoint,
  FundingEvent,
  INTERVAL_MS,
  StrategyParams,
} from './types';
import { computeAtr } from './indicators';
import { getStrategy } from './strategies';
import { marginRatioOf, unrealizedPnl } from './margin';
import { computeMetrics } from './metrics';
import { isFlip, PositionSimulator } from './simulator';
import { firstBarAtOrAfter, TimeRange } from './engine';
import type { AggTradeSource } from '@/lib/datasources/aggtrades';
import { utcDayStart } from '@/lib/datasources/aggtrades';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface TickInputs {
  /** Signal-interval candles, including warm-up history before the range. */
  candles: Candle[];
  funding: FundingEvent[];
  /** Mark klines at the signal interval (fallback for liquidation timing). */
  markCandles?: Candle[];
  /** Finer mark klines (1m) for liquidation timing; takes precedence when given. */
  markFine?: Candle[];
  /** Bar length of markFine in ms (60_000 for 1m). */
  markFineMs?: number;
  source: AggTradeSource;
}

export interface TickResult extends BacktestResult {
  tickStats: { prints: number; days: number };
}

/**
 * Longest window one tick run may span. Days stream one at a time from the cache, so
 * the limit is about runtime (about 1 s per million prints) rather than memory.
 */
export const TICK_MAX_DAYS = 366;

export async function runTickBacktest(
  params: StrategyParams,
  inputs: TickInputs,
  range: TimeRange,
): Promise<TickResult> {
  const { candles, funding, markCandles, source } = inputs;
  if (candles.length < 2) throw new Error('Not enough candles to run a backtest');
  const lo = firstBarAtOrAfter(candles, range.fromMs);
  const hi = firstBarAtOrAfter(candles, range.toMs);
  if (hi - lo < 1) throw new Error('No candles inside the requested range');

  const L = INTERVAL_MS[params.interval];
  const tStart = candles[lo].t;
  const tEnd = candles[hi - 1].t + L;
  const spanDays = Math.ceil((tEnd - utcDayStart(tStart)) / DAY_MS);
  if (spanDays > TICK_MAX_DAYS) {
    throw new Error(`tick mode spans ${spanDays} days; the limit is ${TICK_MAX_DAYS} (use a shorter range or the refined mode)`);
  }

  const signals = getStrategy(params.strategyId).computeSignals(candles, params);
  const atr = computeAtr(candles, Math.max(2, Math.round(params.atrPeriod)));
  const markMap =
    markCandles && markCandles.length > 1
      ? new Map<number, Candle>(markCandles.map((m) => [m.t, m]))
      : null;

  // Liquidation-timing mark series: finest available.
  const fine = inputs.markFine && inputs.markFine.length > 1 ? inputs.markFine : null;
  const liqMarks = fine ?? markCandles ?? null;
  const liqMarkMs = fine ? (inputs.markFineMs ?? 60_000) : L;
  const markPriceLiq = liqMarks !== null;

  const sim = new PositionSimulator(params);
  const equityCurve: EquitySeriesPoint[] = [];
  let peakEquity = sim.wallet;

  let b = lo; // decision bar currently open
  let barOpened = false; // open actions (flip, entry, gate) ran for bar b
  let lastPx = NaN; // most recent print
  let fundingIdx = 0;
  let markIdx = 0;
  // The mark bar is checked once per (mark bar, position): a new position entered
  // inside an already-checked mark bar still gets its own check.
  let markChecked = -1;
  let markCheckedPos: unknown = null;
  let prints = 0;
  let days = 0;

  const markFor = (cd: Candle): Candle => (markMap ? (markMap.get(cd.t) ?? cd) : cd);

  /** Liquidation test on a print: the print itself, and the mark bar it enters. */
  const checkLiquidation = (t: number, px: number): boolean => {
    if (!sim.pos) return false;
    if (liqMarks) {
      while (markIdx + 1 < liqMarks.length && liqMarks[markIdx + 1].t <= t) markIdx += 1;
      const mb = liqMarks[markIdx];
      if (mb.t <= t && t < mb.t + liqMarkMs && (markChecked !== markIdx || markCheckedPos !== sim.pos)) {
        markChecked = markIdx;
        markCheckedPos = sim.pos;
        if (sim.liquidationBreached(sim.pos, mb.l, mb.h)) {
          sim.liquidate(t, sim.pos);
          return true;
        }
      }
    }
    if (sim.liquidationBreached(sim.pos, px, px)) {
      sim.liquidate(t, sim.pos);
      return true;
    }
    return false;
  };

  /** Open actions at the first print of signal bar k (flip exit, entry, gate). */
  const openBar = (k: number, t: number, px: number) => {
    if (k === 0) return; // no prior signal: nothing can act at the first bar
    const sigPrev = signals[k - 1];
    if (params.fundingMode === 'fixed' && sim.pos) {
      sim.accrueFixedFunding(candles[k - 1].c);
    }
    const flatAtOpen = sim.pos === null;
    if (sim.pos && params.exitOnTrendFlip && isFlip(sim.pos.direction, sigPrev)) {
      sim.closePosition(t, px, 'TREND_FLIP', { slip: true, exitFeeRate: sim.taker });
    }
    if (flatAtOpen) {
      const atrPrev = atr[k - 1] ?? undefined;
      if (sigPrev === 'LONG' && params.directionMode !== 'short') {
        sim.openPosition(t, px, 'LONG', atrPrev);
      } else if (sigPrev === 'SHORT' && params.directionMode !== 'long') {
        sim.openPosition(t, px, 'SHORT', atrPrev);
      }
    }
    if (sim.pos) sim.applyFlipGate(t, sim.pos, sigPrev);
  };

  /** One print inside signal bar k. */
  const onPrint = (t: number, px: number) => {
    if (params.fundingMode === 'historical') {
      // Events are consumed in time order. Only those AFTER the open position's entry
      // are its funding; earlier events (before entry, or before the window) are not.
      while (fundingIdx < funding.length && funding[fundingIdx].t <= t) {
        const f = funding[fundingIdx++];
        if (sim.pos && f.t > sim.pos.openTime) sim.accrueHistoricalFunding(f, px);
      }
    }
    if (checkLiquidation(t, px)) return;
    const p = sim.pos;
    if (!p) return;
    sim.fillPriceLayers(t, p, px);
    sim.trackPriceExcursion(p, px);
    if (sim.tpReached(p, px)) {
      sim.closePosition(t, sim.targetPrice(p), 'TAKE_PROFIT', { slip: true, exitFeeRate: sim.taker });
      return;
    }
    if (params.maxHoldHours > 0 && t - p.openTime >= params.maxHoldHours * HOUR_MS) {
      sim.closePosition(t, px, 'MAX_HOLD', { slip: true, exitFeeRate: sim.taker });
    }
  };

  /** Close signal bar k: risk gates, emergency exit, equity sample. */
  const closeBar = (k: number) => {
    const cd = candles[k];
    const mk = markFor(cd);
    const barClose = cd.t + L;
    if (sim.pos) {
      const { ratio, state } = sim.evaluateRisk(cd.t, sim.pos, mk.c);
      if (sim.applyRiskGates(cd.t, sim.pos, ratio, state)) {
        sim.closePosition(barClose, lastPx, 'EMERGENCY_RISK', { slip: true, exitFeeRate: sim.taker });
      }
    }
    let ratio: number | null = null;
    let equity = sim.wallet;
    if (sim.pos) {
      const u = unrealizedPnl(sim.pos.direction, sim.pos.qty, sim.pos.avgEntry, mk.c);
      equity = sim.wallet + sim.pos.margin + u;
      ratio = marginRatioOf(sim.mmr, sim.pos.qty, mk.c, sim.pos.margin, u);
    }
    if (equity > peakEquity) peakEquity = equity;
    const ddPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    equityCurve.push({
      t: cd.t,
      equity,
      drawdownPct: ddPct,
      inPosition: sim.pos !== null,
      marginRatio: ratio,
    });
  };

  // Walk the days in order; every print in [tStart, tEnd) is one event.
  outer: for (let d = utcDayStart(tStart); d < tEnd; d += DAY_MS) {
    const day = await source.day(d);
    if (day === null) {
      throw new Error(
        `tick mode needs every aggTrades day in the range; ${new Date(d).toISOString().slice(0, 10)} is not published for ${source.symbol}`,
      );
    }
    days += 1;
    for (let j = 0; j < day.t.length; j++) {
      const t = day.t[j];
      if (t < tStart) continue;
      if (t >= tEnd) break outer;
      const px = day.p[j];

      // Signal bars that ended before this print close first.
      while (b < hi && t >= candles[b].t + L) {
        closeBar(b);
        b += 1;
        barOpened = false;
      }
      if (b >= hi) break outer;

      if (!barOpened) {
        barOpened = true;
        openBar(b, t, px);
      }
      onPrint(t, px);
      lastPx = px;
      prints += 1;
    }
  }

  // Bars the data never reached, and the bar still open at the end, close too.
  while (b < hi) {
    closeBar(b);
    b += 1;
  }

  if (sim.pos) {
    sim.finalize(tEnd, lastPx);
    const lastPoint = equityCurve[equityCurve.length - 1];
    if (lastPoint) {
      lastPoint.equity = sim.wallet;
      lastPoint.inPosition = false;
      lastPoint.marginRatio = null;
      lastPoint.drawdownPct =
        peakEquity > 0 ? Math.max(0, ((peakEquity - sim.wallet) / peakEquity) * 100) : 0;
    }
  }

  const metrics = computeMetrics(sim.trades, equityCurve, params, tStart, tEnd - L, markPriceLiq);
  return {
    params,
    dataFrom: tStart,
    dataTo: tEnd - L,
    candles: hi - lo,
    trades: sim.trades,
    equityCurve,
    riskEvents: sim.riskEvents,
    metrics,
    tickStats: { prints, days },
  };
}
