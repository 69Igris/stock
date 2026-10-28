# Zerodha WebSocket Client

> 20 nodes

## Key Concepts

- **ZerodhaWebSocket** (24 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **Tick** (5 connections) — `workers/src/connect/ws/base-ws.ts`
- **.parseBinaryMessage()** (5 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.parsePacket()** (4 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.setModeForTokens()** (4 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.connect()** (3 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.handleMessage()** (3 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.sendSubscribe()** (3 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.sendUnsubscribe()** (3 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.subscribe()** (3 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.subscribeTokens()** (3 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **HubState** (2 connections) — `workers/src/connect/intraday-hub.ts`
- **.getPacketSize()** (2 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.reconnect()** (2 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.setMode()** (2 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.unsubscribe()** (2 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.unsubscribeTokens()** (2 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.sendHeartbeat()** (1 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.setInstrumentMapping()** (1 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **.setInstrumentMappings()** (1 connections) — `workers/src/connect/ws/zerodha-ws.ts`

## Relationships

- [Broker WebSocket Architecture](Broker_WebSocket_Architecture.md) (6 shared connections)
- [Intraday WebSocket Hub](Intraday_WebSocket_Hub.md) (4 shared connections)
- [Base Broker WebSocket Implementation](Base_Broker_WebSocket_Implementation.md) (1 shared connections)

## Source Files

- `workers/src/connect/intraday-hub.ts`
- `workers/src/connect/ws/base-ws.ts`
- `workers/src/connect/ws/zerodha-ws.ts`

## Audit Trail

- EXTRACTED: 43 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*