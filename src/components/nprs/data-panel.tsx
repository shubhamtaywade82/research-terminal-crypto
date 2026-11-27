'use client';

// Dataset management panel: live Binance market strip, real-archive ingestion
// controls, job progress, coverage table.

import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Activity, Database, Loader2, Radio, TriangleAlert } from 'lucide-react';
import { fmtDate, fmtPrice, fmtSignedPct } from '@/lib/format';
import { SYMBOLS } from '@/lib/nprs/defaults';
import { DatasetInfo, INTERVAL_MAX_YEARS, INTERVALS, Interval, IngestJobState } from '@/lib/nprs/types';

export interface IngestRequest {
  symbol: string;
  interval: string;
  years: number;
}

interface DataPanelProps {
  datasets: DatasetInfo[];
  job: IngestJobState | null;
  onIngest: (req: IngestRequest) => void;
}

interface TickerRow {
  symbol: string;
  price: number;
  changePct: number;
  high: number;
  low: number;
  quoteVolumeUsd: number;
}

const YEAR_OPTIONS = [
  { value: '0.25', label: '3 months' },
  { value: '0.5', label: '6 months' },
  { value: '1', label: '1 year' },
  { value: '2', label: '2 years' },
  { value: '3', label: '3 years' },
  { value: '5', label: '5 years' },
];

function fmtCompactUsd(v: number): string {
  if (!Number.isFinite(v)) return '-';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

/** Live prices polled straight from the Binance spot REST API. */
function LiveTickerStrip() {
  const [tickers, setTickers] = useState<TickerRow[]>([]);
  const [live, setLive] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/market/ticker');
      if (!res.ok) {
        setLive(false);
        return;
      }
      const data = (await res.json()) as { tickers: TickerRow[] };
      setTickers(data.tickers ?? []);
      setLive((data.tickers ?? []).length > 0);
    } catch {
      setLive(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    const iv = setInterval(() => void load(), 30_000);
    return () => {
      clearTimeout(t);
      clearInterval(iv);
    };
  }, [load]);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/80 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Radio
            className={`h-3.5 w-3.5 ${live ? 'text-emerald-400' : 'text-zinc-600'}`}
          />
          <p className="text-[11px] font-medium text-zinc-400">
            Live Market{live ? '' : ' - connecting...'}
          </p>
        </div>
        <p className="font-mono text-[10px] text-zinc-600">
          Binance REST - data-api.binance.vision
        </p>
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {SYMBOLS.map((s) => {
          const t = tickers.find((r) => r.symbol === s);
          const up = (t?.changePct ?? 0) >= 0;
          return (
            <div
              key={s}
              className="rounded border border-zinc-800/70 bg-zinc-900/50 px-2 py-1.5"
            >
              <div className="flex items-center justify-between gap-1">
                <span className="font-mono text-[10px] text-zinc-400">{s}</span>
                {t ? (
                  <span
                    className={`font-mono text-[10px] ${up ? 'text-emerald-400' : 'text-rose-400'}`}
                  >
                    {fmtSignedPct(t.changePct, 2)}
                  </span>
                ) : null}
              </div>
              <p className="font-mono text-sm font-semibold text-zinc-100 tabular-nums">
                {t ? fmtPrice(t.price) : '...'}
              </p>
              <p className="font-mono text-[9px] text-zinc-600">
                {t ? `24h vol ${fmtCompactUsd(t.quoteVolumeUsd)}` : ''}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DataPanel({ datasets, job, onIngest }: DataPanelProps) {
  const [symbol, setSymbol] = useState<string>('ALL');
  const [interval, setIntervalChoice] = useState<string>('1h');
  const [years, setYears] = useState<string>('1');

  const running = job?.running === true;

  return (
    <div className="space-y-4">
      <LiveTickerStrip />

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm text-zinc-200">
            <Database className="h-4 w-4 text-emerald-400" />
            Historical Data Infrastructure
            <Badge
              variant="outline"
              className="ml-1 border-emerald-500/40 bg-emerald-500/10 font-mono text-[9px] text-emerald-400"
            >
              REAL BINANCE DATA
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-[11px] leading-relaxed text-zinc-400">
            <span className="font-medium text-zinc-300">Source:</span> Binance
            USDT-M perpetual public archive{' '}
            <span className="font-mono text-emerald-400/90">data.binance.vision</span>{' '}
            - real futures klines, real mark-price klines (liquidation series)
            and real settled funding rates, fetched as monthly/daily files over
            HTTPS and cached on disk.
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <p className="text-xs text-zinc-400">Symbols</p>
              <Select value={symbol} onValueChange={setSymbol} disabled={running}>
                <SelectTrigger className="h-8 border-zinc-800 bg-zinc-950 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  <SelectItem value="ALL" className="text-sm">
                    All (4 symbols)
                  </SelectItem>
                  {SYMBOLS.map((s) => (
                    <SelectItem key={s} value={s} className="text-sm">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-zinc-400">Interval</p>
              <Select
                value={interval}
                onValueChange={(v) => {
                  setIntervalChoice(v);
                  // keep the history selection valid for the new interval
                  const maxYears = INTERVAL_MAX_YEARS[v as Interval];
                  if (Number(years) > maxYears) setYears(String(maxYears));
                }}
                disabled={running}
              >
                <SelectTrigger className="h-8 border-zinc-800 bg-zinc-950 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  {INTERVALS.map((i) => (
                    <SelectItem key={i} value={i} className="text-sm">
                      {i}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-zinc-400">History</p>
              <Select value={years} onValueChange={setYears} disabled={running}>
                <SelectTrigger className="h-8 border-zinc-800 bg-zinc-950 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  {YEAR_OPTIONS.filter(
                    (y) => Number(y.value) <= INTERVAL_MAX_YEARS[interval as Interval],
                  ).map((y) => (
                    <SelectItem key={y.value} value={y.value} className="text-sm">
                      {y.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Button
            className="w-full bg-emerald-600 font-semibold text-zinc-950 hover:bg-emerald-500"
            disabled={running}
            onClick={() =>
              onIngest({ symbol, interval, years: Number(years) })
            }
          >
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Ingesting...
              </>
            ) : (
              <>
                <Activity className="mr-2 h-4 w-4" />
                Fetch Real Binance Data
              </>
            )}
          </Button>

          {running && job ? (
            <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950 p-3">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span className="max-w-72 truncate">{job.current}</span>
                <span className="font-mono">{Math.round(job.progress * 100)}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${Math.max(2, job.progress * 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between font-mono text-[10px] text-zinc-500">
                <span>
                  {job.filesDownloaded} downloaded / {job.filesCached} cached
                </span>
                <span>
                  {job.insertedCandles.toLocaleString('en-US')} candles /{' '}
                  {job.insertedFunding.toLocaleString('en-US')} funding
                </span>
              </div>
              <div className="max-h-32 overflow-y-auto rounded bg-zinc-950 font-mono text-[10px] leading-relaxed text-zinc-500 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-zinc-700">
                {job.log.slice(-14).map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            </div>
          ) : null}

          {job?.error ? (
            <Alert className="border-rose-500/30 bg-rose-500/10">
              <TriangleAlert className="h-4 w-4 text-rose-400" />
              <AlertTitle className="text-rose-400">Ingestion failed</AlertTitle>
              <AlertDescription className="text-rose-300/80">{job.error}</AlertDescription>
            </Alert>
          ) : null}

          <Alert className="border-emerald-500/25 bg-emerald-500/5">
            <Activity className="h-4 w-4 text-emerald-400" />
            <AlertTitle className="text-sm text-emerald-400">Data provenance</AlertTitle>
            <AlertDescription className="text-xs leading-relaxed text-emerald-200/70">
              Execution candles are real USDT-M perpetual OHLCV; liquidation is
              evaluated on the real mark-price klines Binance liquidates on;
              funding uses the actual settled rate per interval (8h/4h, joined
              with the mark price at settlement). Two archive realities are
              handled explicitly: (1) the futures REST domain (fapi.binance.com)
              is unreachable from this environment, so REST history is served by
              Binance&apos;s official public archive - same exchange, same data;
              (2) funding history is published monthly-only, so the newest
              month accrues no funding until its zip appears. Holes in monthly
              zips are detected and healed from daily files automatically.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-200">Dataset Coverage</CardTitle>
        </CardHeader>
        <CardContent>
          {datasets.length === 0 ? (
            <p className="py-6 text-center text-sm text-zinc-500">
              No datasets stored yet. Fetch real Binance data above.
            </p>
          ) : (
            <div className="max-h-64 overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-zinc-700">
              <Table>
                <TableHeader>
                  <TableRow className="border-zinc-800">
                    <TableHead className="text-xs text-zinc-500">Symbol</TableHead>
                    <TableHead className="text-xs text-zinc-500">TF</TableHead>
                    <TableHead className="text-right text-xs text-zinc-500">Candles</TableHead>
                    <TableHead className="text-right text-xs text-zinc-500">Mark</TableHead>
                    <TableHead className="text-right text-xs text-zinc-500">Coverage</TableHead>
                    <TableHead className="text-xs text-zinc-500">Range</TableHead>
                    <TableHead className="text-right text-xs text-zinc-500">Funding</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {datasets.map((d) => (
                    <TableRow key={`${d.symbol}-${d.interval}`} className="border-zinc-800/60">
                      <TableCell className="font-mono text-xs text-zinc-200">{d.symbol}</TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className="border-zinc-700 font-mono text-[10px] text-zinc-300"
                        >
                          {d.interval}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-zinc-300">
                        {d.candles.toLocaleString('en-US')}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {d.markCandles > 0 ? (
                          <span className="text-emerald-400/90">
                            {d.markCandles.toLocaleString('en-US')}
                          </span>
                        ) : (
                          <span className="text-zinc-600">-</span>
                        )}
                      </TableCell>
                      <TableCell
                        className="text-right font-mono text-xs"
                        title="stored bars vs the expected bar grid over the stored range"
                      >
                        {d.coveragePct == null ? (
                          <span className="text-zinc-600">-</span>
                        ) : (
                          <span
                            className={
                              d.coveragePct >= 99.5
                                ? 'text-emerald-400/90'
                                : d.coveragePct >= 97
                                  ? 'text-amber-400'
                                  : 'text-rose-400'
                            }
                          >
                            {d.coveragePct.toFixed(1)}%
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-zinc-500">
                        {d.from && d.to ? `${fmtDate(d.from)} - ${fmtDate(d.to)}` : '-'}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-zinc-300">
                        {d.fundingEvents > 0 ? d.fundingEvents.toLocaleString('en-US') : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
