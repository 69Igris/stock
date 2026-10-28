# US EOD Data Synchronization

> 138 nodes

## Key Concepts

- **processors/us-eod-sync.ts** (100 connections) — `workers/src/processors/us-eod-sync.ts`
- **us-eod-sync-logic.test.ts** (99 connections) — `workers/__tests__/processors/us-eod-sync-logic.test.ts`
- **us-eod-sync-logic.ts** (98 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **processUsEodSync()** (21 connections) — `workers/src/processors/us-eod-sync.ts`
- **runPriceLeg()** (13 connections) — `workers/src/processors/us-eod-sync.ts`
- **us-eod-sync-permaticker-prefetch.test.ts** (13 connections) — `workers/__tests__/processors/us-eod-sync-permaticker-prefetch.test.ts`
- **runCorpActionCalendarLeg()** (12 connections) — `workers/src/processors/us-eod-sync.ts`
- **judgeUsEodHealth()** (9 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **resolveUsSessionDate()** (8 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **resolveListingId()** (7 connections) — `packages/core/src/market-data/tiingo/tiingo-corp-actions-logic.ts`
- **isRealSplit()** (6 connections) — `packages/core/src/market-data/candles/candle-logic.ts`
- **buildListingWindowIndex()** (6 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **toFundNavRows()** (6 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **utcMidnight()** (6 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **computeSelected()** (5 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **detectCorporateActions()** (5 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **isWithinRunBudget()** (5 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **legIsDark()** (5 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **requestsSpentByCall()** (5 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **resolveCalendarExDate()** (5 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **resolveWindowStart()** (5 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **shiftIsoDate()** (5 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **shouldChainAnotherBatch()** (5 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **toCandleRows()** (5 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- **UsEodLegVerdict** (4 connections) — `workers/src/processors/us-eod-sync-logic.ts`
- *... and 113 more nodes in this community*

## Relationships

- [Tiingo EOD Data Client](Tiingo_EOD_Data_Client.md) (19 shared connections)
- [Tiingo Corporate Actions Logic](Tiingo_Corporate_Actions_Logic.md) (14 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (8 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (4 shared connections)
- [Parquet Candle Cold Storage](Parquet_Candle_Cold_Storage.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Currency Exchange Rates](Currency_Exchange_Rates.md) (3 shared connections)
- [Candle Repository Sharding](Candle_Repository_Sharding.md) (2 shared connections)
- [Tiingo US EOD Backfill](Tiingo_US_EOD_Backfill.md) (2 shared connections)
- [Market Discovery Positioning](Market_Discovery_Positioning.md) (2 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [Databento Market Data Writer](Databento_Market_Data_Writer.md) (2 shared connections)

## Source Files

- `packages/core/src/market-data/candles/candle-logic.ts`
- `packages/core/src/market-data/tiingo/tiingo-corp-actions-logic.ts`
- `workers/__tests__/processors/us-eod-sync-logic.test.ts`
- `workers/__tests__/processors/us-eod-sync-permaticker-prefetch.test.ts`
- `workers/src/processors/us-eod-sync-logic.ts`
- `workers/src/processors/us-eod-sync.ts`

## Audit Trail

- EXTRACTED: 390 (100%)
- INFERRED: 1 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*