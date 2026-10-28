# XBRL Feed Archive Backfill

> 35 nodes

## Key Concepts

- **xbrl-backfill.ts** (39 connections) — `scripts/jobs/xbrl-backfill.ts`
- **xbrl-reparse.ts** (26 connections) — `scripts/jobs/xbrl-reparse.ts`
- **resolveFeedArchiveMode()** (24 connections) — `packages/core/src/market-data/feed-archive.ts`
- **feed-archive-store.ts** (15 connections) — `workers/src/lib/feed-archive-store.ts`
- **getFeedArchiveStore()** (14 connections) — `packages/core/src/market-data/feed-archive.ts`
- **main()** (12 connections) — `scripts/jobs/xbrl-backfill.ts`
- **main()** (12 connections) — `scripts/jobs/xbrl-reparse.ts`
- **initFeedArchive()** (10 connections) — `workers/src/lib/feed-archive-store.ts`
- **fetchXml()** (8 connections) — `workers/src/processors/xbrl-sync.ts`
- **candidateArchiveKeysForFiling()** (8 connections) — `workers/src/processors/xbrl-sync-logic.ts`
- **archiveExistingPass()** (7 connections) — `scripts/jobs/xbrl-backfill.ts`
- **annualExistingPass()** (5 connections) — `scripts/jobs/xbrl-backfill.ts`
- **StoredFilingRef** (4 connections) — `workers/src/processors/xbrl-sync.ts`
- **requireArchiveWired()** (4 connections) — `scripts/jobs/feed-backfill.ts`
- **requireArchiveWired()** (4 connections) — `scripts/jobs/xbrl-backfill.ts`
- **sleep()** (3 connections) — `scripts/jobs/xbrl-backfill.ts`
- **readArchivedXml()** (3 connections) — `scripts/jobs/xbrl-reparse.ts`
- **ReparseRow** (2 connections) — `scripts/jobs/xbrl-reparse.ts`
- **arg()** (2 connections) — `scripts/jobs/xbrl-backfill.ts`
- **monthWindows()** (2 connections) — `scripts/jobs/xbrl-backfill.ts`
- **parseMonth()** (2 connections) — `scripts/jobs/xbrl-backfill.ts`
- **makeDeps()** (2 connections) — `scripts/jobs/xbrl-reparse.ts`
- **AnnualExistingResult** (1 connections) — `scripts/jobs/xbrl-backfill.ts`
- **ArchiveExistingResult** (1 connections) — `scripts/jobs/xbrl-backfill.ts`
- **MonthWindow** (1 connections) — `scripts/jobs/xbrl-backfill.ts`
- *... and 10 more nodes in this community*

## Relationships

- [XBRL Filings Index Sync](XBRL_Filings_Index_Sync.md) (15 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (10 shared connections)
- [Feed Backfill Logic](Feed_Backfill_Logic.md) (8 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (8 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (8 shared connections)
- [NSE Corporate Filings Client](NSE_Corporate_Filings_Client.md) (5 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (5 shared connections)
- [Market Hours and Calendar](Market_Hours_and_Calendar.md) (4 shared connections)
- [XBRL Filing Era Sync](XBRL_Filing_Era_Sync.md) (4 shared connections)
- [Report Family Backfill Registry](Report_Family_Backfill_Registry.md) (3 shared connections)
- [Instrument Synchronization Sweeps](Instrument_Synchronization_Sweeps.md) (2 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (2 shared connections)

## Source Files

- `packages/core/src/market-data/feed-archive.ts`
- `scripts/jobs/feed-backfill.ts`
- `scripts/jobs/xbrl-backfill.ts`
- `scripts/jobs/xbrl-reparse.ts`
- `workers/src/lib/feed-archive-store.ts`
- `workers/src/processors/xbrl-sync-logic.ts`
- `workers/src/processors/xbrl-sync.ts`

## Audit Trail

- EXTRACTED: 154 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*