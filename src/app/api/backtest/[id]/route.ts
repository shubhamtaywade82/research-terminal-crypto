import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { dbRead } from '@/lib/db-read';
import {
  BacktestMetrics,
  EquitySeriesPoint,
  RunDetail,
  RiskEventRecord,
  StrategyParams,
  TradeRecord,
} from '@/lib/nprs/types';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  const run = await dbRead.backtestRun.findUnique({
    where: { id },
    include: {
      trades: { orderBy: { seq: 'asc' } },
      equityPoints: { orderBy: { t: 'asc' } },
      riskEvents: { orderBy: { t: 'asc' } },
    },
  });
  if (!run) {
    return NextResponse.json({ message: 'Run not found' }, { status: 404 });
  }

  const candles = await dbRead.candle.findMany({
    where: {
      symbol: run.symbol,
      interval: run.interval,
      kind: 'last',
      openTime: { gte: run.dataFrom, lte: run.dataTo },
    },
    orderBy: { openTime: 'asc' },
    select: { openTime: true, close: true },
  });
  const step = Math.max(1, Math.ceil(candles.length / 1500));
  const picked = candles.filter((_, idx) => idx % step === 0);
  // keep the final candle so the price chart runs to the end of the dataset
  if (candles.length > 0 && picked[picked.length - 1] !== candles[candles.length - 1]) {
    picked.push(candles[candles.length - 1]);
  }
  const priceSeries = picked.map((c) => ({ t: c.openTime.getTime(), c: c.close }));

  const trades: TradeRecord[] = run.trades.map((t) => ({
    seq: t.seq,
    direction: t.direction === 'SHORT' ? 'SHORT' : 'LONG',
    openTime: t.openTime.getTime(),
    closeTime: t.closeTime.getTime(),
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
    exitReason: t.exitReason as TradeRecord['exitReason'],
    equityAfter: t.equityAfter,
    holdMinutes: t.holdMinutes,
  }));

  const equityCurve: EquitySeriesPoint[] = run.equityPoints.map((p) => ({
    t: p.t.getTime(),
    equity: p.equity,
    drawdownPct: p.drawdownPct,
    inPosition: p.inPosition,
    marginRatio: p.marginRatio,
  }));

  const riskEvents: RiskEventRecord[] = run.riskEvents.map((e) => ({
    t: e.t.getTime(),
    type: e.type as RiskEventRecord['type'],
    message: e.message,
  }));

  const detail: RunDetail = {
    id: run.id,
    createdAt: run.createdAt.getTime(),
    label: run.label,
    symbol: run.symbol,
    interval: run.interval,
    dataFrom: run.dataFrom.getTime(),
    dataTo: run.dataTo.getTime(),
    params: JSON.parse(run.params) as StrategyParams,
    metrics: JSON.parse(run.metrics) as BacktestMetrics,
    trades,
    equityCurve,
    riskEvents,
    priceSeries,
  };

  return NextResponse.json(detail);
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    await db.backtestRun.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: 'Run not found' }, { status: 404 });
  }
}
