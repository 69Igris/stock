# Instrument Sector Enrichment

> 59 nodes

## Key Concepts

- **instruments/sector-enrichment.ts** (34 connections) — `packages/core/src/market-data/instruments/sector-enrichment.ts`
- **instruments/sector-enrichment-logic.ts** (30 connections) — `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- **processors/sector-enrichment.ts** (21 connections) — `workers/src/processors/sector-enrichment.ts`
- **sector-fetch-determinacy.test.ts** (16 connections) — `packages/core/__tests__/market-data/sector-fetch-determinacy.test.ts`
- **sector-enrichment-outage.test.ts** (14 connections) — `workers/__tests__/processors/sector-enrichment-outage.test.ts`
- **processors/sector-enrichment-logic.ts** (13 connections) — `workers/src/processors/sector-enrichment-logic.ts`
- **enrichInstrumentsBySymbol()** (11 connections) — `packages/core/src/market-data/instruments/sector-enrichment.ts`
- **enrichSectors()** (11 connections) — `packages/core/src/market-data/instruments/sector-enrichment.ts`
- **decideErrorOutcome()** (10 connections) — `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- **decideFetchOutcome()** (10 connections) — `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- **toSectorFetchError()** (7 connections) — `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- **seed-sectors.ts** (7 connections) — `scripts/seed/seed-sectors.ts`
- **SectorFetchUnavailableError** (6 connections) — `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- **isSectorFetchUnavailable()** (6 connections) — `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- **makeYahooSectorFetcher()** (6 connections) — `workers/src/processors/sector-enrichment.ts`
- **processSectorEnrichment()** (6 connections) — `workers/src/processors/sector-enrichment.ts`
- **SectorData** (5 connections) — `packages/core/src/market-data/instruments/sector-enrichment.ts`
- **partitionFetchable()** (5 connections) — `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- **EnrichableInstrument** (4 connections) — `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- **groupPendingUpdatesByData()** (4 connections) — `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- **isPermanentSymbolError()** (4 connections) — `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- **run()** (4 connections) — `workers/__tests__/processors/sector-enrichment-outage.test.ts`
- **EnrichmentOutcome** (3 connections) — `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- **flushUpdates()** (3 connections) — `packages/core/src/market-data/instruments/sector-enrichment.ts`
- **selectSymbolKeysToEnrich()** (3 connections) — `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- *... and 34 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (12 shared connections)
- [NSE Sector Taxonomy](NSE_Sector_Taxonomy.md) (11 shared connections)
- [Peer Stock Selection Logic](Peer_Stock_Selection_Logic.md) (6 shared connections)
- [Network Mock Agent Utilities](Network_Mock_Agent_Utilities.md) (5 shared connections)
- [Yahoo Finance Market Data](Yahoo_Finance_Market_Data.md) (4 shared connections)
- [Stock Screener Engine Filtering](Stock_Screener_Engine_Filtering.md) (3 shared connections)
- [Stock Financials Normalization](Stock_Financials_Normalization.md) (3 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Portfolio Holdings Grouping Logic](Portfolio_Holdings_Grouping_Logic.md) (2 shared connections)
- [Intraday Bar Data Synchronization](Intraday_Bar_Data_Synchronization.md) (2 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/market-data/sector-fetch-determinacy.test.ts`
- `packages/core/src/market-data/instruments/sector-enrichment-logic.ts`
- `packages/core/src/market-data/instruments/sector-enrichment.ts`
- `scripts/seed/seed-sectors.ts`
- `workers/__tests__/processors/sector-enrichment-outage.test.ts`
- `workers/src/processors/sector-enrichment-logic.ts`
- `workers/src/processors/sector-enrichment.ts`

## Audit Trail

- EXTRACTED: 179 (99%)
- INFERRED: 2 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*