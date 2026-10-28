# Stock Document Parsing Pipeline

> 56 nodes

## Key Concepts

- **processors/stock-document-parse.ts** (52 connections) — `workers/src/processors/stock-document-parse.ts`
- **stock-document-parse-logic.ts** (44 connections) — `workers/src/processors/stock-document-parse-logic.ts`
- **stock-document-parse-logic.test.ts** (33 connections) — `workers/__tests__/processors/stock-document-parse-logic.test.ts`
- **processStockDocumentParse()** (26 connections) — `workers/src/processors/stock-document-parse.ts`
- **money1259-parse-throughput.test.ts** (11 connections) — `workers/__tests__/processors/money1259-parse-throughput.test.ts`
- **routes/stock-document-parse.ts** (9 connections) — `workers/src/routes/stock-document-parse.ts`
- **chainAnotherBatch()** (6 connections) — `workers/src/processors/stock-document-parse.ts`
- **errText()** (6 connections) — `workers/src/processors/stock-document-parse.ts`
- **buildParseQuery()** (6 connections) — `workers/src/processors/stock-document-parse-logic.ts`
- **buildPhaseQuery()** (6 connections) — `workers/src/processors/stock-document-parse-logic.ts`
- **canPhaseOnCoveredSymbols()** (6 connections) — `workers/src/processors/stock-document-parse-logic.ts`
- **selectBreadthFirst()** (6 connections) — `workers/src/processors/stock-document-parse-logic.ts`
- **summarisePhases()** (6 connections) — `workers/src/processors/stock-document-parse.ts`
- **buildDocumentFinancialsPrompt()** (5 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **markParseStatus()** (5 connections) — `workers/src/processors/doc-extract-persist.ts`
- **phasesToRun()** (5 connections) — `workers/src/processors/stock-document-parse-logic.ts`
- **resolveDocumentParseStatus()** (5 connections) — `workers/src/processors/stock-document-parse-logic.ts`
- **tallyReasons()** (5 connections) — `workers/src/processors/stock-document-parse-logic.ts`
- **DIRECT_DOC_MIME_TYPES** (5 connections) — `packages/core/src/market-data/doc-mime.ts`
- **buildClaimWhere()** (4 connections) — `workers/src/processors/stock-document-parse-logic.ts`
- **describeCohortProgress()** (4 connections) — `workers/src/processors/stock-document-parse-logic.ts`
- **isWithinRunBudget()** (4 connections) — `workers/src/processors/stock-document-parse-logic.ts`
- **normalizeChainDepth()** (4 connections) — `workers/src/processors/stock-document-parse-logic.ts`
- **shouldChainAnotherBatch()** (4 connections) — `workers/src/processors/stock-document-parse-logic.ts`
- **parse-selector-is-valid-prisma.test.ts** (4 connections) — `packages/core/__tests__/market-data/parse-selector-is-valid-prisma.test.ts`
- *... and 31 more nodes in this community*

## Relationships

- [Stock Document Text Extraction](Stock_Document_Text_Extraction.md) (8 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (8 shared connections)
- [Financial Extraction Processing](Financial_Extraction_Processing.md) (7 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (7 shared connections)
- [Gemini Filing Analysis](Gemini_Filing_Analysis.md) (6 shared connections)
- [Document Ingestion Query Selectors](Document_Ingestion_Query_Selectors.md) (4 shared connections)
- [Document Financial Ingestion Backfill](Document_Financial_Ingestion_Backfill.md) (4 shared connections)
- [Vector Embeddings Service](Vector_Embeddings_Service.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Document Container Management](Document_Container_Management.md) (3 shared connections)
- [BSE Announcements Backfill](BSE_Announcements_Backfill.md) (2 shared connections)
- [Stock Document Synchronization](Stock_Document_Synchronization.md) (2 shared connections)

## Source Files

- `packages/core/__tests__/market-data/parse-selector-is-valid-prisma.test.ts`
- `packages/core/src/market-data/doc-mime.ts`
- `packages/core/src/market-data/document-financials-logic.ts`
- `workers/__tests__/processors/money1259-parse-throughput.test.ts`
- `workers/__tests__/processors/stock-document-parse-logic.test.ts`
- `workers/src/processors/doc-extract-persist.ts`
- `workers/src/processors/stock-document-parse-logic.ts`
- `workers/src/processors/stock-document-parse.ts`
- `workers/src/routes/stock-document-parse.ts`

## Audit Trail

- EXTRACTED: 198 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*