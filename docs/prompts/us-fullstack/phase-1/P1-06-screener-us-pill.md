# P1-06 · Screener US pill — US STOCKS mode on `/discover/screener` (W02's US part)

Ticket: MONEY-1587 (+ MONEY-983) · Branch: `feat/MONEY-1587` · Flag(s): `us-screener` · Screens: S1.4 · Depends on: P1-02 (registry, envelope, `ExclusionRow`), P1-01 (`us_screener_rows`), P1-04 (`usStockHref` → `/us/stock/…`), P0-06 (`MarketPill`), P0-08 (toggle) · Parallel-safe with: P1-07

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

A `US` market pill in the existing screener's STOCKS mode. Selecting it screens `us_screener_rows` with the registry's STOCK filters and shows the results with `$` prices, EOD badge, a LATEST FILING column and the **named-absence row** under the results. `screenUs` is ONE service called by the server action and `POST /v1/us/screener`. India output stays byte-identical. The MF/ETF US modes are P1-09.

## Deltas from W02 (this prompt wins)

- Execute ONLY W02 §1 (the pill), §4 (the US filter groups and chips), §5 (US row format, the `$→₹` toggle, the footer) and §6 (states). **Do NOT build the rest of W02's `screener-v2` re-skin** (scans rail, AI search row, overflow menu, presets). That is India work under its own flag.
- The "US FUNDS & ETFS — LATER" panel is **never built** (MONEY-1571, a deliberate override of the design). With `us-funds` off, the pill is simply absent in MF/ETF modes.
- MONEY-983's decision, recorded here: **`market` is a request axis, not a stored column.** The US path reads `us_screener_rows` only. India keeps its exchange-scoped where (`packages/services/src/screener.service.ts:443-444`, `apps/web/lib/screener/match-score.ts:510-512`). No `{market:"IN"}` predicate is added anywhere, because it matches zero on pre-existing rows.
- The API is `POST /v1/us/screener`, not "`/v1/screener/stocks` accepts `market`" (plan U3). The shared context's single `/v1/us` family wins.
- The LATEST FILING column reads `fundamentalsAsOf` + `fundamentalsForm`.

## Why / measured state today (verified)

- The screener: `apps/web/app/discover/screener/{page,client,stocks-mode,mf-mode,etf-mode}.tsx` (client 1,012 lines; URL state `?mode=stocks|mf|etf&stocks.pe=…`, `client.tsx:10`; `ModeTabs` at `:727`). India only; there is no market pill (MONEY-983's grep: zero hits for `setMarket|marketTab|CHIPS_US`).
- **Anti-example to NOT extend:** `apps/web/lib/actions/screener.ts` runs its own `prisma` queries (`:51`, `:790-794`), parallel to `packages/services/src/screener.service.ts`, which `apps/api/src/routes/v1/screener.ts:35` calls. Two implementations. The US leg is a separate action file and never touches it. Converting India is out of scope: file it in the PR as a follow-up per shared context §2 (no invented ticket number; ask the founder to file it).
- `V1_ENDPOINTS` (`apps/api/src/routes/v1/index.ts:60`) is pinned at 39 after P0-01, which added `/v1/us`. This PR adds a sub-path, not a family, so it stays at 39.
- W00's `MarketPill` does not exist in the repo today. It comes from P0-06; if it is missing, STOP and report.

## Read first (verified paths)

W02 §1/§4/§5/§6; `apps/web/app/discover/screener/{client,stocks-mode}.tsx`; `apps/web/components/screener/{ModeTabs,FilterSidebar,QuickFilterChips,ResultsTableShell,ScreenerPagination,StockCardCompact}.tsx`; `packages/core/src/market-data/us-screener/filter-registry.ts`, `packages/services/src/us/screener-logic.ts`, `apps/web/components/screener/us/ExclusionRow.tsx` (P1-02); `packages/types/src/us-screener.ts`; `apps/api/src/routes/v1/screener.ts` (envelope helpers `safeJson`/`zodParse`/`error`).

## Build — in this order

### 1. Service — `packages/services/src/us/screener.service.ts`

`screenUs(userId, req: UsScreenRequest): Promise<ServiceResult<UsScreenResponse>>`:

- `where = buildUsScreenWhere(req)` restricted to `assetType` of the mode.
- `universe = count(assetType)`.
- `matched = count(where)`.
- `excluded = accountExclusions(…)`.
- rows through `findMany` with the cursor on `(sortField, listingId)`.
- `asOf` = max `lastCloseDate` in the page.

Reads `usScreenerRow` ONLY. The schema is `UsScreenRequestSchema` from `screener-logic.ts`. Redis 10 min per request hash; never cache a failure.

### 2. Server action — `apps/web/lib/actions/us-screener.ts`

`screenUsAction(req)`: auth → user → `resolveUsLayer()` → `us-screener` flag → schema → service. A refusal returns `{rows:[], matched:0, universe:0, excluded:{}}`, the same shape as "no matches". No `@usemoney/database` import.

### 3. `/v1` route + `US_SURFACES` row — `apps/api/src/routes/v1/us/screener.ts`

`POST /v1/us/screener` (body = `UsScreenRequestSchema`). Row `{surface:"screener", flag:"us-screener", usAccess:"required", serviceExport:"screenUs", serviceFile:"packages/services/src/us/screener.service.ts", actionFile:"apps/web/lib/actions/us-screener.ts", routeFile:"apps/api/src/routes/v1/us/screener.ts", routePath:"/v1/us/screener"}`. Mount with one `usRoutes.route("/screener", …)` line.

### 4. UI

- `MarketPill` (INDIA | US) to the right of `ModeTabs`, rendered only when `usLayer.on && flags["us-screener"]`. The URL is `?mode=stocks&market=US&us.peTtm=0-25`. The `us.` prefix never collides with `stocks.`/`mf.`/`etf.`, and an old URL without `market` stays India.
- `apps/web/app/discover/screener/us-stocks-mode.tsx`: the filter groups come from `filtersForMode("STOCK")`:
  - "SEC FUNDAMENTALS · FILING-DATED" (market cap, P/E, ROE, net margin, D/E, FCF > 0);
  - "PRICE · EOD" (1D/1M/1Y change, % from 52W high, $ volume);
  - "SECTOR" (`sicDivision`).
- Quick chips: max one row: Mcap > $10B · P/E < 25 · ROE > 15% · FCF positive.
- A filter the data cannot answer is **not rendered** (W02's "disabled with tooltip" applies only to fund reference data; P1-09 decides that copy).
- Results: a `ResultsTableShell` at 1280px and `StockCardCompact`-style cards below 768px.
  - Columns SYMBOL · NAME · PRICE ($) · 1D · MCAP · P/E · LATEST FILING (`10-Q · AUG 02`).
  - The header line reads `US ◷ EOD · SEP 23 CLOSE` (`DelayedDataBadge`).
  - Row tap → `usStockHref`.
- `ExclusionRow` goes directly under the results, and the universe line above them: "8,259 US stocks · EOD". The number comes from `universe`, never hardcoded.
- `$ → ₹` toggle (flag `us-currency-toggle`, P0-08) with "SHOWING ₹ · SPOT 83.51 · 1H". A missing rate disables it with a reason.
- Footer: "SOURCE: SEC EDGAR + THIRD-PARTY EOD TAPE · PREVIOUS CLOSE". No vendor name.
- The bulk toolbar "Add to watchlist" appears only once P1-08 has landed (`us-watchlist`); otherwise it is hidden.
- **Control budget:** count the top-level controls at 1280px, legacy India vs India+US pill. Put both numbers in the PR (W02 acceptance).

## Screens

### S1.4 — US stocks, 375px

```
┌──────────────────────────────────────┐
│ Screener                             │
│ [Stocks] Funds ETFs   (IN)[US]       │
│ US ◷ EOD · SEP 23 CLOSE              │
│ ⌕ Search NASDAQ / NYSE…              │
│ [Mcap>$10B] [P/E<25] [ROE>15%] +2    │
│ 8,259 US stocks · 412 match          │
├──────────────────────────────────────┤
│ MSFT  Microsoft          $438.10     │
│ +0.6% · $3.26T · P/E 36 · 10-K JUL30 │
├──────────────────────────────────────┤
│ NVDA  NVIDIA             $121.44     │
│ −1.2% · $2.98T · P/E 48 · 10-Q AUG28 │
├──────────────────────────────────────┤
│ 3,121 not screened on P/E ·          │
│ No SEC filings on file               │
│          Load more                   │
│ SOURCE: SEC EDGAR + THIRD-PARTY EOD  │
└──────────────────────────────────────┘
```

1280px: the filter sidebar left (the existing `FilterSidebar` shell with registry groups), a table right with 7 columns, and the exclusion row spanning the table.

| State      | Render                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| loading    | skeleton table/cards at final size; universe line skeleton                                                                   |
| empty      | "Nothing matches today. That's the honest answer." + "Loosen the rules" (clears the last filter) + exclusion row still shown |
| error      | `DataGapBanner` "Screener unavailable — retry"; India pill still works                                                       |
| DataGap    | rows stale (`priceFill: STALE`) → price cell `—` + badge; the exclusion row names every null-driven drop                     |
| gated (U5) | pill visible; selecting US shows GateInline "US screener is part of PRO" in the results area                                 |
| flag-off   | no pill; `?market=US` falls back to India silently; the route returns the empty shape                                        |
| demo       | 20 fixture rows (AAPL, MSFT, NVDA, GOOGL, AMZN, …) + a fixture exclusion count                                               |

| User | Behaviour               |
| ---- | ----------------------- |
| U1   | no pill                 |
| U2   | pill + results          |
| U3   | no pill until US access |
| U4   | demo rows               |
| U5   | GateInline in results   |
| U6   | full                    |
| U7   | full                    |

## Cross-surface access (§6)

1. Search: the one search box searches US symbols through `searchUsAction` (P1-03) when the pill is US. 2. Watchlist: bulk + per-row ☆ (P1-08, `us-watchlist`). 3. Sage: row "Ask Sage" is P1-08's (`us-stock-research` + `us-sage-entrypoints`). 4. Home: n/a (P1-07's movers link here with a preset). 5. Deep link: `?market=US&us.*` round-trips and is not in the sitemap. 6. API: `POST /v1/us/screener` + a row. 7. Demo: fixtures. 8. Telemetry: `us_screener_viewed {flag:"us-screener"}`, `us_screener_run {filterIds, matched}`.

## Tests

- `packages/services/__tests__/us-screener-service.test.ts`:
  - **contract:** `screenUs` touches `usScreenerRow` and ZERO of `stockRatios/instrumentMapping/latestQuote/mutualFundMaster/indexConstituent` (spy the prisma client);
  - refusal gives an empty shape identical to no-match;
  - cursor pagination is stable on ties.
- **India golden:** the existing screener tests stay green unchanged, and one new test asserts `screenStocks` output on the existing fixture is byte-identical before and after this PR.
- **ETF venue hazard:** a test named `india-etf-scope-excludes-us-venues` pins the exchange clause at `screener.service.ts:443-444` (a US ETF row in the shared master never appears in India ETF mode).
- `apps/web/__tests__/app/us-screener-mode.test.tsx`:
  - **no `₹` glyph in a USD price cell** with the toggle off;
  - `ExclusionRow` rendered with a non-zero count from the fixture;
  - URL round-trip `?market=US&us.peTtm=0-25`.
- `apps/api/__tests__/routes/us-screener-contract.test.ts`: validation 400, envelope keys `{rows, matched, universe, excluded, nextCursor, asOf}`.
- `TEST-COVERAGE.md` updated.

## Acceptance

- [ ] Locally against QA (`us_screener_rows` is a prod copy once P1-01's founder steps have run; otherwise fixtures, and say so): US pill → "P/E < 25, Mcap > $10B" returns rows, the exclusion row shows the real null count, and `universe` equals QA's active-stock count.
- [ ] India screener unchanged (golden test; manual `?mode=stocks&stocks.pe=…` URL still resolves).
- [ ] Control-budget numbers in the PR; U1/U2/U5 screenshots; `verify:push`; `/code-review`.

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- As the founder on prod with `us-screener` on: US pill → "P/E < 25, Mcap > $10B" returns rows, the exclusion row shows the real null count, and `universe` equals the prod active-stock count.

## Out of scope / hand-offs

US MF and ETF modes (P1-09). ☆/Ask-Sage row actions (P1-08). W02's India v2 re-skin. Converting the India screener action to the service contract (a follow-up for the founder to file).
