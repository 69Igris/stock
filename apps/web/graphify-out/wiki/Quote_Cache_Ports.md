# Quote Cache Ports

> 39 nodes

## Key Concepts

- **quote-cache.ts** (33 connections) — `lib/market/quote-cache.ts`
- **quote-cache-logic.ts** (19 connections) — `lib/market/quote-cache-logic.ts`
- **quote-cache-logic.test.ts** (17 connections) — `__tests__/market/quote-cache-logic.test.ts`
- **resolveQuotesCached()** (14 connections) — `lib/market/quote-cache-logic.ts`
- **QuoteCachePorts** (10 connections) — `lib/market/quote-cache-logic.ts`
- **buildQuoteCachePorts()** (9 connections) — `lib/market/quote-cache.ts`
- **fetchUsQuotesUncached()** (6 connections) — `lib/market/quote-cache.ts`
- **toEpochMs()** (6 connections) — `lib/market/quote-cache-logic.ts`
- **withBudget()** (6 connections) — `lib/market/quote-cache-logic.ts`
- **fetchQuotesCached()** (5 connections) — `lib/market/quote-cache.ts`
- **quoteCacheIdentifier()** (5 connections) — `lib/market/quote-cache-logic.ts`
- **CachedQuoteEnvelope** (4 connections) — `lib/market/quote-cache-logic.ts`
- **partitionBySymbolCache()** (4 connections) — `lib/market/quote-cache-logic.ts`
- **QUOTE_REQUEST_BUDGET_MS** (4 connections) — `lib/market/quote-cache-logic.ts`
- **dedupeSymbols()** (3 connections) — `lib/market/quote-cache-logic.ts`
- **isEnvelopeFresh()** (3 connections) — `lib/market/quote-cache-logic.ts`
- **.responseKey()** (3 connections) — `lib/market/quote-cache-logic.ts`
- **readLatestQuoteRows()** (3 connections) — `lib/market/quote-cache.ts`
- **readSharedCache()** (3 connections) — `lib/market/quote-cache.ts`
- **readUpstreamQuotes()** (3 connections) — `lib/market/quote-cache.ts`
- **writeSharedCache()** (3 connections) — `lib/market/quote-cache.ts`
- **makePorts()** (3 connections) — `__tests__/market/quote-cache-logic.test.ts`
- **QUOTE_CACHE_TTL_MS** (3 connections) — `lib/market/quote-cache-logic.ts`
- **QuoteSource** (2 connections) — `lib/market/providers/quote-providers.ts`
- **QuoteCacheResult** (2 connections) — `lib/market/quote-cache-logic.ts`
- *... and 14 more nodes in this community*

## Relationships

- [Federated Quote Providers](Federated_Quote_Providers.md) (8 shared connections)
- [Market Quote Parser](Market_Quote_Parser.md) (8 shared connections)
- [Market Data Manager](Market_Data_Manager.md) (7 shared connections)
- [Symbol Mapping Utilities](Symbol_Mapping_Utilities.md) (3 shared connections)
- [Market Stream SSE Route](Market_Stream_SSE_Route.md) (3 shared connections)

## Source Files

- `__tests__/market/quote-cache-logic.test.ts`
- `lib/market/providers/quote-providers.ts`
- `lib/market/quote-cache-logic.ts`
- `lib/market/quote-cache.ts`

## Audit Trail

- EXTRACTED: 113 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*