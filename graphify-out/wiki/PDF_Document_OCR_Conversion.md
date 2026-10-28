# PDF Document OCR Conversion

> 63 nodes

## Key Concepts

- **doc-convert.ts** (39 connections) — `workers/src/lib/doc-convert.ts`
- **doc-convert-logic.ts** (18 connections) — `packages/core/src/market-data/doc-convert-logic.ts`
- **convertPdfToMarkdown()** (17 connections) — `workers/src/lib/doc-convert.ts`
- **doc-number-normaliser-logic.ts** (14 connections) — `packages/core/src/market-data/doc-number-normaliser-logic.ts`
- **doc-convert-logic.test.ts** (13 connections) — `packages/core/__tests__/market-data/doc-convert-logic.test.ts`
- **doc-convert.test.ts** (13 connections) — `workers/__tests__/lib/doc-convert.test.ts`
- **normaliseDocumentMarkdown()** (11 connections) — `packages/core/src/market-data/doc-number-normaliser-logic.ts`
- **doc-convert-memory.test.ts** (10 connections) — `workers/__tests__/doc-convert-memory.test.ts`
- **assessExtraction()** (7 connections) — `packages/core/src/market-data/doc-convert-logic.ts`
- **estimatePeakRssBytes()** (7 connections) — `packages/core/src/market-data/doc-convert-logic.ts`
- **joinPagesToMarkdown()** (7 connections) — `packages/core/src/market-data/doc-convert-logic.ts`
- **doc-number-normaliser-logic.test.ts** (7 connections) — `packages/core/__tests__/market-data/doc-number-normaliser-logic.test.ts`
- **describeNonPdf()** (6 connections) — `packages/core/src/market-data/doc-convert-logic.ts`
- **looksLikePdf()** (6 connections) — `packages/core/src/market-data/doc-convert-logic.ts`
- **assessTable()** (5 connections) — `packages/core/src/market-data/doc-number-normaliser-logic.ts`
- **maxEstimatedRssBytes()** (5 connections) — `workers/src/lib/doc-convert.ts`
- **ExtractedPage** (4 connections) — `packages/core/src/market-data/doc-convert-logic.ts`
- **pageNeedsOcr()** (4 connections) — `packages/core/src/market-data/doc-convert-logic.ts`
- **containerMemoryMi()** (4 connections) — `workers/src/lib/doc-convert.ts`
- **ConvertAssessment** (3 connections) — `packages/core/src/market-data/doc-convert-logic.ts`
- **detectMergedColumns()** (3 connections) — `packages/core/src/market-data/doc-number-normaliser-logic.ts`
- **detectOrphanDigits()** (3 connections) — `packages/core/src/market-data/doc-number-normaliser-logic.ts`
- **normaliseRupeeSign()** (3 connections) — `packages/core/src/market-data/doc-number-normaliser-logic.ts`
- **acquire()** (3 connections) — `workers/src/lib/doc-convert.ts`
- **getExtractFn()** (3 connections) — `workers/src/lib/doc-convert.ts`
- *... and 38 more nodes in this community*

## Relationships

- [Document Financial Ingestion Backfill](Document_Financial_Ingestion_Backfill.md) (16 shared connections)
- [Document Ingestion Query Selectors](Document_Ingestion_Query_Selectors.md) (6 shared connections)
- [Feed Archive Header Auditing](Feed_Archive_Header_Auditing.md) (4 shared connections)
- [Stock Document Text Extraction](Stock_Document_Text_Extraction.md) (3 shared connections)
- [Storage Download Budget Manager](Storage_Download_Budget_Manager.md) (1 shared connections)
- [Worker Package Dependencies](Worker_Package_Dependencies.md) (1 shared connections)

## Source Files

- `@firecrawl/pdf-inspector`
- `packages/core/__tests__/market-data/doc-convert-logic.test.ts`
- `packages/core/__tests__/market-data/doc-number-normaliser-logic.test.ts`
- `packages/core/src/market-data/doc-convert-logic.ts`
- `packages/core/src/market-data/doc-number-normaliser-logic.ts`
- `workers/__tests__/doc-convert-memory.test.ts`
- `workers/__tests__/lib/doc-convert.test.ts`
- `workers/package.json`
- `workers/src/lib/doc-convert.ts`

## Audit Trail

- EXTRACTED: 149 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*