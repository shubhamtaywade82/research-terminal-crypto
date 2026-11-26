import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type * as BinanceModule from '@/lib/datasources/binance';

// The archive client caches under NPRS_ROOT/.cache, so point it at a temp dir
// before the module loads. fetch is mocked: no network in these tests.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nprs-binance-'));
process.env.NPRS_ROOT = root;

let binance: typeof BinanceModule;
const H = 3_600_000;
const JAN = Date.UTC(2025, 0, 1);
const FEB_END = Date.UTC(2025, 1, 28, 23, 59, 59);

type Route = { status: number; body?: Uint8Array } | 'reject';
let routes: Record<string, Route[]> = {};

const KLINE_HEADER =
  'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore';

function klineCsv(fromMs: number, toMs: number, skipAt?: number): string {
  const rows = [KLINE_HEADER];
  for (let t = fromMs; t < toMs; t += H) {
    if (t === skipAt) continue;
    rows.push(`${t},100.00,101.00,99.00,100.50,5,${t + H - 1},0,1,0,0,0`);
  }
  return rows.join('\n');
}

function zipOf(csv: string): Uint8Array {
  return zipSync({ 'data.csv': strToU8(csv) });
}

function respond(url: string): Response {
  const path = new URL(url).pathname;
  const queue = routes[path];
  if (!queue || queue.length === 0) {
    return new Response(null, { status: 404 });
  }
  const next = queue.length > 1 ? queue.shift()! : queue[0];
  if (next === 'reject') throw new TypeError('fetch failed');
  const body = next.body ? Uint8Array.from(next.body) : new Uint8Array();
  return new Response(body, { status: next.status });
}

beforeAll(() => {
  // Loaded after NPRS_ROOT is set above; the module reads it at import time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  binance = require('@/lib/datasources/binance') as typeof BinanceModule;
});

beforeEach(() => {
  routes = {};
  fs.rmSync(path.join(root, '.cache'), { recursive: true, force: true });
  global.fetch = jest.fn(async (input: string | URL | Request) =>
    respond(typeof input === 'string' ? input : input.toString()),
  ) as unknown as typeof fetch;
});

const monthlyKlines = (ym: string) =>
  `/data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-${ym}.zip`;
const dailyKlines = (ymd: string) =>
  `/data/futures/um/daily/klines/BTCUSDT/1h/BTCUSDT-1h-${ymd}.zip`;

describe('fetchFuturesKlines', () => {
  it('merges monthly zips and heals a missing hour from the daily file', async () => {
    const febGap = Date.UTC(2025, 1, 10, 5);
    routes[monthlyKlines('2025-01')] = [
      { status: 200, body: zipOf(klineCsv(JAN, Date.UTC(2025, 1, 1))) },
    ];
    routes[monthlyKlines('2025-02')] = [
      { status: 200, body: zipOf(klineCsv(Date.UTC(2025, 1, 1), Date.UTC(2025, 2, 1), febGap)) },
    ];
    routes[dailyKlines('2025-02-10')] = [
      {
        status: 200,
        body: zipOf(klineCsv(Date.UTC(2025, 1, 10), Date.UTC(2025, 1, 11))),
      },
    ];
    const events: string[] = [];
    const rows = await binance.fetchFuturesKlines('BTCUSDT', '1h', JAN, FEB_END, 'last', {
      onFile: (file, status) => events.push(`${status}:${file}`),
    });

    expect(rows).toHaveLength(31 * 24 + 28 * 24);
    const gaps = rows.slice(1).filter((r, i) => r.openTime - rows[i].openTime !== H);
    expect(gaps).toHaveLength(0);
    expect(events.some((e) => e.startsWith('healed:'))).toBe(true);
  });

  it('treats a 404 as not published: the file is skipped, nothing throws', async () => {
    routes[monthlyKlines('2025-01')] = [{ status: 404 }];
    routes[monthlyKlines('2025-02')] = [
      { status: 200, body: zipOf(klineCsv(Date.UTC(2025, 1, 1), Date.UTC(2025, 2, 1))) },
    ];
    const events: string[] = [];
    const rows = await binance.fetchFuturesKlines('BTCUSDT', '1h', JAN, FEB_END, 'last', {
      onFile: (file, status) => events.push(`${status}:${file}`),
    });
    expect(rows).toHaveLength(28 * 24);
    expect(events).toContain('missing:BTCUSDT-1h-2025-01.zip');
  });

  it('retries a transient HTTP 500 and then succeeds', async () => {
    routes[monthlyKlines('2025-01')] = [
      { status: 500 },
      { status: 200, body: zipOf(klineCsv(JAN, Date.UTC(2025, 1, 1))) },
    ];
    routes[monthlyKlines('2025-02')] = [{ status: 404 }];
    const rows = await binance.fetchFuturesKlines('BTCUSDT', '1h', JAN, FEB_END);
    expect(rows).toHaveLength(31 * 24);
    const janCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([u]) => String(u).endsWith(monthlyKlines('2025-01')),
    );
    expect(janCalls).toHaveLength(2);
  }, 15_000);

  it('gives up after the retry budget on persistent network errors', async () => {
    routes[monthlyKlines('2025-01')] = ['reject'];
    routes[monthlyKlines('2025-02')] = [{ status: 404 }];
    await expect(binance.fetchFuturesKlines('BTCUSDT', '1h', JAN, FEB_END)).rejects.toThrow(
      'fetch failed',
    );
    const janCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([u]) => String(u).endsWith(monthlyKlines('2025-01')),
    );
    expect(janCalls).toHaveLength(3);
  }, 20_000);

  it('rejects path-injecting symbols before any request is made', async () => {
    await expect(
      binance.fetchFuturesKlines('../BTCUSDT', '1h', JAN, FEB_END),
    ).rejects.toThrow(/invalid symbol/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects unsupported intervals before any request is made', async () => {
    await expect(
      binance.fetchFuturesKlines('BTCUSDT', '2h' as never, JAN, FEB_END),
    ).rejects.toThrow(/unsupported interval/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('fetchFundingHistory', () => {
  it('normalises the few-millisecond calc_time offset to the funding hour', async () => {
    const csv = [
      'calc_time,funding_interval_hours,last_funding_rate',
      '1735689600015,8,0.00010000',
      '1735718400000,8,-0.00020000',
    ].join('\n');
    routes['/data/futures/um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-2025-01.zip'] = [
      { status: 200, body: zipOf(csv) },
    ];
    const rows = await binance.fetchFundingHistory('BTCUSDT', JAN, Date.UTC(2025, 0, 31, 23));
    expect(rows.map((r) => r.fundingTime)).toEqual([JAN, JAN + 8 * H]);
    expect(rows.map((r) => r.rate)).toEqual([0.0001, -0.0002]);
  });
});
