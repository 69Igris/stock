# PubSub Pull Subscription Workers

> 45 nodes

## Key Concepts

- **pull-subscriber.ts** (73 connections) — `workers/src/lib/pull-subscriber.ts`
- **pull-subscriber.test.ts** (23 connections) — `workers/__tests__/lib/pull-subscriber.test.ts`
- **startPullSubscribers()** (10 connections) — `workers/src/lib/pull-subscriber.ts`
- **processors/mf-sync.ts** (10 connections) — `workers/src/processors/mf-sync.ts`
- **processors/chartink-strategy-sync.ts** (9 connections) — `workers/src/processors/chartink-strategy-sync.ts`
- **routes/mf-sync.ts** (9 connections) — `workers/src/routes/mf-sync.ts`
- **routes/chartink-strategy-sync.ts** (8 connections) — `workers/src/routes/chartink-strategy-sync.ts`
- **processMfSync()** (6 connections) — `workers/src/processors/mf-sync.ts`
- **MfSyncMessage** (4 connections) — `packages/types/src/pubsub.ts`
- **handlePullMessage()** (4 connections) — `workers/src/lib/pull-subscriber.ts`
- **processChartinkStrategySync()** (4 connections) — `workers/src/processors/chartink-strategy-sync.ts`
- **mf-sync-logic.ts** (4 connections) — `workers/src/processors/mf-sync-logic.ts`
- **buildSubscriptionOptions()** (3 connections) — `workers/src/lib/pull-subscriber.ts`
- **classifyError()** (3 connections) — `workers/src/lib/pull-subscriber.ts`
- **getSubscriptionName()** (3 connections) — `workers/src/lib/pull-subscriber.ts`
- **parseMessageData()** (3 connections) — `workers/src/lib/pull-subscriber.ts`
- **selectPullTopics()** (3 connections) — `workers/src/lib/pull-subscriber.ts`
- **capMfErrorsForLog()** (3 connections) — `workers/src/processors/mf-sync-logic.ts`
- **resolveForceFullSync()** (3 connections) — `workers/src/processors/mf-sync-logic.ts`
- **PullMessageLike** (2 connections) — `workers/src/lib/pull-subscriber.ts`
- **PullProcessor** (2 connections) — `workers/src/lib/pull-subscriber.ts`
- **ChartinkStrategySyncMessage** (2 connections) — `workers/src/processors/chartink-strategy-sync.ts`
- **resolveChartinkCategoryIds()** (2 connections) — `workers/src/processors/chartink-strategy-sync.ts`
- **server** (2 connections) — `workers/src/index.ts`
- **ACK_DEADLINE_SECONDS** (2 connections) — `workers/src/lib/pull-subscriber.ts`
- *... and 20 more nodes in this community*

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (14 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (8 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (5 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (3 shared connections)
- [Trade Pairing Processor](Trade_Pairing_Processor.md) (2 shared connections)
- [Broker Trade Import Processing](Broker_Trade_Import_Processing.md) (2 shared connections)
- [Broker Tradebook Synchronization](Broker_Tradebook_Synchronization.md) (2 shared connections)
- [Instrument Master Seeder](Instrument_Master_Seeder.md) (2 shared connections)
- [Price Synchronization Processor](Price_Synchronization_Processor.md) (2 shared connections)
- [Instrument Sector Enrichment](Instrument_Sector_Enrichment.md) (2 shared connections)
- [Research Mode Job Processing](Research_Mode_Job_Processing.md) (2 shared connections)
- [Mutual Fund Metadata Synchronization](Mutual_Fund_Metadata_Synchronization.md) (2 shared connections)

## Source Files

- `packages/types/src/pubsub.ts`
- `workers/__tests__/lib/pull-subscriber.test.ts`
- `workers/src/index.ts`
- `workers/src/lib/pull-subscriber.ts`
- `workers/src/processors/chartink-strategy-sync.ts`
- `workers/src/processors/mf-sync-logic.ts`
- `workers/src/processors/mf-sync.ts`
- `workers/src/routes/chartink-strategy-sync.ts`
- `workers/src/routes/mf-sync.ts`

## Audit Trail

- EXTRACTED: 126 (85%)
- INFERRED: 23 (15%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*