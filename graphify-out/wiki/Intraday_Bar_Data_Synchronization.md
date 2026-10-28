# Intraday Bar Data Synchronization

> 27 nodes

## Key Concepts

- **processors/intraday-sync.ts** (26 connections) — `workers/src/processors/intraday-sync.ts`
- **isUnfetchableYahooSymbol()** (11 connections) — `packages/core/src/market-data/instruments/types.ts`
- **intraday-sync-logic.ts** (11 connections) — `workers/src/processors/intraday-sync-logic.ts`
- **intraday-sync-verdict.test.ts** (11 connections) — `workers/__tests__/processors/intraday-sync-verdict.test.ts`
- **processIntradaySync()** (8 connections) — `workers/src/processors/intraday-sync.ts`
- **backfillIntradayBars()** (5 connections) — `packages/core/src/market-data/prices/intraday-bar-service.ts`
- **computeBackfillWindow()** (4 connections) — `workers/src/processors/intraday-sync-logic.ts`
- **resolveIntradayStatus()** (4 connections) — `workers/src/processors/intraday-sync-logic.ts`
- **makeYahooIntradayFetcher()** (4 connections) — `workers/src/processors/intraday-sync.ts`
- **dedupTrackedTuples()** (3 connections) — `workers/src/processors/intraday-sync-logic.ts`
- **resolveTrackedSymbolIds()** (3 connections) — `workers/src/processors/intraday-sync.ts`
- **IntradayTotals** (2 connections) — `workers/src/processors/intraday-sync-logic.ts`
- **parseDateOr()** (2 connections) — `workers/src/processors/intraday-sync-logic.ts`
- **blankComments()** (2 connections) — `workers/__tests__/processors/intraday-sync-verdict.test.ts`
- **spaces()** (2 connections) — `workers/__tests__/processors/intraday-sync-verdict.test.ts`
- **DEFAULT_LOOKBACK_DAYS** (2 connections) — `workers/src/processors/intraday-sync-logic.ts`
- **MAX_SYMBOLS_PER_RUN** (2 connections) — `workers/src/processors/intraday-sync-logic.ts`
- **IntradayFetchTally** (1 connections) — `workers/src/processors/intraday-sync.ts`
- **IntradaySyncResult** (1 connections) — `workers/src/processors/intraday-sync.ts`
- **IntradaySyncVerdict** (1 connections) — `workers/src/processors/intraday-sync-logic.ts`
- **SymbolExchangeTuple** (1 connections) — `workers/src/processors/intraday-sync-logic.ts`
- **DEFAULT_INTERVALS** (1 connections) — `workers/src/processors/intraday-sync.ts`
- **YAHOO_INTERVAL_MAP** (1 connections) — `workers/src/processors/intraday-sync.ts`
- **CODE** (1 connections) — `workers/__tests__/processors/intraday-sync-verdict.test.ts`
- **healthy** (1 connections) — `workers/__tests__/processors/intraday-sync-verdict.test.ts`
- *... and 2 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (7 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Instrument Sector Enrichment](Instrument_Sector_Enrichment.md) (2 shared connections)
- [Stock Quote Caching Logic](Stock_Quote_Caching_Logic.md) (2 shared connections)
- [Price Synchronization Processor](Price_Synchronization_Processor.md) (2 shared connections)
- [Yahoo Finance Market Data](Yahoo_Finance_Market_Data.md) (2 shared connections)
- [Jobs Authentication Middleware](Jobs_Authentication_Middleware.md) (2 shared connections)
- [Zerodha Instrument Classification](Zerodha_Instrument_Classification.md) (1 shared connections)
- [Instrument Synchronization Sweeps](Instrument_Synchronization_Sweeps.md) (1 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/instruments/types.ts`
- `packages/core/src/market-data/prices/intraday-bar-service.ts`
- `workers/__tests__/processors/intraday-sync-verdict.test.ts`
- `workers/src/processors/intraday-sync-logic.ts`
- `workers/src/processors/intraday-sync.ts`

## Audit Trail

- EXTRACTED: 70 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*