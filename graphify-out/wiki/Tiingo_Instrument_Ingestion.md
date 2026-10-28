# Tiingo Instrument Ingestion

> 67 nodes

## Key Concepts

- **tiingo-instruments-logic.ts** (28 connections) — `packages/core/src/market-data/instruments/tiingo-instruments-logic.ts`
- **us-instrument-sync-logic.ts** (27 connections) — `packages/core/src/market-data/instruments/us-instrument-sync-logic.ts`
- **qa-sample-universe.test.ts** (27 connections) — `packages/core/__tests__/market-data/qa-sample-universe.test.ts`
- **us-instrument-sync-logic.test.ts** (20 connections) — `packages/core/__tests__/market-data/us-instrument-sync-logic.test.ts`
- **us-instrument-sync.ts** (17 connections) — `packages/core/src/market-data/instruments/us-instrument-sync.ts`
- **selectPrimaryListings()** (13 connections) — `packages/core/src/market-data/instruments/tiingo-instruments-logic.ts`
- **deriveListingStatus()** (10 connections) — `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- **selectUsListings()** (9 connections) — `packages/core/src/market-data/instruments/us-instrument-sync-logic.ts`
- **syncUsInstruments()** (9 connections) — `packages/core/src/market-data/instruments/us-instrument-sync.ts`
- **buildListingId()** (9 connections) — `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- **maxEndDate()** (8 connections) — `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- **beatsListing()** (7 connections) — `packages/core/src/market-data/instruments/tiingo-instruments-logic.ts`
- **planUsInstrumentWrites()** (6 connections) — `packages/core/src/market-data/instruments/us-instrument-sync-logic.ts`
- **isUsCoreSecurity()** (6 connections) — `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- **isoToDate()** (4 connections) — `packages/core/src/market-data/instruments/tiingo-instruments-logic.ts`
- **usInstrumentTypeFor()** (4 connections) — `packages/core/src/market-data/instruments/tiingo-instruments-logic.ts`
- **isUsMasterSyncEnabled()** (4 connections) — `packages/core/src/market-data/instruments/us-instrument-sync-logic.ts`
- **judgeUsStaleSweep()** (4 connections) — `packages/core/src/market-data/instruments/us-instrument-sync-logic.ts`
- **loadListingWindows()** (4 connections) — `scripts/jobs/tiingo-us-corp-actions-backfill.ts`
- **TiingoListing** (3 connections) — `packages/core/src/market-data/instruments/tiingo-instruments-logic.ts`
- **StoredUsListing** (3 connections) — `packages/core/src/market-data/instruments/us-instrument-sync-logic.ts`
- **UsListingStats** (3 connections) — `packages/core/src/market-data/instruments/us-instrument-sync-logic.ts`
- **UsInstrumentSyncResult** (3 connections) — `packages/core/src/market-data/instruments/us-instrument-sync.ts`
- **TiingoListingSelection** (2 connections) — `packages/core/src/market-data/instruments/tiingo-instruments-logic.ts`
- **TiingoListingStats** (2 connections) — `packages/core/src/market-data/instruments/tiingo-instruments-logic.ts`
- *... and 42 more nodes in this community*

## Relationships

- [Tiingo EOD Data Client](Tiingo_EOD_Data_Client.md) (19 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (11 shared connections)
- [EDGAR CIK Enrichment](EDGAR_CIK_Enrichment.md) (6 shared connections)
- [QA Universe Sample Generator](QA_Universe_Sample_Generator.md) (6 shared connections)
- [Tiingo US EOD Backfill](Tiingo_US_EOD_Backfill.md) (4 shared connections)
- [Tiingo Corporate Actions Logic](Tiingo_Corporate_Actions_Logic.md) (4 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (4 shared connections)
- [Tiingo US Ticker Search](Tiingo_US_Ticker_Search.md) (2 shared connections)
- [Instrument Master Seeder](Instrument_Master_Seeder.md) (1 shared connections)
- [Zerodha Instrument Classification](Zerodha_Instrument_Classification.md) (1 shared connections)
- [Instrument Synchronization Sweeps](Instrument_Synchronization_Sweeps.md) (1 shared connections)
- [Tiingo US News Ingestion](Tiingo_US_News_Ingestion.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/qa-sample-universe.test.ts`
- `packages/core/__tests__/market-data/us-instrument-sync-logic.test.ts`
- `packages/core/src/market-data/instruments/tiingo-instruments-logic.ts`
- `packages/core/src/market-data/instruments/us-instrument-sync-logic.ts`
- `packages/core/src/market-data/instruments/us-instrument-sync.ts`
- `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- `scripts/jobs/tiingo-us-corp-actions-backfill.ts`

## Audit Trail

- EXTRACTED: 170 (98%)
- INFERRED: 3 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*