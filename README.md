# NPRS Research Terminal

**NEMESIS Progressive Recovery Strategy (v1)** — a quant research terminal for studying whether
**progressive averaging (DCA) can rescue a leveraged trend entry before liquidation**, built on
**real Binance public data** with a deterministic backtest engine and a pluggable, selectable
entry-strategy registry.

> Research tool only. Historical simulation with documented simplifications.
> Not financial advice — leveraged futures can lose all deployed capital.

---

## What it does

NPRS answers one central research question:

> **P(TP before liquidation)** — the probability that a leveraged position reaches its net
> take-profit target before being liquidated, measured over years of real market data,
> conditioned on DCA depth, strategy family, symbol, and risk configuration.

The terminal lets you:

- **Ingest real data** — 1–3 years of USDT-M perpetual **klines, mark-price klines and funding
  rates** for BTC / ETH / SOL / XRP straight from Binance's official public archive
  (`data.binance.vision`) with one click, plus a live market ticker strip from the real
  Binance spot REST API.
- **Select an entry strategy** — 8 registered signal strategies (trend, momentum, breakout,
  volatility families) sharing one identical DCA / margin / liquidation / cost engine, so the
  entry signal stays a controlled variable.
- **Run deterministic backtests** — event-driven, no lookahead (signals on bar close execute on
  the next bar open), conservative intrabar ordering, liquidation on **real mark-price klines**
  with maintenance-margin tiers, historical funding accrual, maker/taker fees and slippage.
- **Compare strategies** — the Strategy Lab backtests every entry signal on the same dataset
  with identical risk settings and ranks them by return, P(TP<liq), profit factor or drawdown.
- **Inspect everything** — full trade ledger, mark-to-market equity curve, drawdown, exit
  breakdown, risk-event log (warnings, DCA blocks, liquidations) and per-depth survival stats
  for every stored run.

## Entry strategies (registry)

| # | Strategy | Family | Style |
|---|----------|--------|-------|
| 1 | EMA Trend Filter (baseline) | trend | state — re-enters while regime holds |
| 2 | EMA Cross | trend | event — fires on the crossing bar |
| 3 | EMA Cross + RSI confirm | trend | event |
| 4 | MACD Momentum | momentum | event — histogram flip + zero-line filter |
| 5 | Donchian Breakout | breakout | event — prior N-bar range break |
| 6 | Supertrend | volatility | state — ATR trailing regime |
| 7 | Bollinger Breakout | volatility | event — band break |
| 8 | ROC Momentum | momentum | event — rate-of-change threshold |

Every strategy implements the same `computeSignals(candles, params) → TrendSignal[]` contract
and declares its own tunable parameters (RSI thresholds, MACD periods, channel length, ATR
multiplier, ...), all validated and clamped server-side.

## The engine (what is simulated)

- **Capital model** — isolated margin, one-way position. Initial tranche
  `initialAllocPct` of equity at `leverage`×; DCA tranches add **quantity** (and margin) at
  fixed-% or ATR-scaled grid levels below/above entry, capped by `maxMarginPct` of starting
  equity and `maxDcaLayers`.
- **Weighted average entry** — `P_avg = Σ(Qi·Pi) / ΣQi`, recomputed per fill; liquidation
  price recomputed from `P_avg`, leverage and maintenance-margin rate.
- **Take-profit** — net ROI target on deployed margin (`targetRoiPct`), i.e. the exit price
  that covers entry fees, funding accrued so far and the exit fee. Executed with slippage +
  taker fee (conservative).
- **Liquidation** — evaluated on the candle's **mark-price** extreme (Binance USDT-M
  liquidates on mark price). Conservative intrabar ordering: liquidation is checked before DCA
  fills; if the candle touches both a DCA level and liquidation, liquidation wins. On
  liquidation the entire deployed margin is forfeited.
- **Risk state machine** — SAFE / WARNING / CRITICAL margin-ratio states. WARNING blocks
  further averaging; CRITICAL cancels pending orders and can force-close (configurable).
- **Funding** — real settled funding rates from the archive (mark-price joined), or a fixed
  per-8h rate; accrued progressively from the wallet.
- **Costs** — maker fee on DCA limit fills, taker fee + slippage on market entries/exits.

Documented simplifications vs. Binance: static (tier-1) maintenance-margin rate instead of
notional brackets, no queue modeling for limit fills, funding archive lags the current month.

## Architecture

```
src/
  app/
    page.tsx                  # terminal UI shell (Run / Results / Trades / Lab / Experiments / Research)
    api/
      data/ingest             # start real-data ingestion job (Binance archive)
      data/status             # job progress + stored dataset inventory
      market/ticker           # live spot tickers (real Binance REST mirror)
      backtest/               # run single or all-strategy comparison, list runs
      backtest/[id]/          # full run detail (trades, equity, risk events)
  components/nprs/            # config form, data panel, results, trades table, charts, lab
  lib/
    datasources/binance.ts    # real HTTP client: archive zips, gap healing, retries, cache
    ingest.ts                 # background ingestion job manager
    nprs/
      engine.ts               # deterministic event-driven backtest engine
      margin.ts               # isolated-margin liquidation & risk-state math
      indicators.ts           # EMA/ATR/RSI/MACD/Donchian/Bollinger/ROC/Supertrend
      strategies.ts           # strategy registry (8 signal families)
      metrics.ts              # P(TP<liq), expectancy, drawdown, depth stats, Sharpe/Sortino
      validate.ts             # server-side param sanitization & clamping
      defaults.ts             # baseline config + experiment presets E1–E9
  prisma/schema.prisma        # Candle / FundingRate / BacktestRun / Trade / EquityPoint / RiskEvent
```

Stack: Next.js (App Router) + TypeScript, Tailwind + shadcn/ui, Prisma + SQLite,
recharts for the equity / drawdown / price charts.

## Run it

```bash
bun install             # regenerates bun.lock
cp .env.example .env    # local SQLite path (db/custom.db)
bun run db:push         # create the local SQLite schema
bun run dev             # http://localhost:3000
```

Then in the app: open the **Run** tab → **Fetch Real Binance Data** (1 year × 4 symbols takes
seconds; 3 years a few minutes; every archive file is cached on disk under `.cache/`) → pick a
strategy, preset or custom config → **Run Backtest**, or head to the **Strategy Lab** and
compare all eight entry families at once.

Data provenance (no synthetic fallbacks, ever):

- Klines, mark-price klines, funding: `https://data.binance.vision` official archive
  (monthly + daily zips, gap detection and healing, 404-aware for pre-listing ranges)
- Live ticker strip: real Binance spot REST (`data-api.binance.vision`)

## Experiments built in

Presets E1–E9 isolate which component creates the edge: fixed 2% vs 1% grids, ATR spacing,
time-based exits, shallow averaging, trend-flip exits, 5× vs 10× leverage — and the Strategy
Lab adds the strategy dimension on top, all on identical datasets and cost models.

## License / disclaimer

Provided for research and education. Backtest results are historical simulations with
documented simplifications; they do not guarantee future performance. Trading leveraged
perpetual futures involves substantial risk of total loss.
