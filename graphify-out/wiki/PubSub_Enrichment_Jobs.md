# PubSub Enrichment Jobs

> 67 nodes

## Key Concepts

- **getTopicName()** (53 connections) — `packages/types/src/pubsub.ts`
- **getPubSubClient()** (48 connections) — `packages/pubsub/src/client.ts`
- **publish.ts** (39 connections) — `packages/pubsub/src/publish.ts`
- **PUBSUB_TOPICS** (26 connections) — `packages/types/src/pubsub.ts`
- **processors/l3-analysis.ts** (26 connections) — `workers/src/processors/l3-analysis.ts`
- **processors/us-instrument-master-sync.ts** (26 connections) — `workers/src/processors/us-instrument-master-sync.ts`
- **pubsub/src/client.ts** (24 connections) — `packages/pubsub/src/client.ts`
- **publish.test.ts** (20 connections) — `packages/pubsub/__tests__/publish.test.ts`
- **stock-document-extract-embed-chain.test.ts** (19 connections) — `workers/__tests__/processors/stock-document-extract-embed-chain.test.ts`
- **pubsub/src/index.ts** (18 connections) — `packages/pubsub/src/index.ts`
- **processL3Segment()** (13 connections) — `workers/src/processors/l3-analysis.ts`
- **syncUsInstrumentMaster()** (10 connections) — `workers/src/processors/us-instrument-master-sync.ts`
- **refundReservationCredits()** (9 connections) — `packages/services/src/credit-reservation.service.ts`
- **routes/l3-analysis.ts** (9 connections) — `workers/src/routes/l3-analysis.ts`
- **processAnnualReportsSync()** (8 connections) — `workers/src/processors/annual-reports-sync.ts`
- **client.test.ts** (8 connections) — `packages/pubsub/__tests__/client.test.ts`
- **routes/us-instrument-master-sync.ts** (8 connections) — `workers/src/routes/us-instrument-master-sync.ts`
- **L3AnalysisMessage** (7 connections) — `packages/types/src/pubsub.ts`
- **publishPairingJob()** (7 connections) — `packages/pubsub/src/publish.ts`
- **__setPubSubClientForTests()** (6 connections) — `packages/pubsub/src/client.ts`
- **publishComparisonJob()** (6 connections) — `packages/pubsub/src/publish.ts`
- **publishL3AnalysisJob()** (6 connections) — `packages/pubsub/src/publish.ts`
- **publishResearchJob()** (6 connections) — `packages/pubsub/src/publish.ts`
- **publishRoastJob()** (6 connections) — `packages/pubsub/src/publish.ts`
- **publishStrategyScanJob()** (6 connections) — `packages/pubsub/src/publish.ts`
- *... and 42 more nodes in this community*

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (24 shared connections)
- [Tiingo US Ticker Search](Tiingo_US_Ticker_Search.md) (15 shared connections)
- [Comprehensive Analysis Service](Comprehensive_Analysis_Service.md) (13 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (10 shared connections)
- [Stock Document Text Extraction](Stock_Document_Text_Extraction.md) (10 shared connections)
- [Stock Document Synchronization](Stock_Document_Synchronization.md) (8 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (8 shared connections)
- [Intraday Candle Eviction](Intraday_Candle_Eviction.md) (8 shared connections)
- [Corporate Issues Logic](Corporate_Issues_Logic.md) (8 shared connections)
- [US EOD Data Synchronization](US_EOD_Data_Synchronization.md) (8 shared connections)
- [Stock Document Parsing Pipeline](Stock_Document_Parsing_Pipeline.md) (7 shared connections)
- [Broker Tradebook Synchronization](Broker_Tradebook_Synchronization.md) (7 shared connections)

## Source Files

- `packages/core/src/market-data/instruments/us-instrument-names-logic.ts`
- `packages/core/src/market-data/prices/mf-nav-service.ts`
- `packages/pubsub/__tests__/client.test.ts`
- `packages/pubsub/__tests__/publish.test.ts`
- `packages/pubsub/src/client.ts`
- `packages/pubsub/src/index.ts`
- `packages/pubsub/src/publish.ts`
- `packages/services/src/credit-reservation.service.ts`
- `packages/types/src/pubsub.ts`
- `workers/__tests__/processors/stock-document-extract-embed-chain.test.ts`
- `workers/src/processors/annual-reports-sync.ts`
- `workers/src/processors/bse-announcements-sync.ts`
- `workers/src/processors/filing-insight-sweep.ts`
- `workers/src/processors/l3-analysis-logic.ts`
- `workers/src/processors/l3-analysis.ts`
- `workers/src/processors/stock-document-sync.ts`
- `workers/src/processors/us-eod-sync.ts`
- `workers/src/processors/us-instrument-master-sync.ts`
- `workers/src/routes/l3-analysis.ts`
- `workers/src/routes/us-instrument-master-sync.ts`

## Audit Trail

- EXTRACTED: 366 (100%)
- INFERRED: 1 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*