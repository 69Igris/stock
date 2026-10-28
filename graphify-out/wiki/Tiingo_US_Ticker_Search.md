# Tiingo US Ticker Search

> 36 nodes

## Key Concepts

- **us-instrument-names.ts** (26 connections) — `packages/core/src/market-data/instruments/us-instrument-names.ts`
- **tiingo-search.ts** (25 connections) — `packages/core/src/market-data/instruments/tiingo-search.ts`
- **us-instrument-names-logic.ts** (18 connections) — `packages/core/src/market-data/instruments/us-instrument-names-logic.ts`
- **us-instrument-names-logic.test.ts** (13 connections) — `packages/core/__tests__/market-data/us-instrument-names-logic.test.ts`
- **search()** (11 connections) — `packages/core/src/market-data/instruments/tiingo-search.ts`
- **enrichUsInstrumentNames()** (10 connections) — `packages/core/src/market-data/instruments/us-instrument-names.ts`
- **fetchMetadata()** (10 connections) — `packages/core/src/market-data/instruments/us-instrument-names.ts`
- **enrichUsInstrumentsWithPermaTicker()** (8 connections) — `packages/core/src/market-data/instruments/tiingo-search.ts`
- **isTiingoRateLimitFailure()** (8 connections) — `packages/core/src/market-data/tiingo/tiingo-budget.ts`
- **tiingo-search-logic.ts** (7 connections) — `packages/core/src/market-data/instruments/tiingo-search-logic.ts`
- **tiingo-search-logic.test.ts** (7 connections) — `packages/core/__tests__/market-data/tiingo-search-logic.test.ts`
- **parseSearchResponse()** (5 connections) — `packages/core/src/market-data/instruments/tiingo-search-logic.ts`
- **resolveSearchMatch()** (5 connections) — `packages/core/src/market-data/instruments/tiingo-search-logic.ts`
- **parseTiingoMetadata()** (5 connections) — `packages/core/src/market-data/instruments/us-instrument-names-logic.ts`
- **resolveUsListingName()** (4 connections) — `packages/core/src/market-data/instruments/us-instrument-names-logic.ts`
- **US_NAME_PAGE_SIZE** (4 connections) — `packages/core/src/market-data/instruments/us-instrument-names-logic.ts`
- **US_SEARCH_PAGE_SIZE** (4 connections) — `packages/core/src/market-data/instruments/us-instrument-names-logic.ts`
- **SearchResolution** (3 connections) — `packages/core/src/market-data/instruments/tiingo-search-logic.ts`
- **TiingoSearchRow** (3 connections) — `packages/core/src/market-data/instruments/tiingo-search-logic.ts`
- **TiingoDailyMetadata** (3 connections) — `packages/core/src/market-data/instruments/us-instrument-names-logic.ts`
- **apiKey()** (3 connections) — `packages/core/src/market-data/instruments/tiingo-search.ts`
- **apiKey()** (3 connections) — `packages/core/src/market-data/instruments/us-instrument-names.ts`
- **US_ENRICH_BUDGET_MS** (3 connections) — `packages/core/src/market-data/instruments/us-instrument-names-logic.ts`
- **US_ENRICH_MAX_CHAIN_DEPTH** (3 connections) — `packages/core/src/market-data/instruments/us-instrument-names-logic.ts`
- **TiingoSearchEnrichmentResult** (2 connections) — `packages/core/src/market-data/instruments/tiingo-search.ts`
- *... and 11 more nodes in this community*

## Relationships

- [Tiingo EOD Data Client](Tiingo_EOD_Data_Client.md) (18 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (15 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (11 shared connections)
- [Tiingo API Rate Limiting](Tiingo_API_Rate_Limiting.md) (8 shared connections)
- [Bhavcopy Market Data Ingestion](Bhavcopy_Market_Data_Ingestion.md) (6 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (2 shared connections)
- [Tiingo Instrument Ingestion](Tiingo_Instrument_Ingestion.md) (2 shared connections)

## Source Files

- `packages/core/__tests__/market-data/tiingo-search-logic.test.ts`
- `packages/core/__tests__/market-data/us-instrument-names-logic.test.ts`
- `packages/core/src/market-data/instruments/tiingo-search-logic.ts`
- `packages/core/src/market-data/instruments/tiingo-search.ts`
- `packages/core/src/market-data/instruments/us-instrument-names-logic.ts`
- `packages/core/src/market-data/instruments/us-instrument-names.ts`
- `packages/core/src/market-data/tiingo/tiingo-budget.ts`

## Audit Trail

- EXTRACTED: 137 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*