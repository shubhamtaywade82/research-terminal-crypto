import { NextResponse } from 'next/server';
import { DATA_SOURCE_LABEL, getJob } from '@/lib/ingest';
import { DatasetInfo, INTERVAL_MS } from '@/lib/nprs/types';
import { probeArchive } from '@/lib/datasources/binance';
import { networkStats } from '@/lib/net/hosts';
import { currentDatasetVersion } from '@/lib/datasets-version';
import { storeCoverage, type StoreCoverage } from '@/lib/store/store-pool';

export const dynamic = 'force-dynamic';

/**
 * Dataset coverage is an aggregate over every stored candle (about 0.5 s at 2 million rows).
 * It runs on the store worker, so the aggregate never blocks the server thread. The result
 * is cached until a dataset write commits (version bump), with a 15 s backstop, and
 * concurrent polls share one query.
 */
type Groups = StoreCoverage;
let groupsMemo: { version: number; at: number; value: Groups } | null = null;
let groupsInflight: Promise<Groups> | null = null;
const GROUPS_TTL_MS = 15_000;

function cachedGroups(): Promise<Groups> {
  const version = currentDatasetVersion();
  if (groupsMemo && groupsMemo.version === version && Date.now() - groupsMemo.at < GROUPS_TTL_MS) {
    return Promise.resolve(groupsMemo.value);
  }
  if (!groupsInflight) {
    groupsInflight = storeCoverage()
      .then((value) => {
        groupsMemo = { version, at: Date.now(), value };
        return value;
      })
      .finally(() => {
        groupsInflight = null;
      });
  }
  return groupsInflight;
}

export async function GET() {
  const job = getJob();
  const [{ candles, funding }, archive] = await Promise.all([cachedGroups(), probeArchive()]);

  const fundingMap = new Map(funding.map((f) => [f.symbol, f.count] as const));
  const markMap = new Map(
    candles
      .filter((g) => g.kind === 'mark')
      .map((g) => [`${g.symbol}|${g.interval}`, g.count] as const),
  );

  const datasets: DatasetInfo[] = candles
    .filter((g) => g.kind === 'last')
    .map((g) => {
      const from = g.fromMs;
      const to = g.toMs;
      const stepMs = INTERVAL_MS[g.interval as keyof typeof INTERVAL_MS];
      const expected =
        from != null && to != null && stepMs ? Math.floor((to - from) / stepMs) + 1 : null;
      return {
        symbol: g.symbol,
        interval: g.interval,
        candles: g.count,
        markCandles: markMap.get(`${g.symbol}|${g.interval}`) ?? 0,
        from,
        to,
        fundingEvents: fundingMap.get(g.symbol) ?? 0,
        coveragePct:
          expected && expected > 0
            ? Math.min(100, (g.count / expected) * 100)
            : null,
      };
    })
    .sort(
      (a, b) =>
        a.symbol.localeCompare(b.symbol) || a.interval.localeCompare(b.interval),
    );

  return NextResponse.json({
    job,
    datasets,
    source: DATA_SOURCE_LABEL,
    archive: { ok: archive.ok, detail: archive.detail, host: 'data.binance.vision' },
    network: networkStats(),
  });
}
