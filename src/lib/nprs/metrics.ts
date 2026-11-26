// Post-run statistics: profitability, survival, recovery characteristics.
// Implements the metric set from spec sections 9A/9B/9C, including the
// central research objective P(profit target reached before liquidation),
// reported both unconditionally and conditioned on DCA depth.

import {
  BacktestMetrics,
  DepthStat,
  EquitySeriesPoint,
  StrategyParams,
  TradeRecord,
} from './types';

const YEAR_MS = 365.25 * 24 * 3_600_000;

export function computeMetrics(
  trades: TradeRecord[],
  equityCurve: EquitySeriesPoint[],
  params: StrategyParams,
  dataFrom: number,
  dataTo: number,
  markPriceLiq = false,
): BacktestMetrics {
  const initial = params.startingEquity;
  const finalEquity =
    equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initial;
  const totalReturnPct = (finalEquity / initial - 1) * 100;
  const spanMs = Math.max(1, dataTo - dataFrom);
  const years = spanMs / YEAR_MS;
  const annualizedReturnPct =
    years > 0.08 && finalEquity > 0
      ? (Math.pow(Math.max(finalEquity, 1e-9) / initial, 1 / years) - 1) * 100
      : null;

  const n = trades.length;
  const winsArr = trades.filter((t) => t.netPnl > 0);
  const lossesArr = trades.filter((t) => t.netPnl <= 0);
  const grossProfit = winsArr.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(lossesArr.reduce((s, t) => s + t.netPnl, 0));
  const netSum = trades.reduce((s, t) => s + t.netPnl, 0);

  // Per-trade returns on account equity (approximate Sharpe / Sortino)
  const rets = trades.map((t) => {
    const eqBefore = t.equityAfter - t.netPnl;
    return eqBefore > 0 ? t.netPnl / eqBefore : 0;
  });
  const mean = rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const variance =
    rets.length > 1
      ? rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (rets.length - 1)
      : 0;
  const std = Math.sqrt(variance);
  // Textbook Sortino: downside deviation against a zero target computed over
  // ALL per-trade returns (not the std of the negative subset).
  const dVar =
    rets.length > 0
      ? rets.reduce((s, r) => s + Math.min(r, 0) * Math.min(r, 0), 0) / rets.length
      : 0;
  const dStd = Math.sqrt(dVar);
  const tradesPerYear = years > 0 ? n / years : 0;
  const sharpe = std > 0 && tradesPerYear > 0 ? (mean / std) * Math.sqrt(tradesPerYear) : null;
  const sortino = dStd > 0 && tradesPerYear > 0 ? (mean / dStd) * Math.sqrt(tradesPerYear) : null;

  // Mark-to-market drawdown from the equity curve
  let maxDrawdownPct = 0;
  let maxDrawdownUsd = 0;
  let peak = initial;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const ddUsd = peak - p.equity;
    const ddPct = peak > 0 ? (ddUsd / peak) * 100 : 0;
    if (ddPct > maxDrawdownPct) {
      maxDrawdownPct = ddPct;
      maxDrawdownUsd = ddUsd;
    }
  }

  let consec = 0;
  let maxConsec = 0;
  for (const t of trades) {
    if (t.netPnl <= 0) {
      consec += 1;
      if (consec > maxConsec) maxConsec = consec;
    } else {
      consec = 0;
    }
  }

  const countReason = (r: string) => trades.filter((t) => t.exitReason === r).length;
  const tp = countReason('TAKE_PROFIT');
  const liq = countReason('LIQUIDATION');

  const totalHoldMinutes = trades.reduce((s, t) => s + t.holdMinutes, 0);
  const totalMinutes = spanMs / 60_000;

  const longs = trades.filter((t) => t.direction === 'LONG');
  const shorts = trades.filter((t) => t.direction === 'SHORT');
  const winRateOf = (arr: TradeRecord[]) =>
    arr.length > 0 ? (arr.filter((t) => t.netPnl > 0).length / arr.length) * 100 : null;

  const maxDepth = trades.reduce((m, t) => Math.max(m, t.dcaLayers), 0);
  const depthStats: DepthStat[] = [];
  for (let d = 0; d <= maxDepth; d++) {
    const bucket = trades.filter((t) => t.dcaLayers === d);
    const bTp = bucket.filter((t) => t.exitReason === 'TAKE_PROFIT').length;
    const bLiq = bucket.filter((t) => t.exitReason === 'LIQUIDATION').length;
    depthStats.push({
      depth: d,
      trades: bucket.length,
      tp: bTp,
      liq: bLiq,
      other: bucket.length - bTp - bLiq,
      pTpBeforeLiq: bTp + bLiq > 0 ? bTp / (bTp + bLiq) : null,
    });
  }

  return {
    finalEquity,
    totalReturnPct,
    annualizedReturnPct,
    totalTrades: n,
    wins: winsArr.length,
    losses: lossesArr.length,
    winRatePct: n > 0 ? (winsArr.length / n) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    expectancyUsd: n > 0 ? netSum / n : 0,
    expectancyRoiPct:
      n > 0 ? trades.reduce((s, t) => s + t.roiOnMargin, 0) / n : 0,
    avgWinUsd: winsArr.length > 0 ? grossProfit / winsArr.length : 0,
    avgLossUsd: lossesArr.length > 0 ? -grossLoss / lossesArr.length : 0,
    sharpe,
    sortino,
    maxDrawdownPct,
    maxDrawdownUsd,
    liquidations: liq,
    takeProfits: tp,
    maxHoldExits: countReason('MAX_HOLD'),
    trendFlipExits: countReason('TREND_FLIP'),
    emergencyExits: countReason('EMERGENCY_RISK'),
    endOfDataExits: countReason('END_OF_DATA'),
    maxConsecutiveLosses: maxConsec,
    maxMarginDeployedUsd:
      trades.reduce((m, t) => Math.max(m, t.marginDeployed), 0),
    maxDcaDepthUsed: maxDepth,
    totalFeesUsd: trades.reduce((s, t) => s + t.fees, 0),
    totalFundingUsd: trades.reduce((s, t) => s + t.funding, 0),
    avgHoldMinutes: n > 0 ? totalHoldMinutes / n : 0,
    exposurePct: totalMinutes > 0 ? (totalHoldMinutes / totalMinutes) * 100 : 0,
    pTpBeforeLiq: tp + liq > 0 ? tp / (tp + liq) : null,
    longTrades: longs.length,
    shortTrades: shorts.length,
    longWinRatePct: winRateOf(longs),
    shortWinRatePct: winRateOf(shorts),
    depthStats,
    markPriceLiq,
  };
}
