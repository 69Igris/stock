# Derivatives Bhavcopy Parsing

> 121 nodes

## Key Concepts

- **feed-parse.ts** (133 connections) — `scripts/jobs/feed-parse.ts`
- **main()** (35 connections) — `scripts/jobs/feed-parse.ts`
- **mwpl-logic.test.ts** (19 connections) — `packages/core/__tests__/market-data/mwpl-logic.test.ts`
- **mwpl-logic.ts** (18 connections) — `packages/core/src/market-data/mwpl-logic.ts`
- **bhavcopy-legacy.ts** (15 connections) — `packages/core/src/market-data/bhavcopy-legacy.ts`
- **UnreadableFeedFile** (12 connections) — `packages/core/src/market-data/bhavcopy.ts`
- **bhavcopy-derivatives.ts** (12 connections) — `packages/core/src/market-data/bhavcopy-derivatives.ts`
- **parseCombinedOiDeleq()** (11 connections) — `packages/core/src/market-data/mwpl-logic.ts`
- **parseUdiffFoBhavcopy()** (10 connections) — `packages/core/src/market-data/bhavcopy-derivatives.ts`
- **parseOldNseCmBhavcopy()** (9 connections) — `packages/core/src/market-data/bhavcopy-legacy.ts`
- **parseOldNseFoBhavcopy()** (8 connections) — `packages/core/src/market-data/bhavcopy-legacy.ts`
- **bhavcopy-legacy.test.ts** (8 connections) — `packages/core/__tests__/market-data/bhavcopy-legacy.test.ts`
- **writeBseLegacyCash()** (7 connections) — `scripts/jobs/feed-parse.ts`
- **writeBseDelivery()** (6 connections) — `scripts/jobs/feed-parse.ts`
- **writeCash()** (6 connections) — `scripts/jobs/feed-parse.ts`
- **run-completion.ts** (6 connections) — `packages/core/src/market-data/run-completion.ts`
- **parseUdiffExpiry()** (5 connections) — `packages/core/src/market-data/bhavcopy-derivatives.ts`
- **parseLegacyExpiry()** (5 connections) — `packages/core/src/market-data/bhavcopy-legacy.ts`
- **collapseBySeriesPreference()** (5 connections) — `packages/core/src/market-data/delivery.ts`
- **parseScbseallGrossDelivery()** (5 connections) — `packages/core/src/market-data/delivery.ts`
- **toMwplDailyWrite()** (5 connections) — `packages/core/src/market-data/mwpl-logic.ts`
- **withHardTimeout()** (5 connections) — `packages/core/src/market-data/run-completion.ts`
- **writeBondEod()** (5 connections) — `scripts/jobs/feed-parse.ts`
- **writeMwpl()** (5 connections) — `scripts/jobs/feed-parse.ts`
- **writeNseDelivery()** (5 connections) — `scripts/jobs/feed-parse.ts`
- *... and 96 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (31 shared connections)
- [Bond Trade Data Processing](Bond_Trade_Data_Processing.md) (25 shared connections)
- [Market Hours and Calendar](Market_Hours_and_Calendar.md) (15 shared connections)
- [FII Statistics Processing](FII_Statistics_Processing.md) (12 shared connections)
- [Index Constituent Parsing](Index_Constituent_Parsing.md) (11 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (9 shared connections)
- [Stock Surveillance Flags](Stock_Surveillance_Flags.md) (9 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (6 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (5 shared connections)
- [Feed Backfill Logic](Feed_Backfill_Logic.md) (4 shared connections)
- [Databento OHLCV Candle Loading](Databento_OHLCV_Candle_Loading.md) (3 shared connections)
- [Commodity Bhavcopy Parsing](Commodity_Bhavcopy_Parsing.md) (2 shared connections)

## Source Files

- `packages/core/__tests__/market-data/bhavcopy-derivatives.test.ts`
- `packages/core/__tests__/market-data/bhavcopy-legacy.test.ts`
- `packages/core/__tests__/market-data/mwpl-logic.test.ts`
- `packages/core/__tests__/market-data/run-completion.test.ts`
- `packages/core/src/market-data/bhavcopy-derivatives.ts`
- `packages/core/src/market-data/bhavcopy-legacy.ts`
- `packages/core/src/market-data/bhavcopy.ts`
- `packages/core/src/market-data/bond-eod-logic.ts`
- `packages/core/src/market-data/bond-master-logic.ts`
- `packages/core/src/market-data/delivery.ts`
- `packages/core/src/market-data/mwpl-logic.ts`
- `packages/core/src/market-data/run-completion.ts`
- `scripts/jobs/feed-parse.ts`

## Audit Trail

- EXTRACTED: 326 (96%)
- INFERRED: 12 (4%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*