# Tiingo Real-Time Market Quotes

> 51 nodes

## Key Concepts

- **tiingo-rt-read.ts** (31 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read.ts`
- **tiingo-rt-read-logic.ts** (30 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts`
- **us-quote-read-logic.test.ts** (26 connections) — `packages/core/__tests__/market-data/us-quote-read-logic.test.ts`
- **us-quote-resolve.test.ts** (19 connections) — `packages/core/__tests__/market-data/us-quote-resolve.test.ts`
- **tiingo-rt-keys.ts** (17 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-keys.ts`
- **decideUsQuote()** (8 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts`
- **RtQuotePayload** (7 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-keys.ts`
- **rtQuoteKey()** (7 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-keys.ts`
- **resolveUsQuotes()** (7 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read.ts`
- **scenario()** (6 connections) — `packages/core/__tests__/market-data/us-quote-resolve.test.ts`
- **readRtQuotes()** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read.ts`
- **ephemeralExpiryScore()** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts`
- **normalizeUsExchange()** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts`
- **pingUsSymbolInterest()** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read.ts`
- **installRedis()** (4 connections) — `packages/core/__tests__/market-data/us-quote-resolve.test.ts`
- **TIINGO_US_EXCHANGES** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- **RT_EPHEMERAL_SET_KEY** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-keys.ts`
- **RT_EPHEMERAL_TTL_MS** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts`
- **UsQuote** (3 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts`
- **parseRtQuote()** (3 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-keys.ts`
- **batchQuoteSource()** (3 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts`
- **isLiveQuoteProvenance()** (3 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts`
- **isRepresentableInstant()** (3 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts`
- **isRtQuoteFresh()** (3 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts`
- **percentChange()** (3 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts`
- *... and 26 more nodes in this community*

## Relationships

- [Redis Connection Management](Redis_Connection_Management.md) (12 shared connections)
- [Tiingo Minute Bar Aggregation](Tiingo_Minute_Bar_Aggregation.md) (8 shared connections)
- [Tiingo Realtime Subscription Planning](Tiingo_Realtime_Subscription_Planning.md) (8 shared connections)
- [Parquet Candle Cold Storage](Parquet_Candle_Cold_Storage.md) (6 shared connections)
- [Candle Repository Sharding](Candle_Repository_Sharding.md) (5 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (3 shared connections)
- [Tiingo EOD Data Client](Tiingo_EOD_Data_Client.md) (3 shared connections)
- [Price Source Write Authority](Price_Source_Write_Authority.md) (2 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (2 shared connections)

## Source Files

- `packages/core/__tests__/market-data/us-quote-read-logic.test.ts`
- `packages/core/__tests__/market-data/us-quote-resolve.test.ts`
- `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- `packages/core/src/market-data/tiingo/tiingo-rt-keys.ts`
- `packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts`
- `packages/core/src/market-data/tiingo/tiingo-rt-read.ts`
- `packages/logger/src/index.ts`

## Audit Trail

- EXTRACTED: 154 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*