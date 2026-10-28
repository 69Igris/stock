# Document Ingestion Query Selectors

> 40 nodes

## Key Concepts

- **processors/stock-document-ingest.ts** (46 connections) — `workers/src/processors/stock-document-ingest.ts`
- **doc-ingest-selectors-logic.ts** (22 connections) — `workers/src/processors/doc-ingest-selectors-logic.ts`
- **stock-document-ingest-logic.ts** (17 connections) — `workers/src/processors/stock-document-ingest-logic.ts`
- **doc-ingest-isset-arms.test.ts** (17 connections) — `workers/__tests__/processors/doc-ingest-isset-arms.test.ts`
- **processStockDocumentIngest()** (15 connections) — `workers/src/processors/stock-document-ingest.ts`
- **stock-document-ingest-logic.test.ts** (13 connections) — `workers/__tests__/processors/stock-document-ingest-logic.test.ts`
- **runLane()** (12 connections) — `workers/src/processors/stock-document-ingest.ts`
- **decideIngestLane()** (8 connections) — `workers/src/processors/stock-document-ingest-logic.ts`
- **classifyIngestOutcome()** (7 connections) — `workers/src/processors/stock-document-ingest-logic.ts`
- **buildConvertQuery()** (5 connections) — `workers/src/processors/doc-ingest-selectors-logic.ts`
- **buildSweepQuery()** (5 connections) — `workers/src/processors/doc-ingest-selectors-logic.ts`
- **exceedsVisionCeiling()** (5 connections) — `workers/src/processors/stock-document-ingest-logic.ts`
- **MAX_PDF_BYTES** (5 connections) — `workers/src/lib/gemini-pdf.ts`
- **CONVERT_STATUS** (5 connections) — `workers/src/processors/doc-ingest-selectors-logic.ts`
- **buildBatchIngestQuery()** (4 connections) — `workers/src/processors/doc-ingest-selectors-logic.ts`
- **buildShardWhere()** (4 connections) — `workers/src/processors/doc-ingest-selectors-logic.ts`
- **splitPageMarkedMarkdown()** (4 connections) — `workers/src/processors/stock-document-ingest-logic.ts`
- **STALE_PROCESSING_MS** (4 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **INGEST_PARSE_STATUS** (4 connections) — `workers/src/processors/stock-document-ingest-logic.ts`
- **buildConvertClaimWhere()** (3 connections) — `workers/src/processors/doc-ingest-selectors-logic.ts`
- **hasUsableTextLayer()** (3 connections) — `workers/src/processors/stock-document-ingest-logic.ts`
- **judge()** (3 connections) — `workers/src/processors/stock-document-ingest.ts`
- **BATCH_PARSE_STATUS** (3 connections) — `workers/src/processors/doc-ingest-selectors-logic.ts`
- **SWEEPABLE_PARSE_STATUS** (3 connections) — `workers/src/processors/doc-ingest-selectors-logic.ts`
- **TERMINAL_PARSE_STATUSES** (3 connections) — `workers/src/processors/stock-document-ingest-logic.ts`
- *... and 15 more nodes in this community*

## Relationships

- [Document Financial Ingestion Backfill](Document_Financial_Ingestion_Backfill.md) (20 shared connections)
- [Gemini Filing Analysis](Gemini_Filing_Analysis.md) (14 shared connections)
- [Stock Document Text Extraction](Stock_Document_Text_Extraction.md) (10 shared connections)
- [Vector Embeddings Service](Vector_Embeddings_Service.md) (6 shared connections)
- [PDF Document OCR Conversion](PDF_Document_OCR_Conversion.md) (6 shared connections)
- [Stock Document Parsing Pipeline](Stock_Document_Parsing_Pipeline.md) (4 shared connections)
- [Financial Extraction Processing](Financial_Extraction_Processing.md) (4 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Document Page Selection](Document_Page_Selection.md) (3 shared connections)
- [Gemini Document Prompt Logic](Gemini_Document_Prompt_Logic.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (2 shared connections)
- [JSON Response Helpers](JSON_Response_Helpers.md) (1 shared connections)

## Source Files

- `workers/__tests__/processors/doc-ingest-isset-arms.test.ts`
- `workers/__tests__/processors/stock-document-ingest-logic.test.ts`
- `workers/src/lib/gemini-pdf.ts`
- `workers/src/processors/doc-ingest-selectors-logic.ts`
- `workers/src/processors/stock-document-extract-logic.ts`
- `workers/src/processors/stock-document-ingest-logic.ts`
- `workers/src/processors/stock-document-ingest.ts`

## Audit Trail

- EXTRACTED: 161 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*