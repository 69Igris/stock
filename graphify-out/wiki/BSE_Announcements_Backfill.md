# BSE Announcements Backfill

> 120 nodes

## Key Concepts

- **bse-announcements-sync.ts** (75 connections) — `workers/src/processors/bse-announcements-sync.ts`
- **bse-announcements-sync-logic.ts** (66 connections) — `workers/src/processors/bse-announcements-sync-logic.ts`
- **backfill-bse-results.ts** (45 connections) — `scripts/data/backfill-bse-results.ts`
- **bse-announcements-sync-logic.test.ts** (35 connections) — `workers/__tests__/processors/bse-announcements-sync-logic.test.ts`
- **processBseAnnouncementsSync()** (20 connections) — `workers/src/processors/bse-announcements-sync.ts`
- **bse-announcements-sync-drain.test.ts** (18 connections) — `workers/__tests__/processors/bse-announcements-sync-drain.test.ts`
- **main()** (16 connections) — `scripts/data/backfill-bse-results.ts`
- **StockDocType** (11 connections) — `packages/research/src/data-sources/stock-document-paths.ts`
- **writeOne()** (11 connections) — `scripts/data/backfill-bse-results.ts`
- **money1258-cloudrun-apply.test.ts** (10 connections) — `workers/__tests__/processors/money1258-cloudrun-apply.test.ts`
- **buildBseDocumentDescription()** (9 connections) — `workers/src/processors/bse-announcements-sync-logic.ts`
- **classifyBseAnnouncement()** (9 connections) — `workers/src/processors/bse-announcements-sync-logic.ts`
- **BseRateLimitError** (8 connections) — `packages/research/src/data-sources/bse-client.ts`
- **parseBseDocumentBreadcrumb()** (8 connections) — `workers/src/processors/bse-announcements-sync-logic.ts`
- **HTML_QUARANTINE_STATUS** (8 connections) — `packages/research/src/data-sources/document-body-guard.ts`
- **BseAnnouncement** (7 connections) — `packages/research/src/data-sources/bse-client.ts`
- **derivePeriodEnd()** (7 connections) — `workers/src/processors/bse-announcements-sync-logic.ts`
- **archivePdf()** (6 connections) — `workers/src/processors/bse-announcements-sync.ts`
- **bseAttachmentCandidates()** (6 connections) — `workers/src/processors/bse-announcements-sync-logic.ts`
- **money1258-bse-attachment-dirs.test.ts** (6 connections) — `workers/__tests__/processors/money1258-bse-attachment-dirs.test.ts`
- **daysInMonth()** (5 connections) — `workers/src/processors/bse-announcements-sync-logic.ts`
- **decodeQuarterId()** (5 connections) — `workers/src/processors/bse-announcements-sync-logic.ts`
- **judgeBseAnnouncementsHealth()** (5 connections) — `workers/src/processors/bse-announcements-sync-logic.ts`
- **resolveApplyConfirmation()** (5 connections) — `workers/src/processors/bse-announcements-sync-logic.ts`
- **shouldChainShard()** (5 connections) — `workers/src/processors/bse-announcements-sync-logic.ts`
- *... and 95 more nodes in this community*

## Relationships

- [BSE Announcements Client](BSE_Announcements_Client.md) (19 shared connections)
- [Stock Document Fetching Staleness](Stock_Document_Fetching_Staleness.md) (13 shared connections)
- [Stock Document Synchronization](Stock_Document_Synchronization.md) (12 shared connections)
- [Document Container Management](Document_Container_Management.md) (7 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (5 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Document Body Guard Recovery](Document_Body_Guard_Recovery.md) (3 shared connections)
- [RAG Document Enqueue Service](RAG_Document_Enqueue_Service.md) (2 shared connections)
- [BSE Scrip Master Enrichment](BSE_Scrip_Master_Enrichment.md) (2 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (2 shared connections)

## Source Files

- `packages/research/src/data-sources/bse-client.ts`
- `packages/research/src/data-sources/document-body-guard.ts`
- `packages/research/src/data-sources/stock-document-paths.ts`
- `scripts/data/backfill-bse-results.ts`
- `workers/__tests__/processors/bse-announcements-sync-drain.test.ts`
- `workers/__tests__/processors/bse-announcements-sync-logic.test.ts`
- `workers/__tests__/processors/money1258-bse-attachment-dirs.test.ts`
- `workers/__tests__/processors/money1258-cloudrun-apply.test.ts`
- `workers/src/processors/bse-announcements-sync-logic.ts`
- `workers/src/processors/bse-announcements-sync.ts`

## Audit Trail

- EXTRACTED: 353 (100%)
- INFERRED: 1 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*