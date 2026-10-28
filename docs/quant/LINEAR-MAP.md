# Linear Map — Quant Platform

**Purpose:** the implementation prompts in `prompts/` reference issues as `{type}/MONEY-{number}`. This file resolves those placeholders to real Linear identifiers. Created by the `00-linear-setup.md` run on 2026-07-03 (+ round-2 sync same day).

- **Initiative:** [Quant Platform](https://linear.app/dis-digital/initiative/quant-platform-8ac278b3b55a) · Team **MONEY** · label `quant` on every issue
- **Issue ranges:** MONEY-940–998 (initial) + MONEY-1014–1047 (round-2 sync). 999–1013 belong to the Personalization/B2B projects (see bottom).
- **Urgent (P1) issues:** MONEY-973, MONEY-989, MONEY-1024
- `DECISION:` issues gate implementation tickets via Linear blocking relations — resolve them first.

## Project 1 — Quant: Market Data Warehouse · `prompts/01-market-data-warehouse.md`

| Issue      | Title                                                                        | Pri  |
| ---------- | ---------------------------------------------------------------------------- | ---- |
| MONEY-940  | Candle warehouse: Prisma model + GCS parquet layout + repository API         | High |
| MONEY-941  | NSE bhavcopy historical EOD backfill job                                     | High |
| MONEY-942  | Fyers History API v3 client + intraday backfill + daily incremental sync     | High |
| MONEY-943  | Route Yahoo price fetches through warehouse _(blocked by 1043)_              | Med  |
| MONEY-944  | FinanceDatabase seed + instrument enrichment                                 | Med  |
| MONEY-945  | Corporate actions adjustment pipeline (splits/bonus/dividends) for India EOD | Med  |
| MONEY-946  | Data-quality checks + staleness monitors                                     | Low  |
| MONEY-947  | Warehouse read API for quant-engine _(blocked by 940)_                       | High |
| MONEY-1043 | DECISION: DailyPrice + IntradayBar → Candle migration/coexistence plan       | High |

## Project 2 — Quant: Strategy & Indicator Library · `prompts/02-strategy-indicator-library.md`

| Issue      | Title                                                                                                             | Pri  |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | ---- |
| MONEY-948  | Scaffold packages/quant: Strategy DSL (Zod), types, registry                                                      | High |
| MONEY-949  | Prisma models: Strategy, Backtest, BacktestMetrics, Signal, Alert, ForwardRun, ExecutionOrder _(blocked by 1042)_ | High |
| MONEY-950  | Indicators (TS): Linear Regression Channel + Anchored VWAP with σ bands                                           | High |
| MONEY-951  | Indicators (TS): TRAMA (CC BY-SA attribution) + Volume Profile (POC/VAH/VAL)                                      | High |
| MONEY-952  | Indicators (TS, clean-room): Liquidity Swings + Trendlines with Breaks                                            | High |
| MONEY-953  | Built-in strategy pack (~16 doc-sourced combination strategies)                                                   | Med  |
| MONEY-985  | Golden test vectors + TS/Python parity harness _(blocked by 950/951/952)_                                         | High |
| MONEY-986  | Strategy CRUD + versioning (paramsHash) + lifecycle enum _(blocked by 949)_                                       | Med  |
| MONEY-1014 | Expose ALL existing indicators + patterns as DSL primitives _(blocked by 948, 1045)_                              | High |
| MONEY-1042 | DECISION: reconcile quant Alert/Strategy models with existing Alert + CustomStrategy                              | High |
| MONEY-1045 | DECISION: TS/Python indicator parity scope — ALL DSL primitives, not just the 7 custom                            | High |

## Project 3 — Quant: Python Backtest Engine · `prompts/03-backtest-engine.md`

| Issue      | Title                                                                                               | Pri  |
| ---------- | --------------------------------------------------------------------------------------------------- | ---- |
| MONEY-954  | Scaffold services/quant-engine: FastAPI + Dockerfile + Cloud Run deploy + OIDC                      | High |
| MONEY-955  | Metrics module incl. Deflated Sharpe                                                                | High |
| MONEY-956  | Parameter sweep + plateau heatmap output                                                            | Med  |
| MONEY-957  | Walk-forward runner + WF efficiency; CPCV + PBO                                                     | Med  |
| MONEY-958  | Backtest worker job (Pub/Sub backtest topic) + result persistence                                   | High |
| MONEY-959  | Backtest QA agent checks                                                                            | Med  |
| MONEY-960  | Perf & cost guardrails                                                                              | Low  |
| MONEY-995  | Python indicator lib: TA-Lib + pandas-ta-classic + 7 custom, parity-tested _(blocked by 985, 1045)_ | High |
| MONEY-996  | Vectorized backtester core _(blocked by 947, 948)_                                                  | High |
| MONEY-1015 | Monte Carlo module (shared path-simulation core) _(blocked by 954)_                                 | High |
| MONEY-1016 | Alpha attribution & signal-validation module _(blocked by 996)_                                     | High |

## Project 4 — Quant: AI Hedge Fund Agents · `prompts/04-ai-hedge-fund-agents.md`

| Issue      | Title                                                                                        | Pri  |
| ---------- | -------------------------------------------------------------------------------------------- | ---- |
| MONEY-961  | Persona agent framework: signal contract {-1..+1, confidence, reasoning}                     | High |
| MONEY-962  | 13 investor personas incl. Jhunjhunwala (adapt from virattt/ai-hedge-fund, MIT)              | High |
| MONEY-963  | Risk Manager agent: deterministic limits + LLM explanation                                   | High |
| MONEY-964  | hedge-fund-analysis skill + slash command + streaming UI                                     | Med  |
| MONEY-965  | market-regime skill (index trend/breadth/volatility)                                         | Med  |
| MONEY-966  | Agent eval harness: fixtures, deterministic replay, scoring                                  | Med  |
| MONEY-987  | Analyst agents: fundamentals, technicals, sentiment, valuation _(blocked by 948)_            | High |
| MONEY-997  | Portfolio Manager aggregation + verdict schema _(blocked by 962/987/963)_                    | High |
| MONEY-1017 | Bull-vs-bear debate rounds before PM verdict _(blocked by 997)_                              | Med  |
| MONEY-1018 | signal-factory skill (AlphaGPT pattern) _(blocked by 958)_                                   | High |
| MONEY-1019 | Earnings-call NLP signal extraction                                                          | Med  |
| MONEY-1020 | quant-knowledge ingestion pipeline (arXiv q-fin/SSRN/quant blogs)                            | Med  |
| MONEY-1021 | Orchestrator primitives (NO LangGraph): checkpointing, crash resume, WAITING_APPROVAL, retry | High |
| MONEY-1022 | Regime-aware position sizing in Risk Manager _(blocked by 963/965)_                          | Med  |

## Project 5 — Quant: Live Signals & Forward Testing · `prompts/05-live-signals-forward-testing.md`

| Issue      | Title                                                                                            | Pri  |
| ---------- | ------------------------------------------------------------------------------------------------ | ---- |
| MONEY-967  | signal-scan worker + Cloud Scheduler per timeframe (IST-aligned) _(blocked by 1044)_             | High |
| MONEY-968  | Signal persistence + idempotency + notification fan-out                                          | High |
| MONEY-969  | TradingView alert webhook ingest endpoint (HMAC-verified)                                        | Med  |
| MONEY-970  | ForwardRun shadow portfolio: virtual application of signals, equity curve                        | High |
| MONEY-971  | Live-vs-backtest drift monitor                                                                   | Med  |
| MONEY-972  | Signals dashboard + alerts UI (basic)                                                            | Med  |
| MONEY-988  | Signal-mode runner in quant-engine (closed bars only, warmup, paramsHash) _(blocked by 954/948)_ | High |
| MONEY-1023 | Live health monitor (Sharpe z-score, drawdown HALT, IC decay) _(blocked by 970)_                 | High |
| MONEY-1044 | Absorb existing strategy-scan + alert-evaluator workers into signal-scan design                  | High |

## Project 6 — Quant: Founder Live Execution (SEBI-compliant) · `prompts/06-founder-live-execution.md`

| Issue      | Title                                                                                                 | Pri        |
| ---------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| MONEY-973  | Order APIs in broker clients: placeOrder/modifyOrder/cancelOrder (Zerodha Kite)                       | **Urgent** |
| MONEY-974  | Fyers order placement implementation                                                                  | High       |
| MONEY-975  | Static IP + daily login ceremony flow + token handling                                                | High       |
| MONEY-976  | ExecutionOrder audit trail + broker orderbook reconciliation                                          | High       |
| MONEY-977  | Founder execution console UI (approve / pause / kill-all)                                             | Med        |
| MONEY-978  | SEBI compliance runbook (docs/quant/)                                                                 | Med        |
| MONEY-989  | Execution service: signal→order state machine, limits, ≤10 OPS budget, kill switch _(blocked by 968)_ | **Urgent** |
| MONEY-1024 | Execution & Live Data connector tab (Zerodha Connect out of portfolio-sync, founder-gated)            | **Urgent** |
| MONEY-1027 | Microstructure execution timing (LOB imbalance, limit-at-touch vs cross-spread) _(blocked by 1024)_   | Med        |

## Project 7 — Quant: US & Global Expansion · `prompts/07-us-global-expansion.md`

| Issue      | Title                                                                                       | Pri  |
| ---------- | ------------------------------------------------------------------------------------------- | ---- |
| MONEY-979  | EDGAR bulk ingestion: companyfacts.zip nightly → normalized fundamentals store (edgartools) | High |
| MONEY-980  | Stooq bulk EOD import for US symbols                                                        | High |
| MONEY-981  | us-fundamentals research skill + ratio engine (FinanceToolkit-style formulas)               | Med  |
| MONEY-982  | FX normalization (INR/USD) in portfolio + backtests                                         | Med  |
| MONEY-983  | quant-screener extension to US universe                                                     | Low  |
| MONEY-990  | Universe expansion: FinanceDatabase US/global into Atlas Search _(blocked by 944)_          | Med  |
| MONEY-1025 | Forensic scores layer (Altman Z, Piotroski F, Sloan accruals) _(blocked by 981)_            | Med  |
| MONEY-1026 | Filing diff (YoY 10-K/annual-report section diff) _(blocked by 979)_                        | Low  |

## Project 8 — Quant: UI & Charts · `prompts/08-quant-ui-charts.md`

| Issue     | Title                                                                                       | Pri  |
| --------- | ------------------------------------------------------------------------------------------- | ---- |
| MONEY-984 | Terminal-style command palette (keyboard-first)                                             | Low  |
| MONEY-991 | UDF datafeed endpoints over Candle warehouse for charting_library _(blocked by 940)_        | High |
| MONEY-992 | Chart page with our indicator overlays (bands, zones, profiles) _(blocked by 950)_          | High |
| MONEY-993 | Backtest results UI: equity curve, drawdown, trade list, sweep heatmap _(blocked by 958)_   | High |
| MONEY-994 | ForwardRun tracking UI (backtest vs forward equity) _(blocked by 970)_                      | Med  |
| MONEY-998 | Strategy Builder UI (rule editor + NL assist via strategy-builder skill) _(blocked by 986)_ | High |

## Project 9 — Quant: F&O Derivatives · `prompts/10-fno-derivatives.md`

| Issue      | Title                                                                                                             | Pri  |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | ---- |
| MONEY-1028 | F&O instrument master: expiries, strikes, lot sizes + FnoInstrument model                                         | High |
| MONEY-1029 | NSE F&O bhavcopy backfill (futures + options EOD) + option-chain EOD snapshots _(blocked by 940)_                 | High |
| MONEY-1030 | Fyers NFO intraday history backfill + incremental sync _(blocked by 942)_                                         | Med  |
| MONEY-1031 | Pricing lib: Black-76/BSM + IV solver + Greeks; MC multi-leg stress simulation _(blocked by 1015)_                | High |
| MONEY-1032 | F&O cost + margin model (STT verify-at-build, SPAN approximation, expiry handling) _(blocked by 996)_             | High |
| MONEY-1033 | F&O signal mode + founder execution: lot-aware sizing, expiry-aware exits, naked-short OFF _(blocked by 988/989)_ | High |
| MONEY-1039 | Continuous futures series builder (roll N days pre-expiry, back-adjusted) _(blocked by 1029)_                     | High |
| MONEY-1040 | Strategy pack B: multi-leg position groups _(blocked by 1031)_                                                    | Med  |
| MONEY-1046 | Strategy pack A: futures trend-follow, covered call, cash-secured put, protective put _(blocked by 1039)_         | Med  |

## Project 10 — Quant: Edge AI (Liquid LFM2/LEAP) · `prompts/11-edge-ai-mobile-desktop.md`

| Issue      | Title                                                                                          | Pri |
| ---------- | ---------------------------------------------------------------------------------------------- | --- |
| MONEY-1034 | Benchmark LFM2 model sizes on target hardware (macOS + mid-tier Android/iOS)                   | Med |
| MONEY-1035 | Routing design: on-device first, server fallback; privacy boundary doc                         | Med |
| MONEY-1041 | Prototype LEAP SDK integration: offline portfolio Q&A over synced snapshot _(blocked by 1034)_ | Med |
| MONEY-1047 | Go/no-go memo + cost comparison vs server-only _(blocked by 1041/1035)_                        | Low |

## Project 11 — Quant: Founder Tooling (Claude Code skills) · `prompts/12-claude-code-quant-skills.md`

| Issue      | Title                                                                                 | Pri |
| ---------- | ------------------------------------------------------------------------------------- | --- |
| MONEY-1036 | Skills: quant-market-data, quant-backtest, quant-research-validate                    | Med |
| MONEY-1037 | Skills: quant-signal-monitor (read-only), fno-analysis; edgartools MCP founder config | Low |
| MONEY-1038 | Six-Rings strategy-review template + runbook links inside skills                      | Low |

## Sibling epics (own Linear projects, NOT under the Quant initiative)

- **Epic 13 (`prompts/13-b2b-broker-mcp-platform.md`)** → project **B2B Platform — APIs & MCP Server**: MONEY-627–631 (June MCP epic) + MONEY-932–938 (July reorg) + MONEY-1001 (white-label MCP factory) · MONEY-1002 (neo-broker adapter spec) · MONEY-1003 (Broker-Sync-aaS). Licensing gate = MONEY-628/936 (Urgent).
- **Prompt 14 (`prompts/14-persona-dashboards-design.md`)** → project **Personalization — Persona Engine & Adaptive Dashboards** (spec: `docs/personalization/PERSONALIZATION-STRATEGY.md` §13): MONEY-999, 1000, 1004–1013 + moved-in MONEY-397/254. Design-run ticket = MONEY-1012.

## Suggested execution order

Per report §9: **1042/1043/1045 decisions → (Epic 01 ∥ Epic 02) → (03 ∥ 04) → 05 (after 1044) → 06 → 10; 07 after 01; 08 after 02/03/05; 11/12 anytime.**
