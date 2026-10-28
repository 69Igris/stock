# Database Client and Migrations

> 75 nodes

## Key Concepts

- **database/index.ts** (269 connections) — `packages/database/index.ts`
- **@prisma/client** (32 connections) — `packages/database/package.json`
- **createNotification()** (25 connections) — `workers/src/lib/notifications.ts`
- **notifications.ts** (24 connections) — `workers/src/lib/notifications.ts`
- **backfill-pro-entitlement.ts** (11 connections) — `scripts/migrations/backfill-pro-entitlement.ts`
- **fix-premium-enddate.ts** (11 connections) — `scripts/migrations/fix-premium-enddate.ts`
- **notifications.test.ts** (11 connections) — `workers/__tests__/lib/notifications.test.ts`
- **tryCreateNotification()** (8 connections) — `workers/src/lib/notifications.ts`
- **verify-instrument-classification.ts** (8 connections) — `scripts/data/verify-instrument-classification.ts`
- **notifications-outcome.test.ts** (8 connections) — `workers/__tests__/lib/notifications-outcome.test.ts`
- **dedupe-stock-flags.ts** (7 connections) — `scripts/migrations/dedupe-stock-flags.ts`
- **database/client.ts** (6 connections) — `packages/database/client.ts`
- **stamp-welcome-email-backfill.ts** (6 connections) — `scripts/migrations/stamp-welcome-email-backfill.ts`
- **seed-stock-ratios.ts** (6 connections) — `scripts/seed/seed-stock-ratios.ts`
- **repair-stock-ratios-links.ts** (5 connections) — `scripts/ops/repair-stock-ratios-links.ts`
- **main()** (4 connections) — `scripts/data/verify-instrument-classification.ts`
- **audit-etf-expense-ratio.ts** (4 connections) — `scripts/data/audit-etf-expense-ratio.ts`
- **NotificationInput** (3 connections) — `workers/src/lib/notifications.ts`
- **main()** (3 connections) — `scripts/migrations/dedupe-stock-flags.ts`
- **castMetadata()** (3 connections) — `workers/src/lib/notifications.ts`
- **backfill-roast-sessionid.ts** (3 connections) — `packages/database/scripts/backfill-roast-sessionid.ts`
- **debug-sectors.ts** (3 connections) — `scripts/data/debug-sectors.ts`
- **reset-broker-trial.ts** (3 connections) — `scripts/ops/reset-broker-trial.ts`
- **assertAll()** (2 connections) — `scripts/data/verify-instrument-classification.ts`
- **compare()** (2 connections) — `scripts/data/verify-instrument-classification.ts`
- *... and 50 more nodes in this community*

## Relationships

- [Content Access and Pagination](Content_Access_and_Pagination.md) (14 shared connections)
- [Audit and Billing Logistics](Audit_and_Billing_Logistics.md) (9 shared connections)
- [Portfolio Roast Agent Pipeline](Portfolio_Roast_Agent_Pipeline.md) (8 shared connections)
- [Research Agent Planning](Research_Agent_Planning.md) (6 shared connections)
- [Broker Trade Import Processing](Broker_Trade_Import_Processing.md) (6 shared connections)
- [Broker Tradebook Synchronization](Broker_Tradebook_Synchronization.md) (6 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (6 shared connections)
- [Vector Embeddings Service](Vector_Embeddings_Service.md) (5 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (5 shared connections)
- [Database Package Configuration](Database_Package_Configuration.md) (5 shared connections)
- [Alert Evaluation Engine](Alert_Evaluation_Engine.md) (5 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (5 shared connections)

## Source Files

- `packages/database/client.ts`
- `packages/database/index.ts`
- `packages/database/package.json`
- `packages/database/scripts/backfill-roast-sessionid.ts`
- `scripts/data/audit-etf-expense-ratio.ts`
- `scripts/data/debug-sectors.ts`
- `scripts/data/verify-instrument-classification.ts`
- `scripts/migrations/backfill-pro-entitlement.ts`
- `scripts/migrations/dedupe-stock-flags.ts`
- `scripts/migrations/fix-premium-enddate.ts`
- `scripts/migrations/stamp-welcome-email-backfill.ts`
- `scripts/ops/repair-stock-ratios-links.ts`
- `scripts/ops/reset-broker-trial.ts`
- `scripts/seed/seed-stock-ratios.ts`
- `workers/__tests__/lib/notifications-outcome.test.ts`
- `workers/__tests__/lib/notifications.test.ts`
- `workers/src/lib/notifications.ts`

## Audit Trail

- EXTRACTED: 430 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*