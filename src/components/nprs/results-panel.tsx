'use client';

// Experiment results: headline metrics, equity/drawdown curves, price chart
// with trade markers, exit breakdown, recovery-by-depth table, risk ledger.

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { FlaskConical, SearchX, ShieldAlert } from 'lucide-react';
import { DrawdownChart, EquityChart, PriceChart } from '@/components/nprs/charts';
import { MetricCard } from '@/components/nprs/metric-card';
import { getStrategy } from '@/lib/nprs/strategies';
import {
  fmtDate,
  fmtDuration,
  fmtPct,
  fmtSignedPct,
  fmtSignedUsd,
  fmtUsd,
} from '@/lib/format';
import { RunDetail } from '@/lib/nprs/types';

interface ResultsPanelProps {
  detail: RunDetail | null;
  loading: boolean;
}

function riskTone(type: string): string {
  if (type === 'LIQUIDATION' || type === 'CRITICAL') return 'text-rose-400';
  if (
    type === 'WARNING' ||
    type === 'DCA_CAP' ||
    type === 'DCA_BLOCKED_FLIP' ||
    type === 'DCA_BLOCKED_WARNING'
  )
    return 'text-amber-400';
  return 'text-zinc-400';
}

export function ResultsPanel({ detail, loading }: ResultsPanelProps) {
  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20 border-zinc-800 bg-zinc-900/60" />
          ))}
        </div>
        <Skeleton className="h-64 w-full border-zinc-800 bg-zinc-900/60" />
        <Skeleton className="h-72 w-full border-zinc-800 bg-zinc-900/60" />
      </div>
    );
  }

  if (!detail) {
    return (
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <SearchX className="h-10 w-10 text-zinc-600" />
          <div>
            <p className="text-sm font-medium text-zinc-300">No experiment selected</p>
            <p className="mt-1 text-xs text-zinc-500">
              Run a backtest from the Run tab, or load a stored experiment from Experiments.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const m = detail.metrics;
  const p = detail.params;
  const entries = detail.trades.map((t) => ({ t: t.openTime, price: t.avgEntry }));
  const exitTp = detail.trades
    .filter((t) => t.exitReason === 'TAKE_PROFIT')
    .map((t) => ({ t: t.closeTime, price: t.exitPrice }));
  const exitLiq = detail.trades
    .filter((t) => t.exitReason === 'LIQUIDATION')
    .map((t) => ({ t: t.closeTime, price: t.exitPrice }));
  const exitOther = detail.trades
    .filter((t) => t.exitReason !== 'TAKE_PROFIT' && t.exitReason !== 'LIQUIDATION')
    .map((t) => ({ t: t.closeTime, price: t.exitPrice }));

  const exitRows: { label: string; count: number; cls: string }[] = [
    { label: 'Take profit', count: m.takeProfits, cls: 'bg-emerald-500' },
    { label: 'Liquidation', count: m.liquidations, cls: 'bg-rose-500' },
    { label: 'Max hold (E6)', count: m.maxHoldExits, cls: 'bg-amber-500' },
    { label: 'Trend flip (E8)', count: m.trendFlipExits, cls: 'bg-amber-400' },
    { label: 'Emergency risk', count: m.emergencyExits, cls: 'bg-rose-400' },
    { label: 'End of data', count: m.endOfDataExits, cls: 'bg-zinc-500' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-sm font-semibold text-zinc-100">{detail.label}</h2>
        {p.strategyId ? (
          <Badge
            variant="outline"
            className="border-emerald-500/40 bg-emerald-500/5 text-[10px] text-emerald-400"
          >
            {getStrategy(p.strategyId).name}
          </Badge>
        ) : null}
        <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-300">
          {detail.symbol}
        </Badge>
        <Badge variant="outline" className="border-zinc-700 font-mono text-[10px] text-zinc-300">
          {detail.interval}
        </Badge>
        <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
          {fmtDate(detail.dataFrom)} - {fmtDate(detail.dataTo)}
        </Badge>
        <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
          {detail.trades.length} trades
        </Badge>
        {m.markPriceLiq ? (
          <Badge
            variant="outline"
            className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-400"
          >
            liq on real mark price
          </Badge>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard
          label="Final equity"
          value={fmtUsd(m.finalEquity)}
          hint={`start ${fmtUsd(p.startingEquity, 0)}`}
          tone={m.finalEquity >= p.startingEquity ? 'positive' : 'negative'}
        />
        <MetricCard
          label="Total return"
          value={fmtSignedPct(m.totalReturnPct)}
          tone={m.totalReturnPct >= 0 ? 'positive' : 'negative'}
          hint={m.annualizedReturnPct != null ? `annualized ${fmtSignedPct(m.annualizedReturnPct)}` : undefined}
        />
        <MetricCard
          label="Win rate"
          value={fmtPct(m.winRatePct, 1)}
          hint={`${m.wins}W / ${m.losses}L - high win rate can hide tail risk`}
        />
        <MetricCard
          label="Profit factor"
          value={m.profitFactor == null ? 'no losses' : m.profitFactor.toFixed(2)}
          tone={m.profitFactor != null && m.profitFactor < 1 ? 'negative' : 'default'}
        />
        <MetricCard
          label="Expectancy / trade"
          value={fmtSignedUsd(m.expectancyUsd)}
          hint={`ROI on margin ${fmtSignedPct(m.expectancyRoiPct)}`}
          tone={m.expectancyUsd >= 0 ? 'positive' : 'negative'}
        />
        <MetricCard label="Max drawdown" value={fmtPct(m.maxDrawdownPct, 2)} hint={fmtUsd(m.maxDrawdownUsd)} tone="negative" />
        <MetricCard
          label="P(TP before liq)"
          value={m.pTpBeforeLiq == null ? '-' : fmtPct(m.pTpBeforeLiq * 100, 1)}
          hint="central research objective"
          tone="warning"
        />
        <MetricCard
          label="Liquidations"
          value={String(m.liquidations)}
          hint={`of ${m.totalTrades} trades`}
          tone={m.liquidations > 0 ? 'negative' : 'positive'}
        />
        <MetricCard
          label="Sharpe (approx)"
          value={m.sharpe == null ? '-' : m.sharpe.toFixed(2)}
          hint={m.sortino != null ? `Sortino ${m.sortino.toFixed(2)}` : 'per-trade returns'}
        />
        <MetricCard label="Total fees" value={fmtUsd(m.totalFeesUsd)} tone="warning" />
        <MetricCard
          label="Total funding"
          value={fmtSignedUsd(m.totalFundingUsd)}
          tone={m.totalFundingUsd <= 0 ? 'positive' : 'warning'}
          hint={p.fundingMode === 'historical' ? 'real USDT-M history' : 'fixed rate'}
        />
        <MetricCard
          label="Max margin used"
          value={fmtUsd(m.maxMarginDeployedUsd)}
          hint={`cap ${fmtPct(p.maxMarginPct, 0)} = ${fmtUsd((p.startingEquity * p.maxMarginPct) / 100, 0)}`}
        />
        <MetricCard
          label="Max DCA depth"
          value={`${m.maxDcaDepthUsed} layers`}
          hint={`max consecutive losses ${m.maxConsecutiveLosses}`}
        />
        <MetricCard
          label="Avg hold"
          value={fmtDuration(m.avgHoldMinutes)}
          hint={`exposure ${fmtPct(m.exposurePct, 1)} of period`}
        />
        <MetricCard
          label="Long / Short"
          value={`${m.longTrades} / ${m.shortTrades}`}
          hint={`win ${m.longWinRatePct != null ? fmtPct(m.longWinRatePct, 0) : '-'} / ${
            m.shortWinRatePct != null ? fmtPct(m.shortWinRatePct, 0) : '-'
          }`}
        />
        <MetricCard
          label="End-of-data exits"
          value={String(m.endOfDataExits)}
          hint="positions still open when data ends"
        />
      </div>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-200">Account Equity (mark-to-market)</CardTitle>
        </CardHeader>
        <CardContent>
          <EquityChart data={detail.equityCurve} startEquity={p.startingEquity} />
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-200">Drawdown from Peak</CardTitle>
        </CardHeader>
        <CardContent>
          <DrawdownChart data={detail.equityCurve} />
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-200">Price Series &amp; Trade Markers</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.priceSeries.length > 0 ? (
            <PriceChart
              series={detail.priceSeries}
              entries={entries}
              exitTp={exitTp}
              exitLiq={exitLiq}
              exitOther={exitOther}
            />
          ) : (
            <p className="py-8 text-center text-sm text-zinc-500">No price series stored for this range.</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
              <FlaskConical className="h-4 w-4 text-emerald-400" />
              Exit Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {exitRows.map((r) => (
              <div key={r.label} className="flex items-center gap-3">
                <span className="w-32 text-xs text-zinc-400">{r.label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={`h-full rounded-full ${r.cls}`}
                    style={{ width: `${m.totalTrades > 0 ? (r.count / m.totalTrades) * 100 : 0}%` }}
                  />
                </div>
                <span className="w-10 text-right font-mono text-xs text-zinc-300">{r.count}</span>
              </div>
            ))}
            <p className="pt-2 text-[11px] leading-relaxed text-zinc-500">
              {m.liquidations > 0
                ? 'Liquidations recorded here are real simulated margin failures - never discard them; they are the tail risk this research measures.'
                : 'No liquidations in this configuration - check drawdown and capital utilization before trusting the result.'}
            </p>
          </CardContent>
        </Card>

        <Card className="border-zinc-800 bg-zinc-900/60">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
              <ShieldAlert className="h-4 w-4 text-amber-400" />
              Recovery by DCA Depth
            </CardTitle>
          </CardHeader>
          <CardContent>
            {m.depthStats.length === 0 ? (
              <p className="py-4 text-center text-sm text-zinc-500">No trades in this run.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-zinc-800">
                    <TableHead className="text-xs text-zinc-500">Depth</TableHead>
                    <TableHead className="text-right text-xs text-zinc-500">Trades</TableHead>
                    <TableHead className="text-right text-xs text-zinc-500">TP</TableHead>
                    <TableHead className="text-right text-xs text-zinc-500">Liq</TableHead>
                    <TableHead className="text-right text-xs text-zinc-500">Other</TableHead>
                    <TableHead className="text-right text-xs text-zinc-500">P(TP|depth)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {m.depthStats.map((d) => (
                    <TableRow key={d.depth} className="border-zinc-800/60">
                      <TableCell className="font-mono text-xs text-zinc-200">{d.depth}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-zinc-300">{d.trades}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-emerald-400">{d.tp}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-rose-400">{d.liq}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-zinc-400">{d.other}</TableCell>
                      <TableCell
                        className={`text-right font-mono text-xs ${
                          d.pTpBeforeLiq != null && d.pTpBeforeLiq < 0.9 ? 'text-amber-400' : 'text-zinc-300'
                        }`}
                      >
                        {d.pTpBeforeLiq == null ? '-' : fmtPct(d.pTpBeforeLiq * 100, 1)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="pt-2 text-[11px] leading-relaxed text-zinc-500">
              P(TP before liquidation | DCA depth): deeper averaging layers should show materially
              different recovery probability - if they do not, the extra exposure is not being paid for.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-200">Risk &amp; Position Event Ledger</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.riskEvents.length === 0 ? (
            <p className="py-4 text-center text-sm text-zinc-500">No risk events recorded.</p>
          ) : (
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-zinc-700">
              {detail.riskEvents.map((e, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 rounded border border-zinc-800/60 bg-zinc-950/60 px-2.5 py-1.5"
                >
                  <span className="w-32 shrink-0 font-mono text-[10px] text-zinc-600">
                    {new Date(e.t).toISOString().slice(0, 16).replace('T', ' ')}
                  </span>
                  <span
                    className={`w-24 shrink-0 font-mono text-[10px] font-semibold uppercase ${riskTone(e.type)}`}
                  >
                    {e.type.replace('_', ' ')}
                  </span>
                  <span className="text-[11px] leading-snug text-zinc-400">{e.message}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-200">Run Configuration Snapshot</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-48 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-400 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-zinc-700">
            {JSON.stringify(p, null, 2)}
          </pre>
          <p className="mt-2 text-[11px] text-zinc-600">
            Every run stores its exact parameter snapshot so results stay reproducible across code
            and dataset changes.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
