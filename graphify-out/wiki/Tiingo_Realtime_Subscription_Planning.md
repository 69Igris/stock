# Tiingo Realtime Subscription Planning

> 27 nodes

## Key Concepts

- **subscription.ts** (28 connections) — `workers/src/realtime/subscription.ts`
- **tiingo-rt-subscription-logic.ts** (19 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- **tiingo-rt-subscription-logic.test.ts** (13 connections) — `packages/core/__tests__/market-data/tiingo-rt-subscription-logic.test.ts`
- **refreshSubscriptions()** (8 connections) — `workers/src/realtime/subscription.ts`
- **planSubscriptions()** (6 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- **DEFAULT_EPHEMERAL_TTL_MS** (6 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- **stageShedsEphemerals()** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- **DegradeStage** (3 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- **EphemeralEntry** (3 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- **ephemeralTtlMs()** (3 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- **readDegradeStage()** (3 connections) — `workers/src/realtime/subscription.ts`
- **readEphemeral()** (3 connections) — `workers/src/realtime/subscription.ts`
- **rebuildBaseSet()** (3 connections) — `workers/src/realtime/subscription.ts`
- **DEFAULT_MAX_SYMBOLS** (3 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- **norm()** (2 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- **emptySubscriptionCounters()** (2 connections) — `workers/src/realtime/subscription.ts`
- **loadDemandSymbols()** (2 connections) — `workers/src/realtime/subscription.ts`
- **SHRUNK_EPHEMERAL_TTL_MS** (2 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- **BASE_REFRESH_MS** (2 connections) — `workers/src/realtime/subscription.ts`
- **SubscriptionPlan** (1 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- **SubscriptionPlanInput** (1 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- **SubscriptionCounters** (1 connections) — `workers/src/realtime/subscription.ts`
- **eph()** (1 connections) — `packages/core/__tests__/market-data/tiingo-rt-subscription-logic.test.ts`
- **STAGE_RANK** (1 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- **NOW** (1 connections) — `packages/core/__tests__/market-data/tiingo-rt-subscription-logic.test.ts`
- *... and 2 more nodes in this community*

## Relationships

- [Tiingo Real-Time Market Quotes](Tiingo_Real-Time_Market_Quotes.md) (8 shared connections)
- [Tiingo Minute Bar Aggregation](Tiingo_Minute_Bar_Aggregation.md) (7 shared connections)
- [Tiingo API Rate Limiting](Tiingo_API_Rate_Limiting.md) (7 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (4 shared connections)
- [Redis Connection Management](Redis_Connection_Management.md) (1 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Zerodha Instrument Classification](Zerodha_Instrument_Classification.md) (1 shared connections)
- [Tiingo WebSocket Client](Tiingo_WebSocket_Client.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Instrument Synchronization Sweeps](Instrument_Synchronization_Sweeps.md) (1 shared connections)
- [Tiingo Realtime WebSocket Client](Tiingo_Realtime_WebSocket_Client.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/tiingo-rt-subscription-logic.test.ts`
- `packages/core/src/market-data/tiingo/tiingo-rt-subscription-logic.ts`
- `workers/src/realtime/subscription.ts`

## Audit Trail

- EXTRACTED: 78 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*