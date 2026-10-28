# Corporate Events Synchronization

> 49 nodes

## Key Concepts

- **processors/events-sync.ts** (41 connections) — `workers/src/processors/events-sync.ts`
- **events-sync-logic.ts** (31 connections) — `workers/src/processors/events-sync-logic.ts`
- **events-sync-logic.test.ts** (23 connections) — `workers/__tests__/processors/events-sync-logic.test.ts`
- **processEventsSync()** (15 connections) — `workers/src/processors/events-sync.ts`
- **fetchNSECorporateActions()** (9 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **fetchNseWindowEvents()** (9 connections) — `workers/src/processors/events-sync.ts`
- **parseNseEvents()** (8 connections) — `workers/src/processors/events-sync-logic.ts`
- **startOfUtcDay()** (7 connections) — `workers/src/processors/events-sync-logic.ts`
- **chunk()** (6 connections) — `workers/src/processors/events-sync-logic.ts`
- **toUpcomingEventRows()** (6 connections) — `workers/src/processors/events-sync-logic.ts`
- **buildSyncTierWhere()** (5 connections) — `packages/core/src/market-data/sync-tiers.ts`
- **fetchYahooEarnings()** (5 connections) — `workers/src/processors/events-sync.ts`
- **gatherTargetSymbols()** (5 connections) — `workers/src/processors/events-sync.ts`
- **dedupeUpcomingEvents()** (5 connections) — `workers/src/processors/events-sync-logic.ts`
- **forwardWindow()** (5 connections) — `workers/src/processors/events-sync-logic.ts`
- **parseBoardMeetings()** (5 connections) — `workers/src/processors/events-sync-logic.ts`
- **parseEventCalendar()** (5 connections) — `workers/src/processors/events-sync-logic.ts`
- **parseNseEventDate()** (5 connections) — `workers/src/processors/events-sync-logic.ts`
- **groupByCategory()** (4 connections) — `workers/src/processors/events-sync-logic.ts`
- **nseEventCategory()** (4 connections) — `workers/src/processors/events-sync-logic.ts`
- **selectEventTargets()** (4 connections) — `workers/src/processors/events-sync-logic.ts`
- **selectFallbackSymbols()** (4 connections) — `workers/src/processors/events-sync-logic.ts`
- **UpcomingEventRow** (3 connections) — `workers/src/processors/events-sync-logic.ts`
- **fetchCorpActions()** (3 connections) — `workers/src/processors/events-sync.ts`
- **buildNseEventTitle()** (3 connections) — `workers/src/processors/events-sync-logic.ts`
- *... and 24 more nodes in this community*

## Relationships

- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (10 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (8 shared connections)
- [Stock Financials Normalization](Stock_Financials_Normalization.md) (4 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Chartink Technical Scans Library](Chartink_Technical_Scans_Library.md) (1 shared connections)
- [Technical Market Indicators](Technical_Market_Indicators.md) (1 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/sync-tiers.ts`
- `packages/research/src/data-sources/nse-filings.ts`
- `workers/__tests__/processors/events-sync-logic.test.ts`
- `workers/src/processors/events-sync-logic.ts`
- `workers/src/processors/events-sync.ts`

## Audit Trail

- EXTRACTED: 147 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*