# Broker Tradebook Synchronization

> 47 nodes

## Key Concepts

- **processors/sync.ts** (48 connections) — `workers/src/processors/sync.ts`
- **sync-logic.ts** (44 connections) — `workers/src/processors/sync-logic.ts`
- **processSync()** (22 connections) — `workers/src/processors/sync.ts`
- **routes/sync.ts** (9 connections) — `workers/src/routes/sync.ts`
- **syncHistoricalTradebook()** (8 connections) — `packages/services/src/broker-sync.service.ts`
- **SyncJobMessage** (6 connections) — `packages/types/src/pubsub.ts`
- **syncBrokerConnections()** (6 connections) — `packages/services/src/broker-sync.service.ts`
- **fanOutScheduledSync()** (5 connections) — `workers/src/processors/sync.ts`
- **buildConnectionWhere()** (4 connections) — `packages/services/src/broker-sync.service.ts`
- **buildSyncEmailCounts()** (4 connections) — `packages/services/src/broker-sync.service.ts`
- **historicalConnectionsWithErrors()** (4 connections) — `packages/services/src/broker-sync.service.ts`
- **buildShardFanoutMessages()** (3 connections) — `workers/src/processors/sync-logic.ts`
- **buildSyncJobStatusUpdate()** (3 connections) — `workers/src/processors/sync-logic.ts`
- **inFlightSyncCutoff()** (3 connections) — `workers/src/processors/sync-logic.ts`
- **isFanoutTrigger()** (3 connections) — `workers/src/processors/sync-logic.ts`
- **isSyncInFlight()** (3 connections) — `workers/src/processors/sync-logic.ts`
- **shouldSendHistoricalEmail()** (3 connections) — `workers/src/processors/sync-logic.ts`
- **shouldSendSyncEmail()** (3 connections) — `workers/src/processors/sync-logic.ts`
- **startOfTodayIST()** (3 connections) — `workers/src/processors/sync-logic.ts`
- **surfaceHistoricalErrors()** (3 connections) — `workers/src/processors/sync.ts`
- **buildPositionCreateData()** (2 connections) — `workers/src/processors/sync-logic.ts`
- **computePositionDerived()** (2 connections) — `workers/src/processors/sync-logic.ts`
- **DEFAULT_SYNC_DATA_TYPES** (2 connections) — `workers/src/processors/sync-logic.ts`
- **syncRoute** (2 connections) — `workers/src/routes/sync.ts`
- **ConnectionWithCreds** (1 connections) — `workers/src/processors/sync-logic.ts`
- *... and 22 more nodes in this community*

## Relationships

- [Broker Account Sync Decisions](Broker_Account_Sync_Decisions.md) (13 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (7 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (7 shared connections)
- [Email Preferences and Unsubscribe](Email_Preferences_and_Unsubscribe.md) (7 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (6 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (4 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (4 shared connections)
- [Broker Data Adapters](Broker_Data_Adapters.md) (4 shared connections)
- [Trade Pairing Processor](Trade_Pairing_Processor.md) (3 shared connections)
- [Transactional Email Templates](Transactional_Email_Templates.md) (3 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (2 shared connections)

## Source Files

- `packages/services/src/broker-sync.service.ts`
- `packages/types/src/pubsub.ts`
- `workers/src/processors/sync-logic.ts`
- `workers/src/processors/sync.ts`
- `workers/src/routes/sync.ts`

## Audit Trail

- EXTRACTED: 143 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*