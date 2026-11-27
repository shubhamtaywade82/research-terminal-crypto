import { NextResponse } from 'next/server';
import { dbRead as db } from '@/lib/db-read';
import { DATA_SOURCE_LABEL, getJob } from '@/lib/ingest';
import { DatasetInfo, INTERVAL_MS } from '@/lib/nprs/types';
import { probeArchive } from '@/lib/datasources/binance';
import { networkStats } from '@/lib/net/hosts';
import { currentDatasetVersion } from '@/lib/datasets-version';

export const dynamic = 'force-dynamic';

/**
 * Dataset coverage is an aggregate over every stored candle (about 0.5 s at 2 million rows).
 * It is cached until a dataset write commits (version bump), with a 15 s backstop, and
 * concurrent polls share one query, so polling never adds aggregation load.
 */
async function computeGroups() {
  const [candleGroups, fundingGroups] = await Promise.all([
    db.candle.groupBy({
      by: ['symbol', 'interval', 'kind'],
      _count: { _all: true },
      _min: { openTime: true },
      _max: { openTime: true },
    }),
    db.fundingRate.groupBy({
      by: ['symbol'],
      _count: { _all: true },
    }),
  ]);
  return { candleGroups, fundingGroups };
}

type Groups = Awaited<ReturnType<typeof computeGroups>>;
let groupsMemo: { version: number; at: number; value: Groups } | null = null;
let groupsInflight: Promise<Groups> | null = null;
const GROUPS_TTL_MS = 15_000;

function cachedGroups(): Promise<Groups> {
  const version = currentDatasetVersion();
  if (groupsMemo && groupsMemo.version === version && Date.now() - groupsMemo.at < GROUPS_TTL_MS) {
    return Promise.resolve(groupsMemo.value);
  }
  if (!groupsInflight) {
    groupsInflight = computeGroups()
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
  const [{ candleGroups, fundingGroups }, archive] = await Promise.all([cachedGroups(), probeArchive()]);

  const fundingMap = new Map(
    fundingGroups.map((f) => [f.symbol, f._count._all] as const),
  );
  const markMap = new Map(
    candleGroups
      .filter((g) => g.kind === 'mark')
      .map((g) => [`${g.symbol}|${g.interval}`, g._count._all] as const),
  );

  const datasets: DatasetInfo[] = candleGroups
    .filter((g) => g.kind === 'last')
    .map((g) => {
      const from = g._min.openTime ? g._min.openTime.getTime() : null;
      const to = g._max.openTime ? g._max.openTime.getTime() : null;
      const stepMs = INTERVAL_MS[g.interval as keyof typeof INTERVAL_MS];
      const expected =
        from != null && to != null && stepMs ? Math.floor((to - from) / stepMs) + 1 : null;
      return {
        symbol: g.symbol,
        interval: g.interval,
        candles: g._count._all,
        markCandles: markMap.get(`${g.symbol}|${g.interval}`) ?? 0,
        from,
        to,
        fundingEvents: fundingMap.get(g.symbol) ?? 0,
        coveragePct:
          expected && expected > 0
            ? Math.min(100, (g._count._all / expected) * 100)
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
