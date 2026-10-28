# BSE Scrip Master Enrichment

> 27 nodes

## Key Concepts

- **bse-master-instruments.ts** (21 connections) — `packages/core/src/market-data/instruments/bse-master-instruments.ts`
- **bse-master-logic.ts** (20 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **bse-master-logic.test.ts** (13 connections) — `packages/core/__tests__/market-data/bse-master-logic.test.ts`
- **fetchBseScripMaster()** (10 connections) — `packages/core/src/market-data/instruments/bse-master-instruments.ts`
- **parseBseMasterJson()** (7 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **enrichBseInstrumentsFromMaster()** (6 connections) — `packages/core/src/market-data/instruments/bse-master-instruments.ts`
- **CashInstrumentClass** (5 connections) — `packages/core/src/market-data/instruments/instrument-classification.ts`
- **planBseMasterEnrichment()** (5 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **diagnoseBseFeed()** (4 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **namesCorroborate()** (4 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **BseMasterRow** (3 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **classifyBseMasterRow()** (3 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **normaliseCompanyName()** (3 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **StoredBseInstrument** (2 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **backoffMs()** (2 connections) — `packages/core/src/market-data/instruments/bse-master-instruments.ts`
- **retryAfterFromError()** (2 connections) — `packages/core/src/market-data/instruments/bse-master-instruments.ts`
- **extractBseRows()** (2 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **BSE_SEGMENT_CLASS** (2 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **BseMasterEnrichmentResult** (1 connections) — `packages/core/src/market-data/instruments/bse-master-instruments.ts`
- **BseMasterEnrichmentPlan** (1 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **RawBseRow** (1 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **str()** (1 connections) — `packages/core/src/market-data/instruments/bse-master-logic.ts`
- **apiRow()** (1 connections) — `packages/core/__tests__/market-data/bse-master-logic.test.ts`
- **row()** (1 connections) — `packages/core/__tests__/market-data/bse-master-logic.test.ts`
- **stored()** (1 connections) — `packages/core/__tests__/market-data/bse-master-logic.test.ts`
- *... and 2 more nodes in this community*

## Relationships

- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (5 shared connections)
- [Exchange Instrument Classification](Exchange_Instrument_Classification.md) (4 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (3 shared connections)
- [Instrument Master Seeder](Instrument_Master_Seeder.md) (2 shared connections)
- [NSE Shareholding Ownership Sync](NSE_Shareholding_Ownership_Sync.md) (2 shared connections)
- [Stock Document Synchronization](Stock_Document_Synchronization.md) (2 shared connections)
- [BSE Announcements Backfill](BSE_Announcements_Backfill.md) (2 shared connections)
- [Instrument Series Readiness Validator](Instrument_Series_Readiness_Validator.md) (1 shared connections)
- [Market Hours and Calendar](Market_Hours_and_Calendar.md) (1 shared connections)
- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (1 shared connections)
- [Index Constituent Parsing](Index_Constituent_Parsing.md) (1 shared connections)
- [Derivatives Bhavcopy Parsing](Derivatives_Bhavcopy_Parsing.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/bse-master-logic.test.ts`
- `packages/core/src/market-data/instruments/bse-master-instruments.ts`
- `packages/core/src/market-data/instruments/bse-master-logic.ts`
- `packages/core/src/market-data/instruments/instrument-classification.ts`

## Audit Trail

- EXTRACTED: 75 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*