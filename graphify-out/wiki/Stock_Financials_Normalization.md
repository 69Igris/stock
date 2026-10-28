# Stock Financials Normalization

> 147 nodes

## Key Concepts

- **db-store.ts** (64 connections) — `packages/research/src/data-sources/db-store.ts`
- **db-store-logic.ts** (44 connections) — `packages/research/src/data-sources/db-store-logic.ts`
- **fetch-balance-sheet.ts** (28 connections) — `packages/research/src/tools/fetch-balance-sheet.ts`
- **fetch-cash-flow.ts** (28 connections) — `packages/research/src/tools/fetch-cash-flow.ts`
- **fetch-income-statement.ts** (28 connections) — `packages/research/src/tools/fetch-income-statement.ts`
- **persistence.ts** (23 connections) — `packages/research/src/data-sources/persistence.ts`
- **backfill-financials-from-rawdata.ts** (21 connections) — `scripts/data/backfill-financials-from-rawdata.ts`
- **money1235-financials-order-and-ttm.test.ts** (19 connections) — `packages/research/__tests__/money1235-financials-order-and-ttm.test.ts`
- **fetchQuoteSummary()** (18 connections) — `packages/core/src/market-data/yahoo-api.ts`
- **withExchangeFallback()** (18 connections) — `packages/core/src/market-data/yahoo-api.ts`
- **fetch-company-profile.ts** (17 connections) — `packages/research/src/tools/fetch-company-profile.ts`
- **mapTickertapeStatementRow()** (16 connections) — `packages/research/src/data-sources/db-store-logic.ts`
- **financials-basis.ts** (16 connections) — `packages/core/src/market-data/financials-basis.ts`
- **tickertape-statement-mapper.test.ts** (16 connections) — `packages/research/__tests__/tickertape-statement-mapper.test.ts`
- **FinancialStatement** (10 connections) — `packages/research/src/types.ts`
- **money1300-financials-basis.test.ts** (10 connections) — `packages/research/__tests__/money1300-financials-basis.test.ts`
- **seed-stock-financials.ts** (10 connections) — `scripts/seed/seed-stock-financials.ts`
- **summariseStockFinancialsBasis()** (8 connections) — `packages/core/src/market-data/financials-basis.ts`
- **tickertapeStatementColumns()** (8 connections) — `packages/research/src/data-sources/db-store-logic.ts`
- **main()** (8 connections) — `scripts/data/backfill-financials-from-rawdata.ts`
- **fetch-global-fund.ts** (8 connections) — `packages/research/src/tools/fetch-global-fund.ts`
- **fetch-company-profile.test.ts** (8 connections) — `packages/research/__tests__/fetch-company-profile.test.ts`
- **normalizeStockFinancialsBasis()** (7 connections) — `packages/core/src/market-data/financials-basis.ts`
- **describeStaleTtm()** (7 connections) — `packages/research/src/data-sources/db-store-logic.ts`
- **pickNewestPeriodicRow()** (7 connections) — `packages/research/src/data-sources/db-store-logic.ts`
- *... and 122 more nodes in this community*

## Relationships

- [NSE Research Tools](NSE_Research_Tools.md) (42 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (17 shared connections)
- [Stock Document Fetching Staleness](Stock_Document_Fetching_Staleness.md) (14 shared connections)
- [Symbol Resolution and Skills](Symbol_Resolution_and_Skills.md) (10 shared connections)
- [Chartink Technical Scans Library](Chartink_Technical_Scans_Library.md) (7 shared connections)
- [Financial Data Source Fallbacks](Financial_Data_Source_Fallbacks.md) (7 shared connections)
- [Financial Ratio Extraction](Financial_Ratio_Extraction.md) (5 shared connections)
- [Yahoo Finance Market Data](Yahoo_Finance_Market_Data.md) (4 shared connections)
- [Corporate Events Synchronization](Corporate_Events_Synchronization.md) (4 shared connections)
- [Financial Key Ratios Fetcher](Financial_Key_Ratios_Fetcher.md) (4 shared connections)
- [XBRL Financial Projections](XBRL_Financial_Projections.md) (4 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (4 shared connections)

## Source Files

- `packages/core/__tests__/market-data/financials-basis.test.ts`
- `packages/core/src/market-data/financials-basis.ts`
- `packages/core/src/market-data/yahoo-api.ts`
- `packages/research/__tests__/fetch-company-profile.test.ts`
- `packages/research/__tests__/money1235-financials-order-and-ttm.test.ts`
- `packages/research/__tests__/money1300-financials-basis.test.ts`
- `packages/research/__tests__/persistence-raw-data.test.ts`
- `packages/research/__tests__/tickertape-statement-mapper.test.ts`
- `packages/research/src/data-sources/db-store-logic.ts`
- `packages/research/src/data-sources/db-store.ts`
- `packages/research/src/data-sources/persistence-logic.ts`
- `packages/research/src/data-sources/persistence.ts`
- `packages/research/src/tools/fetch-balance-sheet.ts`
- `packages/research/src/tools/fetch-cash-flow.ts`
- `packages/research/src/tools/fetch-company-profile.ts`
- `packages/research/src/tools/fetch-global-fund.ts`
- `packages/research/src/tools/fetch-income-statement.ts`
- `packages/research/src/types.ts`
- `scripts/data/backfill-financials-from-rawdata.ts`
- `scripts/seed/seed-stock-financials.ts`

## Audit Trail

- EXTRACTED: 449 (99%)
- INFERRED: 4 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*