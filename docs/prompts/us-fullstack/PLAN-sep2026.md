# UseMoney US full-stack integration — plan (23-Sep-2026)

**Replaces the STUB.** Plan 4 of five. **Design imported, not invented:** the
product surfaces come from `docs/prompts/design-v2/` (36 tracked files, the
canonical copy — newer than `~/Developer/UseMoneyAI/design-v2/`), its
`Decisions - US Launch.dc.html` log (9 binding decisions), and
`cross-pack-reconciliation-sep2026.md` (the 15-Sep collision pass). **Evidence:**
stockbook @ `40c9168a` (branch `fix/MONEY-1401`), prod Mongo measured
2026-09-22, prod cloudbuild specs read as DEPLOYED.

| Plan                                         | File                                 | Lanes                              |
| -------------------------------------------- | ------------------------------------ | ---------------------------------- |
| 1 — Data platform                            | `data-platform-plan-v2.3-sep2026.md` | S, A, B, C1 + C5                   |
| 2 — Product surfaces                         | `product-surfaces-plan-sep2026.md`   | D2, D3, D4, D5 (`apps/api`) + C4   |
| 3 — News & events (claude-algo-coupled only) | `news-events-plan-sep2026.md`        | C2, C3 + the news-engine migration |
| 4 — US full-stack integration (this doc)     | `us-fullstack-plan-sep2026.md`       | **L, U, F, X, H, R, V, Q**         |
| 5 — US broker integration                    | `us-broker-plan-sep2026.md`          | STUB (SnapTrade P18–P33)           |

**Letters are chosen not to collide.** Plan 1 owns S/A/B/C, plan 2 owns D, plan 3
owns P12/P13. This plan owns **L**icence, **U**niverse, **F**unds, f**X**,
**H**istory, **R**esearch, **V**iews, **Q**ueue.

**What is NOT here.** Broker linking, SnapTrade, statement import, LRS/TCS and
the `currency` column on `Holding`/`Trade`/`Position` are **plan 5**. This plan
assumes none of it and builds nothing that waits on it — every task below is
reachable with zero third-party accounts. W08/W10/W11 and M20 are named in lane
V only as the consumers they are.

**No Linear ticket exists for anything in this plan.** A letter here is not a
tracked ticket. The ticket column in §10 reads `TBD` for every row and must be
filled by filing the ticket and reading the id back — never by guessing a
number.

---

## 1. State of the world — measured on PROD, 2026-09-22

```
us_instruments        74,342   Mutual Fund 27,121 ACTIVE / 22,739 DELISTED
                               Stock        8,259 ACTIVE /  8,226 DELISTED
                               ETF          5,822 ACTIVE /  2,175 DELISTED
                               -> 41,202 active, 33,140 delisted
candles           29,616,257   D1 TIINGO 20.3M, 14,179 symbols, 2016-01 -> 2026-09
                               M1 DATABENTO 7.2M (507 sym) · H1 2.1M (12,398 sym)
us_fundamentals    1,153,463   5,138 symbols with isLatest
us_company_facts     504,669   concept-shaped {taxonomy, concept, unit, values[]}
us_fund_nav        5,176,672
us_corporate_actions 2,949,565
fx_rates                  17   USDINR ONLY, 2026-08-28 -> 2026-09-21, source YAHOO
us_cost_model_rows     2,353
```

14,131 symbols carry a Sep-2026 D1 bar — against 14,081 active Stock+ETF
listings, so **the daily price backbone for US equities and ETFs is
effectively complete and current**. Everything in this plan that is hard is
hard somewhere else.

**The one US read path that exists today** is the `/stock/[symbol]` US branch
(`apps/web/app/stock/[symbol]/page.tsx:195`), `/api/market/search` US rows,
`/api/market/quote`, `/api/market/stream`, `/v1/market/us/quotes`, and
`apps/market-data`'s `/udf/*`. **There is no US screener and no US discover
surface at all.**

---

## 2. The central finding — there is no US analogue of `stock_ratios`

`us_instruments` carries **identity and sync bookkeeping only**:

```
listingId · symbol · exchange · assetType · name? · listingStatus
listingStartDate? · listingEndDate? · cik? · permaTicker? · openFIGIComposite?
usEodSyncedAt? · searchSyncedAt? · nameSyncedAt?
coldYearsFrom? · coldYearsTo? · hotLoadedYears Int[] · lastHotLoadAt?
```

Not one fundamental, not one ratio, no `LatestQuote` equivalent. India's screener
reads five collections — `stockRatios`, `instrumentMapping`, `latestQuote`,
`mutualFundMaster`, `indexConstituent` — and **the US has a counterpart for
exactly one of them.**

So _"all filters working"_ is **true of the RAW data and false of anything
screener-shaped**, and three separate facts make a projection mandatory rather
than merely convenient:

1. **The numbers live in a `Json` column.** `UsFundamentals.standardized` is
   `Json`; Prisma cannot filter or index through it, so `PE < 25` is not
   expressible as a query at all. This is structural, not a performance note.
2. **The join key is nullable.** `UsFundamentals` is keyed on `cik10` and its
   `symbol` is nullable, so a ticker reaches its fundamentals only through
   `UsInstrument.cik` — itself nullable, filled by the `EDGAR_CIK_ENRICH` leg.
3. **The row shape is per-statement-per-period.** 1,153,463 rows over 5,138
   symbols is ~224 rows a symbol (INCOME/BALANCE_SHEET/CASH_FLOW ×
   ANNUAL/QUARTERLY × history × amendments, `accession` being in the unique
   key). A screener needs ONE row a listing.

And the lake cannot serve it either: **the web request path never queries
BigQuery** (lake §8; `stockbook-api@` holds no BigQuery grant, IAM-enforced).
So the projection lands in **Mongo** (lane U) or in a **pre-built GCS tile**.

Statement shapes, for the projection's input contract:

```
INCOME: Revenue · CostOfGoodsAndServicesSold · ResearchAndDevelopmentExpenses
        SellingGeneralAndAdminExpenses · TotalOperatingExpenses
        OperatingIncomeLoss · InterestAndDividendIncome · InterestExpense
        PretaxIncomeLoss · IncomeTaxes · NetIncome
        SharesAverage · SharesFullyDilutedAverage · _fallbacks
```

plus `BALANCE_SHEET` and `CASH_FLOW`, each ANNUAL + QUARTERLY. Row counts:
INCOME QUARTERLY 389,105 (4,207 symbols) · BALANCE_SHEET ANNUAL 248,556 (5,055)
· BALANCE_SHEET QUARTERLY 146,800 (4,239) · INCOME ANNUAL 139,107 (4,875) ·
CASH_FLOW ANNUAL 129,580 (4,772) · CASH_FLOW QUARTERLY 100,315 (4,076).

---

## 3. Three constraints stated now rather than discovered later

**C-1 · 62 % fundamental coverage on stocks.** 5,138 of 8,259 active. Ratio
filters cannot apply to the other 3,121, and the screener must render that as a
**named absence** — a counted, labelled exclusion under the results — never a
silent drop. This repo's entire defect culture is absences that read as health
(MONEY-1211, 1215, 1235, 1255, 1399, 1500). _Caveat worth measuring before U2
is called done:_ 5,138 is "symbols with `isLatest`" across the whole table; the
number that actually gates the screener is
`count(us_instruments where assetType="Stock" and listingStatus="ACTIVE" and cik != null)`
joined to `us_fundamentals.cik10`. Run it; if it is materially below 5,138 the
gap is `EDGAR_CIK_ENRICH` coverage, not EDGAR coverage, and that is a different
fix.

**C-2 · Funds have no fundamentals at all, and they split into two data paths.**
27,121 active mutual funds + 5,822 active ETFs. `buildUsEodWhere`
(`workers/src/processors/us-eod-sync-logic.ts:219`) routes
`US_EQUITY_ASSET_TYPES = ["Stock","ETF"]` to `candles` and
`US_MF_ASSET_TYPES = ["Mutual Fund"]` to `us_fund_nav`. So:

- **ETFs have real OHLCV** — every price, return, volume and volatility filter
  works for them on day one.
- **Mutual funds have a NAV series only**, keyed `(permaTicker, date)`. The
  permaTicker enricher is ACTIVE-ONLY by design, so **22,556 delisted funds can
  never receive a NAV row** — a documented coverage FLOOR, not a backlog.
- **Neither has expense ratio, AUM, category, issuer or holdings.** Nothing in
  this platform holds them and nothing can derive them: Tiingo's
  `supported_tickers.zip` carries ticker/exchange/assetType/currency/dates, and
  `/tiingo/daily/<ticker>` adds name + description. India gets `expenseRatio`
  from AMFI's TER file; **there is no AMFI for the US.** That is a PURCHASE or
  scrape decision (F4), not a build task, and it is the honest limit on "all
  fund filters working".

_Arithmetic that needs settling:_ 5,176,672 NAV rows over 27,121 active funds is
~191 rows a fund — under one trading year each on average. If that average is
real rather than a long-tail artefact, **1Y/3Y/5Y fund return filters are not
computable for most funds today**. The measurement that settles it:
`us_fund_nav` distinct `permaTicker` count, and the p10/p50/p90 of
`max(date) - min(date)` per permaTicker. Do it before F2 is scoped.

**C-3 · `fx_rates` holds 17 rows and the table cannot hold what Decision 02
requires.** One month of USDINR, source YAHOO, written by leg (d) of
`us-eod-sync` (`us-eod-sync.ts:1988`). A USD→INR conversion of a 2016 price has
no rate. Worse, and not previously written down anywhere:

> **`FxRate` is `@@unique([pair, date])` — `source` is NOT in the key.**
> Decision 02 requires **two rates for the same date** (hourly spot for values,
> RBI reference of trade date for cost basis, _never mixed_). The table can hold
> one. This is the same "source not in the unique key" class that produced
> MONEY-1050, MONEY-1234 and MONEY-1235 on `StockFinancials` / `StockRatios` —
> the first RBI write would destroy the YAHOO row it replaced, and nothing
> afterwards could tell which kind of rate a number was.

And `fetchFromRbi` is still `return null` (`packages/services/src/gst/rbi-fx.ts`,
`TODO(MONEY-217)`); only `GST_FX_RATE_<CCY>_<YYYY-MM-DD>` ops overrides work.
A silently-missing rate that renders as a blank or a zero is the failure mode
(X2).

---

## 4. Gates — the licence one is not a feature flag

**Two gates, both must pass, and they answer different questions.**

| Gate                                                                     | Question                                       | Where                                                                                                | Default              |
| ------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------- |
| `US_MARKET_ALLOWED_EMAILS`                                               | _May this person legally be shown a US price?_ | `packages/core/src/market-data/us-market-access.ts`, read **per call**, CSV **replaces** the default | unset ⇒ founder only |
| `us-stocks-listing` / `us-stocks-search` / `us-stock-research` (PostHog) | _Is this surface built and turned on?_         | `apps/web/lib/types/feature-flags.ts` `UsFeatureFlag`                                                | **false**            |

**The licence gate blocks the whole product, and this plan cannot lift it.**
Tiingo COMMERCIAL is **INTERNAL USE ONLY**. Ingest and storage are fine;
**serving a US price to a user is redistribution** and needs the $250/mo
"EOD + IEX Redistribution" plan (MONEY-1262). It is enforced in code with a safe
default rather than in PostHog, deliberately: PostHog is remote configuration
that can be flipped by someone who does not know what it is load-bearing for.
A test fails if `US_MARKET_ALLOWED_EMAILS` appears in a cloudbuild spec, because
widening a licence gate must be visible in a diff.

**So every lane below ships to the founder allowlist and stops there. `L1` is
the single named gate that converts this plan from a private tool into a
product, and it is a commercial action, not an engineering one.**

**Refusal is ABSENCE, never an error.** `partitionUsSymbolsByAccess` returns
`{allowed, refused}` and the refused symbols are simply unresolved;
`/v1/market/us/quotes` substitutes an empty quote map rather than returning 403,
because a 403 confirms the data exists. Every new US surface must copy that
shape.

**The MONEY-1142 shape, measured on this repo today.** A dark page in front of
open data is a link nobody has been given yet. Current state, read from source:

- Licence gate present: `/api/market/quote:135`, `/api/market/stream:141`,
  `/stock/[symbol]/page.tsx:195`, `market-data-token.ts:70`,
  `/v1/market/us/quotes` (via `mayServeUsMarket`). **Good.**
- Product flag present: `/stock/[symbol]/page.tsx:195` (both), `/api/market/search:123`.
  **Absent** from `/api/market/quote`, `/api/market/stream`,
  `/v1/market/us/quotes`.
- `apps/web/proxy-routes.ts` does **no** US gating — the branch is inside the
  page, not in middleware.
- `apps/market-data` **trusts the US claim minted into the token**
  (`market-data-token.ts:70`), so narrowing the allowlist takes effect only
  after the token TTL. That TTL is the revocation lag and must be stated.

---

## 5. The lanes

Every task carries **Goal / Why / Files / Depends / Acceptance (what is
measured) / Risk**. "Acceptance" is always a number or a runtime observation,
never "it is wired" — `deployed ≠ done`, and this repo has shipped a merged,
deployed, DDL-applied table that was structurally incapable of holding a row.

### Lane L — Licence and gates

**L1 · Buy the Tiingo redistribution plan, or decide not to launch.**
_Goal:_ lift the internal-use-only restriction so a non-founder may be shown a
US price. _Why:_ every surface in lanes U, F, V and R renders a US price;
without it they are all founder-only forever, and building them for an audience
of one is a choice that should be made deliberately. _Files:_ none — commercial.
_Depends:_ nothing. _Acceptance:_ the plan is live on the account and
`TIINGO_PLAN` reads `REDISTRIBUTION` on prod; `US_MARKET_ALLOWED_EMAILS` widened
in ONE reviewed diff. _Risk:_ $250/mo against zero US revenue. The alternative
is an explicit decision to keep US founder-only, which is fine — but it has to
be written down, because ten tasks below assume one answer or the other.

**L2 · One `useUsLayer()` selector, two gates, every surface.**
_Goal:_ one function returning `{ mayServe, flagOn }`, consumed by web, api and
mobile; no surface evaluates PostHog or the allowlist itself. _Why:_ the US
branch lives inside pages today and the flag is missing from three API routes
(§4). Two gates evaluated in five places is how one of them goes missing.
_Files:_ `apps/web/lib/market/us-access.ts` · `apps/api/src/lib/us-access.ts` ·
`apps/web/lib/hooks/useUsFeatureFlags.ts` · new `us-layer-logic.ts`.
_Depends:_ nothing. _Acceptance:_ a source-scan test asserting every route that
reads `us_instruments`, `candles` with `market: "US"`, `us_fund_nav`,
`us_fundamentals` or `fx_rates` passes through the selector — a scan, not a
review note, because MONEY-1309 proved a guard wired at one of five call sites
under-reports by 80 % and manufactures headroom that does not exist.
_Risk:_ a scan cannot assert a POLICY, only a call. Pair it with a functional
test that an allowlisted-off user gets `absence` and not a 403 from each route.

**L3 · The US flag audit, before anything new ships.**
_Goal:_ enumerate every US read surface and record, per surface, which of the
two gates it carries and why. _Why:_ the answer today is uneven and the uneven
half is the one that matters (`/v1/market/us/quotes` is reachable by any client
with a Bearer token). _Files:_ `docs/setup/us-feature-flags-setup.md` (it lists
five flags and no routes). _Depends:_ L2. _Acceptance:_ the doc names every
route in §4's list with both gate states, and the `us-stocks-listing` flag is
added to the three routes that lack it. _Risk:_ none; this is the cheapest task
in the plan and it is first for that reason.

---

### Lane U — Universe: the screener projection, and search

**U1 · `us_screener_row` — one row per active listing.**
_Goal:_ a new Mongo collection, `@@unique([listingId])`, that is the ONLY thing
a US screener query touches. _Why:_ §2 — the numbers are in a `Json` column, the
join key is nullable, and the row shape is per-period. No amount of query
cleverness gets around any of those. _Shape:_

```
identity     listingId · symbol · exchange · assetType · name · cik · permaTicker
price        lastClose · lastCloseDate · chg1D/1W/1M/3M/6M/1Y · high52w · low52w
             pctFrom52wHigh · avgVolume30d · dollarVolume30d · vol1y · maxDd1y
fundamental  marketCap · sharesDiluted · revenueTtm · netIncomeTtm · epsTtm
             peTtm · grossMargin · operatingMargin · netMargin · roe · roa
             debtToEquity · currentRatio · fcfTtm · dividendYieldTtm
             fundamentalsAsOf (filedAt) · fundamentalsForm (10-K | 10-Q)
fund         navOrClose · ret1M/3M/6M/1Y/3Y/5Y · distributionYieldTtm
             navHistoryFrom
coverage     priceFill · fundamentalFill · fundFill — each a NAMED enum
provenance   computedAt · projectionVersion
```

`coverage.fundamentalFill ∈ {FILED, NO_CIK, NO_FILINGS, NOT_APPLICABLE}` — a
**named value, never absent and never null**, because a Mongo `db push` creates
indexes and not fields, so `{fundamentalFill: null}` and
`{fundamentalFill: {not: null}}` both return ZERO on every pre-existing row.
That class has caused MONEY-1050, MONEY-1234 and MONEY-1235.
_Files:_ `packages/database/prisma/schema.prisma` ·
`packages/types/src/us-screener.ts`. _Depends:_ nothing.
_Acceptance:_ the schema pushed to QA and prod; indexes present on every field
a filter sorts or ranges on. _Risk:_ a wide index set on 41k rows is cheap; a
missing one is a blocking in-memory sort against Mongo's 32 MB ceiling, which
THROWS rather than degrading (the `UsInstrument` comment already records this).

**U2 · `us-screener-project` — the job that fills it.**
_Goal:_ a **Cloud Run job**, sharded by listing, that reads `candles`,
`us_fundamentals` and `us_fund_nav` and writes `us_screener_row`. _Why:_ a
Cloud Run job, not a Pub/Sub handler, for the same reason `databento-harvest`
and `tile-build-d1` are: there is no 600 s ack deadline to overrun and no
redelivery to guard against (lane Q). 41,202 listings × a trailing-window read
is not a 600 s unit of work under any batch size. _Cadence:_ after
`us-eod-sync` (11:00 IST), Tue–Sat IST — Tue–Sat because a US session closing
16:00 ET lands after midnight IST the following day, the same correction
`us-eod-sync` already carries. _Files:_ `scripts/jobs/us-screener-project.ts` +
pure `packages/core/src/market-data/us-screener/projection-logic.ts` ·
`workers/tsup.config.ts` (one entry per Cloud Run job) ·
`scripts/ops/setup-us-screener-job.sh`. _Depends:_ U1.
_Acceptance:_ row count == active listing count; per-`coverage`-enum histogram
logged and matching §3's expectations (≈5,138 `FILED`, ≈3,121 `NO_CIK`/
`NO_FILINGS`); a spot-check of ten symbols against a hand-computed PE and 1Y
return. **`US_SCREENER_APPLY` ships PRESENT and `"false"` in both specs**, read
per call against the literal string — absent and `"false"` must not be the same
state (MONEY-1214), and `Boolean("false")` is true.
_Risk:_ this is a full pass over 20.3M `candles` rows, which is the one table
B6 is trying to shrink. It is a READ, so it does not fight B6, but it must be
sharded and it must not be scheduled inside the eviction window. **When
`lake_silver.price_bar_d1` gains US rows (MONEY-1513, plan 1), the trailing
arithmetic should move to BigQuery and land the same rows — a reader swap
inside one job, never a second projection.**

**U3 · `screenUs()` — the query surface.**
_Goal:_ extend `packages/services/src/screener.service.ts` with a US path that
reads `us_screener_row` and nothing else. _Why:_ `screenStocks` today is
India-shaped to the bone (`exchange?: "NSE"|"BSE"`, ₹-crore `MCAP_BUCKETS`,
five India collections) and has no `market` axis. Adding one to the existing
function would put two universes behind one set of thresholds.
_Files:_ `packages/services/src/screener.service.ts` + a sibling
`us-screener-logic.ts` · `packages/services/src/scans.service.ts:369`
(`mapFiltersToScreenFilters` gains a US band table) ·
`apps/web/lib/actions/screener.ts` · `apps/api/src/routes/v1/screener.ts`
(`POST /v1/screener/stocks` accepts `market` — a field, not a new family; the
`V1_ENDPOINTS` count stays pinned at 38). _Depends:_ U1, U2, L2.
_Acceptance:_ a contract test that `market: "US"` touches `us_screener_row` and
**zero** India collections, and that `market: "IN"` output is byte-identical to
today on the golden fixture. _Risk:_ `screener.service.ts:441-444` already
records that the ETF `where` is scoped by **exchange, not market**, because
`{market: "IN"}` matches zero on pre-existing India rows and **without a venue
clause the India ETF surface fills with US names — the ETF master is shared.**
The moment a US mode exists, that venue clause is the only thing separating the
two. Pin it with a test that names the hazard.

**U4 · The named-absence contract.**
_Goal:_ every screener response carries
`{matched, universe, excluded: {filterId -> count, reason}}`, and the UI renders
it as a row under the results, not a tooltip. _Why:_ C-1. A PE filter that
silently drops 3,121 stocks is indistinguishable from a PE filter that found
nothing — and the repo has shipped that exact shape at four layers already.
_Files:_ `packages/types/src/us-screener.ts` ·
`apps/web/components/screener/*` (the `DataGapBanner` named in W00) ·
the `apps/api` envelope. _Depends:_ U3.
_Acceptance:_ a render test asserting that a fixture where a filter excludes
rows for missing data shows a **non-zero, labelled** count; and a mutation test
that removing the exclusion accounting turns the test red — otherwise the check
is vacuous. _Risk:_ none. This is the task that makes "all filters working"
an honest claim rather than a hopeful one.

**U5 · US search — make the silent fallback loud.**
_Goal:_ `apps/web/lib/market/us-instrument-search.ts` keeps its Atlas→Prisma
ladder but reports which rung answered, and the screener/`@`-picker read the
same function. _Why:_ the file **never throws** (a deliberate divergence from
India's `atlas-search.ts`, because it rides a shared `Promise.all`), so a
misconfigured or mis-filtered `us_instrument_search` index returns `null`,
falls through to `startsWith`/`contains`, and looks like a working search with
worse results. That is MONEY-1500's shape — an empty or degraded result that
never throws — one collection over. And per CLAUDE.md, **QA has no Atlas Search
at all**, so QA exercises only the fallback: a green QA is no evidence about
prod here, in either direction. _Files:_ `apps/web/lib/market/us-instrument-search.ts`
(`reportUsSearchFailure` already exists — give it a counter) ·
`apps/web/app/api/market/search/route.ts:123`.
_Depends:_ L2. _Acceptance:_ a prod counter distinguishing `atlas` /
`prisma-fallback` / `refused` answers per request, observed non-zero on the
Atlas rung for a week. _Risk:_ the token-field trap is already documented in the
file (`exchange`/`assetType`/`listingStatus` are **token** fields — `text`
silently matches nothing; `assetType` must not be upper-cased). Any new facet
added for the screener repeats it unless a test pins the casing.

---

### Lane F — Funds and ETFs

**F1 · Resolve the design contradiction: US funds are in scope.**
_Goal:_ delete the "US FUNDS & ETFS — LATER · Same switcher, next stop" panel
from the US build. _Why:_ `v2 Screener.dc.html` renders
`usSoon: usReal && S.mode !== "stocks"` and `mfShow: S.mode === "mf" && !isUS`
— the design **defers US funds and ETFs entirely**, and W02 implements that
deferral. The founder's brief requires them. The design yields; this is recorded
in §8 as a deliberate override, not an oversight. _Files:_
`docs/prompts/design-v2/web/W02-screener-unified.md` (§1 and Non-goals) ·
`docs/prompts/design-v2/mobile/M21-module-web-v2-parity.md`.
_Depends:_ nothing. _Acceptance:_ the prompt says what is being built.
_Risk:_ none, but the copy and empty states for two new modes are now
undesigned — F2's acceptance must not assume a mockup exists.

**F2 · The shared-filter design question, answered.**
_Goal:_ decide how one filter panel serves stocks, ETFs and mutual funds.
_The question:_ a shared panel has to answer "what does P/E mean for a mutual
fund", and the honest answer is "nothing".
_The answer:_ **keep the three modes that already exist** — `STOCKS |
MUTUAL FUNDS | ETFS`, with per-mode URL params (`?mode=&stocks.pe=…`), which
`apps/web/app/discover/screener/` already ships for India — and add a market
pill inside each. **"All filters working" is satisfied per mode, not per panel.**
Beneath them, **one registry** where every filter declares
`appliesTo: ("STOCK" | "ETF" | "MF")[]` and `requires: (keyof UsScreenerRow)[]`,
so the mode tabs, the disabled states and U4's exclusion accounting are all
**derived from one declaration** rather than three hand-maintained lists.
_What each mode can actually filter on, measured:_

| Mode      | Population    | Price/return filters                             | Fundamental filters      | Fund reference |
| --------- | ------------- | ------------------------------------------------ | ------------------------ | -------------- |
| US STOCKS | 8,259 active  | **all** (14,131 have a Sep-2026 bar)             | 62 % — U4 names the rest | n/a            |
| US ETFS   | 5,822 active  | **all** (ETFs ride the `candles` leg)            | none, and none derivable | **none — F4**  |
| US FUNDS  | 27,121 active | NAV-derived only; history depth unmeasured (C-2) | none                     | **none — F4**  |

_Files:_ `packages/core/src/market-data/us-screener/filter-registry.ts` (new,
the single declaration) · `apps/web/app/discover/screener/{mf,etf}-mode.tsx`
(US branches) · `apps/api/src/routes/v1/screener.ts`.
_Depends:_ U1, U3, F1. _Acceptance:_ a test that every filter rendered in a mode
declares that mode in `appliesTo`, and that every filter's `requires` names a
field U2 actually writes — the join tested, not just the halves.
_Risk:_ the mutual-fund mode is the one that can ship looking full and be empty
of anything a user would sort on. Run C-2's NAV-depth measurement **before**
scoping it; if the median fund has under a year of NAV, ship the mode with
1M/3M/6M only and say so, rather than rendering `—` in four columns.

**F3 · A serving path for US mutual-fund NAV.**
_Goal:_ a US fund's NAV series becomes readable by a chart. _Why:_ measured in
`apps/market-data/src/routes/history.ts` — the symbol resolver has exactly three
kinds: `{EXCHANGE}:{TICKER}` → India tile, `MF:{schemeCode}` → **AMFI** NAV
synthesis (MONEY-1478), and a 3-part `SYMBOL:EXCHANGE:START` → US tile. **A US
mutual fund is none of them**: it has no tile (funds have no tiles) and its
scheme code is not an AMFI one. It is unreachable. _The lazy fix:_ one more
branch in the same resolver, reading `us_fund_nav` through the existing
`navPointsToBars`, so `/udf/symbols` and `/udf/history` cannot disagree about
what exists — the defect MONEY-1476 was spent closing.
_Files:_ `apps/market-data/src/routes/history.ts` (resolver + one branch) ·
`apps/market-data/src/routes/symbols.ts` · a `us-fund-nav-service` sibling to
`prices/mf-nav-service`. _Depends:_ L2. _Acceptance:_ `/udf/history` for a US
fund returns bars; a non-daily resolution returns the same **named refusal** an
equity gets, not bars (the MONEY-1478 review finding). _Risk:_ delisted funds
have no permaTicker and therefore no NAV row, ever — the resolver must say
"no history on file", not "error".

**F4 · US fund reference data — a purchase decision, not a build task.**
_Goal:_ decide whether expense ratio, AUM, category, issuer and holdings are
bought, scraped, or declared out of scope. _Why:_ C-2. They do not exist in this
platform and cannot be derived from anything we hold; India's equivalents come
from AMFI, which has no US counterpart. Until this is decided, the US FUNDS and
US ETFS modes carry price-derived filters only, and that is the product.
_Files:_ a decision note in `docs/reference/`. _Depends:_ nothing.
_Acceptance:_ a written decision with a quoted price, not an intention.
_Risk:_ shipping the fund modes first and deciding later is fine; shipping them
while implying the missing filters are "coming" is the thing to avoid.

---

### Lane X — Currency and denomination

**X1 · Put `source` in the `FxRate` unique key, then backfill.**
_Goal:_ `@@unique([pair, date, source])`, then a daily USDINR SPOT series back
to 2016-01 (the earliest D1 bar). _Why:_ C-3 — Decision 02 needs two rates for
one date and the table holds one, and the first RBI write would destroy the
YAHOO row with nothing left to tell them apart. Backfill second: ~2,700 trading
days at one row each is trivial, and without it every conversion older than
2026-08-28 has no rate. _Files:_
`packages/database/prisma/schema.prisma:7233` ·
`workers/src/processors/us-eod-sync.ts:1988` +
`us-eod-sync-logic.ts:369` (the upsert's `where` changes shape) ·
`scripts/jobs/fx-backfill-usdinr.ts` (new).
_Depends:_ nothing. _Acceptance:_ `fx_rates` holds a YAHOO row for every US
trading session 2016-01 → today, count reconciled against distinct `candles.ts`
for `timeframe: "D1"`; and a QA fixture proves a YAHOO and an RBI row coexist on
one date. _Risk:_ the index change is a `db push` on a live collection —
**`db push` creates indexes and not fields**, and a unique index on Mongo is
**not sparse**, so any pre-existing row missing `source` collides. Every row has
`source` today (it is required with no default), so verify that with a count
before pushing, the way MONEY-1509's duplicate-`candles` blocker was found.

**X2 · One denomination function, and a missing rate is never a number.**
_Goal:_ `convertUsd({amount, kind: "VALUE" | "COST", date})` — VALUE takes hourly
spot, COST takes the RBI reference of the trade date, they are never mixed, and
**a missing rate returns a flagged absence, never `null`-coerced-to-0 and never
`NaN`**. _Why:_ Decision 02 is binding and `cross-pack-reconciliation` C3
already records that the SnapTrade pack would otherwise ship a second,
conflicting conversion rule. _Files:_
`packages/core/src/currency/exchange-rates.ts` (spot, in-memory 1 h, no DB
today) · `packages/services/src/gst/rbi-fx.ts` ·
new `packages/services/src/currency/us-denomination-logic.ts` (pure).
_Depends:_ X1. _Acceptance:_ unit tests over every branch — stale spot > 24 h →
`DataGapBanner` on totals with rows still rendering native; missing RBI ref →
row flagged and **excluded from totals with a visible count**; `finite()` guards
on every arm. _Risk:_ `fetchFromRbi` returns `null` (MONEY-217), so the COST arm
has no source in production. Env overrides carry QA only. **Anything that needs
a cost basis is blocked on MONEY-217 and that must be said out loud rather than
discovered in a `RbiRateUnavailableError` on prod.**

**X3 · `$ → ₹` is disabled with a reason, not blank.**
_Goal:_ the screener's and stock page's currency toggle reflects whether a rate
exists for the date being rendered. _Why:_ a toggle that produces a blank cell
teaches the user the data is broken; a toggle that is off with "no reference
rate for 18 Apr 2016" is the truth. _Files:_ the `DualCurrency` component
(W00) · `apps/web/app/discover/screener/*`. _Depends:_ X2.
_Acceptance:_ a render test on a pre-2026-08-28 date showing the disabled state
with copy. _Risk:_ none.

---

### Lane H — History: adjustment, corporate actions, and the archived fetch

**H1 · US daily-bar adjustment — state the rule, then pin it.**
_Goal:_ write down, and test, that **US daily adjustment rides Tiingo's own
`divCash`/`splitFactor` carried on the bar**, and that the corporate-action join
is inert for US by construction. _Why, measured:_
`dataform/includes/adjustment.js:553-561` is
`COALESCE(NULLIF(b.split_factor, 0), a.action_split)` for splits and
`COALESCE(b.div_cash, a.action_cash)` for dividends. `Candle.divCash` is
`Float @default(0)` and `Candle.splitFactor` is `Float @default(1)` — **NOT
NULL**. So for a US bar the COALESCE **always takes the bar column**; the
`corporate_action` join exists because all 13.1M India bars are NULL in both.
Read-time CRSP in `CandleRepository` and the SQL agree to 2.80e-16 against a
1e-9 bound (plan 1, B4). _Files:_ `dataform/includes/adjustment.js` (a comment
naming the asymmetry) · `packages/core/__tests__/market-data/adjustment-sql-parity.test.ts`
· `packages/database/prisma/schema.prisma` (the two `Candle` fields).
_Depends:_ nothing. _Acceptance:_ a test asserting that a US bar with a real
`divCash` wins over a contradicting action row, **and** that a US bar with
`divCash = 0` beside a real action row also wins — because that second case is
the one nobody expects. _Risk, named:_ `splitFactor @default(1)` cannot
distinguish _"measured, no split"_ from _"this source has no corporate-action
columns"_. `UsFundNav.splitFactor` takes the opposite convention deliberately —
absent means exactly "no split" — so **the same concept carries two opposite
conventions in one schema.** DATABENTO and TIINGO_RT bars carry the defaults, so
any future adjusted read over an intraday series would silently apply no
adjustment. _Measurement that bounds it today:_
`count(candles where timeframe = "D1" and source != "TIINGO")`. If zero, the
daily path is safe and the hazard is confined to a future intraday-adjusted
read; record the number rather than the reassurance.

**H2 · Load `us_corporate_actions` into `lake_silver.corporate_action`.**
_Goal:_ 2,949,565 Mongo rows reach the lake. _Why:_ there is no US loader.
`corp-action-lake-sink.ts` + `packages/lake/src/corp-action-logic.ts:65` map
`CORP_ACTION_VENUE_MARKET = {NSE: "IN", BSE: "IN"}` and **reject an unknown
venue with `UNKNOWN_VENUE`, explicitly so "the day a US corporate-action
producer writes here" it cannot be defaulted to `IN`.** That day is this task.
Without it the lake's US adjustment has exactly one source and no way to repair
a gap. _Files:_ `packages/lake/src/corp-action-logic.ts` (a US venue map) ·
`scripts/jobs/corp-action-lake-sink.ts` (a US leg) ·
`dataform/definitions/gold/adjusted_bar_d1.sqlx` (unchanged — the view already
refs `corporate_action`). _Depends:_ MONEY-1513 (plan 1 — `price_bar_d1` has no
US rows, so there is nothing to join to yet). _Acceptance:_ row count in
`lake_silver_prod.corporate_action` for `market = "US"`, and a count of rows the
loader could NOT resolve to a `listing_id` reported rather than dropped.
_Risk:_ `UsCorporateAction` is keyed on `permaTicker` with a **nullable**
`listingId`, and the permaTicker enricher is ACTIVE-ONLY — so every delisted
security's corporate actions are unjoinable. The loader must count them, not
silently skip them (this is `us_screener_row.coverage`'s rule, one table over).

**H3 · Prove the cold→hot demand-load at runtime.**
_Goal:_ observe a cold shard being promoted into Mongo on a real prod read.
_Why:_ the path already exists and is read-triggered — `CandleRepository`
`readHot` + `readCold` in one `Promise.all`, `planHotLoad` → `runHotLoad`
(inline deadline 2,000 ms), promoted rows land as `tier: "LOADED"` with
`hotLoadedAt`, and `UsInstrument.hotLoadedYears` is the per-listing summary a UI
can read without touching `candles`. **But `CANDLE_EVICT_APPLY = "false"` in
BOTH cloudbuild specs, read as deployed** — so nothing has ever been evicted, so
the hot store still holds everything it ever wrote, so a cold MISS may never
have occurred in production. **"Wired" needs runtime proof; a 0-count is a red
flag.** _Files:_ `packages/core/src/market-data/candles/candle-repository.ts` ·
`workers/src/processors/candle-evict.ts`. _Depends:_ nothing.
_Acceptance:_ a prod read of a symbol-year known to be cold returns bars and
leaves `tier: "LOADED"` rows behind, with `hotLoadOutcome` observed non-trivial
— the repository already distinguishes the states specifically so
`hotLoadBars: 0` cannot mean three different things. _Risk:_ arming
`CANDLE_EVICT_APPLY` is a separate, destructive decision and is **not** part of
this task. It deletes only after a cold shard is observed to hold the row, which
is the right guard — but it is still a one-way door and belongs beside B6.

**H4 · The archived-data fetch the founder asked for — three classes, three
answers.**
_Goal:_ a user-facing way to request data that is in GCS or BigQuery but not in
Mongo, **without the request path ever touching BigQuery**.
_Why:_ founder: _"what about data which is not in Mongo or has been archived but
is available in bigdata — we need to have option to load those or fetch."_ The
honest answer is that it depends on which archive, and there are three:

| Class                                                                  | Where it lives                                                            | Answer                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Candle years outside the hot window**                                | GCS `candles/{market}/{tf}/{sym}/{year}`, format sniffed from magic bytes | **Already solved.** `CandleRepository` demand-loads on read (H3). The only work is to SURFACE it: `coldYearsFrom/To` vs `hotLoadedYears` becomes a "full history available" badge and a range widen — no new mechanism. |
| **Lake tables (silver/gold)**                                          | BigQuery `lake_silver_*`, `lake_gold_*`                                   | **Async materialisation.** The request path may not query BigQuery, so the UI asks, a Cloud Run job writes the slice to Mongo or a GCS tile, the UI polls. Never a synchronous read.                                    |
| **Raw archives** (`edgar/filings` 490 GiB, `databento/` 1-s, `feeds/`) | GCS, Nearline                                                             | **Operator-only.** No user-facing affordance. These are re-derivation inputs, not product data, and a per-user fetch against Nearline is a cost surprise with no ceiling.                                               |

_Files:_ `packages/core/src/market-data/candles/candle-repository.ts` (badge
fields only) · a new `us-history-request` Cloud Run job for class 2 ·
`apps/web/components/stock/*`. _Depends:_ H3. _Acceptance:_ a US chart on a
symbol whose 2017 shard is cold renders 2017 after one load, and the
`hotLoadedYears` badge moves; a class-2 request produces a job row and a polled
completion. _Risk:_ the temptation is one generic "load anything" button. Resist
it — parquet **costs** space at every measured timeframe (+68 % at D1, +23 % at
M1) and the cold store is the cheap half of the arrangement. Pulling everything
hot to make a button feel fast un-does B6.

**H5 · The US tile chain is broken, and it is plan 1's to fix.**
_Goal:_ record the dependency rather than route around it. _Why, measured:_
`scripts/jobs/tile-build-d1.ts:571` sets `builtFrom = isUs ? "gold" :
"dailyprice"` — **US tiles are built from `gold.adjusted_bar_d1`.** Per plan 1
and CLAUDE.md, `lake_gold_prod` holds **no** `adjusted_bar_d1` (Dataform has
never run on prod) and `lake_silver_prod.price_bar_d1` is **market = IN only**,
because B2's US replay was never built (**MONEY-1513**). And
`apps/market-data/src/routes/history.ts` reads **tiles only** — there is no
`CandleRepository` fallback, contrary to the cross-pack note's recommendation
(S3). So: **`tiles/US/` is empty, `/udf/history` for a US symbol has nothing to
serve, and the 20.3M US D1 rows sitting in Mongo are unreachable through the
chart path.**

> **23-Sep correction — measured, the premise above is wrong.**
> `gs://stockbook-lake-prod/tiles/US/d1/` holds **90,447 objects**: one folder
> per listing (`A:NYSE:1999-11-18/`, …) and FOUR sharded manifests,
> `manifest.{0..3}-of-4.json`. `tile-build-d1-us` builds them from Mongo
> `candles`, not from gold, so they exist whether or not Dataform has run.
> The acceptance line below also names a single `manifest.json` that the
> builder never writes. Re-derive H5 from what `/udf/history` actually does with
> these tiles (and from the `US_MARKET_ALLOWED_EMAILS` licence gate) before
> scheduling work against it.

_Files:_ none here — MONEY-1513 (plan 1) plus a Dataform run on
prod. _Depends:_ MONEY-1513. _Acceptance:_ `tiles/US/d1/manifest.json` exists
with a non-zero listing count; a US `/udf/history` request returns bars.
_Risk:_ the tile builders already carry `zeroWriteRefusal` / `missingTileRefusal`
**specifically because `tiles/US/` once went quietly absent** — so the refusal
machinery works and the emptiness is visible. **Decide explicitly** whether to
add the S3 `CandleRepository` fallback to `/udf/history` (unblocks every US
chart today, at the cost of a second read path to retire) or to wait for
MONEY-1513. Recommendation: **add the fallback**, marked `builtFrom: "candles"`
— the enum value already exists — because V2/V3 are otherwise blocked on
another plan's unbuilt task.

---

### Lane R — StockSage US arm

**R1 · US tools in the research registry.**
_Goal:_ `us-filings`, `us-fundamentals`, `us-insiders`, `us-13f`,
`us-eod-prices`, `us-fx-spot`; `symbol-resolver.ts` accepts a `market`;
`preview-plan` carries `market` and returns the US source list. _Why:_ Decision
09 — today `agent.ts` resolves `market: "IN"` only and a bare "AAPL" fails
_after_ planning with "not listed on NSE or BSE", i.e. after the credit is spent.
All 122 tools read NSE/BSE/screener.in/XBRL. _Files:_
`packages/research/src/data-sources/symbol-resolver.ts` ·
`packages/research/src/tools/us-*.ts` (new) ·
`apps/web/app/api/research/preview-plan/route.ts` ·
`packages/research/src/agent.ts`, `planner.ts`.
_Depends:_ U1 (the ratio tool reads the projection, not the `Json` column),
L2. _Acceptance:_ a US run's plan preview carries `market: "US"`, the EDGAR+EOD
source list and an estimate; the report cites EDGAR with filing dates.
_Risk:_ the research tools must read history through `CandleRepository`, never
`prisma.candle` — B6 shrinks the Mongo window and a direct read silently
truncates every series older than it.

**R2 · Gate before spend, and the licence applies to the report too.**
_Goal:_ with `us-stock-research` off, a US CTA reads "Research · India only
today" and **refuses before any credit reservation**. With the licence gate off,
a US research run refuses regardless of the flag. _Why:_ the first half is
Decision 09 and W06's acceptance (a functional test asserting **zero credit
movement**). The second half is not in any design doc and needs saying: **a
StockSage report that quotes a US price is redistribution**, exactly like a
chart is. The licence gate is not a UI concern. _Files:_
`packages/research/src/agent.ts` · `apps/web/lib/actions/research.ts` ·
`apps/api/src/routes/v1/research.ts`. _Depends:_ L2, R1.
_Acceptance:_ two functional tests — flag off ⇒ no credit consumed; licence off
⇒ refusal, as absence, before any tool runs. _Risk:_ the refusal must not leak
that the data exists (§4's shape).

---

### Lane V — Surfaces (web + mobile)

**These are the design-v2 prompts, imported and ordered. Each already carries
its own `Data wiring` and `Acceptance`; this plan adds only the deltas the
founder's brief creates and the order the measurements force.**

| #      | Task                                                                                                     | Prompt | Delta this plan adds                                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **V1** | Market persona: onboarding fork, `market`/`residency`/`primaryCurrency`, Settings → Market preferences   | `W12`  | none — run it first, every other surface reads it                                                                                           |
| **V2** | US stock page: EOD header, ratios with filing chips, financials, insiders, holders, filings, Events seam | `W09`  | the KEY RATIOS grid reads `us_screener_row` (U1), not a per-request `Json` walk; the chart depends on **H5**                                |
| **V3** | Unified screener, US pill, **and the three US modes**                                                    | `W02`  | **F1/F2 — the "US FUNDS & ETFS — LATER" panel is deleted**; U4's exclusion row is rendered; `LATEST FILING` column reads `fundamentalsAsOf` |
| **V4** | StockSage US deltas, `@`-picker market pill, model picker, consensus                                     | `W06`  | R1/R2                                                                                                                                       |
| **V5** | Dashboard US drop-ins                                                                                    | `W01`  | dual-currency tiles via X2                                                                                                                  |
| **V6** | Holdings / watchlist / tradebook US deltas                                                               | `W10`  | **plan 5 territory for holdings; the WATCHLIST half is reachable now** — US rows need only `WatchlistItem.market` + the quote route         |
| **V7** | Mobile US layer (8 screens + drop-ins)                                                                   | `M20`  | reads bars from `apps/market-data` `/udf/history` directly (cross-pack S2/C1), not from a removed `/us/candles`                             |

_Depends:_ V1 → V2 → V3; V4 after V1; V5/V6 any time after V1; V7 after
V1–V3 and H5. **W00 (the 18 named components) is the prerequisite for all of
them and belongs to whoever runs first.**
_Acceptance, shared:_ every US price renders `DelayedDataBadge`; no vendor is
named in any rendered string (Decision 06 — `ProvenanceChip` maps `TIINGO_RT`
and friends to neutral labels, tested over the label map); no India-only section
renders for a US listing; demo mode keeps working on every touched page.
_Risk:_ W02's own acceptance includes a **visible-control budget** — the v2
screener at 1280px must have fewer or equal top-level controls than legacy.
Adding two modes and a market pill spends that budget. Count them in the PR.

---

### Lane Q — Pub/Sub for prod

**The measured topology.** `workers/scripts/setup-pubsub.sh` provisions **65
base topics** plus **7 EDGAR topics** (routed to the Python
`services/us-fundamentals`), and **one push subscription per topic**,
`{topic}-{env}-push` → `${SERVICE_URL}/jobs/{topic}` on **one** Cloud Run
service. `--ack-deadline=600` (Pub/Sub's maximum, unraisable),
`MAX_DELIVERY_ATTEMPTS=5`, `dead-letter-{env}`, backoff 10 s → 600 s. **There is
no per-job split today.** Cloud Run's own request timeout is 3,600 s, so the ack
deadline is always the binding constraint.

**Q1 · `stock-document-embed` — make the batch ONE.**
_Goal:_ one document per message. _Why, measured:_ it takes `batchSize = 200`
with `DELAY_BETWEEN_BATCHES_MS = 1000` per document — 200 s of pacing alone
before any embedding work — and it is the **only** document-pipeline processor
with **no `RUN_TIME_BUDGET_MS`, no self-chain and no in-flight claim** (source-
confirmed: zero matches for all three). Prod: **423 requests over 600 s in 7
days**, four killed at the 3,600 s Cloud Run timeout, `instance_count` pinned at
maxScale 20 with 11 queued. `stock-document-ingest` already proved the answer —
**one document per message dissolves the constraint rather than tuning against
it**: no page to truncate, no remainder to chain, no scan to cap, and Pub/Sub's
own concurrency replaces all three. _Files:_
`workers/src/processors/stock-document-embed.ts` + `-logic.ts` ·
`packages/types/src/pubsub.ts` (message shape) ·
`scripts/ops/setup-scheduler.sh` (the publisher becomes a selector).
_Depends:_ nothing. _Acceptance:_ zero requests over 600 s on that subscription
for 7 days, and the dead-letter rate from it at zero. _Risk:_ the historical
backlog can no longer ride the same lane — it is drained by a Cloud Run job with
no ack deadline, exactly as MONEY-1314 did for ingest. Size that separately.

**Q2 · The dedupe-409 → dead-letter loop.**
_Goal:_ a redelivery whose claim is still live must stop consuming delivery
attempts. _Why:_ at 600 s Pub/Sub redelivers; `pubsubDedupeMiddleware`
(`workers/src/lib/pubsub-dedupe.ts:127`, registered on `/jobs/*` after the OIDC
gate) correctly answers **409 `RETRY_LATER`** rather than running it twice — but
**Pub/Sub counts a 409 as a delivery attempt**, so after 5 (~20–25 min) the
message is DEAD-LETTERED and the founder is notified **while the original
execution is still running and will succeed**. 368 of those a day from one
subscription. _The fix:_ a redelivery against a live claim must be **ACKed**
(2xx, "already in flight, dropped") rather than retried — the same reasoning
that makes the retired `financial-data-sync` route answer `200 {retired:true}`:
Pub/Sub ACKs only on 2xx, and a semantically tidy 4xx NACKs. _The precondition,
stated because dropping work is otherwise unsafe:_ the claim's TTL must be
shorter than the ack deadline, and the handler must be idempotent and
checkpointed, so a crashed original is re-selected by the next run rather than
lost. _Files:_ `workers/src/lib/pubsub-dedupe.ts` · `workers/src/index.ts:263`.
_Depends:_ Q1 (it removes most of the traffic that triggers this).
_Acceptance:_ dead-letter count from `stock-document-embed-prod-push` at zero
for 7 days **with** a non-zero "dropped redelivery" counter — a zero on both
would mean the path is untested, not fixed. _Risk:_ this is the task where
"drop the message" can become data loss. The claim TTL and the checkpoint are
not optional details; they are the whole safety argument. The notification half
is MONEY-1390 and is separate.

**Q3 · The split — the US requirement plan 2's D5 must satisfy.**
_Goal:_ state what the worker split has to guarantee for US jobs, and let **D5**
(plan 2) build it. _Why:_ 67 job routes are mounted in one Cloud Run service,
where one PDF or candle job OOM-kills the container for everything else — that
is D5's own framing and it is correct. Duplicating it here would be a second
plan for one change. **What this plan requires of it:** `us-eod-sync`,
`us-instrument-master-sync`, `us-screener-project`, `tiingo-news-poll` and
`candle-evict` must not share an instance pool with `stock-document-embed`,
which today pins maxScale 20 and queues 11 behind itself. In D5's five classes
that is `ingest-market` vs `documents` — so the requirement is already expressed
by D5's taxonomy, and this task is to **name it as a constraint on D5's
acceptance** rather than to build anything. _Files:_ a line in
`product-surfaces-plan-sep2026.md` §D5 acceptance.
_Depends:_ nothing. _Acceptance:_ D5's acceptance criteria name US-job isolation.
_Risk:_ **D5 must go last of everything** (its own ordering constraint), so this
plan must not depend on it. Q1 and Q2 are the parts that deliver value before
the split and they are deliberately independent of it.

**Q4 · Every new US job is a Cloud Run JOB, not a Pub/Sub handler.**
_Goal:_ a standing rule, enforced. _Why:_ `us-screener-project` (U2),
`fx-backfill-usdinr` (X1), `us-history-request` (H4) and the corporate-action
loader (H2) are all multi-hour, whole-universe passes. Putting any of them
behind a push subscription re-creates the 600 s problem this lane exists to
remove — and the repo already has the pattern in `databento-harvest`,
`tile-build-d1` and `corp-action-lake-sink` (which is a job specifically because
the workers SA holds no BigQuery grant). _Files:_ `workers/tsup.config.ts` (one
entry per job — `SETUP_SCRIPT_BY_ENTRYPOINT` and the release re-pin loop key on
it) · `scripts/ops/setup-*-job.sh`. _Depends:_ nothing.
_Acceptance:_ a test asserting no new `/jobs/*` route is added for any task in
this plan. _Risk:_ **a Cloud Run JOB pins its image and its env at setup time
and does NOT inherit the service env block.** Re-run `setup-*-job.sh` after
every deploy, and read the DEPLOYED state rather than the spec — `feed-parse-prod`
and `xbrl-reparse-prod` carried no `DD_*` env for months while the provisioner
was correct.

---

## 6. Dependency ordering

```
L3 ──► L2 ──┬──────────────────────────────────────────────────────────┐
            │                                                          │
            ├─► U1 ──► U2 ──► U3 ──► U4 ──┐                            │
            │            │                ├─► V3 (screener, 3 modes)   │
            │            └─► F2 ◄── F1     │                           │
            │                     └─► F3   │                           │
            ├─► U5 ─────────────────────────┘                          │
            │                                                          │
            ├─► X1 ──► X2 ──► X3 ────────► V5 · V6                     │
            │                                                          │
            ├─► R1 ──► R2 ──────────────► V4                           │
            │                                                          │
            └─► V1 (persona) ──► V2 (stock page) ──► V7 (mobile)       │
                                    ▲                                  │
                                    └── H5 (tiles) ◄── MONEY-1513 [plan 1]
H1 (independent)      H3 ──► H4
H2 ◄── MONEY-1513 [plan 1]
Q1 ──► Q2        Q3 ──► D5 [plan 2, LAST]        Q4 (standing rule)
L1 (commercial) gates SHIPPING everything, blocks BUILDING nothing
F4 (purchase)  gates the fund modes' completeness, blocks nothing
```

**Three hard facts about this graph.**

1. **`L1` is not on the critical path for building and is the only thing on the
   critical path for launching.** Every lane can be built, tested and shipped
   behind the founder allowlist without it.
2. **`H5` is the one place this plan waits on another plan.** MONEY-1513 is
   plan 1's and does not exist as code. The recommended escape is the S3
   `CandleRepository` fallback in `/udf/history`, which unblocks V2/V3/V7 today
   and leaves one read path to retire later.
3. **`Q3 → D5` runs last of everything, by D5's own constraint.** Q1 and Q2 are
   deliberately independent of it so the 600 s defect is fixed long before the
   split.

---

## 7. Sequencing

| Wk  | L — Gates                      | U/F — Universe & funds                        | X/H — Money & history                                 | R/V — Product                       | Q — Queue              |
| --- | ------------------------------ | --------------------------------------------- | ----------------------------------------------------- | ----------------------------------- | ---------------------- |
| 1   | **L3** audit · **L2** selector | **U1** schema · **F1** decision               | **H1** adjustment rule · **X1** fx key + backfill     | **V1** persona (W12)                | **Q1** embed batch=1   |
| 2   | —                              | **U2** projection job                         | **H3** hot-load runtime proof                         | W00 primitives                      | **Q2** dedupe ACK      |
| 3   | —                              | **U3** `screenUs()` · **U5** search telemetry | **X2** denomination · **H5** decide the tile fallback | **V2** US stock page (W09)          | —                      |
| 4   | —                              | **U4** named absence · **F2** filter registry | **X3** toggle states                                  | **V3** screener, 3 modes (W02)      | —                      |
| 5   | **L1** licence decision        | **F3** US fund NAV serving                    | **H4** archived fetch                                 | **V4** StockSage US (W06)           | —                      |
| 6   | —                              | **F4** fund reference decision                | **H2** corp-action loader _(needs 1513)_              | **V5** dashboard · **V6** watchlist | —                      |
| 7–8 | widen allowlist **if L1 yes**  | re-measure coverage                           | —                                                     | **V7** mobile (M20)                 | **Q3** → D5 constraint |

_Status legend:_ nothing in this plan is started. Every row is _no ticket_.

---

## 8. Where the design and the founder's brief disagree

Read these as **deliberate overrides**, recorded so nobody "fixes" the plan back
to the design later.

1. **US funds and ETFs — the design defers them; the brief requires them.**
   `v2 Screener.dc.html` renders `usSoon: usReal && S.mode !== "stocks"` and
   `mfShow: S.mode === "mf" && !isUS`, and W02 §1 implements a
   "US FUNDS & ETFS — LATER · Same switcher, next stop" panel plus an explicit
   Non-goal "US MF/ETF modes". The founder: _"the data is available for all US
   stocks and Funds so all filters should be working."_ **The brief wins (F1).**
   Cost of the override: the two new modes have **no mockup, no copy and no
   empty states** — F2 must not assume otherwise.
2. **"All filters working" cannot be true of fund reference data.** W02's US
   filter group is `SEC FUNDAMENTALS · FILING-DATED` (Mcap > $10B, PE < 25,
   ROE > 15 %, FCF positive (10-K)) with chips
   `["Mega cap","Profitable","PE < 25","Dividend payers","Near 52w high"]` —
   all stock-shaped, and W02 already says _"implement only the filters the data
   supports; others render disabled with tooltip 'not derivable yet'."_ That
   instruction is right and it is the honest form of the brief for funds: expense
   ratio, AUM, category and issuer are **not derivable from anything we hold**
   (C-2, F4).
3. **The design's own Decisions log lists five items as OPEN that are still
   open**, and two of them gate tasks here: _"RBI reference-rate fetcher is a
   stub (`fetchFromRbi` returns null, MONEY-217)"_ — X2's COST arm — and
   _"StockSage US arm — no US tools in the research registry"_ — R1. A third,
   _"Databento is not on main yet"_, is now stale: it is on main, loaded, and
   **irrelevant to this plan** (its M1/H1 bars are backtest inputs, not the
   EOD series the product renders).
4. **Decision 01 says US quotes are EOD at launch.** Nothing in the founder's
   brief contradicts it, and this plan does not propose live US ticks. Worth
   stating because `TIINGO_RT` exists and is running — it is **ingest-only** and
   stays that way here.
5. **W09's chart already had its second read path removed** (cross-pack C1):
   `getUsStockCandlesAction` and `/us/candles` are gone, the chart is the shared
   `TradingViewAdvancedChart` on whatever `UDF_BASE_URL` points at. **H5 is the
   consequence nobody followed through on** — that shared path serves tiles
   only, and `tiles/US/` is empty. _(23-Sep: it is not — 90,447 objects under
   `tiles/US/d1/` with four sharded manifests; see the correction under H5.)_

---

## 9. Still open — and what measurement settles each

| Open                                                                         | What settles it                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **L1** — buy the $250/mo Tiingo redistribution plan, or keep US founder-only | A founder decision. Nothing technical is blocked either way; ten tasks assume one answer.                                                                                      |
| US fund NAV depth (C-2)                                                      | `us_fund_nav`: distinct `permaTicker` count, and p10/p50/p90 of `max(date) − min(date)` per permaTicker. Decides whether F2 ships 1Y/3Y/5Y fund filters or only 1M/3M/6M.      |
| Real fundamental coverage (C-1)                                              | `us_instruments {assetType:"Stock", listingStatus:"ACTIVE", cik:{not:null}}` joined to `us_fundamentals.cik10`. If well under 5,138, the gap is `EDGAR_CIK_ENRICH`, not EDGAR. |
| Is the D1 adjustment hazard live? (H1)                                       | `count(candles where timeframe="D1" and source != "TIINGO")`. Zero ⇒ confined to a future intraday-adjusted read.                                                              |
| H5 — fallback now, or wait for MONEY-1513?                                   | A decision, informed by whether plan 1 schedules 1513. Recommendation: fallback now, `builtFrom: "candles"`.                                                                   |
| F4 — buy US fund reference data?                                             | A quoted price for expense ratio + AUM + category coverage over 32,943 active US funds and ETFs.                                                                               |
| Atlas Search health on prod for `us_instrument_search` (U5)                  | The per-rung counter, observed non-zero on `atlas` for a week. QA cannot answer this — QA has no Atlas Search.                                                                 |
| MONEY-217 (RBI fetcher)                                                      | Not this plan's, but X2's COST arm and all of plan 5 are blocked on it in production.                                                                                          |
| `FxRate` key change on a live collection (X1)                                | `count(fx_rates where source is absent)` before the `db push`. A Mongo unique index is not sparse.                                                                             |

---

## 10. Tickets

Filed 2026-09-23; 32 new, 5 reused (plus 8 new lane epics, one per lane).

~~**NONE OF THESE EXIST.**~~ _(23-Sep: all filed — numbers below, each read back from Linear.)_ File any new task the same way and read the id back; never guess a number.
A guessed MONEY number in this repo once landed on a real teammate's live bug.

| Task | Title                                                           | Ticket                                                      | Epic       |
| ---- | --------------------------------------------------------------- | ----------------------------------------------------------- | ---------- |
| L1   | Tiingo redistribution plan — licence decision for US serving    | MONEY-1563 + MONEY-1262 (existing)                          | MONEY-1549 |
| L2   | One `useUsLayer()` selector: licence + flag on every US surface | MONEY-1562                                                  | MONEY-1549 |
| L3   | US gate audit — every route, both gates, written down           | MONEY-1561                                                  | MONEY-1549 |
| U1   | `us_screener_row` schema + named coverage enums                 | MONEY-1566                                                  | MONEY-1550 |
| U2   | `us-screener-project` Cloud Run job (`US_SCREENER_APPLY`)       | MONEY-1568                                                  | MONEY-1550 |
| U3   | `screenUs()` — US screener query surface                        | MONEY-983 (existing)                                        | MONEY-1550 |
| U4   | Named-absence contract: counted, labelled exclusions            | MONEY-1569                                                  | MONEY-1550 |
| U5   | US search — report which rung answered                          | MONEY-1570                                                  | MONEY-1550 |
| F1   | Delete the "US FUNDS & ETFS — LATER" deferral                   | MONEY-1571                                                  | MONEY-1551 |
| F2   | Filter registry: `appliesTo` / `requires`, three US modes       | MONEY-1574                                                  | MONEY-1551 |
| F3   | US mutual-fund NAV serving path in `apps/market-data`           | MONEY-1572                                                  | MONEY-1551 |
| F4   | US fund reference data — buy, scrape or scope out               | MONEY-1573                                                  | MONEY-1551 |
| X1   | `FxRate` unique key gains `source`; USDINR backfill to 2016     | MONEY-1575                                                  | MONEY-1553 |
| X2   | One denomination function; a missing rate is never a number     | MONEY-1576                                                  | MONEY-1553 |
| X3   | `$ → ₹` disabled with a reason, not blank                       | MONEY-1578                                                  | MONEY-1553 |
| H1   | US daily adjustment: state the bar-wins rule, pin it            | MONEY-1577                                                  | MONEY-1554 |
| H2   | `us_corporate_actions` → `lake_silver.corporate_action`         | MONEY-1579                                                  | MONEY-1554 |
| H3   | Runtime proof of the cold→hot candle demand-load                | MONEY-1580                                                  | MONEY-1554 |
| H4   | Archived-data fetch: three classes, three answers               | MONEY-1582                                                  | MONEY-1554 |
| H5   | US tile chain — fallback decision (blocked on MONEY-1513)       | MONEY-1581                                                  | MONEY-1554 |
| R1   | US tools in the research registry + `market` on the plan        | MONEY-1583                                                  | MONEY-1555 |
| R2   | Gate before spend; the licence applies to the report            | MONEY-1585                                                  | MONEY-1555 |
| V1   | W12 — market persona + Settings → Market preferences            | MONEY-1584                                                  | MONEY-1557 |
| V2   | W09 — US stock page                                             | MONEY-1586                                                  | MONEY-1557 |
| V3   | W02 — unified screener, US pill, three US modes                 | MONEY-1587                                                  | MONEY-1557 |
| V4   | W06 — StockSage US deltas + model picker                        | MONEY-1588                                                  | MONEY-1557 |
| V5   | W01 — dashboard US drop-ins                                     | MONEY-912 (existing)                                        | MONEY-1557 |
| V6   | W10 — watchlist US deltas (holdings half is plan 5)             | MONEY-1589                                                  | MONEY-1557 |
| V7   | M20 — mobile US layer                                           | MONEY-1590 (container) → MONEY-1591, MONEY-1592, MONEY-1593 | MONEY-1557 |
| Q1   | `stock-document-embed` — one document per message               | MONEY-1389 (existing)                                       | MONEY-1558 |
| Q2   | Dedupe redelivery ACKs instead of burning delivery attempts     | MONEY-1594                                                  | MONEY-1558 |
| Q3   | US-job isolation as a constraint on D5's acceptance             | MONEY-1525 (existing)                                       | MONEY-1558 |
| Q4   | Standing rule: whole-universe US work is a Cloud Run job        | MONEY-1595                                                  | MONEY-1558 |

---

## Sources

**Design (canonical):** `docs/prompts/design-v2/` — `README.md`,
`00-shared-context.md`, `web/W00–W15`, `api/A01–A02`, `mobile/M00–M22`;
`docs/design/v2-bundle/` — `Decisions - US Launch.dc.html` (9 decisions),
`Spec v2 - Core Surfaces.dc.html`, `v2 Screener.dc.html`, `v2 US Launch.dc.html`,
`web/v2data.js`. **Plans:** `data-platform-plan-v2.3-sep2026.md`,
`product-surfaces-plan-sep2026.md`, `news-events-plan-sep2026.md`,
`cross-pack-reconciliation-sep2026.md`, `claude-code-prompts-snaptrade.md`
(plan 5). **Repo, read 23-Sep:** `packages/database/prisma/schema.prisma`
(`UsInstrument:6868`, `UsFundamentals:8284`, `UsCompanyFact:8366`,
`UsFundNav:6977`, `Candle:7086`, `UsCorporateAction:7659`, `FxRate:7233`) ·
`packages/core/src/market-data/us-market-access.ts` ·
`packages/core/src/market-data/candles/{candle-repository,candle-cold-store,candle-logic}.ts`
· `packages/core/src/market-data/tiles/tile-logic.ts` ·
`packages/services/src/screener.service.ts` · `scans.service.ts:369` ·
`packages/services/src/gst/rbi-fx.ts` · `packages/core/src/currency/exchange-rates.ts`
· `packages/lake/src/corp-action-logic.ts:65` · `packages/lake/ddl/002_silver_price_bars.sql:91`
· `dataform/includes/adjustment.js:553` · `dataform/definitions/gold/adjusted_bar_d1.sqlx`
· `scripts/jobs/{tile-build-d1,corp-action-lake-sink,tiingo-us-corp-actions-backfill,tiingo-us-backfill}.ts`
· `workers/scripts/setup-pubsub.sh` · `workers/src/lib/pubsub-dedupe.ts:127` ·
`workers/src/processors/{stock-document-embed,us-eod-sync,us-eod-sync-logic,candle-evict}.ts`
· `workers/cloudbuild.{prod,qa}.yaml` (read as DEPLOYED) ·
`apps/market-data/src/routes/{history,symbols,udf}.ts` ·
`apps/web/lib/market/{us-instrument-search,us-access,us-interest}.ts` ·
`apps/web/lib/types/feature-flags.ts` · `apps/web/proxy-routes.ts` ·
`apps/api/src/lib/us-access.ts` · `apps/api/src/routes/v1/market.ts:506` ·
`docs/setup/us-feature-flags-setup.md` · root `CLAUDE.md`
(Tiingo, US REALTIME, Databento, SEC EDGAR, the 600 s ceiling).
