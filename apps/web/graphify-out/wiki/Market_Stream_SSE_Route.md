# Market Stream SSE Route

> 21 nodes

## Key Concepts

- **market/stream/route.ts** (26 connections) — `app/api/market/stream/route.ts`
- **stream-logic.ts** (15 connections) — `app/api/market/stream/stream-logic.ts`
- **market-stream.test.ts** (10 connections) — `__tests__/api/market-stream.test.ts`
- **market-stream-us.test.ts** (9 connections) — `__tests__/api/market-stream-us.test.ts`
- **resolveQuoteExchange()** (7 connections) — `lib/market/quote-exchange.ts`
- **parseExchange()** (6 connections) — `app/api/market/stream/stream-logic.ts`
- **GET()** (5 connections) — `app/api/market/stream/route.ts`
- **checkConnectionLimit()** (4 connections) — `app/api/market/stream/stream-logic.ts`
- **formatConnectMessage()** (4 connections) — `app/api/market/stream/stream-logic.ts`
- **incrementConnection()** (4 connections) — `app/api/market/stream/stream-logic.ts`
- **parseSymbols()** (4 connections) — `app/api/market/stream/stream-logic.ts`
- **POLL_INTERVAL** (4 connections) — `app/api/market/stream/stream-logic.ts`
- **decrementConnection()** (3 connections) — `app/api/market/stream/stream-logic.ts`
- **formatErrorMessage()** (3 connections) — `app/api/market/stream/stream-logic.ts`
- **MAX_CONNECTIONS_PER_USER** (2 connections) — `app/api/market/stream/stream-logic.ts`
- **routeBody()** (1 connections) — `__tests__/api/market-stream-us.test.ts`
- **activeConnections** (1 connections) — `app/api/market/stream/route.ts`
- **dynamic** (1 connections) — `app/api/market/stream/route.ts`
- **runtime** (1 connections) — `app/api/market/stream/route.ts`
- **ROUTE** (1 connections) — `__tests__/api/market-stream-us.test.ts`
- **routeSrc** (1 connections) — `__tests__/api/market-stream-us.test.ts`

## Relationships

- [Federated Quote Providers](Federated_Quote_Providers.md) (9 shared connections)
- [Market Quote Parser](Market_Quote_Parser.md) (4 shared connections)
- [Quote Cache Ports](Quote_Cache_Ports.md) (3 shared connections)
- [Market Data Manager](Market_Data_Manager.md) (2 shared connections)
- [Symbol Mapping Utilities](Symbol_Mapping_Utilities.md) (2 shared connections)

## Source Files

- `__tests__/api/market-stream-us.test.ts`
- `__tests__/api/market-stream.test.ts`
- `app/api/market/stream/route.ts`
- `app/api/market/stream/stream-logic.ts`
- `lib/market/quote-exchange.ts`

## Audit Trail

- EXTRACTED: 66 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*