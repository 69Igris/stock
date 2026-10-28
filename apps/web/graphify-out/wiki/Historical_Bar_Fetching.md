# Historical Bar Fetching

> 25 nodes

## Key Concepts

- **historical-fetcher.ts** (34 connections) — `lib/market/historical-fetcher.ts`
- **fetchHistoricalBars()** (16 connections) — `lib/market/historical-fetcher.ts`
- **market-historical.test.ts** (14 connections) — `__tests__/api/market-historical.test.ts`
- **historical/route.ts** (9 connections) — `app/api/market/historical/route.ts`
- **HistoricalFetchError** (5 connections) — `lib/market/historical-fetcher.ts`
- **getIntradayChart()** (4 connections) — `lib/market/yahoo-client.ts`
- **isIntradayInterval()** (3 connections) — `lib/market/historical-fetcher.ts`
- **isIntradayPeriod()** (3 connections) — `lib/market/historical-fetcher.ts`
- **isValidInterval()** (3 connections) — `lib/market/historical-fetcher.ts`
- **isValidPeriod()** (3 connections) — `lib/market/historical-fetcher.ts`
- **validateSymbol()** (3 connections) — `lib/market/historical-fetcher.ts`
- **Interval** (2 connections) — `lib/market/yahoo-client.ts`
- **GET()** (2 connections) — `app/api/market/historical/route.ts`
- **getPeriodStartDate()** (2 connections) — `lib/market/historical-fetcher.ts`
- **isYahooInterval()** (2 connections) — `lib/market/historical-fetcher.ts`
- **startOfLocalDay()** (2 connections) — `lib/market/historical-fetcher.ts`
- **validateDateRange()** (2 connections) — `lib/market/historical-fetcher.ts`
- **INTRADAY_INTERVALS** (2 connections) — `lib/market/historical-fetcher.ts`
- **INTRADAY_PERIODS** (2 connections) — `lib/market/historical-fetcher.ts`
- **VALID_INTERVALS** (2 connections) — `lib/market/historical-fetcher.ts`
- **VALID_PERIODS** (2 connections) — `lib/market/historical-fetcher.ts`
- **YAHOO_INTERVALS** (2 connections) — `lib/market/historical-fetcher.ts`
- **FetchHistoricalResult** (1 connections) — `lib/market/historical-fetcher.ts`
- **.constructor()** (1 connections) — `lib/market/historical-fetcher.ts`
- **dynamic** (1 connections) — `app/api/market/historical/route.ts`

## Relationships

- [Market Data Manager](Market_Data_Manager.md) (10 shared connections)
- [Historical Bar Routes](Historical_Bar_Routes.md) (7 shared connections)
- [Symbol Mapping Utilities](Symbol_Mapping_Utilities.md) (4 shared connections)
- [Broker Connection Status](Broker_Connection_Status.md) (3 shared connections)
- [Strategy Backtesting Engine](Strategy_Backtesting_Engine.md) (2 shared connections)

## Source Files

- `__tests__/api/market-historical.test.ts`
- `app/api/market/historical/route.ts`
- `lib/market/historical-fetcher.ts`
- `lib/market/yahoo-client.ts`

## Audit Trail

- EXTRACTED: 74 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*