# Broker Account Sync Decisions

> 41 nodes

## Key Concepts

- **broker-sync.service.ts** (61 connections) — `packages/services/src/broker-sync.service.ts`
- **BrokerType** (22 connections) — `packages/types/src/broker/index.ts`
- **broker-sync.test.ts** (18 connections) — `packages/services/__tests__/broker-sync.test.ts`
- **syncBrokerConnectionRow()** (10 connections) — `packages/services/src/broker-sync.service.ts`
- **classifyConnectionForSync()** (5 connections) — `packages/services/src/broker-sync.service.ts`
- **StartedSyncJob** (4 connections) — `packages/services/src/broker-sync.service.ts`
- **startHistoricalSync()** (4 connections) — `packages/services/src/broker-sync.service.ts`
- **verifyAndTrackConnection()** (4 connections) — `packages/services/src/broker-sync.service.ts`
- **StartSyncDeps** (3 connections) — `packages/services/src/broker-sync.service.ts`
- **SyncConnectionResult** (3 connections) — `packages/services/src/broker-sync.service.ts`
- **.constructor()** (3 connections) — `packages/core/src/brokers/clients/base-client.ts`
- **is403Error()** (3 connections) — `packages/services/src/broker-sync.service.ts`
- **isConnectionTokenExpired()** (3 connections) — `packages/services/src/broker-sync.service.ts`
- **markNeedsReauth()** (3 connections) — `packages/services/src/broker-sync.service.ts`
- **persistTrades()** (3 connections) — `packages/services/src/broker-sync.service.ts`
- **resolveHistoricalSyncDays()** (3 connections) — `packages/services/src/broker-sync.service.ts`
- **startAllBrokerSyncs()** (3 connections) — `packages/services/src/broker-sync.service.ts`
- **startBrokerSync()** (3 connections) — `packages/services/src/broker-sync.service.ts`
- **trackSyncJob()** (3 connections) — `packages/services/src/broker-sync.service.ts`
- **HistoricalTradesPerConnection** (2 connections) — `packages/services/src/broker-sync.service.ts`
- **StartedAllSyncJob** (2 connections) — `packages/services/src/broker-sync.service.ts`
- **StartedHistoricalSyncJob** (2 connections) — `packages/services/src/broker-sync.service.ts`
- **SyncBrokerConnectionsParams** (2 connections) — `packages/services/src/broker-sync.service.ts`
- **SyncEmailCounts** (2 connections) — `packages/services/src/broker-sync.service.ts`
- **SyncHistoricalTradesParams** (2 connections) — `packages/services/src/broker-sync.service.ts`
- *... and 16 more nodes in this community*

## Relationships

- [Broker Tradebook Synchronization](Broker_Tradebook_Synchronization.md) (13 shared connections)
- [Angel One Client](Angel_One_Client.md) (13 shared connections)
- [Broker Data Adapters](Broker_Data_Adapters.md) (4 shared connections)
- [Broker Portfolio Data Normalizers](Broker_Portfolio_Data_Normalizers.md) (4 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (4 shared connections)
- [Broker Connection Auth Logic](Broker_Connection_Auth_Logic.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (2 shared connections)
- [Data Encryption Service](Data_Encryption_Service.md) (2 shared connections)
- [Peer Stock Selection Logic](Peer_Stock_Selection_Logic.md) (2 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (2 shared connections)
- [Broker Auth Adapters](Broker_Auth_Adapters.md) (1 shared connections)

## Source Files

- `packages/core/src/brokers/base-adapter.ts`
- `packages/core/src/brokers/clients/base-client.ts`
- `packages/services/__tests__/broker-sync.test.ts`
- `packages/services/src/broker-sync.service.ts`
- `packages/types/src/broker/index.ts`

## Audit Trail

- EXTRACTED: 124 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*