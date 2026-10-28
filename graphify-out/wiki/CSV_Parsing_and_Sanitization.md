# CSV Parsing and Sanitization

> 16 nodes

## Key Concepts

- **import/types.ts** (12 connections) — `packages/core/src/import/types.ts`
- **parseCSVContent()** (9 connections) — `packages/core/src/import/csv-parser.ts`
- **csv-parser.ts** (9 connections) — `packages/core/src/import/csv-parser.ts`
- **file-parser.ts** (8 connections) — `packages/core/src/import/file-parser.ts`
- **sanitize.ts** (8 connections) — `packages/core/src/import/sanitize.ts`
- **neutralizeFormulaCell()** (7 connections) — `packages/core/src/import/sanitize.ts`
- **parseXLSXContent()** (7 connections) — `packages/core/src/import/xlsx-parser.ts`
- **xlsx-parser.ts** (7 connections) — `packages/core/src/import/xlsx-parser.ts`
- **ParsedFileData** (5 connections) — `packages/core/src/import/types.ts`
- **sanitizeFormulaInjection()** (5 connections) — `packages/core/src/import/sanitize.ts`
- **parseFile()** (4 connections) — `packages/core/src/import/file-parser.ts`
- **detectDelimiter()** (3 connections) — `packages/core/src/import/csv-parser.ts`
- **findHeaderRow()** (3 connections) — `packages/core/src/import/csv-parser.ts`
- **neutralizeRawCell()** (3 connections) — `packages/core/src/import/sanitize.ts`
- **startsWithFormulaChar()** (3 connections) — `packages/core/src/import/sanitize.ts`
- **FORMULA_PREFIXES** (1 connections) — `packages/core/src/import/sanitize.ts`

## Relationships

- [Data Import Normalizers and Parsers](Data_Import_Normalizers_and_Parsers.md) (17 shared connections)
- [Broker Trade Import Processing](Broker_Trade_Import_Processing.md) (6 shared connections)
- [Broker File Format Detection](Broker_File_Format_Detection.md) (3 shared connections)

## Source Files

- `packages/core/src/import/csv-parser.ts`
- `packages/core/src/import/file-parser.ts`
- `packages/core/src/import/sanitize.ts`
- `packages/core/src/import/types.ts`
- `packages/core/src/import/xlsx-parser.ts`

## Audit Trail

- EXTRACTED: 59 (98%)
- INFERRED: 1 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*