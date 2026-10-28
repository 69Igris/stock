# docs/quant — Quant Platform Plan & Prompts

| File                                         | Purpose                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUANT-PLATFORM-REPORT.md`                   | Master report: research verdicts, gaps, architecture, skills/agents inventory, data matrix, SEBI + licensing, phased plan                               |
| `appendix-repo-audit.md`                     | Full repo audit (what exists, file paths, staleness)                                                                                                    |
| `prompts/00-linear-setup.md`                 | Claude Code prompt: create Linear initiative, 11 projects, ~90 issues (team MONEY)                                                                      |
| `prompts/01-market-data-warehouse.md`        | Epic 1: Candle warehouse, bhavcopy/Fyers/Yahoo backfill, FinanceDatabase seed                                                                           |
| `prompts/02-strategy-indicator-library.md`   | Epic 2: packages/quant, Strategy DSL, 7 indicators (exact math), Prisma models, strategy pack                                                           |
| `prompts/03-backtest-engine.md`              | Epic 3: Python quant-engine — vectorized backtester, costs, sweeps, walk-forward, DSR/CPCV                                                              |
| `prompts/04-ai-hedge-fund-agents.md`         | Epic 4: 13 personas + 4 analysts → Risk Manager → Portfolio Manager (TS, packages/research)                                                             |
| `prompts/05-live-signals-forward-testing.md` | Epic 5: signal mode, schedulers, alerts, TV webhook ingest, ForwardRun shadow ledger                                                                    |
| `prompts/06-founder-live-execution.md`       | Epic 6: order placement (Zerodha/Fyers), SEBI-compliant infra, kill switch, audit                                                                       |
| `prompts/07-us-global-expansion.md`          | Epic 7: EDGAR, Stooq, universe, FX                                                                                                                      |
| `prompts/08-quant-ui-charts.md`              | Epic 8: UDF datafeed, chart overlays, strategy builder, results UI                                                                                      |
| `prompts/09-cowork-live-test.md`             | Cowork prompt: live validation vs TradingView + Zerodha/Fyers on local machine                                                                          |
| `prompts/10-fno-derivatives.md`              | Epic 10: F&O — futures + options data, Black-76/Greeks, MC stress, strategy packs, execution                                                            |
| `prompts/11-edge-ai-mobile-desktop.md`       | Epic 11: Liquid LFM2/LEAP on-device spike (mobile/desktop apps)                                                                                         |
| `prompts/12-claude-code-quant-skills.md`     | Epic 12: repo SKILL.md files — founder research guardrails                                                                                              |
| `prompts/13-b2b-broker-mcp-platform.md`      | Epic 13: B2B partner APIs + hosted/white-label broker MCP servers (Mochatrade archetype, offer ladder, licensing gate) — includes Linear build prompt   |
| `prompts/14-persona-dashboards-design.md`    | Design prompt: 3 persona dashboard sets (Beginner/Intermediate/Advanced) via canvas-design — spec in `docs/personalization/PERSONALIZATION-STRATEGY.md` |

**Order:** 00 → (01 ∥ 02) → (03 ∥ 04) → 05 → 06 → 10; 07 after 01; 08 after 02/03/05; 11/12 anytime. Cowork validation (09) after any built phase. 13 (B2B/MCP) starts after US beta is stable (~Aug); 14 (persona dashboards) anytime — pairs with the Personalization project.

**Round-2 updates applied** (founder decisions + 5 X articles + MIT thesis): TV Charting Library license confirmed · Yahoo = temporary (warehouse seam) · Zerodha Connect → founder "Execution & Live Data" tab (data + execution) · F&O in scope · all indicators as composable DSL primitives + ~16 prebuilt combos · cost & pricing model (report §14) · LangGraph = NO (report §11) · our RAG kept, quant-mind ingestion pattern adopted (§12) · signal factory, debate rounds, MC significance, alpha/IC validation, health monitor, microstructure execution timing, forensic scores, edgartools (§13).
