# XBRL Filing Era Sync

> 34 nodes

## Key Concepts

- **xbrl-sync-logic.ts** (45 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **xbrl-sync-logic.test.ts** (28 connections) — `workers/__tests__/processors/xbrl-sync-logic.test.ts`
- **FilingIndexEntry** (8 connections) — `packages/core/src/market-data/xbrl-filing-index.ts`
- **routes/xbrl-sync.ts** (8 connections) — `workers/src/routes/xbrl-sync.ts`
- **compareFilingWriteOrder()** (7 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **orderFilingsForWrite()** (7 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **eraForDate()** (5 connections) — `packages/core/src/market-data/xbrl-filing-index.ts`
- **bucketForOutcome()** (5 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **erasForWindow()** (5 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **XbrlDocumentOutcome** (4 connections) — `packages/core/src/market-data/xbrl-financials-logic.ts`
- **archiveDayForFiling()** (4 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **downloadBudgetAfterIndexing()** (4 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **isNonFinancialFilingUrl()** (4 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **judgeXbrlParseHealth()** (4 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **pickAnnualCompanion()** (4 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **filingWriteTimestamp()** (3 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **isRetriableFailure()** (3 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **XBRL_FEED_SLUG** (3 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **XbrlParseTally** (2 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **cmpNum()** (2 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **eraRank()** (2 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **sequenceRank()** (2 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **LEGACY_FINANCIALS_OVERLAP_END** (2 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **MAX_NOT_UNDERSTOOD_SHARE** (2 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **MIN_READABLE_FOR_RATIO** (2 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- *... and 9 more nodes in this community*

## Relationships

- [XBRL Filings Index Sync](XBRL_Filings_Index_Sync.md) (27 shared connections)
- [XBRL Instrument Symbol Resolution](XBRL_Instrument_Symbol_Resolution.md) (7 shared connections)
- [XBRL Filing Indexing](XBRL_Filing_Indexing.md) (6 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (5 shared connections)
- [XBRL Fact Store Sync Tests](XBRL_Fact_Store_Sync_Tests.md) (4 shared connections)
- [XBRL Feed Archive Backfill](XBRL_Feed_Archive_Backfill.md) (4 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [XBRL Concept Parsing](XBRL_Concept_Parsing.md) (1 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/xbrl-filing-index.ts`
- `packages/core/src/market-data/xbrl-financials-logic.ts`
- `workers/__tests__/processors/xbrl-sync-logic.test.ts`
- `workers/src/processors/xbrl-sync-logic.ts`
- `workers/src/routes/xbrl-sync.ts`

## Audit Trail

- EXTRACTED: 116 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*