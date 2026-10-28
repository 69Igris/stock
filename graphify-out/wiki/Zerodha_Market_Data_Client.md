# Zerodha Market Data Client

> 22 nodes

## Key Concepts

- **zerodha-client.ts** (16 connections) — `workers/src/connect/zerodha-client.ts`
- **zerodha-client.test.ts** (8 connections) — `workers/__tests__/connect/zerodha-client.test.ts`
- **getHeaders()** (4 connections) — `workers/src/connect/zerodha-client.ts`
- **getZerodhaHistorical()** (3 connections) — `workers/src/connect/zerodha-client.ts`
- **connect/types.ts** (3 connections) — `workers/src/connect/types.ts`
- **HistoricalBar** (2 connections) — `workers/src/connect/types.ts`
- **QuoteData** (2 connections) — `workers/src/connect/types.ts`
- **formatDate()** (2 connections) — `workers/src/connect/zerodha-client.ts`
- **getZerodhaQuote()** (2 connections) — `workers/src/connect/zerodha-client.ts`
- **getZerodhaQuotes()** (2 connections) — `workers/src/connect/zerodha-client.ts`
- **isZerodhaInterval()** (2 connections) — `workers/src/connect/zerodha-client.ts`
- **ZERODHA_INTERVAL_MAP** (2 connections) — `workers/src/connect/zerodha-client.ts`
- **ZerodhaCredentials** (1 connections) — `workers/src/connect/zerodha-client.ts`
- **ZerodhaHistoricalResponse** (1 connections) — `workers/src/connect/zerodha-client.ts`
- **ZerodhaQuoteResponse** (1 connections) — `workers/src/connect/zerodha-client.ts`
- **calcChangePercent()** (1 connections) — `workers/__tests__/connect/zerodha-client.test.ts`
- **clampFromDate()** (1 connections) — `workers/__tests__/connect/zerodha-client.test.ts`
- **formatDate()** (1 connections) — `workers/__tests__/connect/zerodha-client.test.ts`
- **transformCandles()** (1 connections) — `workers/__tests__/connect/zerodha-client.test.ts`
- **ZERODHA_MAX_DAYS** (1 connections) — `workers/src/connect/zerodha-client.ts`
- **ZERODHA_MAX_DAYS** (1 connections) — `workers/__tests__/connect/zerodha-client.test.ts`
- **NOTE: Intraday window normalization (snapping from/to to whole-day** (1 connections) — `workers/src/connect/zerodha-client.ts`

## Relationships

- No strong cross-community connections detected

## Source Files

- `workers/__tests__/connect/zerodha-client.test.ts`
- `workers/src/connect/types.ts`
- `workers/src/connect/zerodha-client.ts`

## Audit Trail

- EXTRACTED: 29 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*