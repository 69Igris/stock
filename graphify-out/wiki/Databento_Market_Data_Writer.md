# Databento Market Data Writer

> 25 nodes

## Key Concepts

- **databento-session-writer.ts** (29 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **candleKey()** (21 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **CandleWriteRow** (16 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **databento-session-writer.test.ts** (16 connections) — `packages/core/__tests__/market-data/databento-session-writer.test.ts`
- **writeSymbolBatch()** (12 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **writeColdSessions()** (10 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **SessionWriterDeps** (9 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **writeHotSession()** (6 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **ColdShardOutcome** (5 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **groupRowsBySession()** (5 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **errText()** (3 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **.deleteSessionRows()** (3 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **.putCandles()** (3 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **.readColdShard()** (3 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **.writeColdShard()** (3 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **shardUnchanged()** (3 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **SessionGroup** (2 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **.findExistingSources()** (2 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **.now()** (2 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **toColdBarRow()** (2 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **SessionWriteCounters** (1 connections) — `packages/core/src/market-data/databento/databento-session-writer.ts`
- **bar()** (1 connections) — `packages/core/__tests__/market-data/databento-session-writer.test.ts`
- **fakeDeps()** (1 connections) — `packages/core/__tests__/market-data/databento-session-writer.test.ts`
- **recent()** (1 connections) — `packages/core/__tests__/market-data/databento-session-writer.test.ts`
- **row()** (1 connections) — `packages/core/__tests__/market-data/databento-session-writer.test.ts`

## Relationships

- [Parquet Candle Cold Storage](Parquet_Candle_Cold_Storage.md) (20 shared connections)
- [Databento Data Harvesting](Databento_Data_Harvesting.md) (11 shared connections)
- [Databento OHLCV Candle Loading](Databento_OHLCV_Candle_Loading.md) (8 shared connections)
- [Price Source Write Authority](Price_Source_Write_Authority.md) (6 shared connections)
- [Databento Data Append Logic](Databento_Data_Append_Logic.md) (5 shared connections)
- [Intraday Candle Eviction](Intraday_Candle_Eviction.md) (4 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (3 shared connections)
- [Candle Cold Storage](Candle_Cold_Storage.md) (3 shared connections)
- [Candle Repository Sharding](Candle_Repository_Sharding.md) (3 shared connections)
- [US EOD Data Synchronization](US_EOD_Data_Synchronization.md) (2 shared connections)
- [Candle Shard Cold Storage](Candle_Shard_Cold_Storage.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/databento-session-writer.test.ts`
- `packages/core/src/market-data/candles/candle-cold-store.ts`
- `packages/core/src/market-data/candles/candle-logic.ts`
- `packages/core/src/market-data/databento/databento-session-writer.ts`

## Audit Trail

- EXTRACTED: 110 (97%)
- INFERRED: 3 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*