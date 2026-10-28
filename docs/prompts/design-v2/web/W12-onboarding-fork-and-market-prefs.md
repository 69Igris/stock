# W12 · Onboarding fork ("Where do you invest?" + "Where do you live?") · Settings → Market preferences · connected US accounts · US data disclosure

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. Prerequisite: W00. This prompt **owns the persona fields** (`market`, `residency`, `primaryCurrency`) that W01/W08–W11 and the mobile US module consume — run it before them (or first among them).

**Ticket:** `MONEY-{n}` "US persona — onboarding fork + market preferences" → `feat/MONEY-{n}`.
**Design sources:** `docs/design/v2-bundle/v2 US Launch.dc.html` "STEP 04 OF 05 · Skip for now · Where do you invest?" (options India / United States / Both with sub-copy; "Question one of two. Sets your currency and which connection we offer first. Editable in Settings."), "QUESTION TWO · BECAUSE YOU PICKED US · Where do you live right now?" (In the US — "H-1B, green card, citizen. You hold US brokerage accounts and think in dollars." · $ PRIMARY · LINK A BROKERAGE FIRST / In India, investing via LRS — "You remit under LRS through Vested, INDmoney or a direct broker. You think in rupees." · ₹ PRIMARY · IMPORT A STATEMENT FIRST · LRS TRACKER ON), footer honesty line ("US quotes are end-of-day at launch — every price says so…"), "← Back / {forkCta}"; "Market preferences." (SETTINGS · PREFERENCES · MARKET: "Markets & currency — Your two onboarding answers, editable." rows; "Connected US accounts — Via SnapTrade. Read-only. Revoke stops the sync and keeps your history." + Add account + "TOKENS ENCRYPTED AT REST · NO TRADING SCOPE, EVER · Revoke all US access"; "US data disclosure — What you're getting, and what you're not." four tags + prices/filings/fx/orders lines + disclaimer) · `app/s-us.jsx` `UsForkScreen`, `UsPrefsScreen` (also "Primary currency — The other always stays visible", "US market hours in ET/IST") · Decisions 03, 05, 06 · dashboard entry card "US markets are here" (dismissible) for existing users.

## Read first
- `apps/web/app/welcome/{page,client}.tsx` (the 5-step wizard: experience → goals → risk → step 4 → step 5 "Connect a broker"; `finish` completes onboarding), `apps/web/lib/actions/{walkthrough,user,preferences,gst-profile}.ts`, `packages/services/src/user{,-sync}.service.ts`, `preferences/*`, Prisma `User` (`preferredCurrency` exists — "INR" default; `preferences` Json), `InvestorProfile`
- `apps/web/app/settings/{client}.tsx` (tabs: account · plans · billing · usage · preferences · notifications · security · integrations · feedback), `settings/tabs/PreferencesTab.tsx`, `IntegrationsTab.tsx`, `primitives.tsx`
- `apps/web/lib/actions/feature-flags.ts`, `packages/core/src/market-data/us-market-access.ts` (email allowlist founder gate — not a product state), `apps/api/src/routes/v1/me.ts` (`GET /`, `PATCH /preferences`, `PATCH /persona` — the latter is the **chat** persona; do not overload it)
- W08 for the connected-accounts list contract.

## Current state
Wizard has 5 steps with no market question; `User.preferredCurrency` exists but nothing sets it from residency; no persona fields; Settings has no market section; US access is founder-allowlisted via flag + email.

## Build (behind `us-stocks-listing`; with the flag off nothing changes — Decision 03)
1. **Wizard step 4 (new, skippable):** "Where do you invest?" (IN / US / BOTH tiles) → if US or BOTH: "Where do you live right now?" (NRI vs LRS rows with the tags) → footer honesty line → CTA text follows the answer ("Next: link a brokerage" / "Next: import a statement" / "Next: connect a broker"). Existing step numbering shifts to 5 steps + connect; "Skip for now" keeps defaults (market IN, residency null, ₹).
2. **Existing-user entry:** dismissible dashboard card "US markets are here" (W01 slot) and the screener US pill (W02) deep-link to `/welcome?step=market` (the fork renders standalone, revisitable).
3. **Settings → Preferences → "Market preferences" section** (one new section; nothing else moves): rows "Where do you invest?" (India + US), "Residency" (US · NRI / India · LRS), "Primary currency" segmented $ / ₹ ("The other always stays visible"), "US market hours in" (ET/IST — derived from residency, overridable); "Connected US accounts" list (broker tile · name · positions · status ● synced 2h / ↻ re-auth / import-only · actions) + "Add account" + "Revoke all US access" (confirm sheet; revoking stops sync, keeps history); "US data disclosure" card (tags "◷ end-of-day prices · SEC EDGAR · spot FX hourly · RBI ref for cost · no live ticks · no execution" + the four lines + disclaimer); "LRS tracker assumptions →" row for LRS persona (W11).
4. **Persona rule engine:** `residency` drives `primaryCurrency` default (NRI → USD, LRS/India → INR), connect-path order (W08), LRS visibility (W11), US hours display; user override of currency persists. Expose `getMarketPersonaAction()` used by W01/W08–W11 and mobile.

## Data wiring
- Prisma `User`: add `market` enum `IN|US|BOTH` (default IN), `residency` enum `INDIA|US|INDIA_LRS` (nullable), keep `preferredCurrency` as the primary-currency override, `marketPrefsUpdatedAt`. (Decision 05: "needs market, residency, primaryCurrency on the profile".)
- Actions: `setMarketPreferencesAction({market, residency, preferredCurrency?})`, `getMarketPersonaAction()`, `dismissUsIntroCardAction()` (walkthrough versions pattern), `revokeAllUsAccessAction()` (delegates to W08 service).
- Services: `packages/services/src/preferences/market-preferences.ts` + `market-persona-logic.ts` (derivations above — unit-tested for every combination incl. "US only" residency null).
- `apps/api` mirror: `GET /v1/me` includes `marketPersona`; `PATCH /v1/me/market-preferences`; `GET /v1/me/us-disclosure` (static copy — so mobile shows identical text).
- Analytics: PostHog event `market_persona_set` (no PII beyond the enum values).

## Non-goals
Tier gating for US (Decision 03 — "designed later"), SnapTrade linking itself (W08).

## Acceptance
- Flag off: wizard has today's steps; Settings unchanged. On: the fork appears as step 4, is skippable, and answers persist to `User`; revisiting from Settings pre-fills.
- Derivation table tested: NRI → $ primary + link-first + LRS hidden; LRS → ₹ primary + import-first + LRS on; India-only → nothing US.
- "Revoke all US access" removes SnapTrade connections and keeps imported history (functional test with a fixture connection).
- Disclosure copy served from one source for web + API (contract test compares).
- TEST-COVERAGE.md; `verify:push`; `/code-review`.
