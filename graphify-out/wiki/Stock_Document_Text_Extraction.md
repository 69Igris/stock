# Stock Document Text Extraction

> 50 nodes

## Key Concepts

- **processors/stock-document-extract.ts** (46 connections) — `workers/src/processors/stock-document-extract.ts`
- **stock-document-extract-logic.ts** (44 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **money1319-container-lane-invariant.test.ts** (29 connections) — `workers/__tests__/processors/money1319-container-lane-invariant.test.ts`
- **processStockDocumentExtract()** (23 connections) — `workers/src/processors/stock-document-extract.ts`
- **money1319-extract-archive.test.ts** (14 connections) — `workers/__tests__/processors/money1319-extract-archive.test.ts`
- **buildGcsUri()** (10 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **resolveExtractionSource()** (8 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **sidecarIsPageIncomplete()** (6 connections) — `packages/core/src/market-data/doc-convert-logic.ts`
- **EXTRACTABLE_DOC_MIME_TYPES** (6 connections) — `packages/core/src/market-data/doc-mime.ts`
- **chainAnotherBatch()** (5 connections) — `workers/src/processors/stock-document-extract.ts`
- **buildExtractQuery()** (5 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **MAX_TEXT_LENGTH** (5 connections) — `workers/src/processors/document-process-logic.ts`
- **decideTextSource()** (4 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **shouldFetchFromSource()** (4 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **triggerEmbedPass()** (4 connections) — `workers/src/processors/stock-document-extract.ts`
- **isWithinRunBudget()** (3 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **normalizeChainDepth()** (3 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **shouldChainAnotherBatch()** (3 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **CONTAINER_DOC_MIME_TYPES** (3 connections) — `packages/core/src/market-data/doc-mime.ts`
- **ExtractionSource** (2 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **isFetchableSourceUrl()** (2 connections) — `workers/src/processors/stock-document-extract-logic.ts`
- **findSelectionSites()** (2 connections) — `workers/__tests__/processors/money1319-container-lane-invariant.test.ts`
- **walkTs()** (2 connections) — `workers/__tests__/processors/money1319-container-lane-invariant.test.ts`
- **localHeader()** (2 connections) — `workers/__tests__/processors/money1319-extract-archive.test.ts`
- **zip()** (2 connections) — `workers/__tests__/processors/money1319-extract-archive.test.ts`
- *... and 25 more nodes in this community*

## Relationships

- [Document Container Management](Document_Container_Management.md) (19 shared connections)
- [Vector Embeddings Service](Vector_Embeddings_Service.md) (11 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (10 shared connections)
- [Document Ingestion Query Selectors](Document_Ingestion_Query_Selectors.md) (10 shared connections)
- [Stock Document Parsing Pipeline](Stock_Document_Parsing_Pipeline.md) (8 shared connections)
- [Document Financial Ingestion Backfill](Document_Financial_Ingestion_Backfill.md) (7 shared connections)
- [Google Cloud Credentials Handler](Google_Cloud_Credentials_Handler.md) (7 shared connections)
- [Vertex AI RAG Retrieval](Vertex_AI_RAG_Retrieval.md) (5 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [PDF Document OCR Conversion](PDF_Document_OCR_Conversion.md) (3 shared connections)
- [Stock Document Synchronization](Stock_Document_Synchronization.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)

## Source Files

- `packages/core/src/market-data/doc-convert-logic.ts`
- `packages/core/src/market-data/doc-mime.ts`
- `pdf-parse`
- `workers/__tests__/processors/money1319-container-lane-invariant.test.ts`
- `workers/__tests__/processors/money1319-extract-archive.test.ts`
- `workers/src/processors/document-process-logic.ts`
- `workers/src/processors/stock-document-extract-logic.ts`
- `workers/src/processors/stock-document-extract.ts`

## Audit Trail

- EXTRACTED: 182 (99%)
- INFERRED: 2 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*