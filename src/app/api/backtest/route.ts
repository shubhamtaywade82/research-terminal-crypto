import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  runBacktest,
  runRefinedBacktest,
  TimeRange,
} from '@/lib/nprs/engine';
import { runTickBacktest, TICK_MAX_DAYS } from '@/lib/nprs/tick-engine';
import { sanitizeParams } from '@/lib/nprs/validate';
import {
  BacktestMetrics,
  BacktestResult,
  Candle,
  CompareRow,
  FundingEvent,
  IntrabarSource,
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
import { createAggTradeSource } from '@/lib/datasources/aggtrades';

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
  intrabarRefinedBars: 0,
  intrabarFallbackBars: 0,
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
  if (p.intrabarMode && p.intrabarMode !== 'bar') bits.push(`exec ${p.intrabarMode}`);
  return bits.join(' | ');
}

interface StoredRun {
  id: string;
  label: string;
  trades: number;
  metrics: BacktestMetrics;
}

/** Rows per bulk insert: keeps each statement well under SQLite's bind-param limit. */
const INSERT_CHUNK = 500;

function chunked<T>(rows: T[], size = INSERT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Persist one finished simulation. The run row and all child rows are written in ONE
 * transaction: a failed insert rolls back the whole experiment, so the registry never
 * lists a run whose trades are missing.
 */
async function storeRun(params: StrategyParams, result: BacktestResult, label: string): Promise<StoredRun> {
  const step = Math.max(1, Math.ceil(result.equityCurve.length / 2500));
  const sampledCurve = result.equityCurve.filter(
    (_p, idx) => idx % step === 0 || idx === result.equityCurve.length - 1,
  );

  const run = await db.$transaction(
    async (tx) => {
      const created = await tx.backtestRun.create({
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

      for (const batch of chunked(result.trades)) {
        await tx.trade.createMany({
          data: batch.map((t) => ({
            runId: created.id,
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

      for (const batch of chunked(sampledCurve, 1000)) {
        await tx.equityPoint.createMany({
          data: batch.map((p) => ({
            runId: created.id,
            t: new Date(p.t),
            equity: Math.round(p.equity * 100) / 100,
            drawdownPct: Math.round(p.drawdownPct * 100) / 100,
            inPosition: p.inPosition,
            marginRatio:
              p.marginRatio == null ? null : Math.round(p.marginRatio * 1000) / 1000,
          })),
        });
      }

      for (const batch of chunked(result.riskEvents, 1000)) {
        await tx.riskEvent.createMany({
          data: batch.map((e) => ({
            runId: created.id,
            t: new Date(e.t),
            type: e.type,
            message: e.message,
          })),
        });
      }

      return created;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );

  return {
    id: run.id,
    label,
    trades: result.trades.length,
    metrics: result.metrics,
  };
}

/** Candles, marks and funding for one request, already loaded from the database. */
interface DatasetInputs {
  candles: Candle[];
  markCandles: Candle[];
  funding: FundingEvent[];
  /** 1m mark klines, loaded only for tick mode (liquidation timing). */
  markFine: Candle[];
}

/**
 * Run one simulation in the requested execution mode. Every mode returns the same
 * BacktestResult shape; tick mode additionally reports how many prints it processed.
 */
async function executeRun(
  params: StrategyParams,
  data: DatasetInputs,
  range: TimeRange | undefined,
  source: IntrabarSource,
): Promise<BacktestResult & { tickStats?: { prints: number; days: number } }> {
  const marks = data.markCandles.length > 1 ? data.markCandles : undefined;
  if (params.intrabarMode === 'refined') {
    return runRefinedBacktest(data.candles, data.funding, params, source, marks, range);
  }
  if (params.intrabarMode === 'tick') {
    if (!range) throw new Error('tick mode needs a window: send windowFromMs and windowToMs');
    return runTickBacktest(
      params,
      {
        candles: data.candles,
        funding: data.funding,
        markCandles: marks,
        markFine: data.markFine.length > 1 ? data.markFine : undefined,
        markFineMs: 60_000,
        source: source as ReturnType<typeof createAggTradeSource>,
      },
      range,
    );
  }
  return runBacktest(data.candles, data.funding, params, marks, range);
}

/** Optional [windowFromMs, windowToMs) simulation window (epoch ms). */
function parseWindow(body: Record<string, unknown>): { range?: TimeRange; error?: string } {
  if (body.windowFromMs === undefined && body.windowToMs === undefined) return {};
  const fromMs = Number(body.windowFromMs);
  const toMs = Number(body.windowToMs);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return { error: 'windowFromMs and windowToMs must be epoch milliseconds with from < to' };
  }
  return { range: { fromMs, toMs } };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const params = sanitizeParams(body);
  const win = parseWindow(body);
  if (win.error) {
    return NextResponse.json({ message: win.error }, { status: 400 });
  }
  const range = win.range;

  // Warm-up history is always loaded (the engine skips bars before the window).
  const upTo = range ? { lt: new Date(range.toMs) } : undefined;
  const rows = await db.candle.findMany({
    where: { symbol: params.symbol, interval: params.interval, kind: 'last', ...(upTo ? { openTime: upTo } : {}) },
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

  const toCandle = (c: { openTime: Date; open: number; high: number; low: number; close: number; volume: number }): Candle => ({
    t: c.openTime.getTime(),
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: c.volume,
  });
  const candles: Candle[] = rows.map(toCandle);

  const markRows = await db.candle.findMany({
    where: { symbol: params.symbol, interval: params.interval, kind: 'mark', ...(upTo ? { openTime: upTo } : {}) },
    orderBy: { openTime: 'asc' },
  });
  const markCandles: Candle[] = markRows.map(toCandle);

  // Tick mode times liquidation on 1m mark klines when they are stored.
  const markFine: Candle[] =
    params.intrabarMode === 'tick'
      ? (
          await db.candle.findMany({
            where: { symbol: params.symbol, interval: '1m', kind: 'mark', ...(upTo ? { openTime: upTo } : {}) },
            orderBy: { openTime: 'asc' },
          })
        ).map(toCandle)
      : [];

  const fundingRows =
    params.fundingMode === 'historical'
      ? await db.fundingRate.findMany({
          where: { symbol: params.symbol },
          orderBy: { fundingTime: 'asc' },
        })
      : [];
  const funding: FundingEvent[] = fundingRows.map((f) => ({
    t: f.fundingTime.getTime(),
    rate: f.rate,
    markPrice: f.markPrice,
  }));

  const data: DatasetInputs = { candles, markCandles, funding, markFine };
  const customLabel =
    typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : '';

  // ------------------------------------------------------------------
  // Compare mode: every registered strategy on the SAME dataset with the same
  // DCA / risk / cost configuration - only the entry signal varies.
  // ------------------------------------------------------------------
  if (body.mode === 'compare') {
    if (params.intrabarMode === 'tick') {
      return NextResponse.json(
        { message: 'tick mode runs one strategy at a time; use refined mode to compare all strategies' },
        { status: 400 },
      );
    }
    const source = createAggTradeSource(params.symbol);
    const results: CompareRow[] = [];
    for (const s of STRATEGIES) {
      const strategyParams: StrategyParams = {
        ...params,
        strategyId: s.id,
        signalParams: defaultSignalParams(s.id),
      };
      const label = `[Compare] ${s.name} | ${configSuffix(params)}`;
      try {
        const result = await executeRun(strategyParams, data, range, source);
        const stored = await storeRun(strategyParams, result, label);
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
          { message: `Strategy ${s.name} failed: ${e instanceof Error ? e.message : 'backtest error'}` },
          { status: 400 },
        );
      }
    }
    return NextResponse.json({
      mode: 'compare',
      symbol: params.symbol,
      interval: params.interval,
      intrabarMode: params.intrabarMode ?? 'bar',
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
  let result: Awaited<ReturnType<typeof executeRun>>;
  try {
    result = await executeRun(params, data, range, createAggTradeSource(params.symbol));
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : 'Backtest failed' },
      { status: 400 },
    );
  }
  const stored = await storeRun(params, result, label);

  return NextResponse.json({
    id: stored.id,
    label,
    strategyId: params.strategyId ?? 'ema-trend',
    intrabarMode: params.intrabarMode ?? 'bar',
    candles: result.candles,
    markCandles: markCandles.length,
    window: range ?? null,
    maxTickDays: TICK_MAX_DAYS,
    trades: stored.trades,
    metrics: stored.metrics,
    tickStats: result.tickStats ?? null,
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
