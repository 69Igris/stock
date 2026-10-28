# Report Family Backfill Registry

> 65 nodes

## Key Concepts

- **processors/report-archive-sync.ts** (44 connections) — `workers/src/processors/report-archive-sync.ts`
- **report-registry.ts** (42 connections) — `packages/core/src/market-data/report-registry.ts`
- **report-registry.test.ts** (20 connections) — `packages/core/__tests__/market-data/report-registry.test.ts`
- **report-archive-sync-logic.ts** (20 connections) — `workers/src/processors/report-archive-sync-logic.ts`
- **processReportArchiveSync()** (19 connections) — `workers/src/processors/report-archive-sync.ts`
- **report-archive-sync-logic.test.ts** (14 connections) — `workers/__tests__/processors/report-archive-sync-logic.test.ts`
- **ReportFamily** (13 connections) — `packages/core/src/market-data/report-registry.ts`
- **istParts()** (13 connections) — `packages/core/src/market-data/report-registry.ts`
- **pad2()** (11 connections) — `packages/core/src/market-data/report-registry.ts`
- **tokIsoDay()** (10 connections) — `packages/core/src/market-data/report-registry.ts`
- **allFamilies()** (9 connections) — `packages/core/src/market-data/report-registry.ts`
- **familiesDue()** (9 connections) — `packages/core/src/market-data/report-registry.ts`
- **archiveFamily()** (9 connections) — `workers/src/processors/report-archive-sync.ts`
- **runDriftGuard()** (8 connections) — `workers/src/processors/report-archive-sync.ts`
- **emptyFeedAssetOutcome()** (6 connections) — `packages/core/src/market-data/feed-archive.ts`
- **familiesForBackfill()** (6 connections) — `packages/core/src/market-data/report-registry.ts`
- **tokDashMonTitle()** (6 connections) — `packages/core/src/market-data/report-registry.ts`
- **tokYYYYMMDD()** (6 connections) — `packages/core/src/market-data/report-registry.ts`
- **tokDashMonUpper()** (5 connections) — `packages/core/src/market-data/report-registry.ts`
- **tokDDMM()** (5 connections) — `packages/core/src/market-data/report-registry.ts`
- **tokDDMMMYYYY()** (5 connections) — `packages/core/src/market-data/report-registry.ts`
- **tokDDMMYY()** (5 connections) — `packages/core/src/market-data/report-registry.ts`
- **tokDDMMYYYY()** (5 connections) — `packages/core/src/market-data/report-registry.ts`
- **tokSlash()** (5 connections) — `packages/core/src/market-data/report-registry.ts`
- **backfillableFamilies()** (4 connections) — `packages/core/src/market-data/report-registry.ts`
- *... and 40 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (27 shared connections)
- [Feed Backfill Logic](Feed_Backfill_Logic.md) (9 shared connections)
- [AMC Signal Validation Tests](AMC_Signal_Validation_Tests.md) (7 shared connections)
- [Exchange Archive Probing](Exchange_Archive_Probing.md) (7 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (7 shared connections)
- [Instrument Synchronization Sweeps](Instrument_Synchronization_Sweeps.md) (4 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [XBRL Feed Archive Backfill](XBRL_Feed_Archive_Backfill.md) (3 shared connections)
- [Circulars Ingestion Processor](Circulars_Ingestion_Processor.md) (3 shared connections)
- [Market Hours and Calendar](Market_Hours_and_Calendar.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (3 shared connections)

## Source Files

- `packages/core/__tests__/market-data/report-registry.test.ts`
- `packages/core/src/market-data/feed-archive.ts`
- `packages/core/src/market-data/feed-backfill-logic.ts`
- `packages/core/src/market-data/report-registry.ts`
- `workers/__tests__/processors/report-archive-sync-logic.test.ts`
- `workers/src/processors/report-archive-sync-logic.ts`
- `workers/src/processors/report-archive-sync.ts`

## Audit Trail

- EXTRACTED: 239 (98%)
- INFERRED: 4 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*