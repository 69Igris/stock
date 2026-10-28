# Strategy Backtesting Engine

> 20 nodes

## Key Concepts

- **backtest/route-logic.ts** (16 connections) — `app/api/backtest/route-logic.ts`
- **backtest/route.ts** (11 connections) — `app/api/backtest/route.ts`
- **backtest.test.ts** (11 connections) — `__tests__/api/backtest.test.ts`
- **POST()** (9 connections) — `app/api/backtest/route.ts`
- **getHistorical()** (7 connections) — `lib/market/yahoo-client.ts`
- **runMACrossover()** (5 connections) — `app/api/backtest/route-logic.ts`
- **runRSIStrategy()** (5 connections) — `app/api/backtest/route-logic.ts`
- **buildResponse()** (4 connections) — `app/api/backtest/route-logic.ts`
- **isKnownStrategy()** (4 connections) — `app/api/backtest/route-logic.ts`
- **normalizeSymbol()** (4 connections) — `app/api/backtest/route-logic.ts`
- **validateBacktestInput()** (4 connections) — `app/api/backtest/route-logic.ts`
- **validateHistoricalData()** (4 connections) — `app/api/backtest/route-logic.ts`
- **calculateRSI()** (3 connections) — `app/api/backtest/route-logic.ts`
- **calculateSMA()** (3 connections) — `app/api/backtest/route-logic.ts`
- **BacktestTrade** (2 connections) — `app/api/backtest/route-logic.ts`
- **yahooHistoricalFetcher()** (2 connections) — `lib/market/yahoo-client.ts`
- **BacktestResponse** (1 connections) — `app/api/backtest/route-logic.ts`
- **StrategyName** (1 connections) — `app/api/backtest/route-logic.ts`
- **StrategyRun** (1 connections) — `app/api/backtest/route-logic.ts`
- **VALID_STRATEGIES** (1 connections) — `app/api/backtest/route-logic.ts`

## Relationships

- [Market Data Manager](Market_Data_Manager.md) (4 shared connections)
- [Historical Bar Fetching](Historical_Bar_Fetching.md) (2 shared connections)

## Source Files

- `__tests__/api/backtest.test.ts`
- `app/api/backtest/route-logic.ts`
- `app/api/backtest/route.ts`
- `lib/market/yahoo-client.ts`

## Audit Trail

- EXTRACTED: 51 (98%)
- INFERRED: 1 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*