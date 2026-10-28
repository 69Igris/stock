# FII Statistics Processing

> 100 nodes

## Key Concepts

- **market-positioning-logic.ts** (36 connections) — `packages/core/src/market-data/market-positioning-logic.ts`
- **fii-stats-logic.ts** (28 connections) — `packages/core/src/market-data/fii-stats-logic.ts`
- **market-positioning-logic.test.ts** (20 connections) — `packages/core/__tests__/market-data/market-positioning-logic.test.ts`
- **institutional-flows.ts** (19 connections) — `packages/core/src/market-data/institutional-flows.ts`
- **processors/institutional-flow-sync.ts** (18 connections) — `workers/src/processors/institutional-flow-sync.ts`
- **feed-parse-dispatch.test.ts** (17 connections) — `packages/core/__tests__/market-data/feed-parse-dispatch.test.ts`
- **fii-stats-logic.test.ts** (16 connections) — `packages/core/__tests__/market-data/fii-stats-logic.test.ts`
- **parseParticipantPositioning()** (13 connections) — `packages/core/src/market-data/market-positioning-logic.ts`
- **parseFiiStatsXls()** (12 connections) — `packages/core/src/market-data/fii-stats-logic.ts`
- **parseNseFlowDate()** (10 connections) — `packages/core/src/market-data/institutional-flows.ts`
- **parseFiiDiiReport()** (9 connections) — `packages/core/src/market-data/institutional-flows.ts`
- **institutional-flows.test.ts** (9 connections) — `packages/core/__tests__/market-data/institutional-flows.test.ts`
- **parseContractCount()** (8 connections) — `packages/core/src/market-data/market-positioning-logic.ts`
- **familyById()** (8 connections) — `packages/core/src/market-data/report-registry.ts`
- **processInstitutionalFlowSync()** (7 connections) — `workers/src/processors/institutional-flow-sync.ts`
- **netContracts()** (6 connections) — `packages/core/src/market-data/market-positioning-logic.ts`
- **routes/institutional-flow-sync.ts** (6 connections) — `workers/src/routes/institutional-flow-sync.ts`
- **InstitutionalFlowRow** (5 connections) — `packages/core/src/market-data/institutional-flows.ts`
- **dedupeFlowRows()** (5 connections) — `packages/core/src/market-data/institutional-flows.ts`
- **diffPositioning()** (5 connections) — `packages/core/src/market-data/market-positioning-logic.ts`
- **parseParticipantTitleDate()** (5 connections) — `packages/core/src/market-data/market-positioning-logic.ts`
- **parseParticipantTitleMeasure()** (5 connections) — `packages/core/src/market-data/market-positioning-logic.ts`
- **writePositioning()** (5 connections) — `scripts/jobs/feed-parse.ts`
- **FII_STATS_PARTICIPANT** (5 connections) — `packages/core/src/market-data/fii-stats-logic.ts`
- **POSITIONING_BUCKETS** (5 connections) — `packages/core/src/market-data/market-positioning-logic.ts`
- *... and 75 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (51 shared connections)
- [Derivatives Bhavcopy Parsing](Derivatives_Bhavcopy_Parsing.md) (12 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Report Family Backfill Registry](Report_Family_Backfill_Registry.md) (3 shared connections)
- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (3 shared connections)
- [Chartink Scanner and Caching](Chartink_Scanner_and_Caching.md) (2 shared connections)
- [Corporate Actions Windows](Corporate_Actions_Windows.md) (2 shared connections)
- [AMC Signal Validation Tests](AMC_Signal_Validation_Tests.md) (1 shared connections)
- [Stock Surveillance Flags](Stock_Surveillance_Flags.md) (1 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/feed-parse-dispatch.test.ts`
- `packages/core/__tests__/market-data/fii-stats-logic.test.ts`
- `packages/core/__tests__/market-data/institutional-flows.test.ts`
- `packages/core/__tests__/market-data/market-positioning-logic.test.ts`
- `packages/core/src/market-data/fii-stats-logic.ts`
- `packages/core/src/market-data/institutional-flows.ts`
- `packages/core/src/market-data/market-positioning-logic.ts`
- `packages/core/src/market-data/report-registry.ts`
- `scripts/jobs/feed-parse.ts`
- `workers/src/processors/institutional-flow-sync.ts`
- `workers/src/routes/institutional-flow-sync.ts`

## Audit Trail

- EXTRACTED: 250 (100%)
- INFERRED: 1 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*