# Tiingo WebSocket Client

> 12 nodes

## Key Concepts

- **TiingoSocket** (17 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.connect()** (6 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.send()** (5 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.armWatchdog()** (4 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.teardown()** (4 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.applyDelta()** (3 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.isConnected()** (3 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.msSinceLastMessage()** (2 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.close()** (1 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.constructor()** (1 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.subscribedCount()** (1 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.subscribedSymbols()** (1 connections) — `workers/src/realtime/tiingo-socket.ts`

## Relationships

- [Tiingo Realtime WebSocket Client](Tiingo_Realtime_WebSocket_Client.md) (6 shared connections)
- [Tiingo Minute Bar Aggregation](Tiingo_Minute_Bar_Aggregation.md) (2 shared connections)
- [Tiingo Realtime Subscription Planning](Tiingo_Realtime_Subscription_Planning.md) (1 shared connections)
- [Tiingo Realtime Price Parsing](Tiingo_Realtime_Price_Parsing.md) (1 shared connections)

## Source Files

- `workers/src/realtime/tiingo-socket.ts`

## Audit Trail

- EXTRACTED: 29 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*