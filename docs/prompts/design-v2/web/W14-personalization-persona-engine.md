# W14 · Personalization (Module E) — 4-question questionnaire · persona resolver · Settings persona section · sidebar visibility matrix · PersonaPreview

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. Prerequisites: W00 (LayoutMenu, PersonaPreview, ViewSwitcher, sidebar hide mechanism), W01 (three dashboard layouts consume the persona). **`docs/personalization/PERSONALIZATION-STRATEGY.md` is the source of truth for schema/rules; the design governs look and flows.**

**Ticket:** `MONEY-{n}` "Persona engine v1" → `feat/MONEY-{n}` (Linear MONEY-999/1000/1004–1013 map in the strategy doc §13).
**Design sources:** `docs/design/v2-bundle/web/mod-e.jsx` (`P_DEFS` copy: Beginner "GUIDE ME — Sentences, not stats. 9 nav items. VaR/Greeks vocabulary banned." · Intermediate "KEEP ME SHARP — The default + tax-preview moat widget + insights feed." · Advanced "GET OUT OF MY WAY — 3-column dense terminal. Numbers first, adjectives never."; persona cards with Preview → / Apply; "Why am I seeing this layout?" card ("You answered '3-10 years' + 'keep me sharp' in the onboarding questionnaire (Jul 20). Persona changes presentation only — same computed numbers … Override it any time here."); per-widget overrides list (Tax-preview widget · Insights feed · VaR / risk tiles · Learning nudges); live/preview panel with "SAME DATA · … · Ask Sage — always here"; footer "BEGINNER HIDES: STRATEGY LAB · SIGNALS · RISK · TRADEBOOK · SCREENER · DEV CONSOLE (SIDEBAR 16 → 9). CHAT IS NEVER REMOVED."; questionnaire modal `QS` — 4 questions with options, "SKIP — KEEP MY CURRENT LAYOUT", result sticker "you're an intermediate — 'keep me sharp.'") · `Persona Dashboards.dc.html` (nav lists per persona) · `Module Specs A-H.dc.html` §E · `Spec v2` ViewSwitcher note ("this same component becomes its manual override").

## Read first
- `docs/personalization/PERSONALIZATION-STRATEGY.md` fully (§2 persona model 3 levels × 4 types; §3 inference signals + deterministic rules — TRADER: median hold < 14 d OR F&O share ≥ 25 % OR intraday; INVESTOR: median hold > 90 d AND turnover < 0.2; PORTFOLIO_MANAGER: brokers ≥ 3 OR portfolio > ₹50 L OR …; ties; confidence +0.05/night cap 0.95, contradiction −0.1; §4 questionnaire mapping; §5 memory; §7 sidebar matrix; §8 settings; §10 SEBI; resolution order MANUAL > INFERRED > QUESTIONNAIRE > DEFAULT)
- Prisma `InvestorProfile` (`riskAppetite`, `experienceLevel`, `confidence`, `seededFrom`, propensities), `PortfolioInsight`, `UserEvent`; `packages/core/src/investor/{profile,context,capture,concepts,mastery,signal-map}.ts` (`assembleUserContext`), `workers/src/processors/investor-rollup{,-logic}.ts` (nightly), `login-briefing.ts`
- `apps/web/app/welcome/client.tsx` (wizard: experience → goals → risk → … — reuse its answers rather than asking twice), `apps/web/components/Sidebar.tsx` (+ W00 hide mechanism), `CommandPalette.tsx`, `apps/web/app/settings/tabs/PreferencesTab.tsx`, `apps/web/lib/actions/preferences.ts` (W00 `viewPresets`, W01 `layoutOverride`)
- `apps/api/src/routes/v1/me.ts` (`PATCH /persona` is the **chat** persona — add a distinct `ui-persona`)

## Current state
`InvestorProfile` holds level + propensities, nightly rollup exists, `assembleUserContext` injects a profile block into chat; no `userType`, no provenance, no UI-preference model, no layout switching except what W00/W01 added as manual overrides.

## Build (flag `persona-engine`, default OFF; W01's `dashboard-v2` consumes the resolved persona when both are on)
1. **Schema (MONEY-999):** `InvestorProfile` += `userType` enum `FIRST_TIME|INVESTOR|TRADER|PORTFOLIO_MANAGER`, `personaSource` enum `DEFAULT|QUESTIONNAIRE|INFERRED|MANUAL`, `personaUpdatedAt`, `manualLevel?`, `manualType?`; new `UserUiPreference` (userId, layoutOverride `AUTO|BEGINNER|INTERMEDIATE|ADVANCED`, hiddenNavItems[], hiddenWidgets[], pinnedWidgets[], viewPresets Json — migrate W00/W01's `User.preferences` keys here with a script).
2. **Questionnaire (4 questions, ≤ 30 s, skippable)** as one added step in the welcome wizard (reuse existing answers: "How long have you been investing?" already exists as `experience` — map it) + "Retake questionnaire · 30s" from Settings: Q1 investing tenure, Q2 "What do you check daily?", Q3 "Comfort with VaR, beta, drawdown?", Q4 "What should the dashboard do?" (Guide me / Keep me sharp / Get out of my way) → `experienceLevel` + `userType` + layout with `personaSource = QUESTIONNAIRE`, confidence 0.6; skip → DEFAULT (BEGINNER, 0.1) per the doc. Result sticker copy per design.
3. **Deterministic classifier** (`packages/core/src/investor/persona-classifier-logic.ts`, pure, exhaustively tested at every boundary: hold-days 14/90, F&O 25 %, brokers ≥ 3, ₹50 L, intraday present, turnover 0.2, tie rules) run inside the nightly `investor-rollup` and immediately post-first-sync; writes `seededFrom` audit + confidence growth; **never silently overrides MANUAL** — a contradiction for 60+ days creates a `PortfolioInsight` of type `persona_shift` → soft in-app prompt; user confirms.
4. **Resolver** `resolvePersona(profile, uiPrefs)` → `{ level, type, source, confidence, layout, why }` (MANUAL > INFERRED > QUESTIONNAIRE > DEFAULT) replacing W01's `getPersonaAction` body; `why` is a human sentence built from `seededFrom` ("2 brokers, 47 trades/30d, F&O 38% → Advanced Trader").
5. **Layouts + sidebar matrix:** dashboard (W01) reads `layout`; sidebar visibility from the doc §7 table (Beginner hides Strategy Lab · Signals · Risk · Tradebook · Screener/Scans · Research List · Calculators · Document Vault · Dev console → 9 items); hidden ≠ gone (Command Palette keeps all routes; direct URLs still work); accent packs (INVESTOR: SIP tracker / MF overlap / dividends; TRADER: pairing win-rate + streaks, intraday P&L; PORTFOLIO_MANAGER: account switcher, report exports; FIRST_TIME: activation checklist + demo invite) as 2–3 swappable dashboard slots — implement the slot mechanism and at least one widget per pack (the rest as follow-ups listed in the PR).
6. **Settings → Preferences → "Personalization" section:** detected persona + why; override level/type (sets MANUAL); layout picker AUTO / B / I / A with `PersonaPreview` (Preview → / Apply / ✕ exit preview); nav-item checklist; per-widget show/hide; "Reset to recommended"; the W00 `ViewSwitcher` on Screener/Strategies becomes this system's manual override (same component, same store).
7. **Chat/research context:** persona block joins `assembleUserContext` (level/type/source — no advice changes, presentation hints only). Chat entry persists in all layouts (test).

## Data wiring
- Actions: `submitPersonaQuestionnaireAction`, `getPersonaAction` (resolver), `setPersonaOverrideAction`, `setUiPreferencesAction`, `resetPersonaAction`, `confirmPersonaShiftAction`.
- Services: `packages/services/src/persona.service.ts` (+ resolver logic in `packages/core/src/investor/persona-resolver-logic.ts`).
- Worker: `investor-rollup` calls the classifier; emits `persona_shift` insights.
- `apps/api` mirror in `/v1/me`: `GET /ui-persona`, `POST /ui-persona/questionnaire`, `PATCH /ui-persona` (override), `PATCH /ui-preferences` — mobile M12 (Home presets) + M19 consume.
- Analytics: PostHog events `persona_questionnaire_completed|skipped`, `persona_override_set`, `layout_switched` (prereq MONEY-904 events).

## Non-goals
LLM-based classification (never), memory extraction (W15), Beginner/Intermediate presets for Screener/Strategies beyond what W02/W03 shipped.

## Acceptance
- Classifier unit tests hit every rule boundary and tie; nightly run on a fixture user produces the expected `seededFrom` and confidence growth; MANUAL is never overwritten (test).
- Layout switch is instant (no reload) and persisted server-side; a second browser sees the same layout.
- Beginner never renders VaR/Greeks vocabulary (W01 lint test re-run with the resolver) and shows exactly the 9 nav items; Command Palette still lists every route.
- Questionnaire skip → DEFAULT persona; retake from Settings overwrites QUESTIONNAIRE answers only (not MANUAL).
- TEST-COVERAGE.md; `verify:push`; `/code-review`.
