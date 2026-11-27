import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { DATA_SOURCE_LABEL, getJob } from '@/lib/ingest';
import { DatasetInfo, INTERVAL_MS } from '@/lib/nprs/types';
import { probeArchive } from '@/lib/datasources/binance';
import { networkStats } from '@/lib/net/hosts';

export const dynamic = 'force-dynamic';

export async function GET() {
  const job = getJob();

  const [candleGroups, fundingGroups, archive] = await Promise.all([
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
    probeArchive(),
  ]);

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
