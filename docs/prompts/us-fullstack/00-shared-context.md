# 00 · Shared context for every US full-stack build prompt

> Every prompt in `docs/prompts/us-fullstack/` starts with: **"Read `docs/prompts/design-v2/00-shared-context.md` AND `docs/prompts/us-fullstack/00-shared-context.md` — both are part of this prompt."**
>
> The design-v2 file carries the repo laws, the design-bundle reading rules, the named components and the definition of done. **All of it applies here unchanged.** This file ADDS the US rules. Where the two disagree, this file wins, and it says so explicitly.

Written 2026-09-24. Plan of record: `docs/prompts/us-fullstack/PLAN-sep2026.md`, which covers the lanes, the measured prod state and the dependency order. Product and design review: `docs/gstack/ceo-review-2026-09-23-product-roadmap/`.

---

## 1. Founder rules for this program

1. **Phase order:**
   - **0**: India/US split and onboarding.
   - **1**: screener and market.
   - **2**: StockSage.
   - **3**: broker integration.

   A phase starts only when the tickets it depends on are merged. The README lists them.

2. **No native iOS/Android work in this program.** The M-prompts (`design-v2/mobile/*`, M20 = MONEY-1590–1593) are parked. **But every API is built mobile-ready now** (§2), so the future app is a client and not a rewrite.
3. **Mobile-first web.** Design and build at **375px first**, then scale up to 768 and 1280 (§4).
4. **Every UI surface ships behind its own `us-*` PostHog flag, default OFF** (§3). The founder enables each one individually. A flag that is off means the layer is ABSENT: no teaser, no "coming soon", no waitlist.
5. **Every implementation wires its own access paths** (§6). A US surface that cannot be reached from search, the watchlist and Sage is not done.

---

## 2. The service contract — MONEY-1632 (overrides design-v2 §2.2 where they differ)

**One feature = ONE function.** The Next.js app calls it through a server action. A future mobile app calls the SAME function through `apps/api`.

```
Next.js component ──► apps/web/lib/actions/us-<surface>.ts ("use server") ─┐
                                                                            ├─► packages/services/src/us/<surface>.service.ts ──► Prisma / CandleRepository / BigQuery-never
mobile (later)    ──► apps/api/src/routes/v1/us/<surface>.ts (Hono)     ───┘            └─ <surface>-logic.ts (pure, unit-tested)
```

The contract has seven rules:

1. **The service is the only implementation.** It takes `(userId, input)` and returns a `ServiceResult<T>` whose `T` is **plain JSON**:
   - Dates are ISO strings.
   - No Prisma model types, no `Decimal`, no Next.js types.
   - A mobile client must be able to deserialise it with no knowledge of our server.
2. **The server action and the `/v1` route are thin and identical in shape:** authenticate → resolve the DB user → US access check (§3) → validate the input with the SHARED schema → call the service → map the result. **Neither imports `@usemoney/database` or `prisma`.**
3. **Schemas are single-sourced.** A zod input schema lives once, in the service's `-logic.ts` (or `packages/validation`), and both callers import it. **Do not write "mirrors X" comments. Import X.**
4. **Components call the server action only.** Never `fetch('/v1/…')` from the web app. `apps/api` never imports from `apps/web`.
5. **Lists paginate by cursor** through `@usemoney/api-utils` in BOTH callers. The web action exposes the same cursor, so mobile infinite scroll needs nothing new.
6. **A refusal is ABSENCE.** If the user lacks US access, the route answers exactly as it would for a symbol that does not exist. Never a 403 that confirms the thing exists (the licence rule, `US_MARKET_ALLOWED_EMAILS`).
7. **Every surface registers a row in `US_SURFACES`** (`packages/services/src/us/registry.ts`, built by MONEY-1632) with exactly P0-01's field names: `{surface, flag, serviceExport, serviceFile, actionFile, routeFile, routePath, usAccess, familyException?}`.
   - `surface` is a free kebab-case id with NO `us-` prefix (`search`, `stock-overview`, `markets`).
   - `routePath` starts with `/v1/`, normally `/v1/us/…`. A route in another, existing family is legal only with `familyException: "<reason>"` (the watchlist `/v1/watchlists`, `/v1/research/*`, `/v1/holdings`, brokers `/v1/brokers/snaptrade/*`, `/v1/me/market`, `/v1/market/us/quotes`).
   - `us-surface-parity.test.ts` fails when a file is missing, when the two callers import different service exports or from a specifier other than the one derived from `serviceFile`, when either imports the database, when the route module is not mounted under `apps/api/src/routes/v1/index.ts` (directly or through `us/index.ts`), or when a `usAccess:"required"` caller never calls `resolveUsLayer` / `usLayerForRequest` / `usLayerFor`.

**The anti-example is in this repo.** `packages/services/src/saved-screens.service.ts` is a _port_ of `apps/web/lib/actions/saved-screens.ts`. That action still runs its own `prisma` calls, and the zod schemas are hand-copied into `apps/api/src/routes/v1/saved-screens.ts` ("Mirrors…"). There are two implementations of one feature, and they drift. **Do not copy this shape.** If you touch an India surface to add a US leg and it has this shape, convert that surface to the contract in the same PR. If the conversion is large, file a ticket and say so in the PR.

**`V1_ENDPOINTS` is pinned at 38 families.** All US routes live under ONE new family, `/v1/us/*`, mounted once by MONEY-1632, so the pin moves **38 → 39** in that PR (update `v1-helpers.test.ts` and `parity-p14-discover-sections-contract.test.ts` deliberately). Later tickets add sub-paths; they never add families. This overrides any ticket or W-prompt that names another family (`/v1/search`, `/v1/markets/us`, `/v1/stocks/:symbol/us/*`). A surface may still live in an EXISTING family when its row carries `familyException` (rule 7); broker routes are the main case, and stay at `/v1/brokers/snaptrade/*` (README, Phase 3). After MONEY-1632 merges, every mention of the pin means **39**.

---

## 3. Flags and the two gates

**Two gates, and both must pass. They are different things.**

| Gate             | What it is                                                                                                                                                                                                                                                                                               | Where it lives                                                                                                                                     | Who flips it             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **US access**    | The LICENCE boundary. Tiingo Commercial is internal-use-only, so serving US prices to a user is redistribution. Today it is an email allowlist (`US_MARKET_ALLOWED_EMAILS`, founder by default). MONEY-1624 turns it into an entitlement (plan and region rule plus a global switch), still fail-closed. | `packages/core/src/market-data/us-market-access.ts`, `apps/api/src/lib/us-access.ts`, and after MONEY-1562 one `useUsLayer()` / `resolveUsLayer()` | a code diff (MONEY-1563) |
| **Product flag** | "Is this SCREEN switched on for this user?"                                                                                                                                                                                                                                                              | PostHog, declared ONCE in the registry built by MONEY-1622                                                                                         | the founder, in PostHog  |

**Flag set** (all default OFF; the registry built by MONEY-1622 is authoritative):

| Flag                    | Phase | Screens                                          |
| ----------------------- | ----- | ------------------------------------------------ |
| `us-onboarding`         | 0     | S0.1 /start, S0.2 market fork, S0.3 market prefs |
| `us-market-switch`      | 0     | S0.6 market pill (header, tab bar)               |
| `us-upgrade`            | 0     | S0.4 /upgrade?market=US, S0.5 GateInline         |
| `us-currency-toggle`    | 0/3   | $ ↔ ₹ toggle (screener, stock page, holdings)    |
| `us-stocks-search`      | 1     | S1.1 search, command palette, pickers            |
| `us-stocks-listing`     | 1     | S1.3 US stock page (exists; kept)                |
| `us-stock-chart`        | 1     | chart block on S1.3                              |
| `us-stock-fundamentals` | 1     | ratios, financials, insiders, 13F on S1.3        |
| `us-news`               | 1     | news, filings and events on S1.3 and S1.2        |
| `us-market-overview`    | 1     | S1.2 /markets/us                                 |
| `us-screener`           | 1     | S1.4 screener US pill (stocks)                   |
| `us-funds`              | 1     | US MF + ETF screener modes and fund pages        |
| `us-watchlist`          | 1     | S1.5 mixed watchlist                             |
| `us-dashboard`          | 1     | S1.6 Home US cards                               |
| `us-stock-research`     | 2     | S2.2 US research report (exists; kept)           |
| `us-sage-entrypoints`   | 2     | S2.1 Sage market pill, S2.3 Ask-Sage sheet       |
| `us-broker-connect`     | 3     | S3.1 connect US broker                           |
| `us-holdings`           | 3     | S3.2 mixed holdings                              |
| `us-lrs-tracker`        | 3     | S3.3 LRS/TCS tracker                             |
| `us-statement-import`   | 3     | S3.4 statement import                            |

Rules:

- **Read flags ONLY through the registry** (MONEY-1622): the server evaluation, the client hook and `/v1/me/flags`. Today the flag names are hand-synced across four copies, and `useUsFeatureFlags` has no consumers. Do not add a fifth copy.
- **Compose, don't nest.** A surface renders when `usAccess && flag`. An entry point to another surface (e.g. "Ask Sage" on the stock page) renders when that surface's own flag is on. It lights up with no code change when the founder flips it.
- **A flag that is off means the layer is absent.** That applies to the component, the nav item, the search section, the sitemap entry and the `/v1` route (which refuses as absence).
- The route-level flag stays even after a surface is fully rolled out, until the founder removes it in a deliberate cleanup ticket.

---

## 4. Mobile-first (DS-RESP1, from the design review)

- **The Claude Design bundle IS the design.** Look, copy, spacing, components and states come from `docs/design/v2-bundle/`: `v2 US Launch.dc.html`, `Spec v2 - Core Surfaces.dc.html`, `UseMoney Mobile.dc.html`, `Decisions - US Launch.dc.html` and the rest, read as design-v2 §1 says. The ASCII wireframes in these prompts, and the ones on the plan page (`plan.html`), are INTENT sketches: what the screen must contain, which flag gates it, which states exist. They are never the visual spec. Where a sketch and the bundle disagree, **the bundle wins**. Where the bundle has no screen for a surface (e.g. S1.2 /markets/us), compose it from the bundle's existing components and tokens, and say so in the PR.
- **375px is the primary artboard.** Build it first, then verify at 768 and 1280. The design-v2 definition of done ("matches at 1280px and 375px") still applies. The ORDER of work is mobile first.
- Touch targets are **at least 44×44px**. Text is at least 14px. Wide tables collapse to a card list below 768px, and are never a horizontally-scrolling page body. A table may scroll inside its own container.
- Below 768px, a modal is a **bottom sheet** and a secondary panel is a full-screen route with a back affordance.
- **Tab bar below 768px: Home · Portfolio · Sage · Discover · You.** Desktop keeps the v2 sidebar. The market pill (S0.6) sits in the top bar on both.
- Every state from the design review's binding table (DS-ST3) is built: **loading** (skeleton at the final layout, no spinner-only screens), **empty**, **error**, **DataGap**, **gated** (GateInline, never a modal), **flag-off** (absent), **demo**.
- Light and dark, through the `.pf-*` tokens in `apps/web/app/playful-app.css`. Never add new colours.

---

## 5. User types — every screen states its behaviour for each

| #   | User                                                      | How they arrive           | US layer                                                                                     |
| --- | --------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| U1  | New, India-only                                           | `/start` → "India"        | absent, and never nagged; the Add-US card appears only after 7 days of activity (MONEY-1626) |
| U2  | New, US-interested (NRI, or resident investing under LRS) | `/start` → "US" or "Both" | on if US access passes; otherwise GateInline → `/upgrade?market=US`                          |
| U3  | Existing India user                                       | already onboarded         | sees the S0.7 Add-US card once; dismissible; `User.market` backfilled to `IN`                |
| U4  | Demo visitor                                              | "Just look around"        | one demo fixture covers India AND US (MONEY-919); "Make this mine" converts                  |
| U5  | FREE plan, flag on                                        | any                       | GateInline on every US surface, showing the real plan name and price by IP-currency          |
| U6  | Paid plan (PRO/PREMIUM), flag on                          | any                       | full layer                                                                                   |
| U7  | Founder / allowlist                                       | override                  | everything, on any plan                                                                      |

Every screen's prompt carries a U1–U7 row table. Every PR includes screenshots for at least U1, U2 and U5.

Onboarding facts from the design review (they bind Phase 0):

- the quiz is removed;
- terms are accepted before `/start`;
- `/start` offers three doors: **Connect Zerodha · Upload a statement · Just look around**;
- "Roast my portfolio" is the first-value moment;
- Premium is the recommended plan, priced in the currency chosen by IP;
- persona comes from two onboarding questions (Decisions log #05).

**The profile moves off Clerk `unsafeMetadata`**, which the client can write, to server-owned `User` fields (`market`, `residency`, `primaryCurrency`) through the service contract.

---

## 6. Cross-surface access checklist (every ticket answers every line in its PR body)

1. **Search:** is the new thing findable from S1.1 search and the command palette?
2. **Watchlist:** can it be added (☆) where it is shown, stored as `{market: "US", listingId}`?
3. **Sage:** is there an "Ask Sage" entry that passes `{market, listingId}` or the screen context? It renders only under `us-stock-research` + `us-sage-entrypoints`.
4. **Home/dashboard:** does a card or row link here (under `us-dashboard`)?
5. **Deep link:** does the URL round-trip, and is it shareable? Is it in the sitemap only when public?
6. **API:** does the `/v1/us/*` route exist, with a row in `US_SURFACES`?
7. **Demo:** is there a demo fixture for it?
8. **Telemetry:** is there a PostHog event on first render and on the primary action, carrying the flag name?

Answer "n/a" only with a reason.

---

## 7. US data you build on — measured facts, not assumptions

- **Identity is `listingId`**, formatted `{symbol}:{exchange}:{listingStartDate}`. It is NEVER the bare symbol. Tickers are recycled: `DOW` is Dow Chemical from 1972 to 2017 and Dow Inc. from 2019. A URL may carry the symbol; the server resolves it to ONE listing, the current occupant (`latestOccupantOf`, MONEY-1616/1617).
- **Prices are EOD-only for users** (Decisions #01). `candles`: D1 from Tiingo (about 20M rows, 14k symbols) and M1 from Databento. Read ONLY through `CandleRepository` or the market-data service (`apps/market-data` `/udf/history`). **Never `prisma.candle`**, and **never BigQuery from a request path**.
- **Fundamentals and events:**
  - `us_fundamentals` (EDGAR);
  - `UsFilingInsight` (8-K/10-Q/10-K insights);
  - `instrument_event` (insider Form 4, 13D/G);
  - 13F holdings;
  - `UsNewsArticle` (news poller, 24×7).

  Several of these are **written today and read by nothing**; the tickets say which.

- **Funds:** `us_fund_nav`, keyed `(permaTicker, date)`. Delisted funds never have NAVs; that is by design.
- **FX:** `fx_rates`. **Spot for VALUES, the RBI reference rate for COST basis/LRS. Never mixed** (Decisions #02). One `convertUsd()` (MONEY-1576). A missing rate disables the toggle with a reason (MONEY-1578). It never shows a blank or a guessed rate.
- **The vendor is never named in the UI** (Decisions #06): "third-party consolidated tape".
- **Money is not ₹ by default.** Format through the currency-parameterised helper (MONEY-901). A USD surface that renders ₹ is a bug, and a test in each surface ticket asserts it cannot happen.
- **QA has no Atlas Search** (root `CLAUDE.md`). US search must work on the prisma-fallback rung, and MONEY-1570 reports which rung answered.

---

## 8. Running this from cloud Claude Code

- One prompt equals one session equals one branch, `{type}/MONEY-{n}`, where n is the ticket in the prompt header. **The ticket already exists. Do not create another** (the rule is to never invent a ticket number).
- Everything you need is in the repo: these prompts, `PLAN-sep2026.md`, `snaptrade-prompts-P18-P33.md`, `docs/reference/snaptrade-multi-broker-plan-sep2026.md`, `docs/design/v2-bundle/` and `docs/gstack/`. **Do not reach for `~/Developer/UseMoneyAI/archive-docs`.** It is not available in the cloud.
- The gate is `VERIFY_SERIAL=1 yarn verify:push`, then `/code-review` (money, entitlement and broker paths use `/code-review ultra`), then push and open a PR. **Do not merge. The founder merges.**
- The PR body contains:
  - the ticket;
  - the flags added;
  - the `/v1/us/*` routes added and the `US_SURFACES` rows added;
  - the §6 checklist;
  - U1/U2/U5 screenshots at 375px and 1280px, light and dark;
  - any "Engine-gated" seams;
  - **Founder, after merge**: every prod step (see the next rule).
- **A session never writes to or runs against prod.** Every step that pushes a schema/index to prod (`setup-infra.sh … --only db`), provisions or executes a prod job, flips an APPLY flag, or verifies "as the founder on prod" / "Datadog on prod" is a FOUNDER step after merge. The session edits schema + runs `prisma generate`, runs jobs unarmed against QA or fixtures, and lists the founder steps in the PR body under **"Founder, after merge"**. Each prompt's own "Founder, after merge" subsection lists them; copy it into the PR body and add any the session discovers.
- After merge the founder turns the flag on **for the founder only** in PostHog, looks at it on a phone, then widens it.
