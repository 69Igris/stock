# Document Financial Ingestion Backfill

> 75 nodes

## Key Concepts

- **doc-ingest-backfill.ts** (133 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **runScanConvert()** (27 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **runSweep()** (25 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **runBatchBuild()** (22 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **main()** (21 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **runBatchIngest()** (21 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **mapDocumentFinancials()** (11 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **errText()** (10 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **Budget** (9 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **runBatchSubmit()** (9 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **resolveApply()** (8 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **countedWrite()** (7 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **.check()** (6 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **bump()** (6 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **assertSafeObjectKey()** (6 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **parseArgs()** (5 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **loadConverter()** (4 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **pickPilotDocumentIds()** (4 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **stampRefusedByBatchLane()** (4 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **upsertExtract()** (4 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **whereOf()** (4 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **.elapsedMs()** (3 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **describeApply()** (3 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **fetchBatchResults()** (3 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- **gb()** (3 connections) — `scripts/jobs/doc-ingest-backfill.ts`
- *... and 50 more nodes in this community*

## Relationships

- [Document Ingestion Query Selectors](Document_Ingestion_Query_Selectors.md) (20 shared connections)
- [PDF Document OCR Conversion](PDF_Document_OCR_Conversion.md) (16 shared connections)
- [Gemini Filing Analysis](Gemini_Filing_Analysis.md) (16 shared connections)
- [Financial Extraction Processing](Financial_Extraction_Processing.md) (10 shared connections)
- [Document Page Selection](Document_Page_Selection.md) (8 shared connections)
- [Stock Document Text Extraction](Stock_Document_Text_Extraction.md) (7 shared connections)
- [Vector Embeddings Service](Vector_Embeddings_Service.md) (7 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (6 shared connections)
- [Gemini Document Prompt Logic](Gemini_Document_Prompt_Logic.md) (6 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (5 shared connections)
- [Stock Document Parsing Pipeline](Stock_Document_Parsing_Pipeline.md) (4 shared connections)
- [Feed Archive Header Auditing](Feed_Archive_Header_Auditing.md) (4 shared connections)

## Source Files

- `packages/core/src/market-data/document-financials-logic.ts`
- `scripts/jobs/doc-ingest-backfill.ts`
- `workers/src/processors/stock-document-extract-logic.ts`

## Audit Trail

- EXTRACTED: 276 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*