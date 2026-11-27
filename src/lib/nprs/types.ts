// ---------------------------------------------------------------------------
// NPRS - NEMESIS Progressive Recovery Strategy
// Core domain types shared by engine (server) and dashboard (client).
// Exchange-independent: nothing here knows about Binance.
// ---------------------------------------------------------------------------

export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

/** Every interval the engine and archive ingestion support, finest first. */
export const INTERVALS: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

/**
 * How far back ingestion may go per interval. Finer bars mean far more rows
 * (1m = 525,600 bars per symbol-year), so the depth limit shrinks with the bar size.
 */
export const INTERVAL_MAX_YEARS: Record<Interval, number> = {
  '1m': 0.5,
  '5m': 0.25,
  '15m': 1,
  '1h': 5,
  '4h': 5,
  '1d': 5,
};

export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export interface Candle {
  t: number; // open time, epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface FundingEvent {
  t: number; // epoch ms
  rate: number; // e.g. 0.0001 = 0.01%
  markPrice: number;
}

export type Direction = 'LONG' | 'SHORT';
export type TrendSignal = 'LONG' | 'SHORT' | 'FLAT';

export type ExitReason =
  | 'TAKE_PROFIT'
  | 'LIQUIDATION'
  | 'MAX_HOLD'
  | 'TREND_FLIP'
  | 'EMERGENCY_RISK'
  | 'END_OF_DATA';

export type RiskEventType =
  | 'POSITION_OPENED'
  | 'WARNING'
  | 'CRITICAL'
  | 'DCA_CAP'
  | 'DCA_BLOCKED_FLIP'
  | 'DCA_BLOCKED_WARNING'
  | 'ENTRY_SKIPPED'
  | 'LIQUIDATION';

/**
 * Execution fidelity:
 *  - 'bar'     : OHLC bars. Intrabar order inferred (dip-then-rally). Fast.
 *  - 'refined' : OHLC bars, but a bar where a DCA limit is reachable is replayed from
 *                its aggTrades prints in time order. Exact order on those bars only.
 *  - 'tick'    : event-driven over every aggTrades print in the window. Decisions are
 *                still taken on the signal bars; fills, take-profit, liquidation and
 *                exits are evaluated trade by trade.
 */
export type IntrabarMode = 'bar' | 'refined' | 'tick';

/** Time-ordered trade prints for one window: t in epoch ms, p = trade price. */
export interface IntrabarWindow {
  t: Float64Array;
  p: Float64Array;
}

/** Supplies trade prints for [fromMs, toMs); null when the trades are unavailable. */
export interface IntrabarSource {
  window(fromMs: number, toMs: number): Promise<IntrabarWindow | null>;
}

export interface StrategyParams {
  // Market & dataset
  symbol: string;
  interval: Interval;
  /** Intrabar ordering (optional so runs stored before this field still load). */
  intrabarMode?: IntrabarMode;

  // Capital & sizing (spec sections 1/2)
  startingEquity: number;
  initialAllocPct: number; // % of startingEquity used for initial margin
  leverage: number; // x, applied to every tranche
  dcaAllocPct: number; // % of startingEquity per averaging layer
  maxDcaLayers: number;
  maxMarginPct: number; // hard deployment cap, % of startingEquity

  // DCA spacing (spec section 3)
  spacingMode: 'fixed' | 'atr';
  spacingPct: number; // fixed % of entry price
  atrPeriod: number;
  atrMultiplier: number;

  // Trend filter (spec sections 3 / 10)
  emaFast: number;
  emaSlow: number;
  directionMode: 'both' | 'long' | 'short';
  blockDcaOnFlip: boolean; // trend health gate: no new averaging when trend flipped
  exitOnTrendFlip: boolean; // experiment E8: trend invalidation exit

  // Entry signal strategy (the signal family is a controlled variable;
  // defaults to the spec-baseline EMA trend filter for backward compatibility)
  strategyId?: string;
  /** per-strategy inputs, e.g. { rsiPeriod: 14, rsiLongMin: 50 } */
  signalParams?: Record<string, number>;

  // Exit (spec section 4)
  targetRoiPct: number; // net ROI on total deployed margin
  maxHoldHours: number; // 0 = disabled (experiment E6)

  // Risk / liquidation monitoring (spec section 5)
  forceCloseAtRisk: boolean; // emergency action at CRITICAL
  riskWarningRatio: number; // margin ratio threshold
  riskCriticalRatio: number;
  /** spec section 5: WARNING blocks further averaging (grid is cancelled) */
  blockDcaOnWarning: boolean;

  // Costs (spec sections 4 / 12)
  feeMakerPct: number;
  feeTakerPct: number;
  slippagePct: number;
  fundingMode: 'historical' | 'fixed';
  fixedFundingPctPer8h: number;
  mmrPct: number; // maintenance margin rate (simplified bracket)
}

// --- Raw exchange-shaped rows (structural, used by data adapters) ----------

export interface RawKline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FundingRow {
  fundingTime: number;
  rate: number;
  markPrice: number;
}

// --- Engine outputs ---------------------------------------------------------

export interface TradeRecord {
  seq: number;
  direction: Direction;
  openTime: number;
  closeTime: number;
  avgEntry: number;
  exitPrice: number;
  qtyTotal: number;
  marginDeployed: number;
  dcaLayers: number; // filled averaging layers (0 = never averaged)
  grossPnl: number;
  fees: number; // entry + exit fees
  funding: number; // net funding paid (positive = paid)
  netPnl: number;
  roiOnMargin: number; // %, netPnl / marginDeployed
  maePct: number; // max adverse excursion from avg entry
  mfePct: number; // max favorable excursion from avg entry
  exitReason: ExitReason;
  equityAfter: number;
  holdMinutes: number;
}

export interface EquitySeriesPoint {
  t: number;
  equity: number;
  drawdownPct: number;
  inPosition: boolean;
  marginRatio: number | null;
}

export interface RiskEventRecord {
  t: number;
  type: RiskEventType;
  message: string;
}

export interface DepthStat {
  depth: number; // DCA layers filled
  trades: number;
  tp: number;
  liq: number;
  other: number;
  pTpBeforeLiq: number | null;
}

export interface BacktestMetrics {
  finalEquity: number;
  totalReturnPct: number;
  annualizedReturnPct: number | null;
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  profitFactor: number | null;
  expectancyUsd: number;
  expectancyRoiPct: number;
  avgWinUsd: number;
  avgLossUsd: number;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  liquidations: number;
  takeProfits: number;
  maxHoldExits: number;
  trendFlipExits: number;
  emergencyExits: number;
  endOfDataExits: number;
  maxConsecutiveLosses: number;
  maxMarginDeployedUsd: number;
  maxDcaDepthUsed: number;
  totalFeesUsd: number;
  totalFundingUsd: number;
  avgHoldMinutes: number;
  exposurePct: number;
  pTpBeforeLiq: number | null;
  /** true when liquidation was evaluated on real mark-price klines */
  markPriceLiq: boolean;
  longTrades: number;
  shortTrades: number;
  longWinRatePct: number | null;
  shortWinRatePct: number | null;
  depthStats: DepthStat[];
  /** Bars whose intrabar order was resolved from aggTrades prints. */
  intrabarRefinedBars: number;
  /** Bars that needed aggTrades but had none; resolved with the OHLC rule instead. */
  intrabarFallbackBars: number;
}

export interface BacktestResult {
  params: StrategyParams;
  dataFrom: number;
  dataTo: number;
  candles: number;
  trades: TradeRecord[];
  equityCurve: EquitySeriesPoint[];
  riskEvents: RiskEventRecord[];
  metrics: BacktestMetrics;
}

// --- API shapes (client <-> server) ----------------------------------------

export interface DatasetInfo {
  symbol: string;
  interval: string;
  candles: number;
  markCandles: number;
  from: number | null;
  to: number | null;
  fundingEvents: number;
  /** stored bars / expected bars over [from, to] at the interval grid */
  coveragePct: number | null;
}

export interface RunSummary {
  id: string;
  createdAt: number;
  label: string;
  symbol: string;
  interval: string;
  strategyId?: string;
  totalTrades: number;
  finalEquity: number;
  totalReturnPct: number;
  winRatePct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  liquidations: number;
  pTpBeforeLiq: number | null;
  expectancyRoiPct: number;
}

/** One row of a strategy comparison run (all strategies, same dataset/config). */
export interface CompareRow {
  id: string;
  strategyId: string;
  name: string;
  category: string;
  style: string;
  label: string;
  trades: number;
  metrics: BacktestMetrics;
}

export interface RunDetail {
  id: string;
  createdAt: number;
  label: string;
  symbol: string;
  interval: string;
  dataFrom: number;
  dataTo: number;
  params: StrategyParams;
  metrics: BacktestMetrics;
  trades: TradeRecord[];
  equityCurve: EquitySeriesPoint[];
  riskEvents: RiskEventRecord[];
  priceSeries: { t: number; c: number }[];
}

export interface IngestJobState {
  running: boolean;
  /** Human-readable label of the active data source. */
  source: string;
  symbols: string[];
  interval: string;
  years: number;
  startedAt: number | null;
  finishedAt: number | null;
  progress: number;
  current: string;
  log: string[];
  error: string | null;
  insertedCandles: number;
  insertedFunding: number;
  filesDownloaded: number;
  filesCached: number;
}
