'use client';

// Strategy configuration form: every NPRS parameter from the research spec,
// grouped into research-relevant sections. The entry signal is selectable
// from the strategy registry; per-strategy params render dynamically.

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SYMBOL_MMR_PCT, SYMBOLS } from '@/lib/nprs/defaults';
import {
  defaultSignalParams,
  getStrategy,
  STRATEGIES,
} from '@/lib/nprs/strategies';
import { INTERVALS, Interval, StrategyParams } from '@/lib/nprs/types';

interface ConfigFormProps {
  params: StrategyParams;
  onChange: (p: StrategyParams) => void;
  disabled?: boolean;
}

function NumField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  hint?: string;
  disabled?: boolean;
}) {
  // Keep the raw text while typing so partial input ("", "2.", "25") is not
  // clamped on every keystroke. The clamped value is committed on blur/Enter.
  const [draft, setDraft] = useState(String(value));
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    // The committed value changed from outside (preset, strategy switch):
    // resync the draft during render instead of in an effect.
    setSynced(value);
    setDraft(String(value));
  }

  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <div className="space-y-1">
      <Label className="text-xs text-zinc-400">{label}</Label>
      <Input
        type="number"
        className="h-8 border-zinc-800 bg-zinc-950 font-mono text-sm"
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      {hint ? <p className="text-[10px] leading-snug text-zinc-600">{hint}</p> : null}
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-zinc-400">{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="h-8 border-zinc-800 bg-zinc-950 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="border-zinc-800 bg-zinc-900">
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-sm">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SwitchField({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <div>
        <Label className="text-xs text-zinc-400">{label}</Label>
        {hint ? <p className="mt-0.5 text-[10px] leading-snug text-zinc-600">{hint}</p> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

export function ConfigForm({ params, onChange, disabled }: ConfigFormProps) {
  const set = (patch: Partial<StrategyParams>) => onChange({ ...params, ...patch });

  const strategy = getStrategy(params.strategyId);
  const signalParams = params.signalParams ?? {};
  const setSignalParam = (key: string, v: number) =>
    set({ signalParams: { ...signalParams, [key]: v } });

  return (
    <div className="space-y-4">
      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-200">Entry Signal Strategy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <SelectField
            label="Strategy (select one)"
            value={strategy.id}
            options={STRATEGIES.map((s) => ({ value: s.id, label: `${s.name}` }))}
            onChange={(v) =>
              onChange({ ...params, strategyId: v, signalParams: defaultSignalParams(v) })
            }
            disabled={disabled}
          />
          <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-2.5">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <Badge
                variant="outline"
                className="border-emerald-500/30 bg-emerald-500/5 text-[10px] uppercase tracking-wide text-emerald-400"
              >
                {strategy.category}
              </Badge>
              <Badge
                variant="outline"
                className="border-zinc-700 text-[10px] uppercase tracking-wide text-zinc-400"
              >
                {strategy.style === 'state' ? 'state: re-enters while regime holds' : 'event: enters on the signal bar'}
              </Badge>
            </div>
            <p className="text-[11px] font-medium leading-snug text-zinc-300">{strategy.tagline}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{strategy.description}</p>
          </div>
          <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
            {strategy.usesEma ? (
              <>
                <NumField
                  label="EMA fast"
                  value={params.emaFast}
                  min={2}
                  max={500}
                  onChange={(v) => set({ emaFast: v })}
                  disabled={disabled}
                />
                <NumField
                  label="EMA slow"
                  value={params.emaSlow}
                  min={3}
                  max={1000}
                  onChange={(v) => set({ emaSlow: v })}
                  disabled={disabled}
                />
              </>
            ) : null}
            {strategy.params.map((def) => (
              <NumField
                key={def.key}
                label={def.label}
                value={signalParams[def.key] ?? def.default}
                min={def.min}
                max={def.max}
                step={def.step}
                onChange={(v) => setSignalParam(def.key, v)}
                hint={def.hint}
                disabled={disabled}
              />
            ))}
          </div>
          <p className="text-[10px] leading-snug text-zinc-600">
            The signal family is a controlled variable: every strategy runs through the identical
            DCA / margin / liquidation machinery below.
          </p>
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-200">Market &amp; Capital</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
          <SelectField
            label="Symbol"
            value={params.symbol}
            options={SYMBOLS.map((s) => ({ value: s, label: s }))}
            onChange={(v) => {
              const patch: Partial<StrategyParams> = { symbol: v };
              // Follow the symbol's Binance tier-1 MMR unless the user set a
              // custom value for the previous symbol (SOL/XRP tier-1 is 1.0%,
              // double the old flat 0.5% default - liquidation risk there was
              // previously underestimated).
              const prevDefault = SYMBOL_MMR_PCT[params.symbol] ?? 0.5;
              if (params.mmrPct === prevDefault || params.mmrPct === 0.5) {
                patch.mmrPct = SYMBOL_MMR_PCT[v] ?? 0.5;
              }
              set(patch);
            }}
            disabled={disabled}
          />
          <SelectField
            label="Signal timeframe"
            value={params.interval}
            options={INTERVALS.map((i: Interval) => ({
              value: i,
              label: i,
            }))}
            onChange={(v) => set({ interval: v as Interval })}
            disabled={disabled}
          />
          <SelectField
            label="Execution (intrabar order)"
            value={params.intrabarMode ?? 'bar'}
            options={[
              { value: 'bar', label: 'OHLC bars (fast)' },
              { value: 'refined', label: 'OHLC + aggTrades where needed' },
              { value: 'tick', label: 'aggTrades ticks (needs a window)' },
            ]}
            onChange={(v) => set({ intrabarMode: v as StrategyParams['intrabarMode'] })}
            disabled={disabled}
          />
          <NumField
            label="Starting equity (USDT)"
            value={params.startingEquity}
            min={100}
            max={10000000}
            step={100}
            onChange={(v) => set({ startingEquity: v })}
            disabled={disabled}
          />
          <NumField
            label="Initial allocation (%)"
            value={params.initialAllocPct}
            min={0.5}
            max={100}
            step={0.5}
            onChange={(v) => set({ initialAllocPct: v })}
            hint="% of starting equity used as initial margin"
            disabled={disabled}
          />
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-200">Direction &amp; Leverage</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
          <NumField
            label="Leverage (x)"
            value={params.leverage}
            min={1}
            max={125}
            step={1}
            onChange={(v) => set({ leverage: v })}
            disabled={disabled}
          />
          <SelectField
            label="Direction"
            value={params.directionMode}
            options={[
              { value: 'both', label: 'LONG + SHORT' },
              { value: 'long', label: 'LONG only' },
              { value: 'short', label: 'SHORT only' },
            ]}
            onChange={(v) => set({ directionMode: v as StrategyParams['directionMode'] })}
            disabled={disabled}
          />
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-200">Progressive Averaging (DCA)</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
          <SelectField
            label="Spacing mode"
            value={params.spacingMode}
            options={[
              { value: 'fixed', label: 'Fixed % grid' },
              { value: 'atr', label: 'ATR-based grid' },
            ]}
            onChange={(v) => set({ spacingMode: v as StrategyParams['spacingMode'] })}
            disabled={disabled}
          />
          <NumField
            label="Fixed spacing (%)"
            value={params.spacingPct}
            min={0.05}
            max={50}
            step={0.05}
            onChange={(v) => set({ spacingPct: v })}
            disabled={disabled || params.spacingMode !== 'fixed'}
          />
          <NumField
            label="ATR period"
            value={params.atrPeriod}
            min={2}
            max={200}
            onChange={(v) => set({ atrPeriod: v })}
            disabled={disabled || params.spacingMode !== 'atr'}
          />
          <NumField
            label="ATR multiplier"
            value={params.atrMultiplier}
            min={0.1}
            max={20}
            step={0.1}
            onChange={(v) => set({ atrMultiplier: v })}
            disabled={disabled || params.spacingMode !== 'atr'}
          />
          <NumField
            label="DCA allocation (%)"
            value={params.dcaAllocPct}
            min={0.1}
            max={100}
            step={0.5}
            onChange={(v) => set({ dcaAllocPct: v })}
            hint="% of starting equity per layer (fixed at trade start)"
            disabled={disabled}
          />
          <NumField
            label="Max DCA layers"
            value={params.maxDcaLayers}
            min={0}
            max={50}
            onChange={(v) => set({ maxDcaLayers: Math.round(v) })}
            disabled={disabled}
          />
          <NumField
            label="Max margin deployment (%)"
            value={params.maxMarginPct}
            min={1}
            max={100}
            step={1}
            onChange={(v) => set({ maxMarginPct: v })}
            hint="Hard cap, % of starting equity"
            disabled={disabled}
          />
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-200">Exit Rules</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
          <NumField
            label="Profit target (% ROI on margin)"
            value={params.targetRoiPct}
            min={0.1}
            max={200}
            step={0.5}
            onChange={(v) => set({ targetRoiPct: v })}
            hint="Net ROI on total deployed margin"
            disabled={disabled}
          />
          <NumField
            label="Max hold (hours, 0 = off)"
            value={params.maxHoldHours}
            min={0}
            max={8760}
            step={1}
            onChange={(v) => set({ maxHoldHours: v })}
            hint="Time-based exit (experiment E6)"
            disabled={disabled}
          />
          <div className="col-span-2">
            <SwitchField
              label="Trend invalidation exit (E8)"
              checked={params.exitOnTrendFlip}
              onChange={(v) => set({ exitOnTrendFlip: v })}
              hint="Close the position when the trend signal flips against it"
              disabled={disabled}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-200">Liquidation Risk Monitor</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
            <NumField
              label="WARNING ratio"
              value={params.riskWarningRatio}
              min={0.05}
              max={1}
              step={0.05}
              onChange={(v) => set({ riskWarningRatio: v })}
              disabled={disabled}
            />
            <NumField
              label="CRITICAL ratio"
              value={params.riskCriticalRatio}
              min={0.1}
              max={1}
              step={0.05}
              onChange={(v) => set({ riskCriticalRatio: v })}
              disabled={disabled}
            />
          </div>
          <SwitchField
            label="Block DCA at WARNING"
            checked={params.blockDcaOnWarning}
            onChange={(v) => set({ blockDcaOnWarning: v })}
            hint="Cancel remaining averaging orders when the margin ratio enters the WARNING zone (spec section 5)"
            disabled={disabled}
          />
          <SwitchField
            label="Trend health gate on DCA"
            checked={params.blockDcaOnFlip}
            onChange={(v) => set({ blockDcaOnFlip: v })}
            hint="Cancel pending averaging orders once the trend flips against the position"
            disabled={disabled}
          />
          <SwitchField
            label="Emergency close at CRITICAL"
            checked={params.forceCloseAtRisk}
            onChange={(v) => set({ forceCloseAtRisk: v })}
            hint="Force-close the whole position when the CRITICAL margin threshold is breached"
            disabled={disabled}
          />
          <NumField
            label="Maintenance margin rate (%)"
            value={params.mmrPct}
            min={0.05}
            max={10}
            step={0.05}
            onChange={(v) => set({ mmrPct: v })}
            hint={`Static MMR approximation of Binance bracket tiers (tier-1 for ${params.symbol}: ${SYMBOL_MMR_PCT[params.symbol] ?? 0.5}%)`}
            disabled={disabled}
          />
        </CardContent>
      </Card>

      <Card className="border-zinc-800 bg-zinc-900/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-zinc-200">Costs &amp; Funding</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
          <NumField
            label="Maker fee (%)"
            value={params.feeMakerPct}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(v) => set({ feeMakerPct: v })}
            disabled={disabled}
          />
          <NumField
            label="Taker fee (%)"
            value={params.feeTakerPct}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(v) => set({ feeTakerPct: v })}
            disabled={disabled}
          />
          <NumField
            label="Slippage (%)"
            value={params.slippagePct}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => set({ slippagePct: v })}
            disabled={disabled}
          />
          <SelectField
            label="Funding mode"
            value={params.fundingMode}
            options={[
              { value: 'historical', label: 'Historical (real)' },
              { value: 'fixed', label: 'Fixed rate' },
            ]}
            onChange={(v) => set({ fundingMode: v as StrategyParams['fundingMode'] })}
            disabled={disabled}
          />
          {params.fundingMode === 'fixed' ? (
            <NumField
              label="Fixed funding (% / 8h)"
              value={params.fixedFundingPctPer8h}
              min={-0.5}
              max={0.5}
              step={0.005}
              onChange={(v) => set({ fixedFundingPctPer8h: v })}
              disabled={disabled}
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
