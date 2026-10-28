# Bhavcopy Market Data Ingestion

> 128 nodes

## Key Concepts

- **feed-archive.ts** (53 connections) — `packages/core/src/market-data/feed-archive.ts`
- **market-data/bhavcopy.ts** (47 connections) — `packages/core/src/market-data/bhavcopy.ts`
- **getFeedAsset()** (44 connections) — `packages/core/src/market-data/feed-archive.ts`
- **feed-payload.ts** (19 connections) — `packages/core/src/market-data/feed-payload.ts`
- **nse-master-instruments.ts** (19 connections) — `packages/core/src/market-data/instruments/nse-master-instruments.ts`
- **parseUdiffBhavcopy()** (16 connections) — `packages/core/src/market-data/bhavcopy.ts`
- **nse-master-logic.ts** (16 connections) — `packages/core/src/market-data/instruments/nse-master-logic.ts`
- **feed-archive-guards.test.ts** (16 connections) — `packages/core/__tests__/market-data/feed-archive-guards.test.ts`
- **feed-payload.test.ts** (16 connections) — `packages/core/__tests__/market-data/feed-payload.test.ts`
- **validateFeedPayload()** (15 connections) — `packages/core/src/market-data/feed-payload.ts`
- **exchange-feed.ts** (15 connections) — `packages/core/src/market-data/exchange-feed.ts`
- **bhavcopy.test.ts** (14 connections) — `packages/core/__tests__/market-data/bhavcopy.test.ts`
- **feed-archive.test.ts** (14 connections) — `packages/core/__tests__/market-data/feed-archive.test.ts`
- **exchange-feed.test.ts** (13 connections) — `packages/core/__tests__/market-data/exchange-feed.test.ts`
- **sme-coverage.test.ts** (13 connections) — `packages/core/__tests__/market-data/sme-coverage.test.ts`
- **buildFeedArchiveKey()** (11 connections) — `packages/core/src/market-data/feed-archive.ts`
- **setFeedArchiveStore()** (11 connections) — `packages/core/src/market-data/feed-archive.ts`
- **FeedArchiveStore** (10 connections) — `packages/core/src/market-data/feed-archive.ts`
- **parseNseIndicesCsv()** (10 connections) — `packages/core/src/market-data/bhavcopy.ts`
- **toBhavcopyDateToken()** (10 connections) — `packages/core/src/market-data/bhavcopy.ts`
- **parseNseMasterCsv()** (10 connections) — `packages/core/src/market-data/instruments/nse-master-logic.ts`
- **decodeFeedText()** (9 connections) — `packages/core/src/market-data/bhavcopy.ts`
- **feedShapeFor()** (9 connections) — `packages/core/src/market-data/feed-payload.ts`
- **nse-master-logic.test.ts** (9 connections) — `packages/core/__tests__/market-data/nse-master-logic.test.ts`
- **fetchNseBhavcopy()** (8 connections) — `packages/core/src/market-data/bhavcopy.ts`
- *... and 103 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (50 shared connections)
- [Market Hours and Calendar](Market_Hours_and_Calendar.md) (16 shared connections)
- [Tiingo EOD Data Client](Tiingo_EOD_Data_Client.md) (15 shared connections)
- [XBRL Feed Archive Backfill](XBRL_Feed_Archive_Backfill.md) (10 shared connections)
- [Derivatives Bhavcopy Parsing](Derivatives_Bhavcopy_Parsing.md) (9 shared connections)
- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (8 shared connections)
- [Instrument Synchronization Sweeps](Instrument_Synchronization_Sweeps.md) (8 shared connections)
- [Report Family Backfill Registry](Report_Family_Backfill_Registry.md) (7 shared connections)
- [Bond Trade Data Processing](Bond_Trade_Data_Processing.md) (7 shared connections)
- [Exchange Instrument Classification](Exchange_Instrument_Classification.md) (7 shared connections)
- [Feed Archive Header Auditing](Feed_Archive_Header_Auditing.md) (6 shared connections)
- [Instrument Master Seeder](Instrument_Master_Seeder.md) (6 shared connections)

## Source Files

- `packages/core/__tests__/market-data/bhavcopy.test.ts`
- `packages/core/__tests__/market-data/exchange-feed.test.ts`
- `packages/core/__tests__/market-data/feed-archive-guards.test.ts`
- `packages/core/__tests__/market-data/feed-archive.test.ts`
- `packages/core/__tests__/market-data/feed-payload.test.ts`
- `packages/core/__tests__/market-data/nse-master-logic.test.ts`
- `packages/core/__tests__/market-data/sme-coverage.test.ts`
- `packages/core/src/market-data/bhavcopy.ts`
- `packages/core/src/market-data/exchange-feed.ts`
- `packages/core/src/market-data/feed-archive.ts`
- `packages/core/src/market-data/feed-payload.ts`
- `packages/core/src/market-data/instruments/nse-master-instruments.ts`
- `packages/core/src/market-data/instruments/nse-master-logic.ts`

## Audit Trail

- EXTRACTED: 441 (100%)
- INFERRED: 2 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*