# Candle Data Integrity Verification

> 60 nodes

## Key Concepts

- **fetch-price-history.ts** (30 connections) — `packages/research/src/tools/fetch-price-history.ts`
- **yahoo-price-service.ts** (18 connections) — `packages/core/src/market-data/prices/yahoo-price-service.ts`
- **repair-daily-price-candles.ts** (16 connections) — `scripts/migrations/repair-daily-price-candles.ts`
- **yahoo-price-logic.ts** (13 connections) — `packages/core/src/market-data/prices/yahoo-price-logic.ts`
- **repairCandle()** (12 connections) — `packages/core/src/market-data/candle-integrity.ts`
- **fetch-price-history.test.ts** (12 connections) — `packages/research/__tests__/fetch-price-history.test.ts`
- **candle-integrity.ts** (11 connections) — `packages/core/src/market-data/candle-integrity.ts`
- **classifyCandle()** (8 connections) — `packages/core/src/market-data/candle-integrity.ts`
- **widenCandleRange()** (7 connections) — `packages/core/src/market-data/candle-integrity.ts`
- **getHistoricalPrices()** (7 connections) — `packages/core/src/market-data/prices/yahoo-price-service.ts`
- **hasGaps()** (6 connections) — `packages/core/src/market-data/prices/yahoo-price-logic.ts`
- **backfillPrices()** (6 connections) — `packages/core/src/market-data/prices/yahoo-price-service.ts`
- **upsertDailyPrices()** (6 connections) — `packages/core/src/market-data/prices/yahoo-price-service.ts`
- **resolvePriceHistory()** (6 connections) — `packages/research/src/tools/fetch-price-history.ts`
- **candle-integrity.test.ts** (6 connections) — `packages/core/__tests__/market-data/candle-integrity.test.ts`
- **isDrawableCandle()** (5 connections) — `packages/core/src/market-data/candle-integrity.ts`
- **normalizeDate()** (5 connections) — `packages/core/src/market-data/prices/yahoo-price-logic.ts`
- **yahoo-price-logic.test.ts** (5 connections) — `packages/core/__tests__/market-data/yahoo-price-logic.test.ts`
- **HistoricalBar** (4 connections) — `packages/core/src/market-data/prices/yahoo-price-logic.ts`
- **clampCandleOpen()** (4 connections) — `packages/core/src/market-data/candle-integrity.ts`
- **selectServableRows()** (4 connections) — `packages/core/src/market-data/prices/yahoo-price-logic.ts`
- **main()** (4 connections) — `scripts/migrations/repair-daily-price-candles.ts`
- **Candle** (3 connections) — `packages/core/src/market-data/candle-integrity.ts`
- **CandleDefect** (3 connections) — `packages/core/src/market-data/candle-integrity.ts`
- **toHistoricalBar()** (3 connections) — `packages/core/src/market-data/prices/yahoo-price-logic.ts`
- *... and 35 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (17 shared connections)
- [NSE Research Tools](NSE_Research_Tools.md) (5 shared connections)
- [Price Source Write Authority](Price_Source_Write_Authority.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (3 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (3 shared connections)
- [Derivatives Bhavcopy Parsing](Derivatives_Bhavcopy_Parsing.md) (2 shared connections)
- [Price Synchronization Processor](Price_Synchronization_Processor.md) (2 shared connections)
- [Stock Financials Normalization](Stock_Financials_Normalization.md) (2 shared connections)
- [Risk and Portfolio Metrics](Risk_and_Portfolio_Metrics.md) (2 shared connections)
- [Yahoo Finance Market Data](Yahoo_Finance_Market_Data.md) (1 shared connections)
- [Database Migration Scripts](Database_Migration_Scripts.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/candle-integrity.test.ts`
- `packages/core/__tests__/market-data/yahoo-price-logic.test.ts`
- `packages/core/src/market-data/candle-integrity.ts`
- `packages/core/src/market-data/prices/yahoo-price-logic.ts`
- `packages/core/src/market-data/prices/yahoo-price-service.ts`
- `packages/research/__tests__/fetch-price-history.test.ts`
- `packages/research/src/tools/fetch-price-history.ts`
- `scripts/migrations/repair-daily-price-candles.ts`

## Audit Trail

- EXTRACTED: 148 (99%)
- INFERRED: 2 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*