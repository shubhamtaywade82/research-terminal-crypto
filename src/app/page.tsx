'use client';

// NPRS Research Terminal - main application shell.
// Tabs: Run (config + data), Results, Trades, Experiments, Research docs.

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { Loader2, Layers, Play, ShieldAlert, Zap } from 'lucide-react';
import { ConfigForm } from '@/components/nprs/config-form';
import { DataPanel, IngestRequest } from '@/components/nprs/data-panel';
import { ExperimentsPanel } from '@/components/nprs/experiments-panel';
import { ResultsPanel } from '@/components/nprs/results-panel';
import { StrategyLab } from '@/components/nprs/strategy-lab';
import { TradesTable } from '@/components/nprs/trades-table';
import ResearchPanel from '@/components/nprs/research-panel';
import { fmtPct, fmtSignedPct, fmtUsd } from '@/lib/format';
import { DEFAULT_PARAMS, PRESETS } from '@/lib/nprs/defaults';
import { getStrategy, STRATEGIES } from '@/lib/nprs/strategies';
import {
  CompareRow,
  DatasetInfo,
  IngestJobState,
  RunDetail,
  RunSummary,
  StrategyParams,
} from '@/lib/nprs/types';

type StatusPayload = { job: IngestJobState; datasets: DatasetInfo[] };

/** Pure fetchers: return data (or null on failure) and never touch React state. */
async function fetchStatusPayload(): Promise<StatusPayload | null> {
  try {
    const res = await fetch('/api/data/status');
    return res.ok ? ((await res.json()) as StatusPayload) : null;
  } catch {
    return null; // server momentarily unavailable; keep previous state
  }
}

async function fetchRunsPayload(): Promise<RunSummary[] | null> {
  try {
    const res = await fetch('/api/backtest');
    if (!res.ok) return null;
    return ((await res.json()) as { runs: RunSummary[] }).runs;
  } catch {
    return null;
  }
}

export default function Page() {
  const { toast } = useToast();

  // Tick is the default execution: exact order for fills, take-profit, liquidation and exits.
  const [params, setParams] = useState<StrategyParams>({ ...DEFAULT_PARAMS, intrabarMode: 'tick' });
  const [label, setLabel] = useState('');
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [job, setJob] = useState<IngestJobState | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [compareRows, setCompareRows] = useState<CompareRow[] | null>(null);
  const [tab, setTab] = useState('run');
  // UTC window (YYYY-MM-DD, end exclusive). Defaults to the last ten complete days of
  // the selected dataset, so tick runs work without typing dates; typed values win.
  const [windowFromOverride, setWindowFromOverride] = useState<string | null>(null);
  const [windowToOverride, setWindowToOverride] = useState<string | null>(null);
  const DAY_MS = 86_400_000;
  const selectedDataset = datasets.find((d) => d.symbol === params.symbol && d.interval === params.interval);
  // Start of the UTC day holding the last stored bar: that day is partial, so excluded.
  const defaultEnd = selectedDataset?.to != null ? Math.floor(selectedDataset.to / DAY_MS) * DAY_MS : null;
  const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const windowFrom = windowFromOverride ?? (defaultEnd !== null ? toDay(defaultEnd - 10 * DAY_MS) : '');
  const windowTo = windowToOverride ?? (defaultEnd !== null ? toDay(defaultEnd) : '');
  const setWindowFrom = (v: string) => setWindowFromOverride(v);
  const setWindowTo = (v: string) => setWindowToOverride(v);
  const windowMs = (day: string) => {
    const t = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(t) ? t : null;
  };
  const windowBounds = (() => {
    const from = windowFrom ? windowMs(windowFrom) : null;
    const to = windowTo ? windowMs(windowTo) : null;
    return from !== null && to !== null && to > from ? { from, to } : null;
  })();
  const needsWindow = params.intrabarMode === 'tick' && windowBounds === null;

  const refreshStatus = useCallback(async () => {
    const data = await fetchStatusPayload();
    if (data) {
      setJob(data.job);
      setDatasets(data.datasets);
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    const list = await fetchRunsPayload();
    if (list) setRuns(list);
    setRunsLoading(false);
  }, []);

  // Initial load. State is only set inside promise callbacks, and the cleanup
  // ignores responses that arrive after unmount.
  useEffect(() => {
    let active = true;
    void fetchStatusPayload().then((data) => {
      if (active && data) {
        setJob(data.job);
        setDatasets(data.datasets);
      }
    });
    void fetchRunsPayload().then((list) => {
      if (!active) return;
      if (list) setRuns(list);
      setRunsLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!job?.running) return;
    const iv = setInterval(() => void refreshStatus(), 1500);
    return () => clearInterval(iv);
  }, [job?.running, refreshStatus]);

  const loadDetail = useCallback(
    async (id: string, switchTab: boolean) => {
      setDetailLoading(true);
      try {
        const res = await fetch(`/api/backtest/${id}`);
        if (!res.ok) throw new Error('failed to load run');
        const data = (await res.json()) as RunDetail;
        setDetail(data);
        if (switchTab) setTab('results');
      } catch {
        toast({
          title: 'Could not load experiment',
          description: 'The run detail could not be fetched.',
          variant: 'destructive',
        });
      } finally {
        setDetailLoading(false);
      }
    },
    [toast],
  );

  const startIngest = useCallback(
    async (req: IngestRequest) => {
      try {
        const res = await fetch('/api/data/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
        });
        const data = (await res.json()) as { message?: string; job?: IngestJobState };
        if (!res.ok) {
          toast({
            title: 'Ingestion not started',
            description: data.message ?? 'Request failed',
            variant: 'destructive',
          });
          if (data.job) setJob(data.job);
          return;
        }
        setJob(data.job ?? null);
        toast({ title: 'Ingestion started', description: data.message });
        void refreshStatus();
      } catch {
        toast({
          title: 'Ingestion failed',
          description: 'The request could not be completed.',
          variant: 'destructive',
        });
      }
    },
    [refreshStatus, toast],
  );

  const runBacktest = useCallback(async () => {
    setRunning(true);
    try {
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...params,
          label: label.trim() || undefined,
          ...(windowBounds ? { windowFromMs: windowBounds.from, windowToMs: windowBounds.to } : {}),
        }),
      });
      const data = (await res.json()) as {
        id?: string;
        label?: string;
        trades?: number;
        metrics?: { totalReturnPct: number; liquidations: number };
        message?: string;
      };
      if (!res.ok || !data.id) {
        toast({
          title: 'Backtest failed',
          description: data.message ?? 'Unknown error',
          variant: 'destructive',
        });
        return;
      }
      toast({
        title: `Backtest complete: ${data.label ?? ''}`,
        description: `${data.trades ?? 0} trades - return ${fmtSignedPct(data.metrics?.totalReturnPct)} - liquidations ${data.metrics?.liquidations ?? 0}`,
      });
      await refreshRuns();
      await loadDetail(data.id, true);
    } catch {
      toast({
        title: 'Backtest failed',
        description: 'The request could not be completed.',
        variant: 'destructive',
      });
    } finally {
      setRunning(false);
    }
  }, [label, loadDetail, params, refreshRuns, toast, windowBounds]);

  const compareStrategies = useCallback(async () => {
    setComparing(true);
    try {
      // Tick runs one strategy at a time, so the comparison uses refined mode when tick is
      // selected (the same ordering where it matters, and it can compare all strategies).
      const compareMode = params.intrabarMode === 'tick' ? 'refined' : (params.intrabarMode ?? 'bar');
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...params,
          intrabarMode: compareMode,
          mode: 'compare',
          ...(windowBounds ? { windowFromMs: windowBounds.from, windowToMs: windowBounds.to } : {}),
        }),
      });
      const data = (await res.json()) as {
        results?: CompareRow[];
        message?: string;
      };
      if (!res.ok || !data.results) {
        toast({
          title: 'Comparison failed',
          description: data.message ?? 'Unknown error',
          variant: 'destructive',
        });
        return;
      }
      setCompareRows(data.results);
      const best = [...data.results].sort(
        (a, b) => b.metrics.totalReturnPct - a.metrics.totalReturnPct,
      )[0];
      const modeNote = params.intrabarMode === 'tick' ? ' (refined mode: tick runs one strategy at a time)' : '';
      toast({
        title: `Compared ${data.results.length} strategies on ${params.symbol} ${params.interval}${modeNote}`,
        description: best
          ? `Best return: ${best.name} ${fmtSignedPct(best.metrics.totalReturnPct, 1)}`
          : undefined,
      });
      await refreshRuns();
      setTab('lab');
    } catch {
      toast({
        title: 'Comparison failed',
        description: 'The request could not be completed.',
        variant: 'destructive',
      });
    } finally {
      setComparing(false);
    }
  }, [params, refreshRuns, toast, windowBounds]);

  const deleteRun = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/backtest/${id}`, { method: 'DELETE' });
        // 404 means it is already gone server-side, so drop it locally too.
        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
        setRuns((rs) => rs.filter((r) => r.id !== id));
        setDetail((d) => (d?.id === id ? null : d));
        toast({ title: 'Experiment deleted' });
      } catch {
        toast({
          title: 'Delete failed',
          description: 'Could not delete the experiment.',
          variant: 'destructive',
        });
      }
    },
    [toast],
  );

  const applyPreset = useCallback(
    (presetId: string) => {
      const preset = PRESETS.find((p) => p.id === presetId);
      if (!preset) return;
      setParams((prev) => ({
        ...DEFAULT_PARAMS,
        ...preset.patch,
        symbol: prev.symbol,
        interval: prev.interval,
        intrabarMode: prev.intrabarMode,
        startingEquity: prev.startingEquity,
        strategyId: prev.strategyId,
        signalParams: prev.signalParams,
      }));
      toast({ title: `Preset applied: ${preset.name}`, description: preset.description });
    },
    [toast],
  );

  const hasDataForSelection = datasets.some(
    (d) => d.symbol === params.symbol && d.interval === params.interval && d.candles >= 250,
  );

  const symbolChips = Array.from(new Set(datasets.map((d) => d.symbol)));

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10">
            <ShieldAlert className="h-5 w-5 text-emerald-400" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight text-zinc-100">
              NEMESIS Progressive Recovery Strategy - Research Terminal
            </h1>
            <p className="truncate text-[11px] text-zinc-500">
              NPRS v1 - 8 selectable entry strategies over one progressive-averaging engine -
              deterministic backtests on real Binance USDT-M public data (klines, mark price,
              funding)
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {symbolChips.length === 0 ? (
              <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-500">
                no datasets loaded
              </Badge>
            ) : (
              symbolChips.map((s) => {
                const info = datasets.find((d) => d.symbol === s);
                return (
                  <Badge
                    key={s}
                    variant="outline"
                    className="border-emerald-500/30 bg-emerald-500/5 font-mono text-[10px] text-emerald-400"
                  >
                    {s} {info ? `${info.candles.toLocaleString('en-US')}c` : ''}
                  </Badge>
                );
              })
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex flex-wrap border-zinc-800 bg-zinc-900/60">
            <TabsTrigger value="run" className="text-xs">Run</TabsTrigger>
            <TabsTrigger value="results" className="text-xs">Results</TabsTrigger>
            <TabsTrigger value="trades" className="text-xs">Trades</TabsTrigger>
            <TabsTrigger value="lab" className="text-xs">Strategy Lab</TabsTrigger>
            <TabsTrigger value="experiments" className="text-xs">Experiments</TabsTrigger>
            <TabsTrigger value="research" className="text-xs">Research</TabsTrigger>
          </TabsList>

          <TabsContent value="run" className="mt-4">
            <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
              <div className="min-w-0 space-y-4">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Zap className="h-4 w-4 text-amber-400" />
                    <p className="text-xs font-medium text-zinc-300">Experiment presets</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {PRESETS.map((p) => (
                      <Button
                        key={p.id}
                        variant="outline"
                        size="sm"
                        className="h-7 border-zinc-700 px-2 text-[11px] text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-400"
                        onClick={() => applyPreset(p.id)}
                      >
                        {p.name}
                      </Button>
                    ))}
                  </div>
                </div>

                <ConfigForm params={params} onChange={setParams} disabled={running} />

                <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs text-zinc-400">Window from (UTC)</Label>
                      <Input
                        type="date"
                        className="h-8 border-zinc-800 bg-zinc-950 font-mono text-sm"
                        value={windowFrom}
                        onChange={(e) => setWindowFrom(e.target.value)}
                        disabled={running}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-zinc-400">Window to (exclusive)</Label>
                      <Input
                        type="date"
                        className="h-8 border-zinc-800 bg-zinc-950 font-mono text-sm"
                        value={windowTo}
                        onChange={(e) => setWindowTo(e.target.value)}
                        disabled={running}
                      />
                    </div>
                  </div>
                  <p className="text-[11px] leading-snug text-zinc-500">
                    Defaults to the last ten complete days of the selected dataset. Tick runs up to 366 days.
                    Days not cached yet are downloaded at a paced rate, at most 60 per request; cached
                    days are free, so long windows fill up over several runs.
                  </p>
                  <Label className="text-xs text-zinc-400">Experiment label (optional)</Label>
                  <Input
                    className="h-8 border-zinc-800 bg-zinc-950 font-mono text-sm"
                    placeholder="auto: symbol tf lev spacing"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    disabled={running}
                  />
                  <Button
                    className="w-full bg-emerald-600 font-semibold text-zinc-950 hover:bg-emerald-500"
                    disabled={running || comparing || job?.running === true || needsWindow}
                    onClick={() => void runBacktest()}
                  >
                    {running ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Running backtest...
                      </>
                    ) : (
                      <>
                        <Play className="mr-2 h-4 w-4" />
                        Run Backtest
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full border-emerald-600/40 text-xs font-semibold text-emerald-400 hover:border-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-300"
                    disabled={running || comparing || job?.running === true}
                    onClick={() => void compareStrategies()}
                  >
                    {comparing ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Comparing {STRATEGIES.length} strategies...
                      </>
                    ) : (
                      <>
                        <Layers className="mr-2 h-4 w-4" />
                        Compare all strategies
                      </>
                    )}
                  </Button>
                  {!hasDataForSelection ? (
                    <p className="text-[11px] leading-snug text-amber-400/80">
                      No dataset stored yet for {params.symbol} {params.interval}. Ingest data on
                      the right first.
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0 space-y-4">
                <DataPanel datasets={datasets} job={job} onIngest={(req) => void startIngest(req)} />
                {runs.length > 0 ? (
                  <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                    <p className="mb-2 text-xs font-medium text-zinc-300">Recent experiments</p>
                    <div className="space-y-1.5">
                      {runs.slice(0, 5).map((r) => (
                        <button
                          key={r.id}
                          className="flex w-full flex-wrap items-center gap-2 rounded border border-zinc-800/60 bg-zinc-950/60 px-2.5 py-1.5 text-left hover:border-emerald-500/30"
                          onClick={() => void loadDetail(r.id, true)}
                        >
                          <span className="max-w-48 truncate font-mono text-[11px] text-zinc-200">
                            {r.label}
                          </span>
                          {r.strategyId ? (
                            <Badge
                              variant="outline"
                              className="border-emerald-500/30 bg-emerald-500/5 px-1.5 text-[9px] uppercase tracking-wide text-emerald-400"
                            >
                              {getStrategy(r.strategyId).name}
                            </Badge>
                          ) : null}
                          <span className={`font-mono text-[11px] ${r.totalReturnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {fmtSignedPct(r.totalReturnPct, 1)}
                          </span>
                          <span className="font-mono text-[11px] text-zinc-500">
                            {fmtUsd(r.finalEquity, 0)}
                          </span>
                          {r.liquidations > 0 ? (
                            <span className="font-mono text-[11px] text-rose-400">
                              {r.liquidations} liq
                            </span>
                          ) : null}
                          <span className="ml-auto font-mono text-[10px] text-zinc-600">
                            P(TP no-liq) {r.pTpBeforeLiq == null ? '-' : fmtPct(r.pTpBeforeLiq * 100, 0)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="results" className="mt-4">
            <ResultsPanel detail={detail} loading={detailLoading} />
          </TabsContent>

          <TabsContent value="trades" className="mt-4">
            {detail ? (
              <TradesTable trades={detail.trades} />
            ) : (
              <p className="py-16 text-center text-sm text-zinc-500">
                No experiment loaded. Run or open one first.
              </p>
            )}
          </TabsContent>

          <TabsContent value="lab" className="mt-4">
            <StrategyLab
              rows={compareRows}
              loading={comparing}
              onOpen={(id) => void loadDetail(id, true)}
              onCompare={() => void compareStrategies()}
              hasData={hasDataForSelection}
              configSummary={`${params.symbol} ${params.interval} - lev ${params.leverage}x - ${
                params.spacingMode === 'fixed'
                  ? `${params.spacingPct}% grid`
                  : `ATR x${params.atrMultiplier} grid`
              } - TP ${params.targetRoiPct}% net ROI - max ${params.maxDcaLayers} DCA layers - ${
                params.directionMode === 'both'
                  ? 'long+short'
                  : params.directionMode === 'long'
                    ? 'long only'
                    : 'short only'
              }`}
            />
          </TabsContent>

          <TabsContent value="experiments" className="mt-4">
            <ExperimentsPanel
              runs={runs}
              loading={runsLoading}
              selectedId={detail?.id ?? null}
              onView={(id) => void loadDetail(id, true)}
              onDelete={(id) => void deleteRun(id)}
            />
          </TabsContent>

          <TabsContent value="research" className="mt-4">
            <ResearchPanel />
          </TabsContent>
        </Tabs>
      </main>

      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-3 text-[11px] text-zinc-600">
          <span>
            NPRS v1 research terminal - historical simulation with documented simplifications.
            Not financial advice; leveraged futures can lose all deployed capital.
          </span>
          <span className="font-mono">
            P(TP before liquidation){' '}
            {detail ? (detail.metrics.pTpBeforeLiq == null ? '-' : fmtPct(detail.metrics.pTpBeforeLiq * 100, 1)) : '-'}
          </span>
        </div>
      </footer>
    </div>
  );
}
