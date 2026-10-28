# Intraday WebSocket Hub

> 27 nodes

## Key Concepts

- **intraday-hub.ts** (22 connections) — `workers/src/connect/intraday-hub.ts`
- **TickAggregator** (11 connections) — `workers/src/connect/tick-aggregator.ts`
- **tick-aggregator.ts** (8 connections) — `workers/src/connect/tick-aggregator.ts`
- **subscribe()** (7 connections) — `workers/src/connect/intraday-hub.ts`
- **Bar** (5 connections) — `workers/src/connect/tick-aggregator.ts`
- **tick-aggregator.test.ts** (5 connections) — `workers/__tests__/connect/tick-aggregator.test.ts`
- **ensureWsConnected()** (4 connections) — `workers/src/connect/intraday-hub.ts`
- **getIntervalSeconds()** (3 connections) — `workers/src/connect/tick-aggregator.ts`
- **snapToBarStart()** (3 connections) — `workers/src/connect/tick-aggregator.ts`
- **.ingest()** (3 connections) — `workers/src/connect/tick-aggregator.ts`
- **AggregatorEntry** (2 connections) — `workers/src/connect/intraday-hub.ts`
- **IntradaySubscription** (2 connections) — `workers/src/connect/intraday-hub.ts`
- **SubscribeResult** (2 connections) — `workers/src/connect/intraday-hub.ts`
- **aggregatorKey()** (2 connections) — `workers/src/connect/intraday-hub.ts`
- **resolveInstrumentToken()** (2 connections) — `workers/src/connect/intraday-hub.ts`
- **routeTick()** (2 connections) — `workers/src/connect/intraday-hub.ts`
- **scheduleWsShutdown()** (2 connections) — `workers/src/connect/intraday-hub.ts`
- **.constructor()** (2 connections) — `workers/src/connect/tick-aggregator.ts`
- **.emit()** (2 connections) — `workers/src/connect/tick-aggregator.ts`
- **TokenEntry** (1 connections) — `workers/src/connect/intraday-hub.ts`
- **BarUpdateListener** (1 connections) — `workers/src/connect/tick-aggregator.ts`
- **.destroy()** (1 connections) — `workers/src/connect/tick-aggregator.ts`
- **.getCurrentBar()** (1 connections) — `workers/src/connect/tick-aggregator.ts`
- **.onBarUpdate()** (1 connections) — `workers/src/connect/tick-aggregator.ts`
- **state** (1 connections) — `workers/src/connect/intraday-hub.ts`
- *... and 2 more nodes in this community*

## Relationships

- [Zerodha WebSocket Client](Zerodha_WebSocket_Client.md) (4 shared connections)
- [Broker WebSocket Architecture](Broker_WebSocket_Architecture.md) (2 shared connections)
- [Base Broker WebSocket Implementation](Base_Broker_WebSocket_Implementation.md) (1 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `workers/__tests__/connect/tick-aggregator.test.ts`
- `workers/src/connect/intraday-hub.ts`
- `workers/src/connect/tick-aggregator.ts`

## Audit Trail

- EXTRACTED: 53 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*