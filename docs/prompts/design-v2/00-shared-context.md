# 00 · Shared context for every Design-v2 build prompt

> Every prompt in `docs/prompts/design-v2/` starts with: **"Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt."** Do not skip it. It carries the rules that are not repeated per prompt.

## 1. What you are building from

- **Design bundle (source of truth for look, copy, states):** `docs/design/v2-bundle/` — a Claude Design export (project `68d59c1e-f5a8-4f1a-b97c-f390a6ff3fee`, last synced to `main` 2026-09-06). If the folder is missing, the same bundle lives at `~/Downloads/usemoney-android-app-review/project/`.
  - `*.dc.html` files are spec/decision canvases and interactive mockups. Read the HTML text **and** the `class Component … renderVals()` script inside each — that is where labels, states, and demo data live. Mockup data: `web/v2data.js`, `web/wdata.js`, `app/data.js`.
  - `web/mod-a.jsx … mod-h.jsx` = Modules A–H mockups; `web/wshell.jsx` = web shell used by those mockups.
  - `app/*.jsx` = the mobile v2.1 app (registry in `app/root2.jsx`, shell in `app/shell2.jsx`, primitives in `app/kit2.jsx`, screens in `app/s-*.jsx`). `src/*.jsx` = baseline public/auth screens the mobile app reuses.
  - `styles/colors_and_type.css` = tokens. **It is a 1:1 port of `apps/web/app/playful-app.css`** — the repo CSS is the source of truth; never restyle the app, reuse `.pf-*` classes + shadcn primitives from `@usemoney/ui`.
  - `HANDOFF-README.md` explains the bundle. Do NOT screenshot the mockups; read the source.
  - Superseded material: `Module Specs A-H.dc.html` §C (standalone Signals surface), §A's IA, §E's dashboard, §H's placement, and `Module D - US Launch.html` are superseded by `Spec v2 - Core Surfaces.dc.html` and `v2 US Launch.dc.html`. Analytics content of A, and all of B/F/G stand.
- **Decisions log:** `docs/design/v2-bundle/Decisions - US Launch.dc.html` (9 decisions, read the `rows` array in its script). They bind every US surface: EOD-only US quotes; spot FX (hourly) for values vs RBI reference rate of trade date for cost basis/LRS — never mixed; no pre-GA/waitlist (flag off = layer absent; tier gate at launch); SnapTrade for US retail brokers, IBKR direct not a product path; persona from two onboarding questions; vendor never named in UI ("third-party consolidated tape"); US lands inside the v2 set; mobile gets the full US layer; StockSage US research is a flagged arm.
- **Prior planning docs (read when a prompt points at them):** `docs/personalization/PERSONALIZATION-STRATEGY.md`, `docs/quant/LINEAR-MAP.md`, `docs/setup/us-feature-flags-setup.md`, `docs/reference/*`. Quant-engine prompts (00–14) live outside the repo at `~/Developer/UseMoneyAI/archive-docs/quant-prompts/`; SnapTrade prompts (P18–P33) are committed at `docs/prompts/us-fullstack/snaptrade-prompts-P18-P33.md`. Its references are also committed: `docs/reference/snaptrade-multi-broker-plan-sep2026.md` and `docs/reference/crypto-venues-live-data-and-multi-asset-sep2026.md`. The archive-docs original is `claude-code-prompts-snaptrade.md`.

## 2. Repo laws (non-negotiable)

1. **Write path (web):** Component → Server Action (`apps/web/lib/actions/*.ts`) → Service (`packages/services/src/*.service.ts`) → Prisma (`packages/database`). Components and routes never call Prisma. Pure decision logic goes in a sibling `*-logic.ts` so it is unit-testable without mocks.
2. **Mobile parity (MONEY-401/402):** mobile talks only to `apps/api` (`/v1/*`, Hono, Clerk JWT, Cloud Run). `apps/api` never imports from `apps/web`. **Whenever a server action with mobile relevance is added or changed, mirror it in `apps/api/src/routes/v1/*`** — same service, same Zod schema, same entitlement gate, same sanitized errors. The `V1_ENDPOINTS` family count is pinned at **38** by `apps/api/__tests__/routes/v1-helpers.test.ts` and `parity-p14-discover-sections-contract.test.ts` — prefer sub-paths inside an existing family; if you add a family, update both tests deliberately.
3. **Numbers are computed or absent.** No placeholder stats, no defaults that look like data, no `NaN`/`Infinity`/`Invalid Date` (use the repo's `finite()` guards). Degraded sources render `DataGapBanner` and `—`, never stale values silently.
4. **Copy is SEBI-safe (India) and "not investment advice" (US).** Education/analysis framing; personas/layouts change presentation, never recommendations. Backtests/ForwardRun carry "historical simulation including costs — not indicative of future returns" / "hypothetical — no real orders were or can be placed". No order buttons anywhere.
5. **Gating is inline, never modal-spam:** FREE / PRO / PREMIUM / ULTIMATE via `packages/services` entitlements; metered actions show a `CreditChip` with the real cost from `packages/core/src/subscription/plans.ts` `CREDIT_COSTS`; consume on accept, refund on failure (mirror `apps/web/lib/actions/research.ts`).
6. **Feature flags:** PostHog via `apps/web/lib/actions/feature-flags.ts`; types in `apps/web/lib/types/feature-flags.ts` (`AppFeatureFlag`, `UsFeatureFlag`: `us-stocks-listing`, `us-stocks-search`, `us-broker-ib`, `global-mf`, `us-stock-research`). New surfaces ship behind a flag, default OFF, legacy chrome stays default until flipped.
7. **Chat entry is always present** (Sage FAB / composer / "Ask Sage" affordance) — no persona or layout removes it.
8. **Currency:** ₹ en-IN grouping, $ en-US grouping; dual display via the `DualCurrency` component with an FX-as-of stamp; IST timestamps; US market hours shown in IST (ET primary only for the NRI persona).
9. **Demo mode** (`apps/web/lib/demo`, HMAC cookie) must keep working on every touched page — demo data for every new tile/state.
10. **Security:** never log tokens; sanitize errors (`@usemoney/utils`); Zod-validate inputs; no `any`.

## 3. Named shared components (build once in W00, reuse everywhere by these names)

`CreditChip`, `ProvenanceChip` (exists: `apps/web/components/stock/SectionShell.tsx` — extend, don't duplicate), `DataGapBanner`, `GateInline`, `LifecycleBadge`, `DelayedDataBadge` (exists as `apps/web/components/market/DelayedDataNote.tsx` — add the compact badge variant), `ConsensusBadge`, `VerdictCard`, `DebateTranscript`, `OverfitBadge`, `DualCurrency`, `MemoryChip`, `PersonaPreview`, `EvidenceLink`, `ViewSwitcher`, `LayoutMenu`, `AlertSignalConfig` (one component, label-swapped "Alerts"/"Signals"), `MarketPill` (INDIA | US, extensible to a third pill), `SourceBadge` (ENGINE | CHARTINK | STRATEGY | YOURS), `ScanContextBar`.

## 4. Process rules (every prompt)

- Create the Linear ticket first (team `MONEY`); branch `{type}/MONEY-{n}` — text branch names are rejected by the pre-push hook.
- Read the referenced repo files BEFORE coding; verify every path in this prompt against the file system (files move).
- Tests: `node:test` + `node:assert/strict`; follow the `writing-tests` skill (unit for `*-logic.ts`, contract tests for API envelopes, functional for actions/services); no shadow tests; update `TEST-COVERAGE.md` (`yarn test:coverage-check` must pass).
- Update the relevant `CLAUDE.md` (root feature list / `apps/web/CLAUDE.md` / `apps/api/CLAUDE.md` / `apps/mobile/CLAUDE.md`).
- Finish with the `verify-before-push` skill (`yarn build` → `yarn test --force` → coverage check → runtime proof for any "wired" claim) and `/code-review` (money/credit/broker/user-data paths → `/code-review ultra`). This repo has no human reviewer.
- If a prerequisite named in the prompt is missing (a model, a route, an engine), **stop and say so** with the exact gap — do not fake around it. Build the seam (interface + honest empty state) and list it in the PR body under "Engine-gated".

## 5. Definition of done (template — every prompt's acceptance section refines it)

- Screen matches the named design file(s) at 1280px and 375px, light and dark (`html.dark`), including loading / empty / error / DataGap / gated / demo states.
- Every number on screen traces to a service call or is absent; zero hardcoded performance figures.
- Server action + service + Zod + entitlement + `apps/api` mirror shipped together; tests green; TEST-COVERAGE.md updated; `verify:push` green; `/code-review` done.
- PR description lists: design files implemented, flags added, endpoints added/changed, engine-gated seams, screenshots (light + dark).
