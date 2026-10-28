# Databento API Spend Budgeting

> 33 nodes

## Key Concepts

- **databento-budget.ts** (23 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **withDatabentoBudget()** (20 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **databento-budget.test.ts** (19 connections) — `packages/core/__tests__/market-data/databento-budget.test.ts`
- **stepQuote()** (15 connections) — `scripts/jobs/databento-harvest.ts`
- **DatabentoBudgetDeps** (10 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **DatabentoJob** (8 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **formatBudgetLine()** (8 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **monthWindowUtc()** (7 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **DatabentoBudgetExceededError** (6 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **DatabentoJobRequest** (6 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **reportQuoteDrift()** (6 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **BudgetKey** (4 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **BudgetSpec** (4 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **DatabentoJobRow** (4 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **.markSubmitted()** (3 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **readDatabentoMonthlyBudgetUsd()** (3 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **.createQuotedJob()** (2 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **.findEntryPurchase()** (2 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **.findExistingJob()** (2 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **.markFailed()** (2 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **.now()** (2 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **.sumMonthSpendUsd()** (2 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **isRebuyableState()** (2 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **__resetDatabentoBudgetWarning()** (2 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- **windowIsPinnedFor()** (2 connections) — `packages/core/src/market-data/databento/databento-budget.ts`
- *... and 8 more nodes in this community*

## Relationships

- [Databento Data Harvesting](Databento_Data_Harvesting.md) (32 shared connections)
- [Databento Storage Client](Databento_Storage_Client.md) (11 shared connections)
- [Databento OHLCV Candle Loading](Databento_OHLCV_Candle_Loading.md) (5 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (1 shared connections)
- [Databento Data Append Logic](Databento_Data_Append_Logic.md) (1 shared connections)
- [Databento Manifest Parsing](Databento_Manifest_Parsing.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/databento-budget.test.ts`
- `packages/core/src/market-data/databento/databento-budget.ts`
- `packages/core/src/market-data/databento/databento-logic.ts`
- `scripts/jobs/databento-harvest.ts`

## Audit Trail

- EXTRACTED: 111 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*