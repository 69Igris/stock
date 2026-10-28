# Broker WebSocket Architecture

> 17 nodes

## Key Concepts

- **zerodha-ws.ts** (14 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **base-ws.ts** (12 connections) — `workers/src/connect/ws/base-ws.ts`
- **ws** (5 connections) — `workers/package.json`
- **MarketDepth** (3 connections) — `workers/src/connect/ws/base-ws.ts`
- **WebSocketConfig** (3 connections) — `workers/src/connect/ws/base-ws.ts`
- **.parseMarketDepth()** (3 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **DepthLevel** (2 connections) — `workers/src/connect/ws/base-ws.ts`
- **.constructor()** (2 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **ConnectionCallback** (1 connections) — `workers/src/connect/ws/base-ws.ts`
- **ConnectionState** (1 connections) — `workers/src/connect/ws/base-ws.ts`
- **ErrorCallback** (1 connections) — `workers/src/connect/ws/base-ws.ts`
- **TickCallback** (1 connections) — `workers/src/connect/ws/base-ws.ts`
- **ZerodhaCredentials** (1 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **ZerodhaMode** (1 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **ZerodhaTick** (1 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **symbolToToken** (1 connections) — `workers/src/connect/ws/zerodha-ws.ts`
- **tokenToSymbol** (1 connections) — `workers/src/connect/ws/zerodha-ws.ts`

## Relationships

- [Zerodha WebSocket Client](Zerodha_WebSocket_Client.md) (6 shared connections)
- [Intraday WebSocket Hub](Intraday_WebSocket_Hub.md) (2 shared connections)
- [Base Broker WebSocket Implementation](Base_Broker_WebSocket_Implementation.md) (2 shared connections)
- [Worker Package Dependencies](Worker_Package_Dependencies.md) (1 shared connections)
- [Realtime Market Data Capture](Realtime_Market_Data_Capture.md) (1 shared connections)
- [Tiingo Realtime WebSocket Client](Tiingo_Realtime_WebSocket_Client.md) (1 shared connections)

## Source Files

- `workers/package.json`
- `workers/src/connect/ws/base-ws.ts`
- `workers/src/connect/ws/zerodha-ws.ts`

## Audit Trail

- EXTRACTED: 33 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*