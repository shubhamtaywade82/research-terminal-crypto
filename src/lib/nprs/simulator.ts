// NPRS position simulator: the single state machine shared by every execution mode
// (bar, refined, tick). It owns the wallet, the open position, fills, fees,
// funding, take-profit, liquidation, risk states and the trade / risk ledgers.
// Callers decide WHEN each primitive runs; this class decides WHAT it does.

import {
  Direction,
  ExitReason,
  FundingEvent,
  INTERVAL_MS,
  RiskEventRecord,
  RiskEventType,
  StrategyParams,
  TradeRecord,
  TrendSignal,
} from './types';
import { liquidationPrice, marginRatioOf, riskStateOf, unrealizedPnl } from './margin';

const HOUR_MS = 3_600_000;

export interface Position {
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

export interface CloseOpts {
  /** Apply exit slippage to the price (against the position). */
  slip: boolean;
  exitFeeRate: number;
  forfeitMargin?: boolean;
}

export type FillResult = 'FILLED' | 'LAST' | 'CAPPED';

export interface RiskReading {
  ratio: number;
  state: 'SAFE' | 'WARNING' | 'CRITICAL';
}

/** True when `signal` opposes the open position's direction. */
export function isFlip(direction: Direction, signal: TrendSignal | undefined): boolean {
  return (
    (direction === 'LONG' && signal === 'SHORT') ||
    (direction === 'SHORT' && signal === 'LONG')
  );
}

export class PositionSimulator {
  wallet: number;
  pos: Position | null = null;
  readonly trades: TradeRecord[] = [];
  readonly riskEvents: RiskEventRecord[] = [];

  private seq = 0;
  private skipActive = false;
  private lastWarnT = -Infinity;
  private lastCriticalT = -Infinity;

  readonly taker: number;
  readonly maker: number;
  readonly slip: number;
  readonly mmr: number;
  readonly lev: number;
  readonly msPerBar: number;
  readonly initialMargin0: number;
  readonly layerBase: number;
  readonly capUsd: number;

  constructor(readonly params: StrategyParams) {
    this.wallet = params.startingEquity;
    this.taker = params.feeTakerPct / 100;
    this.maker = params.feeMakerPct / 100;
    this.slip = params.slippagePct / 100;
    this.mmr = params.mmrPct / 100;
    this.lev = params.leverage;
    this.msPerBar = INTERVAL_MS[params.interval];
    this.initialMargin0 = params.startingEquity * (params.initialAllocPct / 100);
    this.layerBase = params.startingEquity * (params.dcaAllocPct / 100);
    this.capUsd = params.startingEquity * (params.maxMarginPct / 100);
  }

  pushEvent(t: number, type: RiskEventType, message: string): void {
    this.riskEvents.push({ t, type, message });
  }

  /**
   * Price at which NET ROI on deployed margin equals the target. Slippage and the
   * exit taker fee are applied to the exit price in closePosition(), so the solved
   * price includes both: a realised take-profit lands on the target.
   *   LONG : net = qty*P*(1-s)*(1-t) - cost - fees - funding
   *   SHORT: net = cost - qty*P*(1+s)*(1+t) - fees - funding
   */
  targetPrice(p: Position): number {
    const targetUsd = (this.params.targetRoiPct / 100) * p.margin;
    if (p.direction === 'LONG') {
      const denom = p.qty * (1 - this.slip) * (1 - this.taker);
      return denom > 0 ? (targetUsd + p.cost + p.fees + p.funding) / denom : NaN;
    }
    const denom = p.qty * (1 + this.slip) * (1 + this.taker);
    return denom > 0 ? (p.cost - p.fees - p.funding - targetUsd) / denom : NaN;
  }

  /** Take-profit reached by a price level (bar high/low or a single print). */
  tpReached(p: Position, px: number): boolean {
    const tp = this.targetPrice(p);
    return Number.isFinite(tp) && tp > 0 && (p.direction === 'LONG' ? px >= tp : px <= tp);
  }

  /**
   * Open at `rawOpen` (bar open or print price) when the free balance covers the
   * baseline allocation plus the taker fee. Returns false when entry is skipped.
   */
  openPosition(t: number, rawOpen: number, dir: Direction, atrPrev: number | undefined): boolean {
    if (this.wallet < this.initialMargin0 * (1 + this.lev * this.taker)) {
      if (!this.skipActive) {
        this.skipActive = true;
        this.pushEvent(
          t,
          'ENTRY_SKIPPED',
          'Free balance below baseline initial allocation; entries skipped until balance recovers',
        );
      }
      return false;
    }
    this.skipActive = false;
    const p0 = this.params;
    const price = dir === 'LONG' ? rawOpen * (1 + this.slip) : rawOpen * (1 - this.slip);
    const margin0 = this.initialMargin0;
    const qty = (margin0 * this.lev) / price;
    const fee = qty * price * this.taker;
    this.wallet -= margin0 + fee;

    // ATR spacing uses the PREVIOUS bar's ATR (known at this open).
    const spacingAbs =
      p0.spacingMode === 'fixed'
        ? price * (p0.spacingPct / 100)
        : (atrPrev ?? price * 0.02) * p0.atrMultiplier;
    const grid: number[] = [];
    for (let k = 1; k <= Math.round(p0.maxDcaLayers); k++) {
      const gp = dir === 'LONG' ? price - k * spacingAbs : price + k * spacingAbs;
      if (gp > 0) grid.push(gp);
    }

    this.pos = {
      direction: dir,
      openTime: t,
      qty,
      cost: qty * price,
      avgEntry: price,
      margin: margin0,
      fees: fee,
      funding: 0,
      liqPrice: liquidationPrice(price, this.lev, this.mmr, dir),
      grid,
      nextLayer: 0,
      gridCancelled: false,
      maePct: 0,
      mfePct: 0,
      lastState: 'SAFE',
    };
    this.pushEvent(
      t,
      'POSITION_OPENED',
      `${dir} @ ${price.toPrecision(8)} | margin ${margin0.toFixed(2)} | ${this.lev}x | ${grid.length} DCA orders (${p0.spacingMode === 'fixed' ? `${p0.spacingPct}% grid` : `ATR${p0.atrPeriod} x${p0.atrMultiplier}`})`,
    );
    return true;
  }

  /** Fill the next DCA layer at its limit price `gp` (maker fee, deployment cap). */
  fillLayer(t: number, p: Position, gp: number): FillResult {
    let m = this.layerBase;
    const allowed = this.capUsd - p.margin;
    if (m > allowed) m = allowed;
    if (this.wallet * 0.98 < m) m = this.wallet * 0.98;
    if (m < this.layerBase * 0.05 || m <= 0) {
      p.gridCancelled = true;
      this.pushEvent(
        t,
        'DCA_CAP',
        `Deployment cap (${this.params.maxMarginPct}% of starting equity) reached or balance insufficient; remaining DCA orders cancelled`,
      );
      return 'CAPPED';
    }
    const qty = (m * this.lev) / gp;
    const fee = qty * gp * this.maker;
    this.wallet -= m + fee;
    p.qty += qty;
    p.cost += qty * gp;
    p.margin += m;
    p.fees += fee;
    p.avgEntry = p.cost / p.qty;
    p.liqPrice = liquidationPrice(p.avgEntry, this.lev, this.mmr, p.direction);
    p.nextLayer += 1;
    if (m < this.layerBase - 1e-9) {
      p.gridCancelled = true;
      this.pushEvent(
        t,
        'DCA_CAP',
        `Final layer scaled to fit ${this.params.maxMarginPct}% deployment cap; remaining DCA orders cancelled`,
      );
      return 'LAST';
    }
    return 'FILLED';
  }

  /** Trend-health gate: a flip against the position cancels pending averaging. */
  applyFlipGate(t: number, p: Position, sigPrev: TrendSignal | undefined): void {
    if (p.gridCancelled || p.nextLayer >= p.grid.length) return;
    if (isFlip(p.direction, sigPrev) && this.params.blockDcaOnFlip) {
      p.gridCancelled = true;
      this.pushEvent(
        t,
        'DCA_BLOCKED_FLIP',
        `Trend flipped against ${p.direction} position; remaining DCA orders cancelled (trend health gate)`,
      );
    }
  }

  /** Bar-level DCA: every layer whose limit lies inside the bar's [low, high]. */
  fillBarLayers(t: number, p: Position, low: number, high: number): void {
    while (!p.gridCancelled && p.nextLayer < p.grid.length) {
      const gp = p.grid[p.nextLayer];
      const inRange = p.direction === 'LONG' ? gp >= low : gp <= high;
      if (!inRange) break;
      if (this.fillLayer(t, p, gp) !== 'FILLED') break;
    }
  }

  /** Trade-level DCA: every layer a single print crosses, in the order reached. */
  fillPriceLayers(t: number, p: Position, px: number): void {
    while (!p.gridCancelled && p.nextLayer < p.grid.length) {
      const gp = p.grid[p.nextLayer];
      const crossed = p.direction === 'LONG' ? px <= gp : px >= gp;
      if (!crossed) break;
      if (this.fillLayer(t, p, gp) !== 'FILLED') break;
    }
  }

  /** Close the open position at `priceRaw` (slippage / fees per `opts`). */
  closePosition(t: number, priceRaw: number, reason: ExitReason, opts: CloseOpts): void {
    const p = this.pos;
    if (!p) return;
    const price =
      p.direction === 'LONG'
        ? opts.slip
          ? priceRaw * (1 - this.slip)
          : priceRaw
        : opts.slip
          ? priceRaw * (1 + this.slip)
          : priceRaw;
    const exitFee = p.qty * price * opts.exitFeeRate;
    const gross =
      p.direction === 'LONG'
        ? p.qty * (price - p.avgEntry)
        : p.qty * (p.avgEntry - price);
    let netPnl: number;
    if (opts.forfeitMargin) {
      // Isolated liquidation: the whole position margin goes to the liquidation
      // engine. The wallet already paid margin, fees and funding when incurred.
      netPnl = -(p.margin + p.fees + p.funding);
    } else {
      const realized = gross - exitFee; // fees/funding already left the wallet
      this.wallet += p.margin + realized;
      netPnl = gross - exitFee - p.fees - p.funding;
    }
    this.pos = null;
    this.trades.push({
      seq: this.seq++,
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
      equityAfter: this.wallet,
      holdMinutes: Math.max(0, (t - p.openTime) / 60_000),
    });
  }

  /** Liquidate at the liquidation price; the whole deployed margin is forfeited. */
  liquidate(t: number, p: Position): void {
    const uAtLiq = unrealizedPnl(p.direction, p.qty, p.avgEntry, p.liqPrice);
    const layers = p.nextLayer;
    const margin = p.margin;
    const netLoss = -(p.margin + p.fees + p.funding);
    this.closePosition(t, p.liqPrice, 'LIQUIDATION', {
      slip: false,
      exitFeeRate: 0,
      forfeitMargin: true,
    });
    this.pushEvent(
      t,
      'LIQUIDATION',
      `${p.direction} position liquidated at ${p.liqPrice.toPrecision(8)} after ${layers} DCA layer(s); entire deployed margin forfeited (net ${netLoss.toFixed(2)} USDT, margin ${margin.toFixed(2)}, mark-price move at boundary ${uAtLiq.toFixed(2)})`,
    );
  }

  /** True when the mark extreme breaches the liquidation price. */
  liquidationBreached(p: Position, markLow: number, markHigh: number): boolean {
    const worst = p.direction === 'LONG' ? markLow : markHigh;
    return p.direction === 'LONG' ? worst <= p.liqPrice : worst >= p.liqPrice;
  }

  /** Bar-level MAE / MFE against the current average entry. */
  trackBarExcursion(p: Position, high: number, low: number): void {
    const worst = p.direction === 'LONG' ? low : high;
    const best = p.direction === 'LONG' ? high : low;
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

  /** Excursion from a single print against the current average entry. */
  trackPriceExcursion(p: Position, px: number): void {
    this.trackBarExcursion(p, px, px);
  }

  /** Margin ratio and risk state at a mark price; emits threshold-crossing events. */
  evaluateRisk(t: number, p: Position, markClose: number): RiskReading {
    const u = unrealizedPnl(p.direction, p.qty, p.avgEntry, markClose);
    const ratio = marginRatioOf(this.mmr, p.qty, markClose, p.margin, u);
    const state = riskStateOf(ratio, this.params.riskWarningRatio, this.params.riskCriticalRatio);
    if (state !== p.lastState) {
      if (state === 'WARNING' && t - this.lastWarnT > 6 * this.msPerBar) {
        this.lastWarnT = t;
        this.pushEvent(
          t,
          'WARNING',
          `Margin ratio ${(ratio * 100).toFixed(1)}% crossed WARNING threshold (${(this.params.riskWarningRatio * 100).toFixed(0)}%)`,
        );
      }
      if (state === 'CRITICAL' && t - this.lastCriticalT > 2 * this.msPerBar) {
        this.lastCriticalT = t;
        this.pushEvent(
          t,
          'CRITICAL',
          `Margin ratio ${(ratio * 100).toFixed(1)}% breached CRITICAL threshold (${(this.params.riskCriticalRatio * 100).toFixed(0)}%); pending DCA orders cancelled`,
        );
      }
      p.lastState = state;
    }
    return { ratio, state };
  }

  /**
   * Spec section 5: WARNING blocks further averaging, CRITICAL cancels it. Returns
   * true when the position must be force-closed (CRITICAL with forceCloseAtRisk).
   */
  applyRiskGates(t: number, p: Position, ratio: number, state: RiskReading['state']): boolean {
    if (state === 'WARNING' && this.params.blockDcaOnWarning && !p.gridCancelled) {
      p.gridCancelled = true;
      this.pushEvent(
        t,
        'DCA_BLOCKED_WARNING',
        `Margin ratio ${(ratio * 100).toFixed(1)}% in WARNING zone; remaining DCA orders cancelled (risk gate)`,
      );
    }
    if (state === 'CRITICAL') {
      p.gridCancelled = true;
      return this.params.forceCloseAtRisk;
    }
    return false;
  }

  /** Historical funding event against the open position (priced at its mark). */
  accrueHistoricalFunding(f: FundingEvent, closeFallback: number): void {
    const p = this.pos;
    if (!p) return;
    const amt = f.rate * p.qty * (f.markPrice > 0 ? f.markPrice : closeFallback);
    const paid = p.direction === 'LONG' ? amt : -amt;
    p.funding += paid;
    this.wallet -= paid;
  }

  /** Fixed-rate funding for one bar, pro-rated to the bar length. */
  accrueFixedFunding(closePrice: number): void {
    const p = this.pos;
    if (!p) return;
    const rate = (this.params.fixedFundingPctPer8h / 100) * (this.msPerBar / (8 * HOUR_MS));
    const paid = rate * p.qty * closePrice * (p.direction === 'LONG' ? 1 : -1);
    p.funding += paid;
    this.wallet -= paid;
  }

  /** Force-close at the end of the dataset (priced at `price`, exit costs applied). */
  finalize(t: number, price: number): void {
    if (this.pos) {
      this.closePosition(t, price, 'END_OF_DATA', { slip: true, exitFeeRate: this.taker });
    }
  }
}
