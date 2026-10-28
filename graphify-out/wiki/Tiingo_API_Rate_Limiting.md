# Tiingo API Rate Limiting

> 73 nodes

## Key Concepts

- **tiingo-budget.ts** (76 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **tiingo-budget.test.ts** (44 connections) — `packages/core/__tests__/market-data/tiingo-budget.test.ts`
- **recordBytes()** (29 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **readTiingoBytesStage()** (16 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **readCounters()** (13 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **recordTiingoRequest()** (11 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **effectiveCeilings()** (9 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **flushStreamBytes()** (8 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **flushTick()** (8 connections) — `workers/src/realtime/main.ts`
- **TiingoBudgetRedis** (7 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **checkTiingoBudget()** (7 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **safeRedis()** (7 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **noteStage()** (6 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **recordStreamBytes()** (6 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **.get()** (6 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **TiingoBudgetExhaustedError** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **breakTiingoLeg()** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **defaultRedis()** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **incrWindow()** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **isBroken()** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **noteDegraded()** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **bytesKey()** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **noteRecovered()** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **noteSharedMonthBytes()** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **rollLocalMonth()** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- *... and 48 more nodes in this community*

## Relationships

- [Tiingo EOD Data Client](Tiingo_EOD_Data_Client.md) (36 shared connections)
- [Tiingo Minute Bar Aggregation](Tiingo_Minute_Bar_Aggregation.md) (8 shared connections)
- [Tiingo US Ticker Search](Tiingo_US_Ticker_Search.md) (8 shared connections)
- [Tiingo Realtime Subscription Planning](Tiingo_Realtime_Subscription_Planning.md) (7 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (2 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (1 shared connections)
- [Tiingo News Ingestion](Tiingo_News_Ingestion.md) (1 shared connections)
- [Price Source Write Authority](Price_Source_Write_Authority.md) (1 shared connections)
- [Redis Connection Management](Redis_Connection_Management.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/tiingo-budget.test.ts`
- `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- `workers/src/realtime/main.ts`

## Audit Trail

- EXTRACTED: 232 (99%)
- INFERRED: 2 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*