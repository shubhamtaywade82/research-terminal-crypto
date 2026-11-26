import type { LucideIcon } from "lucide-react"
import {
  AlertTriangle,
  FlaskConical,
  FlaskRound,
  Gauge,
  GitBranch,
  Map,
  Microscope,
  Repeat,
  ShieldAlert,
  Sigma,
  Target,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

const STRATEGY_PARAMETERS: { parameter: string; value: string; note: string }[] = [
  {
    parameter: "Initial margin allocation",
    value: "10% of account capital",
    note: "Per position, deployed at entry",
  },
  {
    parameter: "Leverage",
    value: "10x",
    note: "Per position",
  },
  {
    parameter: "Additional allocation",
    value: "5%",
    note: "Per averaging layer, on adverse movement",
  },
  {
    parameter: "Maximum margin allocation",
    value: "50%",
    note: "Experimental cap on total deployed margin",
  },
  {
    parameter: "Profit target",
    value: "10% net ROI",
    note: "On deployed margin, closes the entire position",
  },
  {
    parameter: "Position stop-loss",
    value: "Disabled",
    note: "Baseline configuration, experimental",
  },
  {
    parameter: "Margin mode",
    value: "Isolated",
    note: "Initially isolated, per-position collateral",
  },
]

const LIFECYCLE_STEPS: string[] = [
  "Initial entry in the direction of the detected trend.",
  "Additional limit orders are placed against adverse movement.",
  "After every fill: recalculate average entry, liquidation price and margin.",
  "Exit the entire position when the net profit target is achieved.",
  "Stop averaging when the capital or exposure limit is reached.",
]

const ENTRY_STRATEGIES: {
  name: string
  category: string
  style: "state" | "event"
  signal: string
  baseline?: boolean
}[] = [
  {
    name: "EMA Trend Filter",
    category: "trend",
    style: "state",
    signal: "Fast EMA above slow EMA and close above fast EMA (mirrored for SHORT).",
    baseline: true,
  },
  {
    name: "EMA Cross",
    category: "trend",
    style: "event",
    signal: "Fast EMA crosses above/below the slow EMA (golden / death cross).",
  },
  {
    name: "EMA Cross + RSI Confirm",
    category: "trend",
    style: "event",
    signal: "EMA cross confirmed by RSI above the long threshold / below the short threshold.",
  },
  {
    name: "MACD Momentum",
    category: "momentum",
    style: "event",
    signal: "MACD histogram flips sign, optionally filtered by the MACD zero line.",
  },
  {
    name: "Donchian Breakout",
    category: "breakout",
    style: "event",
    signal: "Close crosses above the prior N-bar high / below the prior N-bar low.",
  },
  {
    name: "Supertrend",
    category: "volatility",
    style: "state",
    signal: "ATR trailing-stop regime: long above the lower band, short below the upper band.",
  },
  {
    name: "Bollinger Breakout",
    category: "volatility",
    style: "event",
    signal: "Close crosses the upper / lower Bollinger band (volatility expansion).",
  },
  {
    name: "ROC Momentum",
    category: "momentum",
    style: "event",
    signal: "N-bar rate of change crosses a +/- percent threshold.",
  },
]

const FORMULAS: { label: string; expression: string }[] = [
  { label: "Weighted average entry", expression: "P_avg = sum(Q_i * P_i) / sum(Q_i)" },
  { label: "ROI on deployed margin", expression: "ROI_margin = NetPnL / TotalMarginDeployed * 100" },
  { label: "LONG PnL", expression: "PnL_long = Q_total * (P_exit - P_avg)" },
  { label: "SHORT PnL", expression: "PnL_short = Q_total * (P_avg - P_exit)" },
  { label: "Net PnL", expression: "NetPnL = GrossPnL - Fees - Funding - Slippage" },
]

const STATE_FIELDS: { field: string; description: string }[] = [
  { field: "Average entry price", description: "Volume-weighted average across all fills" },
  { field: "Total quantity", description: "Sum of filled position size, base asset units" },
  { field: "Total notional", description: "Total quantity valued at current price" },
  { field: "Initial margin", description: "Collateral deployed to open the position" },
  { field: "Maintenance margin", description: "Exchange-required maintenance collateral" },
  { field: "Wallet balance", description: "Isolated margin wallet of the position" },
  { field: "Unrealized PnL", description: "Mark-to-market result versus average entry" },
  { field: "Liquidation price", description: "Derived boundary at which the exchange closes the position" },
  { field: "Margin ratio", description: "Maintenance margin relative to margin balance" },
  { field: "Distance to liquidation", description: "Remaining price gap to the liquidation boundary" },
]

const RISK_STATES: {
  state: string
  badgeClass: string
  meaning: string
  action: string
}[] = [
  {
    state: "SAFE",
    badgeClass: "border-emerald-900 bg-emerald-950/60 text-emerald-400",
    meaning: "Healthy margin buffer.",
    action: "Continue managing pending DCA orders.",
  },
  {
    state: "WARNING",
    badgeClass: "border-amber-900 bg-amber-950/60 text-amber-400",
    meaning: "Liquidation buffer decreasing.",
    action: "Remaining averaging orders cancelled (risk gate, configurable).",
  },
  {
    state: "CRITICAL",
    badgeClass: "border-rose-900 bg-rose-950/60 text-rose-400",
    meaning: "Margin safety limit breached.",
    action: "Pending orders cancelled, configured emergency action executes.",
  },
]

const SIMULATOR_ASSUMPTIONS: string[] = [
  "Binance liquidation uses Mark Price and notional-dependent maintenance brackets; this simulator evaluates liquidation on the REAL mark-price klines from the Binance archive but uses a static MMR (default 0.5%) instead of historical notional brackets - a documented approximation.",
  "Within each candle, risk is evaluated pessimistically: liquidation is checked BEFORE averaging fills; if both a DCA level and liquidation level are touched in the same candle, the simulator assumes liquidation happened first.",
  "Limit fills are assumed filled at the limit price only if the candle range crosses it (no order-book queue modeling).",
  "Take-profit counts only if the candle extreme crosses the derived target price; the fill is executed with taker fee and slippage applied (conservative).",
  "Funding is applied from real USDT-M funding history (or a configurable fixed rate), deducted from wallet and PnL progressively. Archive reality: the public archive publishes funding history as monthly files only, so the newest (still incomplete) month accrues no funding until its zip appears - a small, temporary understatement of costs for trades opened in that window.",
  "Isolated liquidation boundary approximated as P_liq = P_avg * (1 - 1/lev + MMR) for LONG (mirrored for SHORT); on liquidation the ENTIRE deployed margin is forfeited to the liquidation engine (Binance isolated-margin behavior) - nothing is returned to the wallet.",
  "Price, mark price and funding series are real Binance USDT-M perpetual data fetched over HTTPS from Binance's official public archive (data.binance.vision); the live ticker strip quotes the Binance spot REST API (data-api.binance.vision). Monthly-zip holes are detected after the merge and healed from daily files automatically. No synthetic or simulated price paths are used anywhere.",
  "A 1-minute OHLC candle cannot reveal intrabar ordering; conservative ordering means results are more likely understated than overstated.",
]

const PAIRED_METRICS: string[] = [
  "Expected net return",
  "Maximum drawdown",
  "Capital utilization",
  "Probability of account ruin",
]

const EXPERIMENTS: { id: string; dimension: string; configuration: string; baseline?: boolean }[] = [
  { id: "E1", dimension: "DCA spacing", configuration: "Fixed 2% DCA spacing" },
  { id: "E2", dimension: "DCA spacing", configuration: "Fixed 1% DCA spacing" },
  { id: "E3", dimension: "DCA spacing", configuration: "ATR-based DCA spacing" },
  { id: "E4", dimension: "Position sizing", configuration: "Fixed 5% margin per layer", baseline: true },
  { id: "E5", dimension: "Position sizing", configuration: "Volatility-adjusted position sizing" },
  { id: "E6", dimension: "Exit rule", configuration: "Time-based exit" },
  { id: "E7", dimension: "DCA depth", configuration: "Maximum DCA layers" },
  { id: "E8", dimension: "Exit rule", configuration: "Trend invalidation exit" },
  { id: "E9", dimension: "Leverage", configuration: "5x vs 10x leverage" },
  { id: "E10", dimension: "Margin mode", configuration: "Isolated vs cross margin" },
]

const VALIDATION_STAGES: string[] = [
  "Historical development",
  "Validation period",
  "Out-of-sample evaluation",
  "Walk-forward experiments",
]

const ROADMAP: {
  phase: string
  title: string
  status: "implemented" | "planned"
  detail: string
}[] = [
  {
    phase: "Phase 1",
    title: "Historical Data Infrastructure",
    status: "implemented",
    detail: "Real Binance candles + funding ingestion with versioned dataset ranges.",
  },
  {
    phase: "Phase 2",
    title: "Deterministic Trading Simulator",
    status: "implemented",
    detail: "Position accounting, weighted entry, DCA, margin, liquidation, fees, funding, profit exits.",
  },
  {
    phase: "Phase 3",
    title: "Strategy Backtesting",
    status: "implemented",
    detail: "Trend signals, DCA configs, multi-timeframe experiment runner.",
  },
  {
    phase: "Phase 4",
    title: "Analytics and Research Dashboard",
    status: "implemented",
    detail: "Equity curves, drawdowns, liquidation analytics, trade explorer, experiment comparison.",
  },
  {
    phase: "Phase 5",
    title: "Paper Trading Validation",
    status: "planned",
    detail: "Live market data with simulated execution before any live consideration.",
  },
]

/* ------------------------------------------------------------------ */
/* Local presentational helpers                                        */
/* ------------------------------------------------------------------ */

function SectionIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-4 shrink-0 text-zinc-500" aria-hidden="true" />
}

function SectionCard({
  icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <Card className="border-zinc-800 bg-zinc-900/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-300">
          <SectionIcon icon={icon} />
          {title}
        </CardTitle>
        {description ? (
          <CardDescription className="text-sm text-zinc-400">{description}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  )
}

function DataTableHead() {
  return (
    <TableHeader>
      <TableRow className="border-zinc-800 hover:bg-transparent">
        <TableHead className="text-xs uppercase tracking-wide text-zinc-500">Field</TableHead>
        <TableHead className="text-xs uppercase tracking-wide text-zinc-500">Value</TableHead>
        <TableHead className="text-xs uppercase tracking-wide text-zinc-500">Notes</TableHead>
      </TableRow>
    </TableHeader>
  )
}

/* ------------------------------------------------------------------ */
/* Research panel                                                      */
/* ------------------------------------------------------------------ */

export default function ResearchPanel() {
  return (
    <div className="w-full space-y-4 text-zinc-400">
      {/* 1. Strategy Definition */}
      <SectionCard
        icon={FlaskConical}
        title="Strategy Definition — NPRS v1"
        description="NEMESIS Progressive Recovery Strategy (NPRS) v1"
      >
        <p className="text-sm leading-relaxed">
          A leveraged trend-following strategy with progressive averaging (DCA), dynamic
          liquidation monitoring and a profit-based exit. Enter in the direction of a detected
          trend, progressively increase exposure when price moves against the position, improve
          the volume-weighted average entry price, and close the entire position when it recovers
          to the target profit.
        </p>
        <Separator className="bg-zinc-800" />
        <Table>
          <DataTableHead />
          <TableBody>
            {STRATEGY_PARAMETERS.map((row) => (
              <TableRow key={row.parameter} className="border-zinc-800">
                <TableCell className="text-sm text-zinc-300">{row.parameter}</TableCell>
                <TableCell className="font-mono text-sm text-zinc-100">{row.value}</TableCell>
                <TableCell className="text-sm text-zinc-500">{row.note}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-xs leading-relaxed text-amber-500/90">
          Note: running without a conventional per-position stop-loss is an experimental choice.
          Allocation caps and emergency rules replace it.
        </p>
      </SectionCard>

      {/* 1b. Entry Signal Strategy Catalog */}
      <SectionCard
        icon={GitBranch}
        title="Entry Signal Strategy Catalog"
        description="Eight selectable signal families - one controlled variable"
      >
        <p className="text-sm leading-relaxed">
          The NPRS research question is whether progressive averaging rescues a leveraged
          trend entry before liquidation. The entry signal is therefore a controlled variable:
          every strategy below feeds the same TrendSignal contract into the identical DCA,
          margin, funding and liquidation machinery. Select one on the Run tab, or compare all
          of them on the same dataset in the Strategy Lab.
        </p>
        <Table>
          <TableHeader>
            <TableRow className="border-zinc-800 hover:bg-transparent">
              <TableHead className="text-xs uppercase tracking-wide text-zinc-500">Strategy</TableHead>
              <TableHead className="text-xs uppercase tracking-wide text-zinc-500">Family</TableHead>
              <TableHead className="text-xs uppercase tracking-wide text-zinc-500">Style</TableHead>
              <TableHead className="text-xs uppercase tracking-wide text-zinc-500">Signal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ENTRY_STRATEGIES.map((s) => (
              <TableRow key={s.name} className="border-zinc-800">
                <TableCell className="text-sm text-zinc-300">
                  {s.name}
                  {s.baseline ? (
                    <Badge
                      variant="outline"
                      className="ml-2 border-emerald-900 bg-emerald-950/60 text-[10px] text-emerald-400"
                    >
                      baseline
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className="border-zinc-700 text-[10px] uppercase tracking-wide text-zinc-400"
                  >
                    {s.category}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={`text-[10px] uppercase tracking-wide ${
                      s.style === "state"
                        ? "border-amber-900 bg-amber-950/60 text-amber-400"
                        : "border-zinc-700 text-zinc-400"
                    }`}
                  >
                    {s.style}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-zinc-500">{s.signal}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-xs leading-relaxed text-zinc-500">
          State-style strategies stay signaled while their regime holds, so the engine can
          re-enter immediately after a take-profit. Event-style strategies fire only on the
          crossing bar itself. Signals are always evaluated on bar close and executed on the
          next bar open - no lookahead anywhere in the pipeline.
        </p>
      </SectionCard>

      {/* 2. Position Lifecycle */}
      <SectionCard
        icon={Repeat}
        title="Position Lifecycle"
        description="From trend entry to profit-based exit"
      >
        <ol className="space-y-2">
          {LIFECYCLE_STEPS.map((step, index) => (
            <li key={step} className="flex items-start gap-3">
              <span className="mt-0.5 font-mono text-xs text-zinc-600">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="text-sm leading-relaxed">{step}</span>
            </li>
          ))}
        </ol>
        <Alert className="border-amber-900/60 bg-amber-950/30 text-amber-200">
          <AlertTriangle className="text-amber-500" aria-hidden="true" />
          <AlertTitle className="text-amber-200">Important distinction</AlertTitle>
          <AlertDescription className="text-amber-200/80">
            The engine increases position quantity (not just margin), which changes the
            liquidation price and the profitability of the position.
          </AlertDescription>
        </Alert>
      </SectionCard>

      {/* 3. Key Formulas */}
      <SectionCard icon={Sigma} title="Key Formulas" description="Accounting used by the simulator">
        <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-950/60 p-4">
          {FORMULAS.map((formula) => (
            <div key={formula.label} className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-zinc-500">{formula.label}</p>
              <p className="font-mono text-sm text-zinc-100">{formula.expression}</p>
            </div>
          ))}
        </div>
        <p className="text-sm leading-relaxed">
          At 10x leverage, roughly a{" "}
          <span className="font-mono text-emerald-400">1%</span> favorable move from average entry
          equals a <span className="font-mono text-emerald-400">10%</span> gross ROI on margin.
        </p>
      </SectionCard>

      {/* 4. Per-Position State Monitored */}
      <SectionCard
        icon={Gauge}
        title="Per-Position State Monitored"
        description="State tracked for every open position"
      >
        <Table>
          <TableHeader>
            <TableRow className="border-zinc-800 hover:bg-transparent">
              <TableHead className="text-xs uppercase tracking-wide text-zinc-500">State field</TableHead>
              <TableHead className="text-xs uppercase tracking-wide text-zinc-500">Meaning</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {STATE_FIELDS.map((field) => (
              <TableRow key={field.field} className="border-zinc-800">
                <TableCell className="text-sm text-zinc-300">{field.field}</TableCell>
                <TableCell className="text-sm text-zinc-500">{field.description}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>

      {/* 5. Liquidation Risk Monitor */}
      <SectionCard
        icon={ShieldAlert}
        title="Liquidation Risk Monitor"
        description="Three-state margin safety classification per position"
      >
        <div className="grid gap-4 md:grid-cols-3">
          {RISK_STATES.map((risk) => (
            <div key={risk.state} className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-4">
              <Badge variant="outline" className={risk.badgeClass}>
                {risk.state}
              </Badge>
              <p className="text-sm text-zinc-300">{risk.meaning}</p>
              <p className="text-xs leading-relaxed text-zinc-500">{risk.action}</p>
            </div>
          ))}
        </div>
        <p className="text-sm leading-relaxed">
          State transitions are driven by configurable margin-ratio levels{" "}
          <span className="font-mono text-zinc-200">(defaults 0.5 / 0.8)</span>.
        </p>
        <Alert className="border-rose-900/60 bg-rose-950/30 text-rose-200">
          <ShieldAlert className="text-rose-400" aria-hidden="true" />
          <AlertTitle className="text-rose-200">Liquidation is not a stop-loss</AlertTitle>
          <AlertDescription className="text-rose-200/80">
            Liquidation is an exchange-enforced failure mechanism. Additional DCA can increase
            capital at risk even when the average entry improves.
          </AlertDescription>
        </Alert>
      </SectionCard>

      {/* 6. Simulator Fidelity and Conservative Assumptions */}
      <SectionCard
        icon={Microscope}
        title="Simulator Fidelity and Conservative Assumptions"
        description="Documented approximations, applied pessimistically"
      >
        <ul className="space-y-3">
          {SIMULATOR_ASSUMPTIONS.map((assumption) => (
            <li key={assumption} className="flex items-start gap-3">
              <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-zinc-600" />
              <span className="text-sm leading-relaxed">{assumption}</span>
            </li>
          ))}
        </ul>
      </SectionCard>

      {/* 7. Central Research Objective */}
      <SectionCard
        icon={Target}
        title="Central Research Objective"
        description="The metric the whole project revolves around"
      >
        <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-4">
          <p className="font-mono text-lg leading-relaxed text-zinc-100">
            P(Profit Target Reached Before Liquidation)
          </p>
          <p className="font-mono text-sm leading-relaxed text-zinc-400">
            reported overall, and conditioned on DCA depth:{" "}
            <span className="text-zinc-200">P(TP before liquidation | DCA depth)</span>
          </p>
        </div>
        <div className="space-y-2">
          <p className="text-sm text-zinc-300">Never optimize it alone. Pair it with:</p>
          <div className="flex flex-wrap gap-2">
            {PAIRED_METRICS.map((metric) => (
              <Badge
                key={metric}
                variant="outline"
                className="border-zinc-700 bg-zinc-900 text-zinc-300"
              >
                {metric}
              </Badge>
            ))}
          </div>
        </div>
        <Alert className="border-amber-900/60 bg-amber-950/30 text-amber-200">
          <AlertTriangle className="text-amber-500" aria-hidden="true" />
          <AlertTitle className="text-amber-200">Expectancy warning</AlertTitle>
          <AlertDescription className="text-amber-200/80">
            A strategy that wins 95 of 100 trades but loses most of the account on the remaining
            five is not a successful strategy. A high win rate can coexist with negative expectancy
            and catastrophic tail risk.
          </AlertDescription>
        </Alert>
      </SectionCard>

      {/* 8. Experiment Matrix */}
      <SectionCard
        icon={FlaskRound}
        title="Experiment Matrix"
        description="Controlled comparisons, one variable at a time"
      >
        <Table>
          <TableHeader>
            <TableRow className="border-zinc-800 hover:bg-transparent">
              <TableHead className="text-xs uppercase tracking-wide text-zinc-500">ID</TableHead>
              <TableHead className="text-xs uppercase tracking-wide text-zinc-500">Dimension</TableHead>
              <TableHead className="text-xs uppercase tracking-wide text-zinc-500">Configuration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {EXPERIMENTS.map((experiment) => (
              <TableRow key={experiment.id} className="border-zinc-800">
                <TableCell className="font-mono text-sm text-zinc-100">{experiment.id}</TableCell>
                <TableCell className="text-sm text-zinc-500">{experiment.dimension}</TableCell>
                <TableCell className="text-sm text-zinc-300">
                  <span className="flex items-center gap-2">
                    {experiment.configuration}
                    {experiment.baseline ? (
                      <Badge
                        variant="outline"
                        className="border-emerald-900 bg-emerald-950/60 text-emerald-400"
                      >
                        baseline
                      </Badge>
                    ) : null}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-sm leading-relaxed">
          Purpose: understand which component creates the edge instead of optimizing everything at
          once.
        </p>
      </SectionCard>

      {/* 9. Validation Methodology */}
      <SectionCard
        icon={GitBranch}
        title="Validation Methodology"
        description="Sequential evaluation pipeline"
      >
        <ol className="flex flex-wrap items-center gap-2">
          {VALIDATION_STAGES.map((stage, index) => (
            <li key={stage} className="flex items-center gap-2">
              <span className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-xs text-zinc-300">
                <span className="mr-2 font-mono text-zinc-600">
                  {String(index + 1).padStart(2, "0")}
                </span>
                {stage}
              </span>
              {index < VALIDATION_STAGES.length - 1 ? (
                <span aria-hidden="true" className="font-mono text-xs text-zinc-600">
                  {"->"}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
        <ul className="space-y-2">
          <li className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-zinc-600" />
            <span className="text-sm leading-relaxed">
              Every experiment records its result, including failed configurations.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-zinc-600" />
            <span className="text-sm leading-relaxed">
              Never discard liquidations or losing trades from the record.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-600" />
            <span className="text-sm leading-relaxed text-amber-500/90">
              Beware parameter overfitting: the best of hundreds of historical configurations is
              not evidence of edge.
            </span>
          </li>
        </ul>
      </SectionCard>

      {/* 10. Build Roadmap */}
      <SectionCard icon={Map} title="Build Roadmap" description="Delivery status by phase">
        <div className="space-y-3">
          {ROADMAP.map((phase) => (
            <div
              key={phase.phase}
              className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-4 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="space-y-1">
                <p className="text-sm text-zinc-100">
                  <span className="mr-2 font-mono text-xs uppercase tracking-wide text-zinc-500">
                    {phase.phase}
                  </span>
                  {phase.title}
                </p>
                <p className="text-xs leading-relaxed text-zinc-500">{phase.detail}</p>
              </div>
              <Badge
                variant="outline"
                className={
                  phase.status === "implemented"
                    ? "shrink-0 border-emerald-900 bg-emerald-950/60 text-emerald-400"
                    : "shrink-0 border-amber-900 bg-amber-950/60 text-amber-400"
                }
              >
                {phase.status}
              </Badge>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* 11. Disclaimer */}
      <Alert className="border-rose-900/60 bg-rose-950/30 text-rose-200">
        <AlertTriangle className="text-rose-400" aria-hidden="true" />
        <AlertTitle className="text-rose-200">Disclaimer</AlertTitle>
        <AlertDescription className="text-rose-200/80">
          Research tool only. Results are historical simulations with documented simplifications
          and are not financial advice. Leveraged futures trading can result in total loss of
          deployed capital.
        </AlertDescription>
      </Alert>
    </div>
  )
}
