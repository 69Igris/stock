# Candle Shard Cold Storage

> 36 nodes

## Key Concepts

- **candle-hot-load.test.ts** (52 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **Harness** (11 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **encodeColdShard()** (10 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **setCandleColdStore()** (8 connections) — `packages/core/src/market-data/candles/candle-cold-store.ts`
- **FakeDb** (7 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **.install()** (5 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **bar()** (4 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **d()** (3 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **.enterWrite()** (2 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **.ops()** (2 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **.writes()** (2 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **hotRow()** (2 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **matches()** (2 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **nextSymbol()** (2 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **normalized()** (2 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **project()** (2 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **storedRow()** (2 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **HOT_LOAD_STAMP_CHUNK** (2 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **HOT_LOAD_STAMP_MAX_AGE_MS** (2 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **FakeRow** (1 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **FlatWhere** (1 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **RawUpdateCommand** (1 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **SelectMap** (1 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **ago()** (1 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- **deferred()** (1 connections) — `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- *... and 11 more nodes in this community*

## Relationships

- [Parquet Candle Cold Storage](Parquet_Candle_Cold_Storage.md) (21 shared connections)
- [Candle Repository Sharding](Candle_Repository_Sharding.md) (7 shared connections)
- [Candle Cold Storage](Candle_Cold_Storage.md) (6 shared connections)
- [Databento Data Harvesting](Databento_Data_Harvesting.md) (2 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Databento Market Data Writer](Databento_Market_Data_Writer.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/candle-hot-load.test.ts`
- `packages/core/src/market-data/candles/candle-cold-store.ts`
- `packages/core/src/market-data/candles/candle-logic.ts`

## Audit Trail

- EXTRACTED: 90 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*