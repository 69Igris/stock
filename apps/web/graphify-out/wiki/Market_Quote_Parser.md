# Market Quote Parser

> 33 nodes

## Key Concepts

- **quote/route.ts** (30 connections) — `app/api/market/quote/route.ts`
- **quote-logic.ts** (20 connections) — `app/api/market/quote/quote-logic.ts`
- **stock/[symbol]/page.tsx** (18 connections) — `app/stock/[symbol]/page.tsx`
- **GET()** (12 connections) — `app/api/market/quote/route.ts`
- **market-quote.test.ts** (10 connections) — `__tests__/api/market-quote.test.ts`
- **currentUserMaySeeUsMarket()** (7 connections) — `lib/market/us-access.ts`
- **us-access.ts** (7 connections) — `lib/market/us-access.ts`
- **fetchForExchange()** (6 connections) — `app/api/market/quote/route.ts`
- **formatMultiQuoteResponse()** (5 connections) — `app/api/market/quote/quote-logic.ts`
- **formatSingleQuoteResponse()** (5 connections) — `app/api/market/quote/quote-logic.ts`
- **StockPage()** (5 connections) — `app/stock/[symbol]/page.tsx`
- **parseSymbolList()** (4 connections) — `app/api/market/quote/quote-logic.ts`
- **validateSymbolListNotEmpty()** (4 connections) — `app/api/market/quote/quote-logic.ts`
- **validateSymbolListSize()** (4 connections) — `app/api/market/quote/quote-logic.ts`
- **validateSymbolParams()** (4 connections) — `app/api/market/quote/quote-logic.ts`
- **noteUsSymbolInterest()** (4 connections) — `lib/market/us-interest.ts`
- **withMeta()** (3 connections) — `app/api/market/quote/quote-logic.ts`
- **QuoteResponseMeta** (2 connections) — `app/api/market/quote/quote-logic.ts`
- **QuoteResponseSource** (2 connections) — `app/api/market/quote/quote-logic.ts`
- **CachedQuotesResult** (2 connections) — `lib/market/quote-cache.ts`
- **determineSource()** (2 connections) — `app/api/market/quote/quote-logic.ts`
- **findMissingSymbols()** (2 connections) — `app/api/market/quote/quote-logic.ts`
- **resolveExchange()** (2 connections) — `app/api/market/quote/quote-logic.ts`
- **buildMeta()** (2 connections) — `app/api/market/quote/route.ts`
- **resolveEmail()** (2 connections) — `lib/market/us-access.ts`
- *... and 8 more nodes in this community*

## Relationships

- [Quote Cache Ports](Quote_Cache_Ports.md) (8 shared connections)
- [Federated Quote Providers](Federated_Quote_Providers.md) (7 shared connections)
- [Market Stream SSE Route](Market_Stream_SSE_Route.md) (4 shared connections)
- [Broker Connection Status](Broker_Connection_Status.md) (3 shared connections)
- [Feature App Layouts](Feature_App_Layouts.md) (3 shared connections)
- [Holdings Management Views](Holdings_Management_Views.md) (3 shared connections)
- [Paper Trading Views](Paper_Trading_Views.md) (2 shared connections)
- [ETF and Terminal Pages](ETF_and_Terminal_Pages.md) (2 shared connections)
- [US Stock Market Data](US_Stock_Market_Data.md) (2 shared connections)
- [Market Data Manager](Market_Data_Manager.md) (1 shared connections)
- [Symbol Mapping Utilities](Symbol_Mapping_Utilities.md) (1 shared connections)
- [TradingView Advanced Chart](TradingView_Advanced_Chart.md) (1 shared connections)

## Source Files

- `__tests__/api/market-quote.test.ts`
- `app/api/market/quote/quote-logic.ts`
- `app/api/market/quote/route.ts`
- `app/stock/[symbol]/page.tsx`
- `lib/market/quote-cache.ts`
- `lib/market/us-access.ts`
- `lib/market/us-interest.ts`

## Audit Trail

- EXTRACTED: 107 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*