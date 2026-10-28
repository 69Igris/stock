# Databento Data Append Logic

> 77 nodes

## Key Concepts

- **us-market-hours.ts** (51 connections) — `packages/core/src/market-data/us-market-hours.ts`
- **databento-cost-model-logic.ts** (33 connections) — `packages/core/src/market-data/databento/databento-cost-model-logic.ts`
- **usMarketDayBoundsUtc()** (27 connections) — `packages/core/src/market-data/us-market-hours.ts`
- **us-market-hours.test.ts** (24 connections) — `packages/core/__tests__/market-data/us-market-hours.test.ts`
- **usMarketDateKey()** (18 connections) — `packages/core/src/market-data/us-market-hours.ts`
- **databento-append-logic.ts** (18 connections) — `packages/core/src/market-data/databento/databento-append-logic.ts`
- **databento-cost-model-logic.test.ts** (17 connections) — `packages/core/__tests__/market-data/databento/databento-cost-model-logic.test.ts`
- **isUsTradingDay()** (15 connections) — `packages/core/src/market-data/us-market-hours.ts`
- **lastCompletedUsSession()** (15 connections) — `packages/core/src/market-data/us-market-hours.ts`
- **databento-append-logic.test.ts** (12 connections) — `packages/core/__tests__/market-data/databento/databento-append-logic.test.ts`
- **toEtClock()** (11 connections) — `packages/core/src/market-data/us-market-hours.ts`
- **usMarketSession** (9 connections) — `packages/core/src/market-data/us-market-hours.ts`
- **computeAppendGap()** (9 connections) — `packages/core/src/market-data/databento/databento-append-logic.ts`
- **assertValidInstant()** (9 connections) — `packages/core/src/market-data/us-market-hours.ts`
- **resolveEntryRange()** (8 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **nextUsSessionBoundary()** (8 connections) — `packages/core/src/market-data/us-market-hours.ts`
- **newCell()** (7 connections) — `packages/core/src/market-data/databento/databento-cost-model-logic.ts`
- **getUsEarlyClose()** (7 connections) — `packages/core/src/market-data/us-market-hours.ts`
- **Reservoir** (6 connections) — `packages/core/src/market-data/databento/databento-cost-model-logic.ts`
- **summarizeCell()** (6 connections) — `packages/core/src/market-data/databento/databento-cost-model-logic.ts`
- **todBucketFor()** (6 connections) — `packages/core/src/market-data/databento/databento-cost-model-logic.ts`
- **isNonTradingDay()** (6 connections) — `packages/core/src/market-data/us-market-hours.ts`
- **usEtMinutesFromMidnight()** (6 connections) — `packages/core/src/market-data/us-market-hours.ts`
- **SeededRandom** (5 connections) — `packages/core/src/market-data/databento/databento-cost-model-logic.ts`
- **highWaterMarkFromChunks()** (5 connections) — `packages/core/src/market-data/databento/databento-append-logic.ts`
- *... and 52 more nodes in this community*

## Relationships

- [Databento Data Harvesting](Databento_Data_Harvesting.md) (22 shared connections)
- [Databento Cost Modeling](Databento_Cost_Modeling.md) (22 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (21 shared connections)
- [Price Source Write Authority](Price_Source_Write_Authority.md) (11 shared connections)
- [Intraday Candle Eviction](Intraday_Candle_Eviction.md) (10 shared connections)
- [Databento OHLCV Candle Loading](Databento_OHLCV_Candle_Loading.md) (8 shared connections)
- [Databento Manifest Parsing](Databento_Manifest_Parsing.md) (7 shared connections)
- [Databento Storage Client](Databento_Storage_Client.md) (7 shared connections)
- [Databento Market Data Writer](Databento_Market_Data_Writer.md) (5 shared connections)
- [Tiingo Minute Bar Aggregation](Tiingo_Minute_Bar_Aggregation.md) (3 shared connections)
- [Databento API Spend Budgeting](Databento_API_Spend_Budgeting.md) (1 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/databento/databento-append-logic.test.ts`
- `packages/core/__tests__/market-data/databento/databento-cost-model-logic.test.ts`
- `packages/core/__tests__/market-data/us-market-hours.test.ts`
- `packages/core/src/market-data/databento/databento-append-logic.ts`
- `packages/core/src/market-data/databento/databento-cost-model-logic.ts`
- `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- `packages/core/src/market-data/us-market-hours.ts`
- `scripts/jobs/databento-append.ts`

## Audit Trail

- EXTRACTED: 300 (100%)
- INFERRED: 1 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*