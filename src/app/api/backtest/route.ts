import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { runBacktest } from '@/lib/nprs/engine';
import { sanitizeParams } from '@/lib/nprs/validate';
import {
  BacktestMetrics,
  Candle,
  CompareRow,
  RunSummary,
  StrategyParams,
} from '@/lib/nprs/types';
import {
  defaultSignalParams,
  describeEma,
  describeSignalParams,
  getStrategy,
  STRATEGIES,
} from '@/lib/nprs/strategies';

const EMPTY_METRICS: BacktestMetrics = {
  finalEquity: 0,
  totalReturnPct: 0,
  annualizedReturnPct: null,
  totalTrades: 0,
  wins: 0,
  losses: 0,
  winRatePct: 0,
  profitFactor: null,
  expectancyUsd: 0,
  expectancyRoiPct: 0,
  avgWinUsd: 0,
  avgLossUsd: 0,
  sharpe: null,
  sortino: null,
  maxDrawdownPct: 0,
  maxDrawdownUsd: 0,
  liquidations: 0,
  takeProfits: 0,
  maxHoldExits: 0,
  trendFlipExits: 0,
  emergencyExits: 0,
  endOfDataExits: 0,
  maxConsecutiveLosses: 0,
  maxMarginDeployedUsd: 0,
  maxDcaDepthUsed: 0,
  totalFeesUsd: 0,
  totalFundingUsd: 0,
  avgHoldMinutes: 0,
  exposurePct: 0,
  pTpBeforeLiq: null,
  longTrades: 0,
  shortTrades: 0,
  longWinRatePct: null,
  shortWinRatePct: null,
  depthStats: [],
  markPriceLiq: false,
};

/** Short config summary appended to auto labels. */
function configSuffix(p: StrategyParams): string {
  const grid =
    p.spacingMode === 'fixed' ? `${p.spacingPct}% grid` : `ATR${p.atrPeriod} x${p.atrMultiplier}`;
  return `${p.symbol} ${p.interval} lev${p.leverage} ${grid}`;
}

/** Auto label: strategy identity + config. */
function autoLabel(p: StrategyParams): string {
  const s = getStrategy(p.strategyId);
  const bits: string[] = [s.name];
  if (s.usesEma) bits.push(describeEma(p));
  const spDesc = describeSignalParams(s.id, p.signalParams);
  if (spDesc) bits.push(spDesc);
  bits.push(configSuffix(p));
  return bits.join(' | ');
}

interface StoredRun {
  id: string;
  label: string;
  trades: number;
  metrics: BacktestMetrics;
}

/** Run the engine for one param set and persist the full run ledger. */
async function runAndStore(
  params: StrategyParams,
  candles: Candle[],
  markCandles: Candle[],
  funding: { t: number; rate: number; markPrice: number }[],
  label: string,
): Promise<StoredRun> {
  const result = runBacktest(
    candles,
    funding,
    params,
    markCandles.length > 1 ? markCandles : undefined,
  );

  const run = await db.backtestRun.create({
    data: {
      label,
      symbol: params.symbol,
      interval: params.interval,
      dataFrom: new Date(result.dataFrom),
      dataTo: new Date(result.dataTo),
      params: JSON.stringify(params),
      status: 'COMPLETED',
      metrics: JSON.stringify(result.metrics),
    },
  });

  if (result.trades.length > 0) {
    await db.trade.createMany({
      data: result.trades.map((t) => ({
        runId: run.id,
        seq: t.seq,
        direction: t.direction,
        openTime: new Date(t.openTime),
        closeTime: new Date(t.closeTime),
        avgEntry: t.avgEntry,
        exitPrice: t.exitPrice,
        qtyTotal: t.qtyTotal,
        marginDeployed: t.marginDeployed,
        dcaLayers: t.dcaLayers,
        grossPnl: t.grossPnl,
        fees: t.fees,
        funding: t.funding,
        netPnl: t.netPnl,
        roiOnMargin: t.roiOnMargin,
        maePct: t.maePct,
        mfePct: t.mfePct,
        exitReason: t.exitReason,
        equityAfter: t.equityAfter,
        holdMinutes: t.holdMinutes,
      })),
    });
  }

  const step = Math.max(1, Math.ceil(result.equityCurve.length / 2500));
  const points = result.equityCurve
    .filter((p, idx) => idx % step === 0 || idx === result.equityCurve.length - 1)
    .map((p) => ({
      runId: run.id,
      t: new Date(p.t),
      equity: Math.round(p.equity * 100) / 100,
      drawdownPct: Math.round(p.drawdownPct * 100) / 100,
      inPosition: p.inPosition,
      marginRatio:
        p.marginRatio == null ? null : Math.round(p.marginRatio * 1000) / 1000,
    }));
  if (points.length > 0) {
    await db.equityPoint.createMany({ data: points });
  }

  if (result.riskEvents.length > 0) {
    await db.riskEvent.createMany({
      data: result.riskEvents.map((e) => ({
        runId: run.id,
        t: new Date(e.t),
        type: e.type,
        message: e.message,
      })),
    });
  }

  return {
    id: run.id,
    label,
    trades: result.trades.length,
    metrics: result.metrics,
  };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const params = sanitizeParams(body);

  const rows = await db.candle.findMany({
    where: { symbol: params.symbol, interval: params.interval, kind: 'last' },
    orderBy: { openTime: 'asc' },
  });
  if (rows.length < 250) {
    return NextResponse.json(
      {
        message: `Not enough data for ${params.symbol} ${params.interval}: ${rows.length} candles stored. Ingest a dataset first (need at least 250).`,
      },
      { status: 400 },
    );
  }

  const candles: Candle[] = rows.map((c) => ({
    t: c.openTime.getTime(),
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: c.volume,
  }));

  // Real mark-price klines drive liquidation when available
  const markRows = await db.candle.findMany({
    where: { symbol: params.symbol, interval: params.interval, kind: 'mark' },
    orderBy: { openTime: 'asc' },
  });
  const markCandles: Candle[] = markRows.map((c) => ({
    t: c.openTime.getTime(),
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: c.volume,
  }));

  const fundingRows =
    params.fundingMode === 'historical'
      ? await db.fundingRate.findMany({
          where: { symbol: params.symbol },
          orderBy: { fundingTime: 'asc' },
        })
      : [];
  const funding = fundingRows.map((f) => ({
    t: f.fundingTime.getTime(),
    rate: f.rate,
    markPrice: f.markPrice,
  }));

  const customLabel =
    typeof body.label === 'string' && body.label.trim()
      ? body.label.trim().slice(0, 120)
      : '';

  // ------------------------------------------------------------------
  // Compare mode: every registered strategy on the SAME dataset with the
  // same DCA / risk / cost configuration - only the entry signal varies.
  // ------------------------------------------------------------------
  if (body.mode === 'compare') {
    const results: CompareRow[] = [];
    for (const s of STRATEGIES) {
      const strategyParams: StrategyParams = {
        ...params,
        strategyId: s.id,
        signalParams: defaultSignalParams(s.id),
      };
      const label = `[Compare] ${s.name} | ${configSuffix(params)}`;
      try {
        const stored = await runAndStore(
          strategyParams,
          candles,
          markCandles,
          funding,
          label,
        );
        results.push({
          id: stored.id,
          strategyId: s.id,
          name: s.name,
          category: s.category,
          style: s.style,
          label,
          trades: stored.trades,
          metrics: stored.metrics,
        });
      } catch (e) {
        return NextResponse.json(
          {
            message: `Strategy ${s.name} failed: ${
              e instanceof Error ? e.message : 'backtest error'
            }`,
          },
          { status: 400 },
        );
      }
    }
    return NextResponse.json({
      mode: 'compare',
      symbol: params.symbol,
      interval: params.interval,
      config: {
        leverage: params.leverage,
        targetRoiPct: params.targetRoiPct,
        maxDcaLayers: params.maxDcaLayers,
        spacingMode: params.spacingMode,
        spacingPct: params.spacingPct,
        atrMultiplier: params.atrMultiplier,
        directionMode: params.directionMode,
      },
      results,
    });
  }

  // ------------------------------------------------------------------
  // Single-strategy mode (selected strategy, current params)
  // ------------------------------------------------------------------
  const label = customLabel || autoLabel(params);

  let stored: StoredRun;
  try {
    stored = await runAndStore(params, candles, markCandles, funding, label);
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : 'Backtest failed' },
      { status: 400 },
    );
  }

  return NextResponse.json({
    id: stored.id,
    label,
    strategyId: params.strategyId ?? 'ema-trend',
    candles: candles.length,
    markCandles: markCandles.length,
    trades: stored.trades,
    metrics: stored.metrics,
  });
}

export async function GET() {
  const runs = await db.backtestRun.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const summaries: RunSummary[] = runs.map((r) => {
    let m: BacktestMetrics;
    let strategyId: string | undefined;
    try {
      m = JSON.parse(r.metrics) as BacktestMetrics;
    } catch {
      m = EMPTY_METRICS;
    }
    try {
      strategyId = (JSON.parse(r.params) as { strategyId?: string }).strategyId;
    } catch {
      strategyId = undefined;
    }
    return {
      id: r.id,
      createdAt: r.createdAt.getTime(),
      label: r.label,
      symbol: r.symbol,
      interval: r.interval,
      strategyId,
      totalTrades: m.totalTrades,
      finalEquity: m.finalEquity,
      totalReturnPct: m.totalReturnPct,
      winRatePct: m.winRatePct,
      profitFactor: m.profitFactor,
      maxDrawdownPct: m.maxDrawdownPct,
      liquidations: m.liquidations,
      pTpBeforeLiq: m.pTpBeforeLiq,
      expectancyRoiPct: m.expectancyRoiPct,
    };
  });
  return NextResponse.json({ runs: summaries });
}
