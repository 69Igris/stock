# Broker Connection Auth Logic

> 45 nodes

## Key Concepts

- **broker-connection.service.ts** (39 connections) — `packages/services/src/broker-connection.service.ts`
- **broker-connection-logic.ts** (20 connections) — `packages/services/src/broker-connection-logic.ts`
- **persist-broker-connection.test.ts** (8 connections) — `packages/services/__tests__/persist-broker-connection.test.ts`
- **toBrokerConnectionInfo()** (7 connections) — `packages/services/src/broker-connection-logic.ts`
- **syncBucketFor()** (6 connections) — `packages/types/src/pubsub.ts`
- **isTokenExpired()** (5 connections) — `packages/services/src/broker-connection-logic.ts`
- **isValidDate()** (5 connections) — `packages/services/src/broker-connection-logic.ts`
- **safeISOStringOrNull()** (5 connections) — `packages/services/src/broker-connection-logic.ts`
- **toBrokerSyncStatus()** (5 connections) — `packages/services/src/broker-connection-logic.ts`
- **persistBrokerConnection()** (4 connections) — `packages/services/src/broker-connection.service.ts`
- **BrokerConnectionInfo** (3 connections) — `packages/services/src/broker-connection-logic.ts`
- **BrokerSyncStatus** (3 connections) — `packages/services/src/broker-connection-logic.ts`
- **FakePrisma** (3 connections) — `packages/services/__tests__/persist-broker-connection.test.ts`
- **deriveNeedsReauth()** (3 connections) — `packages/services/src/broker-connection-logic.ts`
- **isConnectionActive()** (3 connections) — `packages/services/src/broker-connection-logic.ts`
- **safeISOString()** (3 connections) — `packages/services/src/broker-connection-logic.ts`
- **PersistBrokerConnectionDeps** (2 connections) — `packages/services/src/broker-connection.service.ts`
- **PersistEncryption** (2 connections) — `packages/services/src/broker-connection.service.ts`
- **FakeEncryption** (2 connections) — `packages/services/__tests__/persist-broker-connection.test.ts`
- **formatLastSyncedRelative()** (2 connections) — `packages/services/src/broker-connection-logic.ts`
- **getActiveBrokerJobs()** (2 connections) — `packages/services/src/broker-connection.service.ts`
- **getBrokerConnection()** (2 connections) — `packages/services/src/broker-connection.service.ts`
- **getBrokerConnections()** (2 connections) — `packages/services/src/broker-connection.service.ts`
- **getBrokerSyncStatus()** (2 connections) — `packages/services/src/broker-connection.service.ts`
- **getLastSyncTime()** (2 connections) — `packages/services/src/broker-connection.service.ts`
- *... and 20 more nodes in this community*

## Relationships

- [Cache Key Management](Cache_Key_Management.md) (5 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (4 shared connections)
- [Broker Account Sync Decisions](Broker_Account_Sync_Decisions.md) (3 shared connections)
- [Sync Bucket Backfill](Sync_Bucket_Backfill.md) (2 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (2 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (2 shared connections)
- [Data Encryption Service](Data_Encryption_Service.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)

## Source Files

- `packages/services/__tests__/persist-broker-connection.test.ts`
- `packages/services/src/broker-connection-logic.ts`
- `packages/services/src/broker-connection.service.ts`
- `packages/types/src/pubsub.ts`

## Audit Trail

- EXTRACTED: 93 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*