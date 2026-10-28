# Market Data Manager

> 48 nodes

## Key Concepts

- **yahoo-client.ts** (34 connections) — `lib/market/yahoo-client.ts`
- **Exchange** (17 connections) — `lib/market/symbol-mapper.ts`
- **MarketDataManager** (16 connections) — `lib/market/data-manager.ts`
- **data-manager.ts** (16 connections) — `lib/market/data-manager.ts`
- **yahoo-client-logic.ts** (15 connections) — `lib/market/yahoo-client-logic.ts`
- **getQuotes()** (11 connections) — `lib/market/yahoo-client.ts`
- **extractSymbol()** (10 connections) — `lib/market/yahoo-client-logic.ts`
- **rawQuoteToQuoteData()** (9 connections) — `lib/market/yahoo-client-logic.ts`
- **yahoo-client-helpers.test.ts** (9 connections) — `__tests__/market/yahoo-client-helpers.test.ts`
- **Period** (8 connections) — `lib/market/yahoo-client-logic.ts`
- **.fetchQuotes()** (7 connections) — `lib/market/data-manager.ts`
- **getQuotesByInstrumentIds()** (7 connections) — `lib/market/yahoo-client.ts`
- **yahoo-client.test.ts** (7 connections) — `__tests__/market/yahoo-client.test.ts`
- **.fetchQuote()** (6 connections) — `lib/market/data-manager.ts`
- **getQuote()** (6 connections) — `lib/market/yahoo-client.ts`
- **getPeriodStartDate()** (6 connections) — `lib/market/yahoo-client-logic.ts`
- **.pollQuotes()** (5 connections) — `lib/market/data-manager.ts`
- **.subscribe()** (5 connections) — `lib/market/data-manager.ts`
- **getQuoteByInstrumentId()** (5 connections) — `lib/market/yahoo-client.ts`
- **mapExchange()** (5 connections) — `lib/market/yahoo-client-logic.ts`
- **searchSymbols()** (5 connections) — `lib/market/yahoo-client.ts`
- **extractExchange()** (4 connections) — `lib/market/yahoo-client-logic.ts`
- **yahooBatchQuoteFetcher()** (4 connections) — `lib/market/yahoo-client.ts`
- **MarketDataSubscription** (3 connections) — `lib/market/data-manager.ts`
- **FetchHistoricalOptions** (3 connections) — `lib/market/historical-fetcher.ts`
- *... and 23 more nodes in this community*

## Relationships

- [Federated Quote Providers](Federated_Quote_Providers.md) (17 shared connections)
- [Historical Bar Fetching](Historical_Bar_Fetching.md) (10 shared connections)
- [Quote Cache Ports](Quote_Cache_Ports.md) (7 shared connections)
- [Symbol Mapping Utilities](Symbol_Mapping_Utilities.md) (6 shared connections)
- [Strategy Backtesting Engine](Strategy_Backtesting_Engine.md) (4 shared connections)
- [Historical Bar Routes](Historical_Bar_Routes.md) (3 shared connections)
- [Index Quotes Logic](Index_Quotes_Logic.md) (3 shared connections)
- [Market Search API](Market_Search_API.md) (3 shared connections)
- [Market Stream SSE Route](Market_Stream_SSE_Route.md) (2 shared connections)
- [Market Quote Parser](Market_Quote_Parser.md) (1 shared connections)
- [UDF Instrument Search](UDF_Instrument_Search.md) (1 shared connections)
- [Symbol Resolution Route](Symbol_Resolution_Route.md) (1 shared connections)

## Source Files

- `__tests__/market/yahoo-client-helpers.test.ts`
- `__tests__/market/yahoo-client.test.ts`
- `lib/market/data-manager.ts`
- `lib/market/historical-fetcher.ts`
- `lib/market/index.ts`
- `lib/market/symbol-mapper.ts`
- `lib/market/yahoo-client-logic.ts`
- `lib/market/yahoo-client.ts`

## Audit Trail

- EXTRACTED: 160 (99%)
- INFERRED: 2 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*