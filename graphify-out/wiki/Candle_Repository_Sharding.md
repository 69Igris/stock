# Candle Repository Sharding

> 27 nodes

## Key Concepts

- **CandleBar** (30 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **candleRepository** (28 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **.getCandles()** (16 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **getCandleColdStore()** (13 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **marketForExchange()** (11 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **HotCandleRow** (7 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **.hotLoad()** (7 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **.planHotLoad()** (7 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **.readCold()** (7 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **AdjustedCandleBar** (6 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **.archiveCold()** (6 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **.latestTs()** (6 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **hotLoadedYearsForBars()** (4 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **toHotLoadWriteRows()** (4 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **.recordHotLoadLedger()** (4 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **.refreshHotLoadStamps()** (4 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **.runHotLoad()** (4 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **.readHot()** (3 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **emptyColdResult()** (3 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **CachedShard** (2 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **ColdReadResult** (2 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **HotLoadPlan** (2 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **IntradaySessionPartition** (2 connections) — `workers/src/processors/candle-evict-logic.ts`
- **.evictColdShards()** (2 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- **.resolveCurrentListingId()** (2 connections) — `packages/core/src/market-data/candles/candle-repository.ts`
- *... and 2 more nodes in this community*

## Relationships

- [Parquet Candle Cold Storage](Parquet_Candle_Cold_Storage.md) (44 shared connections)
- [Candle Cold Storage](Candle_Cold_Storage.md) (11 shared connections)
- [Intraday Candle Eviction](Intraday_Candle_Eviction.md) (8 shared connections)
- [Candle Shard Cold Storage](Candle_Shard_Cold_Storage.md) (7 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (5 shared connections)
- [Tiingo Real-Time Market Quotes](Tiingo_Real-Time_Market_Quotes.md) (5 shared connections)
- [Databento Market Data Writer](Databento_Market_Data_Writer.md) (3 shared connections)
- [Databento Data Harvesting](Databento_Data_Harvesting.md) (3 shared connections)
- [US EOD Data Synchronization](US_EOD_Data_Synchronization.md) (2 shared connections)
- [Tiingo US EOD Backfill](Tiingo_US_EOD_Backfill.md) (1 shared connections)
- [Price Source Write Authority](Price_Source_Write_Authority.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/candles/candle-cold-store.ts`
- `packages/core/src/market-data/candles/candle-logic.ts`
- `packages/core/src/market-data/candles/candle-repository.ts`
- `workers/src/processors/candle-evict-logic.ts`

## Audit Trail

- EXTRACTED: 137 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*