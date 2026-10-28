# Financial Extraction Processing

> 69 nodes

## Key Concepts

- **document-financials-logic.ts** (73 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **document-financials-logic.test.ts** (29 connections) — `packages/core/__tests__/market-data/document-financials-logic.test.ts`
- **mapPeriodExtract()** (18 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **doc-extract-persist.ts** (11 connections) — `workers/src/processors/doc-extract-persist.ts`
- **buildExtractWritePayload()** (6 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **upsertExtract()** (6 connections) — `workers/src/processors/doc-extract-persist.ts`
- **resolveScale()** (5 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **DOC_FINANCIALS_PROMPT_VERSION** (4 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **DOCUMENT_FINANCIALS_SCHEMA** (4 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **ExtractionVerdict** (3 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **MappedExtract** (3 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **applyScale()** (3 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **hasNonFiniteRawFigure()** (3 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **isPeriodEndInRange()** (3 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **normaliseCapexSign()** (3 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **parsePeriodEnd()** (3 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **statementHasFigure()** (3 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **unscaled()** (3 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **DocResponseSchema** (2 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **RawPeriodExtract** (2 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **ScaleUnit** (2 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **applyScaleInference()** (2 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **inferScale()** (2 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **isDocFinancialsApplyArmed()** (2 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- **isoDay()** (2 connections) — `packages/core/src/market-data/document-financials-logic.ts`
- *... and 44 more nodes in this community*

## Relationships

- [Document Financial Ingestion Backfill](Document_Financial_Ingestion_Backfill.md) (10 shared connections)
- [Stock Document Parsing Pipeline](Stock_Document_Parsing_Pipeline.md) (7 shared connections)
- [Document Ingestion Query Selectors](Document_Ingestion_Query_Selectors.md) (4 shared connections)
- [Gemini Filing Analysis](Gemini_Filing_Analysis.md) (3 shared connections)
- [Document Financials Projection](Document_Financials_Projection.md) (3 shared connections)
- [Gemini Document Prompt Logic](Gemini_Document_Prompt_Logic.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/document-financials-logic.test.ts`
- `packages/core/src/market-data/document-financials-logic.ts`
- `workers/src/processors/doc-extract-persist.ts`

## Audit Trail

- EXTRACTED: 141 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*