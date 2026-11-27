// Outbound request gate for every external host the app talks to.
//
// Goals, in order: never trigger a rate limit or an IP ban; never hammer a host that
// is already refusing us; never hide a throttle from the operator.
//
// Per host it enforces:
//   - spacing between request STARTS (minIntervalMs), serialised;
//   - a concurrency cap (maxConcurrent in flight);
//   - a cooldown after 418 / 429 / 503: the whole host pauses, honouring Retry-After;
//   - a bounded number of attempts per call (no unbounded retry loops);
//   - counters (requests, throttle responses, errors) for the status endpoint.
//
// A RequestBudget bounds how many NEW downloads one user request may cause. Cache hits
// do not consume budget, so repeated runs over cached data stay free.

export interface HostPolicy {
  name: string;
  /** Minimum gap between the start of two requests to this host. */
  minIntervalMs: number;
  /** Requests allowed in flight at once. */
  maxConcurrent: number;
  /** Attempts per call before the error is surfaced (transport errors and throttles). */
  maxAttempts: number;
  /** Exponential backoff for transport errors: base * 2^(attempt-1), capped. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Cooldown after 429 / 503 without a Retry-After header. */
  cooldownMs: number;
  /** Cooldown after 418 (IP ban) without a Retry-After header. Binance bans start at 2 min. */
  banCooldownMs: number;
  /**
   * Longest pause a single request will sit through. Anything longer fails the call at
   * once with the retry time, so a user request or status poll never waits minutes.
   */
  maxInRequestWaitMs: number;
}

export class RateLimitError extends Error {
  constructor(
    readonly host: string,
    readonly status: number,
    readonly retryAfterMs: number,
  ) {
    super(`${host} is rate limiting us (HTTP ${status}); retry after ${Math.ceil(retryAfterMs / 1000)} s`);
    this.name = 'RateLimitError';
  }
}

export class RequestBudgetExceeded extends Error {
  constructor(readonly budget: number) {
    super(`this request would need more than ${budget} new downloads; run the window in smaller ranges (cached days are free)`);
    this.name = 'RequestBudgetExceeded';
  }
}

export interface GateStats {
  requests: number;
  throttled: number;
  errors: number;
  lastStatus: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** Retry-After in ms: integer seconds or an HTTP date. Null when absent or unparsable. */
export function retryAfterMs(res: Response, now = Date.now()): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export class HostGate {
  private lastStart = 0;
  private cooldownUntil = 0;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private startChain: Promise<void> = Promise.resolve();
  readonly stats: GateStats = { requests: 0, throttled: 0, errors: 0, lastStatus: 0 };

  constructor(readonly policy: HostPolicy) {}

  /** Milliseconds the host is currently cooling down for (0 when open). */
  cooldownRemainingMs(now = Date.now()): number {
    return Math.max(0, this.cooldownUntil - now);
  }

  private async acquire(): Promise<void> {
    if (this.active >= this.policy.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }

  /** Wait for spacing and cooldown. Starts are serialised so spacing holds under concurrency. */
  private pace(): Promise<void> {
    const run = this.startChain.then(async () => {
      const now = Date.now();
      const wait = Math.max(this.lastStart + this.policy.minIntervalMs - now, this.cooldownUntil - now, 0);
      if (wait > 0) await sleep(wait);
      this.lastStart = Date.now();
    });
    this.startChain = run.catch(() => undefined);
    return run;
  }

  private backoff(attempt: number): number {
    const exp = Math.min(this.policy.backoffMaxMs, this.policy.backoffBaseMs * 2 ** (attempt - 1));
    return Math.round(exp * (0.8 + Math.random() * 0.4));
  }

  /**
   * fetch() through the gate. Returns the final Response for any status that is not
   * a throttle or transient server error (so 404 stays the caller's business).
   * Throws RateLimitError when a throttle persists past maxAttempts.
   */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const host = this.policy.name;
    // Fail fast during a cooldown: queueing callers behind a ban would stall them silently.
    const remaining = this.cooldownRemainingMs();
    if (remaining > 0) throw new RateLimitError(host, this.stats.lastStatus, remaining);
    await this.acquire();
    try {
      for (let attempt = 1; ; attempt++) {
        await this.pace();
        this.stats.requests += 1;
        let res: Response;
        try {
          res = await fetch(url, init);
        } catch (e) {
          this.stats.errors += 1;
          if (attempt >= this.policy.maxAttempts) throw e;
          await sleep(this.backoff(attempt));
          continue;
        }

        if (res.status === 418 || res.status === 429 || res.status === 503) {
          this.stats.throttled += 1;
          this.stats.lastStatus = res.status;
          const header = retryAfterMs(res);
          // A bare 503 is a transient blip: back off for this call only. 418 and 429
          // are explicit limits: the whole host pauses. Retry-After is authoritative,
          // but never shorter than the policy minimum (Retry-After: 0 is not permission).
          const transient = res.status === 503 && header === null;
          const minimum = res.status === 418 ? this.policy.banCooldownMs : this.policy.cooldownMs;
          const pause = transient ? this.backoff(attempt) : Math.max(header ?? minimum, minimum);
          if (!transient) this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + pause);
          if (attempt >= this.policy.maxAttempts || pause > this.policy.maxInRequestWaitMs) {
            throw new RateLimitError(host, res.status, pause);
          }
          if (transient) await sleep(pause);
          continue; // pace() waits out any host cooldown before the next attempt
        }

        if (res.status >= 500 && res.status !== 503) {
          this.stats.errors += 1;
          this.stats.lastStatus = res.status;
          if (attempt >= this.policy.maxAttempts) return res;
          await sleep(this.backoff(attempt));
          continue;
        }
        return res;
      }
    } finally {
      this.release();
    }
  }
}

/** Counts NEW downloads for one user request. Cache hits never call consume(). */
export class RequestBudget {
  private used = 0;
  constructor(readonly max: number) {}

  consume(): void {
    if (this.used >= this.max) throw new RequestBudgetExceeded(this.max);
    this.used += 1;
  }

  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }
}
