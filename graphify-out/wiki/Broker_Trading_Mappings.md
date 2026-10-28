# Broker Trading Mappings

> 60 nodes

## Key Concepts

- **ZerodhaClient** (28 connections) — `packages/core/src/brokers/clients/zerodha.ts`
- **broker-mappings.ts** (16 connections) — `packages/core/src/brokers/clients/broker-mappings.ts`
- **.normalizeBackofficeTrade()** (7 connections) — `packages/core/src/brokers/clients/zerodha.ts`
- **.normalizePosition()** (7 connections) — `packages/core/src/brokers/clients/zerodha.ts`
- **parseKiteTimestamp()** (6 connections) — `packages/core/src/brokers/clients/kite-time.ts`
- **.getHistoricalTrades()** (6 connections) — `packages/core/src/brokers/clients/zerodha.ts`
- **.getOrders()** (6 connections) — `packages/core/src/brokers/clients/zerodha.ts`
- **.getTrades()** (6 connections) — `packages/core/src/brokers/clients/zerodha.ts`
- **zerodha-cd-segment-skip.test.ts** (6 connections) — `packages/core/__tests__/brokers/zerodha-cd-segment-skip.test.ts`
- **zerodha-historical-trades.test.ts** (6 connections) — `packages/core/__tests__/brokers/zerodha-historical-trades.test.ts`
- **.getSegmentFromExchange()** (5 connections) — `packages/core/src/brokers/clients/zerodha.ts`
- **zerodha-holdings-schema.ts** (5 connections) — `packages/core/src/brokers/clients/zerodha-holdings-schema.ts`
- **normalizeSide()** (4 connections) — `packages/core/src/brokers/clients/kite-normalize.ts`
- **toFiniteNumber()** (4 connections) — `packages/core/src/brokers/clients/kite-normalize.ts`
- **kite-time.ts** (4 connections) — `packages/core/src/brokers/clients/kite-time.ts`
- **getPositionTypeLabel()** (3 connections) — `packages/core/src/brokers/clients/broker-mappings.ts`
- **getProductTypeLabel()** (3 connections) — `packages/core/src/brokers/clients/broker-mappings.ts`
- **getSegmentLabel()** (3 connections) — `packages/core/src/brokers/clients/broker-mappings.ts`
- **validateZerodhaHoldingShape()** (3 connections) — `packages/core/src/brokers/clients/zerodha-holdings-schema.ts`
- **.fetchBackofficeTradebookPage()** (3 connections) — `packages/core/src/brokers/clients/zerodha.ts`
- **.getHoldings()** (3 connections) — `packages/core/src/brokers/clients/zerodha.ts`
- **.getPositions()** (3 connections) — `packages/core/src/brokers/clients/zerodha.ts`
- **kite-normalize.ts** (3 connections) — `packages/core/src/brokers/clients/kite-normalize.ts`
- **hasExplicitZone()** (2 connections) — `packages/core/src/brokers/clients/kite-time.ts`
- **isBenignSegmentError()** (2 connections) — `packages/core/src/brokers/clients/zerodha.ts`
- *... and 35 more nodes in this community*

## Relationships

- [Angel One Client](Angel_One_Client.md) (35 shared connections)
- [Broker Portfolio Data Normalizers](Broker_Portfolio_Data_Normalizers.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/brokers/zerodha-cd-segment-skip.test.ts`
- `packages/core/__tests__/brokers/zerodha-historical-trades.test.ts`
- `packages/core/src/brokers/clients/broker-mappings.ts`
- `packages/core/src/brokers/clients/kite-normalize.ts`
- `packages/core/src/brokers/clients/kite-time.ts`
- `packages/core/src/brokers/clients/zerodha-holdings-schema.ts`
- `packages/core/src/brokers/clients/zerodha.ts`

## Audit Trail

- EXTRACTED: 112 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*