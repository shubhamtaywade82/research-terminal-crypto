// Margin & liquidation mathematics (isolated margin, one-way position).
//
// Simplifications versus Binance USDT-M (documented in the research panel):
//  - Liquidation boundary uses a static maintenance-margin rate (mmr) instead of
//    historical notional brackets.
//  - Isolated collateral = sum of tranche margins; fees and funding are
//    deducted from the free wallet progressively, not from position margin.
//  - On liquidation the position forfeits its ENTIRE deployed margin to the
//    liquidation engine (Binance isolated behavior) - nothing is returned.

import { Direction } from './types';

/**
 * Isolated-margin liquidation boundary:
 *   LONG : avg * (1 - 1/lev + mmr)
 *   SHORT: avg * (1 + 1/lev - mmr)
 */
export function liquidationPrice(
  avgEntry: number,
  leverage: number,
  mmr: number,
  direction: Direction,
): number {
  return direction === 'LONG'
    ? avgEntry * (1 - 1 / leverage + mmr)
    : avgEntry * (1 + 1 / leverage - mmr);
}

export function unrealizedPnl(
  direction: Direction,
  qty: number,
  avgEntry: number,
  mark: number,
): number {
  return direction === 'LONG' ? qty * (mark - avgEntry) : qty * (avgEntry - mark);
}

export function maintenanceMargin(mmr: number, qty: number, mark: number): number {
  return mmr * qty * mark;
}

/** Margin ratio = maintenance margin / margin balance (>= 10 once balance is gone). */
export function marginRatioOf(
  mmr: number,
  qty: number,
  mark: number,
  margin: number,
  uPnl: number,
): number {
  const balance = margin + uPnl;
  if (balance <= 0) return 10;
  return maintenanceMargin(mmr, qty, mark) / balance;
}

export type RiskState = 'SAFE' | 'WARNING' | 'CRITICAL';

export function riskStateOf(ratio: number, warn: number, crit: number): RiskState {
  if (ratio >= crit) return 'CRITICAL';
  if (ratio >= warn) return 'WARNING';
  return 'SAFE';
}
