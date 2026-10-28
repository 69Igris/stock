# Tiingo Realtime WebSocket Client

> 25 nodes

## Key Concepts

- **tiingo-socket.ts** (20 connections) — `workers/src/realtime/tiingo-socket.ts`
- **FakeSocket** (9 connections) — `workers/__tests__/realtime/tiingo-socket-behaviour.test.ts`
- **SocketLike** (7 connections) — `workers/src/realtime/tiingo-socket.ts`
- **tiingo-socket-behaviour.test.ts** (7 connections) — `workers/__tests__/realtime/tiingo-socket-behaviour.test.ts`
- **buildSubscribePayload()** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-realtime-logic.ts`
- **backoffDelayMs()** (4 connections) — `workers/src/realtime/tiingo-socket.ts`
- **TiingoRtFrame** (3 connections) — `packages/core/src/market-data/tiingo/tiingo-realtime-logic.ts`
- **Harness** (3 connections) — `workers/__tests__/realtime/tiingo-socket-behaviour.test.ts`
- **HEARTBEAT_TIMEOUT_MS** (3 connections) — `workers/src/realtime/tiingo-socket.ts`
- **tiingo-socket-backoff.test.ts** (3 connections) — `workers/__tests__/realtime/tiingo-socket-backoff.test.ts`
- **SocketCallbacks** (2 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.on()** (2 connections) — `workers/src/realtime/tiingo-socket.ts`
- **BACKOFF_STABLE_AFTER_MS** (2 connections) — `workers/src/realtime/tiingo-socket.ts`
- **SocketCounters** (1 connections) — `workers/src/realtime/tiingo-socket.ts`
- **SocketFactory** (1 connections) — `workers/src/realtime/tiingo-socket.ts`
- **defaultSocketFactory()** (1 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.close()** (1 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.send()** (1 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.terminate()** (1 connections) — `workers/src/realtime/tiingo-socket.ts`
- **.close()** (1 connections) — `workers/__tests__/realtime/tiingo-socket-behaviour.test.ts`
- **.emit()** (1 connections) — `workers/__tests__/realtime/tiingo-socket-behaviour.test.ts`
- **.hasHandler()** (1 connections) — `workers/__tests__/realtime/tiingo-socket-behaviour.test.ts`
- **.on()** (1 connections) — `workers/__tests__/realtime/tiingo-socket-behaviour.test.ts`
- **.send()** (1 connections) — `workers/__tests__/realtime/tiingo-socket-behaviour.test.ts`
- **.terminate()** (1 connections) — `workers/__tests__/realtime/tiingo-socket-behaviour.test.ts`

## Relationships

- [Tiingo Realtime Price Parsing](Tiingo_Realtime_Price_Parsing.md) (7 shared connections)
- [Tiingo WebSocket Client](Tiingo_WebSocket_Client.md) (6 shared connections)
- [Tiingo Minute Bar Aggregation](Tiingo_Minute_Bar_Aggregation.md) (2 shared connections)
- [Realtime Market Data Capture](Realtime_Market_Data_Capture.md) (1 shared connections)
- [Tiingo Realtime Subscription Planning](Tiingo_Realtime_Subscription_Planning.md) (1 shared connections)
- [Broker WebSocket Architecture](Broker_WebSocket_Architecture.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/tiingo/tiingo-realtime-logic.ts`
- `workers/__tests__/realtime/tiingo-socket-backoff.test.ts`
- `workers/__tests__/realtime/tiingo-socket-behaviour.test.ts`
- `workers/src/realtime/tiingo-socket.ts`

## Audit Trail

- EXTRACTED: 50 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*