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
- **Take-profit** — net ROI target on deployed margin (`targetRoiPct`). The trigger price is
  solved so that, after exit slippage and the exit taker fee, the trade's net ROI equals the
  target; a `TAKE_PROFIT` trade therefore realises the configured ROI exactly.
- **Timing** — a signal evaluated on bar *i−1* close is executed at bar *i* **open** (entries and
  trend-flip exits alike). The entry bar is fully managed (liquidation, DCA fills, take-profit,
  risk states), so no candle after the open is skipped. Max-hold, emergency and end-of-data exits
  are priced at the bar close and stamped with the close time.
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

## Execution modes (`intrabarMode`)

The signal is always decided on the dataset interval (default 1h, or 1m); what changes is how
fills, take-profit, liquidation and exits are ordered within that bar.

| Mode | How intrabar order is resolved | Data needed | Speed |
|---|---|---|---|
| `bar` (default) | OHLC heuristic: fills first, then take-profit (dip-then-rally) | klines + mark klines | fastest |
| `refined` | Bars where a DCA limit is reachable are replayed from their aggTrades prints in order; other bars use `bar` | + aggTrades for those days (fallback if missing, counted in the result) | several seconds per 10 days |
| `tick` | Every aggTrades print is an event: funding at its timestamp, liquidation on each print and on the finest mark bar, DCA fills and take-profit on the print that crosses them, max hold on the first print past the limit | aggTrades for every day in the window (the run fails otherwise); window ≤ 31 days | about 1 s per million prints |

Signals are computed from bar closes and acted on at the next bar's first print in `tick` mode
(or the open in `bar` and `refined`), so no mode uses a future price to decide.

**Measured on BTCUSDT, 10 days (1–10 Nov 2026), 1h signal bars**

- `ema-trend`, DCA grid 0.2%, take-profit 3%: `bar` **−29.5%** (15 trades), `refined` and `tick`
  **+20.1%** (37 trades each). Refined and tick agree on every PnL-determining field except two
  entry/exit prices that differ by about 0.1 USDT (see the data check below).
- `ema-trend` and `macd` at 0.5% and 1% grids (3% and 10% targets), and `macd` at 0.2%: all three
  modes agree exactly. The OHLC ordering guess only changes outcomes when a bar can fill a DCA
  limit and reach the take-profit in the opposite order, so tight grids on coarse bars are where
  it matters. `ema-trend` at 0.2% is the case where it does.

**Data check.** The stored 1m klines were compared with the aggTrades prints of one full UTC day
(1,440 minutes). Close matches in all minutes; open in 97.1%; high and low in 99.8%. Largest
difference 0.4 USDT. About 62% of prints share a millisecond with a neighbour, and the archive's
aggregate-trade-ID order (the matching order) is what the reader keeps within a millisecond.

**Limits of `tick` mode**

- The archive has no mark-price ticks, so liquidation timing is bounded by the finest mark bar
  (1m). A breach of that bar's extreme counts as a liquidation at the first print inside it.
- Fixed-rate funding is accrued per signal bar, not per print. Historical funding is exact.
- Timestamps in `bar` mode are bar-resolution; `tick` stamps the actual print time.
- Max-hold and take-profit exits move to the print that triggers them, so holding times and
  excursions differ from `bar` even where the PnL matches.

## Rate limits and bans

Every outbound request goes through a gate in `src/lib/net/` (`throttle.ts`, `hosts.ts`), so
the limits hold across routes, browser tabs and runs.

**What the app sends to Binance**

| Host | Used for | Policy |
|---|---|---|
| `data.binance.vision` (archive) | klines, mark klines, funding, aggTrades, and a reachability probe | at most 4 requests/s (250 ms spacing), 2 in flight, 3 attempts; 429 or 418 pauses the host for 60 s or 2 min; a bare 503 gets a short backoff; `Retry-After` is honoured but never shorter than the minimum; a pause longer than 10 s fails the call at once |
| `data-api.binance.vision` (spot REST) | live ticker strip | 1 request/s, 1 in flight; 15 s server-side cache; a throttle is reported at once with `Retry-After`, never waited out |

**Other safeguards**

- The archive probe runs at most once a minute, however often the status endpoint is polled.
- A request may download at most **60** uncached aggTrades days (`NPRS_MAX_DOWNLOADS_PER_REQUEST`).
  Cached days are free. A tick window needing more is refused before any download starts.
- Concurrent callers share one probe and one ticker fetch per symbol set.
- During a cooldown, requests fail at once without contacting the host.
- The live counters (requests, throttles, errors, cooldown remaining) are in `/api/data/status`
  and in every backtest response under `network`.

**What is and isn't verified.** Binance's REST documentation (checked for this policy) defines
429 for over-limit, 418 for an IP ban that escalates from 2 minutes to 3 days, and a `Retry-After`
header on both. It doesn't publish the throttling rules for `data.binance.vision`, so the archive
policy is conservative rather than measured against a published limit. In the verification runs
no throttle response was received: a 40-day tick run made 32 archive requests (31 day downloads
and one probe), 46 status polls made none beyond the cached probe, and 30 ticker calls made one
spot request.

## Operations: responsiveness, memory and diagnostics

Large ingests (a 1m series is about 261k candles per symbol per six months) used to freeze the
server for up to a minute during the write. What changed:

- **Writes are multi-row raw INSERTs** (500 rows per statement, values bound as parameters),
  inside the same transaction as the delete, so a dataset is still replaced atomically. The
  previous Prisma `createMany` path cost about 130 ms of CPU per 1,000 rows.
- **The ingest yields to the event loop** between downloaded files and insert batches.
- **Archive files are inflated once**, with Node's native zlib (`src/lib/datasources/zip.ts`).
- **SQLite runs in WAL mode** with a busy timeout. Read-only routes (status, run list, run
  detail) use a separate read connection, so they do not queue behind a write.
- **Dataset coverage is cached** until a dataset write commits, so polling does not re-aggregate
  millions of rows.

Measured on a four-symbol 1m ingest (39 s, 33 status and static probes, all HTTP 200): status
median 19 ms (p95 501 ms; it was about 430 ms idle before the cache), peak server memory 587 MB
(it was 1.48 GB), worst event-loop block about 0.9 s (it was 62.6 s). The stored rows match the
archive: row counts, first and last timestamps, OHLCV sums and funding all agree.

**Diagnostics.** Start the server with `NPRS_DIAG=1` to log event-loop blocks above 150 ms with
timestamps, the worst block per 10 seconds, and the phases of each ingest write.

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
  lib/db.ts                   # Prisma client on the libsql driver adapter (singleton)
  lib/db-url.ts               # DATABASE_URL resolution (project-root relative), NPRS_ROOT
  prisma/schema.prisma        # Candle / FundingRate / BacktestRun / Trade / EquityPoint / RiskEvent
  prisma.config.ts            # Prisma 7 CLI datasource config (migrate / db push)
  **/__tests__/*.test.ts      # Jest: engine invariants, margin, validation, indicators, archive client
```

Stack: Next.js (App Router) + React 19 + TypeScript (strict), Tailwind v4 + shadcn-style
primitives, Prisma 7 + SQLite via `@prisma/adapter-libsql`, recharts 3 for the equity /
drawdown / price charts, Jest 30 for tests.

## Run it

```bash
bun install             # installs from bun.lock; prisma generate runs on postinstall
cp .env.example .env    # DATABASE_URL=file:./db/custom.db (relative to the project root)
bun run db:push         # create the local SQLite schema
bun run dev             # http://localhost:3000
```

Production-style run:

```bash
bun run build           # next build (standalone) + static/public copy
bun run start           # sets NPRS_ROOT to the project root, then runs the standalone server
```

Checks:

```bash
bun run typecheck       # tsc --noEmit (strict)
bun run lint            # eslint
bun run test            # jest: engine invariants, margin, validation, indicators, archive client
```

Toolchain notes:

- TypeScript is pinned to **6.0.x**: `typescript-eslint` (used by `eslint-config-next`) declares
  `typescript <6.1.0` and refuses TypeScript 7. Move to 7 once typescript-eslint supports it.
- Runtime data lives under the project root, never under `.next/`: `db/custom.db` and
  `.cache/binance/`. `NPRS_ROOT` tells the server where that root is, because the standalone
  server changes its working directory; `bun run build` wipes `.next/`.
- Relative `DATABASE_URL` paths resolve from the project root for both the Prisma CLI and the app.

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
