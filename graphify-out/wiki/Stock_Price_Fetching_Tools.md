# Stock Price Fetching Tools

> 20 nodes

## Key Concepts

- **fetch-stock-price.ts** (26 connections) — `packages/research/src/tools/fetch-stock-price.ts`
- **fetch-stock-price.test.ts** (15 connections) — `packages/research/__tests__/fetch-stock-price.test.ts`
- **assemblePrices()** (4 connections) — `packages/research/src/tools/fetch-stock-price.ts`
- **needsSearchQuote()** (4 connections) — `packages/research/src/tools/fetch-stock-price.ts`
- **fetchStockPriceTool** (4 connections) — `packages/research/src/tools/fetch-stock-price.ts`
- **YahooFetchErrorOpts** (3 connections) — `packages/core/src/market-data/yahoo-api.ts`
- **fetchDbPriceFallback()** (3 connections) — `packages/research/src/tools/fetch-stock-price.ts`
- **isPositiveFinite()** (3 connections) — `packages/research/src/tools/fetch-stock-price.ts`
- **resolvePriceDb()** (3 connections) — `packages/research/src/tools/fetch-stock-price.ts`
- **PriceFallbackDb** (2 connections) — `packages/research/src/tools/fetch-stock-price.ts`
- **fetchLivePrices()** (2 connections) — `packages/research/src/tools/fetch-stock-price.ts`
- **SEARCH_TIER_MAX_DB_AGE_MS** (2 connections) — `packages/research/src/tools/fetch-stock-price.ts`
- **BatchQuotesFetcher** (1 connections) — `packages/research/src/tools/fetch-stock-price.ts`
- **QuoteChainFetcher** (1 connections) — `packages/research/src/tools/fetch-stock-price.ts`
- **SearchQuoteFetcher** (1 connections) — `packages/research/src/tools/fetch-stock-price.ts`
- **FakeDbOpts** (1 connections) — `packages/research/__tests__/fetch-stock-price.test.ts`
- **fakeDb()** (1 connections) — `packages/research/__tests__/fetch-stock-price.test.ts`
- **yq()** (1 connections) — `packages/research/__tests__/fetch-stock-price.test.ts`
- **TODAY** (1 connections) — `packages/research/__tests__/fetch-stock-price.test.ts`
- **YESTERDAY** (1 connections) — `packages/research/__tests__/fetch-stock-price.test.ts`

## Relationships

- [NSE Research Tools](NSE_Research_Tools.md) (7 shared connections)
- [Yahoo Finance Market Data](Yahoo_Finance_Market_Data.md) (4 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (3 shared connections)
- [Financial Data Source Fallbacks](Financial_Data_Source_Fallbacks.md) (2 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Database Script Safety Tests](Database_Script_Safety_Tests.md) (1 shared connections)
- [Gemini Search Quote Integration](Gemini_Search_Quote_Integration.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/yahoo-api.ts`
- `packages/research/__tests__/fetch-stock-price.test.ts`
- `packages/research/src/tools/fetch-stock-price.ts`

## Audit Trail

- EXTRACTED: 49 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*