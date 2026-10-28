# Databento Manifest Parsing

> 26 nodes

## Key Concepts

- **databento-manifest-logic.ts** (30 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **databento-manifest.test.ts** (15 connections) — `packages/core/__tests__/market-data/databento-manifest.test.ts`
- **refresh-databento-manifest.ts** (10 connections) — `scripts/data/refresh-databento-manifest.ts`
- **parseManifest()** (8 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **chunkSymbols()** (6 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **DATABENTO_MAX_SYMBOLS_PER_REQUEST** (6 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **isLoadableSchema()** (5 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **EQUS_MINI_HISTORY_FLOOR** (5 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **DatabentoManifest** (4 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **databento-manifest.json** (4 connections) — `scripts/README.md`
- **DatabentoManifestEntry** (3 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **main()** (3 connections) — `scripts/data/refresh-databento-manifest.ts`
- **parseHoldings()** (3 connections) — `scripts/data/refresh-databento-manifest.ts`
- **manifestEntrySchema** (3 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **toOurNotation()** (2 connections) — `scripts/data/refresh-databento-manifest.ts`
- **DATABENTO_SCHEMAS** (2 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **ResolvedRange** (1 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **Holding** (1 connections) — `scripts/data/refresh-databento-manifest.ts`
- **manifestSchema** (1 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **rangeEnd** (1 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **rangeStart** (1 connections) — `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- **MANIFEST_PATH** (1 connections) — `packages/core/__tests__/market-data/databento-manifest.test.ts`
- **raw** (1 connections) — `packages/core/__tests__/market-data/databento-manifest.test.ts`
- **APPLY** (1 connections) — `scripts/data/refresh-databento-manifest.ts`
- **argv** (1 connections) — `scripts/data/refresh-databento-manifest.ts`
- *... and 1 more nodes in this community*

## Relationships

- [Databento Data Harvesting](Databento_Data_Harvesting.md) (22 shared connections)
- [Databento OHLCV Candle Loading](Databento_OHLCV_Candle_Loading.md) (9 shared connections)
- [Databento Data Append Logic](Databento_Data_Append_Logic.md) (7 shared connections)
- [Databento Storage Client](Databento_Storage_Client.md) (5 shared connections)
- [Databento API Spend Budgeting](Databento_API_Spend_Budgeting.md) (1 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/databento-manifest.test.ts`
- `packages/core/src/market-data/databento/databento-logic.ts`
- `packages/core/src/market-data/databento/databento-manifest-logic.ts`
- `scripts/README.md`
- `scripts/data/refresh-databento-manifest.ts`

## Audit Trail

- EXTRACTED: 82 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*