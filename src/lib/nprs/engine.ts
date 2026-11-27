// NPRS event-driven backtest engine, bar loop (execution modes 'bar' and 'refined').
//
// Timing rules (no lookahead):
//  - A signal evaluated on bar i-1 close is actionable from bar i open. Entries and
//    trend-flip exits both execute at bar i OPEN (with slippage).
//  - The entry bar is fully managed: liquidation, DCA fills, take-profit and risk
//    states are evaluated on bar i after the entry fill.
//  - A position can only be opened when flat at the open of the bar, so an exit
//    never re-enters on the same bar.
//
// Intrabar ordering on a bar (conservative):
//  - Liquidation is checked on the mark extreme BEFORE any DCA fill.
//  - 'bar'     : fills then take-profit on the bar's extremes (dip-then-rally).
//  - 'refined' : a bar where a DCA limit is reachable is replayed from its aggTrades
//                prints in time order (exact order). Other bars use the rule above.
//
// The state machine itself lives in simulator.ts; this file decides the order of
// events within each bar. The tick engine (tick-engine.ts) drives the same simulator
// trade by trade.

import {
  BacktestResult,
  Candle,
  EquitySeriesPoint,
  FundingEvent,
  IntrabarSource,
  IntrabarWindow,
  StrategyParams,
  TrendSignal,
} from './types';
import { computeAtr } from './indicators';
import { getStrategy } from './strategies';
import { marginRatioOf, unrealizedPnl } from './margin';
import { computeMetrics } from './metrics';
import { isFlip, Position, PositionSimulator } from './simulator';

export { isFlip } from './simulator';

const HOUR_MS = 3_600_000;

/** A request for the trades of [fromMs, toMs), answered by the driver. */
export interface WindowRequest {
  fromMs: number;
  toMs: number;
}

/**
 * Simulate only bars with openTime in [fromMs, toMs). Indicators and signals still
 * see every candle before the range, so the warm-up is not lost.
 */
export interface TimeRange {
  fromMs: number;
  toMs: number;
}

/** Index of the first candle whose openTime is >= t (candles are time-sorted). */
export function firstBarAtOrAfter(candles: Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type BarSteps = Generator<WindowRequest, BacktestResult, IntrabarWindow | null>;

interface Counters {
  refined: number;
  fallback: number;
}

/** Refinement applies only where a DCA limit is reachable on this bar. */
function gridReachable(cd: Candle, p: Position): boolean {
  if (p.gridCancelled || p.nextLayer >= p.grid.length) return false;
  const gp = p.grid[p.nextLayer];
  return p.direction === 'LONG' ? gp >= cd.l : gp <= cd.h;
}

/** Replay one bar's prints in time order: DCA fills and take-profit. True when closed. */
function replayPrints(sim: PositionSimulator, win: IntrabarWindow, p: Position): boolean {
  for (let k = 0; k < win.t.length; k++) {
    const tk = win.t[k];
    const px = win.p[k];
    sim.fillPriceLayers(tk, p, px);
    sim.trackPriceExcursion(p, px);
    if (sim.tpReached(p, px)) {
      sim.closePosition(tk, sim.targetPrice(p), 'TAKE_PROFIT', {
        slip: true,
        exitFeeRate: sim.taker,
      });
      return true;
    }
  }
  return false;
}

/** Max hold, then margin risk states, evaluated at the bar close. */
function barExitsAndRisk(
  sim: PositionSimulator,
  params: StrategyParams,
  cd: Candle,
  mk: Candle,
  p: Position,
): void {
  const barClose = cd.t + sim.msPerBar;
  if (params.maxHoldHours > 0 && cd.t - p.openTime >= params.maxHoldHours * HOUR_MS) {
    sim.closePosition(barClose, cd.c, 'MAX_HOLD', { slip: true, exitFeeRate: sim.taker });
    return;
  }
  const { ratio, state } = sim.evaluateRisk(cd.t, p, mk.c);
  if (sim.applyRiskGates(cd.t, p, ratio, state)) {
    sim.closePosition(barClose, cd.c, 'EMERGENCY_RISK', { slip: true, exitFeeRate: sim.taker });
  }
}

/** Position management on one bar, in the documented intrabar order. */
function* managePosition(
  sim: PositionSimulator,
  params: StrategyParams,
  signals: TrendSignal[],
  i: number,
  cd: Candle,
  mk: Candle,
  p: Position,
  refine: boolean,
  counters: Counters,
): Generator<WindowRequest, void, IntrabarWindow | null> {
  // 1. Liquidation on the mark extreme, before any fill (conservative).
  if (sim.liquidationBreached(p, mk.l, mk.h)) {
    sim.trackBarExcursion(p, cd.h, cd.l);
    sim.liquidate(cd.t, p);
    return;
  }

  // 2. Trend-health gate (decided at the open, so it precedes the bar's fills).
  sim.applyFlipGate(cd.t, p, signals[i - 1]);

  // 3. Fills and take-profit.
  if (refine && gridReachable(cd, p)) {
    const win: IntrabarWindow | null = yield { fromMs: cd.t, toMs: cd.t + sim.msPerBar };
    if (win !== null) {
      counters.refined += 1;
      if (!replayPrints(sim, win, p)) barExitsAndRisk(sim, params, cd, mk, p);
      return;
    }
    counters.fallback += 1;
  }

  sim.trackBarExcursion(p, cd.h, cd.l);
  sim.fillBarLayers(cd.t, p, cd.l, cd.h);
  sim.trackBarExcursion(p, cd.h, cd.l);
  const tp = sim.targetPrice(p);
  const favorable = p.direction === 'LONG' ? cd.h : cd.l;
  if (sim.tpReached(p, favorable)) {
    sim.closePosition(cd.t, tp, 'TAKE_PROFIT', { slip: true, exitFeeRate: sim.taker });
    return;
  }

  // 4. Exits and risk at the bar close.
  barExitsAndRisk(sim, params, cd, mk, p);
}

/**
 * The bar loop as a generator. It only pauses (yields a WindowRequest) on bars that
 * need trade-level ordering in 'refined' mode; the driver answers with the trades.
 */
function* simulateBars(
  candles: Candle[],
  funding: FundingEvent[],
  params: StrategyParams,
  markCandles: Candle[] | undefined,
  refine: boolean,
  range?: TimeRange,
): BarSteps {
  if (candles.length < 2) throw new Error('Not enough candles to run a backtest');
  const lo = range ? firstBarAtOrAfter(candles, range.fromMs) : 0;
  const hi = range ? firstBarAtOrAfter(candles, range.toMs) : candles.length;
  if (hi - lo < 1) throw new Error('No candles inside the requested range');

  // Entry signals come from the selected strategy in the registry: one TrendSignal
  // per bar, evaluated on close and acted on from the next open. Every strategy uses
  // the same DCA / risk / cost machinery, so the signal stays a controlled variable.
  const strategy = getStrategy(params.strategyId);
  const signals = strategy.computeSignals(candles, params);
  const atr = computeAtr(candles, Math.max(2, Math.round(params.atrPeriod)));

  // Real mark-price series (Binance USDT-M liquidates on mark price). Falls back to
  // the execution series when mark klines are missing.
  const markMap =
    markCandles && markCandles.length > 1
      ? new Map<number, Candle>(markCandles.map((m) => [m.t, m]))
      : null;
  const markPriceLiq = markMap !== null;

  const sim = new PositionSimulator(params);
  const counters: Counters = { refined: 0, fallback: 0 };
  let fi = 0; // funding pointer
  let peakEquity = sim.wallet;
  const equityCurve: EquitySeriesPoint[] = [];

  for (let i = lo; i < hi; i++) {
    const cd = candles[i];
    const prev = i > 0 ? candles[i - 1] : null;
    // Mark-price bar for this timestamp (mark drives liquidation + risk marks).
    const mk = markMap ? (markMap.get(cd.t) ?? cd) : cd;

    // --- funding accrual (positions held through the previous bar) -----------
    if (sim.pos && params.fundingMode === 'historical') {
      const from = prev ? prev.t : -1;
      while (fi < funding.length && funding[fi].t <= cd.t) {
        const f = funding[fi++];
        if (f.t > from) sim.accrueHistoricalFunding(f, cd.c);
      }
    } else if (sim.pos && params.fundingMode === 'fixed') {
      sim.accrueFixedFunding(cd.c);
    }

    if (prev) {
      const sigPrev = signals[i - 1];
      const flatAtOpen = sim.pos === null;

      // --- trend-flip exit at bar OPEN (the flip is known at this open) -------
      if (sim.pos && params.exitOnTrendFlip && isFlip(sim.pos.direction, sigPrev)) {
        sim.closePosition(cd.t, cd.o, 'TREND_FLIP', { slip: true, exitFeeRate: sim.taker });
      }

      // --- entry at bar OPEN, only when flat at the open -----------------------
      if (flatAtOpen) {
        const atrPrev = atr[i - 1] ?? undefined;
        if (sigPrev === 'LONG' && params.directionMode !== 'short') {
          sim.openPosition(cd.t, cd.o, 'LONG', atrPrev);
        } else if (sigPrev === 'SHORT' && params.directionMode !== 'long') {
          sim.openPosition(cd.t, cd.o, 'SHORT', atrPrev);
        }
      }

      // --- intrabar management, including the bar just entered ----------------
      if (sim.pos) {
        yield* managePosition(sim, params, signals, i, cd, mk, sim.pos, refine, counters);
      }
    }

    // --- equity point (mark-to-market on mark price) ---------------------------
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
  }

  // Force-close anything still open at the end of the dataset.
  if (sim.pos) {
    const last = candles[hi - 1];
    sim.finalize(last.t + sim.msPerBar, last.c);
    // The last equity point was recorded before the force-close charged its exit
    // fee + slippage; sync it so reported finalEquity equals the realized wallet.
    const lastPoint = equityCurve[equityCurve.length - 1];
    if (lastPoint) {
      lastPoint.equity = sim.wallet;
      lastPoint.inPosition = false;
      lastPoint.marginRatio = null;
      lastPoint.drawdownPct =
        peakEquity > 0 ? Math.max(0, ((peakEquity - sim.wallet) / peakEquity) * 100) : 0;
    }
  }

  const metrics = computeMetrics(
    sim.trades,
    equityCurve,
    params,
    candles[lo].t,
    candles[hi - 1].t,
    markPriceLiq,
  );
  metrics.intrabarRefinedBars = counters.refined;
  metrics.intrabarFallbackBars = counters.fallback;

  return {
    params,
    dataFrom: candles[lo].t,
    dataTo: candles[hi - 1].t,
    candles: hi - lo,
    trades: sim.trades,
    equityCurve,
    riskEvents: sim.riskEvents,
    metrics,
  };
}

/** Bar-OHLC execution ('bar' mode). Synchronous: never requests trades. */
export function runBacktest(
  candles: Candle[],
  funding: FundingEvent[],
  params: StrategyParams,
  markCandles?: Candle[],
  range?: TimeRange,
): BacktestResult {
  const steps = simulateBars(candles, funding, params, markCandles, false, range);
  const first = steps.next();
  if (!first.done) throw new Error('bar execution must not request trades');
  return first.value;
}

/**
 * 'refined' execution: bar loop, with bars that need intrabar order answered from
 * the aggTrades source. Bars the source cannot answer fall back to the OHLC rule.
 */
export async function runRefinedBacktest(
  candles: Candle[],
  funding: FundingEvent[],
  params: StrategyParams,
  source: IntrabarSource,
  markCandles?: Candle[],
  range?: TimeRange,
): Promise<BacktestResult> {
  const steps = simulateBars(candles, funding, params, markCandles, true, range);
  let step = steps.next();
  while (!step.done) {
    const win = await source.window(step.value.fromMs, step.value.toMs);
    step = steps.next(win);
  }
  return step.value;
}

