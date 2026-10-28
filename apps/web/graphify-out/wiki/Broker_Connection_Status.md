# Broker Connection Status

> 34 nodes

## Key Concepts

- **broker-status.ts** (16 connections) — `lib/actions/broker-status.ts`
- **broker-status-cache.test.ts** (16 connections) — `__tests__/actions/broker-status-cache.test.ts`
- **resolveBrokerMarketDataStatus()** (14 connections) — `lib/actions/broker-status-logic.ts`
- **broker-status-logic.ts** (14 connections) — `lib/actions/broker-status-logic.ts`
- **BrokerStatusPorts** (11 connections) — `lib/actions/broker-status-logic.ts`
- **getBrokerMarketDataStatus()** (11 connections) — `lib/actions/broker-status.ts`
- **BrokerConnectionSnapshot** (5 connections) — `lib/actions/broker-status-logic.ts`
- **deriveBrokerMarketDataStatus()** (4 connections) — `lib/actions/broker-status-logic.ts`
- **broker-status/route.ts** (4 connections) — `app/api/market/broker-status/route.ts`
- **snapshotExpiryMs()** (3 connections) — `lib/actions/broker-status-logic.ts`
- **toConnectionSnapshots()** (3 connections) — `lib/actions/broker-status-logic.ts`
- **BROKER_CONNECTIONS_CACHE_IDENTIFIER** (3 connections) — `lib/actions/broker-status-logic.ts`
- **BROKER_STATUS_CACHE_TTL_SECONDS** (3 connections) — `lib/actions/broker-status-logic.ts`
- **BROKER_USER_CACHE_IDENTIFIER** (3 connections) — `lib/actions/broker-status-logic.ts`
- **BrokerMarketDataStatus** (2 connections) — `lib/actions/broker-status-logic.ts`
- **PortOverrides** (2 connections) — `__tests__/actions/broker-status-cache.test.ts`
- **Recorder** (2 connections) — `__tests__/actions/broker-status-cache.test.ts`
- **GET()** (2 connections) — `app/api/market/broker-status/route.ts`
- **buildPorts()** (2 connections) — `lib/actions/broker-status.ts`
- **.findConnections()** (2 connections) — `lib/actions/broker-status-logic.ts`
- **.findUserId()** (2 connections) — `lib/actions/broker-status-logic.ts`
- **.now()** (2 connections) — `lib/actions/broker-status-logic.ts`
- **.readConnectionsCache()** (2 connections) — `lib/actions/broker-status-logic.ts`
- **.readUserIdCache()** (2 connections) — `lib/actions/broker-status-logic.ts`
- **.reauthUrl()** (2 connections) — `lib/actions/broker-status-logic.ts`
- *... and 9 more nodes in this community*

## Relationships

- [Market Quote Parser](Market_Quote_Parser.md) (3 shared connections)
- [Historical Bar Routes](Historical_Bar_Routes.md) (3 shared connections)
- [Historical Bar Fetching](Historical_Bar_Fetching.md) (3 shared connections)
- [Auth & Integration Routes](Auth_&_Integration_Routes.md) (1 shared connections)

## Source Files

- `__tests__/actions/broker-status-cache.test.ts`
- `app/api/market/broker-status/route.ts`
- `lib/actions/broker-status-logic.ts`
- `lib/actions/broker-status.ts`

## Audit Trail

- EXTRACTED: 77 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*