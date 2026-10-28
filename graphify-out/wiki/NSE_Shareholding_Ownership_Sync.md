# NSE Shareholding Ownership Sync

> 61 nodes

## Key Concepts

- **processors/ownership-sync.ts** (94 connections) — `workers/src/processors/ownership-sync.ts`
- **processOwnershipSync()** (32 connections) — `workers/src/processors/ownership-sync.ts`
- **runBseSymbol()** (14 connections) — `workers/src/processors/ownership-sync.ts`
- **runShpXbrlSymbol()** (11 connections) — `workers/src/processors/ownership-sync.ts`
- **normalizeQuarter()** (8 connections) — `packages/research/src/data-sources/ownership-logic.ts`
- **fetchNseOwnershipJson()** (7 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **ownership-run-verdict.test.ts** (6 connections) — `workers/__tests__/processors/ownership-run-verdict.test.ts`
- **buildBseShpQueue()** (5 connections) — `packages/research/src/data-sources/ownership-logic.ts`
- **normalizeCompanyName()** (5 connections) — `packages/research/src/data-sources/ownership-logic.ts`
- **projectedPassDays()** (5 connections) — `packages/research/src/data-sources/ownership-logic.ts`
- **loadBseQueue()** (5 connections) — `workers/src/processors/ownership-sync.ts`
- **fetchInsiderTradingPit()** (4 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **fetchPledgeData()** (4 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **fetchSastReg29()** (4 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **fetchShareholdingMaster()** (4 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **mergeSyncMetadata()** (4 connections) — `packages/research/src/data-sources/ownership-logic.ts`
- **readStoredCursors()** (4 connections) — `packages/research/src/data-sources/ownership-logic.ts`
- **shpXbrlArchiveDay()** (4 connections) — `packages/research/src/data-sources/ownership-logic.ts`
- **bump()** (4 connections) — `workers/src/processors/ownership-sync.ts`
- **fetchShpXml()** (4 connections) — `workers/src/processors/ownership-sync.ts`
- **mergeCounts()** (4 connections) — `workers/src/processors/ownership-sync.ts`
- **writeInsiderEvents()** (4 connections) — `workers/src/processors/ownership-sync.ts`
- **RunStatus** (3 connections) — `packages/research/src/data-sources/ownership-logic.ts`
- **runPacedPerSymbol()** (3 connections) — `packages/research/src/data-sources/nse-filings.ts`
- **absorb()** (3 connections) — `workers/src/processors/ownership-sync.ts`
- *... and 36 more nodes in this community*

## Relationships

- [BSE Shareholding Logic](BSE_Shareholding_Logic.md) (44 shared connections)
- [BSE Shareholding XBRL Feed](BSE_Shareholding_XBRL_Feed.md) (16 shared connections)
- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (11 shared connections)
- [BSE Shareholding Pattern Provider](BSE_Shareholding_Pattern_Provider.md) (9 shared connections)
- [Shareholding XBRL Parsing](Shareholding_XBRL_Parsing.md) (8 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (2 shared connections)
- [BSE Scrip Master Enrichment](BSE_Scrip_Master_Enrichment.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Shareholding Raw Data Reparsing](Shareholding_Raw_Data_Reparsing.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (1 shared connections)

## Source Files

- `packages/research/src/data-sources/nse-filings.ts`
- `packages/research/src/data-sources/ownership-logic.ts`
- `workers/__tests__/processors/ownership-run-verdict.test.ts`
- `workers/src/processors/ownership-sync.ts`

## Audit Trail

- EXTRACTED: 202 (99%)
- INFERRED: 2 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*