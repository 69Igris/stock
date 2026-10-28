# Symbol Resolution Route

> 22 nodes

## Key Concepts

- **symbols/route.ts** (18 connections) — `app/api/market/udf/symbols/route.ts`
- **udf-symbols.test.ts** (15 connections) — `__tests__/api/udf-symbols.test.ts`
- **symbols-logic.ts** (14 connections) — `app/api/market/udf/symbols/symbols-logic.ts`
- **GET()** (10 connections) — `app/api/market/udf/symbols/route.ts`
- **buildEquitySymbolInfo()** (7 connections) — `app/api/market/udf/symbols/symbols-logic.ts`
- **computeSupportedResolutions()** (7 connections) — `app/api/market/udf/symbols/symbols-logic.ts`
- **buildFundSymbolInfo()** (6 connections) — `app/api/market/udf/symbols/symbols-logic.ts`
- **buildIndexSymbolInfo()** (6 connections) — `app/api/market/udf/symbols/symbols-logic.ts`
- **isUnsupportedEquityExchange()** (4 connections) — `app/api/market/udf/symbols/symbols-logic.ts`
- **parseSymbolPrefix()** (4 connections) — `app/api/market/udf/symbols/symbols-logic.ts`
- **ResolvedSymbol** (3 connections) — `app/api/market/udf/symbols/symbols-logic.ts`
- **findInstrument()** (3 connections) — `lib/market/symbol-mapper.ts`
- **buildEtfSymbol()** (2 connections) — `__tests__/api/udf-symbols.test.ts`
- **buildFundSymbol()** (2 connections) — `__tests__/api/udf-symbols.test.ts`
- **buildIndexSymbol()** (2 connections) — `__tests__/api/udf-symbols.test.ts`
- **buildStockSymbol()** (2 connections) — `__tests__/api/udf-symbols.test.ts`
- **ALL_INTRADAY_RESOLUTIONS** (2 connections) — `app/api/market/udf/symbols/symbols-logic.ts`
- **DAILY_RESOLUTIONS** (2 connections) — `app/api/market/udf/symbols/symbols-logic.ts`
- **ZERODHA_ONLY_RESOLUTIONS** (2 connections) — `app/api/market/udf/symbols/symbols-logic.ts`
- **TvSymbolType** (1 connections) — `app/api/market/udf/symbols/symbols-logic.ts`
- **dynamic** (1 connections) — `app/api/market/udf/symbols/route.ts`
- **SUPPORTED_EQUITY_EXCHANGES** (1 connections) — `app/api/market/udf/symbols/symbols-logic.ts`

## Relationships

- [Symbol Mapping Utilities](Symbol_Mapping_Utilities.md) (3 shared connections)
- [Paper Trading Views](Paper_Trading_Views.md) (2 shared connections)
- [Chart Marks Route](Chart_Marks_Route.md) (2 shared connections)
- [Market Data Manager](Market_Data_Manager.md) (1 shared connections)
- [UDF Configuration Routes](UDF_Configuration_Routes.md) (1 shared connections)
- [Demo Seed Data](Demo_Seed_Data.md) (1 shared connections)

## Source Files

- `__tests__/api/udf-symbols.test.ts`
- `app/api/market/udf/symbols/route.ts`
- `app/api/market/udf/symbols/symbols-logic.ts`
- `lib/market/symbol-mapper.ts`

## Audit Trail

- EXTRACTED: 62 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*