# Corporate Issues Logic

> 100 nodes

## Key Concepts

- **processors/annual-reports-sync.ts** (58 connections) — `workers/src/processors/annual-reports-sync.ts`
- **issues-logic.ts** (47 connections) — `packages/research/src/data-sources/issues-logic.ts`
- **issues-logic.test.ts** (46 connections) — `workers/__tests__/issues-logic.test.ts`
- **nse-issues.ts** (33 connections) — `packages/research/src/data-sources/nse-issues.ts`
- **processors/ipo-sync.ts** (26 connections) — `workers/src/processors/ipo-sync.ts`
- **runAnnualReportsLeg()** (13 connections) — `workers/src/processors/annual-reports-sync.ts`
- **parseIpoRow()** (12 connections) — `packages/research/src/data-sources/issues-logic.ts`
- **parseIntegratedFilings()** (11 connections) — `packages/research/src/data-sources/issues-logic.ts`
- **parseAnnualReports()** (9 connections) — `packages/research/src/data-sources/issues-logic.ts`
- **fetchNseIssuesJson()** (9 connections) — `packages/research/src/data-sources/nse-issues.ts`
- **normalizeIssueSymbol()** (8 connections) — `packages/research/src/data-sources/issues-logic.ts`
- **parseIpoIssues()** (8 connections) — `packages/research/src/data-sources/issues-logic.ts`
- **processIpoSync()** (8 connections) — `workers/src/processors/ipo-sync.ts`
- **routes/ipo-sync.ts** (8 connections) — `workers/src/routes/ipo-sync.ts`
- **fetchAnnualReports()** (7 connections) — `packages/research/src/data-sources/nse-issues.ts`
- **fetchIntegratedFilings()** (7 connections) — `packages/research/src/data-sources/nse-issues.ts`
- **runIntegratedFilingsLeg()** (7 connections) — `workers/src/processors/annual-reports-sync.ts`
- **IpoIssue** (6 connections) — `packages/research/src/data-sources/issues-logic.ts`
- **mergeIpoIssues()** (6 connections) — `packages/research/src/data-sources/issues-logic.ts`
- **pickNumber()** (6 connections) — `packages/research/src/data-sources/issues-logic.ts`
- **unwrapRows()** (6 connections) — `packages/research/src/data-sources/issues-logic.ts`
- **fetchUpcomingIpos()** (6 connections) — `packages/research/src/data-sources/nse-issues.ts`
- **storeIntegratedFiling()** (6 connections) — `workers/src/processors/annual-reports-sync.ts`
- **pickRaw()** (5 connections) — `packages/research/src/data-sources/issues-logic.ts`
- **pickString()** (5 connections) — `packages/research/src/data-sources/issues-logic.ts`
- *... and 75 more nodes in this community*

## Relationships

- [Stock Document Synchronization](Stock_Document_Synchronization.md) (16 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (8 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (8 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (5 shared connections)
- [Circulars Ingestion Processor](Circulars_Ingestion_Processor.md) (4 shared connections)
- [Stock Document Fetching Staleness](Stock_Document_Fetching_Staleness.md) (4 shared connections)
- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (3 shared connections)
- [Vector Embeddings Service](Vector_Embeddings_Service.md) (3 shared connections)
- [Document Container Management](Document_Container_Management.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (2 shared connections)
- [BSE Announcements Backfill](BSE_Announcements_Backfill.md) (1 shared connections)

## Source Files

- `packages/research/src/data-sources/issues-logic.ts`
- `packages/research/src/data-sources/nse-issues.ts`
- `workers/__tests__/issues-logic.test.ts`
- `workers/src/processors/annual-reports-sync.ts`
- `workers/src/processors/ipo-sync.ts`
- `workers/src/routes/ipo-sync.ts`

## Audit Trail

- EXTRACTED: 300 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*