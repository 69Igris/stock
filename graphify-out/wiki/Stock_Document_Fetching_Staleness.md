# Stock Document Fetching Staleness

> 44 nodes

## Key Concepts

- **stock-document-fetcher.ts** (55 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- **buildFullDocPath()** (22 connections) — `packages/research/src/data-sources/stock-document-paths.ts`
- **stock-document-paths.ts** (18 connections) — `packages/research/src/data-sources/stock-document-paths.ts`
- **getOrFetchFinancials()** (15 connections) — `packages/research/src/data-sources/db-store.ts`
- **getOrFetchStockDocuments()** (12 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- **seed-stock-documents.ts** (12 connections) — `scripts/seed/seed-stock-documents.ts`
- **isStale()** (11 connections) — `packages/core/src/market-data/staleness.ts`
- **fetchAndStoreNSEFilings()** (11 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- **fetchAndStoreScreenerDocs()** (11 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- **buildStockDocPath()** (10 connections) — `packages/research/src/data-sources/stock-document-paths.ts`
- **ABSENT_GCS_PATH** (8 connections) — `packages/research/src/data-sources/document-body-guard.ts`
- **fetchAndStoreFinancials()** (7 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- **fetchScreenerDocuments()** (5 connections) — `packages/research/src/data-sources/screener-client.ts`
- **staleness.ts** (5 connections) — `packages/core/src/market-data/staleness.ts`
- **uploadToStorage()** (4 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- **stock-document-paths.test.ts** (4 connections) — `packages/research/__tests__/stock-document-paths.test.ts`
- **delay()** (3 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- **formatRow()** (3 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- **inferDocExtension()** (3 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- **quarantineHtmlDownload()** (3 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- **buildDocFileName()** (3 connections) — `packages/research/src/data-sources/stock-document-paths.ts`
- **archiveSnapshot()** (3 connections) — `workers/src/processors/corporate-actions-sync.ts`
- **ScreenerDocument** (2 connections) — `packages/research/src/data-sources/screener-client.ts`
- **downloadPdfFromNSE()** (2 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- **ensureStockDocumentsExist()** (2 connections) — `packages/research/src/data-sources/stock-document-fetcher.ts`
- *... and 19 more nodes in this community*

## Relationships

- [Stock Document Synchronization](Stock_Document_Synchronization.md) (21 shared connections)
- [Stock Financials Normalization](Stock_Financials_Normalization.md) (14 shared connections)
- [BSE Announcements Backfill](BSE_Announcements_Backfill.md) (13 shared connections)
- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (7 shared connections)
- [Document Container Management](Document_Container_Management.md) (6 shared connections)
- [Financial Data Source Fallbacks](Financial_Data_Source_Fallbacks.md) (4 shared connections)
- [Corporate Issues Logic](Corporate_Issues_Logic.md) (4 shared connections)
- [Chartink Technical Scans Library](Chartink_Technical_Scans_Library.md) (3 shared connections)
- [YouTube Transcript Fetcher](YouTube_Transcript_Fetcher.md) (3 shared connections)
- [Document Recovery Pipeline](Document_Recovery_Pipeline.md) (3 shared connections)
- [NSE Announcements Sync](NSE_Announcements_Sync.md) (3 shared connections)
- [Corporate Actions Windows](Corporate_Actions_Windows.md) (3 shared connections)

## Source Files

- `packages/core/src/market-data/staleness.ts`
- `packages/research/__tests__/stock-document-paths.test.ts`
- `packages/research/src/data-sources/db-store.ts`
- `packages/research/src/data-sources/document-body-guard.ts`
- `packages/research/src/data-sources/screener-client.ts`
- `packages/research/src/data-sources/stock-document-fetcher.ts`
- `packages/research/src/data-sources/stock-document-paths.ts`
- `scripts/seed/seed-stock-documents.ts`
- `workers/src/processors/corporate-actions-sync.ts`

## Audit Trail

- EXTRACTED: 180 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*