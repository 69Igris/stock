# Tiingo EOD Data Client

> 62 nodes

## Key Concepts

- **tiingo-client.ts** (50 connections) — `packages/core/src/market-data/tiingo/tiingo-client.ts`
- **tiingo-logic.ts** (41 connections) — `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- **tiingo-corp-actions.ts** (33 connections) — `packages/core/src/market-data/tiingo/tiingo-corp-actions.ts`
- **tiingo-logic.test.ts** (33 connections) — `packages/core/__tests__/market-data/tiingo-logic.test.ts`
- **tiingo-news.ts** (30 connections) — `packages/core/src/market-data/tiingo/tiingo-news.ts`
- **TiingoRateLimitError** (24 connections) — `packages/core/src/market-data/tiingo/tiingo-errors.ts`
- **tiingo-pacer.ts** (18 connections) — `packages/core/src/market-data/tiingo/tiingo-pacer.ts`
- **withTiingoBudget()** (17 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **TiingoAuthError** (15 connections) — `packages/core/src/market-data/tiingo/tiingo-errors.ts`
- **tiingoLimits** (15 connections) — `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- **fetchSupportedTickers()** (14 connections) — `packages/core/src/market-data/tiingo/tiingo-client.ts`
- **paceTiingoRequest()** (14 connections) — `packages/core/src/market-data/tiingo/tiingo-pacer.ts`
- **decideTiingoFailure()** (12 connections) — `packages/core/src/market-data/tiingo/tiingo-client.ts`
- **fetchDistributionsByExDate()** (12 connections) — `packages/core/src/market-data/tiingo/tiingo-corp-actions.ts`
- **fetchSplitsByExDate()** (12 connections) — `packages/core/src/market-data/tiingo/tiingo-corp-actions.ts`
- **getArchived()** (11 connections) — `packages/core/src/market-data/tiingo/tiingo-client.ts`
- **getArchived()** (11 connections) — `packages/core/src/market-data/tiingo/tiingo-corp-actions.ts`
- **getArchived()** (10 connections) — `packages/core/src/market-data/tiingo/tiingo-news.ts`
- **TiingoDailyCapError** (9 connections) — `packages/core/src/market-data/tiingo/tiingo-pacer.ts`
- **fetchTiingoEod()** (9 connections) — `packages/core/src/market-data/tiingo/tiingo-client.ts`
- **tiingo-errors.ts** (8 connections) — `packages/core/src/market-data/tiingo/tiingo-errors.ts`
- **TiingoMasterRow** (7 connections) — `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- **TiingoEodBar** (6 connections) — `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- **MAX_RETRIES** (6 connections) — `packages/core/src/market-data/tiingo/tiingo-client.ts`
- **tiingoStatusFromError()** (5 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- *... and 37 more nodes in this community*

## Relationships

- [Tiingo API Rate Limiting](Tiingo_API_Rate_Limiting.md) (36 shared connections)
- [Tiingo Corporate Actions Logic](Tiingo_Corporate_Actions_Logic.md) (26 shared connections)
- [Tiingo News Ingestion](Tiingo_News_Ingestion.md) (23 shared connections)
- [US EOD Data Synchronization](US_EOD_Data_Synchronization.md) (19 shared connections)
- [Tiingo Instrument Ingestion](Tiingo_Instrument_Ingestion.md) (19 shared connections)
- [Tiingo US Ticker Search](Tiingo_US_Ticker_Search.md) (18 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (15 shared connections)
- [Tiingo US EOD Backfill](Tiingo_US_EOD_Backfill.md) (12 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (7 shared connections)
- [Parquet Candle Cold Storage](Parquet_Candle_Cold_Storage.md) (5 shared connections)
- [EDGAR CIK Enrichment](EDGAR_CIK_Enrichment.md) (5 shared connections)
- [Tiingo US News Ingestion](Tiingo_US_News_Ingestion.md) (4 shared connections)

## Source Files

- `packages/core/__tests__/market-data/tiingo-logic.test.ts`
- `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- `packages/core/src/market-data/tiingo/tiingo-client.ts`
- `packages/core/src/market-data/tiingo/tiingo-corp-actions.ts`
- `packages/core/src/market-data/tiingo/tiingo-errors.ts`
- `packages/core/src/market-data/tiingo/tiingo-logic.ts`
- `packages/core/src/market-data/tiingo/tiingo-news.ts`
- `packages/core/src/market-data/tiingo/tiingo-pacer.ts`

## Audit Trail

- EXTRACTED: 353 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*