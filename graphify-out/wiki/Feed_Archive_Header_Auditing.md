# Feed Archive Header Auditing

> 39 nodes

## Key Concepts

- **feed-repair.ts** (35 connections) — `scripts/jobs/feed-repair.ts`
- **archive-audit.ts** (27 connections) — `packages/storage/src/archive-audit.ts`
- **stripMultipartEnvelope()** (23 connections) — `packages/storage/src/multipart-envelope.ts`
- **archive-audit.test.ts** (18 connections) — `packages/storage/__tests__/archive-audit.test.ts`
- **main()** (15 connections) — `scripts/jobs/feed-repair.ts`
- **isMultipartEnvelope()** (13 connections) — `packages/storage/src/multipart-envelope.ts`
- **classifyArchivedObject()** (11 connections) — `packages/storage/src/archive-audit.ts`
- **classifyPayloadBytes()** (8 connections) — `packages/storage/src/archive-audit.ts`
- **isEnvelopeVerdictKind()** (7 connections) — `packages/storage/src/archive-audit.ts`
- **runAudit()** (7 connections) — `scripts/jobs/feed-repair.ts`
- **FailureReporter** (6 connections) — `scripts/jobs/feed-repair.ts`
- **archiveFamilyOf()** (6 connections) — `packages/storage/src/archive-audit.ts`
- **ARCHIVE_AUDIT_HEAD_BYTES** (6 connections) — `packages/storage/src/archive-audit.ts`
- **emptyFamilyAudit()** (5 connections) — `packages/storage/src/archive-audit.ts`
- **recordArchiveVerdict()** (5 connections) — `packages/storage/src/archive-audit.ts`
- **ArchiveVerdictKind** (4 connections) — `packages/storage/src/archive-audit.ts`
- **familyDeclaresHtmlPayload()** (4 connections) — `packages/storage/src/archive-audit.ts`
- **verifyPayload()** (4 connections) — `scripts/jobs/feed-repair.ts`
- **ArchiveFamilyAudit** (3 connections) — `packages/storage/src/archive-audit.ts`
- **resolveContainerMi()** (3 connections) — `scripts/jobs/feed-repair.ts`
- **ENVELOPE_VERDICT_KINDS** (3 connections) — `packages/storage/src/archive-audit.ts`
- **looksLikeHtml()** (2 connections) — `packages/storage/src/archive-audit.ts`
- **classify()** (2 connections) — `packages/storage/__tests__/archive-audit.test.ts`
- **contentTypeFor()** (2 connections) — `scripts/jobs/feed-repair.ts`
- **.codeForError()** (2 connections) — `scripts/jobs/feed-repair.ts`
- *... and 14 more nodes in this community*

## Relationships

- [Storage Download Budget Manager](Storage_Download_Budget_Manager.md) (23 shared connections)
- [Document Body Guard Recovery](Document_Body_Guard_Recovery.md) (7 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (6 shared connections)
- [Multipart Envelope Processing](Multipart_Envelope_Processing.md) (6 shared connections)
- [Stock Document Validation Quarantine](Stock_Document_Validation_Quarantine.md) (5 shared connections)
- [Document Financial Ingestion Backfill](Document_Financial_Ingestion_Backfill.md) (4 shared connections)
- [PDF Document OCR Conversion](PDF_Document_OCR_Conversion.md) (4 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (3 shared connections)
- [Google Cloud Credentials Handler](Google_Cloud_Credentials_Handler.md) (3 shared connections)
- [Document Container Management](Document_Container_Management.md) (2 shared connections)
- [Document Recovery Pipeline](Document_Recovery_Pipeline.md) (2 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (2 shared connections)

## Source Files

- `packages/storage/__tests__/archive-audit.test.ts`
- `packages/storage/src/archive-audit.ts`
- `packages/storage/src/multipart-envelope.ts`
- `scripts/jobs/feed-repair.ts`

## Audit Trail

- EXTRACTED: 154 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*