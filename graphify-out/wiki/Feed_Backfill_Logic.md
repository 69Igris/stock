# Feed Backfill Logic

> 51 nodes

## Key Concepts

- **feed-backfill.ts** (56 connections) — `scripts/jobs/feed-backfill.ts`
- **feed-backfill-logic.ts** (40 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **feed-backfill-logic.test.ts** (32 connections) — `packages/core/__tests__/market-data/feed-backfill-logic.test.ts`
- **main()** (19 connections) — `scripts/jobs/feed-backfill.ts`
- **fetchDay()** (15 connections) — `scripts/jobs/feed-backfill.ts`
- **isoDay()** (13 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **planFamily()** (9 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **advanceErrorRuns()** (7 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **emptyErrorRuns()** (6 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **isPrecedingWeekday()** (6 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **parseDay()** (6 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **utcMidnightOf()** (6 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **weekdaysDescending()** (6 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **advanceRange()** (5 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **backfillBackoffMs()** (5 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **chunkStartsDescending()** (5 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **emptyHostState()** (5 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **emptyTally()** (5 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **hostIsPaused()** (5 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **isWeekend()** (5 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **noteHostOutcome()** (5 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **previousWeekday()** (5 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **shouldAbort()** (5 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **shouldEndRange()** (5 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- **shouldTryDoor()** (5 connections) — `packages/core/src/market-data/feed-backfill-logic.ts`
- *... and 26 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (34 shared connections)
- [Report Family Backfill Registry](Report_Family_Backfill_Registry.md) (9 shared connections)
- [XBRL Feed Archive Backfill](XBRL_Feed_Archive_Backfill.md) (8 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (6 shared connections)
- [Derivatives Bhavcopy Parsing](Derivatives_Bhavcopy_Parsing.md) (4 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (3 shared connections)
- [Index Constituent Parsing](Index_Constituent_Parsing.md) (3 shared connections)
- [Bond Trade Data Processing](Bond_Trade_Data_Processing.md) (2 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (2 shared connections)
- [Exchange Archive Probing](Exchange_Archive_Probing.md) (1 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/feed-backfill-logic.test.ts`
- `packages/core/src/market-data/feed-backfill-logic.ts`
- `scripts/jobs/feed-backfill.ts`

## Audit Trail

- EXTRACTED: 209 (99%)
- INFERRED: 2 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*