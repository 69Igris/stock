# Broker Auth Adapters

> 72 nodes

## Key Concepts

- **AuthResult** (31 connections) — `packages/types/src/broker/index.ts`
- **FyersAdapter** (22 connections) — `packages/core/src/brokers/adapters/fyers.ts`
- **HDFCAdapter** (22 connections) — `packages/core/src/brokers/adapters/hdfc.ts`
- **ICICIAdapter** (22 connections) — `packages/core/src/brokers/adapters/icici.ts`
- **RefreshStrategy** (22 connections) — `packages/types/src/broker/index.ts`
- **AngelOneAdapter** (21 connections) — `packages/core/src/brokers/adapters/angel-one.ts`
- **DhanAdapter** (21 connections) — `packages/core/src/brokers/adapters/dhan.ts`
- **GrowwAdapter** (20 connections) — `packages/core/src/brokers/adapters/groww.ts`
- **factory.ts** (19 connections) — `packages/core/src/brokers/factory.ts`
- **getBrokerAdapter()** (12 connections) — `packages/core/src/brokers/factory.ts`
- **.getAuthHeaders()** (9 connections) — `packages/core/src/brokers/adapters/icici.ts`
- **.getAuthHeaders()** (8 connections) — `packages/core/src/brokers/adapters/hdfc.ts`
- **.refreshAccessToken()** (6 connections) — `packages/core/src/brokers/adapters/fyers.ts`
- **.authenticate()** (5 connections) — `packages/core/src/brokers/adapters/fyers.ts`
- **.getAppId()** (5 connections) — `packages/core/src/brokers/adapters/fyers.ts`
- **.authenticate()** (5 connections) — `packages/core/src/brokers/adapters/hdfc.ts`
- **.authenticate()** (4 connections) — `packages/core/src/brokers/adapters/angel-one.ts`
- **.refreshAccessToken()** (4 connections) — `packages/core/src/brokers/adapters/angel-one.ts`
- **.authenticate()** (4 connections) — `packages/core/src/brokers/adapters/dhan.ts`
- **.getApiKey()** (4 connections) — `packages/core/src/brokers/adapters/hdfc.ts`
- **.validateToken()** (4 connections) — `packages/core/src/brokers/adapters/hdfc.ts`
- **.authenticate()** (4 connections) — `packages/core/src/brokers/adapters/icici.ts`
- **.getApiKey()** (4 connections) — `packages/core/src/brokers/adapters/icici.ts`
- **.validateToken()** (4 connections) — `packages/core/src/brokers/adapters/icici.ts`
- **.getApiKey()** (3 connections) — `packages/core/src/brokers/adapters/angel-one.ts`
- *... and 47 more nodes in this community*

## Relationships

- [Broker Data Adapters](Broker_Data_Adapters.md) (103 shared connections)
- [Broker Portfolio Data Normalizers](Broker_Portfolio_Data_Normalizers.md) (21 shared connections)
- [Interactive Brokers Adapter](Interactive_Brokers_Adapter.md) (5 shared connections)
- [Zerodha Broker Adapter](Zerodha_Broker_Adapter.md) (5 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (3 shared connections)
- [Angel One Client](Angel_One_Client.md) (2 shared connections)
- [Broker Account Sync Decisions](Broker_Account_Sync_Decisions.md) (1 shared connections)

## Source Files

- `packages/core/src/brokers/adapters/angel-one.ts`
- `packages/core/src/brokers/adapters/dhan.ts`
- `packages/core/src/brokers/adapters/fyers.ts`
- `packages/core/src/brokers/adapters/groww.ts`
- `packages/core/src/brokers/adapters/hdfc.ts`
- `packages/core/src/brokers/adapters/icici.ts`
- `packages/core/src/brokers/adapters/interactive-brokers.ts`
- `packages/core/src/brokers/adapters/upstox.ts`
- `packages/core/src/brokers/factory.ts`
- `packages/types/src/broker/index.ts`

## Audit Trail

- EXTRACTED: 251 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*