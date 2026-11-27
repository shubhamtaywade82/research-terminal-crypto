// Host policies and the shared gates. Every outbound request in the app goes through
// one of these gates, so the limits hold across routes, tabs and runs.
//
//  - archive: data.binance.vision (static file archive: klines, mark klines, funding,
//    aggTrades). Paced at most 4 requests per second, two in flight, and every
//    throttle (429 / 503) pauses the host for at least 60 s.
//  - spot:    data-api.binance.vision REST (live ticker strip). One request per second,
//    one in flight. An IP ban (418) pauses the host for at least 2 minutes, which is the
//    shortest ban Binance documents.
//
// The values are deliberately conservative. Binance does not publish the archive's
// throttling rules, so the policy is "back off hard on the first signal".

import { HostGate, HostPolicy } from './throttle';

export const ARCHIVE_POLICY: HostPolicy = {
  name: 'data.binance.vision',
  minIntervalMs: 250,
  maxConcurrent: 2,
  maxAttempts: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  cooldownMs: 60_000,
  banCooldownMs: 120_000,
  maxInRequestWaitMs: 10_000,
};

export const SPOT_POLICY: HostPolicy = {
  name: 'data-api.binance.vision',
  minIntervalMs: 1_000,
  maxConcurrent: 1,
  maxAttempts: 2,
  backoffBaseMs: 2_000,
  backoffMaxMs: 60_000,
  cooldownMs: 60_000,
  banCooldownMs: 120_000,
  // The ticker is a convenience: a throttle is reported at once, never waited out.
  maxInRequestWaitMs: 0,
};

/** Shared across the whole server process (module singletons). */
const g = globalThis as unknown as { __nprsGates?: { archive: HostGate; spot: HostGate } };
if (!g.__nprsGates) {
  g.__nprsGates = { archive: new HostGate(ARCHIVE_POLICY), spot: new HostGate(SPOT_POLICY) };
}
export const archiveGate: HostGate = g.__nprsGates.archive;
export const spotGate: HostGate = g.__nprsGates.spot;

/** Counters for the status endpoint and for verifying the rate behaviour. */
export function networkStats() {
  const view = (gate: HostGate) => ({
    host: gate.policy.name,
    ...gate.stats,
    cooldownRemainingMs: gate.cooldownRemainingMs(),
  });
  return { archive: view(archiveGate), spot: view(spotGate) };
}

/** Per-request budget for new archive downloads. Cache hits never consume it. */
export const DEFAULT_DOWNLOADS_PER_REQUEST = Math.max(
  1,
  Number(process.env.NPRS_MAX_DOWNLOADS_PER_REQUEST) || 60,
);
