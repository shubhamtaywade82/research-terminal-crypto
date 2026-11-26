'use client';

// Experiments comparison: every stored run with headline metrics, reproducible
// configuration, and actions to inspect or delete.

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
import { Eye, FlaskConical, Trash2 } from 'lucide-react';
import { fmtDateTime, fmtPct, fmtSignedPct, fmtUsd } from '@/lib/format';
import { getStrategy } from '@/lib/nprs/strategies';
import { RunSummary } from '@/lib/nprs/types';

interface ExperimentsPanelProps {
  runs: RunSummary[];
  loading: boolean;
  selectedId: string | null;
  onView: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ExperimentsPanel({ runs, loading, selectedId, onView, onDelete }: ExperimentsPanelProps) {
  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
          <FlaskConical className="h-4 w-4 text-emerald-400" />
          Experiment Registry
        </CardTitle>
        <span className="text-[11px] text-zinc-500">
          every run is stored - including failures and liquidations
        </span>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 bg-zinc-900" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-500">
            No experiments yet. Configure and run a backtest from the Run tab.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-zinc-800 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-zinc-700">
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-800 hover:bg-transparent">
                  <TableHead className="text-xs text-zinc-500">Experiment</TableHead>
                  <TableHead className="text-xs text-zinc-500">Market</TableHead>
                  <TableHead className="text-xs text-zinc-500">Strategy</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Trades</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Return</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Win rate</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">PF</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Max DD</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Liq</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">P(TP no-liq)</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Expect ROI</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Final equity</TableHead>
                  <TableHead className="text-xs text-zinc-500">Created</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow
                    key={r.id}
                    className={cn(
                      'border-zinc-800/60',
                      selectedId === r.id && 'bg-emerald-500/5',
                    )}
                  >
                    <TableCell className="max-w-52 truncate font-mono text-xs text-zinc-200" title={r.label}>
                      {r.label}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-300">
                          {r.symbol}
                        </Badge>
                        <Badge variant="outline" className="border-zinc-700 font-mono text-[10px] text-zinc-400">
                          {r.interval}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      {r.strategyId ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/30 bg-emerald-500/5 text-[10px] text-emerald-400"
                        >
                          {getStrategy(r.strategyId).name}
                        </Badge>
                      ) : (
                        <span className="text-[10px] text-zinc-600">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-zinc-300">{r.totalTrades}</TableCell>
                    <TableCell className={cn('text-right font-mono text-xs', r.totalReturnPct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {fmtSignedPct(r.totalReturnPct, 1)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-zinc-300">{fmtPct(r.winRatePct, 1)}</TableCell>
                    <TableCell className="text-right font-mono text-xs text-zinc-300">
                      {r.profitFactor == null ? 'n/l' : r.profitFactor.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-amber-400">{fmtPct(r.maxDrawdownPct, 1)}</TableCell>
                    <TableCell className={cn('text-right font-mono text-xs', r.liquidations > 0 ? 'text-rose-400' : 'text-zinc-500')}>
                      {r.liquidations}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-zinc-300">
                      {r.pTpBeforeLiq == null ? '-' : fmtPct(r.pTpBeforeLiq * 100, 1)}
                    </TableCell>
                    <TableCell className={cn('text-right font-mono text-xs', r.expectancyRoiPct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {fmtSignedPct(r.expectancyRoiPct, 2)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-zinc-300">{fmtUsd(r.finalEquity, 0)}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-[10px] text-zinc-500">{fmtDateTime(r.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-zinc-400 hover:bg-zinc-800 hover:text-emerald-400"
                          onClick={() => onView(r.id)}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-zinc-400 hover:bg-zinc-800 hover:text-rose-400"
                          onClick={() => onDelete(r.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
