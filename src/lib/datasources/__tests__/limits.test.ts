import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { RateLimitError, RequestBudget, RequestBudgetExceeded } from '@/lib/net/throttle';

// Module-level cache root and gates: set up before the modules load.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nprs-limits-'));
process.env.NPRS_ROOT = root;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const agg = require('@/lib/datasources/aggtrades') as typeof import('@/lib/datasources/aggtrades');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bin = require('@/lib/datasources/binance') as typeof import('@/lib/datasources/binance');

const DAY = 86_400_000;
const D0 = Date.UTC(2025, 0, 1);
const dayKey = (d: number) => new Date(d).toISOString().slice(0, 10);

/** One-row aggTrades zip for the given UTC day. */
function dayZip(dayStart: number): Uint8Array {
  const csv = `agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker\n1,100,1,1,1,${dayStart + 1000},true\n`;
  return zipSync({ 'day.csv': strToU8(csv) });
}

let fetchCalls: string[] = [];
beforeEach(() => {
  fetchCalls = [];
  fs.rmSync(path.join(root, '.cache'), { recursive: true, force: true });
  global.fetch = jest.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push(url);
    const m = /aggTrades-(\d{4}-\d{2}-\d{2})\.zip$/.exec(url);
    if (m) {
      const start = Date.parse(`${m[1]}T00:00:00Z`);
      return new Response(Uint8Array.from(dayZip(start)), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

describe('aggTrades download budget', () => {
  it('refuses a window whose uncached days exceed the budget, and downloads nothing extra', async () => {
    const src = agg.createAggTradeSource('BTCUSDT', { budget: new RequestBudget(2) });
    await expect(src.window(D0, D0 + 3 * DAY)).rejects.toBeInstanceOf(RequestBudgetExceeded);
    const dayRequests = fetchCalls.filter((u) => u.includes('/daily/aggTrades/')).length;
    expect(dayRequests).toBe(2);
  });

  it('cache hits are free: a second window over cached days costs no budget', async () => {
    const budget = new RequestBudget(3);
    const src = agg.createAggTradeSource('BTCUSDT', { budget });
    const first = await src.window(D0, D0 + 3 * DAY);
    expect(first!.t.length).toBe(3);
    expect(budget.remaining).toBe(0);
    // Budget is exhausted, but every day is now in memory or on disk.
    const again = await src.window(D0, D0 + 3 * DAY);
    expect(again!.t.length).toBe(3);
    expect(fetchCalls.filter((u) => u.includes('/daily/aggTrades/')).length).toBe(3);
  });

  it('reports which days still need downloading, without downloading them', async () => {
    const src = agg.createAggTradeSource('BTCUSDT', { budget: new RequestBudget(9) });
    await src.window(D0, D0 + DAY); // cache day 1 only
    const missing = await agg.uncachedAggTradeDays('BTCUSDT', D0, D0 + 3 * DAY);
    expect(missing).toEqual([dayKey(D0 + DAY), dayKey(D0 + 2 * DAY)]);
    expect(fetchCalls.filter((u) => u.includes('/daily/aggTrades/')).length).toBe(1);
  });
});

describe('archive probe cache', () => {
  it('probes the archive once per minute, however often the status endpoint is polled', async () => {
    const first = await bin.probeArchive();
    const second = await bin.probeArchive();
    const third = await bin.probeArchive();
    expect(first.ok && second.ok && third.ok).toBe(true);
    expect(fetchCalls.filter((u) => u.includes('prefix=')).length).toBe(1);
  });
});

describe('spot ticker cooldown', () => {
  it('a 418 ban is surfaced, and callers during the ban get no new request', async () => {
    global.fetch = jest.fn(async () => {
      fetchCalls.push('spot');
      return new Response('banned', { status: 418, headers: { 'retry-after': '120' } });
    }) as unknown as typeof fetch;
    await expect(bin.fetchSpotTickers(['BTCUSDT'])).rejects.toBeInstanceOf(RateLimitError);
    const sent = fetchCalls.length;
    await expect(bin.fetchSpotTickers(['ETHUSDT'])).rejects.toBeInstanceOf(RateLimitError);
    expect(fetchCalls.length).toBe(sent);
  });
});
