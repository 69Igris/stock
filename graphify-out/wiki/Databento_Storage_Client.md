# Databento Storage Client

> 79 nodes

## Key Concepts

- **databento-client.ts** (53 connections) — `packages/core/src/market-data/databento/databento-client.ts`
- **databento-probe.ts** (49 connections) — `scripts/data/databento-probe.ts`
- **main()** (24 connections) — `scripts/data/databento-probe.ts`
- **databento-client.test.ts** (23 connections) — `packages/core/__tests__/market-data/databento-client.test.ts`
- **downloadToArchive()** (16 connections) — `packages/core/src/market-data/databento/databento-client.ts`
- **databento-archive-gcs.ts** (16 connections) — `workers/src/lib/databento-archive-gcs.ts`
- **request()** (15 connections) — `packages/core/src/market-data/databento/databento-client.ts`
- **databento-archive.ts** (12 connections) — `packages/core/src/market-data/databento/databento-archive.ts`
- **getDatabentoArchiveStore()** (11 connections) — `packages/core/src/market-data/databento/databento-archive.ts`
- **getCost()** (11 connections) — `packages/core/src/market-data/databento/databento-client.ts`
- **listFiles()** (11 connections) — `packages/core/src/market-data/databento/databento-client.ts`
- **submitBatchJob()** (11 connections) — `packages/core/src/market-data/databento/databento-client.ts`
- **getDatasetRange()** (10 connections) — `packages/core/src/market-data/databento/databento-client.ts`
- **DatabentoRequestError** (9 connections) — `packages/core/src/market-data/databento/databento-errors.ts`
- **databentoApiKey()** (9 connections) — `packages/core/src/market-data/databento/databento-client.ts`
- **getJobDetails()** (9 connections) — `packages/core/src/market-data/databento/databento-client.ts`
- **initDatabentoArchiveStore()** (9 connections) — `workers/src/lib/databento-archive-gcs.ts`
- **DatabentoArchiveStore** (8 connections) — `packages/core/src/market-data/databento/databento-archive.ts`
- **toDatabentoSymbol()** (8 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **symbolsHash()** (8 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **DatabentoAuthError** (7 connections) — `packages/core/src/market-data/databento/databento-errors.ts`
- **listJobs()** (6 connections) — `packages/core/src/market-data/databento/databento-client.ts`
- **resolveDatabentoEnv()** (6 connections) — `packages/core/src/market-data/databento/databento-client.ts`
- **resolveSymbology()** (6 connections) — `packages/core/src/market-data/databento/databento-client.ts`
- **databento-errors.ts** (6 connections) — `packages/core/src/market-data/databento/databento-errors.ts`
- *... and 54 more nodes in this community*

## Relationships

- [Databento Data Harvesting](Databento_Data_Harvesting.md) (67 shared connections)
- [Databento OHLCV Candle Loading](Databento_OHLCV_Candle_Loading.md) (30 shared connections)
- [Databento API Spend Budgeting](Databento_API_Spend_Budgeting.md) (11 shared connections)
- [Databento Data Append Logic](Databento_Data_Append_Logic.md) (7 shared connections)
- [Databento Manifest Parsing](Databento_Manifest_Parsing.md) (5 shared connections)
- [Storage Download Budget Manager](Storage_Download_Budget_Manager.md) (5 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (2 shared connections)
- [CLI Argument Parsing Utilities](CLI_Argument_Parsing_Utilities.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/databento-client.test.ts`
- `packages/core/src/market-data/databento/databento-archive.ts`
- `packages/core/src/market-data/databento/databento-client.ts`
- `packages/core/src/market-data/databento/databento-errors.ts`
- `packages/core/src/market-data/databento/databento-logic.ts`
- `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- `packages/core/src/market-data/databento/databento-repo.ts`
- `scripts/data/databento-probe.ts`
- `scripts/jobs/databento-append.ts`
- `scripts/jobs/databento-harvest.ts`
- `workers/src/lib/databento-archive-gcs.ts`

## Audit Trail

- EXTRACTED: 291 (98%)
- INFERRED: 5 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*