import { NextResponse } from 'next/server';
import { getJob, startIngest, SYMBOLS } from '@/lib/ingest';
import { INTERVAL_MAX_YEARS, INTERVALS, Interval } from '@/lib/nprs/types';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ message: 'Request body must be a JSON object' }, { status: 400 });
  }

  // Reject unknown values instead of silently substituting a default: a typo
  // such as "BTCUSDTT" must not start a four-symbol download.
  const symbol = body.symbol ?? 'ALL';
  if (symbol !== 'ALL' && !(typeof symbol === 'string' && SYMBOLS.includes(symbol))) {
    return NextResponse.json(
      { message: `symbol must be ALL or one of ${SYMBOLS.join(', ')}` },
      { status: 400 },
    );
  }

  const interval = body.interval ?? '1h';
  if (!(typeof interval === 'string' && INTERVALS.includes(interval as Interval))) {
    return NextResponse.json(
      { message: `interval must be one of ${INTERVALS.join(', ')}` },
      { status: 400 },
    );
  }

  const years = body.years ?? 3;
  const requested = typeof years === 'number' ? years : Number(years);
  if (!Number.isFinite(requested) || requested <= 0) {
    return NextResponse.json({ message: 'years must be a positive number' }, { status: 400 });
  }
  const clampedYears = Math.min(INTERVAL_MAX_YEARS[interval as Interval], Math.max(0.1, requested));

  const res = await startIngest({
    symbol: symbol as string,
    interval: interval as Interval,
    years: clampedYears,
  });
  if (!res.started) {
    return NextResponse.json({ message: res.message, job: getJob() }, { status: 409 });
  }
  return NextResponse.json({
    message: res.message,
    job: getJob(),
    effectiveYears: clampedYears,
  });
}
