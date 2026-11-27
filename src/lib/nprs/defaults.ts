// Baseline configuration (spec section 12) and the controlled experiment
// presets E1-E9 used to isolate which component creates the edge.

import { StrategyParams } from './types';

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

/**
 * Binance USDT-M published tier-1 (lowest notional bracket) maintenance
 * margin rates, used as the per-symbol MMR suggestion. Real liquidation uses
 * notional-dependent brackets; the static tier-1 value is the documented
 * approximation for the sub-50k USDT notional range this research trades.
 */
export const SYMBOL_MMR_PCT: Record<string, number> = {
  BTCUSDT: 0.4,
  ETHUSDT: 0.5,
  SOLUSDT: 1.0,
  XRPUSDT: 1.0,
};

export const DEFAULT_PARAMS: StrategyParams = {
  symbol: 'BTCUSDT',
  interval: '1h',
  intrabarMode: 'bar',
  strategyId: 'ema-trend',
  signalParams: {},
  startingEquity: 10_000,
  initialAllocPct: 10,
  leverage: 10,
  dcaAllocPct: 5,
  maxDcaLayers: 8,
  maxMarginPct: 50,
  spacingMode: 'fixed',
  spacingPct: 2,
  atrPeriod: 14,
  atrMultiplier: 1.5,
  emaFast: 50,
  emaSlow: 200,
  directionMode: 'both',
  blockDcaOnFlip: true,
  exitOnTrendFlip: false,
  targetRoiPct: 10,
  maxHoldHours: 0,
  forceCloseAtRisk: false,
  riskWarningRatio: 0.5,
  riskCriticalRatio: 0.8,
  blockDcaOnWarning: true,
  feeMakerPct: 0.02,
  feeTakerPct: 0.05,
  slippagePct: 0.02,
  fundingMode: 'historical',
  fixedFundingPctPer8h: 0.01,
  mmrPct: 0.5,
};

export interface Preset {
  id: string;
  name: string;
  description: string;
  patch: Partial<StrategyParams>;
}

export const PRESETS: Preset[] = [
  {
    id: 'baseline',
    name: 'Baseline',
    description: 'Spec baseline: 10% / 10x / 5% per layer / 2% grid / 50% cap',
    patch: {},
  },
  {
    id: 'e1',
    name: 'E1 - Fixed 2%',
    description: 'Baseline DCA spacing at 2%',
    patch: { spacingMode: 'fixed', spacingPct: 2 },
  },
  {
    id: 'e2',
    name: 'E2 - Fixed 1%',
    description: 'Tighter averaging grid',
    patch: { spacingMode: 'fixed', spacingPct: 1 },
  },
  {
    id: 'e3',
    name: 'E3 - ATR spacing',
    description: 'Volatility-scaled grid: ATR(14) x 1.5',
    patch: { spacingMode: 'atr', atrPeriod: 14, atrMultiplier: 1.5 },
  },
  {
    id: 'e6',
    name: 'E6 - Time exit',
    description: 'Force exit after 48h holding',
    patch: { maxHoldHours: 48 },
  },
  {
    id: 'e7',
    name: 'E7 - Max 4 layers',
    description: 'Shallow averaging depth, 30% cap',
    patch: { maxDcaLayers: 4, maxMarginPct: 30 },
  },
  {
    id: 'e8',
    name: 'E8 - Flip exit',
    description: 'Exit position on trend invalidation',
    patch: { exitOnTrendFlip: true },
  },
  {
    id: 'e9',
    name: 'E9 - 5x leverage',
    description: 'Half leverage, wider survival envelope',
    patch: { leverage: 5 },
  },
];
