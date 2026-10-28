# Stock Quote Caching Logic

> 29 nodes

## Key Concepts

- **quote-service.ts** (25 connections) — `packages/core/src/market-data/prices/quote-service.ts`
- **quote-logic.ts** (18 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- **refreshAllQuotes()** (10 connections) — `packages/core/src/market-data/prices/quote-service.ts`
- **getLatestQuotes()** (6 connections) — `packages/core/src/market-data/prices/quote-service.ts`
- **seed-prices.ts** (6 connections) — `scripts/seed/seed-prices.ts`
- **YahooQuoteData** (5 connections) — `packages/core/src/market-data/prices/quote-service.ts`
- **queryByIdChunks()** (5 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- **runWithWriteConflictRetry()** (5 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- **calcBackoff()** (4 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- **chunkIds()** (4 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- **isFresh()** (4 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- **isWriteConflictError()** (4 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- **shouldFetchFromApi()** (4 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- **getLatestQuote()** (3 connections) — `packages/core/src/market-data/prices/quote-service.ts`
- **fetchYahooBatchQuotes()** (3 connections) — `scripts/seed/seed-prices.ts`
- **main()** (3 connections) — `scripts/seed/seed-prices.ts`
- **QuoteData** (2 connections) — `packages/core/src/market-data/prices/quote-service.ts`
- **YahooBatchQuoteFetcher** (2 connections) — `packages/core/src/market-data/prices/quote-service.ts`
- **YahooQuoteFetcher** (2 connections) — `packages/core/src/market-data/prices/quote-service.ts`
- **REFRESH_BACKOFF_BASE_MS** (2 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- **REFRESH_MAX_RETRIES** (2 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- **UPSERT_BACKOFF_BASE_MS** (2 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- **UPSERT_BATCH_SIZE** (2 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- **UPSERT_MAX_RETRIES** (2 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- **WriteConflictRetryOptions** (1 connections) — `packages/core/src/market-data/prices/quote-logic.ts`
- *... and 4 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (9 shared connections)
- [Price Synchronization Processor](Price_Synchronization_Processor.md) (4 shared connections)
- [Intraday Bar Data Synchronization](Intraday_Bar_Data_Synchronization.md) (2 shared connections)
- [Yahoo Finance Market Data](Yahoo_Finance_Market_Data.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Instrument Synchronization Sweeps](Instrument_Synchronization_Sweeps.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/prices/quote-logic.ts`
- `packages/core/src/market-data/prices/quote-service.ts`
- `scripts/seed/seed-prices.ts`

## Audit Trail

- EXTRACTED: 74 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*