# W01 · Dashboard ×3 personas (`/dashboard`) + LAYOUT menu + US drop-ins

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. Prerequisite: W00 merged (LayoutMenu, PersonaPreview, DualCurrency, DelayedDataBadge, GateInline, CreditChip).

**Ticket:** `MONEY-{n}` "Dashboard v2 — three persona layouts" → `feat/MONEY-{n}`.
**Design sources (read all, in this order):** `docs/design/v2-bundle/Spec v2 - Core Surfaces.dc.html` §1C · `Persona Dashboards.dc.html` (web 1a/1b/1c — nav, copy, tiles) · `v2 Dashboard.dc.html` (the interactive mockup: read the `renderVals()` script — `pDefs`, `mstats`, `expo`, `usMkts`, `prompts`, `holdSrc`, `begUsLine`, and the four US deltas) · `web/v2data.js` `DASH` (demo data shapes) · `v2 US Launch.dc.html` section "FOUR DROP-INS · SURVIVE ALL THREE PERSONAS".

## Read first
- `apps/web/app/dashboard/page.tsx`, `apps/web/app/dashboard/client.tsx`, `apps/web/components/dashboard/DashboardOverview.tsx` (1,328 lines — the current single layout: stat strip, performance + Ask Sage, top holdings + side cards, IPO card, overview hub with QUICK/BROWSE), `apps/web/components/dashboard/LoginBriefingCard.tsx`
- `apps/web/lib/actions/dashboard.ts` (`getDashboardStatsAction`, `getPortfolioReturnsAction`), `packages/services/src/dashboard.service.ts`, `packages/types/src/dashboard/index.ts` (`DashboardStats`, `PortfolioReturns`)
- Data the layouts need that exists elsewhere: `apps/web/lib/actions/tax.ts` + `tax-ledgers.ts` (STCG/LTCG so far, harvest ideas), `roast-history.ts` (latest roast score + line), `watchlist.ts`, `alerts.ts`, `briefing.ts` (login briefing/insights), `risk.ts` (VaR/beta/max DD), `holdings.ts`, `news.ts` (holdings news), `discover.ts` (indices for the terminal header)
- `apps/web/lib/demo/*` (demo data must cover all three layouts)
- Persona source: until W14 lands, read `User.preferences.layoutOverride` (set by the LayoutMenu) and default to `intermediate`.

## Current state
One layout for everyone (`DashboardOverview`), server-warmed `initialStats` (MONEY-1126 — keep that pattern). No persona, no US awareness, greeting + briefing card + Ask Sage bar + holdings + compare-to-NIFTY + FIRE + roast + calculators + learn tiles.

## Build
One route, one data contract, three densities. Implement `apps/web/components/dashboard/v2/{DashboardV2,BeginnerLayout,IntermediateLayout,AdvancedLayout}.tsx` selected by `persona` and mounted by `client.tsx` when `AppFeatureFlag` `dashboard-v2` is ON (default OFF; legacy `DashboardOverview` stays the default). Header: greeting ("Morning, Rahul." / Advanced: plain "Dashboard"), `LayoutMenu` ("LAYOUT: {PERSONA} ▾"), status pill ("NSE OPEN · 09:42 IST · 3 BROKERS SYNCED ●"), credits chip. The `FLAG US ON/OFF` button in the mockup is demo-only — in production the US deltas appear iff `us-stocks-listing` is on AND the user has ≥1 US holding/account.

**Beginner — "Guide me"** (copy from `Persona Dashboards` §1a + `v2 Dashboard` `isBeg` branch): "ALL YOUR MONEY, EVERY BROKER" net worth (words + number: "Up ₹4,120 today — that's 0.24%. Nothing needs your attention." / US line when mixed: "Your US stocks haven't moved yet — their market opens tonight."), "WHAT YOU OWN, IN PLAIN WORDS" (holdings in sentences, `usHoldBeg` style), "ONE GOOD NEXT STEP" (exactly one action card — source: broker-attention > roast-ready > idle-cash > SIP nudge, in that priority; logic in `next-action-logic.ts`, tested), "LEARN THE BASICS" tile, "PORTFOLIO ROAST" teaser, Ask-Sage bar with the 3 beginner prompts from `DASH.prompts.beginner`. **Banned vocabulary (lint the layout's component tree with a test): XIRR, VaR, Greeks, beta, drawdown** — use "yearly growth rate", "worst fall".

**Intermediate — "Keep me sharp"** (default): stat strip (NET WORTH · TODAY · TOTAL RETURNS + XIRR), MY HOLDINGS snapshot (top 6, "+ 7 MORE → HOLDINGS"), "YOU VS NIFTY — 1Y" sparkline pair (`getPortfolioReturnsAction` + NIFTY series from `market/historical`), TAX PREVIEW — FY (STCG so far · LTCG so far · one harvest idea · advance-tax due line — from `tax` actions; render `—` + DataGap if the FY ledger isn't computed), INSIGHTS FEED (login briefing insights; keep `LoginBriefingCard` semantics), PORTFOLIO ROAST card (score + line), Ask-Sage bar with `DASH.prompts.intermediate`.

**Advanced — "Get out of my way"**: no greeting; 3 columns — left rail WATCH · CORE (watchlist rows + signal chips from W05 when present; until then price only) + SECTOR PULSE; centre `mstats` band (NET WORTH · [US BOOK] · DAY · XIRR · BETA · MAX DD from `risk` action; missing → `—`), EXPOSURE bars (by market when mixed, then sector), dense HOLDINGS table (SYM · QTY@AVG · LTP · VALUE · P&L% · DAY% · WT%), VS NIFTY sparkline; right rail Sage prompts (`DASH.prompts.advanced`), ALERTS (from `alerts.ts` + notification feed), ROAST, TAX — FY. Mono tabular everywhere, minimal padding.

**US drop-ins (all three personas, only when mixed):** net worth becomes `DualCurrency` (spot stamp), day-change tile gets the honesty line "India exchange-delayed. US as of yesterday's close — $0 today.", allocation gains an INDIA/US ring/bars, one compact "US MARKETS ◷ EOD" tile (S&P 500 · NASDAQ · USDINR spot; "YOUR US BOOK · OPENS 19:00 IST"), plus the LRS HEADROOM card **only for the LRS persona** (W11/W12 provide it; render nothing until then).

States: skeleton per layout (`apps/web/components/skeletons`), empty (no broker → connect CTA + demo invite, all three), partial (service timeout → tile-level DataGap, never a blank page), demo mode (demo data for every tile), persona switch is instant (no reload) and persists.

## Data wiring
- Extend `getDashboardStatsAction` → `dashboard.service.ts` with a **projected** `DashboardV2Payload` (parallel + Redis-cached like today): `{ stats, returns, taxPreview, roast, watchlist, insights, risk, exposure, usSummary? }` — one server round-trip warmed on the server (keep the 4s `withTimeout` pattern) and refreshed client-side. Add `dashboard-v2-payload-logic.ts` for the persona-independent projection and `next-action-logic.ts`; unit-test both.
- Persona resolution: `getPersonaAction` (new, in `preferences.ts`) → `layoutOverride` from `User.preferences` (W14 replaces the body with the real resolver; keep the signature).
- `apps/api` mirror: `GET /v1/dashboard` gains `?v=2` returning the same payload (same service); `PATCH /v1/me/preferences` accepts `layoutOverride`.
- Flags: `dashboard-v2` (AppFeatureFlag), reads `us-stocks-listing`.

## Non-goals
Persona inference/questionnaire (W14), US holdings/import (W08–W10), Signals data (W05), any change to `DashboardOverview` (legacy stays).

## Acceptance
- With `dashboard-v2` ON: switching LAYOUT re-renders instantly with identical underlying numbers across all three (test: same payload → same totals in each layout); choice persists server-side.
- Beginner layout contains none of the banned words (test walks the rendered tree); Advanced shows XIRR/BETA/MAX DD or `—`, never `NaN`.
- Mixed portfolio: `DualCurrency` + honesty line + US tile appear; India-only: none of them.
- Demo mode renders all three layouts; p75 server render not slower than today (measure with the existing Datadog RUM view for `/dashboard`).
- Tests + TEST-COVERAGE.md + `verify:push` + `/code-review`.
