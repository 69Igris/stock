# UseMoney Quant Platform — Research, Gap Analysis & Integration Plan

**Date:** 2026-07-03 · **Scope:** Backtesting, strategy library, multi-agent AI hedge fund, forward signals, founder-only live execution — India + US + global.
**Companion files:** `appendix-repo-audit.md` (full repo audit), `prompts/` (Claude Code + Cowork prompts).

---

## 1. Decisions locked in (from founder Q&A)

| Question              | Decision                                                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where does this live? | Both: UseMoney premium features + founder-only live algo layer                                                                                                                                                                           |
| Execution scope       | Live analysis from day one. Paper trading has been **removed** from the product (Prisma models remain as legacy; do not build on them — a lightweight `ForwardRun` shadow-portfolio model replaces it for strategy forward-testing only) |
| Engine                | Python service (Cloud Run) + TS orchestration in monorepo                                                                                                                                                                                |
| Data                  | India: free (bhavcopy, Fyers history, Yahoo). US: EDGAR + free sources. Founder-only Zerodha live data for testing                                                                                                                       |

---

## 2. Current state (repo audit summary)

Readiness: **AI research 8/10 · backtesting 6.5/10 · live trading 3/10**. Full detail in `appendix-repo-audit.md`.

**Already built and reusable:**

- `packages/research` — mature agent loop (`ResearchAgent` → Planner → Executor → Validator, 3 modes), 9 skills, 45+ tools, Gemini/Claude routing (MONEY-626). This is the chassis for multi-agent orchestration; we extend it rather than adopt LangGraph.
- Indicators: 24+ in `packages/research/src/lib/indicators.ts` + `packages/core/src/market-data/technical-indicators.ts` (SMA, EMA, RSI, MACD, BB, Stoch, ATR, ADX, Supertrend, PSAR, Ichimoku, OBV, VWAP session-basic, CCI, MFI, W%R, ROC, beta…), plus chart patterns (8) and candlestick patterns (10+). An `evaluateRule()` strategy-rule engine and a skeleton `backtest-strategy` tool exist.
- Quant math tools: VaR, drawdown profile, correlation matrix, concentration, beta drift — computed on current portfolio only, not historical simulation.
- Market data: Yahoo chart API (daily OHLCV, ~1y), NSE bhavcopy import, instrument master + Atlas Search, Redis L1/L2 cache. **No persistent OHLCV warehouse** (`DailyPrice` model exists, inactive).
- Brokers: 7 integrations, **all read-only**. No `placeOrder()` anywhere. Zerodha Connect founder OAuth exists; tick-streaming code dormant in `workers/src/connect`.
- Workers: 14 Pub/Sub job types on Cloud Run — the exact pattern a backtest job needs. All TS/Node; **no Python anywhere yet**.
- Charts: TradingView **Charting Library already vendored** (`apps/web/public/charting_library/`) + lightweight-charts 5.1 + klinecharts installed. Datafeed (UDF) not wired.

**Critical gaps (blocking):** no backtest engine, no `Strategy/Backtest/Signal/Alert` Prisma models, no order placement, no live-signal infra, no OHLCV warehouse, no Python service.

---

## 3. External research verdicts

### Adopt

| Source                                  | What we take                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **virattt/ai-hedge-fund** (58.8k★, MIT) | v1 agent graph: 13 investor personas (incl. **Rakesh Jhunjhunwala**) + 4 analysts (fundamentals/technicals/sentiment/valuation) → Risk Manager → Portfolio Manager. Persona prompts portable. v2 (WIP) is the spec for our Python service: `BaseSignal` ABC with [-1,+1] outputs, point-in-time data contracts, transaction-cost-aware vectorized backtester, CPCV + PBO validation, Almgren-Chriss execution sim. Its data layer (financialdatasets.ai) is US-only — we substitute our own adapters |
| **SEC EDGAR**                           | Free US fundamentals backbone: bulk `companyfacts.zip` + `submissions.zip` nightly downloads (avoids the 10 req/s API cap; descriptive User-Agent mandatory)                                                                                                                                                                                                                                                                                                                                         |
| **Stooq**                               | Free bulk EOD price dumps (US/global) for backtest backfill — use the DB dumps at stooq.com/db/h/, not per-symbol scraping                                                                                                                                                                                                                                                                                                                                                                           |
| **JerBouma/FinanceDatabase**            | 300k+ symbol universe (160k equities, 117 countries, sector/industry/ISIN/FIGI, Yahoo-format tickers incl. `.NS`/`.BO`) — one-time seed + enrichment for our Atlas instrument collection, not a runtime dep. FinanceToolkit's ratio formulas as reference spec                                                                                                                                                                                                                                       |
| **financial-datasets/mcp-server**       | The _pattern_ (financial data as MCP-style agent tools) — reimplement in TS over our own data layer. Their API: US-only, no real free tier ($20/1k req pay-as-you-go; **redistribution needs $2k/mo Scale plan** — internal agent use only, never display to users without that)                                                                                                                                                                                                                     |
| **financialdatasets.ai**                | Optional paid add-on for clean US structured data when agents need it ($20 credits for founder testing)                                                                                                                                                                                                                                                                                                                                                                                              |

### Skip (conceptual value only)

- **janestreet/\*** — all OCaml (core/async = stdlib+concurrency, magic-trace = x86 native profiler, hardcaml = FPGA). Zero reusable code for TS/Python. Take the discipline (expect-tests, "illegal states unrepresentable", deterministic market-data replay in tests), not code. They open-source infrastructure, never trading logic.
- **LLMQuant/quant-mind** — arXiv/RAG paper-ingestion pipeline, not a trading framework. We already have research + RAG seams (MONEY-781/782).
- **feremabraz/bloomberg-terminal** — 14-commit demo, simulated data. Steal terminal-UI ideas (command palette, dense panes) only.
- **Liquid4All/docs** — docs for on-device LFM models; irrelevant server-side. Revisit only for offline mobile inference.
- **Alpha Vantage** free tier (25 req/day) — dead end. **X links** — could not be fetched (X blocks unauthenticated reads); paste text if load-bearing.

---

## 4. Indicator library to add (exact math captured)

All seven targets are implementable from scratch; math + Pine translations are embedded in `prompts/02-strategy-indicator-library.md`. Licensing matters:

| Indicator                        | Source license            | Approach                                                                                                                                                    |
| -------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linear Regression Channel        | TV built-in (public math) | Implement: OLS over N bars (default 100), bands = ±2·σ(residuals, population); also max-deviation mode; expose Pearson R                                    |
| TRAMA (LuxAlgo)                  | CC **BY-SA** 4.0          | Port allowed with attribution; adaptive EMA, α = sma(newHH∨newLL, len)²                                                                                     |
| Liquidity Swings (LuxAlgo)       | CC BY-**NC**-SA           | **Clean-room re-implement the math** (pivot ±14, wick-extremity zones, volume/touch accumulation, break detection). Never port code                         |
| Trendlines with Breaks (LuxAlgo) | CC BY-**NC**-SA           | Clean-room: pivots ±14, slope via ATR/stdev/linreg ÷ length × mult, projected-line crossover breakout with one-shot latch                                   |
| EMA systems                      | public                    | 9/21 momentum cross + 50/200 golden/death regime filter (exists; add multi-EMA strategy wrapper)                                                            |
| VWAP                             | public                    | Upgrade existing session VWAP → **anchored** (any bar/event) + rolling + volume-weighted σ bands (±1/2/3)                                                   |
| Volume Profile                   | public                    | From OHLCV bins (uniform volume split across bar range; optional intrabar precision from 5m sub-bars): POC, 70% Value Area → VAH/VAL, fixed-range + session |

LuxAlgo premium signals cannot be pulled programmatically — Pine is closed; the sanctioned bridge is **TradingView alert webhooks** (paid TV plan) into our signal-ingest endpoint. LuxAlgo's PineTS transpiler is AGPL/commercial — skip.

---

## 5. Architecture

```
                    ┌────────────────────── apps/web (Next.js, Vercel) ──────────────────────┐
                    │  Strategy Builder UI · Backtest results · Signals dashboard · Charts    │
                    │  (TradingView charting_library + UDF datafeed / lightweight-charts)     │
                    └──────────────┬───────────────────────────────┬──────────────────────────┘
                                   │ tRPC/server actions           │ SSE/stream
              ┌────────────────────▼─────────────┐   ┌─────────────▼──────────────┐
              │ packages/research (TS)           │   │ packages/quant (TS, new)   │
              │ Multi-agent orchestration:       │   │ Strategy DSL, registry,    │
              │ personas → analysts → risk mgr → │   │ signal types, Zod schemas, │
              │ portfolio mgr (Gemini/Claude)    │   │ backtest client            │
              └────────────────────┬─────────────┘   └─────────────┬──────────────┘
                                   │ Pub/Sub                        │ HTTP (OIDC)
              ┌────────────────────▼────────────────────────────────▼──────────────┐
              │ services/quant-engine (PYTHON, new — Cloud Run)                    │
              │ FastAPI · in-house vectorized backtester (NumPy) · indicators      │
              │ (TA-Lib BSD + pandas-ta-classic MIT + custom Lux-math) · sweeps ·  │
              │ walk-forward · Deflated Sharpe · CPCV/PBO · signal mode            │
              └────────────────────┬───────────────────────────────────────────────┘
                                   │
    ┌──────────────────────────────▼───────────────────────────────────────────────┐
    │ Data plane: Candle warehouse (Mongo daily + GCS parquet intraday)            │
    │ India: NSE bhavcopy (EOD, official) · Fyers History API v3 (intraday, free) │
    │        · Yahoo .NS/.BO (adjusted closes) · Kite ₹500/mo (founder, backup)   │
    │ US/global: EDGAR companyfacts.zip (fundamentals) · Stooq bulk (EOD)         │
    │        · yfinance (dev) · FinanceDatabase (universe seed)                   │
    └──────────────────────────────────────────────────────────────────────────────┘
                                   │ signals (Pub/Sub)
              ┌────────────────────▼─────────────────────────────────────┐
              │ workers (TS): signal-scan per timeframe (Cloud Scheduler) │
              │ → Signal/Alert models → notifications → ForwardRun track  │
              │ → founder-only Execution service (Zerodha/Fyers orders,   │
              │   static IP VM, ≤10 OPS, kill switch, audit log)          │
              └───────────────────────────────────────────────────────────┘
```

**Key choices and why:**

1. **Backtester core: in-house NumPy vectorized simulator** (~300–500 lines) instead of vectorbt OSS. vectorbt is Apache-2.0 **+ Commons Clause** — selling a product whose value substantially derives from it is prohibited; safe paths are a written exception, PRO seats, or in-house. Since our indicator layer is custom anyway, in-house avoids legal review entirely. **NautilusTrader (LGPL, commercially safe)** is the phase-2 option for event-driven backtest↔live parity. Avoid backtesting.py (AGPL) and backtrader (unmaintained).
2. **Python indicator stack:** TA-Lib (BSD) + pandas-ta-classic (MIT, maintained fork; original pandas-ta is at risk) + our custom implementations for the 7 target indicators (must match the TS versions — golden test vectors shared between both).
3. **Backtest/live parity:** one strategy implementation, two runners. Signal mode feeds the same code the latest N closed bars (drop the forming bar), identical warmup, versioned paramset hash stored with every backtest and every live signal.
4. **Orchestration stays TS** in `packages/research` — no LangGraph. Personas/analysts/risk-manager/portfolio-manager become research skills + a new debate-style aggregation step.
5. **Founder gating** follows existing seams: CSV email allowlist env vars (à la `CLAUDE_ALLOWED_EMAILS`), kill-switch env var, default-off.

### New Prisma models

`Strategy` (rules JSON, params, version, owner, visibility), `Backtest` (strategyId, universe, range, costs config, status), `BacktestMetrics` (return, CAGR, maxDD, Sharpe, **Deflated Sharpe**, Sortino, winRate, profitFactor, trades, WF efficiency, PBO), `Signal` (strategyId, symbol, timeframe, direction, barTimestamp, paramsHash, indicatorSnapshot — idempotency key strategy+symbol+timeframe+barTimestamp), `Alert`, `Candle` (symbol, tf, ts, OHLCV, source — daily in Mongo; intraday parquet in GCS), `ForwardRun` (shadow portfolio for forward-testing, replaces removed paper trading), `ExecutionOrder` (founder live orders: signalId, brokerOrderId, state machine, audit).

---

## 6. Skills & agents inventory

### New research skills (extend the existing 9)

| Skill                     | Purpose                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `backtest-strategy`       | Replace skeleton: NL → strategy def → quant-engine run → metrics narrative               |
| `strategy-builder`        | NL → validated Strategy DSL (Zod), save/version                                          |
| `hedge-fund-analysis`     | Full multi-agent pipeline on a symbol/portfolio: personas + analysts → risk → PM verdict |
| `quant-screener`          | Multi-indicator screen across India/US universes (extends `stock-screener`)              |
| `signal-scan`             | On-demand signal-mode run of active strategies                                           |
| `market-regime`           | Index trend/breadth/volatility regime classification (gates strategies)                  |
| `walk-forward-validation` | Sweep + WF windows + DSR/PBO verdict on a strategy                                       |
| `us-fundamentals`         | EDGAR companyfacts Q&A, ratios via FinanceToolkit-style formulas                         |
| `risk-manager`            | Position sizing, portfolio limits, VaR/drawdown checks pre-trade                         |
| `trade-journal-analysis`  | User's actual PairedTradeView vs strategy signals — discipline analytics                 |

### Agent roster (multi-agent orchestration, TS)

- **Existing:** Planner, Executor, Validator, LoopController (keep).
- **Persona agents (prompt-level, run via Executor):** Buffett, Munger, Graham, Lynch, Burry, Druckenmiller, Wood, Taleb, Damodaran, Pabrai, Ackman, Fisher, **Jhunjhunwala** (India). Each returns `{signal: -1..+1, confidence, reasoning}`.
- **Analyst agents:** Fundamentals, Technicals (uses our indicator tools), Sentiment (news/filings), Valuation (DCF exists).
- **Risk Manager agent:** hard limits (max position %, sector exposure, VaR budget) — deterministic code + LLM explanation.
- **Portfolio Manager agent:** aggregates signals → action recommendation; founder-only can hand to Execution.
- **Execution agent (founder-only):** turns approved decisions into broker orders under SEBI constraints; never autonomous beyond configured limits; kill switch.
- **Backtest QA agent:** adversarial check on any backtest (look-ahead, survivorship, cost realism, DSR, param plateau) before results are trusted.

---

## 7. Compliance & licensing summary

**SEBI (fully in force since Apr 1, 2026), founder-only path:** no exchange registration needed at **≤10 orders/sec** (generic algo ID tagged by broker); **static IP mandatory** for order placement (Kite: up to 2 IPs, non-India OK — GCP Mumbai VM recommended; Fyers: whitelist in myapi.fyers.in); **one API key** per user for unregistered algos; **daily TOTP/OAuth login ceremony** (no permanent tokens); broker RMS is liable. Kite Connect: order+portfolio APIs free, data APIs ₹500/mo. If UseMoney ever offers algos **to users**, that's exchange empanelment territory — explicitly out of scope now; design the seam (per-user strategy registration ID field) but don't build.

**Licensing:** vectorbt Commons Clause (avoid/in-house), backtesting.py AGPL (avoid), NautilusTrader LGPL (OK), TA-Lib BSD (OK), pandas-ta-classic MIT (OK), TRAMA CC BY-SA (attribute), Liquidity Swings + Trendlines CC BY-NC-SA (clean-room math only), lightweight-charts Apache-2.0 (enable `attributionLogo`), TradingView Charting Library (already vendored — verify our B2B license agreement covers the new datafeed use), financialdatasets.ai (no redistribution below Scale), jugaad-data GPL (invoke as CLI tool, don't link).

---

## 8. Data matrix

| Market | Prices EOD                                                             | Prices intraday                                                                                                 | Fundamentals                                            | Universe                                            |
| ------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| India  | NSE bhavcopy (official, exists) + Yahoo adjusted                       | **Fyers History API v3** (free, official; 1–240m @100d/req, paginated unlimited lookback) · Kite ₹500/mo backup | Screener.in scraper (exists) + NSE/BSE filings (exists) | Instrument master (exists) + FinanceDatabase enrich |
| US     | Stooq bulk dumps + yfinance (dev-only; degrading — cache aggressively) | yfinance 60d limit (accept for MVP)                                                                             | **EDGAR companyfacts.zip** nightly bulk                 | FinanceDatabase (27k+ US via FD.ai optional)        |
| Global | Stooq + Yahoo                                                          | — (defer)                                                                                                       | — (defer)                                               | FinanceDatabase (117 countries)                     |

All candles land in the warehouse once; external limits only affect incremental sync.

---

## 9. Phased plan → prompts

| Phase | Epic                                                                                           | Prompt file                                  | Depends on      |
| ----- | ---------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------- |
| 0     | Linear projects + issues setup                                                                 | `prompts/00-linear-setup.md`                 | —               |
| 1     | Market data warehouse (Candle store, bhavcopy/Fyers/Yahoo backfill, FinanceDatabase seed)      | `prompts/01-market-data-warehouse.md`        | —               |
| 1     | Strategy & indicator library (7 new indicators TS+Python parity, Strategy DSL, models)         | `prompts/02-strategy-indicator-library.md`   | —               |
| 2     | Python quant-engine (backtester, sweeps, walk-forward, DSR/CPCV, costs)                        | `prompts/03-backtest-engine.md`              | 01, 02          |
| 2     | AI hedge fund multi-agent orchestration                                                        | `prompts/04-ai-hedge-fund-agents.md`         | 02              |
| 3     | Live signals + forward testing (signal mode, scheduler, alerts, TV webhook ingest, ForwardRun) | `prompts/05-live-signals-forward-testing.md` | 02, 03          |
| 4     | Founder-only live execution (order APIs, SEBI setup, kill switch, audit)                       | `prompts/06-founder-live-execution.md`       | 05              |
| 4     | US & global expansion (EDGAR, Stooq, universe, currency)                                       | `prompts/07-us-global-expansion.md`          | 01              |
| 5     | Quant UI & charts (strategy builder, results, signals dashboard, UDF datafeed)                 | `prompts/08-quant-ui-charts.md`              | 02, 03, 05      |
| 5     | F&O derivatives (futures + options: data, pricing/Greeks, strategies, execution)               | `prompts/10-fno-derivatives.md`              | 01, 03, 06      |
| 6     | Edge AI: Liquid LFM2/LEAP for mobile + desktop apps                                            | `prompts/11-edge-ai-mobile-desktop.md`       | — (spike)       |
| any   | Claude Code quant skills (SKILL.md files for founder research workflow)                        | `prompts/12-claude-code-quant-skills.md`     | 03 useful       |
| —     | Cowork live validation (TradingView + Zerodha/Fyers, local)                                    | `prompts/09-cowork-live-test.md`             | any built phase |

**Sequencing note:** 01+02 are parallel; 03+04 parallel after; 05 unlocks 06; 07/08 slot anywhere after their deps; 10 after 03+06; 11/12 anytime.

---

## 10. Open questions / risks (updated after founder round-2)

1. **Yahoo is confirmed temporary** — a real feed is planned. `CandleRepository` is the seam: every consumer reads the warehouse, never a provider directly, so the future feed is a new `source` + sync job, zero downstream changes.
2. **Charting Library license: CONFIRMED held.** Build the UDF datafeed on the vendored library as primary; lightweight-charts stays the embedded/secondary renderer.
3. **Intraday history depth** for India backtests is bounded by Fyers pagination effort — plan a one-time deep backfill job; Zerodha Connect (founder) historical API is the second deep source.
4. **F&O now IN SCOPE** (stocks + futures + options) — Epic 10.
5. **Compute cost** — see §14 cost & pricing model; per-tier caps are the margin lever.
6. **X articles received** (3) — integrated; see §13.

---

## 11. LangGraph decision — NO (verdict + evidence)

**Do not adopt LangGraph, in either language.** Evidence from reading our code and LangGraph 2026 docs:

What LangGraph would add that `packages/research` lacks: (a) durable per-superstep checkpointing — our Scratchpad is in-memory and persisted only at terminal states; a crash mid-RESEARCHING re-runs from scratch; (b) resume-without-rerunning-completed-nodes; (c) `interrupt()` human-in-the-loop approve/edit/resume — we only have cancel-by-poll. That's the whole list. Everything else it offers we already have: dependency-DAG parallel execution (maxConcurrency 3, layered `Promise.allSettled`), timeouts, deadlock detection, validation/refine loop, Mongo session persistence, progress streaming to UI, Gemini/Claude routing on raw SDKs.

What it would cost: rewriting agent/executor/loop-controller as StateGraph nodes (~4–8 weeks incl. re-testing the heavily-tested research package), wrapping 45+ tools into LangChain interfaces, dependency lock-in to an ecosystem with a history of breaking abstraction churn (0.x→1.0, agents→langgraph migrations), and for nothing: ai-hedge-fund's LangGraph usage is shallow (18 persona nodes fan-out/fan-in over a shared state dict) — our planner/executor DAG already expresses that shape natively.

**Instead: build the 3 missing primitives into our loop (~1.5–2.5 engineer-weeks total), tracked as issues in Project 4:** durable checkpointing (flush scratchpad + plan snapshot on each executor batch settle, ~2 days), crash resume (rehydrate plan on Pub/Sub redelivery of RESEARCHING sessions, skip re-planning, ~3–4 days), interrupt-for-approval (new `WAITING_APPROVAL` status + resume path, ~3–5 days incl. UI) — plus one retry-with-backoff for failed fetch-type tasks (half day). Note: LangGraph.js does have a MongoDB checkpointer at parity in 2026, so if we ever reverse this decision the migration path exists; revisit only if we need multi-day durable agent workflows.

## 12. RAG: ours vs LLMQuant/quant-mind (verdict + evidence)

**Keep our RAG infrastructure unchanged — it wins outright. Adopt quant-mind's content pattern, not its code.**

As infrastructure there is no contest: quant-mind's master branch today has **no vector store, no embeddings, and no retrieval** — the README's sources→parser→tagger→KB→embeddings→RAG pipeline is stale; the repo pivoted in April 2026 to a "domain library on OpenAI Agents SDK" and deleted `sources/`, `parsers/`, `tagger/`, `storage/` (their own CLAUDE.md contradicts the README; sqlite-vec storage, memory, DeepResearch and Data-MCP are explicitly roadmap/vision). Ours is production: Atlas `$vectorSearch` (native or cosine fallback) + managed Vertex RAG Engine behind the MONEY-781/782 seam with fail-closed per-user CEL filters and automatic corpus refresh, fed by a real ingestion chain (idempotent StockDocument upsert → Document AI OCR → 512-token section-aware financial chunker → text-embedding-004, gemini-embedding-001 behind flag).

What quant-mind has that we genuinely lack is **content scope**: our corpus is Indian filings, concalls, and user docs — zero academic/quant literature. Adopt (re-implemented in TS in our workers, ~1–2 weeks, Project 4 issue): a **`quant-knowledge` ingestion pipeline** — arXiv q-fin/SSRN/quant-blog fetchers → existing extract→chunk→embed chain → new docTypes (`research_paper`, `quant_note`) → agents cite literature when proposing/challenging strategies. Also adopt their schema discipline: mandatory `as_of` timestamp, typed `SourceRef` provenance, and a Gemini-Flash tagging taxonomy step on ingest. Skip: vendoring any quant-mind code (Python, mid-pivot, 3 contributors, whole packages deleted per PR), sqlite-vec, OpenAI Agents SDK coupling. Our one real infra gap noted in passing: **no hybrid (BM25+vector) retrieval or reranker on either backend** — worth a future ticket, unrelated to quant-mind.

## 13. Article & document integrations (5 X articles + MIT thesis)

**Article 1 — "Hedge Fund from AI Agents" (Phosphen):**

- **TauricResearch/TradingAgents (81.6k★)** — the structural idea worth stealing: an adversarial **bull-vs-bear debate round** between analyst outputs and the PM decision ("two agents arguing cancels a single model's confident wrong answer"). Added to Epic 4: `maxDebateRounds` config (default 2) — bull researcher and bear researcher argue over the aggregated analyst signals before Risk Manager/PM. We keep our TS orchestration; no need for their runtime.
- **dgunning/edgartools** (MIT, 2.3M downloads) — adopted as the EDGAR parsing library inside the Python quant-engine for Epic 7 (replaces hand-rolled XBRL parsing of companyfacts; keeps bulk-download strategy). Its MCP server also becomes a founder-side Claude Code tool (Epic 12).
- **Forensic scores layer** — Beneish M-Score (we already have `compute-accounting-quality`), add **Altman Z-Score, Piotroski F-Score, Sloan accruals ratio** to the ratio engine (Epic 7) and expose as screener filters + analyst-agent inputs ("run the forensic screen before reading the filing" ordering, exactly as the article argues).
- **OpenBB** — noted as reference cockpit; not integrated (heavy platform, we're building our own UI). **Polymarket toolkit** — out of scope (prediction markets ≠ our product).
- The article's 4-layer framing (L1 real data / L2 forensic screen / L3 filing diff / L4 agents) matches our architecture; L3 "filing diff" (YoY 10-K/annual-report diff, read only what changed) added as an Epic 7 issue feeding the Fundamentals analyst.

**Article 2 — Citadel order-book microstructure (Venus):**
We are explicitly NOT building HFT (colocation/FPGA/sub-µs is a different business). The transferable piece — per the article's own conclusion — is **execution timing for longer-horizon signals**: from Zerodha Connect WebSocket 5-level depth compute LOB imbalance `(bidDepth−askDepth)/(bidDepth+askDepth)`, volume-weighted mid, spread bps, trade-flow imbalance; the execution agent uses them to decide _limit-at-touch vs cross-the-spread_ on founder orders, targeting 1–2 bps implementation-shortfall savings, logged per order (Epic 6 issue). These same features become optional intraday strategy inputs later.

**Article 3 — AI quant workflows / AlphaGPT (Roan):** maps almost 1:1 onto our plan; deltas folded in:

- **Signal Factory (AlphaGPT pattern)** — new Epic 4 skill `signal-factory`: hypothesis-generator agent → DSL implementer → **adversarial challenger** (is it computable point-in-time? economic rationale or post-hoc story? regime dependence? what kills it?) → evaluator (runs Epic 3 backtest + validation) → **human review queue** (UI in Epic 8). Our Backtest QA agent already covers the challenger's statistical half; the factory adds hypothesis generation + economic-rationale challenge. Human gate is non-negotiable (matches our execution design).
- **Monte Carlo significance testing** — added to Epic 3 metrics: permutation/bootstrap distribution of matched random strategies → percentile of actual Sharpe (report alongside DSR/PBO), plus MC path simulation for drawdown distribution → feeds position sizing.
- **Earnings-call NLP extraction** — we already ingest concall transcripts into the corpus; new Epic 4 tool: structured signal JSON `{sentiment, managementConfidence, guidanceRevision, keyRisks, signal}` per transcript → Sentiment analyst + screener filter.
- **Regime-aware position sizing** — Epic 4 Risk Manager upgraded: Markov transition matrix over regime states (from `market-regime`) synthesized with realized vol, current drawdown, and signal strength → sizing recommendation.
- **Live health monitor** — Epic 5/6: rolling live Sharpe z-score vs backtest expectation (z < −2 → HUMAN REVIEW flag) + hard drawdown-limit HALT, thresholds defined **before** go-live in strategy config; feeds the kill-switch auto-trip.
- **Claude Code quant skills** — Epic 12: repo-local SKILL.md files (market-data-pipeline, backtest-with-validation, research-validation, signal-monitor, fno-analysis) so founder research sessions in Claude Code follow institutional guardrails by default.

**Article 4 — Linear-regression alpha framework (Roan):** becomes the statistical spine of Epic 3's validation module:

- **Jensen's-alpha factor regression** of strategy returns — `r = α + Σβ·factor + ε` against factor series we compute from the warehouse (market NIFTY/SPX, sector, momentum, size proxies) with **Newey-West (HAC) standard errors** (financial returns cluster; raw OLS p-values flatter the signal).
- Significance discipline: t-stat ≥ 3 bar for brand-new signals, **trials-aware Bonferroni threshold** wired to the same `n_trials` the Deflated Sharpe uses; enforced OOS split; low R² treated as normal for return prediction (0.9 R² triggers a look-ahead investigation, not celebration).
- **Information Coefficient**: per-period corr(factor value, forward return) → mean IC, IC stability (ICIR); reported on every backtest.
- New Backtest QA check: **BETA_ONLY flag** — strategy whose α loses significance once factors are stripped is disguised beta, verdict says so.
- **Alpha decay**: rolling-IC trend added to the Epic 5 drift monitor (decaying IC → strategy review flag). The article's closing point — the research engine that replaces signals is the edge, not any single signal — is exactly what the signal-factory + validation gauntlet operationalizes.

**Article 5 — Monte Carlo exotic-option pricing (Venus/RitOnchain):** NSE doesn't list Asian/barrier/lookback exotics, so we adopt the **framework, not the exotic payoffs**: one seeded, vectorized GBM path-simulation core in the quant-engine, reused for (a) MC significance testing (Epic 3), (b) strategy P&L / drawdown distributions for position sizing, (c) **multi-leg option-strategy stress simulation** (Epic 10: simulate underlying paths → reprice legs via Black-76 → P&L distribution of an iron condor before entering it). Adopted verbatim as engineering rules: antithetic variates always on, control variates where a closed form exists (geometric-Asian trick generalizes: use BSM European as control for path-dependent stats), importance sampling for tail/deep-OTM scenarios, **confidence intervals mandatory on every MC number**, fixed seeds for reproducibility.

**MIT thesis — "HFT System Design and Process Management" (Xiao):** the process-management blueprint; validates and formalizes our lifecycle design:

- **Six Rings checklist** (investment philosophy → strategies/models → risk & money management → disciplined processes → backtest & optimization → data & software) — adopted as the strategy-review template in the signal-factory human gate and the runbook.
- **OPM lifecycle states** → codified as enums: `Strategy.status = DRAFT → BACKTESTED → VALIDATED → FORWARD → LIVE → DEGRADED/RETIRED` (prototype untested/failed/accepted, generalized) and the trade-order machine (unverified/rejected/accepted) which our `ExecutionOrder` state machine already extends.
- **Two QA gates**: prototype QA (= Epic 3 validation gauntlet: OOS, WF, DSR, MC significance, factor regression) and production QA (= Epic 5 ForwardRun + health monitor) — both mandatory, matching the thesis's "backtesting and optimization without overfitting is the most important part."
- **Data cleaning as a first-class stage** (thesis Fig. 26) — already Epic 1 issue 8; elevated: no strategy may run on a symbol failing gap/anomaly checks.
- Emotion-free discipline + save-out-of-sample-data rules land in docs and the QA agent's checklist.

## 14. Cost & pricing model

**Variable cost estimates (Cloud Run ~$0.000024/vCPU-s; Gemini 2.5 Pro/Flash mid-2026 list):**

| Operation                                   | Compute             | LLM               | Est. cost                                                          |
| ------------------------------------------- | ------------------- | ----------------- | ------------------------------------------------------------------ |
| Single backtest (5y daily)                  | <1 vCPU-s           | 1 Flash narrative | <$0.01                                                             |
| 2,000-combo sweep                           | ~2–4 vCPU-min       | 1 Flash narrative | ~$0.01–0.02                                                        |
| Walk-forward + MC significance              | ~5–10 vCPU-min      | 1 narrative       | ~$0.03                                                             |
| Hedge-fund run (5-persona board)            | negligible          | ~10–15 calls      | Flash ~$0.02–0.05 · Pro ~$0.15–0.40 · Claude (founder) ~$0.50–1.50 |
| Signal scans (500 symbols × 4 tf, daily)    | batched             | none              | ~$5–15/mo total                                                    |
| Candle storage (India+US, 5y, EOD+intraday) | GCS parquet ~1–5 GB | —                 | <$1/mo                                                             |

**Fixed monthly:** Kite Connect data ₹500 · TradingView plan for webhook alerts ₹1.5–5k (tier by alert count) · static-IP NAT ~$10 · quant-engine scale-to-zero ≈ $0 idle · financialdatasets.ai optional $20 one-time credits · Datadog marginal on existing. **Total fixed ≈ ₹4–7k/mo.**

**Tier mapping (recommendation):**

| Tier             | Quant entitlements                                                                                                                                                   | Rationale                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| FREE             | Charts + all indicators (view), 3 prebuilt-strategy backtests/mo (daily tf, 1 symbol), delayed public-strategy signal feed                                           | Acquisition; cost ≈ ₹0                                                      |
| PREMIUM          | Strategy builder + combinations, 25 backtests/day, sweeps ≤200 combos, EOD+hourly scans on ≤20 symbols, hedge-fund lite (3-persona Flash board) 5/day, 3 ForwardRuns | Cost ceiling ≈ ₹50–150/user/mo at heavy use — fine at current PREMIUM price |
| PRO              | Intraday timeframes, sweeps ≤2,000, walk-forward + DSR + MC significance, full-board hedge-fund (Pro model) 10/day, F&O backtesting, 10 ForwardRuns, priority queue  | Heavy PRO user ≈ ₹300–800/mo cost → price PRO ≥ ₹2.5k/mo or meter           |
| Add-on packs     | Metered "compute packs" via Dodo one-time (e.g., +2,000 sweep combos / +10 Pro hedge-fund runs)                                                                      | Converts whales without raising base price                                  |
| Founder/internal | Execution layer + Claude models + live data — **never sold** (SEBI empanelment wall)                                                                                 | —                                                                           |

**Margin levers:** per-tier rate limits are the real control (LLM narrative is the dominant cost, not compute — cap Pro-model calls, default Flash); annual billing for PRO smooths spikes; env caps (`QUANT_SWEEP_MAX_COMBOS`, per-tier run quotas) enforced server-side from day one.

## 15. F&O scope summary (Epic 10)

Data: NSE F&O bhavcopy (EOD futures+options history, free/official) + Fyers NFO intraday history + Zerodha Connect live chain/depth (founder) + lot-size/expiry master from the Zerodha instruments dump (system key exists). Models: `FnoInstrument`, continuous-futures series (roll N days pre-expiry, back-adjusted), EOD option-chain snapshots (strike × {close, OI, volume, IV}). Engine: Black-76/BSM + IV solver + Greeks; margin approximation for backtests (documented heuristics; live margins from broker API); F&O cost model (futures STT 0.02% sell, options STT 0.1% premium sell — **verify current rates at build time**, ₹20/order brokerage); expiry handling (force-close before physical-delivery window by default). Strategies phase A: futures trend-follow (TRAMA/Supertrend/EMA on continuous), covered call, cash-secured put, protective put. Phase B: multi-leg position groups — spreads, iron condor, short straddle/strangle with stops, calendars. Naked-short options default OFF.

## 16. Edge AI (Liquid LFM2/LEAP) — mobile & desktop track

Since mobile + desktop apps are planned: a spike epic (11), not a production commitment. Evaluate LEAP SDK + LFM2 open-weight small models for **on-device** use: offline portfolio Q&A over a synced snapshot, local signal explanations, PII-sensitive document summarization that never leaves the device. Deliverables: model-size/latency/quality benchmark on target hardware (macOS + Android/iOS mid-tier), a prototype in a sandbox app, a routing design (on-device first, server Gemini/Claude fallback), and a go/no-go memo. Server-side quant stack is unaffected. Their docs MCP (docs.liquid.ai/mcp) can be added to founder Claude Code sessions during the spike.

## 17. Zerodha Connect → Execution Connector (founder)

Per founder decision: the Zerodha Connect (paid app) connector moves out of the portfolio-sync brokers list into its own **"Execution & Live Data" tab** (founder-gated, `CONNECT_FOUNDER_EMAILS` pattern): one connection powering BOTH live market data (WebSocket ticks, 5-level depth, historical candles — activates the dormant `workers/src/connect` code) and order execution (Epic 6). Fyers execution credentials live in the same tab. Portfolio-sync connectors (free Personal app) remain untouched. This gives the founder full live-data testing immediately while user-facing data continues via warehouse sources.

## 18. B2B / MCP platform — broker-house distribution (added 2026-07-03; was the missing section)

The original report covered internal features only; the B2B line researched Jul 2 is now specced as **Epic 13 → `prompts/13-b2b-broker-mcp-platform.md`** (includes the Claude Code build prompt). Summary:

- **Wedge:** Zerodha/Upstox/Groww ship official **single-broker raw-data** MCPs; the layer they won't build is multi-broker consolidated portfolio + FIFO pairing/tax + risk/roast/research. Paid-MCP billing rails matured in 2026 (Stripe MPP, Apify).
- **Mochatrade** (YC S26 neo-broker: US stock perps for Indians, 50x on Hyperliquid, FIU-IND in flight) = the buyer _archetype_ (thin-team broker, zero analytics), but SEBI/FEMA-gray — archetype yes, that specific partner not yet (MONEY-1002 gate).
- **Offer ladder (build order):** ① Tax & Pairing Engine API (pure compute — TradesViz/MProfit/Quicko) → ② Broker-Sync-as-a-Service (₹10–30/user/mo, per-end-user OAuth — MONEY-1003) → ③ hosted Portfolio-Context MCP → ④ white-label StockSage (HDFC Sky → Angel One → ICICI Sec → Kotak → 5paisa → Motilal; anti-targets: Zerodha/Groww/Upstox/Fyers) → ⑤ Roast/Risk widget. Sensibull broker-pays = commercial template; smallcase (MONEY-634) = complementary inbound.
- **Licensing gate (blocks GA):** sellable = user-consented broker data + bhavcopy-derived + pure-compute + EDGAR. Tickertape/Yahoo/Screener provenance never resold — enforced as a tool-manifest allowlist at the partner gateway (MONEY-628/936).
- **Readiness ~70%:** apps/api is the seam (Clerk in one middleware), 114 mostly-stateless research tools, video-studio McpServer precedent. Missing: Partner/ApiKey models, Redis quotas, metering/billing, webhooks-out, OpenAPI/sandbox.
- **Linear:** project _B2B Platform — APIs & MCP Server_ — MONEY-932–938 (reorg set) + MONEY-627–631 (June MCP epic, moved in 2026-07-03) + MONEY-1001 (white-label factory) / 1002 (neo-broker adapter) / 1003 (sync-as-a-service). Start after US beta stabilizes (~Aug); target Nov 30.
