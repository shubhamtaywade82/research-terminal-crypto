// NPRS deterministic event-driven backtest engine.
//
// Design rules (spec sections 5/6/12):
//  - Signal from bar i-1 is executed at bar i open (no lookahead).
//  - Isolated margin; every tranche sized independently at configured leverage.
//  - Conservative intrabar ordering: liquidation is checked BEFORE DCA fills;
//    if both a DCA level and liquidation are touched within one candle the
//    simulator assumes liquidation happened first.
//  - Limit fills only when the candle range crosses the limit price; filled at
//    the limit price with maker fee (no queue modeling).
//  - When one candle touches both DCA levels and the (post-fill) take-profit,
//    fills are assumed to happen first (dip-then-rally); combined with the
//    liquidation-first rule above this is the coherent conservative ordering
//    for the dangerous cases.
//  - Take-profit counts only if the favorable extreme crosses the derived
//    target price; executed with slippage + taker fee (conservative).
//  - Funding applied from real history (or fixed rate) progressively.
//  - Position exits only via TP / liquidation / configured rules or end of data.

import {
  BacktestResult,
  Candle,
  Direction,
  EquitySeriesPoint,
  ExitReason,
  FundingEvent,
  RiskEventType,
  StrategyParams,
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
  fees: number; // entry fees paid
  funding: number; // net funding paid
  liqPrice: number;
  grid: number[]; // planned DCA limit prices
  nextLayer: number; // index of next unfilled layer
  gridCancelled: boolean;
  maePct: number;
  mfePct: number;
  lastState: 'SAFE' | 'WARNING' | 'CRITICAL';
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
  // consumed one bar later), so the DCA / risk machinery below is identical
  // for all signal families - the entry signal stays a controlled variable.
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
  let pos: Position | null = null;
  let seq = 0;
  let fi = 0; // funding pointer
  let peakEquity = wallet;

  const trades: TradeRecord[] = [];
  const equityCurve: EquitySeriesPoint[] = [];
  const riskEvents: { t: number; type: RiskEventType; message: string }[] = [];

  // Event rate limits: keep the risk ledger readable without losing signal.
  let lastWarnEventT = -Infinity;
  let lastCriticalEventT = -Infinity;
  let skipActive = false;
  const WARN_GAP_MS = 6 * msPerBar;
  const CRIT_GAP_MS = 2 * msPerBar;

  const pushEvent = (t: number, type: RiskEventType, message: string) => {
    riskEvents.push({ t, type, message });
  };

  // Price at which net ROI on deployed margin reaches the configured target.
  const targetPrice = (p: Position): number => {
    const targetUsd = (params.targetRoiPct / 100) * p.margin;
    if (p.direction === 'LONG') {
      const denom = p.qty * (1 - taker);
      return denom > 0 ? (targetUsd + p.fees + p.funding + p.cost) / denom : NaN;
    }
    const denom = p.qty * (1 + taker);
    return denom > 0 ? (p.cost - p.fees - p.funding - targetUsd) / denom : NaN;
  };

  const closeAt = (
    t: number,
    priceRaw: number,
    reason: ExitReason,
    opts: { slip: boolean; exitFeeRate: number; forfeitMargin?: boolean },
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
      // to the liquidation engine - nothing returns to the wallet. The gross
      // capital loss equals the deployed margin (fees/funding already paid).
      wallet += 0;
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

  const openAt = (i: number, cd: Candle, dir: Direction) => {
    // Entry needs margin + taker fee on the full notional (margin * lev).
    if (wallet < initialMargin0 * (1 + lev * taker)) {
      if (!skipActive) {
        skipActive = true;
        pushEvent(cd.t, 'ENTRY_SKIPPED', 'Free balance below baseline initial allocation; entries skipped until balance recovers');
      }
      return;
    }
    skipActive = false;
    const price = dir === 'LONG' ? cd.o * (1 + slip) : cd.o * (1 - slip);
    const margin0 = initialMargin0;
    const qty = (margin0 * lev) / price;
    const fee = qty * price * taker;
    wallet -= margin0 + fee;

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

  for (let i = 0; i < candles.length; i++) {
    const cd = candles[i];
    const prev = i > 0 ? candles[i - 1] : null;
    const hadPosAtStart = pos !== null;
    // Mark-price bar for this timestamp (mark drives liquidation + risk marks)
    const mk = markMap ? (markMap.get(cd.t) ?? cd) : cd;

    // --- funding accrual -----------------------------------------------------
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

    // --- position management -------------------------------------------------
    if (pos && prev) {
      const p = pos;
      const best = p.direction === 'LONG' ? cd.h : cd.l;

      // 1. Liquidation first: conservative intrabar ordering, evaluated on the
      //    real mark-price klines (Binance USDT-M liquidates on mark price)
      const worstMark = p.direction === 'LONG' ? mk.l : mk.h;
      const hitLiq =
        p.direction === 'LONG' ? worstMark <= p.liqPrice : worstMark >= p.liqPrice;
      if (hitLiq) {
        const uAtLiq = unrealizedPnl(p.direction, p.qty, p.avgEntry, p.liqPrice);
        closeAt(cd.t, p.liqPrice, 'LIQUIDATION', {
          slip: false,
          exitFeeRate: 0,
          forfeitMargin: true,
        });
        pushEvent(
          cd.t,
          'LIQUIDATION',
          `${p.direction} position liquidated at ${p.liqPrice.toPrecision(8)} after ${p.nextLayer} DCA layer(s); entire deployed margin forfeited (net ${(-(p.margin + p.fees + p.funding)).toFixed(2)} USDT, mark-price move at boundary ${uAtLiq.toFixed(2)})`,
        );
      } else {
        // 2. DCA limit fills
        if (!p.gridCancelled && p.nextLayer < p.grid.length) {
          const prevSignal = signals[i - 1];
          const flipped =
            (p.direction === 'LONG' && prevSignal === 'SHORT') ||
            (p.direction === 'SHORT' && prevSignal === 'LONG');
          if (flipped && params.blockDcaOnFlip) {
            p.gridCancelled = true;
            pushEvent(
              cd.t,
              'DCA_BLOCKED_FLIP',
              `Trend flipped against ${p.direction} position; remaining DCA orders cancelled (trend health gate)`,
            );
          } else {
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
                break;
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
                break;
              }
            }
          }
        }

        // 3. Take-profit on favorable extreme (if position survived fills)
        if (pos) {
          const tp = targetPrice(p);
          const tpHit =
            Number.isFinite(tp) &&
            tp > 0 &&
            (p.direction === 'LONG' ? best >= tp : best <= tp);
          if (tpHit) {
            closeAt(cd.t, tp, 'TAKE_PROFIT', { slip: true, exitFeeRate: taker });
          } else {
            const prevSignal = signals[i - 1];
            const flipped =
              (p.direction === 'LONG' && prevSignal === 'SHORT') ||
              (p.direction === 'SHORT' && prevSignal === 'LONG');
            if (flipped && params.exitOnTrendFlip) {
              closeAt(cd.t, cd.c, 'TREND_FLIP', { slip: true, exitFeeRate: taker });
            } else if (
              params.maxHoldHours > 0 &&
              cd.t - p.openTime >= params.maxHoldHours * HOUR_MS
            ) {
              closeAt(cd.t, cd.c, 'MAX_HOLD', { slip: true, exitFeeRate: taker });
            } else {
              // 4. Margin risk states evaluated at candle close on mark price
              const u = unrealizedPnl(p.direction, p.qty, p.avgEntry, mk.c);
              const ratio = marginRatioOf(mmr, p.qty, mk.c, p.margin, u);
              const state = riskStateOf(
                ratio,
                params.riskWarningRatio,
                params.riskCriticalRatio,
              );
              if (state !== p.lastState) {
                if (state === 'WARNING' && cd.t - lastWarnEventT > WARN_GAP_MS) {
                  lastWarnEventT = cd.t;
                  pushEvent(cd.t, 'WARNING', `Margin ratio ${(ratio * 100).toFixed(1)}% crossed WARNING threshold (${(params.riskWarningRatio * 100).toFixed(0)}%)`);
                }
                if (state === 'CRITICAL' && cd.t - lastCriticalEventT > CRIT_GAP_MS) {
                  lastCriticalEventT = cd.t;
                  pushEvent(cd.t, 'CRITICAL', `Margin ratio ${(ratio * 100).toFixed(1)}% breached CRITICAL threshold (${(params.riskCriticalRatio * 100).toFixed(0)}%); pending DCA orders cancelled`);
                }
                p.lastState = state;
              }
              // Spec section 5: WARNING blocks further averaging - the remaining
              // DCA grid is cancelled once the margin ratio first crosses the
              // WARNING threshold (configurable for A/B research).
              if (
                state === 'WARNING' &&
                params.blockDcaOnWarning &&
                !p.gridCancelled
              ) {
                p.gridCancelled = true;
                pushEvent(
                  cd.t,
                  'DCA_BLOCKED_WARNING',
                  `Margin ratio ${(ratio * 100).toFixed(1)}% in WARNING zone; remaining DCA orders cancelled (risk gate)`,
                );
              }
              if (state === 'CRITICAL') {
                if (!p.gridCancelled) p.gridCancelled = true;
                if (params.forceCloseAtRisk) {
                  closeAt(cd.t, cd.c, 'EMERGENCY_RISK', { slip: true, exitFeeRate: taker });
                }
              }
            }
          }
        }
      }
    }

    // --- excursion tracking ----------------------------------------------------
    if (pos) {
      const p = pos;
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
    }

    // --- new entry (only if flat for the entire candle) ------------------------
    if (!pos && !hadPosAtStart && prev) {
      const sig = signals[i - 1];
      if (sig === 'LONG' && params.directionMode !== 'short') openAt(i, cd, 'LONG');
      else if (sig === 'SHORT' && params.directionMode !== 'long') openAt(i, cd, 'SHORT');
    }

    // --- equity point (mark-to-market on mark price) --------------------------
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

  // Force-close anything still open at the end of the dataset
  if (pos) {
    const last = candles[candles.length - 1];
    closeAt(last.t, last.c, 'END_OF_DATA', { slip: true, exitFeeRate: taker });
    // The last equity point was recorded before the force-close charged its
    // exit fee + slippage; sync it so reported finalEquity equals the
    // realized post-close wallet (metrics read the last curve point).
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
