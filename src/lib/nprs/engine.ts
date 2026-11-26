// NPRS deterministic event-driven backtest engine.
//
// Timing rules (no lookahead):
//  - A signal evaluated on bar i-1 close is actionable from bar i open. Entries
//    and trend-flip exits both execute at bar i OPEN (with slippage).
//  - The entry bar is fully managed: liquidation, DCA fills, take-profit and
//    risk states are all evaluated on bar i after the entry fill.
//  - A position can only be opened when flat at the open of the bar, so an
//    exit never re-enters on the same bar.
//
// Intrabar ordering (conservative, documented in the research panel):
//  - Liquidation is checked on the mark-price extreme BEFORE any DCA fill; if a
//    candle touches both a DCA level and liquidation, liquidation wins.
//  - When a candle touches both DCA levels and the (post-fill) take-profit, the
//    fills are assumed to happen first (dip-then-rally).
//  - Take-profit fires only when the favorable extreme crosses the target
//    price; that target is solved so the NET ROI after slippage and the taker
//    fee equals targetRoiPct, so a TAKE_PROFIT trade realises the target.
//  - Exits priced at a bar close (MAX_HOLD, EMERGENCY_RISK, END_OF_DATA) are
//    stamped with that bar's close time, not its open time.
//  - Funding is accrued progressively from real history (or a fixed rate).

import {
  BacktestResult,
  Candle,
  Direction,
  EquitySeriesPoint,
  ExitReason,
  FundingEvent,
  RiskEventRecord,
  RiskEventType,
  StrategyParams,
  TrendSignal,
  TradeRecord,
} from './types';
import { INTERVAL_MS } from './types';
import { computeAtr } from './indicators';
import { getStrategy } from './strategies';
import {
  liquidationPrice,
  marginRatioOf,
  riskStateOf,
  unrealizedPnl,
} from './margin';
import { computeMetrics } from './metrics';

const HOUR_MS = 3_600_000;

interface Position {
  direction: Direction;
  openTime: number;
  qty: number;
  cost: number; // sum(qty * price)
  avgEntry: number;
  margin: number;
  fees: number; // entry + DCA fees paid
  funding: number; // net funding paid (positive = paid)
  liqPrice: number;
  grid: number[]; // planned DCA limit prices
  nextLayer: number; // index of next unfilled layer
  gridCancelled: boolean;
  maePct: number;
  mfePct: number;
  lastState: 'SAFE' | 'WARNING' | 'CRITICAL';
}

interface CloseOpts {
  slip: boolean;
  exitFeeRate: number;
  forfeitMargin?: boolean;
}

/** True when `signal` opposes the open position's direction. */
export function isFlip(direction: Direction, signal: TrendSignal | undefined): boolean {
  return (
    (direction === 'LONG' && signal === 'SHORT') ||
    (direction === 'SHORT' && signal === 'LONG')
  );
}

export function runBacktest(
  candles: Candle[],
  funding: FundingEvent[],
  params: StrategyParams,
  markCandles?: Candle[],
): BacktestResult {
  if (candles.length < 2) throw new Error('Not enough candles to run a backtest');

  // Entry signals come from the selected strategy in the registry. Every
  // strategy produces the same TrendSignal[] contract (evaluated on close,
  // consumed from the next bar open), so the DCA / risk / cost machinery below
  // is identical for all signal families - the entry signal stays a controlled
  // variable.
  const strategy = getStrategy(params.strategyId);
  const signals = strategy.computeSignals(candles, params);
  const atr = computeAtr(candles, Math.max(2, Math.round(params.atrPeriod)));

  // Real mark-price series (Binance USDT-M liquidates on mark price, not last
  // price). Falls back to the execution series when mark klines are missing.
  const markMap =
    markCandles && markCandles.length > 1
      ? new Map<number, Candle>(markCandles.map((m) => [m.t, m]))
      : null;
  const markPriceLiq = markMap !== null;

  const taker = params.feeTakerPct / 100;
  const maker = params.feeMakerPct / 100;
  const slip = params.slippagePct / 100;
  const mmr = params.mmrPct / 100;
  const lev = params.leverage;
  const msPerBar = INTERVAL_MS[params.interval];
  const initialMargin0 = params.startingEquity * (params.initialAllocPct / 100);
  const layerBase = params.startingEquity * (params.dcaAllocPct / 100);
  const capUsd = params.startingEquity * (params.maxMarginPct / 100);

  let wallet = params.startingEquity;
  // `as` keeps TypeScript from narrowing `pos` to `null` at declaration: it is
  // only assigned inside closures (openPosition / closePosition).
  let pos = null as Position | null;
  let seq = 0;
  let fi = 0; // funding pointer
  let peakEquity = wallet;

  const trades: TradeRecord[] = [];
  const equityCurve: EquitySeriesPoint[] = [];
  const riskEvents: RiskEventRecord[] = [];

  // Event rate limits: keep the risk ledger readable without losing signal.
  let lastWarnEventT = -Infinity;
  let lastCriticalEventT = -Infinity;
  let skipActive = false;
  const WARN_GAP_MS = 6 * msPerBar;
  const CRIT_GAP_MS = 2 * msPerBar;

  const pushEvent = (t: number, type: RiskEventType, message: string) => {
    riskEvents.push({ t, type, message });
  };

  /**
   * Price at which NET ROI on deployed margin equals the target. Slippage and
   * the exit taker fee are applied to the exit price in closePosition(), so the
   * solved price includes both: the realised TP trade lands on the target.
   *   LONG : net = qty*P*(1-s)*(1-t) - cost - fees - funding
   *   SHORT: net = cost - qty*P*(1+s)*(1+t) - fees - funding
   */
  const targetPrice = (p: Position): number => {
    const targetUsd = (params.targetRoiPct / 100) * p.margin;
    if (p.direction === 'LONG') {
      const denom = p.qty * (1 - slip) * (1 - taker);
      return denom > 0 ? (targetUsd + p.cost + p.fees + p.funding) / denom : NaN;
    }
    const denom = p.qty * (1 + slip) * (1 + taker);
    return denom > 0 ? (p.cost - p.fees - p.funding - targetUsd) / denom : NaN;
  };

  const closePosition = (
    t: number,
    priceRaw: number,
    reason: ExitReason,
    opts: CloseOpts,
  ) => {
    if (!pos) return;
    const p = pos;
    const price =
      p.direction === 'LONG'
        ? opts.slip
          ? priceRaw * (1 - slip)
          : priceRaw
        : opts.slip
          ? priceRaw * (1 + slip)
          : priceRaw;
    const exitFee = p.qty * price * opts.exitFeeRate;
    const gross =
      p.direction === 'LONG'
        ? p.qty * (price - p.avgEntry)
        : p.qty * (p.avgEntry - price);
    let netPnl: number;
    if (opts.forfeitMargin) {
      // Binance isolated liquidation: the entire position margin is forfeited
      // to the liquidation engine - nothing returns to the wallet. The wallet
      // already paid the margin, fees and funding when they were incurred.
      netPnl = -(p.margin + p.fees + p.funding);
    } else {
      const realized = gross - exitFee; // fees/funding already left the wallet
      wallet += p.margin + realized;
      netPnl = gross - exitFee - p.fees - p.funding;
    }
    pos = null;
    trades.push({
      seq: seq++,
      direction: p.direction,
      openTime: p.openTime,
      closeTime: t,
      avgEntry: p.avgEntry,
      exitPrice: price,
      qtyTotal: p.qty,
      marginDeployed: p.margin,
      dcaLayers: p.nextLayer,
      grossPnl: opts.forfeitMargin ? -p.margin : gross,
      fees: p.fees + exitFee,
      funding: p.funding,
      netPnl,
      roiOnMargin: p.margin > 0 ? (netPnl / p.margin) * 100 : 0,
      maePct: p.maePct,
      mfePct: p.mfePct,
      exitReason: reason,
      equityAfter: wallet,
      holdMinutes: Math.max(0, (t - p.openTime) / 60_000),
    });
  };

  const openPosition = (i: number, cd: Candle, dir: Direction) => {
    // Entry needs margin + taker fee on the full notional (margin * lev).
    if (wallet < initialMargin0 * (1 + lev * taker)) {
      if (!skipActive) {
        skipActive = true;
        pushEvent(
          cd.t,
          'ENTRY_SKIPPED',
          'Free balance below baseline initial allocation; entries skipped until balance recovers',
        );
      }
      return;
    }
    skipActive = false;
    const price = dir === 'LONG' ? cd.o * (1 + slip) : cd.o * (1 - slip);
    const margin0 = initialMargin0;
    const qty = (margin0 * lev) / price;
    const fee = qty * price * taker;
    wallet -= margin0 + fee;

    // ATR spacing uses the PREVIOUS bar's ATR (known at this open).
    const spacingAbs =
      params.spacingMode === 'fixed'
        ? price * (params.spacingPct / 100)
        : (atr[i - 1] ?? price * 0.02) * params.atrMultiplier;
    const grid: number[] = [];
    for (let k = 1; k <= Math.round(params.maxDcaLayers); k++) {
      const gp = dir === 'LONG' ? price - k * spacingAbs : price + k * spacingAbs;
      if (gp > 0) grid.push(gp);
    }

    pos = {
      direction: dir,
      openTime: cd.t,
      qty,
      cost: qty * price,
      avgEntry: price,
      margin: margin0,
      fees: fee,
      funding: 0,
      liqPrice: liquidationPrice(price, lev, mmr, dir),
      grid,
      nextLayer: 0,
      gridCancelled: false,
      maePct: 0,
      mfePct: 0,
      lastState: 'SAFE',
    };
    pushEvent(
      cd.t,
      'POSITION_OPENED',
      `${dir} @ ${price.toPrecision(8)} | margin ${margin0.toFixed(2)} | ${lev}x | ${grid.length} DCA orders (${params.spacingMode === 'fixed' ? `${params.spacingPct}% grid` : `ATR${params.atrPeriod} x${params.atrMultiplier}`})`,
    );
  };

  /** Adverse / favorable excursion vs the CURRENT average entry, from one bar. */
  const trackExcursion = (p: Position, cd: Candle) => {
    const worst = p.direction === 'LONG' ? cd.l : cd.h;
    const best = p.direction === 'LONG' ? cd.h : cd.l;
    const adv =
      p.direction === 'LONG'
        ? ((p.avgEntry - worst) / p.avgEntry) * 100
        : ((worst - p.avgEntry) / p.avgEntry) * 100;
    const fav =
      p.direction === 'LONG'
        ? ((best - p.avgEntry) / p.avgEntry) * 100
        : ((p.avgEntry - best) / p.avgEntry) * 100;
    if (adv > p.maePct) p.maePct = adv;
    if (fav > p.mfePct) p.mfePct = fav;
  };

  /** Place DCA limit fills the candle range crosses (dip-then-rally ordering). */
  const fillDcaLayers = (i: number, cd: Candle, p: Position) => {
    if (p.gridCancelled || p.nextLayer >= p.grid.length) return;
    if (isFlip(p.direction, signals[i - 1]) && params.blockDcaOnFlip) {
      p.gridCancelled = true;
      pushEvent(
        cd.t,
        'DCA_BLOCKED_FLIP',
        `Trend flipped against ${p.direction} position; remaining DCA orders cancelled (trend health gate)`,
      );
      return;
    }
    while (p.nextLayer < p.grid.length) {
      const gp = p.grid[p.nextLayer];
      const inRange = p.direction === 'LONG' ? gp >= cd.l : gp <= cd.h;
      if (!inRange) break;
      let m = layerBase;
      const allowed = capUsd - p.margin;
      if (m > allowed) m = allowed;
      if (wallet * 0.98 < m) m = wallet * 0.98;
      if (m < layerBase * 0.05 || m <= 0) {
        p.gridCancelled = true;
        pushEvent(
          cd.t,
          'DCA_CAP',
          `Deployment cap (${params.maxMarginPct}% of starting equity) reached or balance insufficient; remaining DCA orders cancelled`,
        );
        return;
      }
      const qty = (m * lev) / gp;
      const fee = qty * gp * maker;
      wallet -= m + fee;
      p.qty += qty;
      p.cost += qty * gp;
      p.margin += m;
      p.fees += fee;
      p.avgEntry = p.cost / p.qty;
      p.liqPrice = liquidationPrice(p.avgEntry, lev, mmr, p.direction);
      p.nextLayer += 1;
      if (m < layerBase - 1e-9) {
        p.gridCancelled = true;
        pushEvent(
          cd.t,
          'DCA_CAP',
          `Final layer scaled to fit ${params.maxMarginPct}% deployment cap; remaining DCA orders cancelled`,
        );
        return;
      }
    }
  };

  /**
   * Intrabar management of an open position on bar i, in the order:
   * liquidation -> excursion (pre-fill) -> DCA fills -> excursion (post-fill)
   * -> take-profit -> max hold -> margin risk states.
   * Every exit branch returns immediately; `p` is closed when it returns.
   */
  const managePosition = (i: number, cd: Candle, mk: Candle, p: Position) => {
    const barClose = cd.t + msPerBar;

    // 1. Liquidation first, on the mark-price extreme.
    const worstMark = p.direction === 'LONG' ? mk.l : mk.h;
    const hitLiq =
      p.direction === 'LONG' ? worstMark <= p.liqPrice : worstMark >= p.liqPrice;
    trackExcursion(p, cd);
    if (hitLiq) {
      const uAtLiq = unrealizedPnl(p.direction, p.qty, p.avgEntry, p.liqPrice);
      const layers = p.nextLayer;
      const margin = p.margin;
      const netLoss = -(p.margin + p.fees + p.funding);
      closePosition(cd.t, p.liqPrice, 'LIQUIDATION', {
        slip: false,
        exitFeeRate: 0,
        forfeitMargin: true,
      });
      pushEvent(
        cd.t,
        'LIQUIDATION',
        `${p.direction} position liquidated at ${p.liqPrice.toPrecision(8)} after ${layers} DCA layer(s); entire deployed margin forfeited (net ${netLoss.toFixed(2)} USDT, margin ${margin.toFixed(2)}, mark-price move at boundary ${uAtLiq.toFixed(2)})`,
      );
      return;
    }

    // 2. DCA limit fills, then re-measure excursion against the new average.
    fillDcaLayers(i, cd, p);
    trackExcursion(p, cd);

    // 3. Take-profit on the favorable extreme.
    const tp = targetPrice(p);
    const tpHit =
      Number.isFinite(tp) &&
      tp > 0 &&
      (p.direction === 'LONG' ? cd.h >= tp : cd.l <= tp);
    if (tpHit) {
      closePosition(cd.t, tp, 'TAKE_PROFIT', { slip: true, exitFeeRate: taker });
      return;
    }

    // 4. Maximum holding period (exit priced at bar close).
    if (
      params.maxHoldHours > 0 &&
      cd.t - p.openTime >= params.maxHoldHours * HOUR_MS
    ) {
      closePosition(barClose, cd.c, 'MAX_HOLD', { slip: true, exitFeeRate: taker });
      return;
    }

    // 5. Margin risk states, evaluated at bar close on mark price.
    const u = unrealizedPnl(p.direction, p.qty, p.avgEntry, mk.c);
    const ratio = marginRatioOf(mmr, p.qty, mk.c, p.margin, u);
    const state = riskStateOf(ratio, params.riskWarningRatio, params.riskCriticalRatio);
    if (state !== p.lastState) {
      if (state === 'WARNING' && cd.t - lastWarnEventT > WARN_GAP_MS) {
        lastWarnEventT = cd.t;
        pushEvent(
          cd.t,
          'WARNING',
          `Margin ratio ${(ratio * 100).toFixed(1)}% crossed WARNING threshold (${(params.riskWarningRatio * 100).toFixed(0)}%)`,
        );
      }
      if (state === 'CRITICAL' && cd.t - lastCriticalEventT > CRIT_GAP_MS) {
        lastCriticalEventT = cd.t;
        pushEvent(
          cd.t,
          'CRITICAL',
          `Margin ratio ${(ratio * 100).toFixed(1)}% breached CRITICAL threshold (${(params.riskCriticalRatio * 100).toFixed(0)}%); pending DCA orders cancelled`,
        );
      }
      p.lastState = state;
    }
    // Spec section 5: WARNING blocks further averaging - the remaining DCA grid
    // is cancelled once the margin ratio first crosses the WARNING threshold
    // (configurable for A/B research).
    if (state === 'WARNING' && params.blockDcaOnWarning && !p.gridCancelled) {
      p.gridCancelled = true;
      pushEvent(
        cd.t,
        'DCA_BLOCKED_WARNING',
        `Margin ratio ${(ratio * 100).toFixed(1)}% in WARNING zone; remaining DCA orders cancelled (risk gate)`,
      );
    }
    if (state === 'CRITICAL') {
      p.gridCancelled = true;
      if (params.forceCloseAtRisk) {
        closePosition(barClose, cd.c, 'EMERGENCY_RISK', { slip: true, exitFeeRate: taker });
      }
    }
  };

  for (let i = 0; i < candles.length; i++) {
    const cd = candles[i];
    const prev = i > 0 ? candles[i - 1] : null;
    // Mark-price bar for this timestamp (mark drives liquidation + risk marks)
    const mk = markMap ? (markMap.get(cd.t) ?? cd) : cd;

    // --- funding accrual (positions held through the previous bar) ----------
    if (pos && params.fundingMode === 'historical') {
      const from = prev ? prev.t : -1;
      while (fi < funding.length && funding[fi].t <= cd.t) {
        const f = funding[fi++];
        if (f.t > from) {
          const amt = f.rate * pos.qty * (f.markPrice > 0 ? f.markPrice : cd.c);
          const paid = pos.direction === 'LONG' ? amt : -amt;
          pos.funding += paid;
          wallet -= paid;
        }
      }
    } else if (pos && params.fundingMode === 'fixed') {
      const rate = (params.fixedFundingPctPer8h / 100) * (msPerBar / (8 * HOUR_MS));
      const paid = rate * pos.qty * cd.c * (pos.direction === 'LONG' ? 1 : -1);
      pos.funding += paid;
      wallet -= paid;
    }

    if (prev) {
      const sigPrev = signals[i - 1];
      const flatAtOpen = pos === null;

      // --- trend-flip exit at bar OPEN (the flip is known at this open) -----
      if (pos && params.exitOnTrendFlip && isFlip(pos.direction, sigPrev)) {
        closePosition(cd.t, cd.o, 'TREND_FLIP', { slip: true, exitFeeRate: taker });
      }

      // --- entry at bar OPEN, only when flat at the open -------------------
      if (flatAtOpen) {
        if (sigPrev === 'LONG' && params.directionMode !== 'short') {
          openPosition(i, cd, 'LONG');
        } else if (sigPrev === 'SHORT' && params.directionMode !== 'long') {
          openPosition(i, cd, 'SHORT');
        }
      }

      // --- intrabar management, including the bar we just entered ---------
      if (pos) managePosition(i, cd, mk, pos);
    }

    // --- equity point (mark-to-market on mark price) -------------------------
    let ratio: number | null = null;
    let equity = wallet;
    if (pos) {
      const u = unrealizedPnl(pos.direction, pos.qty, pos.avgEntry, mk.c);
      equity = wallet + pos.margin + u;
      ratio = marginRatioOf(mmr, pos.qty, mk.c, pos.margin, u);
    }
    if (equity > peakEquity) peakEquity = equity;
    const ddPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    equityCurve.push({
      t: cd.t,
      equity,
      drawdownPct: ddPct,
      inPosition: pos !== null,
      marginRatio: ratio,
    });
  }

  // Force-close anything still open at the end of the dataset.
  if (pos) {
    const last = candles[candles.length - 1];
    closePosition(last.t + msPerBar, last.c, 'END_OF_DATA', {
      slip: true,
      exitFeeRate: taker,
    });
    // The last equity point was recorded before the force-close charged its
    // exit fee + slippage; sync it so reported finalEquity equals the realized
    // post-close wallet (metrics read the last curve point).
    const lastPoint = equityCurve[equityCurve.length - 1];
    if (lastPoint) {
      lastPoint.equity = wallet;
      lastPoint.inPosition = false;
      lastPoint.marginRatio = null;
      lastPoint.drawdownPct =
        peakEquity > 0 ? Math.max(0, ((peakEquity - wallet) / peakEquity) * 100) : 0;
    }
  }

  const metrics = computeMetrics(
    trades,
    equityCurve,
    params,
    candles[0].t,
    candles[candles.length - 1].t,
    markPriceLiq,
  );

  return {
    params,
    dataFrom: candles[0].t,
    dataTo: candles[candles.length - 1].t,
    candles: candles.length,
    trades,
    equityCurve,
    riskEvents,
    metrics,
  };
}
