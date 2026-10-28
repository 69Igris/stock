# Base Broker WebSocket Implementation

> 19 nodes

## Key Concepts

- **BaseBrokerWebSocket** (21 connections) — `workers/src/connect/ws/base-ws.ts`
- **.scheduleReconnect()** (4 connections) — `workers/src/connect/ws/base-ws.ts`
- **.setState()** (4 connections) — `workers/src/connect/ws/base-ws.ts`
- **.stopHeartbeat()** (4 connections) — `workers/src/connect/ws/base-ws.ts`
- **.cleanup()** (3 connections) — `workers/src/connect/ws/base-ws.ts`
- **.disconnect()** (3 connections) — `workers/src/connect/ws/base-ws.ts`
- **.emitError()** (3 connections) — `workers/src/connect/ws/base-ws.ts`
- **.handleClose()** (3 connections) — `workers/src/connect/ws/base-ws.ts`
- **.handleOpen()** (3 connections) — `workers/src/connect/ws/base-ws.ts`
- **.startHeartbeat()** (3 connections) — `workers/src/connect/ws/base-ws.ts`
- **.handleError()** (2 connections) — `workers/src/connect/ws/base-ws.ts`
- **.onError()** (2 connections) — `workers/src/connect/ws/base-ws.ts`
- **.constructor()** (1 connections) — `workers/src/connect/ws/base-ws.ts`
- **.emitTicks()** (1 connections) — `workers/src/connect/ws/base-ws.ts`
- **.getState()** (1 connections) — `workers/src/connect/ws/base-ws.ts`
- **.getSubscriptions()** (1 connections) — `workers/src/connect/ws/base-ws.ts`
- **.isConnected()** (1 connections) — `workers/src/connect/ws/base-ws.ts`
- **.onConnectionChange()** (1 connections) — `workers/src/connect/ws/base-ws.ts`
- **.onTick()** (1 connections) — `workers/src/connect/ws/base-ws.ts`

## Relationships

- [Broker WebSocket Architecture](Broker_WebSocket_Architecture.md) (2 shared connections)
- [Zerodha WebSocket Client](Zerodha_WebSocket_Client.md) (1 shared connections)
- [Intraday WebSocket Hub](Intraday_WebSocket_Hub.md) (1 shared connections)

## Source Files

- `workers/src/connect/ws/base-ws.ts`

## Audit Trail

- EXTRACTED: 33 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*