'use client';

// Strategy Lab: run every registered entry strategy on the SAME dataset with
// the SAME DCA / risk / cost configuration and compare outcomes side by side.
// Only the entry signal varies - which is exactly the controlled variable the
// NPRS research isolates.

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { cn } from '@/lib/utils';
import { Eye, FlaskConical, Loader2, Play, Trophy } from 'lucide-react';
import { fmtPct, fmtSignedPct } from '@/lib/format';
import { CompareRow } from '@/lib/nprs/types';

interface StrategyLabProps {
  rows: CompareRow[] | null;
  loading: boolean;
  onOpen: (id: string) => void;
  onCompare: () => void;
  /** true when a dataset for the current selection exists */
  hasData: boolean;
  configSummary: string;
}

type SortKey = 'totalReturnPct' | 'pTpBeforeLiq' | 'profitFactor' | 'maxDrawdownPct';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'totalReturnPct', label: 'Return' },
  { key: 'pTpBeforeLiq', label: 'P(TP<liq)' },
  { key: 'profitFactor', label: 'Profit factor' },
  { key: 'maxDrawdownPct', label: 'Lowest DD' },
];

function sortValue(r: CompareRow, key: SortKey): number {
  const m = r.metrics;
  switch (key) {
    case 'totalReturnPct':
      return m.totalReturnPct;
    case 'pTpBeforeLiq':
      return m.pTpBeforeLiq ?? -1;
    case 'profitFactor':
      return m.profitFactor ?? 99;
    case 'maxDrawdownPct':
      return -m.maxDrawdownPct; // ascending drawdown = "lowest DD" first
  }
}

export function StrategyLab({
  rows,
  loading,
  onOpen,
  onCompare,
  hasData,
  configSummary,
}: StrategyLabProps) {
  const [sortKey, setSortKey] = useState<SortKey>('totalReturnPct');

  const sorted = useMemo(() => {
    if (!rows) return [];
    return [...rows].sort((a, b) => sortValue(b, sortKey) - sortValue(a, sortKey));
  }, [rows, sortKey]);

  const maxAbsReturn = useMemo(
    () =>
      rows
        ? Math.max(1, ...rows.map((r) => Math.abs(r.metrics.totalReturnPct)))
        : 1,
    [rows],
  );

  const bestId = sorted.length > 0 ? sorted[0].id : null;

  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader className="flex flex-col gap-3 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
            <FlaskConical className="h-4 w-4 text-emerald-400" />
            Strategy Lab - all entry signals on the same dataset
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            className="h-8 border-emerald-600/40 text-xs text-emerald-400 hover:border-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-300"
            disabled={loading || !hasData}
            onClick={onCompare}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Running 8 strategies...
              </>
            ) : (
              <>
                <Play className="mr-2 h-3.5 w-3.5" />
                Run comparison
              </>
            )}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] text-zinc-500">{configSummary}</span>
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[11px] text-zinc-500">rank by</span>
            {SORTS.map((s) => (
              <button
                key={s.key}
                className={cn(
                  'rounded border px-2 py-0.5 text-[11px] transition-colors',
                  sortKey === s.key
                    ? 'border-emerald-600/50 bg-emerald-500/10 text-emerald-400'
                    : 'border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200',
                )}
                onClick={() => setSortKey(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 bg-zinc-900" />
            ))}
          </div>
        ) : !rows || rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <FlaskConical className="h-10 w-10 text-zinc-600" />
            <div>
              <p className="text-sm font-medium text-zinc-300">No comparison yet</p>
              <p className="mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
                Run a comparison to backtest every entry strategy (EMA trend filter, EMA cross,
                EMA+RSI, MACD, Donchian, Supertrend, Bollinger, ROC) on the currently selected
                dataset with identical averaging, risk and cost settings.
              </p>
              {!hasData ? (
                <p className="mt-2 text-[11px] text-amber-400/80">
                  No dataset stored for the current symbol / timeframe - ingest data on the Run tab
                  first.
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-zinc-800 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-zinc-700">
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-800 hover:bg-transparent">
                  <TableHead className="text-xs text-zinc-500">#</TableHead>
                  <TableHead className="text-xs text-zinc-500">Strategy</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Trades</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">TP</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Liq</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Return</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Win rate</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">PF</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Max DD</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">P(TP no-liq)</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Exp ROI</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r, idx) => {
                  const m = r.metrics;
                  const barWidth = (Math.abs(m.totalReturnPct) / maxAbsReturn) * 100;
                  return (
                    <TableRow
                      key={r.id}
                      className={cn(
                        'cursor-pointer border-zinc-800/60 hover:bg-zinc-800/40',
                        bestId === r.id && 'bg-emerald-500/5',
                      )}
                      onClick={() => onOpen(r.id)}
                    >
                      <TableCell className="font-mono text-xs text-zinc-500">
                        {idx === 0 && sortKey === 'totalReturnPct' ? (
                          <Trophy className="h-3.5 w-3.5 text-amber-400" aria-label="best" />
                        ) : (
                          idx + 1
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-medium text-zinc-200">{r.name}</span>
                          <Badge
                            variant="outline"
                            className="border-zinc-700 px-1.5 text-[9px] uppercase tracking-wide text-zinc-500"
                          >
                            {r.category}
                          </Badge>
                          <Badge
                            variant="outline"
                            className="border-zinc-800 px-1.5 text-[9px] uppercase tracking-wide text-zinc-600"
                          >
                            {r.style}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-zinc-300">
                        {m.totalTrades}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-emerald-400">
                        {m.takeProfits}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right font-mono text-xs',
                          m.liquidations > 0 ? 'text-rose-400' : 'text-zinc-500',
                        )}
                      >
                        {m.liquidations}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-zinc-800 sm:block">
                            <div
                              className={cn(
                                'h-full rounded-full',
                                m.totalReturnPct >= 0 ? 'bg-emerald-500' : 'bg-rose-500',
                              )}
                              style={{ width: `${barWidth}%` }}
                            />
                          </div>
                          <span
                            className={cn(
                              'font-mono text-xs',
                              m.totalReturnPct >= 0 ? 'text-emerald-400' : 'text-rose-400',
                            )}
                          >
                            {fmtSignedPct(m.totalReturnPct, 1)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-zinc-300">
                        {fmtPct(m.winRatePct, 1)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-zinc-300">
                        {m.profitFactor == null ? 'n/l' : m.profitFactor.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-amber-400">
                        {fmtPct(m.maxDrawdownPct, 1)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-zinc-200">
                        {m.pTpBeforeLiq == null ? '-' : fmtPct(m.pTpBeforeLiq * 100, 1)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right font-mono text-xs',
                          m.expectancyRoiPct >= 0 ? 'text-emerald-400' : 'text-rose-400',
                        )}
                      >
                        {fmtSignedPct(m.expectancyRoiPct, 2)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-zinc-400 hover:bg-zinc-800 hover:text-emerald-400"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(r.id);
                          }}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
        {rows && rows.length > 0 ? (
          <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
            Every row is a fully stored experiment (click to inspect trades, equity curve and risk
            ledger). Identical dataset, leverage, DCA grid, fees and funding - only the entry signal
            differs, which is the controlled variable of this research.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
