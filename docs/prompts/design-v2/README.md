# Design v2 → build prompts (web · API · mobile)

Claude Code prompts that turn the Claude Design v2 project (`docs/design/v2-bundle/`) into the product. One prompt = one Claude Code session at the repo root. Written 2026-09-12 against `main` @ `c8129049` (branch `chore/MONEY-1395`).

## How to run one

1. Open a Claude Code session at the repo root; make sure `docs/design/v2-bundle/` is present (copied from the Claude Design export; if not, it is at `~/Downloads/usemoney-android-app-review/project/`).
2. Paste: `Read docs/prompts/design-v2/00-shared-context.md, then execute docs/prompts/design-v2/<file>.md end to end.` (The shared-context file carries the repo laws, design-reading rules, named components, process and definition-of-done that every prompt assumes.)
3. Create the Linear ticket first; the prompt tells you the branch type. Each prompt ends with the `verify-before-push` gate and `/code-review` — do not skip them; this repo has no human reviewer.
4. If a prerequisite the prompt names is missing, the session must stop and report the gap — never fake around it (see §4 of the shared context).

## Build order (dependencies)

```
W00 primitives+shell ──► W01 dashboard ×3 ──► W14 persona engine ──► W15 memory/DNA
      │                    ▲
      ├─► W02 screener ◄───┼── W03 strategies ──► W04 backtest+builder ──► W05 signals/forward run
      ├─► W06 stocksage+model picker ──► W07 analyst board
      └─► W12 market persona ──► W08 US connect+import ──► W09 US stock page ──► W10 mixed holdings ──► W11 LRS/TCS
                                  (needs SnapTrade P18 from archive-docs)
W13 settings→developer (needs Epic-13 MCP server; builds v1 if absent)

A01 chat stream + sync + push ──► M14 sage, M19 notifications
A02 native IAP (server)       ──► M19 plans

M00 workspace ──► M01 android · M02 ios ──► M10 shell ──► M11 onboarding/auth/first-run ──► M12 home · M13 portfolio · M14 sage · M15 discover · M16 instruments · M17 roast · M18 tools · M19 you ──► M20 US layer (needs W08–W12) · M21 web-v2 parity (needs W02–W05, W13) · M22 public screens
```

Suggested sequencing for one engineer + Claude Code: **W00 → W12 → W01 → W02 → W03 → M00 → A01 → M10 → M11 → M12 → M13 → M14** (a usable India mobile app + the two most-visited web surfaces), then US (W08 → W09 → W10 → W11 → M20), then the lab (W04 → W05 → W06 → W07 → M21), then W13/W14/W15, A02/M19 billing, M22, M15–M18 in parallel with any of the above.

## US track (cross-pack order) — added 15-Sep-2026

The data-platform pack (`docs/prompts/data-platform/`, plan v2.3 LOCKED 14-Sep) and the SnapTrade pack (`~/Developer/UseMoneyAI/archive-docs/reports/claude-code-prompts-snaptrade.md`, P18–P33) were written without reference to this one. `docs/prompts/cross-pack-reconciliation-sep2026.md` lists every dependency and collision with line references; this is the resulting order for the US surfaces.

```
A1 (done, MONEY-1466) ──► A2 tiles ──► A3 chart flip ──► A4 quotes        data-platform Track A = the shared serving layer
                                                             │
W00 ──► W12 ──► W09 (patched 15-Sep) ─────────────────────────┤
                                                             ▼
                    D3 signed-URL import ──► P18 SnapTrade rail ──► W08 ──► W10 ──► W11 ──► M20
                                                                      └─► P19…P29 per broker, behind their flags, any time after W08
C1 ──► C2 ──► C3 ──► C4   fills W09's EVENTS seam + US holdings alerts (after W09/W10, or with the missing-`market` arm)
```

Rules that came out of the reconciliation: W09 builds no candle read path (the chart is the shared `TradingViewAdvancedChart` on whatever A3 points it at); W08 follows P18's `BrokerType` names (`ROBINHOOD` + `rail: SNAPTRADE`; the `_SNAPTRADE` suffix only where a direct adapter coexists — IBKR, Zerodha, Upstox); FX is Decision 02 everywhere, including P18 §7 (spot for values, RBI reference for cost — P18 must not ship its own `FxRate`-by-display-date conversion); W08's 20 MB statement upload rides D3; every daily/intraday history read goes through `CandleRepository` or the market-data service, never `prisma.candle` (B6 shrinks the Mongo window). The only India prerequisites of the US track are W00 and W12 — whether it runs before or after the India-mobile sequence above is a priority call, not a dependency.

## Files

| # | File | Builds | Server deps |
|---|------|--------|-------------|
| — | `00-shared-context.md` | rules every prompt inherits | — |
| W00 | `web/W00-design-primitives-and-shell.md` | 18 named components, ViewSwitcher/LayoutMenu persistence, v2 sidebar, Beginner hide mechanism | — |
| W01 | `web/W01-dashboard-personas.md` | `/dashboard` Beginner/Intermediate/Advanced + US drop-ins | W00 |
| W02 | `web/W02-screener-unified.md` | `/discover/screener` scans rail, market pill, one search box, overflow; `/discover/scans` redirect | W00 |
| W03 | `web/W03-strategies-lifecycle.md` | `/strategies` Catalog/Custom/Signals, detail 4 tabs, Strategy/Backtest/Signal/ForwardRun models, `StrategyEngine` seam | W00 |
| W04 | `web/W04-backtest-results-and-builder.md` | backtest config/run/results, `LocalEngine`, rule builder → DSL | W03 |
| W05 | `web/W05-signals-forwardrun.md` | signal watches + evaluator, TradingView webhook, shadow portfolio | W03, W04 |
| W06 | `web/W06-stocksage-us-deltas-model-picker.md` | 8 StockSage US deltas, model picker (OpenAI/Claude gated), consensus badge, report provenance | W00 |
| W07 | `web/W07-analyst-board.md` | Analyst Board setup → hearing → verdict → share | W00, W06 |
| W08 | `web/W08-us-connect-and-import.md` | `/brokers` US section: SnapTrade link flow, statement import wizard | W12, SnapTrade P18 |
| W09 | `web/W09-us-stock-page.md` | `/stock/[symbol]` US variant (EDGAR sections, EOD chart) | W00, W06 |
| W10 | `web/W10-holdings-watchlist-tradebook-us-deltas.md` | by-market grouping, dual-currency totals, US lots in tradebook | W08, W12 |
| W11 | `web/W11-lrs-tcs-tracker.md` | LRS/TCS tracker (tax section + dashboard card) | W08, W12 |
| W12 | `web/W12-onboarding-fork-and-market-prefs.md` | onboarding fork, `market/residency/primaryCurrency`, Settings → Market preferences | W00 |
| W13 | `web/W13-settings-developer-mcp.md` | Settings → Developer, API keys, hosted MCP v1, provenance gate | W00 |
| W14 | `web/W14-personalization-persona-engine.md` | questionnaire, classifier, resolver, Settings persona section, sidebar matrix | W00, W01 |
| W15 | `web/W15-memory-and-trading-dna.md` | DNA metrics, MemoryItem + extraction, transparency center, chat chip, per-run toggle | W00, W14 |
| A01 | `api/A01-mobile-api-parity-chat-stream-sync-push.md` | `/v1/chat/stream` (SSE), `/v1/sync/summary`, `/v1/devices` + push, ETags, route inventory test | — |
| A02 | `api/A02-mobile-iap-billing.md` | StoreKit 2 / Play Billing receipts → Subscription ledger, webhooks, reconciliation | — |
| M00 | `mobile/M00-workspace-setup-expo-monorepo.md` | `apps/mobile` (Expo, Router, Clerk, API/SSE client, MMKV, kit, theme) | — |
| M01 | `mobile/M01-android-setup.md` | toolchain, FCM, signing, local AAB, Play readiness | M00 |
| M02 | `mobile/M02-ios-setup.md` | toolchain, APNs via FCM, capabilities, archive/TestFlight, App Store readiness | M00 |
| M10 | `mobile/M10-module-shell-navigation.md` | 5-tab shell, topbar, ticker, search overlay, sheets/toasts, aliases, flag-off | M00 |
| M11 | `mobile/M11-module-onboarding-auth-firstrun.md` | splash/onboarding/welcome, 11 Clerk screens, investor profile, connect→OAuth→sync→ready, demo | M10 |
| M12 | `mobile/M12-module-home.md` | Home ×3 presets + US drop-in | M10, (A01) |
| M13 | `mobile/M13-module-portfolio.md` | Holdings/Positions/Trades, sheets, CSV import | M10 |
| M14 | `mobile/M14-module-sage.md` | streaming chat, research confirm/progress/report, history, model sheet | M10, A01 |
| M15 | `mobile/M15-module-discover.md` | Markets/Screener(scans)/Sectors/News/Watchlists | M10 |
| M16 | `mobile/M16-module-instruments.md` | stock page, MF page, compare | M10, M13 |
| M17 | `mobile/M17-module-roast.md` | roast scope → run → verdict → share | M10 |
| M18 | `mobile/M18-module-tools.md` | FIRE, calculators, risk, tax, documents | M10 |
| M19 | `mobile/M19-module-you-account.md` | You hub, brokers, notifications, plans (IAP), settings, invite, help, feedback | M10, A01, A02 |
| M20 | `mobile/M20-module-us-layer.md` | 8 US screens + all US drop-ins | W08–W12 |
| M21 | `mobile/M21-module-web-v2-parity.md` | Screener v2, Strategies + detail, Settings → Developer | W02–W05, W13 |
| M22 | `mobile/M22-module-public-marketing-legal.md` | Explore hub + 16 public screens, `/v1/content` | — |

## Decisions baked into these prompts (Shaswat, 12-Sep-2026)

- Mobile = **Expo/React Native inside the monorepo** (`apps/mobile`), local builds (no EAS), one codebase with separate Android/iOS setup prompts.
- Web design applied by **re-skinning existing routes in place** behind per-surface flags (`design-v2-shell`, `dashboard-v2`, `screener-v2`, `strategies-v2`, `analyst-board`, `model-picker-v2`, `consensus-badges`, `developer-console`, `persona-engine`, `memory-dna`, `push-notifications`) — legacy stays default until flipped.
- **Quant engine:** UI now with engine-gated sections; `LocalEngine` (TS, cost-inclusive, no CPCV/PBO) until `services/quant-engine` ships; `LocalEngine` can never mark a strategy VALIDATED.
- **Mobile chat = SSE streaming from day one** (A01 extracts the web pipeline into a shared generator).
- **Mobile billing = native IAP** (A02); the design's UPI checkout screen is replaced by the platform purchase sheet.
- **Public/marketing/legal screens native** on mobile (M22), fed by a new public `/v1/content` surface.
- **US launch decisions** (from the design's Decisions log) are binding: EOD-only US quotes; spot FX for values vs RBI reference for cost/LRS; flag off = US layer absent; SnapTrade (PAYG real-time, read-only at launch, paid plans + allowlist); persona from two onboarding questions; vendor never named.

## Open items (need a call before the related prompt runs)

1. **Public Scan Library** — the Jul-29 consolidated design prompt asked for `/discover/scans` + `/discover/scans/{slug}` public SEO pages; the bundle does **not** contain them (it keeps scans native in the screener and redirects `/discover/scans`). W02 follows the bundle. If you want the library, it needs a design pass first.
2. **Sign in with Apple** — the design shows Apple as "SOON"; App Store guideline 4.8 requires it when Google sign-in is offered. Enable Apple in Clerk before the first iOS submission (M02 note).
3. **RBI reference-rate fetcher** is a stub (`fetchFromRbi` → null, MONEY-217). W08/W10/W11 depend on it; env-override rates work for QA but production needs the fetcher.
4. **StockSage US research arm** — no US tools in the research registry today; W06 adds EDGAR/EOD tools; until then the CTA stays gated (Decision 09).
5. **`V1_ENDPOINTS` count is pinned at 38** — A01 (`chat`/`sync`/`devices`), M22 (`content`), W13 (`mcp`) and data-platform C4 (`/v1/events?listing=`) may want new families (D3's `/v1/imports/upload-url` is a sub-path); each prompt says to prefer sub-paths or update the two count tests deliberately.
6. **Demo mode on mobile** — the web demo is an HMAC cookie; M11 must decide (demo user vs `X-Demo-Session`) — pick one and keep demo data identical to web.
7. **Vercel vs Cloud Run for `apps/api`** — settled by data-platform D4: `apps/api` is containerised as `usemoney-api` on Cloud Run (QA first, DNS cut ~wk 7–8 of plan v2.3). A01's SSE targets Cloud Run; run D4 (QA) before A01, or ship A01's `/v1/chat/stream` QA-only until the DNS cut.
8. **Currency column** on `Holding/Trade/Position` (SnapTrade plan) — W08/W10 assume it lands with P18; if P18 runs later, W08 adds it.
9. **Mobile daily bars (added 15-Sep)** — after data-platform A3 the web chart reads tiles from the market-data service; M16 (`/v1/market/historical`) and M20 (`/us/candles`, now removed from W09) would still read Yahoo-backed apps/api routes. Decide: mobile reads `${MARKET_DATA_URL}/udf/history` directly (public daily bars, CDN — recommended) or apps/api proxies the core tile reader. Intraday on mobile also needs `POST /v1/market/token` (A1 mints from web only).

## Design-file map (which bundle file answers what)

- Web IA + decisions: `Spec v2 - Core Surfaces.dc.html`, `Module Specs A-H.dc.html`, `Decisions - US Launch.dc.html`, `UseMoney v2 Hub.dc.html`
- Web mockups: `v2 Dashboard.dc.html`, `v2 Screener.dc.html`, `v2 Strategies.dc.html`, `v2 StockSage.dc.html`, `v2 Settings Developer.dc.html`, `v2 US Launch.dc.html` (+ data in `web/v2data.js`, `web/wdata.js`); Modules A–H in `web/mod-*.jsx`; `Persona Dashboards.dc.html`
- Mobile: `Design Review.dc.html` (rationale), `app/root2.jsx` (79-screen registry + flows), `app/shell2.jsx`, `app/kit2.jsx`, `app/s-*.jsx`, `src/*.jsx` (public/auth baseline), `frames/*`, `styles/colors_and_type.css`
- Source prompts that produced the design (context only): `~/Documents/Claude/Projects/UseMoney - Research/prompt-claude-design-*.md`, `prompts-claude-code-per-module.md`, `prompt-mobile-apps-implementation.md`, `prompt-apps-api-mobile-parity.md`
