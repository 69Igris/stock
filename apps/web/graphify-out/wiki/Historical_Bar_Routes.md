# Historical Bar Routes

> 52 nodes

## Key Concepts

- **history/route.ts** (42 connections) — `app/api/market/udf/history/route.ts`
- **history/route-logic.ts** (23 connections) — `app/api/market/udf/history/route-logic.ts`
- **GET()** (20 connections) — `app/api/market/udf/history/route.ts`
- **udf-history-cache.ts** (13 connections) — `lib/market/udf-history-cache.ts`
- **udf-history.test.ts** (10 connections) — `__tests__/api/udf-history.test.ts`
- **udf-history-cache-logic.ts** (7 connections) — `lib/market/udf-history-cache-logic.ts`
- **corporate-action-adjust.ts** (6 connections) — `lib/market/corporate-action-adjust.ts`
- **udf-history-live-bar.test.ts** (6 connections) — `__tests__/market/udf-history-live-bar.test.ts`
- **shouldReadSharedCache()** (5 connections) — `app/api/market/udf/history/route-logic.ts`
- **shouldWriteSharedCache()** (5 connections) — `app/api/market/udf/history/route-logic.ts`
- **buildUdfHistoryCacheKey()** (5 connections) — `lib/market/udf-history-cache-logic.ts`
- **setCachedUdfHistory()** (5 connections) — `lib/market/udf-history-cache.ts`
- **HistoricalBar** (4 connections) — `lib/market/historical-fetcher.ts`
- **barsToUdfOk()** (4 connections) — `app/api/market/udf/history/route-logic.ts`
- **istSessionDateUtcMs()** (4 connections) — `app/api/market/udf/history/route-logic.ts`
- **liveBarFromQuote()** (4 connections) — `app/api/market/udf/history/route-logic.ts`
- **loadHistoryPreconditions()** (4 connections) — `app/api/market/udf/history/route-logic.ts`
- **pickPeriodForRange()** (4 connections) — `app/api/market/udf/history/route-logic.ts`
- **shouldAppendLiveBar()** (4 connections) — `app/api/market/udf/history/route-logic.ts`
- **tvResolutionToInterval()** (4 connections) — `app/api/market/udf/history/route-logic.ts`
- **udf-history-cache.test.ts** (4 connections) — `__tests__/market/udf-history-cache.test.ts`
- **isActiveBroker()** (3 connections) — `app/api/market/udf/history/route-logic.ts`
- **getSymbolAdjustment()** (3 connections) — `lib/market/corporate-action-adjust.ts`
- **getCachedUdfHistory()** (3 connections) — `lib/market/udf-history-cache.ts`
- **pickHistoryCacheTtlSeconds()** (3 connections) — `lib/market/udf-history-cache-logic.ts`
- *... and 27 more nodes in this community*

## Relationships

- [Historical Bar Fetching](Historical_Bar_Fetching.md) (7 shared connections)
- [Chart Marks Route](Chart_Marks_Route.md) (7 shared connections)
- [Broker Connection Status](Broker_Connection_Status.md) (3 shared connections)
- [Market Data Manager](Market_Data_Manager.md) (3 shared connections)
- [Paper Trading Views](Paper_Trading_Views.md) (2 shared connections)
- [Cache Management Routes](Cache_Management_Routes.md) (2 shared connections)
- [UDF Configuration Routes](UDF_Configuration_Routes.md) (1 shared connections)
- [Demo Seed Data](Demo_Seed_Data.md) (1 shared connections)
- [Symbol Mapping Utilities](Symbol_Mapping_Utilities.md) (1 shared connections)

## Source Files

- `__tests__/api/udf-history.test.ts`
- `__tests__/market/udf-history-cache.test.ts`
- `__tests__/market/udf-history-live-bar.test.ts`
- `__tests__/market/udf-history-preconditions.test.ts`
- `app/api/market/udf/history/route-logic.ts`
- `app/api/market/udf/history/route.ts`
- `lib/market/corporate-action-adjust.ts`
- `lib/market/historical-fetcher.ts`
- `lib/market/udf-history-cache-logic.ts`
- `lib/market/udf-history-cache.ts`

## Audit Trail

- EXTRACTED: 131 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*