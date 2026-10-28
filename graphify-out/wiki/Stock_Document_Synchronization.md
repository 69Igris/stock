# Stock Document Synchronization

> 112 nodes

## Key Concepts

- **processors/stock-document-sync.ts** (103 connections) — `workers/src/processors/stock-document-sync.ts`
- **stock-document-sync-logic.ts** (57 connections) — `workers/src/processors/stock-document-sync-logic.ts`
- **processStockDocumentSync()** (37 connections) — `workers/src/processors/stock-document-sync.ts`
- **money1238-written-means-writes.test.ts** (23 connections) — `workers/__tests__/processors/money1238-written-means-writes.test.ts`
- **money1255-document-sync-rotation.test.ts** (23 connections) — `workers/__tests__/processors/money1255-document-sync-rotation.test.ts`
- **initialProcessingStatus()** (21 connections) — `packages/core/src/market-data/doc-mime.ts`
- **resolveStoredMimeType()** (19 connections) — `packages/core/src/market-data/doc-container.ts`
- **money1315-html-write-guard.test.ts** (18 connections) — `workers/__tests__/processors/money1315-html-write-guard.test.ts`
- **mayStoreDocumentBody()** (15 connections) — `packages/research/src/data-sources/document-body-guard.ts`
- **publishDocumentIngest()** (13 connections) — `workers/src/lib/doc-ingest-publish.ts`
- **storeAnnualReport()** (10 connections) — `workers/src/processors/annual-reports-sync.ts`
- **storeNSEFiling()** (10 connections) — `workers/src/processors/stock-document-sync.ts`
- **storeScreenerDoc()** (10 connections) — `workers/src/processors/stock-document-sync.ts`
- **runNseWith()** (7 connections) — `workers/__tests__/processors/money1315-html-write-guard.test.ts`
- **StockDocumentSyncMessage** (6 connections) — `packages/types/src/pubsub.ts`
- **cleanSymbol()** (6 connections) — `workers/src/processors/stock-document-sync-logic.ts`
- **runWith()** (6 connections) — `workers/__tests__/processors/money1315-html-write-guard.test.ts`
- **formatFinancialsForDocument()** (5 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- **isValidEquitySymbol()** (5 connections) — `workers/src/processors/stock-document-sync-logic.ts`
- **partitionSymbolPage()** (5 connections) — `workers/src/processors/stock-document-sync-logic.ts`
- **resolveEnabledLegs()** (5 connections) — `workers/src/processors/stock-document-sync-logic.ts`
- **BseOnlyCounters** (4 connections) — `workers/src/processors/stock-document-sync-logic.ts`
- **WritesBySource** (4 connections) — `workers/src/processors/stock-document-sync-logic.ts`
- **describeSyncShortfall()** (4 connections) — `workers/src/processors/stock-document-sync-logic.ts`
- **inferExtension()** (4 connections) — `workers/src/processors/stock-document-sync-logic.ts`
- *... and 87 more nodes in this community*

## Relationships

- [Stock Document Fetching Staleness](Stock_Document_Fetching_Staleness.md) (21 shared connections)
- [Document Container Management](Document_Container_Management.md) (20 shared connections)
- [Corporate Issues Logic](Corporate_Issues_Logic.md) (16 shared connections)
- [BSE Announcements Backfill](BSE_Announcements_Backfill.md) (12 shared connections)
- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (10 shared connections)
- [Screener Company Symbol Resolver](Screener_Company_Symbol_Resolver.md) (9 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (8 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (7 shared connections)
- [NSE Announcements Sync](NSE_Announcements_Sync.md) (6 shared connections)
- [Stock News Feed Synchronization](Stock_News_Feed_Synchronization.md) (4 shared connections)
- [Document Recovery Pipeline](Document_Recovery_Pipeline.md) (4 shared connections)
- [Stock Document Text Extraction](Stock_Document_Text_Extraction.md) (3 shared connections)

## Source Files

- `packages/core/src/market-data/doc-container.ts`
- `packages/core/src/market-data/doc-mime.ts`
- `packages/research/src/data-sources/document-body-guard.ts`
- `packages/research/src/data-sources/stock-document-fetcher.ts`
- `packages/types/src/pubsub.ts`
- `workers/__tests__/processors/money1238-written-means-writes.test.ts`
- `workers/__tests__/processors/money1255-document-sync-rotation.test.ts`
- `workers/__tests__/processors/money1257-digit-led-symbols.test.ts`
- `workers/__tests__/processors/money1315-html-write-guard.test.ts`
- `workers/src/lib/doc-ingest-publish.ts`
- `workers/src/processors/annual-reports-sync.ts`
- `workers/src/processors/filings-sync.ts`
- `workers/src/processors/news-sync.ts`
- `workers/src/processors/stock-document-sync-logic.ts`
- `workers/src/processors/stock-document-sync.ts`

## Audit Trail

- EXTRACTED: 362 (98%)
- INFERRED: 6 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*