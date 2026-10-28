# XBRL Filings Index Sync

> 40 nodes

## Key Concepts

- **processors/xbrl-sync.ts** (83 connections) — `workers/src/processors/xbrl-sync.ts`
- **processXbrlSync()** (26 connections) — `workers/src/processors/xbrl-sync.ts`
- **storeFiling()** (14 connections) — `workers/src/processors/xbrl-sync.ts`
- **reparseStoredFiling()** (10 connections) — `workers/src/processors/xbrl-sync.ts`
- **storeAnnualCompanion()** (9 connections) — `workers/src/processors/xbrl-sync.ts`
- **filingExchange** (8 connections) — `packages/core/src/market-data/xbrl-filing-index.ts`
- **backfillAnnualFromXml()** (7 connections) — `workers/src/processors/xbrl-sync.ts`
- **buildFilingIndexPath()** (6 connections) — `packages/core/src/market-data/xbrl-filing-index.ts`
- **classifyFilingPeriod()** (6 connections) — `packages/core/src/market-data/xbrl-filing-index.ts`
- **collectIndex()** (6 connections) — `workers/src/processors/xbrl-sync.ts`
- **FilingIndexEra** (5 connections) — `packages/core/src/market-data/xbrl-filing-index.ts`
- **indexSupportsPaging()** (5 connections) — `packages/core/src/market-data/xbrl-filing-index.ts`
- **emptyXbrlSyncResult()** (5 connections) — `workers/src/processors/xbrl-sync.ts`
- **entryFromStoredFiling()** (4 connections) — `workers/src/processors/xbrl-sync.ts`
- **XbrlOutcomeBucket** (3 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **downloadOrder()** (3 connections) — `workers/src/processors/xbrl-sync.ts`
- **isoToUtc()** (3 connections) — `workers/src/processors/xbrl-sync.ts`
- **reportXbrlSyncOutcome()** (3 connections) — `workers/src/processors/xbrl-sync.ts`
- **resolveInstrumentId()** (3 connections) — `workers/src/processors/xbrl-sync.ts`
- **AnnualBackfillOutcome** (2 connections) — `workers/src/processors/xbrl-sync.ts`
- **InstanceFetchPlan** (2 connections) — `workers/src/processors/xbrl-sync.ts`
- **ArchivedFilingRef** (2 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **InstrumentChoice** (2 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **ReparseOutcome** (2 connections) — `workers/src/processors/xbrl-sync.ts`
- **XbrlSyncResult** (2 connections) — `workers/src/processors/xbrl-sync.ts`
- *... and 15 more nodes in this community*

## Relationships

- [XBRL Filing Era Sync](XBRL_Filing_Era_Sync.md) (27 shared connections)
- [XBRL Filing Indexing](XBRL_Filing_Indexing.md) (17 shared connections)
- [XBRL Feed Archive Backfill](XBRL_Feed_Archive_Backfill.md) (15 shared connections)
- [XBRL Instrument Symbol Resolution](XBRL_Instrument_Symbol_Resolution.md) (15 shared connections)
- [XBRL Fact Store Sync Tests](XBRL_Fact_Store_Sync_Tests.md) (8 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (6 shared connections)
- [XBRL Concept Parsing](XBRL_Concept_Parsing.md) (5 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (1 shared connections)
- [XBRL Financial Projections](XBRL_Financial_Projections.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/xbrl-filing-index.ts`
- `workers/src/processors/xbrl-sync-logic.ts`
- `workers/src/processors/xbrl-sync.ts`

## Audit Trail

- EXTRACTED: 173 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*