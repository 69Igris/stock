# Data Import Normalizers and Parsers

> 18 nodes

## Key Concepts

- **import/index.ts** (57 connections) — `packages/core/src/import/index.ts`
- **row-parser.ts** (17 connections) — `packages/core/src/import/row-parser.ts`
- **parseCSVRow()** (13 connections) — `packages/core/src/import/row-parser.ts`
- **normalizers.ts** (8 connections) — `packages/core/src/import/normalizers.ts`
- **TradeRow** (5 connections) — `packages/core/src/import/types.ts`
- **ColumnMapping** (4 connections) — `packages/core/src/import/types.ts`
- **ParsedTradeRow** (4 connections) — `packages/core/src/import/types.ts`
- **parseDate()** (4 connections) — `packages/core/src/import/date-parsers.ts`
- **parseDateTime()** (4 connections) — `packages/core/src/import/date-parsers.ts`
- **normalizeExchange()** (4 connections) — `packages/core/src/import/normalizers.ts`
- **normalizeSegment()** (4 connections) — `packages/core/src/import/normalizers.ts`
- **normalizeTradeType()** (4 connections) — `packages/core/src/import/normalizers.ts`
- **parseNumber()** (4 connections) — `packages/core/src/import/normalizers.ts`
- **splitExchangePrefixedSymbol()** (4 connections) — `packages/core/src/import/normalizers.ts`
- **date-parsers.ts** (4 connections) — `packages/core/src/import/date-parsers.ts`
- **normalizeColumnName()** (2 connections) — `packages/core/src/import/normalizers.ts`
- **findColumn()** (2 connections) — `packages/core/src/import/row-parser.ts`
- **looksLikeIsin()** (2 connections) — `packages/core/src/import/row-parser.ts`

## Relationships

- [CSV Parsing and Sanitization](CSV_Parsing_and_Sanitization.md) (17 shared connections)
- [SSRF Guard and Network Validation](SSRF_Guard_and_Network_Validation.md) (11 shared connections)
- [Broker File Format Detection](Broker_File_Format_Detection.md) (8 shared connections)
- [Broker Trade Import Processing](Broker_Trade_Import_Processing.md) (7 shared connections)
- [Trade Import Deduplication](Trade_Import_Deduplication.md) (5 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (1 shared connections)
- [Document Recovery Pipeline](Document_Recovery_Pipeline.md) (1 shared connections)
- [Vector Embeddings Service](Vector_Embeddings_Service.md) (1 shared connections)
- [Stock Document Text Extraction](Stock_Document_Text_Extraction.md) (1 shared connections)

## Source Files

- `packages/core/src/import/date-parsers.ts`
- `packages/core/src/import/index.ts`
- `packages/core/src/import/normalizers.ts`
- `packages/core/src/import/row-parser.ts`
- `packages/core/src/import/types.ts`

## Audit Trail

- EXTRACTED: 99 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*