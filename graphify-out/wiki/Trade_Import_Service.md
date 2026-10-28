# Trade Import Service

> 10 nodes

## Key Concepts

- **trade-import-service.test.ts** (10 connections) — `packages/services/__tests__/trade-import-service.test.ts`
- **RetryImportDeps** (3 connections) — `packages/services/src/trade-import.service.ts`
- **StartTradeImportDeps** (3 connections) — `packages/services/src/trade-import.service.ts`
- **retryImport()** (3 connections) — `packages/services/src/trade-import.service.ts`
- **startTradeImport()** (3 connections) — `packages/services/src/trade-import.service.ts`
- **DbCall** (1 connections) — `packages/services/__tests__/trade-import-service.test.ts`
- **fakeRetryDb()** (1 connections) — `packages/services/__tests__/trade-import-service.test.ts`
- **fakeStartDb()** (1 connections) — `packages/services/__tests__/trade-import-service.test.ts`
- **importLogWith()** (1 connections) — `packages/services/__tests__/trade-import-service.test.ts`
- **VALID_ROW** (1 connections) — `packages/services/__tests__/trade-import-service.test.ts`

## Relationships

- [Trade Import Deduplication](Trade_Import_Deduplication.md) (5 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [Broker Trade Import Processing](Broker_Trade_Import_Processing.md) (1 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (1 shared connections)

## Source Files

- `packages/services/__tests__/trade-import-service.test.ts`
- `packages/services/src/trade-import.service.ts`

## Audit Trail

- EXTRACTED: 18 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*