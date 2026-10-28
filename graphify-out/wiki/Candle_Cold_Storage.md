# Candle Cold Storage

> 30 nodes

## Key Concepts

- **candle-cold-store.ts** (36 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **candle-cold-store.test.ts** (24 connections) — `packages/core/__tests__/market-data/candle-cold-store.test.ts`
- **writeColdShard()** (21 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **readColdShard()** (13 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **decodeColdShard()** (12 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **readColdShardUncached()** (10 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **buildCandleColdKey()** (10 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **CandleColdStore** (8 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **ColdStoreUnavailableError** (8 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **evictColdShard()** (7 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **mergeColdBars()** (7 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **CANDLE_COLD_TIMEOUT_MS** (6 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **deleteCached()** (5 connections) — `packages/core/src/cache/wrapper.ts`
- **withDeadline()** (5 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **SINGLE_FLIGHT_TIMEOUT_MS** (5 connections) — `packages/core/src/cache/stale-while-error.ts`
- **.get()** (4 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **coldShardContentType()** (4 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **resolveColdShardFormat()** (4 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **.put()** (2 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **COLD_CACHE_LAST_GOOD_SUFFIX** (2 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **COLD_CACHE_SCOPE** (2 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **.constructor()** (1 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **bar()** (1 connections) — `packages/core/__tests__/market-data/candle-cold-store.test.ts`
- **codeOnly()** (1 connections) — `packages/core/__tests__/market-data/candle-cold-store.test.ts`
- **fakeStore()** (1 connections) — `packages/core/__tests__/market-data/candle-cold-store.test.ts`
- *... and 5 more nodes in this community*

## Relationships

- [Parquet Candle Cold Storage](Parquet_Candle_Cold_Storage.md) (36 shared connections)
- [Candle Repository Sharding](Candle_Repository_Sharding.md) (11 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (7 shared connections)
- [Intraday Candle Eviction](Intraday_Candle_Eviction.md) (7 shared connections)
- [Candle Shard Cold Storage](Candle_Shard_Cold_Storage.md) (6 shared connections)
- [Databento Data Harvesting](Databento_Data_Harvesting.md) (6 shared connections)
- [Stale-While-Error Cache Utility](Stale-While-Error_Cache_Utility.md) (5 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (4 shared connections)
- [Databento Market Data Writer](Databento_Market_Data_Writer.md) (3 shared connections)
- [Yahoo Finance Market Data](Yahoo_Finance_Market_Data.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/candle-cold-store.test.ts`
- `packages/core/src/cache/stale-while-error.ts`
- `packages/core/src/cache/wrapper.ts`
- `packages/core/src/market-data/candles/candle-cold-store.ts`
- `packages/core/src/market-data/candles/candle-logic.ts`

## Audit Trail

- EXTRACTED: 143 (99%)
- INFERRED: 2 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*