# P1-04 · US stock page `/us/stock/[symbol]` (W09 with Plan-4 deltas)

Ticket: MONEY-1586 (+ H lane MONEY-1554 → MONEY-1581 verification) · Branch: `feat/MONEY-1586` · Flag(s): `us-stocks-listing` (page), `us-stock-chart` (chart block), `us-stock-fundamentals` (ratios, financials, insiders, holders) · Screens: S1.3 · Depends on: P1-01 (`us_screener_rows`), P0-03, P0-08 (`convertUsd`/toggle), P0-09 (currency formatter) · Parallel-safe with: P1-02

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

Execute `docs/prompts/design-v2/web/W09-us-stock-page.md`, with the deltas below. The result is a mobile-first US stock page with:

- an EOD header;
- a KEY RATIOS grid read from `us_screener_rows`, every value carrying its filing chip;
- the shared chart on `/udf/history`;
- FINANCIALS, INSIDERS and HOLDERS tabs;
- a disclaimer with the listing id.

It is served from ONE service used by both the server actions and `/v1/us/stocks/:listingId/*`.

## Deltas from W09 (this prompt wins)

1. **Route.** The page moves to `/us/stock/[symbol]` (`?listing=<listingId>` for a delisted or ambiguous listing).
   - `/stock/[symbol]`'s US branch (`apps/web/app/stock/[symbol]/page.tsx:185-218`) becomes `redirect(usStockHref(us))`.
   - `usStockHref` (`apps/web/lib/market/us-href.ts`, from P1-03) flips to `/us/stock/…`.
   - Why: 214 tickers exist in both markets, and `/stock/X` asks India first.
2. **KEY RATIOS read `us_screener_rows`** (MONEY-1566). Never walk `UsFundamentals.standardized` per request.
3. **API family.** The API is `/v1/us/stocks/:listingId/*`, not W09's `/v1/stocks/:symbol/us/*` (shared context §2: one `/v1/us` family).
4. **FILINGS and EVENTS move to P1-05.** P1-05 builds one "News & filings" section (News | SEC filings | Events). This page leaves a tab slot for it.
5. **Out of this PR:**
   - the Alert action (there is no US `PRICE_EOD` evaluator; hand-off);
   - the holding line (plan 5 / P3-04);
   - the Watch ☆ and Research/Ask-Sage CTAs. P1-08 fills the header action slot; P2 lights up research.
6. **Chart.** Mount the shared `TradingViewAdvancedChart` with `symbol = listingId`, daily only. Build NO candle action or route (cross-pack C1). MONEY-1581 (H5) re-derived that `tiles/US/d1/` holds 90,447 objects. Build the block's DataGap state as the DEFAULT render (no bars → `DataGapBanner`), so the block is correct whether or not bars come back; the prod `/udf/history` check is a founder step after merge ("Founder, after merge"), never a session step.

## Why / measured state today (verified)

- `apps/web/app/stock/[symbol]/us-client.tsx` (200 lines) renders a quote only (`useQuote` + `ProvenanceChip` + `DelayedDataNote`), gated at `page.tsx:195` on `us-stocks-listing` && `currentUserMaySeeUsMarket()`. `apps/web/__tests__/market/us-stock-page-branch.test.ts` pins that branch.
- The read layer already exists: `@usemoney/core/us-fundamentals` (`packages/core/package.json:144`), `repository.ts`:
  - `resolveUsFiler` `:339`
  - `getStatements` `:415`
  - `getInsiderActivity` `:632`
  - `getTopHolders` `:779`
  - `getFilings` `:1185`

  **Pass `cik10` from the resolved listing, never a bare symbol.** `getTopHolders` takes only a symbol and resolves `listingStatus:"ACTIVE"` (`:385-395`), so for a DELISTED listing it would return the successor company's holders. Refuse holders for a delisted listing.

- Legends to reuse (pure, no I/O): `packages/research/src/tools/fetch-us-insider-trades.ts:25` `US_INSIDER_CODE_LEGEND`, `fetch-us-13f-holders.ts:59` `partitionHolders`, `fetch-us-financials.ts:77` `US_GAP_EXPLANATIONS`. Import by file path, never the `@usemoney/research` root barrel. If a subpath export is missing, add one.
- Filing links: `UsFiling` (`schema.prisma:8209`) has `accession`, `cik10` and `primaryDocument`, with no URL column. Derive `https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession without dashes}/{primaryDocument}` in pure logic. This is a link, not a fetch.
- Chart: `apps/web/components/charts/TradingViewAdvancedChart.tsx:194` `UDF_BASE_URL` and `:459-473` base resolution. `apps/market-data/src/routes/history.ts:102-103` treats a 3-part symbol as a US tile and gates the licence at `:219-227`. The market-data token carries the US claim (`apps/web/lib/actions/market-data-token.ts:68`).
- `apps/web/proxy-routes.ts:94` `APP_ROUTE_PATTERNS` has `"/stock(.*)"` and no `"/us(.*)"`. Add it.
- W00 components (`DataGapBanner`, `DelayedDataBadge`, `DualCurrency`) do NOT exist yet (`grep` returns nothing). If P0 has not created them, create the minimal ones this page needs in `apps/web/components/design-v2/` per W00 §"Create", each with a render test. `ProvenanceChip` exists in `apps/web/components/stock/SectionShell.tsx`: extend it, don't copy it.

## Read first (verified paths)

W09 in full; `apps/web/app/stock/[symbol]/{page,us-client,client}.tsx`; `apps/web/components/stock/{SectionShell,StockSectionTabs,StockInsiderTimeline,StockFinancialsTab,DayRangeBar}.tsx` + `day-range-logic.ts`; `packages/core/src/us-fundamentals/{repository,repository-logic,types}.ts`; `packages/types/src/us-screener.ts`; `packages/core/src/market-data/instruments/resolve-instrument.ts:202`; `apps/api/src/lib/us-access.ts:83`; `packages/services/src/us/registry.ts`.

## Build — in this order

### 1. Service — `packages/services/src/us/stock.service.ts` (+ `stock-logic.ts`, pure)

Inputs are zod in `stock-logic.ts`: `UsListingRefSchema = {listingId?: string, symbol?: string}` (exactly one) and `UsFinancialsInputSchema = {listingId, view:"standardized"|"asReported", period:"Q"|"A"}`.

| Export                                    | Reads                                                                                         | Returns (plain JSON)                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolveUsListing(userId, ref)`           | `UsInstrument` by listingId; or `resolveInstrument({symbol, market:"US"})` (current occupant) | `{listingId, symbol, name, exchange, assetType, listingStatus, listingEndDate, cik}` or NOT_FOUND                                          |
| `getUsStockOverview(userId, {listingId})` | `UsScreenerRow` + latest filing per ratio                                                     | header (lastClose, lastCloseDate, chg1D abs/%, high/low52w) + ratios `[{id, value, unit, filing:{form, filedAt, url}\|null}]` + `coverage` |
| `getUsStockFinancials`                    | `getStatements({cik10,…})` × 3 statements, last 3 periods + YoY                               | rows Revenue · Gross profit · Operating income · Net income · Diluted EPS · FCF (`derived:true`)                                           |
| `getUsStockInsiders`                      | `getInsiderActivity({cik10, windowDays:90})`                                                  | rows + summary; codes via legend; classes never summed                                                                                     |
| `getUsStockHolders`                       | `getTopHolders({symbol})`, ONLY when `listingStatus==="ACTIVE"`                               | top 10 + quarter; DELISTED → `{empty:true, reason:"DELISTED_LISTING"}`                                                                     |

- Every section returns `{data, asOf, empty, reason?}`.
- An absence is a named reason (reuse `US_GAP_EXPLANATIONS` keys), never `[]` alone.
- Cache: Redis L2 per `listingId:section`, TTL 6h. **Never cache a refusal or a failure** (key on determinacy).

### 2. Server actions — `apps/web/lib/actions/us-stock.ts`

One action per export: auth → DB user → `resolveUsLayer()` → flag (`us-stock-fundamentals` for the tabs; the overview header needs only `us-stocks-listing`) → schema → service. A refusal returns the same `NOT_FOUND` a bad listingId gets. No `@usemoney/database` import.

### 3. `/v1` routes + `US_SURFACES` rows — `apps/api/src/routes/v1/us/stocks.ts`

- `GET /v1/us/stocks/resolve?symbol=`
- `GET /v1/us/stocks/:listingId` (overview)
- `…/:listingId/financials?view=&period=`
- `…/:listingId/insiders`
- `…/:listingId/holders`

`listingId` is `encodeURIComponent`'d (it holds `:` and, for `NYSE ARCA`, a space). Decode once and validate with the shared schema. No `/candles`. Mount with one `usRoutes.route("/stocks", …)` line in `us/index.ts`.

Add 5 `US_SURFACES` rows. All five share `usAccess:"required"`, `serviceFile:"packages/services/src/us/stock.service.ts"`, `actionFile:"apps/web/lib/actions/us-stock.ts"` and `routeFile:"apps/api/src/routes/v1/us/stocks.ts"`:

| `surface`          | `flag`                  | `serviceExport`        | `routePath`                           |
| ------------------ | ----------------------- | ---------------------- | ------------------------------------- |
| `stock-resolve`    | `us-stocks-listing`     | `resolveUsListing`     | `/v1/us/stocks/resolve`               |
| `stock-overview`   | `us-stocks-listing`     | `getUsStockOverview`   | `/v1/us/stocks/:listingId`            |
| `stock-financials` | `us-stock-fundamentals` | `getUsStockFinancials` | `/v1/us/stocks/:listingId/financials` |
| `stock-insiders`   | `us-stock-fundamentals` | `getUsStockInsiders`   | `/v1/us/stocks/:listingId/insiders`   |
| `stock-holders`    | `us-stock-fundamentals` | `getUsStockHolders`    | `/v1/us/stocks/:listingId/holders`    |

### 4. UI — `apps/web/app/us/stock/[symbol]/{page,client,loading}.tsx`

- `page.tsx` (server): `resolveUsListing` from `params.symbol` + `searchParams.listing`. On a miss or refusal it calls `notFound()`, the identical 404 a random ticker gets. It warms the overview on the server. `noteUsSymbolInterest` is kept (`apps/web/lib/market/us-interest.ts`).
- 375px first. The tab bar scrolls inside its own row: Overview · Financials · Insiders · Holders · News (the News slot renders only when P1-05's `us-news` is on).
- Chart block (`us-stock-chart`): ranges 1M · 6M · 1Y · 5Y, `D` resolution only, caption "● DAILY CLOSES · NO INTRADAY". No bars shows `DataGapBanner` "No daily history on file for this listing", never a page error. 52W bar from the overview row.
- Money: `$` via the currency-parameterised formatter (P0-09). `DualCurrency` shows the ₹ secondary at SPOT with the as-of stamp (P0-08) and is hidden with a reason when the rate is missing (MONEY-1578).
- Disclaimer verbatim from W09, with "Listing {listingId}". No vendor name anywhere ("third-party consolidated tape").
- Delete `apps/web/app/stock/[symbol]/us-client.tsx`; repoint its test.

## Screens

### S1.3 — Overview, 375px

```
┌──────────────────────────────────────┐
│ ‹  AAPL                    ☆  ⋯      │
│ Apple Inc.                           │
│ US · NASDAQ · COMMON STOCK           │
│ $229.87            ◷ EOD · SEP 23    │
│ +$1.80 · +0.79% · previous session   │
│ ≈ ₹19,195 · SPOT ₹83.51/$ · 1H       │
├──────────────────────────────────────┤
│ [1M] 6M  1Y  5Y                      │
│  ╱╲    ╱╲╱╲      ╱                   │
│ ╱  ╲╱╱      ╲╱╲╱                     │
│ ● DAILY CLOSES · NO INTRADAY         │
│ 52W  $164.08 ━━━━━━━━●━ $237.23      │
├──────────────────────────────────────┤
│ Overview Financials Insiders Holders │
├──────────────────────────────────────┤
│ KEY RATIOS · STANDARDIZED            │
│ P/E TTM      35.1   [10-Q · AUG 02]  │
│ Gross margin 46.2%  [10-Q · AUG 02]  │
│ ROE         151.3%  [10-K · FY25]    │
│ Mkt cap     $3.49T  [EOD · SEP 23]   │
│ Div yield    0.43%  [EOD · SEP 23]   │
│ Analysis only — not investment       │
│ advice. Listing AAPL:NASDAQ:1980-12… │
└──────────────────────────────────────┘
```

### S1.3 — Holders, delisted `DOW:NYSE:1972-…`

```
┌──────────────────────────────────────┐
│ ‹  DOW · Dow Chemical   DELISTED 2017│
│ ⚠ 13F holders are matched by current │
│   ticker, so they are not shown for  │
│   a delisted listing.                │
└──────────────────────────────────────┘
```

1280px: two columns, with the chart and tabs left and the KEY RATIOS grid right. The financials table is full-width; below 768 it collapses to one card per line item.

| State      | Render                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| loading    | skeleton header + chart box + 6 ratio rows at final size                                                                |
| empty      | per section: named reason, e.g. "No 13F holders on file — filings arrive quarterly"                                     |
| error      | section-level `DataGapBanner` + Retry; header still renders                                                             |
| DataGap    | `coverage.fundamentalFill = NO_CIK/NO_FILINGS` → ratios show `—` + one banner "No SEC filings on file for this listing" |
| gated (U5) | page shows header identity + GateInline "US stocks are part of PRO" in place of prices/tabs                             |
| flag-off   | `/us/stock/*` → 404 (identical to unknown ticker); chart/fundamentals blocks absent when their own flag is off          |
| demo       | AAPL fixture for every section (P0-07 dataset)                                                                          |

| User | Behaviour                             |
| ---- | ------------------------------------- |
| U1   | 404 (layer absent)                    |
| U2   | full page                             |
| U3   | 404 until US in market prefs + access |
| U4   | demo AAPL                             |
| U5   | GateInline, no numbers leaked         |
| U6   | full                                  |
| U7   | full                                  |

## Cross-surface access (§6)

1. Search: P1-03 links here through `usStockHref`. 2. Watchlist: a header ☆ slot (P1-08 fills it). 3. Sage: a header slot, rendered only under `us-stock-research` + `us-sage-entrypoints` (P1-08). 4. Home: P1-08 US card links here. 5. Deep link: `/us/stock/AAPL`, `?listing=` for a delisted listing; not in the sitemap (licence). 6. API: 5 routes + rows. 7. Demo: AAPL fixture. 8. Telemetry: `us_stock_viewed {flag:"us-stocks-listing", listingId}`, `us_stock_tab {tab}`.

## Tests

- `packages/services/__tests__/us-stock-logic.test.ts`:
  - EDGAR URL derivation;
  - YoY with a missing prior period gives null;
  - FCF is marked derived;
  - insider classes are never summed across codes.
- `packages/services/__tests__/us-stock-service.test.ts`:
  - **DOW:** `resolveUsListing({symbol:"DOW"})` returns the 2019 listing; `{listingId:"DOW:NYSE:1972-…"}` returns the delisted one; holders for it are `DELISTED_LISTING`; financials are read by that listing's `cik`, never the symbol.
  - A refusal equals NOT_FOUND.
- `apps/web/__tests__/app/us-stock-page.test.tsx`:
  - **no `₹` glyph in any USD field** (the secondary ₹ appears only inside `DualCurrency`'s labelled slot);
  - no India-only section component (Derivatives, Deals, Shareholding, Circulars) is imported by the US client;
  - no vendor string (`Tiingo|Databento`) in rendered output.
- `apps/api/__tests__/routes/us-stocks-contract.test.ts`: envelopes, an encoded listingId round-trip with a space (fixture `SPY:NYSE ARCA:<start>`), absence on refusal, and `V1_ENDPOINTS` still 39 (no new family).
- The redirect test replaces `us-stock-page-branch.test.ts`. `TEST-COVERAGE.md` updated.

## Acceptance

- [ ] The chart block's DataGap state is the default render and is covered by a render test (no bars → `DataGapBanner`, never a page error). No fallback data source is added.
- [ ] Locally against QA (whose US collections are prod copies), AAPL, MSFT and NVDA render every tab from real rows. A small cap with `NO_CIK` renders the named gaps. If QA has no `us_screener_rows` yet (P1-01's founder steps not run), say so in the PR and render from fixtures.
- [ ] DOW current vs delisted behave as tested.
- [ ] U1/U2/U5 at 375/1280, light and dark; `verify:push`; `/code-review`.

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- **H5 verification (MONEY-1581):** read AAPL's real `listingId` from prod `us_instruments`. As the founder on prod, `/udf/history?symbol=<that listingId, URL-encoded>&resolution=D` returns bars; as a non-allowlisted user it returns the named refusal. If bars are absent, the chart block already shows its DataGap state; file the gap under the H lane (MONEY-1554) rather than adding a fallback.
- Turn `us-stocks-listing`, then `us-stock-chart` and `us-stock-fundamentals`, on for the founder only and check `/us/stock/AAPL` on a phone.

## Out of scope / hand-offs

The News/Filings/Events section (P1-05). ☆ and Ask-Sage (P1-08). US price alerts (no evaluator; needs its own ticket, not invented here). The holding line (P3-04). The cold-year "full history" badge (MONEY-1582).
