# Price Synchronization Processor

> 33 nodes

## Key Concepts

- **processors/price-sync.ts** (33 connections) — `workers/src/processors/price-sync.ts`
- **price-sync-logic.ts** (23 connections) — `workers/src/processors/price-sync-logic.ts`
- **price-sync-verdict.test.ts** (12 connections) — `workers/__tests__/processors/price-sync-verdict.test.ts`
- **processPriceSync()** (11 connections) — `workers/src/processors/price-sync.ts`
- **runHistoricalBackfill()** (8 connections) — `workers/src/processors/price-sync.ts`
- **resolveBackfillStatus()** (4 connections) — `workers/src/processors/price-sync-logic.ts`
- **resolveQuoteRefreshStatus()** (4 connections) — `workers/src/processors/price-sync-logic.ts`
- **makeBatchQuoteFetcher()** (4 connections) — `workers/src/processors/price-sync.ts`
- **BackfillTotals** (3 connections) — `workers/src/processors/price-sync-logic.ts`
- **resolveIncrementalDateRange()** (3 connections) — `workers/src/processors/price-sync-logic.ts`
- **resolveSyncType()** (3 connections) — `workers/src/processors/price-sync-logic.ts`
- **selectBackfillInstruments()** (3 connections) — `workers/src/processors/price-sync-logic.ts`
- **shouldDelay()** (3 connections) — `workers/src/processors/price-sync-logic.ts`
- **shouldLogProgress()** (3 connections) — `workers/src/processors/price-sync-logic.ts`
- **transformRawQuote()** (3 connections) — `workers/src/processors/price-sync-logic.ts`
- **makeHistoricalFetcher()** (3 connections) — `workers/src/processors/price-sync.ts`
- **SyncLogVerdict** (2 connections) — `workers/src/processors/price-sync-logic.ts`
- **blankComments()** (2 connections) — `workers/__tests__/processors/price-sync-verdict.test.ts`
- **spaces()** (2 connections) — `workers/__tests__/processors/price-sync-verdict.test.ts`
- **QUOTE_REFRESH_BATCH_SIZE** (2 connections) — `workers/src/processors/price-sync-logic.ts`
- **BackfillInstrument** (1 connections) — `workers/src/processors/price-sync-logic.ts`
- **PriceSyncType** (1 connections) — `workers/src/processors/price-sync-logic.ts`
- **QuoteRefreshTotals** (1 connections) — `workers/src/processors/price-sync-logic.ts`
- **PriceSyncResult** (1 connections) — `workers/src/processors/price-sync.ts`
- **YahooErrorTally** (1 connections) — `workers/src/processors/price-sync.ts`
- *... and 8 more nodes in this community*

## Relationships

- [Yahoo Finance Market Data](Yahoo_Finance_Market_Data.md) (5 shared connections)
- [Stock Quote Caching Logic](Stock_Quote_Caching_Logic.md) (4 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [Intraday Bar Data Synchronization](Intraday_Bar_Data_Synchronization.md) (2 shared connections)
- [Candle Data Integrity Verification](Candle_Data_Integrity_Verification.md) (2 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (2 shared connections)
- [Jobs Authentication Middleware](Jobs_Authentication_Middleware.md) (2 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `workers/__tests__/processors/price-sync-verdict.test.ts`
- `workers/src/processors/price-sync-logic.ts`
- `workers/src/processors/price-sync.ts`

## Audit Trail

- EXTRACTED: 85 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*