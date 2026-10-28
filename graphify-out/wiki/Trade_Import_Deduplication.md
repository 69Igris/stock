# Trade Import Deduplication

> 45 nodes

## Key Concepts

- **trade-import.service.ts** (62 connections) — `packages/services/src/trade-import.service.ts`
- **trade-import-logic.ts** (31 connections) — `packages/services/src/trade-import-logic.ts`
- **finite()** (7 connections) — `packages/services/src/trade-import-logic.ts`
- **summarizeImport()** (6 connections) — `packages/services/src/trade-import-logic.ts`
- **computeImportProgress()** (4 connections) — `packages/services/src/trade-import-logic.ts`
- **determineImportStatus()** (4 connections) — `packages/services/src/trade-import-logic.ts`
- **mapRowToTradeInput()** (4 connections) — `packages/services/src/trade-import-logic.ts`
- **rollupDuplicateCount()** (4 connections) — `packages/services/src/trade-import-logic.ts`
- **clampPercent()** (3 connections) — `packages/services/src/trade-import-logic.ts`
- **getTradePriority()** (3 connections) — `packages/services/src/trade-import-logic.ts`
- **mapParsedRowToTradeInput()** (3 connections) — `packages/services/src/trade-import-logic.ts`
- **resolveDuplicate()** (3 connections) — `packages/services/src/trade-import-logic.ts`
- **DuplicateAction** (2 connections) — `packages/services/src/trade-import-logic.ts`
- **DuplicateBucket** (2 connections) — `packages/services/src/trade-import-logic.ts`
- **DuplicateCounters** (2 connections) — `packages/services/src/trade-import-logic.ts`
- **DuplicateResolution** (2 connections) — `packages/services/src/trade-import-logic.ts`
- **ExistingTradeForDedup** (2 connections) — `packages/services/src/trade-import-logic.ts`
- **ImportStatus** (2 connections) — `packages/services/src/trade-import-logic.ts`
- **ImportSummary** (2 connections) — `packages/services/src/trade-import-logic.ts`
- **ImportSummaryInput** (2 connections) — `packages/services/src/trade-import-logic.ts`
- **MapRowContext** (2 connections) — `packages/services/src/trade-import-logic.ts`
- **MapRowResult** (2 connections) — `packages/services/src/trade-import-logic.ts`
- **NewTradeLinking** (2 connections) — `packages/services/src/trade-import-logic.ts`
- **TradeCreateData** (2 connections) — `packages/services/src/trade-import-logic.ts`
- **TradeSourceType** (2 connections) — `packages/services/src/trade-import-logic.ts`
- *... and 20 more nodes in this community*

## Relationships

- [Data Import Normalizers and Parsers](Data_Import_Normalizers_and_Parsers.md) (5 shared connections)
- [Trade Import Service](Trade_Import_Service.md) (5 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (4 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (2 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (2 shared connections)
- [Broker Trade Import Processing](Broker_Trade_Import_Processing.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (1 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (1 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)

## Source Files

- `packages/services/src/trade-import-logic.ts`
- `packages/services/src/trade-import.service.ts`

## Audit Trail

- EXTRACTED: 106 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*