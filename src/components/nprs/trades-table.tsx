'use client';

// Trade ledger explorer: every closed position including liquidations.

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  fmtDateTime,
  fmtDuration,
  fmtPct,
  fmtPrice,
  fmtSignedPct,
  fmtSignedUsd,
  fmtUsd,
} from '@/lib/format';
import { TradeRecord } from '@/lib/nprs/types';

const reasonStyle: Record<string, string> = {
  TAKE_PROFIT: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  LIQUIDATION: 'border-rose-500/40 bg-rose-500/10 text-rose-400',
  MAX_HOLD: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  TREND_FLIP: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  EMERGENCY_RISK: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
  END_OF_DATA: 'border-zinc-600 bg-zinc-500/10 text-zinc-400',
};

function ReasonBadge({ reason }: { reason: string }) {
  const label = reason.replace('_', ' ');
  return (
    <Badge variant="outline" className={cn('whitespace-nowrap text-[10px]', reasonStyle[reason] ?? reasonStyle.END_OF_DATA)}>
      {label}
    </Badge>
  );
}

export function TradesTable({ trades }: { trades: TradeRecord[] }) {
  const wins = trades.filter((t) => t.netPnl > 0).length;
  const liqs = trades.filter((t) => t.exitReason === 'LIQUIDATION').length;

  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm text-zinc-200">Trade Ledger</CardTitle>
        <div className="flex gap-2 text-[11px] text-zinc-500">
          <span>{trades.length} trades</span>
          <span className="text-emerald-400">{wins} wins</span>
          <span className="text-zinc-400">{trades.length - wins} losses</span>
          {liqs > 0 ? <span className="text-rose-400">{liqs} liquidations</span> : null}
        </div>
      </CardHeader>
      <CardContent>
        {trades.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-500">No trades in this run.</p>
        ) : (
          <div className="max-h-[520px] overflow-auto rounded-md border border-zinc-800 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-zinc-700">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-zinc-900">
                <TableRow className="border-zinc-800 hover:bg-transparent">
                  <TableHead className="text-xs text-zinc-500">#</TableHead>
                  <TableHead className="text-xs text-zinc-500">Side</TableHead>
                  <TableHead className="text-xs text-zinc-500">Opened</TableHead>
                  <TableHead className="text-xs text-zinc-500">Closed</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Layers</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Avg entry</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Exit</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Margin</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Net PnL</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">ROI margin</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">MAE</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">MFE</TableHead>
                  <TableHead className="text-right text-xs text-zinc-500">Hold</TableHead>
                  <TableHead className="text-xs text-zinc-500">Exit reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trades.map((t) => (
                  <TableRow key={t.seq} className="border-zinc-800/60">
                    <TableCell className="font-mono text-[11px] text-zinc-500">{t.seq}</TableCell>
                    <TableCell>
                      <span className={cn('font-mono text-[11px] font-semibold', t.direction === 'LONG' ? 'text-emerald-400' : 'text-rose-400')}>
                        {t.direction}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-[10px] text-zinc-500">{fmtDateTime(t.openTime)}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-[10px] text-zinc-500">{fmtDateTime(t.closeTime)}</TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-zinc-300">{t.dcaLayers}</TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-zinc-300">{fmtPrice(t.avgEntry)}</TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-zinc-300">{fmtPrice(t.exitPrice)}</TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-zinc-400">{fmtUsd(t.marginDeployed, 0)}</TableCell>
                    <TableCell className={cn('text-right font-mono text-[11px]', t.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {fmtSignedUsd(t.netPnl)}
                    </TableCell>
                    <TableCell className={cn('text-right font-mono text-[11px]', t.roiOnMargin >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                      {fmtSignedPct(t.roiOnMargin, 1)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-amber-400/80">{fmtPct(t.maePct, 1)}</TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-zinc-400">{fmtPct(t.mfePct, 1)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-[11px] text-zinc-400">{fmtDuration(t.holdMinutes)}</TableCell>
                    <TableCell>
                      <ReasonBadge reason={t.exitReason} />
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
