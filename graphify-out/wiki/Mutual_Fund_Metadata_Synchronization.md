# Mutual Fund Metadata Synchronization

> 24 nodes

## Key Concepts

- **processors/mf-metadata-sync.ts** (26 connections) — `workers/src/processors/mf-metadata-sync.ts`
- **mf-metadata-sync-logic.ts** (18 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **processMfMetadataSync()** (13 connections) — `workers/src/processors/mf-metadata-sync.ts`
- **mf-metadata-sync-logic.test.ts** (13 connections) — `workers/__tests__/processors/mf-metadata-sync-logic.test.ts`
- **buildMfMetadataWhere()** (5 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **computeStaleDate()** (5 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **mf-metadata-cursor-db.test.ts** (5 connections) — `workers/__tests__/processors/mf-metadata-cursor-db.test.ts`
- **judgeMfMetadataHealth()** (4 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **resolveMfMetadataParams()** (4 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **shouldLogProgress()** (4 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **shouldSleepAfterIndex()** (4 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **MfMetadataRunTally** (3 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **sleep()** (2 connections) — `workers/src/processors/mf-metadata-sync.ts`
- **DEFAULT_BATCH_SIZE** (2 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **DEFAULT_DELAY_MS** (2 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **PROGRESS_LOG_EVERY** (2 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **STALE_DAYS** (2 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **MfMetadataHealth** (1 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **MfMetadataHealthReason** (1 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **MfMetadataSyncParams** (1 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **MfMetadataWhere** (1 connections) — `workers/src/processors/mf-metadata-sync-logic.ts`
- **cleanup()** (1 connections) — `workers/__tests__/processors/mf-metadata-cursor-db.test.ts`
- **tally()** (1 connections) — `workers/__tests__/processors/mf-metadata-sync-logic.test.ts`
- **ENABLED** (1 connections) — `workers/__tests__/processors/mf-metadata-cursor-db.test.ts`

## Relationships

- [Kuvera Mutual Fund Metadata](Kuvera_Mutual_Fund_Metadata.md) (6 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [AMFI Mutual Fund Metadata](AMFI_Mutual_Fund_Metadata.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (1 shared connections)
- [AMFI AAUM and TER Provider](AMFI_AAUM_and_TER_Provider.md) (1 shared connections)

## Source Files

- `workers/__tests__/processors/mf-metadata-cursor-db.test.ts`
- `workers/__tests__/processors/mf-metadata-sync-logic.test.ts`
- `workers/src/processors/mf-metadata-sync-logic.ts`
- `workers/src/processors/mf-metadata-sync.ts`

## Audit Trail

- EXTRACTED: 70 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*