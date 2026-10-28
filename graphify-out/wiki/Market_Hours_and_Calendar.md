# Market Hours and Calendar

> 71 nodes

## Key Concepts

- **bhavcopy-sync.ts** (52 connections) — `workers/src/processors/bhavcopy-sync.ts`
- **bhavcopy-sync-logic.ts** (36 connections) — `workers/src/processors/bhavcopy-sync-logic.ts`
- **getNseMarketStatus()** (19 connections) — `packages/core/src/market-data/market-hours.ts`
- **processBhavcopySync()** (17 connections) — `workers/src/processors/bhavcopy-sync.ts`
- **market-hours.ts** (17 connections) — `packages/core/src/market-data/market-hours.ts`
- **toIstDateKey()** (14 connections) — `packages/core/src/market-data/nse-holidays.ts`
- **resolveInstrumentId()** (14 connections) — `workers/src/processors/bhavcopy-sync-logic.ts`
- **nse-holidays.ts** (13 connections) — `packages/core/src/market-data/nse-holidays.ts`
- **bhavcopy-sync-logic.test.ts** (13 connections) — `workers/__tests__/processors/bhavcopy-sync-logic.test.ts`
- **buildInstrumentIndex()** (12 connections) — `workers/src/processors/bhavcopy-sync-logic.ts`
- **BhavcopyRow** (10 connections) — `packages/core/src/market-data/bhavcopy.ts`
- **isinExchangeKey()** (10 connections) — `workers/src/processors/bhavcopy-sync-logic.ts`
- **resolveTargetDay()** (10 connections) — `workers/src/processors/bhavcopy-sync-logic.ts`
- **replay-health.ts** (10 connections) — `packages/core/src/market-data/replay-health.ts`
- **getNonTradingReason()** (9 connections) — `packages/core/src/market-data/nse-holidays.ts`
- **getNseHoliday()** (9 connections) — `packages/core/src/market-data/nse-holidays.ts`
- **symbolExchangeKey()** (7 connections) — `workers/src/processors/bhavcopy-sync-logic.ts`
- **nse-holidays.test.ts** (7 connections) — `packages/core/__tests__/nse-holidays.test.ts`
- **backfillInstrumentMetadata()** (6 connections) — `workers/src/processors/bhavcopy-sync.ts`
- **ingestExchangeDay()** (6 connections) — `workers/src/processors/bhavcopy-sync.ts`
- **resolveBackfillDays()** (6 connections) — `workers/src/processors/bhavcopy-sync-logic.ts`
- **toIndexSlug()** (6 connections) — `workers/src/processors/bhavcopy-sync-logic.ts`
- **FeedArchiveMode** (5 connections) — `packages/core/src/market-data/feed-archive.ts`
- **ReplayHealthInput** (5 connections) — `packages/core/src/market-data/replay-health.ts`
- **InstrumentIndex** (5 connections) — `workers/src/processors/bhavcopy-sync-logic.ts`
- *... and 46 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (30 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (16 shared connections)
- [Derivatives Bhavcopy Parsing](Derivatives_Bhavcopy_Parsing.md) (15 shared connections)
- [Market Movers and Indices](Market_Movers_and_Indices.md) (8 shared connections)
- [Financial Filing Aggregation](Financial_Filing_Aggregation.md) (7 shared connections)
- [Stock Surveillance Flags](Stock_Surveillance_Flags.md) (6 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (5 shared connections)
- [Instrument Synchronization Sweeps](Instrument_Synchronization_Sweeps.md) (4 shared connections)
- [XBRL Feed Archive Backfill](XBRL_Feed_Archive_Backfill.md) (4 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [Exchange Instrument Classification](Exchange_Instrument_Classification.md) (3 shared connections)
- [Report Family Backfill Registry](Report_Family_Backfill_Registry.md) (3 shared connections)

## Source Files

- `packages/core/__tests__/market-data/replay-health.test.ts`
- `packages/core/__tests__/market-hours.test.ts`
- `packages/core/__tests__/nse-holidays.test.ts`
- `packages/core/src/market-data/bhavcopy.ts`
- `packages/core/src/market-data/feed-archive.ts`
- `packages/core/src/market-data/market-hours.ts`
- `packages/core/src/market-data/nse-holidays.ts`
- `packages/core/src/market-data/replay-health.ts`
- `workers/__tests__/processors/bhavcopy-sync-logic.test.ts`
- `workers/src/processors/bhavcopy-sync-logic.ts`
- `workers/src/processors/bhavcopy-sync.ts`

## Audit Trail

- EXTRACTED: 280 (100%)
- INFERRED: 1 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*