# Databento OHLCV Candle Loading

> 95 nodes

## Key Concepts

- **databento-logic.ts** (88 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **databento-logic.test.ts** (35 connections) — `packages/core/__tests__/market-data/databento-logic.test.ts`
- **databento-candle-loader.ts** (25 connections) — `packages/core/src/market-data/databento/databento-candle-loader.ts`
- **splitCsvLine()** (23 connections) — `packages/core/src/market-data/csv-line.ts`
- **databento-symbology.ts** (23 connections) — `packages/core/src/market-data/databento/databento-symbology.ts`
- **QuarantineLedger** (15 connections) — `packages/core/src/market-data/databento/databento-symbology.ts`
- **databento-candle-loader.test.ts** (15 connections) — `packages/core/__tests__/market-data/databento-candle-loader.test.ts`
- **loadOhlcvStream()** (14 connections) — `packages/core/src/market-data/databento/databento-candle-loader.ts`
- **ListingRow** (11 connections) — `packages/core/src/market-data/databento/databento-symbology.ts`
- **databento-symbology.test.ts** (11 connections) — `packages/core/__tests__/market-data/databento-symbology.test.ts`
- **csv-line.ts** (10 connections) — `packages/core/src/market-data/csv-line.ts`
- **loader-heap-probe.ts** (10 connections) — `packages/core/__tests__/fixtures/databento/loader-heap-probe.ts`
- **parseBboRow()** (8 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **resolveListingForDate()** (8 connections) — `packages/core/src/market-data/databento/databento-symbology.ts`
- **DATABENTO_SOURCE** (8 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **parseBboHeader()** (7 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **parseJobResponse()** (7 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **parseOhlcvRow()** (7 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **asString()** (6 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **buildCostQuery()** (6 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **buildSubmitJobForm()** (6 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **fromDatabentoSymbol()** (6 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **parseListFiles()** (6 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **parseTbboHeader()** (6 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- **parseTbboRow()** (6 connections) — `packages/core/src/market-data/databento/databento-logic.ts`
- *... and 70 more nodes in this community*

## Relationships

- [Databento Data Harvesting](Databento_Data_Harvesting.md) (36 shared connections)
- [Databento Cost Modeling](Databento_Cost_Modeling.md) (32 shared connections)
- [Databento Storage Client](Databento_Storage_Client.md) (30 shared connections)
- [Databento Manifest Parsing](Databento_Manifest_Parsing.md) (9 shared connections)
- [Databento Market Data Writer](Databento_Market_Data_Writer.md) (8 shared connections)
- [Databento Data Append Logic](Databento_Data_Append_Logic.md) (8 shared connections)
- [Tiingo Corporate Actions Logic](Tiingo_Corporate_Actions_Logic.md) (5 shared connections)
- [Databento API Spend Budgeting](Databento_API_Spend_Budgeting.md) (5 shared connections)
- [Tiingo EOD Data Client](Tiingo_EOD_Data_Client.md) (4 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (3 shared connections)
- [Zerodha Instrument Classification](Zerodha_Instrument_Classification.md) (3 shared connections)
- [Derivatives Bhavcopy Parsing](Derivatives_Bhavcopy_Parsing.md) (3 shared connections)

## Source Files

- `packages/core/__tests__/fixtures/databento/loader-heap-probe.ts`
- `packages/core/__tests__/market-data/csv-line.test.ts`
- `packages/core/__tests__/market-data/databento-candle-loader.test.ts`
- `packages/core/__tests__/market-data/databento-logic.test.ts`
- `packages/core/__tests__/market-data/databento-symbology.test.ts`
- `packages/core/src/market-data/csv-line.ts`
- `packages/core/src/market-data/databento/databento-candle-loader.ts`
- `packages/core/src/market-data/databento/databento-logic.ts`
- `packages/core/src/market-data/databento/databento-stream.ts`
- `packages/core/src/market-data/databento/databento-symbology.ts`

## Audit Trail

- EXTRACTED: 329 (98%)
- INFERRED: 6 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*