# Stock Screener Engine Filtering

> 44 nodes

## Key Concepts

- **engine.ts** (82 connections) — `packages/core/src/screener/engine.ts`
- **runScreener()** (18 connections) — `packages/core/src/screener/engine.ts`
- **index-constituents.ts** (10 connections) — `packages/core/src/screener/index-constituents.ts`
- **sectorWritableWhere()** (8 connections) — `packages/core/src/market-data/instruments/sector-write-guard.ts`
- **applyTechnicalFilters()** (7 connections) — `packages/core/src/screener/engine.ts`
- **runTechnicalScreen()** (7 connections) — `packages/core/src/screener/engine.ts`
- **findUnavailableFields()** (6 connections) — `packages/core/src/screener/engine.ts`
- **query-to-filters-market-vocabulary.test.ts** (6 connections) — `packages/research/__tests__/query-to-filters-market-vocabulary.test.ts`
- **backfillMissingSectors()** (5 connections) — `packages/core/src/screener/engine.ts`
- **run52WeekDistanceScreen()** (5 connections) — `packages/core/src/screener/engine.ts`
- **isMarketStructure()** (5 connections) — `packages/core/src/screener/market-fields-logic.ts`
- **screener-chunk-explode-ceiling.test.ts** (5 connections) — `packages/core/__tests__/screener/screener-chunk-explode-ceiling.test.ts`
- **marketFieldUniverse** (4 connections) — `packages/core/src/screener/market-fields-logic.ts`
- **fetchCandlesForInstruments()** (4 connections) — `packages/core/src/screener/engine.ts`
- **isFundamental()** (4 connections) — `packages/core/src/screener/engine.ts`
- **runFundamentalScreen()** (4 connections) — `packages/core/src/screener/engine.ts`
- **alwaysNullMarketFields()** (4 connections) — `packages/core/src/screener/market-fields-logic.ts`
- **MARKET_FIELDS** (4 connections) — `packages/core/src/screener/market-fields-logic.ts`
- **chunkArray()** (3 connections) — `packages/core/src/screener/engine.ts`
- **fetchCandleChunk()** (3 connections) — `packages/core/src/screener/engine.ts`
- **normalizeField()** (3 connections) — `packages/core/src/screener/engine.ts`
- **seedMarketUniverse()** (3 connections) — `packages/core/src/screener/engine.ts`
- **SCREENER_CANDLE_LIMIT** (3 connections) — `packages/core/src/screener/engine.ts`
- **SCREENER_PRICE_CHUNK_CONCURRENCY** (3 connections) — `packages/core/src/screener/engine.ts`
- **SCREENER_PRICE_CHUNK_SIZE** (3 connections) — `packages/core/src/screener/engine.ts`
- *... and 19 more nodes in this community*

## Relationships

- [Market Structure Screening](Market_Structure_Screening.md) (37 shared connections)
- [Stock Screener Strategies](Stock_Screener_Strategies.md) (13 shared connections)
- [Technical Filter Engine Tests](Technical_Filter_Engine_Tests.md) (10 shared connections)
- [Technical Analysis Indicators](Technical_Analysis_Indicators.md) (4 shared connections)
- [Instrument Sector Enrichment](Instrument_Sector_Enrichment.md) (3 shared connections)
- [Sector Write Guard Validation](Sector_Write_Guard_Validation.md) (3 shared connections)
- [NSE Sector Taxonomy](NSE_Sector_Taxonomy.md) (3 shared connections)
- [Yahoo Finance Market Data](Yahoo_Finance_Market_Data.md) (3 shared connections)
- [Technical Market Indicators](Technical_Market_Indicators.md) (3 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (2 shared connections)
- [Stock Tabs Financials Formatting](Stock_Tabs_Financials_Formatting.md) (2 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/screener/screener-chunk-explode-ceiling.test.ts`
- `packages/core/src/market-data/instruments/sector-write-guard.ts`
- `packages/core/src/screener/engine.ts`
- `packages/core/src/screener/index-constituents.ts`
- `packages/core/src/screener/market-fields-logic.ts`
- `packages/core/src/screener/market-fields.ts`
- `packages/research/__tests__/query-to-filters-market-vocabulary.test.ts`

## Audit Trail

- EXTRACTED: 159 (99%)
- INFERRED: 2 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*