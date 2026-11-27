// Server-side parameter sanitization: clamps every field into a sane range.

import { DEFAULT_PARAMS } from './defaults';
import { getStrategy, STRATEGY_IDS } from './strategies';
import { Interval, StrategyParams } from './types';

import { INTERVALS } from './types';

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

/** Clamp a strategy's own params to their registered ranges, dropping unknown keys. */
function sanitizeSignalParams(
  strategyId: string,
  raw: unknown,
): Record<string, number> {
  const strategy = getStrategy(strategyId);
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const def of strategy.params) {
    out[def.key] = num(r[def.key], def.default, def.min, def.max);
  }
  return out;
}

export function sanitizeParams(raw: unknown): StrategyParams {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = DEFAULT_PARAMS;
  const strategyId = pick(r.strategyId, STRATEGY_IDS, d.strategyId ?? 'ema-trend');
  // Enforce a strictly increasing SAFE -> WARNING -> CRITICAL ladder: if the
  // client sends critical <= warning the state machine would jump straight to
  // CRITICAL and WARNING would become unreachable.
  let riskWarningRatio = num(r.riskWarningRatio, d.riskWarningRatio, 0.05, 1);
  let riskCriticalRatio = num(r.riskCriticalRatio, d.riskCriticalRatio, 0.1, 1);
  if (riskCriticalRatio <= riskWarningRatio) {
    riskCriticalRatio = Math.min(1, riskWarningRatio + 0.05);
    if (riskCriticalRatio <= riskWarningRatio) {
      // clamped at 1 - pull the warning threshold down instead
      riskWarningRatio = Math.max(0.05, riskCriticalRatio - 0.05);
    }
  }
  // The EMA pair must be strictly increasing: an inverted pair (fast >= slow)
  // silently inverts every trend rule below. Swap an inverted pair; split an
  // equal pair so fast is strictly below slow.
  let emaFast = Math.round(num(r.emaFast, d.emaFast, 2, 500));
  let emaSlow = Math.round(num(r.emaSlow, d.emaSlow, 3, 1000));
  if (emaFast > emaSlow) {
    const t = emaFast;
    emaFast = emaSlow;
    emaSlow = t;
  } else if (emaFast === emaSlow) {
    emaFast = Math.max(2, emaFast - 1);
  }
  return {
    strategyId,
    signalParams: sanitizeSignalParams(strategyId, r.signalParams),
    symbol:
      typeof r.symbol === 'string' && r.symbol.trim()
        ? r.symbol.trim().toUpperCase().slice(0, 20)
        : d.symbol,
    interval: pick<Interval>(r.interval, INTERVALS, d.interval),
    startingEquity: num(r.startingEquity, d.startingEquity, 100, 10_000_000),
    initialAllocPct: num(r.initialAllocPct, d.initialAllocPct, 0.1, 100),
    leverage: num(r.leverage, d.leverage, 1, 125),
    dcaAllocPct: num(r.dcaAllocPct, d.dcaAllocPct, 0.1, 100),
    maxDcaLayers: Math.round(num(r.maxDcaLayers, d.maxDcaLayers, 0, 50)),
    maxMarginPct: num(r.maxMarginPct, d.maxMarginPct, 1, 100),
    spacingMode: pick(r.spacingMode, ['fixed', 'atr'] as const, d.spacingMode),
    spacingPct: num(r.spacingPct, d.spacingPct, 0.05, 50),
    atrPeriod: Math.round(num(r.atrPeriod, d.atrPeriod, 2, 200)),
    atrMultiplier: num(r.atrMultiplier, d.atrMultiplier, 0.1, 20),
    emaFast,
    emaSlow,
    directionMode: pick(
      r.directionMode,
      ['both', 'long', 'short'] as const,
      d.directionMode,
    ),
    blockDcaOnFlip: bool(r.blockDcaOnFlip, d.blockDcaOnFlip),
    exitOnTrendFlip: bool(r.exitOnTrendFlip, d.exitOnTrendFlip),
    targetRoiPct: num(r.targetRoiPct, d.targetRoiPct, 0.1, 200),
    maxHoldHours: num(r.maxHoldHours, d.maxHoldHours, 0, 8760),
    forceCloseAtRisk: bool(r.forceCloseAtRisk, d.forceCloseAtRisk),
    riskWarningRatio,
    riskCriticalRatio,
    blockDcaOnWarning: bool(r.blockDcaOnWarning, d.blockDcaOnWarning),
    feeMakerPct: num(r.feeMakerPct, d.feeMakerPct, 0, 0.5),
    feeTakerPct: num(r.feeTakerPct, d.feeTakerPct, 0, 0.5),
    slippagePct: num(r.slippagePct, d.slippagePct, 0, 1),
    fundingMode: pick(
      r.fundingMode,
      ['historical', 'fixed'] as const,
      d.fundingMode,
    ),
    fixedFundingPctPer8h: num(r.fixedFundingPctPer8h, d.fixedFundingPctPer8h, -0.5, 0.5),
    mmrPct: num(r.mmrPct, d.mmrPct, 0.05, 10),
  };
}
