# Broker Trade Import Processing

> 25 nodes

## Key Concepts

- **processors/import.ts** (32 connections) — `workers/src/processors/import.ts`
- **processImport()** (20 connections) — `workers/src/processors/import.ts`
- **import-logic.ts** (19 connections) — `workers/src/processors/import-logic.ts`
- **generateDuplicateHash()** (6 connections) — `packages/core/src/import/hash.ts`
- **resolveEffectiveBrokerFormat()** (5 connections) — `packages/core/src/import/format-detector.ts`
- **buildTradeCreateData()** (5 connections) — `workers/src/processors/import-logic.ts`
- **getColumnMapping()** (4 connections) — `packages/core/src/import/column-mappings.ts`
- **buildImportLogUpsertArgs()** (3 connections) — `workers/src/processors/import-logic.ts`
- **buildImportResult()** (3 connections) — `workers/src/processors/import-logic.ts`
- **buildJobStatusUpdate()** (3 connections) — `workers/src/processors/import-logic.ts`
- **isUniqueConstraintError()** (3 connections) — `workers/src/processors/import-logic.ts`
- **resolveImportStatus()** (3 connections) — `workers/src/processors/import-logic.ts`
- **upsertImportLog()** (3 connections) — `workers/src/processors/import.ts`
- **buildBrokerTradeId()** (2 connections) — `workers/src/processors/import-logic.ts`
- **buildTradeValue()** (2 connections) — `workers/src/processors/import-logic.ts`
- **hash.ts** (2 connections) — `packages/core/src/import/hash.ts`
- **BuildTradeResult** (1 connections) — `workers/src/processors/import-logic.ts`
- **ImportBrokerContext** (1 connections) — `workers/src/processors/import-logic.ts`
- **ImportJobResult** (1 connections) — `workers/src/processors/import-logic.ts`
- **ImportJobStatus** (1 connections) — `workers/src/processors/import-logic.ts`
- **ImportLogStatus** (1 connections) — `workers/src/processors/import-logic.ts`
- **ImportLogUpsertArgs** (1 connections) — `workers/src/processors/import-logic.ts`
- **ImportTradeCreateData** (1 connections) — `workers/src/processors/import-logic.ts`
- **ImportTradeRow** (1 connections) — `workers/src/processors/import-logic.ts`
- **MAX_IMPORT_RESULT_ERRORS** (1 connections) — `workers/src/processors/import-logic.ts`

## Relationships

- [Data Import Normalizers and Parsers](Data_Import_Normalizers_and_Parsers.md) (7 shared connections)
- [CSV Parsing and Sanitization](CSV_Parsing_and_Sanitization.md) (6 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (6 shared connections)
- [Broker File Format Detection](Broker_File_Format_Detection.md) (4 shared connections)
- [Trade Pairing Processor](Trade_Pairing_Processor.md) (3 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (2 shared connections)
- [SSRF Guard and Network Validation](SSRF_Guard_and_Network_Validation.md) (2 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [Trade Import Service](Trade_Import_Service.md) (1 shared connections)
- [Trade Import Deduplication](Trade_Import_Deduplication.md) (1 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)

## Source Files

- `packages/core/src/import/column-mappings.ts`
- `packages/core/src/import/format-detector.ts`
- `packages/core/src/import/hash.ts`
- `workers/src/processors/import-logic.ts`
- `workers/src/processors/import.ts`

## Audit Trail

- EXTRACTED: 81 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*