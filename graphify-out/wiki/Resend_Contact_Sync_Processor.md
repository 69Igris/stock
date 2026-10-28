# Resend Contact Sync Processor

> 16 nodes

## Key Concepts

- **processors/resend-contact-sync.ts** (19 connections) — `workers/src/processors/resend-contact-sync.ts`
- **resend-contact-sync-logic.ts** (11 connections) — `workers/src/processors/resend-contact-sync-logic.ts`
- **processResendContactSync()** (8 connections) — `workers/src/processors/resend-contact-sync.ts`
- **resolveTargetTier()** (4 connections) — `workers/src/processors/resend-contact-sync-logic.ts`
- **isPaidSubscription()** (3 connections) — `workers/src/processors/resend-contact-sync-logic.ts`
- **shouldLogProgress()** (3 connections) — `workers/src/processors/resend-contact-sync-logic.ts`
- **shouldSyncToMarketing()** (3 connections) — `workers/src/processors/resend-contact-sync-logic.ts`
- **splitName()** (3 connections) — `workers/src/processors/resend-contact-sync-logic.ts`
- **sleep()** (2 connections) — `workers/src/processors/resend-contact-sync.ts`
- **RATE_LIMIT_MS** (2 connections) — `workers/src/processors/resend-contact-sync-logic.ts`
- **ResendTier** (1 connections) — `workers/src/processors/resend-contact-sync-logic.ts`
- **SubscriptionLike** (1 connections) — `workers/src/processors/resend-contact-sync-logic.ts`
- **SyncStats** (1 connections) — `workers/src/processors/resend-contact-sync.ts`
- **logger** (1 connections) — `workers/src/processors/resend-contact-sync.ts`
- **PAID_PLANS** (1 connections) — `workers/src/processors/resend-contact-sync-logic.ts`
- **PROGRESS_LOG_INTERVAL** (1 connections) — `workers/src/processors/resend-contact-sync-logic.ts`

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Resend Audience Segment Migration](Resend_Audience_Segment_Migration.md) (1 shared connections)

## Source Files

- `workers/src/processors/resend-contact-sync-logic.ts`
- `workers/src/processors/resend-contact-sync.ts`

## Audit Trail

- EXTRACTED: 37 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*