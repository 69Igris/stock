# Zerodha Broker Adapter

> 11 nodes

## Key Concepts

- **ZerodhaAdapter** (23 connections) — `packages/core/src/brokers/adapters/zerodha.ts`
- **.authenticate()** (5 connections) — `packages/core/src/brokers/adapters/zerodha.ts`
- **.getApiKey()** (4 connections) — `packages/core/src/brokers/adapters/zerodha.ts`
- **.mapPosition()** (4 connections) — `packages/core/src/brokers/adapters/zerodha.ts`
- **.getApiSecret()** (2 connections) — `packages/core/src/brokers/adapters/zerodha.ts`
- **.getAuthUrl()** (2 connections) — `packages/core/src/brokers/adapters/zerodha.ts`
- **.getRefreshStrategy()** (2 connections) — `packages/core/src/brokers/adapters/zerodha.ts`
- **.refreshAccessToken()** (2 connections) — `packages/core/src/brokers/adapters/zerodha.ts`
- **.constructor()** (1 connections) — `packages/core/src/brokers/adapters/zerodha.ts`
- **.getTokenExpiryDuration()** (1 connections) — `packages/core/src/brokers/adapters/zerodha.ts`
- **.supportsAutoRefresh()** (1 connections) — `packages/core/src/brokers/adapters/zerodha.ts`

## Relationships

- [Broker Data Adapters](Broker_Data_Adapters.md) (14 shared connections)
- [Broker Auth Adapters](Broker_Auth_Adapters.md) (5 shared connections)
- [Broker Portfolio Data Normalizers](Broker_Portfolio_Data_Normalizers.md) (2 shared connections)

## Source Files

- `packages/core/src/brokers/adapters/zerodha.ts`

## Audit Trail

- EXTRACTED: 34 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*