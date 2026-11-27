import {
  HostGate,
  HostPolicy,
  RateLimitError,
  RequestBudget,
  RequestBudgetExceeded,
  retryAfterMs,
} from '@/lib/net/throttle';

const policy = (over: Partial<HostPolicy> = {}): HostPolicy => ({
  name: 'test.host',
  minIntervalMs: 0,
  maxConcurrent: 2,
  maxAttempts: 3,
  backoffBaseMs: 5,
  backoffMaxMs: 20,
  cooldownMs: 40,
  banCooldownMs: 80,
  maxInRequestWaitMs: 1000,
  ...over,
});

const ok = () => new Response('ok', { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response('x', { status: code, headers });

let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('HostGate pacing', () => {
  it('spaces request starts by at least minIntervalMs', async () => {
    const gate = new HostGate(policy({ minIntervalMs: 60 }));
    const starts: number[] = [];
    fetchMock.mockImplementation(async () => {
      starts.push(Date.now());
      return ok();
    });
    for (let i = 0; i < 4; i++) await gate.fetch('https://host/a');
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(55);
    }
  });

  it('never has more than maxConcurrent requests in flight', async () => {
    const gate = new HostGate(policy({ maxConcurrent: 2 }));
    let inFlight = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return ok();
    });
    await Promise.all(Array.from({ length: 6 }, () => gate.fetch('https://host/a')));
    expect(peak).toBeLessThanOrEqual(2);
    expect(gate.stats.requests).toBe(6);
  });
});

describe('HostGate throttling', () => {
  it('honours Retry-After on 429, with the policy minimum as a floor', async () => {
    const gate = new HostGate(policy({ cooldownMs: 40 }));
    let calls = 0;
    fetchMock.mockImplementation(async () => (++calls === 1 ? status(429, { 'retry-after': '0' }) : ok()));
    const t0 = Date.now();
    const res = await gate.fetch('https://host/a');
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(gate.stats.throttled).toBe(1);
    expect(gate.stats.lastStatus).toBe(429);
  });

  it('stops after maxAttempts on a persistent ban, instead of hammering', async () => {
    const gate = new HostGate(policy({ maxAttempts: 2, banCooldownMs: 30 }));
    fetchMock.mockImplementation(async () => status(418, { 'retry-after': '0' }));
    await expect(gate.fetch('https://host/a')).rejects.toBeInstanceOf(RateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails fast without sending anything while the host is cooling down', async () => {
    const gate = new HostGate(policy({ maxAttempts: 1, banCooldownMs: 500 }));
    fetchMock.mockImplementation(async () => status(418));
    await expect(gate.fetch('https://host/a')).rejects.toBeInstanceOf(RateLimitError);
    const sent = fetchMock.mock.calls.length;
    await expect(gate.fetch('https://host/b')).rejects.toBeInstanceOf(RateLimitError);
    expect(fetchMock.mock.calls.length).toBe(sent);
    expect(gate.cooldownRemainingMs()).toBeGreaterThan(0);
  });

  it('fails at once, with the retry time, when the pause exceeds the in-request bound', async () => {
    const gate = new HostGate(policy({ maxInRequestWaitMs: 0, banCooldownMs: 120_000 }));
    fetchMock.mockImplementation(async () => status(418, { 'retry-after': '120' }));
    const err = await gate.fetch('https://host/a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 503 and then succeeds', async () => {
    const gate = new HostGate(policy());
    let calls = 0;
    fetchMock.mockImplementation(async () => (++calls === 1 ? status(503) : ok()));
    const res = await gate.fetch('https://host/a');
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('returns 404 to the caller without retrying (absence is not a throttle)', async () => {
    const gate = new HostGate(policy());
    fetchMock.mockImplementation(async () => status(404));
    const res = await gate.fetch('https://host/a');
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('RequestBudget', () => {
  it('refuses new downloads beyond its limit', () => {
    const budget = new RequestBudget(2);
    budget.consume();
    budget.consume();
    expect(() => budget.consume()).toThrow(RequestBudgetExceeded);
    expect(budget.remaining).toBe(0);
  });
});

describe('retryAfterMs', () => {
  it('parses seconds and HTTP dates, and returns null when absent', () => {
    expect(retryAfterMs(status(429, { 'retry-after': '7' }))).toBe(7000);
    const at = new Date(Date.now() + 5000).toUTCString();
    const ms = retryAfterMs(status(429, { 'retry-after': at }));
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5000);
    expect(retryAfterMs(status(429))).toBeNull();
  });
});
