# Databento Data Harvesting

> 132 nodes

## Key Concepts

- **databento-harvest.ts** (136 connections) — `scripts/jobs/databento-harvest.ts`
- **databento-append.ts** (126 connections) — `scripts/jobs/databento-append.ts`
- **databento-repo.ts** (48 connections) — `packages/core/src/market-data/databento/databento-repo.ts`
- **databento-harvest-logic.ts** (32 connections) — `packages/core/src/market-data/databento/databento-harvest-logic.ts`
- **main()** (27 connections) — `scripts/jobs/databento-harvest.ts`
- **appendEntry()** (20 connections) — `scripts/jobs/databento-append.ts`
- **databento-harvest-logic.test.ts** (20 connections) — `packages/core/__tests__/market-data/databento/databento-harvest-logic.test.ts`
- **maybeRebuildCostModel()** (17 connections) — `scripts/jobs/databento-append.ts`
- **stepLoad()** (16 connections) — `scripts/jobs/databento-harvest.ts`
- **downloadAndLoad()** (15 connections) — `scripts/jobs/databento-append.ts`
- **stepDownload()** (15 connections) — `scripts/jobs/databento-harvest.ts`
- **candle-cold-store-gcs.ts** (15 connections) — `workers/src/lib/candle-cold-store-gcs.ts`
- **stepCoverage()** (13 connections) — `scripts/jobs/databento-harvest.ts`
- **judgeBackfillOutcome()** (12 connections) — `packages/core/src/ops/backfill-outcome.ts`
- **initCandleColdStore()** (10 connections) — `workers/src/lib/candle-cold-store-gcs.ts`
- **backfill-outcome.ts** (10 connections) — `packages/core/src/ops/backfill-outcome.ts`
- **readFileRecords()** (9 connections) — `packages/core/src/market-data/databento/databento-repo.ts`
- **coverageFromCount()** (8 connections) — `packages/core/src/market-data/databento/databento-harvest-logic.ts`
- **classifyFile()** (8 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **databentoArchiveKey()** (8 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **datasetForEntry()** (8 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **resolveSymbolSet()** (8 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **buildListingIndex()** (8 connections) — `packages/core/src/market-data/databento/databento-symbology.ts`
- **fetchMasterSymbols()** (7 connections) — `packages/core/src/market-data/databento/databento-repo.ts`
- **reportCoverage()** (7 connections) — `scripts/jobs/databento-append.ts`
- *... and 107 more nodes in this community*

## Relationships

- [Databento Storage Client](Databento_Storage_Client.md) (67 shared connections)
- [Databento OHLCV Candle Loading](Databento_OHLCV_Candle_Loading.md) (36 shared connections)
- [Databento API Spend Budgeting](Databento_API_Spend_Budgeting.md) (32 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (30 shared connections)
- [Databento Data Append Logic](Databento_Data_Append_Logic.md) (22 shared connections)
- [Databento Manifest Parsing](Databento_Manifest_Parsing.md) (22 shared connections)
- [Databento Market Data Writer](Databento_Market_Data_Writer.md) (11 shared connections)
- [Worker Telemetry Log Flushing](Worker_Telemetry_Log_Flushing.md) (8 shared connections)
- [Databento Cost Modeling](Databento_Cost_Modeling.md) (7 shared connections)
- [Candle Cold Storage](Candle_Cold_Storage.md) (6 shared connections)
- [Tiingo US EOD Backfill](Tiingo_US_EOD_Backfill.md) (6 shared connections)
- [CLI Argument Parsing Utilities](CLI_Argument_Parsing_Utilities.md) (4 shared connections)

## Source Files

- `packages/core/__tests__/market-data/databento/databento-harvest-logic.test.ts`
- `packages/core/__tests__/ops/backfill-outcome.test.ts`
- `packages/core/src/market-data/databento/databento-cost-model.ts`
- `packages/core/src/market-data/databento/databento-harvest-logic.ts`
- `packages/core/src/market-data/databento/databento-logic.ts`
- `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- `packages/core/src/market-data/databento/databento-repo.ts`
- `packages/core/src/market-data/databento/databento-session-writer.ts`
- `packages/core/src/market-data/databento/databento-symbology.ts`
- `packages/core/src/ops/backfill-outcome.ts`
- `scripts/jobs/databento-append.ts`
- `scripts/jobs/databento-harvest.ts`
- `workers/src/lib/candle-cold-store-gcs.ts`

## Audit Trail

- EXTRACTED: 573 (97%)
- INFERRED: 17 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*