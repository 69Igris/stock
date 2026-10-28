# Tiingo US EOD Backfill

> 39 nodes

## Key Concepts

- **tiingo-us-backfill.ts** (62 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **main()** (23 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **writeFundNavs()** (5 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **TiingoCliArgs** (4 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **isRecycledResponse()** (4 connections) — `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- **barTs()** (4 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **parseTiingoCliArgs()** (4 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **TiingoCliError** (3 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **barYear()** (3 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **.has()** (3 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **chunk()** (2 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **judgeColdStamp()** (2 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **judgeEodWrite()** (2 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **parseArgsOrExit()** (2 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **planColdStamp()** (2 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **selectTargets()** (2 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **splitByDestination()** (2 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **stampColdYears()** (2 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **ColdStampPlan** (1 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **ColdStampVerdict** (1 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **EodBar** (1 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **eodCheckpointFields** (1 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **EodWriteTally** (1 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **EodWriteVerdict** (1 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- **HotColdSplit** (1 connections) — `scripts/jobs/tiingo-us-backfill.ts`
- *... and 14 more nodes in this community*

## Relationships

- [Tiingo EOD Data Client](Tiingo_EOD_Data_Client.md) (12 shared connections)
- [Databento Data Harvesting](Databento_Data_Harvesting.md) (6 shared connections)
- [Tiingo Instrument Ingestion](Tiingo_Instrument_Ingestion.md) (4 shared connections)
- [Parquet Candle Cold Storage](Parquet_Candle_Cold_Storage.md) (4 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (3 shared connections)
- [Tiingo Corporate Actions Logic](Tiingo_Corporate_Actions_Logic.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (2 shared connections)
- [Intraday Candle Eviction](Intraday_Candle_Eviction.md) (2 shared connections)
- [US EOD Data Synchronization](US_EOD_Data_Synchronization.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Candle Repository Sharding](Candle_Repository_Sharding.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- `scripts/jobs/tiingo-us-backfill.ts`

## Audit Trail

- EXTRACTED: 96 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*