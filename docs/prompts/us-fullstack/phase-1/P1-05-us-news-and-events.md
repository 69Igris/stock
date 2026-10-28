# P1-05 · US news, SEC filings and events (stock page section + market feed)

Ticket: MONEY-1629 · Branch: `feat/MONEY-1629` · Flag(s): `us-news` · Screens: S1.3 "News & filings" section, S1.2 feed (component consumed by P1-07) · Depends on: P0-01, P0-03 · Parallel-safe with: P1-01, P1-03

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

Read the three US event streams that are written today and read by nothing. Render them as:

- a **News | SEC filings | Events** section on the US stock page;
- a market-wide feed component for `/markets/us`.

Every item shows its source and first-seen time. The price vendor is never named.

## Why / measured state today (verified)

- `UsNewsArticle` (`packages/database/prisma/schema.prisma:5310`, `@@map("us_news_articles")`).
  - Written 24×7 by `tiingo-news-poll`.
  - `source` is the PUBLISHER domain (`:5358`).
  - `feedSource` defaults to `"TIINGO"` (`:5408`) and must NEVER render (Decision 06).
  - `fetchedAt` is first-seen; `publishedAt` is the world's time.
  - `tickers String[]` holds symbols that resolved against `us_instruments` (`:5376`). An empty array is normal (macro stories).
  - Index `@@index([tickers, publishedAt])`.
- `UsFilingInsight` (`:7802`, `@@map("us_filing_insights")`).
  - `cik10`, `symbol String?`, `form`, `filedAt`, `summary?`, `keyPoints[]`, `insightStatus`.
  - Indexes: `filedAt`, `[insightStatus, filedAt]`, `[symbol, filedAt]`, `[documentClass, filedAt]`. **There is no `cik10` index.** Add `@@index([cik10, filedAt])` in this PR, because reading by symbol hits the DOW trap and misses null-symbol rows.
- `UsFiling` (`:8209`): the filing timeline; derive the EDGAR URL from `accession` + `primaryDocument`.
- `InstrumentEvent` (`:8027`, **`@@map("instrument_events")`**, plural; the plan text says `instrument_event`).
  - `market` ("US"|"IN"), `listingId?`, `eventType` (FILING_8K, INSIDER_TXN, OWNERSHIP_13D_G, …), `severity 0–3`, `evidenceUri`, `observedAt`.
  - Index `[listingId, observedAt desc]` and `[market, observedAt desc]`.
  - Writer: `packages/services/src/events.service.ts:330` `publishEvents`.
  - **It is NOT in `sync-prod-to-qa.sh` `REFERENCE_COLLECTIONS` (`:897`), so QA has no events.** Say so in the PR; do not add it here (its writer runs in both envs; that is a separate decision).
- **The prod event count is unknown to the session, and QA has no copy**, so build the honest empty state ("No events linked to this listing yet") as the DEFAULT render of the Events tab and list the tab under "Engine-gated" (C1/C4) until the founder's count says otherwise. The count is a founder step: `db.instrument_events.countDocuments({market:"US"})`, grouped by `eventType` ("Founder, after merge").
- Existing India pattern to reuse visually: `apps/web/components/stock/StockNewsTab.tsx`, `StockFilingsTimeline.tsx`, `relative-time.ts`.
- `packages/core/src/us-fundamentals/repository.ts:1185` `getFilings({cik10, forms, limit})` already exists; use it for the filings list.

## Read first (verified paths)

`apps/web/components/stock/{StockNewsTab,StockFilingsTimeline,SectionShell}.tsx`, `apps/web/components/stock/relative-time.ts`, `packages/services/src/events.service.ts`, `packages/core/src/us-fundamentals/repository.ts`, `packages/services/src/us/stock.service.ts` (`resolveUsListing`, P1-04; if P1-04 is not merged, resolve with `UsInstrument` by listingId in this service and leave a note), `packages/api-utils/src/pagination/index.ts`, `packages/services/src/us/registry.ts`.

## Build — in this order

### 1. Service — `packages/services/src/us/news.service.ts` (+ `news-logic.ts`)

Schemas live in `news-logic.ts`: `UsStockFeedInputSchema = {listingId, tab:"news"|"filings"|"events", cursor?, limit≤30}` and `UsMarketFeedInputSchema = {kinds?: ("news"|"filings")[], cursor?, limit≤30}`.

- `getUsStockFeed(userId, input)`:
  - **news:** `usNewsArticle` where `tickers has symbol`, ordered by `publishedAt desc`. Only when the listing is ACTIVE; a DELISTED listing returns `{empty:true, reason:"NEWS_MATCHED_BY_CURRENT_TICKER"}` (the DOW rule).
  - **filings:** `getFilings({cik10})` joined by accession to `UsFilingInsight` where `insightStatus` is complete, so an item carries a `summary`. The AI summary is labelled `aiGenerated:true`.
  - **events:** `instrumentEvent` where `{listingId}` is ordered by `observedAt desc`.
- `getUsMarketFeed(userId, input)`: latest `usNewsArticle` (`market:"US"`) merged by time with the latest summarised `UsFilingInsight` (`filedAt desc`). Cursor-paginated through `encodeCursor({t, id})`.
- The item shape (plain JSON, every kind):

  `{kind, id, title, summary|null, url, source: "prnewswire.com"|"SEC EDGAR", publishedAt, firstSeenAt, tickers[], listingId|null, severity|null, aiGenerated:boolean}`

  A pure `toFeedItem` builds it and never emits `feedSource`.

- Cache: Redis 5 min for the market feed only. Never cache a refusal.

### 2. Server actions — `apps/web/lib/actions/us-news.ts`

`getUsStockFeedAction`, `getUsMarketFeedAction`: auth → user → `resolveUsLayer()` → `us-news` flag → schema → service. A refusal returns the empty shape.

### 3. `/v1` routes + `US_SURFACES` rows — `apps/api/src/routes/v1/us/news.ts`

- `GET /v1/us/stocks/:listingId/news?tab=&cursor=` (the ticket's path; mount it under the `us` family's `stocks` sub-router from P1-04, or a sibling file mounted at the same prefix).
- `GET /v1/us/news?cursor=` (market feed).

Two `US_SURFACES` rows, both `flag:"us-news"`, `usAccess:"required"`, `serviceFile:"packages/services/src/us/news.service.ts"`, `actionFile:"apps/web/lib/actions/us-news.ts"`, `routeFile:"apps/api/src/routes/v1/us/news.ts"`:

- `{surface:"stock-feed", serviceExport:"getUsStockFeed", routePath:"/v1/us/stocks/:listingId/news"}`
- `{surface:"market-feed", serviceExport:"getUsMarketFeed", routePath:"/v1/us/news"}`

`news.ts` must be reachable from `v1/index.ts` through `us/index.ts` (P0-01 rule 5); mounting it inside P1-04's `stocks.ts` sub-router satisfies that.

### 4. UI

- `apps/web/components/us/UsNewsFilingsSection.tsx`: segmented News · SEC filings · Events, infinite scroll by cursor (a "Load more" button, no auto-poll).
  - Each row: the title; `source · first seen 2h ago`; for filings, a form chip (`8-K`, `10-Q`) plus an "AI summary" label; for events, a severity dot.
  - The link opens the external URL in a new tab with `rel="noopener noreferrer"`.
- Mount it in P1-04's News tab slot (`/us/stock/[symbol]`). It renders only when `us-news` is on.
- `apps/web/components/us/UsMarketFeed.tsx`: the same row component, market-wide; P1-07 mounts it.
- Schema: add `@@index([cik10, filedAt])` to `UsFilingInsight` and run `prisma generate`. Pushing the index to QA and prod is a founder step ("Founder, after merge").

## Screens

### S1.3 News & filings tab, 375px

```
┌──────────────────────────────────────┐
│ [News]  SEC filings  Events          │
├──────────────────────────────────────┤
│ Apple unveils new chip lineup        │
│ theverge.com · first seen 2h ago     │
├──────────────────────────────────────┤
│ iPhone demand steady into Q4, says   │
│ supplier                             │
│ reuters.com · first seen 6h ago      │
├──────────────────────────────────────┤
│ [8-K] Results of operations          │
│ AI summary · SEC EDGAR · Aug 01      │
│ Revenue up 5% YoY; services record.  │
├──────────────────────────────────────┤
│          Load more                   │
└──────────────────────────────────────┘
```

### S1.2 market feed (component), 375px

```
┌──────────────────────────────────────┐
│ US NEWS & FILINGS    ◷ UPDATED 2M AGO│
│ NVDA  Nvidia supplier ramps output   │
│       bloomberg.com · 40m ago        │
│ MSFT  [10-K] Annual report filed     │
│       SEC EDGAR · Jul 30 · AI summary│
│ —     Fed minutes: rates on hold     │
│       wsj.com · 1h ago               │
└──────────────────────────────────────┘
```

1280px: the section sits under the tabs at full width, and the market feed is a right-rail card (P1-07).

| State      | Render                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| loading    | 4 skeleton rows at final height                                                                                             |
| empty      | news: "No news for AAPL in the last 30 days"; filings: "No filings on file"; events: "No events linked to this listing yet" |
| error      | `DataGapBanner` "News feed unavailable — retry" inside the section; page unaffected                                         |
| DataGap    | delisted listing → "News is matched by current ticker, so it is not shown for a delisted listing"                           |
| gated (U5) | section absent (the page shows GateInline, P1-04)                                                                           |
| flag-off   | section and tab absent; routes return empty shape                                                                           |
| demo       | 3 news + 2 filings fixtures for AAPL, 5 feed items                                                                          |

| User | Behaviour                |
| ---- | ------------------------ |
| U1   | absent                   |
| U2   | full                     |
| U3   | absent until US access   |
| U4   | demo fixtures            |
| U5   | absent (page-level gate) |
| U6   | full                     |
| U7   | full                     |

## Cross-surface access (§6)

1. Search: n/a (content lives inside the stock page, which search reaches). 2. Watchlist: n/a (items are not instruments; the tickers link to stock pages that carry ☆). 3. Sage: a per-item "Ask Sage about this filing" is P1-08's wiring, and it renders only under `us-stock-research` + `us-sage-entrypoints`. 4. Home: P1-07/P1-08 show the feed card. 5. Deep link: `/us/stock/AAPL?tab=news` round-trips. 6. API: 2 routes + rows. 7. Demo: fixtures. 8. Telemetry: `us_news_viewed {flag:"us-news", tab}`, `us_news_opened {kind, source}`.

## Tests

- `packages/services/__tests__/us-news-logic.test.ts`:
  - `toFeedItem` never outputs `TIINGO` / `feedSource` (the vendor string is absent in JSON);
  - `firstSeenAt` = `fetchedAt`;
  - the merge sort is stable, and the cursor round-trips.
- `packages/services/__tests__/us-news-service.test.ts`:
  - **DOW delisted** returns the named absence for news, and filings read by that listing's `cik10`;
  - refusal returns the empty shape;
  - events read by `listingId`, never by symbol.
- `apps/web/__tests__/components/us-news-section.test.tsx`: the source + first-seen line is rendered on every row, the AI label appears on summaries, and no vendor string appears.
- `apps/api/__tests__/routes/us-news-contract.test.ts`: tab validation 400, cursor pagination, absence on refusal.
- `TEST-COVERAGE.md` updated.

## Acceptance

- [ ] Locally against QA, AAPL shows ≥1 news item and ≥1 filing with a summary (or the named empty state, with the reason). The Events tab renders its empty state (QA has no `instrument_events`) and is listed under "Engine-gated".
- [ ] No rendered string contains the price vendor's name (test + manual grep of the HTML).
- [ ] The `UsFilingInsight` `[cik10, filedAt]` index is in `schema.prisma` and `prisma generate` passes.
- [ ] U1/U2/U5 screenshots; `verify:push`; `/code-review`.

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- Push the index: `setup-infra.sh qa --only db`, then `setup-infra.sh prod --only db`; confirm `[cik10, filedAt]` is present on both.
- Measure `db.instrument_events.countDocuments({market:"US"})` on prod, grouped by `eventType`. If it is non-zero, check AAPL's Events tab on prod and drop the "Engine-gated" note in a follow-up.

## Out of scope / hand-offs

The `/markets/us` page (P1-07 mounts `UsMarketFeed`). Ask-Sage chips (P1-08). Event alerts (C4). Adding `instrument_events` to the QA sync (founder decision; note it in the PR).
