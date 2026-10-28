# Price Source Write Authority

> 53 nodes

## Key Concepts

- **tiingo-rt-sink-logic.ts** (26 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-sink-logic.ts`
- **candle-sink.ts** (25 connections) — `workers/src/realtime/candle-sink.ts`
- **tiingo-rt-sink-logic.test.ts** (15 connections) — `packages/core/__tests__/market-data/tiingo-rt-sink-logic.test.ts`
- **price-source-authority.ts** (12 connections) — `packages/core/src/market-data/price-source-authority.ts`
- **databento-day-authority.ts** (11 connections) — `packages/core/src/market-data/databento/databento-day-authority.ts`
- **candle-sink.test.ts** (11 connections) — `workers/__tests__/realtime/candle-sink.test.ts`
- **decideSessionWrite()** (10 connections) — `packages/core/src/market-data/databento/databento-day-authority.ts`
- **.write()** (10 connections) — `workers/src/realtime/candle-sink.ts`
- **RtCandleSink** (9 connections) — `workers/src/realtime/candle-sink.ts`
- **shouldUpgradePriceSource()** (9 connections) — `packages/core/src/market-data/price-source-authority.ts`
- **databento-day-authority.test.ts** (8 connections) — `packages/core/__tests__/market-data/databento-day-authority.test.ts`
- **price-source-authority.test.ts** (8 connections) — `packages/core/__tests__/market-data/price-source-authority.test.ts`
- **priceSourceAuthority()** (7 connections) — `packages/core/src/market-data/price-source-authority.ts`
- **.resolveDayVerdicts()** (7 connections) — `workers/src/realtime/candle-sink.ts`
- **CandleSinkDeps** (6 connections) — `workers/src/realtime/candle-sink.ts`
- **isIntradayTimeframe()** (6 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **partitionPriceWrites()** (6 connections) — `packages/core/src/market-data/price-source-authority.ts`
- **groupBySymbolDay()** (6 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-sink-logic.ts`
- **mayWriteIntoDay()** (6 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-sink-logic.ts`
- **RT_CANDLE_SOURCE** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-sink-logic.ts`
- **MinuteBar** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-minute-bars.ts`
- **TiingoRtQuote** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-realtime-logic.ts`
- **RtCandleRow** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-sink-logic.ts`
- **mayWritePriceSource()** (4 connections) — `packages/core/src/market-data/price-source-authority.ts`
- **toAggregatorTick()** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-rt-sink-logic.ts`
- *... and 28 more nodes in this community*

## Relationships

- [Tiingo Minute Bar Aggregation](Tiingo_Minute_Bar_Aggregation.md) (14 shared connections)
- [Databento Data Append Logic](Databento_Data_Append_Logic.md) (11 shared connections)
- [Parquet Candle Cold Storage](Parquet_Candle_Cold_Storage.md) (9 shared connections)
- [Databento Market Data Writer](Databento_Market_Data_Writer.md) (6 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (6 shared connections)
- [Tiingo Realtime Price Parsing](Tiingo_Realtime_Price_Parsing.md) (4 shared connections)
- [Intraday Candle Eviction](Intraday_Candle_Eviction.md) (3 shared connections)
- [Candle Data Integrity Verification](Candle_Data_Integrity_Verification.md) (3 shared connections)
- [Market Tick Data Archiver](Market_Tick_Data_Archiver.md) (3 shared connections)
- [Derivatives Bhavcopy Parsing](Derivatives_Bhavcopy_Parsing.md) (2 shared connections)
- [Yahoo Price Cleanup Script](Yahoo_Price_Cleanup_Script.md) (2 shared connections)
- [Tiingo Real-Time Market Quotes](Tiingo_Real-Time_Market_Quotes.md) (2 shared connections)

## Source Files

- `packages/core/__tests__/market-data/databento-day-authority.test.ts`
- `packages/core/__tests__/market-data/price-source-authority.test.ts`
- `packages/core/__tests__/market-data/tiingo-rt-sink-logic.test.ts`
- `packages/core/src/market-data/candles/candle-logic.ts`
- `packages/core/src/market-data/databento/databento-day-authority.ts`
- `packages/core/src/market-data/price-source-authority.ts`
- `packages/core/src/market-data/tiingo/tiingo-minute-bars.ts`
- `packages/core/src/market-data/tiingo/tiingo-realtime-logic.ts`
- `packages/core/src/market-data/tiingo/tiingo-rt-sink-logic.ts`
- `workers/__tests__/realtime/candle-sink.test.ts`
- `workers/src/realtime/candle-sink.ts`

## Audit Trail

- EXTRACTED: 170 (97%)
- INFERRED: 5 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*