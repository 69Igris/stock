# Parquet Candle Cold Storage

> 88 nodes

## Key Concepts

- **candle-logic.ts** (105 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **candles/index.ts** (86 connections) — `packages/core/src/market-data/candles/index.ts`
- **candle-repository.ts** (60 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **candle-logic.test.ts** (37 connections) — `packages/core/__tests__/market-data/candle-logic.test.ts`
- **resolveCandleDestination()** (13 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **sortBarsAscending()** (13 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **.putCandles()** (12 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **sanitizeCandleWrites()** (10 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **NormalizedCandleWrite** (9 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **partitionCandleWrites()** (9 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **adjustCandleSeries()** (8 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **barsNeedingHotLoadStamp()** (8 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **chunk()** (8 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **groupColdShards()** (8 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **mergeHotAndCold()** (8 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **.insertNew()** (8 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **partitionCandlesByDestination()** (7 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **sniffColdShardFormat()** (7 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **CandleTier** (6 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **CandleReadMeta** (6 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **buildHotLoadStampUpdates()** (6 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **coldYearsForRange()** (6 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **groupWritesBySeries()** (6 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **parseColdShard()** (6 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **promotableColdBars()** (6 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- *... and 63 more nodes in this community*

## Relationships

- [Candle Repository Sharding](Candle_Repository_Sharding.md) (44 shared connections)
- [Candle Cold Storage](Candle_Cold_Storage.md) (36 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (32 shared connections)
- [Candle Shard Cold Storage](Candle_Shard_Cold_Storage.md) (21 shared connections)
- [Databento Market Data Writer](Databento_Market_Data_Writer.md) (20 shared connections)
- [Intraday Candle Eviction](Intraday_Candle_Eviction.md) (15 shared connections)
- [Price Source Write Authority](Price_Source_Write_Authority.md) (9 shared connections)
- [Tiingo Script CLI Spec](Tiingo_Script_CLI_Spec.md) (6 shared connections)
- [Tiingo Real-Time Market Quotes](Tiingo_Real-Time_Market_Quotes.md) (6 shared connections)
- [Tiingo EOD Data Client](Tiingo_EOD_Data_Client.md) (5 shared connections)
- [13F Cold Storage Sharding](13F_Cold_Storage_Sharding.md) (4 shared connections)
- [Tiingo US EOD Backfill](Tiingo_US_EOD_Backfill.md) (4 shared connections)

## Source Files

- `hyparquet`
- `hyparquet-writer`
- `packages/core/__tests__/market-data/candle-logic.test.ts`
- `packages/core/package.json`
- `packages/core/src/market-data/candles/candle-cold-store.ts`
- `packages/core/src/market-data/candles/candle-logic.ts`
- `packages/core/src/market-data/candles/candle-repository.ts`
- `packages/core/src/market-data/candles/index.ts`

## Audit Trail

- EXTRACTED: 420 (99%)
- INFERRED: 4 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*