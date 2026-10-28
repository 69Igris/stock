# PubSub Message Handlers

> 152 nodes

## Key Concepts

- **workers/src/index.ts** (179 connections) — `workers/src/index.ts`
- **pubsub.ts** (98 connections) — `packages/types/src/pubsub.ts`
- **message.ts** (71 connections) — `workers/src/lib/message.ts`
- **getMessageId()** (68 connections) — `workers/src/lib/message.ts`
- **parsePubSubMessage()** (61 connections) — `workers/src/lib/message.ts`
- **routes/us-filing-insight.ts** (17 connections) — `workers/src/routes/us-filing-insight.ts`
- **routes/mf-portfolio-sync.ts** (11 connections) — `workers/src/routes/mf-portfolio-sync.ts`
- **processors/peers-sync.ts** (10 connections) — `workers/src/processors/peers-sync.ts`
- **routes/account-deletion.ts** (9 connections) — `workers/src/routes/account-deletion.ts`
- **routes/bhavcopy.ts** (9 connections) — `workers/src/routes/bhavcopy.ts`
- **bse-announcements.ts** (9 connections) — `workers/src/routes/bse-announcements.ts`
- **routes/clerk-delete-sweep.ts** (9 connections) — `workers/src/routes/clerk-delete-sweep.ts`
- **routes/comparison.ts** (9 connections) — `workers/src/routes/comparison.ts`
- **corporate-actions.ts** (9 connections) — `workers/src/routes/corporate-actions.ts`
- **routes/document-financials-projection.ts** (9 connections) — `workers/src/routes/document-financials-projection.ts`
- **routes/document-process.ts** (9 connections) — `workers/src/routes/document-process.ts`
- **routes/etf-expense-enrichment.ts** (9 connections) — `workers/src/routes/etf-expense-enrichment.ts`
- **routes/import.ts** (9 connections) — `workers/src/routes/import.ts`
- **routes/index-constituent-sync.ts** (9 connections) — `workers/src/routes/index-constituent-sync.ts`
- **routes/instrument-sync.ts** (9 connections) — `workers/src/routes/instrument-sync.ts`
- **routes/intraday-sync.ts** (9 connections) — `workers/src/routes/intraday-sync.ts`
- **routes/investor-rollup.ts** (9 connections) — `workers/src/routes/investor-rollup.ts`
- **routes/login-briefing.ts** (9 connections) — `workers/src/routes/login-briefing.ts`
- **routes/macro-sync.ts** (9 connections) — `workers/src/routes/macro-sync.ts`
- **routes/mf-metadata-sync.ts** (9 connections) — `workers/src/routes/mf-metadata-sync.ts`
- *... and 127 more nodes in this community*

## Relationships

- [SEO and Chat Components](SEO_and_Chat_Components.md) (42 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (24 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (14 shared connections)
- [User Account Deletion Pipeline](User_Account_Deletion_Pipeline.md) (8 shared connections)
- [Intraday Candle Eviction](Intraday_Candle_Eviction.md) (8 shared connections)
- [Corporate Issues Logic](Corporate_Issues_Logic.md) (8 shared connections)
- [Stock Document Parsing Pipeline](Stock_Document_Parsing_Pipeline.md) (8 shared connections)
- [Filing Insight Sweep Workers](Filing_Insight_Sweep_Workers.md) (8 shared connections)
- [Broker Tradebook Synchronization](Broker_Tradebook_Synchronization.md) (7 shared connections)
- [XBRL Projection Pipeline](XBRL_Projection_Pipeline.md) (7 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (7 shared connections)
- [Stock Document Synchronization](Stock_Document_Synchronization.md) (7 shared connections)

## Source Files

- `@usemoney/logger`
- `packages/types/src/pubsub.ts`
- `workers/CLAUDE.md`
- `workers/README.md`
- `workers/__tests__/processors/xbrl-projection-drain-logic.test.ts`
- `workers/cloudbuild.prod.yaml`
- `workers/src/index-logic.ts`
- `workers/src/index.ts`
- `workers/src/lib/message.ts`
- `workers/src/processors/peers-sync.ts`
- `workers/src/routes/account-deletion.ts`
- `workers/src/routes/alert-evaluator.ts`
- `workers/src/routes/annual-reports-sync.ts`
- `workers/src/routes/bhavcopy.ts`
- `workers/src/routes/bse-announcements.ts`
- `workers/src/routes/clerk-delete-sweep.ts`
- `workers/src/routes/comparison.ts`
- `workers/src/routes/corporate-actions.ts`
- `workers/src/routes/document-financials-projection.ts`
- `workers/src/routes/document-process.ts`

## Audit Trail

- EXTRACTED: 758 (100%)
- INFERRED: 2 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*