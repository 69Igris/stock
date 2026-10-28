# NSE Announcements Sync

> 67 nodes

## Key Concepts

- **nse-announcements-sync-logic.ts** (57 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **nse-announcements-sync.ts** (47 connections) — `workers/src/processors/nse-announcements-sync.ts`
- **nse-announcements-sync-logic.test.ts** (35 connections) — `workers/__tests__/nse-announcements-sync-logic.test.ts`
- **processNseAnnouncementsSync()** (20 connections) — `workers/src/processors/nse-announcements-sync.ts`
- **decideNseAnnouncementDedupe()** (7 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **classifyNseAnnouncement()** (6 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **computeAnnouncementWindow()** (6 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **parseNseAnnouncementRows()** (6 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **buildAnnouncementPeriod()** (5 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **tokenizeTitle()** (5 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **buildAnnouncementsPath()** (4 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **formatIstDate()** (4 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **isUsablePdf()** (4 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **normalizeDesc()** (4 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **parseNseTimestamp()** (4 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **planPdfDownload()** (4 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **splitGcsPath()** (4 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **titleSimilarity()** (4 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **DedupeCandidate** (3 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **downloadAttachment()** (3 connections) — `workers/src/processors/nse-announcements-sync.ts`
- **deriveCandidateConfidence()** (3 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **resolveAttachmentUrl()** (3 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **DEDUPE_WINDOW_MS** (3 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **MAX_PDF_DOWNLOADS_PER_RUN** (3 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- **IncomingAnnouncement** (2 connections) — `workers/src/processors/nse-announcements-sync-logic.ts`
- *... and 42 more nodes in this community*

## Relationships

- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (7 shared connections)
- [Stock Document Synchronization](Stock_Document_Synchronization.md) (6 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Stock Document Fetching Staleness](Stock_Document_Fetching_Staleness.md) (3 shared connections)
- [Document Container Management](Document_Container_Management.md) (3 shared connections)
- [RAG Document Enqueue Service](RAG_Document_Enqueue_Service.md) (2 shared connections)
- [Corporate Actions Windows](Corporate_Actions_Windows.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [BSE Announcements Backfill](BSE_Announcements_Backfill.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Storage Download Budget Manager](Storage_Download_Budget_Manager.md) (1 shared connections)

## Source Files

- `workers/__tests__/nse-announcements-sync-logic.test.ts`
- `workers/src/processors/nse-announcements-sync-logic.ts`
- `workers/src/processors/nse-announcements-sync.ts`

## Audit Trail

- EXTRACTED: 172 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*