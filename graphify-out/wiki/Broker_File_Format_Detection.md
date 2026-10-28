# Broker File Format Detection

> 12 nodes

## Key Concepts

- **format-detector.ts** (10 connections) — `packages/core/src/import/format-detector.ts`
- **column-mappings.ts** (8 connections) — `packages/core/src/import/column-mappings.ts`
- **BrokerFormat** (7 connections) — `packages/core/src/import/types.ts`
- **detectBrokerFormat()** (4 connections) — `packages/core/src/import/format-detector.ts`
- **DetectionResult** (3 connections) — `packages/core/src/import/format-detector.ts`
- **normalizeHeaderToken()** (3 connections) — `packages/core/src/import/format-detector.ts`
- **BrokerSignature** (2 connections) — `packages/core/src/import/format-detector.ts`
- **brokerFormatLabel()** (2 connections) — `packages/core/src/import/format-detector.ts`
- **ANGEL_MAPPING** (1 connections) — `packages/core/src/import/column-mappings.ts`
- **COLUMN_MAPPINGS** (1 connections) — `packages/core/src/import/column-mappings.ts`
- **SIGNATURES** (1 connections) — `packages/core/src/import/format-detector.ts`
- **IMPORTANT: `findColumn` matches a header EXACTLY (case-insensitively) — it does** (1 connections) — `packages/core/src/import/column-mappings.ts`

## Relationships

- [Data Import Normalizers and Parsers](Data_Import_Normalizers_and_Parsers.md) (8 shared connections)
- [Broker Trade Import Processing](Broker_Trade_Import_Processing.md) (4 shared connections)
- [CSV Parsing and Sanitization](CSV_Parsing_and_Sanitization.md) (3 shared connections)

## Source Files

- `packages/core/src/import/column-mappings.ts`
- `packages/core/src/import/format-detector.ts`
- `packages/core/src/import/types.ts`

## Audit Trail

- EXTRACTED: 28 (97%)
- INFERRED: 1 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*