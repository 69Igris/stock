# P0-07 · Existing users meet US · one demo fixture for both markets · "Make this mine"

Ticket: MONEY-1626 (+ MONEY-919) · Branch: `feat/MONEY-1626` (one PR closes both) · Flag(s): `us-onboarding` · Screens: S0.7 "Add US" card (Home), demo banner, demo US card · Depends on: P0-05 · Parallel-safe with: P0-06

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

Every user type has a defined first-run path and every path is measured. Existing users are backfilled to `market: IN` and marked onboarded, so turning `us-onboarding` on never drops them into `/start`. An existing India user who is entitled to US sees one dismissible "Add US" card on Home. A demo visitor sees one coherent sample portfolio that spans India and the US (AAPL, MSFT, NVDA), and the demo banner's call to action is "Make this mine".

## Why / measured state today (verified 2026-09-24)

- After P0-05, `User.market`, `residency`, `onboardedAt`, `onboardingPath` exist and are OPTIONAL; every pre-existing document lacks them. **No Prisma predicate matches an absent Mongo field** (root `CLAUDE.md`; MONEY-1050/1234/1235), so the backfill must use `$runCommandRaw` with `{$exists:false}`. Exact precedent: `scripts/ops/backfill-user-isactive.ts:91-96` — the same absent-field backfill on the same collection, dry run by default, `$runCommandRaw({ update: "User", … multi: true })`.
- P0-05 treats a user as onboarded if `onboardedAt` is set OR a legacy Clerk `investorProfile` exists. Users who accepted terms and closed the wizard have neither and would be routed to `/start` when the flag flips — the backfill closes that.
- Demo: `apps/web/lib/demo/data.ts` (2,367 lines) is India-only — `demoDashboardStats.portfolio.totalValue` 1,093,670 (`:15-28`), no US instrument anywhere (grep `AAPL|NASDAQ|NYSE` → only a USD/INR FX line at `:1198`). The design review's live-demo audit recorded contradictions (header "0 BROKERS · LIVE" beside a ₹10.9L portfolio; "No holdings yet" beside holdings; mobile "3 BROKERS") — DS-ST2 asks for one coherent fixture.
- Demo sessions: HMAC cookie via `POST /api/demo/start` (`apps/web/app/api/demo/start/route.ts`, sets `sb_demo` + `sb_demo_did`); `isDemoSession()` is false for any signed-in user (`apps/web/lib/demo/session.ts:226-234`). Demo users get every flag at its default (OFF): there is no Clerk user to evaluate.
- Banner: `apps/web/components/DemoBanner.tsx` — CTA "Sign up free →" → `/sign-up` (`:47-49`).
- Dashboard: `apps/web/app/dashboard/{page,client}.tsx` → `apps/web/components/dashboard/DashboardOverview.tsx`.
- Dismissal precedent: `User.walkthroughVersionsSeen` (`schema.prisma`, `User` model) with `KNOWN_WALKTHROUGH_VERSIONS = ["v1-core"]` (`packages/services/src/user-logic.ts:454`) — that list is for TOURS; do not put a card in it.

## Read first (verified paths)

- P0-05 output: `packages/services/src/us/market-profile{-logic,.service}.ts`, `apps/web/lib/actions/us-market-profile.ts`
- P0-03/P0-04 output: `packages/services/src/us/us-layer-logic.ts` (`on | gated | absent`), `apps/web/lib/hooks/useUsLayer.ts`
- P0-02 output: `packages/services/src/flags/posthog-decide.ts`
- `apps/web/lib/demo/{data,session}.ts`, `apps/web/components/{DemoBanner,DemoSessionGuard}.tsx`, `apps/web/app/api/demo/start/route.ts`, `apps/web/lib/hooks/useDemoAnalytics.ts`
- `apps/web/components/dashboard/DashboardOverview.tsx`, `scripts/README.md`
- `docs/design/v2-bundle/app/shell2.jsx` (`DemoBanner` `:89`), `app/s-us.jsx` (`UsPortfolioScreen` `:269` — demo US rows/copy)

## Build — in this order

### 0. Schema

One optional field on `User`: `addUsCardDismissedAt DateTime?`. (Queryable for the funnel; not a tour.)

### 1. Service — extend `market-profile`

`market-profile-logic.ts`:

```ts
export type AddUsCard = "show" | "hidden";
/** S0.7: existing India user, entitled, not dismissed, account at least 7 days old. */
export function addUsCardState(a: {
  market: "IN" | "US" | "BOTH";
  dismissedAt: Date | null;
  createdAt: Date;
  layer: "on" | "gated" | "absent";
  onboardingFlag: boolean;
  now: Date;
}): AddUsCard;
// show iff onboardingFlag && market === "IN" && !dismissedAt && layer !== "absent" && now - createdAt >= 7d
```

- `layer: "on"` → the card offers "Add US" (→ `/start/market`). `layer: "gated"` (FREE, `entitled` mode, `us-upgrade` on) → the card offers "See plans" (→ `/upgrade?market=US`). `absent` → hidden: never advertise what the user cannot get.
- `MarketProfile` gains `addUsCard: AddUsCard`. `MarketProfilePatch` gains `dismissAddUsCard: z.literal(true).optional()` → sets `addUsCardDismissedAt` once, fires `add_us_card_dismissed`.
- The service computes `layer` via `resolveUsLayer(userId, "us-onboarding")` — it composes P0-03/P0-04's function; it does not re-evaluate the licence.

### 2. Server action

Reuse `getMarketProfileAction` / `updateMarketProfileAction`. No new action.

### 3. `/v1`

Reuse `GET/PATCH /v1/me/market` — mobile gets `addUsCard` and can dismiss with the same patch. No new route or registry row.

### 4. Backfill — `scripts/data/backfill-user-market.ts`

- Dry run by default; `--apply` writes. Prints counts BEFORE and AFTER from the same raw filters: `users where market absent`, `users where termsAcceptedAt present AND onboardedAt absent`.
- Writes via `prisma.$runCommandRaw({ update: "User", updates: [...] })` — the `User` model has no `@@map`, so the Mongo collection is `User` (as in `backfill-user-isactive.ts`):
  1. `{market: {$exists:false}}` → `$set {market: "IN"}`.
  2. `{termsAcceptedAt: {$exists:true, $ne:null}, onboardedAt: {$exists:false}}` → `$set {onboardedAt: "$createdAt"…}` — use an update pipeline (`[{ $set: { onboardedAt: "$createdAt", onboardingPath: "legacy" } }]`) so each row gets its own `createdAt`.
- `onboardingPath: "legacy"` is written ONLY by this script (the zod patch does not accept it); `deriveProfile` treats it like any other set path.
- Idempotent: a second `--apply` reports 0 and 0. The session runs only the dry run, against QA; `--apply` on QA and then prod is a founder step ("Founder, after merge"). Put the filters and update documents in `scripts/data/backfill-user-market-logic.ts` so they are testable without a database.
- Add the script to `scripts/README.md`.

### 5. Demo — one fixture across both markets (MONEY-919)

- `apps/web/lib/demo/us-data.ts`: `demoUsHoldings` — AAPL (NASDAQ), MSFT (NASDAQ), NVDA (NASDAQ): `listingId`-shaped ids (`{symbol}:{exchange}:{listingStartDate}`, from the real `us_instruments` rows — look them up once and hard-code), qty, avg cost USD, a STATIC demo close with an explicit `asOf` date, and one static `fxUsdInr` with its own `asOf`. These are sample numbers, labelled DEMO DATA, never fetched from Tiingo (Tiingo is internal-use-only; a fixture is not a quote).
- Make the whole demo coherent (DS-ST2): one `demoPortfolioSummary` derived in code from India holdings + MF + US holdings converted at the fixture FX, and every demo surface that shows a total, a broker count or a "no holdings" line reads from it. Fix the three contradictions the design review recorded (broker count vs holdings; "No holdings yet" beside holdings; desktop vs mobile broker count). Demo brokers: Zerodha (India) + one US statement import row — nothing labelled "LIVE" that is "coming soon" for real users.
- Demo US card on the demo dashboard: rows AAPL/MSFT/NVDA with `◷ EOD` and "DEMO DATA". Shown to demo sessions only when `us-onboarding` is on FOR THE DEMO DISTINCT ID: evaluate with `fetchPostHogFlags(sb_demo_did, { demo: "true" })` (P0-02's Decide client) and `readUsFlags`. The founder targets `demo = true` in PostHog to turn it on; default OFF like every flag.
- Banner (`DemoBanner.tsx`): when that same demo evaluation has `us-onboarding` on, the CTA reads **"Make this mine"** → `/sign-up?redirect_url=/start/market`. Off → today's "Sign up free →". After sign-up, TermsGate shows terms, then P0-05 routes to `/start/market` (terms before /start, D26).
- Keep `window.location.href` for any demo navigation (demo-flow rule; see the note in `apps/web/app/(marketing)/home/client.tsx:55-60`).

### 6. Instrumentation + funnel

Events (server-side from the service unless noted), all carrying `flag: "us-onboarding"`:

| Event                                              | Fired by                         |
| -------------------------------------------------- | -------------------------------- |
| `onboarding_path_chosen {path}`                    | P0-05 service (exists)           |
| `market_selected {market, residency}`              | P0-05 service (exists)           |
| `add_us_card_viewed {variant: "add" \| "upgrade"}` | client, first render per session |
| `add_us_card_clicked {variant}`                    | client                           |
| `add_us_card_dismissed`                            | service                          |
| `demo_make_this_mine_clicked`                      | client, via `useDemoAnalytics`   |

Funnel: define it in PostHog (founder, or via the PostHog MCP if the session has it) as `start_viewed → market_selected → onboarding_path_chosen → (roast_started | dashboard_viewed)`, broken down by `market` and `residency`; and a second `add_us_card_viewed → add_us_card_clicked → market_selected`. Record both definitions (steps, breakdowns, insight URL if created) in `docs/setup/us-feature-flags-setup.md` under "Onboarding funnel". Do not invent event names beyond this table.

### User-type matrix (the ticket's six paths — every one must be exercised in the PR)

| #   | Path                                  | First-run route                                                                | Events                                  | Verified by           |
| --- | ------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------- | --------------------- |
| 1   | New, India-only resident              | terms → /start/market (India) → /start                                         | market_selected, onboarding_path_chosen | P0-05 functional test |
| 2   | New, India resident investing via LRS | fork BOTH + INDIA_LRS → ₹ primary                                              | same                                    | P0-05 derivation test |
| 3   | New NRI / US resident                 | fork US or BOTH + US → $ primary                                               | same                                    | P0-05 derivation test |
| 4   | Demo visitor                          | marketing → demo → "Make this mine" → sign-up → terms → /start/market          | demo_make_this_mine_clicked, then 1–3   | this prompt           |
| 5   | Existing India user                   | backfilled IN + onboarded; S0.7 card if entitled & ≥ 7 days                    | add*us_card*\*                          | this prompt           |
| 6   | FREE vs paid                          | FREE entitled-mode → card variant "upgrade" → /upgrade?market=US; paid → "add" | add*us_card*\*                          | this prompt + P0-04   |

## Screens

### S0.7 "Add US" card — 375px (Home, above the fold, below the greeting)

```
┌──────────────────────────────────────┐
│ ┌──────────────────────────────────┐ │
│ │ NEW · US MARKETS              ✕  │ │
│ │ Hold US stocks too?              │ │
│ │ Track NASDAQ and NYSE next to    │ │
│ │ your Indian portfolio. End-of-   │ │
│ │ day prices.                      │ │
│ │ ┌──────────────────────────────┐ │ │
│ │ │ Add US →                     │ │ │
│ │ └──────────────────────────────┘ │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

Variant `upgrade`: button "See plans →" and the line "US markets are part of PRO". 1280px: same card in the dashboard's first row, max-w 560, dismiss top-right.

### Demo banner + demo US card — 375px

```
┌──────────────────────────────────────┐
│ DEMO DATA · sample portfolio         │
│ [ Make this mine ]                ✕  │
├──────────────────────────────────────┤
│ US HOLDINGS · DEMO      ◷ EOD 18 SEP │
│ AAPL  Apple        12   $2,736.00    │
│ MSFT  Microsoft     6   $2,610.00    │
│ NVDA  NVIDIA       20   $2,450.00    │
│ ≈ ₹6,56,000 at fixture FX (DEMO)     │
└──────────────────────────────────────┘
```

(Numbers are illustrative; the fixture decides them and every total is derived.) 1280px: banner unchanged layout; US card sits beside the India holdings card.

### States

| State    | S0.7 card                                                  | Demo US card / banner                             |
| -------- | ---------------------------------------------------------- | ------------------------------------------------- |
| loading  | not rendered until the profile resolves (no flash)         | static fixture, no loading                        |
| empty    | n/a                                                        | n/a                                               |
| error    | profile read fails → not rendered                          | demo flag read fails → today's banner, no US card |
| DataGap  | n/a                                                        | n/a (fixture, stamped DEMO)                       |
| gated    | variant `upgrade` (FREE, `entitled` mode, `us-upgrade` on) | n/a                                               |
| flag-off | not rendered                                               | "Sign up free →", no US card                      |
| demo     | not rendered (demo has no profile)                         | this IS the demo state                            |

### U1–U7

| User                  | S0.7 card                                                        | Demo                                                |
| --------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| U1 new, India-only    | hidden for the first 7 days, then shown only if entitled         | —                                                   |
| U2 new, US-interested | hidden (market ≠ IN)                                             | —                                                   |
| U3 existing India     | shown once if entitled; dismissible forever                      | —                                                   |
| U4 demo               | hidden                                                           | US card + "Make this mine" when the demo flag is on |
| U5 FREE, flag on      | `upgrade` variant in `entitled` mode; hidden in `allowlist` mode | —                                                   |
| U6 paid               | `add` variant (in `entitled` mode)                               | —                                                   |
| U7 founder            | `add` variant if their market is IN                              | —                                                   |

## Cross-surface access (§6)

1. Search — n/a: a card, not an entity. 2. Watchlist — n/a. 3. Sage — n/a in Phase 0. 4. Home — yes, S0.7 lives on Home and links to `/start/market` or `/upgrade?market=US`. 5. Deep link — `/sign-up?redirect_url=/start/market` round-trips. 6. API — `GET/PATCH /v1/me/market` carries `addUsCard` + `dismissAddUsCard`. 7. Demo — this prompt builds the fixture. 8. Telemetry — the table in §6.

## Tests

- `packages/services/__tests__/us/market-profile-logic.test.ts` — `addUsCardState` full table (market × dismissed × age 6d/7d × layer × flag); dismiss sets once.
- `packages/core/__tests__/ops/backfill-user-market.test.ts` (scripts' logic is tested from a package suite, as `packages/core/__tests__/market-data/relabel-us-candles.test.ts` does for `scripts/data/relabel-us-candles-logic.ts`) — the filters are `$exists:false` (not `null`); the pipeline form of update 2; dry run issues zero writes. **Mutation check:** change filter 1 to `{market: null}` → the test that asserts absent-field semantics goes red.
- `apps/web/__tests__/demo/demo-coherence.test.ts` — every demo total equals the sum of its parts; demo broker count equals the number of demo broker rows; no demo string reads "No holdings yet" while `demoHoldings.length > 0`; US rows use `listingId` shape; no US demo value is `NaN`/`Infinity`.
- `apps/web/__tests__/demo/demo-banner.test.tsx` — flag on → "Make this mine" with `redirect_url=/start/market`; off → today's copy.
- `TEST-COVERAGE.md` updated.

## Acceptance

- [ ] Backfill dry run on QA prints the two counts (pasted, labelled QA); a logic test proves a second pass over already-stamped documents selects 0 and 0.
- [ ] With `us-onboarding` on for the founder: an existing account is NOT routed to `/start`; a fresh account is.
- [ ] S0.7 renders for an entitled IN user ≥ 7 days old; dismiss persists across devices (`GET /v1/me/market` shows `hidden`).
- [ ] Demo with the demo flag on: US card + "Make this mine" → sign-up → terms → `/start/market`. Demo with it off: unchanged. Demo numbers coherent across desktop and 375px.
- [ ] Funnel definitions recorded; events visible in PostHog live events from one QA run.
- [ ] Screenshots U1, U3, U4, U5 at 375 + 1280, light + dark. `verify:push`; `/code-review`.

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- Run `scripts/data/backfill-user-market.ts` as a dry run on prod and compare with the QA counts in the PR.
- Run it with `--apply` on QA, then on prod; a second run on each prints 0/0.

## Out of scope / hand-offs

- US demo rows on `/holdings` (mixed holdings) → **P3-04**; demo watchlist/US stock page → **P1-08 / P1-04** read the same `us-data.ts` fixture.
- "Notify me" rows for coming-soon brokers (design review D28) — not in this program.
