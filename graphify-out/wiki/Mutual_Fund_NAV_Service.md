# Mutual Fund NAV Service

> 55 nodes

## Key Concepts

- **mf-nav-service.ts** (31 connections) — `packages/core/src/market-data/prices/mf-nav-service.ts`
- **processors/mf-nav-backfill.ts** (23 connections) — `workers/src/processors/mf-nav-backfill.ts`
- **mf-nav-backfill-logic.ts** (17 connections) — `workers/src/processors/mf-nav-backfill-logic.ts`
- **mf-nav-cold-read.test.ts** (15 connections) — `packages/core/__tests__/market-data/mf-nav-cold-read.test.ts`
- **mf-nav-backfill-logic.test.ts** (12 connections) — `workers/__tests__/processors/mf-nav-backfill-logic.test.ts`
- **processMfNavBackfill()** (11 connections) — `workers/src/processors/mf-nav-backfill.ts`
- **getMfNavHistoryWithCoverage()** (10 connections) — `packages/core/src/market-data/prices/mf-nav-service.ts`
- **routes/mf-nav-backfill.ts** (9 connections) — `workers/src/routes/mf-nav-backfill.ts`
- **MfNavBackfillMessage** (6 connections) — `packages/types/src/pubsub.ts`
- **selectMissingNavPoints()** (6 connections) — `packages/core/src/market-data/prices/mf-nav-service.ts`
- **resolveMfNavBackfillParams()** (6 connections) — `workers/src/processors/mf-nav-backfill-logic.ts`
- **fetchMfNavPoints()** (5 connections) — `packages/core/src/market-data/prices/mf-nav-service.ts`
- **requestMfNavBackfill()** (5 connections) — `packages/core/src/market-data/prices/mf-nav-service.ts`
- **MfNavReader** (4 connections) — `packages/core/src/market-data/prices/mf-nav-service.ts`
- **navDateKeys()** (4 connections) — `packages/core/src/market-data/prices/mf-nav-service.ts`
- **backfillSchemeNav()** (4 connections) — `workers/src/processors/mf-nav-backfill.ts`
- **isBudgetExhausted()** (4 connections) — `workers/src/processors/mf-nav-backfill-logic.ts`
- **judgeMfNavBackfillHealth()** (4 connections) — `workers/src/processors/mf-nav-backfill-logic.ts`
- **shouldLogProgress()** (4 connections) — `workers/src/processors/mf-nav-backfill-logic.ts`
- **shouldSleepAfterIndex()** (4 connections) — `workers/src/processors/mf-nav-backfill-logic.ts`
- **MfNavBackfillTally** (3 connections) — `workers/src/processors/mf-nav-backfill-logic.ts`
- **resetMfNavBackfillRequests()** (3 connections) — `packages/core/src/market-data/prices/mf-nav-service.ts`
- **setMfNavBackfillPublisher()** (3 connections) — `packages/core/src/market-data/prices/mf-nav-service.ts`
- **MF_NAV_COLD_THRESHOLD** (3 connections) — `packages/core/src/market-data/prices/mf-nav-service.ts`
- **MF_NAV_INSERT_CHUNK** (3 connections) — `packages/core/src/market-data/prices/mf-nav-service.ts`
- *... and 30 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (16 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (6 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (5 shared connections)
- [Mutual Fund Performance Comparison](Mutual_Fund_Performance_Comparison.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (3 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (2 shared connections)
- [Market Sector Performance Aggregation](Market_Sector_Performance_Aggregation.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/mf-nav-cold-read.test.ts`
- `packages/core/src/market-data/prices/mf-nav-service.ts`
- `packages/types/src/pubsub.ts`
- `workers/__tests__/processors/mf-nav-backfill-logic.test.ts`
- `workers/src/processors/mf-nav-backfill-logic.ts`
- `workers/src/processors/mf-nav-backfill.ts`
- `workers/src/routes/mf-nav-backfill.ts`

## Audit Trail

- EXTRACTED: 145 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*