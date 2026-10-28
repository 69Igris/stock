# W00 · Shared design primitives + shell deltas (foundation — run first)

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt.

**Ticket:** create `MONEY-{n}` "Design v2 · shared primitives + shell" → branch `feat/MONEY-{n}`.
**Design sources:** `docs/design/v2-bundle/Module Specs A-H.dc.html` (section "NET-NEW COMPONENT INVENTORY"), `Spec v2 - Core Surfaces.dc.html` (ViewSwitcher, nav), `v2 Dashboard.dc.html` + `v2 Screener.dc.html` (`nav` arrays in the `renderVals()` script — the v2 sidebar), `Persona Dashboards.dc.html` (Beginner nav = 9 items), `web/wshell.jsx` (module-mockup shell), `styles/colors_and_type.css` (tokens; must match `apps/web/app/playful-app.css`).

## Read first
- `apps/web/app/playful-app.css`, `apps/web/app/(marketing)/playful.css`, `apps/web/tailwind.config.js`, `apps/web/app/layout.tsx`
- `apps/web/components/Sidebar.tsx` (nav config ≈ lines 200–380, mobile bottom nav ≈ 2340+), `apps/web/components/TopBar.tsx`, `apps/web/components/GlobalMobileBottomNav.tsx`, `apps/web/components/CommandPalette.tsx`, `apps/web/components/app/AppShell.tsx`
- Existing pieces to extend, not duplicate: `apps/web/components/stock/SectionShell.tsx` (`ProvenanceChip`, `SectionShell`), `apps/web/components/market/DelayedDataNote.tsx`, `apps/web/components/FeatureGate.tsx`, `apps/web/components/UpgradePrompt.tsx`, `apps/web/components/NoCreditDialog.tsx`, `apps/web/components/skeletons/*`, `apps/web/components/empty/*`, `packages/ui/src/*`
- Credits: `packages/core/src/subscription/plans.ts` (`CREDIT_COSTS`), `packages/services/src/credit.service.ts`
- Route gating: `apps/web/proxy-routes.ts`, `apps/web/lib/route-lists.ts`, `apps/web/lib/types/feature-flags.ts`

## Current state
The app already renders the "Playful" system (`.pf-*` classes, paper/ink/emerald tokens, `html.dark`). The design bundle tokens are a port of it — so this prompt adds **components and shell deltas only**; it must not touch token values. `ProvenanceChip` and `DelayedDataNote` exist; the rest of the inventory does not.

## Build
Create `apps/web/components/design-v2/` (one file per component, each with a `*-logic.ts` sibling where there is any decision logic, and a Storybook-free `__tests__/` render test):

1. `CreditChip` — `{ cost: number | keyof typeof CREDIT_COSTS, multiplier?: number }` → "⚡ 2 credits" (singular/plural), gold fill `--pop-2`, resolves action keys through `CREDIT_COSTS` and `getEffectiveCreditCost` so the number is never typed by hand. Variant `size: "sm" | "md"`.
2. `ProvenanceChip` — extend the existing one with `{ source, asOf, href? }` + a **neutral-label map** for vendor ids (Decision 06): `TIINGO_*`→"third-party tape", `DATABENTO`→"third-party tape", `EDGAR`→"SEC EDGAR", `NSE`/`BSE`→exchange, `DB_CACHE`→"DB cache", `YAHOO`→"Yahoo (delayed)". Unit-test the map.
3. `DataGapBanner` — `{ text, lastGood?: string, onRerun?: () => void, cost? }` amber band; affected values must render `—`.
4. `GateInline` — `{ tier: "PRO"|"PREMIUM"|"ULTIMATE", line, ctaHref="/pricing" }`, dark ink band with the tier tag + lock; never a modal. Reuse `useSubscriptionAccess`.
5. `LifecycleBadge` — `DRAFT → BACKTESTED → VALIDATED → FORWARD → RETIRED` with the fills from `v2 Strategies.dc.html` `LIFE` map; also `LifecycleSteps` (the 5-step row with the active step filled, others at 45% opacity).
6. `DelayedDataBadge` — compact "◷ EOD · JUL 18 CLOSE" pill built from the same provenance object `DelayedDataNote` consumes; accepts `asOf: Date` and formats IST.
7. `ConsensusBadge` — `{ models: number }` "verified across 2 models" with popover text; `disagree` state "models disagree — flagged for review" (the consuming section must withhold the number).
8. `VerdictCard`, `DebateTranscript` — Module B primitives (persona initials tile ±3° rotation, signal pill BULLISH/BEARISH/NEUTRAL, conviction meter 0–100, serif-italic thesis; collapsible rounds with speaker labels). Data contract in `packages/types/src/analysis` (add `AnalystVerdict`, `DebateTurn`).
9. `OverfitBadge` — `{ level: "low"|"medium"|"high", onExplain }` + `OverfitExplainerSheet` (copy verbatim from `web/mod-a.jsx` `WModal title="Overfitting risk — what we test"`).
10. `DualCurrency` — `{ inr, usd, primary: "INR"|"USD", fxRate, fxAsOf, fxKind: "SPOT"|"RBI_REF" }` renders primary large, secondary muted, stamp "SPOT ₹84.00/$ · 1H" or "RBI REF · TRADE DATE". Pure formatter in `dual-currency-logic.ts` (en-IN vs en-US grouping) — unit-test both.
11. `MemoryChip` — "remembering: …" + manage link (Module F).
12. `PersonaPreview` — wireframe tile (1/2/3 columns) used by the LayoutMenu and Settings.
13. `EvidenceLink` — "from 47 paired trades →" opens a sheet listing the trades.
14. `ViewSwitcher` — "VIEW: ADVANCED ▾" menu (Beginner / Intermediate / Advanced, one-line descriptions from `v2 Screener.dc.html` `viewOpts` and `v2 Strategies.dc.html` `viewOpts`), persisted **server-side per surface** (`User.preferences.viewPresets[surface]` via a new `preferences.ts` action `setSurfaceViewPresetAction`) with a localStorage mirror for instant paint. Footer line: "MANUAL PRESET — PERSONA ENGINE TAKES OVER LATER".
15. `LayoutMenu` — dashboard "LAYOUT: {persona} ▾" (three options with `PersonaPreview` wireframes + "SAME DATA UNDERNEATH — WHY THIS LAYOUT?" link to `/settings?tab=personalization`).
16. `MarketPill` — `INDIA | US` stamped pill; renders the US option **only when** `us-stocks-listing` is on for the user (Decision 03: no gated state in production; the mockup's "Turn the flag on" card is demo-only). Third pill extensible.
17. `SourceBadge`, `ScanContextBar` — for the screener (W02).
18. `AlertSignalConfig` — one config component: schedule (EOD 16:05 IST default; intraday = PRO), channels (push / email / WhatsApp-PRO toggles), min-match threshold; `labels="alerts" | "signals"` swaps copy only. Persists to the existing `Alert` model (`kind`, `conditions`, `notifyChannels`) via `apps/web/lib/actions/alerts.ts`.

Shell deltas (behind `AppFeatureFlag` `design-v2-shell`, default OFF):
- Sidebar (from the v2 `nav` arrays): WORKSPACE: Dashboard · StockSage (AI badge) · Holdings · Watchlists · Tradebook · Portfolio Roast; DISCOVER: Markets · Screener (with "↳ Scans" child that deep-links `/discover/screener?rail=scans`) · Strategies ("LAB" badge) · Research List · News & Events; TOOLS: FIRE Calculator · Calculators · Risk Report · Tax Report · Document Vault; ACCOUNT: Brokers · Settings · Notifications. **No new top-level items** (Developer console lives under Settings; Signals under Strategies; Analyst Board launches from stock pages/Sage).
- Beginner persona hides (W14 provides the persona; this prompt provides the mechanism): Watchlists, Tradebook, Screener/Scans, Strategies, Research List, Calculators, Risk, Document Vault, Dev console → 9 visible items exactly as `Persona Dashboards.dc.html` §1a. Hidden ≠ gone: `CommandPalette` keeps every route.
- Topbar: credits chip ("⚡ 2") linking to `/settings?tab=plans`, market-status chip ("NSE OPEN · 09:42 IST"), dark toggle (already exists — verify it persists via the same key on every page).
- Mobile web bottom nav (`GlobalMobileBottomNav`): HOME · SCREENER · STRATEGIES · SAGE · YOU per the v2 mockups' mobile footer; keep the "✦ Ask Sage" FAB on desktop.

## Data wiring
- `setSurfaceViewPresetAction` / `getSurfaceViewPresetsAction` in `apps/web/lib/actions/preferences.ts` → `packages/services/src/preferences/*` → `User.preferences` JSON (`{ viewPresets: { screener?: "beginner"|"intermediate"|"advanced", strategies?: … }, layoutOverride?: … }`). Zod schema in `packages/validation`.
- `apps/api` mirror: `PATCH /v1/me/preferences` already exists — extend its schema with `viewPresets`; add the read to `GET /v1/me`.
- No other backend changes.

## Non-goals
Page rebuilds (W01+), persona inference (W14), any token/CSS changes.

## Acceptance
- Every component renders in light + dark and at 375px; each has a render test and (where logic exists) a logic test; `ProvenanceChip` neutral-label map tested; `DualCurrency` formatter tested for en-IN/en-US and both `fxKind`s.
- `ViewSwitcher` choice survives reload and appears on a second device (server-persisted); demo mode falls back to localStorage without erroring.
- With `design-v2-shell` OFF the app is byte-identical in behaviour; ON shows the v2 sidebar; Beginner hide-list applied when W14 provides a persona (until then, a query param `?persona=beginner` in dev only).
- `TEST-COVERAGE.md` updated; `verify:push` green; `/code-review`.
