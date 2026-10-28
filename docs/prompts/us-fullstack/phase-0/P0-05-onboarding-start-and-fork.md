# P0-05 · /start first-run + market fork + Settings → Market (W12 with deltas)

Ticket: MONEY-1623 (+ MONEY-1584) · Branch: `feat/MONEY-1623` (one PR closes both) · Flag(s): `us-onboarding` · Screens: S0.1 `/start`, S0.2 `/start/market`, S0.3 `/settings/market`, plus `/start/ready` · Depends on: P0-01, P0-02 · Parallel-safe with: P0-04

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.
> Then read **`docs/prompts/design-v2/web/W12-onboarding-fork-and-market-prefs.md`** — it is executed by this prompt WITH the deltas below. Where W12 and this file disagree, this file wins. Do not re-derive what W12 already specifies (fork copy, residency tags, disclosure copy, persona derivation table).

## Goal

A new user (flag on) accepts terms, answers two questions — where do you invest, and (if US) where do you live — then lands on ONE first-run screen whose primary action is "Connect Zerodha", secondary "Upload statement/CSV", and a text link "Just look around →". The 4-step goals/risk/style quiz is gone. The answers live on server-owned `User` fields written through the service contract, not in Clerk `unsafeMetadata`, and are editable in Settings → Market. With the flag off, nothing changes.

## Deltas from W12 (the whole point of this prompt)

| W12 says                                                                                         | This prompt does                                                                                                                 | Why                                                                                                         |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------- | --- |
| Fork is wizard step 4 of 5, behind `us-stocks-listing`                                           | Fork is `/start/market`, before `/start`, behind `us-onboarding`                                                                 | design review D21/D26; flag registry (P0-02)                                                                |
| Keep steps 1–4 (experience/goals/risk/style)                                                     | **Remove them** when the flag is on; flag off keeps today's wizard untouched                                                     | DS-IA1: "goals/risk/style no longer collected" (they were never read — design review live-flow audit)       |
| Step 5 "Connect a broker"                                                                        | `/start`: one primary block "Connect Zerodha", secondary "Upload statement/CSV", text link "Just look around →", coming-soon row | D21 "One primary, then secondary" (supersedes DS-RESP1's 3-cards-in-a-row)                                  |
| Settings section inside `PreferencesTab`                                                         | Own route `/settings/market` (like `/settings/investor-profile`), linked from `PreferencesTab`                                   | README screen catalogue S0.3                                                                                |
| "Connected US accounts" + "Revoke all US access" in Settings                                     | **Not here** — no US connection exists until Phase 3                                                                             | P3-03 adds it                                                                                               |
| `PATCH /v1/me/market-preferences`, `GET /v1/me/us-disclosure`, `marketPersona` on `GET /v1/me`   | ONE route pair: `GET`/`PATCH /v1/me/market`, disclosure copy included in the GET                                                 | fewer routes; one service                                                                                   |
| `market` enum default IN (required)                                                              | `market` **optional** (absent = IN at read time)                                                                                 | Mongo `db push` creates no field on existing docs; a required field missing on read throws; P0-07 backfills |
| `residency` `INDIA                                                                               | US                                                                                                                               | INDIA_LRS`                                                                                                  | same enum | —   |
| Investor profile saved to Clerk `unsafeMetadata` (`apps/web/app/welcome/client.tsx:173`, `:234`) | Market/residency/currency/onboarding state on `User`; never `unsafeMetadata`                                                     | MONEY-1623 "Must not" — the client can write `unsafeMetadata`                                               |
| "Skip · use demo"                                                                                | Legacy wizard: the button calls `finish()` (`welcome/client.tsx:636-640`) — rename to "Skip" (see demo note)                     | bug named in MONEY-1623                                                                                     |

**Demo note (read before building "Just look around").** `/start` is after sign-in (terms are accepted signed-in, `apps/web/components/TermsGate.tsx`). Demo mode cannot run for a signed-in user: `isDemoSession()` returns false whenever a Clerk user exists (`apps/web/lib/demo/session.ts:226-234`) and `DemoSessionGuard` clears the demo cookie on sign-in (MONEY-439). So for a signed-in user "Just look around →" = mark onboarded with path `explore` and go to `/dashboard` (its empty state lists the same paths). The real demo stays on the signed-out side (marketing "Take a Tour", `apps/web/app/(marketing)/home/client.tsx:66`) and P0-07's "Make this mine". This is a contradiction with the ticket text ("starts demo mode") — it is reported, not silently resolved; do not re-enable signed-in demo.

## Why / measured state today (verified 2026-09-24)

- `User` (`packages/database/prisma/schema.prisma:11`) has `preferredCurrency String @default("INR")` (`:19`), `termsAcceptedAt` (`:20`), `preferences Json?`, no market/residency/onboarding fields.
- The wizard: `apps/web/app/welcome/client.tsx` (730 lines) — `STEP_META` 5 steps; `persist()` writes `unsafeMetadata.investorProfile` (`:173`); `skip()` writes `skipped:true` (`:234`); "Skip · use demo" → `finish()` (`:636-640`).
- The gate: `TermsGate.tsx:67` `hasInvestorProfile = Boolean(user?.unsafeMetadata?.investorProfile)`; sequence terms → embedded `WelcomeWizardClient` → release walkthrough (`:130-160`). `/welcome` is excluded from the gate (`apps/web/lib/route-lists.ts:76`).
- `DashboardOverview.tsx:160` reads `unsafeMetadata.investorProfile.experience` to pick a dashboard variant; default is `"advanced"` (`:150`) — absent profile keeps the default.
- Currency write today: `updateCurrencyPreferenceAction` (`apps/web/lib/actions/user.ts:178`) calls `prisma` directly.
- Broker list is local to the page: `BROKERS` (`apps/web/app/brokers/client.tsx:87`), Zerodha live, 8 entries `comingSoon: true`.
- Zerodha OAuth success → `brokerSuccessRedirect` (`apps/web/lib/brokers/oauth-callback.ts:157`) → `/brokers?success=connected&broker=zerodha`. No "Ready" screen exists on web.
- `/v1/me` already has `GET/POST /terms` (`apps/api/src/routes/v1/me.ts:396`, `:418`).

## Read first (verified paths)

- W12 (above), `docs/design/v2-bundle/app/s-us.jsx` (`UsForkScreen` `:36`, `UsPrefsScreen` `:332`), `app/s-firstrun.jsx` (`ConnectIntroScreen` `:6`, `FirstReadyScreen` `:137`), `v2 US Launch.dc.html`
- `docs/gstack/ceo-review-2026-09-23-product-roadmap/product-plan-and-roadmap.md` rows DS-IA1, OV-2 (D21), OV-7 (D26), DS-ST3
- `apps/web/app/welcome/{page,client}.tsx`, `apps/web/components/{TermsGate.tsx,terms-gate-logic.ts}`, `apps/web/lib/route-lists.ts`
- `apps/web/app/settings/{page,client}.tsx`, `apps/web/app/settings/investor-profile/`, `apps/web/app/settings/tabs/PreferencesTab.tsx`
- `apps/web/app/brokers/client.tsx`, `apps/web/lib/brokers/oauth-callback.ts`, `apps/web/app/api/brokers/zerodha/callback/route.ts`
- `packages/services/src/dashboard.service.ts` (`getDashboardStats` `:87`) — Ready screen totals

## Build — in this order

### 0. Schema — `User` (additive, all optional; the session edits `schema.prisma` and runs `prisma generate`; the QA/prod `db push` is a founder step, see "Founder, after merge")

```prisma
enum MarketChoice { IN US BOTH }
enum Residency { INDIA INDIA_LRS US }

// on model User
market                MarketChoice? // absent = IN at read time (P0-07 backfills)
residency             Residency?
onboardingPath        String?       // "connect" | "upload" | "explore" | "skip"
onboardedAt           DateTime?
marketPrefsUpdatedAt  DateTime?
```

`preferredCurrency` stays and IS `primaryCurrency` (W12: "keep preferredCurrency as the primary-currency override"). Rule: when residency is written without an explicit currency, the service writes the derived currency (NRI/`US` → USD, `INDIA_LRS`/`INDIA` → INR); an explicit currency in the same request wins. Never read `{market: null}` in a query — absent fields match nothing (root `CLAUDE.md`, MONEY-1050).

### 1. Service — `packages/services/src/us/market-profile{-logic,.service}.ts`

```ts
// -logic.ts (pure)
export const MarketProfilePatch = z.object({
  market: z.enum(["IN", "US", "BOTH"]).optional(),
  residency: z.enum(["INDIA", "INDIA_LRS", "US"]).nullable().optional(),
  primaryCurrency: z.enum(["INR", "USD"]).optional(),
  onboardingPath: z.enum(["connect", "upload", "explore", "skip"]).optional(),
}).strict();

export interface MarketProfile {
  market: "IN" | "US" | "BOTH";          // absent → "IN"
  residency: "INDIA" | "INDIA_LRS" | "US" | null;
  primaryCurrency: "INR" | "USD";
  usHoursIn: "ET" | "IST";               // derived: residency US → ET, else IST (W12)
  lrsTrackerVisible: boolean;            // derived: INDIA_LRS (W12 table)
  connectFirst: "zerodha" | "us-broker" | "us-statement"; // derived (W12 table); US options only matter when their flags are on
  onboarded: boolean;                    // onboardedAt set, OR legacy Clerk investorProfile present (web passes that in; never persisted from the client)
  onboardingPath: string | null;
  disclosure: { tags: string[]; lines: string[]; disclaimer: string }; // W12 copy, ONE source for web + mobile
}
export function deriveProfile(row: {...}): MarketProfile
export function planPatch(current, patch, now): Prisma-free update object
```

- `market: "IN"` clears `residency` to null (India-only has no residency question).
- `onboardingPath` sets `onboardedAt` once (never overwritten); `"connect"` does NOT set it — `/start/ready` does (see 4d).
- `getMarketProfile(userId)` / `updateMarketProfile(userId, patch)` → `ServiceResult<MarketProfile>`; `deps.prisma` seam.
- Fires `captureServiceEvent(userId, "market_selected", {market, residency})` when `market` or `residency` changes and `onboarding_path_chosen {path}` when `onboardingPath` is set (event names from MONEY-1626; P0-07 builds the funnel on them).

### 2. Server actions — `apps/web/lib/actions/us-market-profile.ts`

`getMarketProfileAction()` and `updateMarketProfileAction(patch: unknown)`: `getAuthenticatedUser` → `MarketProfilePatch.safeParse` (imported, not redeclared) → service. No prisma. Signed-out/demo → `{success:false,error:"Unauthorized"}` for the write; the read returns the IN default profile.

Repoint `updateCurrencyPreferenceAction` (`apps/web/lib/actions/user.ts:178`) to call `updateMarketProfile(userId, {primaryCurrency})` so there is one writer of `preferredCurrency` (its signature stays; it currently runs prisma inline).

### 3. `/v1/me/market` + registry row

In `apps/api/src/routes/v1/me.ts`: `GET /market` and `PATCH /market` (body = `MarketProfilePatch`) → same service. Existing family, count unchanged.

`US_SURFACES` row `{ surface: "market-profile", flag: "us-onboarding", usAccess: "none", serviceExport: "getMarketProfile", serviceFile: "packages/services/src/us/market-profile.service.ts", actionFile: "apps/web/lib/actions/us-market-profile.ts", routeFile: "apps/api/src/routes/v1/me.ts", routePath: "/v1/me/market", familyException: "profile, read by India-only users too; not US data" }`. The `familyException` field is what makes a non-`/v1/us` route legal (P0-01 rule 1); `me.ts` is mounted directly by `v1/index.ts`, which satisfies P0-01 rule 5 with no special case.

### 4. UI (mobile-first; `.pf-*` tokens; 44px targets)

a. **Gate** — `TermsGate.tsx` + `terms-gate-logic.ts`: after terms, when `us-onboarding` is on (read via `useUsFeatureFlags` — a `licensed:false` flag) and `profile.onboarded` is false → `router.replace("/start/market")` instead of mounting `WelcomeWizardClient`. Flag off → today's path, byte-identical. Add `/start` to `TERMS_GATE_EXCLUDED_PATHS` only AFTER terms: the gate must still show terms first if a user deep-links to `/start` (test it).

b. **`/start/market` (S0.2)** — W12 fork copy verbatim, two questions on one screen; CTA "Continue" → `updateMarketProfileAction({market, residency})` → `/start`. "Skip for now" → `{market:"IN"}` → `/start`.

c. **`/start` (S0.1)** — doors from `doorsFor(profile, flags)` (pure, in `market-profile-logic.ts`):

- `IN`/`BOTH`: primary **Connect Zerodha** → `updateMarketProfileAction({onboardingPath:"connect"})` → `/brokers` Zerodha OAuth; secondary **Upload statement/CSV** → `{onboardingPath:"upload"}` → `/tradebook/import`; link **Just look around →** → `{onboardingPath:"explore"}` → `/dashboard`.
- `US`: no Zerodha door; US connect/import doors appear only when `us-broker-connect` / `us-statement-import` are on (Phase 3); until then the primary is "Just look around →" promoted to a button.
- Coming-soon row: names from the broker catalogue — extract `BROKERS` from `apps/web/app/brokers/client.tsx:87` into `apps/web/lib/brokers/broker-catalog.ts` and import it in both places (one list). No "notify me" here (that is design review D28, not this ticket).

d. **`/start/ready`** — minimal v2 `FirstReadyScreen`: after a Zerodha connect, the callback (`zerodha/callback/route.ts`) redirects to `/start/ready` when the caller's profile has `onboardingPath === "connect"` and `onboardedAt` is null (read through the service; otherwise today's `/brokers?success=…`). Ready sets `onboardedAt`, shows totals from `getDashboardStats` (real numbers or `—`; holdings still syncing → DS-ST3 partial copy "Holdings in, tradebook still syncing · we'll finish in the background"). Primary **Roast my portfolio** → `/roast`; secondary "Take me to my money" → `/dashboard`.

e. **`/settings/market` (S0.3)** — rows per W12 minus connected accounts: Where do you invest (IN/US/Both), Residency (only for US/Both), Primary currency segmented `$ | ₹` ("The other always stays visible"), US market hours in (derived, read-only text), US data disclosure card (from `profile.disclosure`). Link to it from `PreferencesTab` ("Market preferences →") only when `us-onboarding` is on. Flag off → the route `notFound()`.

f. **Legacy wizard fix** (`welcome/client.tsx:636-640`): relabel "Skip · use demo" → "Skip" (it calls `finish()`; demo cannot run signed-in — see demo note). Only change in that file.

## Screens

### S0.2 `/start/market` — 375px

```
┌──────────────────────────────────────┐
│ STEP 1 OF 2 · WHERE YOU INVEST       │
│ Where do you invest?                 │
│ Sets your currency and which         │
│ connection we offer first.           │
│ ┌──────────────────────────────────┐ │
│ │ IN  India                        │ │
│ │ NSE and BSE, via your brokers    │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ US  United States                │ │
│ │ NASDAQ and NYSE · end-of-day     │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ IN+US  Both                      │ │
│ │ One workspace, two markets       │ │
│ └──────────────────────────────────┘ │
│ QUESTION TWO · BECAUSE YOU PICKED US │
│ ( ) In the US        $ PRIMARY       │
│ ( ) In India, via LRS  ₹ PRIMARY     │
│ US quotes are end-of-day at launch.  │
│ [ Continue ]          Skip for now   │
└──────────────────────────────────────┘
```

1280px: centred column max-w 560; question two appears inline below, no second page.

### S0.1 `/start` — 375px

```
┌──────────────────────────────────────┐
│ Let's find your money.               │
│ Read-only. We never place orders.    │
│ ┌──────────────────────────────────┐ │
│ │ ■ Connect Zerodha             →  │ │
│ │   Holdings, trades, MF in ~1 min │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ Upload statement/CSV          →  │ │
│ └──────────────────────────────────┘ │
│ Just look around →                   │
│ ─────────────────────────────────    │
│ COMING SOON                          │
│ Upstox · Dhan · Fyers · Angel One…   │
└──────────────────────────────────────┘
```

1280px: vertical order kept, max-w 640 (D21), primary block ink fill + hard shadow.

### S0.3 `/settings/market` — 375px

```
┌──────────────────────────────────────┐
│ ← Settings                           │
│ Market preferences                   │
│ Your two onboarding answers.         │
│ Where you invest      India + US  ›  │
│ Residency         India · LRS     ›  │
│ Primary currency     [ $ | ₹• ]      │
│ US market hours in          IST      │
│ ┌──────────────────────────────────┐ │
│ │ US DATA DISCLOSURE               │ │
│ │ ◷ end-of-day · SEC EDGAR ·       │ │
│ │ spot FX hourly · no execution    │ │
│ │ Not investment advice.           │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

1280px: inside the settings shell, 2-column rows (label left, control right), max-w 720.

### States

| State    | S0.2 fork                                                        | S0.1 /start                                                      | S0.3 settings                      | /start/ready                                                                                     |
| -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| loading  | n/a (static)                                                     | n/a (static)                                                     | row skeletons                      | "Opening Zerodha…" / skeleton totals                                                             |
| empty    | n/a                                                              | n/a (DS-ST3)                                                     | profile absent → IN defaults shown | 0 holdings → "Zerodha returned no holdings. Using a different account?" [Reconnect] [Upload CSV] |
| error    | save fails → inline "Couldn't save · try again", stays on screen | door action fails → toast, navigation still proceeds for explore | inline per row                     | "Sync failed · we kept nothing half-done." [Retry]                                               |
| DataGap  | n/a                                                              | n/a                                                              | n/a                                | tradebook still syncing → partial copy                                                           |
| gated    | n/a (choosing US is allowed without access)                      | n/a                                                              | n/a                                | n/a                                                                                              |
| flag-off | route `notFound()`; legacy wizard                                | same                                                             | same; no link in Preferences       | today's `/brokers?success`                                                                       |
| demo     | redirect to sign-up                                              | redirect to sign-up                                              | demo settings unchanged            | n/a                                                                                              |

### U1–U7

| User                  | Behaviour                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1 new, India-only    | terms → fork "India" (Q2 hidden) → /start with Zerodha primary                                                                                                        |
| U2 new, US-interested | terms → fork US/Both + residency → /start; US-only sees "Just look around" primary until Phase 3 flags; no US access check here (fork is a preference, not a licence) |
| U3 existing India     | never routed to /start (`onboarded` = legacy profile or P0-07 backfill); can open S0.3                                                                                |
| U4 demo               | none of these routes (redirect to sign-up)                                                                                                                            |
| U5 FREE, flag on      | same as U1/U2 — plan does not change onboarding                                                                                                                       |
| U6 paid               | same                                                                                                                                                                  |
| U7 founder            | same; use a fresh test account to see the flow                                                                                                                        |

## Cross-surface access (§6)

1. Search — n/a: no entity. 2. Watchlist — n/a. 3. Sage — n/a (Sage reads `market` later via `getMarketProfile`; P2-02). 4. Home — Ready → Roast/Dashboard; S0.7 card is P0-07. 5. Deep link — `/start`, `/start/market`, `/settings/market` round-trip; auth-only, not in sitemap. 6. API — `GET/PATCH /v1/me/market` + `market-profile` row. 7. Demo — redirect to sign-up; demo fixture is P0-07. 8. Telemetry — `onboarding_path_chosen {path}`, `market_selected {market, residency}` (server-side, from the service), `start_viewed {flag:"us-onboarding"}` client-side on first render.

## Tests

- `packages/services/__tests__/us/market-profile-logic.test.ts` — W12 derivation table (NRI → USD + ET + us-broker first + LRS hidden; LRS → INR + IST + statement first + LRS visible; India-only → nothing US; absent market → IN); explicit currency beats derived; `market:"IN"` nulls residency; `onboardedAt` set once; `doorsFor` for IN/US/BOTH × Phase-3 flags on/off.
- `packages/services/__tests__/us/market-profile-service.test.ts` — `deps.prisma`; update writes only allowed fields; events fired once per change.
- `apps/api/__tests__/routes/me-market-contract.test.ts` — GET envelope incl. `disclosure`; PATCH strict (unknown key → 400).
- Disclosure single-source: a test that `profile.disclosure` from the service equals what the S0.3 component renders (render test reads the same object).
- `apps/web/__tests__/components/terms-gate-logic.test.ts` — flag on + not onboarded → redirect `/start/market`; flag off → wizard; legacy Clerk profile → onboarded; `/start` deep link still gets terms first.
- `apps/web/__tests__/brokers/zerodha-callback-ready.test.ts` — connect path + not onboarded → `/start/ready`; otherwise unchanged redirect.
- Source scan (add to `packages/services/__tests__/us/us-surface-parity.test.ts`): no file writes `unsafeMetadata` with `market`, `residency` or `primaryCurrency` keys.
- **Mutation check:** make the TermsGate redirect ignore the flag → the flag-off test goes red; drop the `.strict()` → the contract test goes red.
- Parity test picks up the new row; `TEST-COVERAGE.md` updated.

## Acceptance

- [ ] Flag off: `/welcome` wizard and TermsGate behave exactly as today (existing TermsGate tests green, unchanged).
- [ ] Flag on, fresh account: terms → `/start/market` → `/start` → Zerodha → `/start/ready` with real totals → "Roast my portfolio". ≤ 5 screens to data (DS-IA1 verify line).
- [ ] `User.market/residency/preferredCurrency/onboardedAt` written; nothing written to `unsafeMetadata` by the new flow.
- [ ] `/settings/market` edits round-trip with `GET /v1/me/market` (same values).
- [ ] Screenshots U1, U2, U5 at 375 + 1280, light + dark.
- [ ] `verify:push`; `/code-review` (auth/onboarding path → consider `ultra`).

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- Push the `User` schema change: `setup-infra.sh qa --only db`, then `setup-infra.sh prod --only db`.
- Create `us-onboarding` in PostHog (default off), target the founder, then walk the fresh-account flow on a phone.

## Out of scope / hand-offs

- Market pill + context → **P0-06**. Backfill, S0.7 card, demo fixture, "Make this mine", funnel → **P0-07**.
- Connected US accounts + revoke → **P3-03**. LRS tracker assumptions row → **P3-05**.
- Moving `experience` off Clerk and deleting `/welcome` → a later cleanup; the legacy flow remains the flag-off path.
- First-sync 5-step progress screen (v2 `FirstSyncScreen`) → design-review DT1, not in this program.
