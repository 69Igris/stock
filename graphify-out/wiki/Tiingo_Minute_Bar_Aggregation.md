# Tiingo Minute Bar Aggregation

> 79 nodes

## Key Concepts

- **main.ts** (89 connections) — `workers/src/realtime/main.ts`
- **tiingo-minute-bars.ts** (14 connections) — `packages/core/src/market-data/tiingo/tiingo-minute-bars.ts`
- **tiingo-rt-leader-logic.ts** (12 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-leader-logic.ts`
- **leader-lock.ts** (12 connections) — `workers/src/realtime/leader-lock.ts`
- **emitRtMetrics()** (10 connections) — `workers/src/realtime/main.ts`
- **rt-metrics-logic.ts** (10 connections) — `workers/src/realtime/rt-metrics-logic.ts`
- **realtime-wiring.test.ts** (10 connections) — `workers/__tests__/realtime/realtime-wiring.test.ts`
- **openSocket()** (9 connections) — `workers/src/realtime/main.ts`
- **tiingo-rt-leader-logic.test.ts** (9 connections) — `packages/core/__tests__/market-data/tiingo-rt-leader-logic.test.ts`
- **rt-metrics-logic.test.ts** (9 connections) — `workers/__tests__/realtime/rt-metrics-logic.test.ts`
- **MinuteBarAggregator** (8 connections) — `packages/core/src/market-data/tiingo/tiingo-minute-bars.ts`
- **leaderTick()** (8 connections) — `workers/src/realtime/main.ts`
- **closeSocket()** (6 connections) — `workers/src/realtime/main.ts`
- **subscribeTick()** (6 connections) — `workers/src/realtime/main.ts`
- **tiingo-minute-bars.test.ts** (6 connections) — `packages/core/__tests__/market-data/tiingo-minute-bars.test.ts`
- **mayWrite()** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-leader-logic.ts`
- **releaseLeadership()** (5 connections) — `workers/src/realtime/leader-lock.ts`
- **start()** (5 connections) — `workers/src/realtime/main.ts`
- **health-logic.ts** (5 connections) — `workers/src/realtime/health-logic.ts`
- **decideLeadership()** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-leader-logic.ts`
- **makeLeaderToken()** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-leader-logic.ts`
- **decideHealth()** (4 connections) — `workers/src/realtime/health-logic.ts`
- **acquireOrRenew()** (4 connections) — `workers/src/realtime/leader-lock.ts`
- **healthView()** (4 connections) — `workers/src/realtime/main.ts`
- **writeQuote()** (4 connections) — `workers/src/realtime/main.ts`
- *... and 54 more nodes in this community*

## Relationships

- [Price Source Write Authority](Price_Source_Write_Authority.md) (14 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (10 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (9 shared connections)
- [Tiingo API Rate Limiting](Tiingo_API_Rate_Limiting.md) (8 shared connections)
- [Tiingo Real-Time Market Quotes](Tiingo_Real-Time_Market_Quotes.md) (8 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (7 shared connections)
- [Tiingo Realtime Subscription Planning](Tiingo_Realtime_Subscription_Planning.md) (7 shared connections)
- [Market Tick Data Archiver](Market_Tick_Data_Archiver.md) (4 shared connections)
- [Databento Data Append Logic](Databento_Data_Append_Logic.md) (3 shared connections)
- [Tiingo Realtime Price Parsing](Tiingo_Realtime_Price_Parsing.md) (2 shared connections)
- [Tiingo WebSocket Client](Tiingo_WebSocket_Client.md) (2 shared connections)
- [Tiingo Realtime WebSocket Client](Tiingo_Realtime_WebSocket_Client.md) (2 shared connections)

## Source Files

- `packages/core/__tests__/market-data/tiingo-minute-bars.test.ts`
- `packages/core/__tests__/market-data/tiingo-rt-leader-logic.test.ts`
- `packages/core/src/market-data/tiingo/tiingo-minute-bars.ts`
- `packages/core/src/market-data/tiingo/tiingo-rt-keys.ts`
- `packages/core/src/market-data/tiingo/tiingo-rt-leader-logic.ts`
- `workers/__tests__/realtime/realtime-wiring.test.ts`
- `workers/__tests__/realtime/rt-metrics-logic.test.ts`
- `workers/src/realtime/candle-sink.ts`
- `workers/src/realtime/health-logic.ts`
- `workers/src/realtime/leader-lock.ts`
- `workers/src/realtime/main.ts`
- `workers/src/realtime/rt-metrics-logic.ts`

## Audit Trail

- EXTRACTED: 215 (97%)
- INFERRED: 7 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*