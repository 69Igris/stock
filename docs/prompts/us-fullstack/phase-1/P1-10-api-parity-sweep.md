# P1-10 · `/v1/us/*` parity sweep for every Phase-1 US surface

Ticket: MONEY-1630 · Branch: `feat/MONEY-1630` · Flag(s): none new (routes obey each surface's flag via `/v1/me/flags`) · Screens: none · Depends on: P1-01 … P1-09 merged · Parallel-safe with: — (runs last)

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

Prove that every Phase-1 web surface has a `/v1` twin calling the SAME service export, under the SAME gate, answering refusal as ABSENCE, and returning plain JSON a mobile client can decode. Fill any gap the sweep finds and pin the whole set with contract tests. After this PR, M20 (parked) is a client, not a rewrite.

## Why / measured state today (verified)

- Before Phase 1, `apps/api` had exactly one US route: `GET /v1/market/us/quotes` (`apps/api/src/routes/v1/market.ts:506`), licence-gated through `mayServeUsMarket` (`apps/api/src/lib/us-access.ts:83`, used at `market.ts:556`). **PLAN §4 measured it as carrying NO product flag**, the MONEY-1142 shape: a dark page in front of open data.
- `V1_ENDPOINTS` (`apps/api/src/routes/v1/index.ts:60`) is pinned in `apps/api/__tests__/routes/v1-helpers.test.ts:219` and `parity-p14-discover-sections-contract.test.ts`, at 39 since P0-01 added `/v1/us`. Phase 1 must not have moved it again.
- The expected Phase-1 surface set, from P1-03…P1-09 (verify each exists; the sweep's job is to find where reality differs):

| Surface (US_SURFACES)                                                              | Service export                      | Web action file               | Route                                                                                   | Flag                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| search                                                                             | `searchUs`                          | `lib/actions/us-search.ts`    | `GET /v1/us/search`                                                                     | us-stocks-search                          |
| (recents; no row)                                                                  | `listRecents`/`recordRecent`        | `lib/actions/us-search.ts`    | `GET/POST /v1/me/recents`                                                               | us-stocks-search (US rows)                |
| stock-resolve / stock-overview / stock-financials / stock-insiders / stock-holders | `stock.service.ts` exports          | `lib/actions/us-stock.ts`     | `GET /v1/us/stocks/resolve`, `/:listingId`, `/:listingId/{financials,insiders,holders}` | us-stocks-listing / us-stock-fundamentals |
| stock-feed, market-feed                                                            | `getUsStockFeed`, `getUsMarketFeed` | `lib/actions/us-news.ts`      | `GET /v1/us/stocks/:listingId/news`, `GET /v1/us/news`                                  | us-news                                   |
| screener                                                                           | `screenUs`                          | `lib/actions/us-screener.ts`  | `POST /v1/us/screener`                                                                  | us-screener (+ us-funds for MF/ETF)       |
| markets                                                                            | `getUsMarketOverview`               | `lib/actions/us-markets.ts`   | `GET /v1/us/markets`                                                                    | us-market-overview                        |
| watchlist-add (`familyException`)                                                  | `addWatchlistItem`                  | `lib/actions/watchlist.ts`    | `POST /v1/watchlists/:id/items(/batch)`                                                 | us-watchlist                              |
| watchlist-quotes                                                                   | `getUsWatchlistQuotes`              | `lib/actions/us-watchlist.ts` | `GET /v1/us/watchlist/quotes`                                                           | us-watchlist                              |
| home                                                                               | `getUsHomeCard`                     | `lib/actions/us-home.ts`      | `GET /v1/us/home`                                                                       | us-dashboard                              |
| fund                                                                               | `getUsFund`                         | `lib/actions/us-funds.ts`     | `GET /v1/us/funds/:listingId`                                                           | us-funds                                  |

- Chart bars are NOT an `apps/api` route: mobile reads `apps/market-data` `/udf/history` (MONEY-1630 rule; design-v2 README open item 9). No `/v1/us/candles` may exist; the sweep asserts that.

## Read first (verified paths)

`packages/services/src/us/registry.ts` + `us-surface-parity.test.ts` (P0-01); `apps/api/src/routes/v1/us/*`; `apps/api/src/routes/v1/{index,market,watchlist,me}.ts`; `apps/api/src/lib/us-access.ts`; the flag registry + `/v1/me/flags` (P0-02); `resolveUsLayer` (P0-03); `apps/api/__tests__/routes/{v1-helpers,market-us-quotes-contract,parity-p14-stock-sections-contract}.test.ts` (the contract-test shape to copy); `apps/api/CLAUDE.md`.

## Build — in this order

### 1. Service

No new services unless the sweep finds a web surface with no service export (a component calling Prisma, or an action with inline queries). In that case, move the logic into `packages/services/src/us/<surface>.service.ts`, the same PR, same shape.

### 2. Server action

Audit every `apps/web/lib/actions/us-*.ts`. Each must follow: auth → user → `resolveUsLayer()` → flag via the registry → the SHARED zod schema (imported, never copied) → service. Fix drift in place.

### 3. `/v1` routes + `US_SURFACES`

- For each row above: the route exists, imports the same export the action imports, gates with the same `resolveUsLayer` rule plus the same flag (read through the P0-02 registry server evaluation, never a fifth hand-copied flag list), and answers refusal byte-identically to "not found / empty".
- Add the missing product flag to `GET /v1/market/us/quotes` (`us-stocks-listing`), keeping its empty-quote-map absence (`market.ts:556-562`). Register it: `{surface:"quotes", flag:"us-stocks-listing", usAccess:"required", serviceExport:"getUsQuotes", serviceFile:"packages/services/src/us/quotes.service.ts", actionFile:"apps/web/lib/actions/us-quotes.ts", routeFile:"apps/api/src/routes/v1/market.ts", routePath:"/v1/market/us/quotes", familyException:"existing market-family contract; moving it would break current clients"}`. If the route's quote read is inline today, move it into that service (and give the web a thin action) in this PR, per §1 above.
- Every US list endpoint paginates through `@usemoney/api-utils` cursors (`packages/api-utils/src/pagination/index.ts:24-69`); the web action exposes the same cursor.
- Update `apps/api/CLAUDE.md` with the `/v1/us/*` table above, and the root `CLAUDE.md` "Monorepo Structure" line for `apps/api`.

### 4. UI

None.

## Tests

- `apps/api/__tests__/routes/us-parity-sweep-contract.test.ts`, table-driven over `US_SURFACES`:
  1. **Absence:** for an unentitled user, flag off, and entitled with an unknown id, status and body shape are identical, never 403 and never a body that names the listing.
  2. **Plain JSON:** a fixture response survives `JSON.parse(JSON.stringify(x))` deep-equal. No `Date` instances or `Decimal`s; every date field matches ISO-8601.
  3. **Same export:** route and action import the same service export (reuse the P0-01 parity helper, not a second scanner).
  4. **No database import** in any `apps/api/src/routes/v1/us/*` or `apps/web/lib/actions/us-*` file.
  5. **No candles route:** no path under `/v1/us` matches `/candles|bars|history/`.
  6. **Money:** a USD surface response carries `currency:"USD"` where money renders. A rendered-string scan of each fixture finds no `₹` in USD fields.
  7. **DOW:** every `:listingId` route given `DOW:NYSE:<1972 start>` and `DOW:NYSE:<2019 start>` fixtures returns two different identities. No route accepts a bare `DOW` except `/resolve` and `/search`.
- `market-us-quotes-contract.test.ts`: extend it so a product-flag-off request returns the empty map (not 403).
- `v1-helpers.test.ts`: the pin is still 39, unchanged by Phase 1.
- `TEST-COVERAGE.md` updated; `yarn test:coverage-check`.

## Acceptance

- [ ] The sweep table in the PR body shows, per row: route present ✓, same export ✓, gate ✓, absence ✓, JSON ✓. Any row fixed in this PR is named.
- [ ] `/v1/market/us/quotes` now respects `us-stocks-listing`: the contract test shows flag on gives quotes and an allowlisted user with the flag off gets an empty map (not 403).
- [ ] The family count is 39; `verify:push`; `/code-review ultra` (entitlement path).

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- On prod: `/v1/market/us/quotes` as the founder with `us-stocks-listing` on gives quotes; a second allowlisted test user with the flag off gets an empty map.

## Out of scope / hand-offs

Mobile screens (M20, parked). `/udf/history` auth for mobile (MONEY-1477 / design-v2 README item 9). Phase-2 research routes.
