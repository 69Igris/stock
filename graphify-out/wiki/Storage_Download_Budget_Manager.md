# Storage Download Budget Manager

> 28 nodes

## Key Concepts

- **storage/src/index.ts** (63 connections) — `packages/storage/src/index.ts`
- **getBucket()** (9 connections) — `packages/storage/src/index.ts`
- **download-budget.test.ts** (9 connections) — `packages/storage/__tests__/download-budget.test.ts`
- **download-budget.ts** (8 connections) — `packages/storage/src/download-budget.ts`
- **deriveDownloadConcurrency()** (5 connections) — `packages/storage/src/download-budget.ts`
- **parseContainerMi()** (5 connections) — `packages/storage/src/download-budget.ts`
- **getStorageClient()** (5 connections) — `packages/storage/src/index.ts`
- **isObjectNotFound()** (5 connections) — `packages/storage/src/index.ts`
- **buildStreamOptions()** (4 connections) — `packages/storage/src/index.ts`
- **deleteFile()** (4 connections) — `packages/storage/src/index.ts`
- **uploadStream()** (4 connections) — `packages/storage/src/index.ts`
- **DEFAULT_CONTAINER_MI** (4 connections) — `packages/storage/src/download-budget.ts`
- **ArchiveVerdict** (3 connections) — `packages/storage/src/archive-audit.ts`
- **downloadStream()** (3 connections) — `packages/storage/src/index.ts`
- **fileExists()** (3 connections) — `packages/storage/src/index.ts`
- **getFileMetadata()** (3 connections) — `packages/storage/src/index.ts`
- **isBucketNotFound()** (3 connections) — `packages/storage/src/index.ts`
- **LIVE_BUFFERS_PER_SLOT** (3 connections) — `packages/storage/src/download-budget.ts`
- **RUNTIME_RESERVE_MI** (3 connections) — `packages/storage/src/download-budget.ts`
- **download-404.test.ts** (3 connections) — `packages/storage/__tests__/download-404.test.ts`
- **PayloadVerdict** (2 connections) — `packages/storage/src/archive-audit.ts`
- **DownloadConcurrencyPlan** (2 connections) — `packages/storage/src/download-budget.ts`
- **upload-options.test.ts** (2 connections) — `packages/storage/__tests__/upload-options.test.ts`
- **SignedUrlOptions** (1 connections) — `packages/storage/src/index.ts`
- **UploadOptions** (1 connections) — `packages/storage/src/index.ts`
- *... and 3 more nodes in this community*

## Relationships

- [Feed Archive Header Auditing](Feed_Archive_Header_Auditing.md) (23 shared connections)
- [Index Constituent Parsing](Index_Constituent_Parsing.md) (8 shared connections)
- [Databento Storage Client](Databento_Storage_Client.md) (5 shared connections)
- [RAG Document Enqueue Service](RAG_Document_Enqueue_Service.md) (4 shared connections)
- [User Feedback Quota Logic](User_Feedback_Quota_Logic.md) (3 shared connections)
- [Google Cloud Credentials Handler](Google_Cloud_Credentials_Handler.md) (3 shared connections)
- [Multipart Envelope Processing](Multipart_Envelope_Processing.md) (2 shared connections)
- [Document Body Guard Recovery](Document_Body_Guard_Recovery.md) (1 shared connections)
- [BSE Announcements Backfill](BSE_Announcements_Backfill.md) (1 shared connections)
- [Stock Document Fetching Staleness](Stock_Document_Fetching_Staleness.md) (1 shared connections)
- [Document Financial Ingestion Backfill](Document_Financial_Ingestion_Backfill.md) (1 shared connections)
- [Derivatives Bhavcopy Parsing](Derivatives_Bhavcopy_Parsing.md) (1 shared connections)

## Source Files

- `packages/storage/__tests__/download-404.test.ts`
- `packages/storage/__tests__/download-budget.test.ts`
- `packages/storage/__tests__/upload-options.test.ts`
- `packages/storage/src/archive-audit.ts`
- `packages/storage/src/download-budget.ts`
- `packages/storage/src/index.ts`

## Audit Trail

- EXTRACTED: 110 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*