# NSE Corporate Filings Client

> 110 nodes

## Key Concepts

- **nse-filings.ts** (62 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **screener-full-scraper.ts** (38 connections) — `packages/research/src/data-sources/screener-full-scraper.ts`
- **nse-filings-logic.ts** (34 connections) — `packages/research/src/data-sources/nse-filings-logic.ts`
- **fetchNseApiJson()** (19 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **nse-filings-archive.test.ts** (19 connections) — `packages/research/__tests__/nse-filings-archive.test.ts`
- **nse-json-archive.ts** (18 connections) — `packages/research/src/data-sources/nse-json-archive.ts`
- **archiveNseJsonResponse()** (17 connections) — `packages/research/src/data-sources/nse-json-archive.ts`
- **scrapeScreenerFullPage()** (17 connections) — `packages/research/src/data-sources/screener-full-scraper.ts`
- **CorporateActionType** (11 connections) — `packages/research/src/data-sources/nse-filings-types.ts`
- **parseActionSubject()** (11 connections) — `packages/research/src/data-sources/nse-filings-logic.ts`
- **fetchNSECorporateActionsBulk()** (10 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **fetchNSEFinancialResults()** (10 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **nse-fii-dii-archive.test.ts** (10 connections) — `packages/research/__tests__/nse-fii-dii-archive.test.ts`
- **nse-filings-types.ts** (9 connections) — `packages/research/src/data-sources/nse-filings-types.ts`
- **StockDocumentSyncDeps** (8 connections) — `workers/src/processors/stock-document-sync.ts`
- **fetchNSEAnnouncements()** (8 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **getSession()** (8 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **NSECorporateAction** (7 connections) — `packages/research/src/data-sources/nse-filings-types.ts`
- **categorizeNseAnnouncement()** (7 connections) — `packages/research/src/data-sources/nse-filings-logic.ts`
- **parseCorporateActions()** (7 connections) — `packages/research/src/data-sources/nse-filings-logic.ts`
- **nse-json-archive.test.ts** (7 connections) — `packages/research/__tests__/nse-json-archive.test.ts`
- **fetchAnnualReports()** (6 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **formatNSEDate()** (6 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **normalizeFilingSymbol()** (6 connections) — `packages/research/src/data-sources/nse-filings-logic.ts`
- **NSEFiling** (5 connections) — `packages/research/src/data-sources/nse-filings-types.ts`
- *... and 85 more nodes in this community*

## Relationships

- [Corporate Actions Windows](Corporate_Actions_Windows.md) (21 shared connections)
- [NSE Shareholding Ownership Sync](NSE_Shareholding_Ownership_Sync.md) (11 shared connections)
- [Stock Document Synchronization](Stock_Document_Synchronization.md) (10 shared connections)
- [Corporate Events Synchronization](Corporate_Events_Synchronization.md) (10 shared connections)
- [BSE Announcements Client](BSE_Announcements_Client.md) (9 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (8 shared connections)
- [NSE Announcements Sync](NSE_Announcements_Sync.md) (7 shared connections)
- [Stock Document Fetching Staleness](Stock_Document_Fetching_Staleness.md) (7 shared connections)
- [XBRL Feed Archive Backfill](XBRL_Feed_Archive_Backfill.md) (5 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (5 shared connections)
- [NSE Research Tools](NSE_Research_Tools.md) (4 shared connections)
- [Chartink Technical Scans Library](Chartink_Technical_Scans_Library.md) (4 shared connections)

## Source Files

- `@usemoney/core/market-data`
- `packages/core/src/market-data/feed-archive.ts`
- `packages/research/__tests__/nse-fii-dii-archive.test.ts`
- `packages/research/__tests__/nse-filings-archive.test.ts`
- `packages/research/__tests__/nse-json-archive.test.ts`
- `packages/research/src/data-sources/nse-fii-dii.ts`
- `packages/research/src/data-sources/nse-filings-logic.ts`
- `packages/research/src/data-sources/nse-filings-types.ts`
- `packages/research/src/data-sources/nse-filings.ts`
- `packages/research/src/data-sources/nse-json-archive.ts`
- `packages/research/src/data-sources/screener-full-scraper.ts`
- `packages/services/src/corporate-actions.service.ts`
- `workers/src/processors/stock-document-sync.ts`

## Audit Trail

- EXTRACTED: 342 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*