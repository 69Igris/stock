# Intraday Candle Eviction

> 87 nodes

## Key Concepts

- **candle-evict-logic.test.ts** (65 connections) — `workers/__tests__/processors/candle-evict-logic.test.ts`
- **candle-evict-logic.ts** (64 connections) — `workers/src/processors/candle-evict-logic.ts`
- **processors/candle-evict.ts** (63 connections) — `workers/src/processors/candle-evict.ts`
- **processCandleEvict()** (27 connections) — `workers/src/processors/candle-evict.ts`
- **routes/candle-evict.ts** (14 connections) — `workers/src/routes/candle-evict.ts`
- **processIntradayLeaf()** (12 connections) — `workers/src/processors/candle-evict.ts`
- **hotWindowFloorYear()** (10 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **partitionIntradayBySessionAuthority()** (9 connections) — `workers/src/processors/candle-evict-logic.ts`
- **processIntradayPlan()** (9 connections) — `workers/src/processors/candle-evict.ts`
- **intradayHotFloorTs()** (8 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **buildEvictWhere()** (7 connections) — `workers/src/processors/candle-evict-logic.ts`
- **intradaySessionCutoff()** (7 connections) — `workers/src/processors/candle-evict-logic.ts`
- **INTRADAY_TIMEFRAMES** (7 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **buildIntradayUnitWhere()** (6 connections) — `workers/src/processors/candle-evict-logic.ts`
- **groupCandidatesByShard()** (6 connections) — `workers/src/processors/candle-evict-logic.ts`
- **partitionByShardCoverage()** (6 connections) — `workers/src/processors/candle-evict-logic.ts`
- **windowFloorTs()** (6 connections) — `workers/src/processors/candle-evict-logic.ts`
- **chainNext()** (5 connections) — `workers/src/processors/candle-evict.ts`
- **clearLedgerYears()** (5 connections) — `workers/src/processors/candle-evict.ts`
- **buildIntradayPlanPipeline()** (5 connections) — `workers/src/processors/candle-evict-logic.ts`
- **evictTallyBalances()** (5 connections) — `workers/src/processors/candle-evict-logic.ts`
- **hotLoadCutoff()** (5 connections) — `workers/src/processors/candle-evict-logic.ts`
- **isWithinRunBudget()** (5 connections) — `workers/src/processors/candle-evict-logic.ts`
- **judgeEvictRun()** (5 connections) — `workers/src/processors/candle-evict-logic.ts`
- **nextEvictStep()** (5 connections) — `workers/src/processors/candle-evict-logic.ts`
- *... and 62 more nodes in this community*

## Relationships

- [Parquet Candle Cold Storage](Parquet_Candle_Cold_Storage.md) (15 shared connections)
- [Databento Data Append Logic](Databento_Data_Append_Logic.md) (10 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (8 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (8 shared connections)
- [Candle Repository Sharding](Candle_Repository_Sharding.md) (8 shared connections)
- [Candle Cold Storage](Candle_Cold_Storage.md) (7 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (5 shared connections)
- [Databento Market Data Writer](Databento_Market_Data_Writer.md) (4 shared connections)
- [Price Source Write Authority](Price_Source_Write_Authority.md) (3 shared connections)
- [Candle Eviction Rule Tests](Candle_Eviction_Rule_Tests.md) (3 shared connections)
- [Tiingo US EOD Backfill](Tiingo_US_EOD_Backfill.md) (2 shared connections)
- [Tiingo Script CLI Spec](Tiingo_Script_CLI_Spec.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/candles/candle-logic.ts`
- `packages/types/src/pubsub.ts`
- `workers/__tests__/processors/candle-evict-logic.test.ts`
- `workers/src/processors/candle-evict-logic.ts`
- `workers/src/processors/candle-evict.ts`
- `workers/src/routes/candle-evict.ts`

## Audit Trail

- EXTRACTED: 294 (99%)
- INFERRED: 3 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*