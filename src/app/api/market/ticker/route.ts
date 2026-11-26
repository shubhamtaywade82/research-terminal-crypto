import { NextResponse } from 'next/server';
import { fetchSpotTickers } from '@/lib/datasources/binance';
import { SYMBOLS } from '@/lib/nprs/defaults';

export const dynamic = 'force-dynamic';

// Live 24h statistics straight from the Binance spot REST API
// (data-api.binance.vision - the futures REST domain is not reachable from
// this environment, so the live strip quotes the spot market, which the
// perpetual tracks within basis noise).
export async function GET() {
  try {
    const tickers = await fetchSpotTickers(SYMBOLS);
    return NextResponse.json({
      tickers,
      source: 'data-api.binance.vision',
      fetchedAt: Date.now(),
    });
  } catch (e) {
    return NextResponse.json(
      {
        tickers: [],
        message: e instanceof Error ? e.message : 'ticker request failed',
      },
      { status: 502 },
    );
  }
}
