# Sparkline Generation and Caching

> 32 nodes

## Key Concepts

- **sparkline.service.ts** (26 connections) — `packages/services/src/sparkline.service.ts`
- **processors/sparkline-sync.ts** (16 connections) — `workers/src/processors/sparkline-sync.ts`
- **sparkline.ts** (12 connections) — `packages/core/src/market-data/sparkline.ts`
- **getSparklines()** (8 connections) — `packages/services/src/sparkline.service.ts`
- **sparkline-logic.ts** (8 connections) — `packages/services/src/sparkline-logic.ts`
- **fetchSparkline()** (6 connections) — `packages/core/src/market-data/sparkline.ts`
- **SparklineSymbol** (5 connections) — `packages/core/src/market-data/sparkline.ts`
- **SparklineWindow** (5 connections) — `packages/core/src/market-data/sparkline.ts`
- **fetchSparklines()** (5 connections) — `packages/core/src/market-data/sparkline.ts`
- **sanitizeCloses()** (5 connections) — `packages/services/src/sparkline-logic.ts`
- **processSparklineSync()** (5 connections) — `workers/src/processors/sparkline-sync.ts`
- **SparklineResult** (4 connections) — `packages/core/src/market-data/sparkline.ts`
- **sparklineCacheKey()** (4 connections) — `packages/core/src/market-data/sparkline.ts`
- **toYahooSparklineSymbol()** (4 connections) — `packages/core/src/market-data/sparkline.ts`
- **scaleSparklineToViewBox()** (4 connections) — `packages/services/src/sparkline-logic.ts`
- **sparklineKey()** (4 connections) — `packages/services/src/sparkline.service.ts`
- **sanitizeResult()** (3 connections) — `packages/services/src/sparkline.service.ts`
- **buildHotUniverse()** (3 connections) — `workers/src/processors/sparkline-sync.ts`
- **finite()** (2 connections) — `packages/services/src/sparkline-logic.ts`
- **sparklinePointsAttr()** (2 connections) — `packages/services/src/sparkline-logic.ts`
- **chunk()** (2 connections) — `workers/src/processors/sparkline-sync.ts`
- **isExchange()** (2 connections) — `workers/src/processors/sparkline-sync.ts`
- **ScaleSparklineOptions** (1 connections) — `packages/services/src/sparkline-logic.ts`
- **sparklineExtent** (1 connections) — `packages/services/src/sparkline-logic.ts`
- **SparklinePoint** (1 connections) — `packages/services/src/sparkline-logic.ts`
- *... and 7 more nodes in this community*

## Relationships

- [Market Discovery Positioning](Market_Discovery_Positioning.md) (8 shared connections)
- [Redis Connection Management](Redis_Connection_Management.md) (6 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (6 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (5 shared connections)
- [Yahoo Finance Market Data](Yahoo_Finance_Market_Data.md) (3 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Stock Financials Normalization](Stock_Financials_Normalization.md) (2 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (2 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/core/src/market-data/sparkline.ts`
- `packages/services/src/sparkline-logic.ts`
- `packages/services/src/sparkline.service.ts`
- `workers/src/processors/sparkline-sync.ts`

## Audit Trail

- EXTRACTED: 92 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*