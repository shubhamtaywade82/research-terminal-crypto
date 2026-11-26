import { NextResponse } from 'next/server';
import { getJob, startIngest, SYMBOLS } from '@/lib/ingest';
import { Interval } from '@/lib/nprs/types';

const INTERVALS: Interval[] = ['5m', '15m', '1h', '4h', '1d'];

function maxYearsFor(interval: string): number {
  if (interval === '5m') return 0.25;
  if (interval === '15m') return 1;
  return 5;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  // All data now comes from real Binance public endpoints (USDT-M archive).
  const symbol =
    typeof body.symbol === 'string' &&
    (body.symbol === 'ALL' || SYMBOLS.includes(body.symbol))
      ? body.symbol
      : 'ALL';
  const interval: Interval =
    typeof body.interval === 'string' && INTERVALS.includes(body.interval as Interval)
      ? (body.interval as Interval)
      : '1h';
  const requested = Number(body.years);
  const years = Math.min(
    maxYearsFor(interval),
    Math.max(0.1, Number.isFinite(requested) && requested > 0 ? requested : 3),
  );

  const res = await startIngest({ symbol, interval, years });
  if (!res.started) {
    return NextResponse.json({ message: res.message, job: getJob() }, { status: 409 });
  }
  return NextResponse.json({ message: res.message, job: getJob() });
}
