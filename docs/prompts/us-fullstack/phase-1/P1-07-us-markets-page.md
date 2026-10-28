# P1-07 · US Markets page `/markets/us`

Ticket: MONEY-1628 · Branch: `feat/MONEY-1628` · Flag(s): `us-market-overview` · Screens: S1.2 · Depends on: P1-01 (`us_screener_rows`), P1-05 (`UsMarketFeed` + `getUsMarketFeed`), P1-04 (`usStockHref`) · Parallel-safe with: P1-06

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

A mobile-first `/markets/us` page with:

- the S&P 500, Nasdaq-100 and Dow shown as labelled ETF proxies ("S&P 500 · via SPY"), plus VIX as a delayed index level;
- top gainers, losers and most-traded;
- a sector heatmap;
- the latest US news and SEC filings.

Every number carries an EOD date chip. The data comes from ONE service (`getUsMarketOverview`) shared by the server action and `GET /v1/us/markets`.

## Why / measured state today (verified)

- There is no US market page. `apps/web/app/discover/markets/` is India-only, and there is no `apps/web/app/markets/` route.
- `apps/web/proxy-routes.ts:94` `APP_ROUTE_PATTERNS` has no `"/markets(.*)"`. Add it; the page is app-gated and not public.
- **Index levels are not in our US store, and neither paid vendor has them. Measured 2026-09-24 with the prod keys; do not re-probe it and do not scrape an index level from anywhere else.** Tiingo's `supported_tickers` master carries only Stock, ETF and Mutual Fund asset types, and `/tiingo/daily` answers 404 for `^GSPC`, `GSPC`, `^DJI`, `DJI`, `^VIX`, `VIX`, `NDX` and `^IXIC` (`SPX` is 200 with an empty array). Databento `EQUS.MINI` does not resolve SPX, VIX or NDX.
- **Decided by the founder, 2026-09-24:**
  - **S&P 500, Nasdaq-100 and Dow are ETF PROXIES read from our own `us_screener_rows`**, labelled on the card: "S&P 500 · via SPY", "Nasdaq-100 · via QQQ", "Dow 30 · via DIA", each with an EOD date chip.
  - **VIX is SHOWN, from the EXISTING Yahoo-backed indices path.** `apps/web/app/api/market/indices/indices-logic.ts:73` already declares `{ yahooSymbol: "^VIX", name: "VIX", market: "US" }` and the ticker fetches it through `yahooFetchQuotes` (`@usemoney/core/market-data`, via `apps/web/lib/market/yahoo-client.ts`). Reuse that: no new vendor, no new fetcher. It carries a "delayed" chip and never names the vendor. If the quote comes back empty or non-positive, VIX is ABSENT (the card's DataGap state), never a stale or zero value.
  - **Known inconsistency:** the global ticker already shows Yahoo's real `^GSPC`/`^IXIC`/`^DJI` levels, so the ticker and this page show different "S&P 500" numbers. Proxies are the default for this PR; the founder decides afterwards whether the three headline tiles switch to the ticker's levels ("Founder, after merge").
- Sector: `UsInstrument` has no sector. `UsFiler.sic` (`schema.prisma:8144`) is projected by P1-01 as `sicDivision`. The heatmap groups on that. SIC divisions are not GICS sectors; label them "SEC industry division".
- Movers need a liquidity floor, or they fill with sub-dollar names. Put the floor in logic as a named constant (`MOVERS_MIN_MCAP_USD = 2e9`) and print it on screen ("Stocks over $2B market cap").
- "Most active" uses `dollarVolume30d` (the row carries no single-day volume). Label it "Most traded · 30-day avg $ volume". Do not call it "today".
- The India movers/heatmap pieces to reuse visually: `apps/web/components/markets/Treemap.tsx`, `packages/services/src/discover-market.service.ts` (`aggregateSectorPerformance` `:84`: the SHAPE, not the India data).

## Read first (verified paths)

`apps/web/app/discover/markets/{page,client}.tsx` + `components/`, `apps/web/components/markets/Treemap.tsx`, `packages/services/src/discover-market.service.ts`, `packages/types/src/us-screener.ts`, `packages/services/src/us/news.service.ts` (P1-05), `apps/web/components/us/UsMarketFeed.tsx` (P1-05), `apps/web/proxy-routes.ts`, `packages/services/src/us/registry.ts`.

## Build — in this order

### 1. Service — `packages/services/src/us/markets.service.ts` (+ `markets-logic.ts`)

`getUsMarketOverview(userId): ServiceResult<UsMarketOverview>`

```
{ asOf: "2026-09-23",
  proxies: [{listingId, symbol, tracks: "S&P 500"|"Nasdaq-100"|"Dow 30", lastClose, chg1D, chg1DPct, lastCloseDate}],
  vix: {level, chg1D, chg1DPct, asOf, delayed: true} | {absent: true, reason: "NO_QUOTE"},
  gainers|losers|mostTraded: [{listingId, symbol, name, lastClose, chg1DPct, marketCap}] (10 each),
  sectors: [{division, chg1DPct (mcap-weighted), count, totalMcap}],
  floor: {minMcapUsd} }
```

- Everything except VIX reads `usScreenerRow` ONLY: one `findMany` for proxies by symbol+`assetType:"ETF"` ACTIVE, three sorted `findMany` on indexed fields with the floor, and one select of `(sicDivision, marketCap, chg1D)` over rows ≥ floor for the heatmap.
- VIX: move the US subset of `TICKER_INDICES` (or the whole list) out of `apps/web/app/api/market/indices/indices-logic.ts` into a shared module the service can import (e.g. `packages/core/src/market-data/ticker-indices.ts`), have `indices-logic.ts` re-export it so the ticker keeps ONE list, and call the existing `yahooFetchQuotes` for `^VIX` inside `getUsMarketOverview`. `apps/api` cannot import `apps/web`, so the list must live in a package; the fetcher already does. A pure `toVix(quote)` in `markets-logic.ts` maps an empty or non-positive quote to `{absent:true}`. VIX is fetched in parallel with the row reads and a failure never fails the overview.
- Pure `markets-logic.ts` does the weighting, the null-drop counting (sectors report `count` so a division with 2 names is visibly thin), and `asOf` = the modal `lastCloseDate`.
- Cache: Redis keyed by `asOf`, TTL 1h. Never cache a failure.
- The feed is NOT part of this payload. The page calls P1-05's `getUsMarketFeedAction` separately, so a slow feed never blocks the numbers.

### 2. Server action — `apps/web/lib/actions/us-markets.ts`

`getUsMarketOverviewAction()`: auth → user → `resolveUsLayer()` → `us-market-overview` → service. A refusal returns `null` and the page calls `notFound()`.

### 3. `/v1` route + `US_SURFACES` row — `apps/api/src/routes/v1/us/markets.ts`

`GET /v1/us/markets`. The ticket says `/v1/markets/us`; that is a new family and is refused by §2. Row `{surface:"markets", flag:"us-market-overview", usAccess:"required", serviceExport:"getUsMarketOverview", serviceFile:"packages/services/src/us/markets.service.ts", actionFile:"apps/web/lib/actions/us-markets.ts", routeFile:"apps/api/src/routes/v1/us/markets.ts", routePath:"/v1/us/markets"}`. Mount with one `usRoutes.route("/markets", …)` line.

### 4. UI — `apps/web/app/markets/us/{page,client,loading}.tsx`

- The server page warms the overview. Sections in order: index strip (3 proxy cards + VIX, horizontal scroll inside its own row at 375), then Gainers | Losers | Most traded (segmented), then the sector heatmap (`Treemap`), then `UsMarketFeed`.
- Every card carries `◷ EOD · SEP 23`. A movers row taps through to `usStockHref`. A heatmap tile taps through to `/discover/screener?market=US&us.sicDivision=<division>` (P1-06).
- An "Ask Sage about today's US market" slot renders only under `us-stock-research` + `us-sage-entrypoints`; P1-08 provides the component.
- An entry link on `/discover/markets` ("US markets →") renders only when this flag is on.

## Screens

### S1.2 — 375px

```
┌──────────────────────────────────────┐
│ ‹  US Markets     ◷ EOD · SEP 23     │
│ ┌──────────┐┌──────────┐┌─────────┐ →│
│ │S&P 500   ││Nasdaq-100││Dow 30   │  │
│ │via SPY   ││via QQQ   ││via DIA  │  │
│ │$571.30   ││$489.20   ││$421.05  │  │
│ │+0.4%     ││+0.7%     ││−0.1%    │  │
│ └──────────┘└──────────┘└─────────┘  │
│ ETF proxies · not index levels       │
│ (scrolls →) ┌──────────┐             │
│             │VIX 16.42 │ DELAYED     │
│             │−3.1%     │             │
│             └──────────┘             │
├──────────────────────────────────────┤
│ [Gainers] Losers  Most traded        │
│ SMCI  Super Micro   $48.10  +12.4%   │
│ PLTR  Palantir      $37.92   +6.1%   │
│ Stocks over $2B market cap           │
├──────────────────────────────────────┤
│ SEC INDUSTRY DIVISIONS · 1D          │
│ ┌────────────┬──────┬────┐           │
│ │Manufactur. │Finan.│Svc │           │
│ │ +0.6%      │−0.3% │+.9 │           │
│ └────────────┴──────┴────┘           │
├──────────────────────────────────────┤
│ US NEWS & FILINGS                    │
│ NVDA  Nvidia supplier ramps output   │
│       bloomberg.com · 40m ago        │
└──────────────────────────────────────┘
```

1280px: proxies across the top, movers left (2/3 width), the heatmap below the movers, and the feed as a right rail.

| State      | Render                                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| loading    | skeleton at final layout (3 cards, 10 rows, heatmap box, 4 feed rows)                                                                                                                                                                           |
| empty      | movers list empty → "No moves above the $2B floor on SEP 23"; a division with no rows is not drawn                                                                                                                                              |
| error      | per-section `DataGapBanner` + retry; the feed is independent                                                                                                                                                                                    |
| DataGap    | a proxy row missing or `priceFill: STALE` → that card shows `—` + "not on file"; VIX `absent` → the VIX card shows `—` + "not available", never a stale or zero level; `asOf` older than 5 sessions → page banner "US data last updated SEP 16" |
| gated (U5) | GateInline card "US markets are part of PRO" in place of all numbers                                                                                                                                                                            |
| flag-off   | `/markets/us` → 404; the entry link and route are absent                                                                                                                                                                                        |
| demo       | fixture overview + feed                                                                                                                                                                                                                         |

| User | Behaviour           |
| ---- | ------------------- |
| U1   | 404, no link        |
| U2   | full                |
| U3   | 404 until US access |
| U4   | demo                |
| U5   | GateInline          |
| U6   | full                |
| U7   | full                |

## Cross-surface access (§6)

1. Search: the command palette gets a "US Markets" nav item under `us-market-overview`. 2. Watchlist: movers rows get ☆ (P1-08). 3. Sage: the slot (P1-08). 4. Home: P1-08's US card links here. 5. Deep link: `/markets/us`, not in the sitemap. 6. API: `/v1/us/markets` + a row. 7. Demo: fixtures. 8. Telemetry: `us_markets_viewed {flag:"us-market-overview"}`, `us_markets_mover_opened {listingId, list}`.

## Tests

- `packages/services/__tests__/us-markets-logic.test.ts`:
  - mcap weighting;
  - a division with a null `chg1D` is counted, not averaged as 0;
  - the floor excludes a $500M name;
  - `asOf` = mode.
- `packages/services/__tests__/us-markets-service.test.ts`: reads only `usScreenerRow`; refusal returns null; **DOW:** movers and proxies reference `listingId`, and a DELISTED row never appears (ACTIVE filter).
- `apps/web/__tests__/app/us-markets-page.test.tsx`:
  - **no `₹` glyph** in any price;
  - the "ETF proxies · not index levels" caption is present, and each proxy card reads "<index> · via <ETF>";
  - the VIX card carries the "delayed" chip, and an empty or zero Yahoo quote renders the absent state (a `toVix` unit test covers `null`, `0` and a negative price);
  - no vendor string;
  - an EOD chip on every section.
- `apps/api/__tests__/routes/us-markets-contract.test.ts`: the envelope, and absence on refusal.
- `TEST-COVERAGE.md`.

## Acceptance

- [ ] Locally against QA (`us_screener_rows` is a prod copy once P1-01's founder steps have run; otherwise fixtures, and say so): the page renders proxies, VIX, movers and divisions dated the last US session.
- [ ] The ticker and the page read ONE `TICKER_INDICES` list (a test imports it from the shared module in both places).
- [ ] `/markets(.*)` is app-gated (a demo cookie or auth); U1/U2/U5 screenshots; `verify:push`; `/code-review`.

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- As the founder on prod with `us-market-overview` on: the page renders real proxies, VIX, movers and divisions dated the last US session.
- Decide whether the three headline tiles switch from the ETF proxies to the ticker's Yahoo `^GSPC`/`^IXIC`/`^DJI` levels, so the ticker and the page agree. This PR ships proxies.

## Out of scope / hand-offs

Index levels from any new source (measured unavailable, see above). Ask-Sage and ☆ (P1-08). Intraday or live anything (Decision 01).
