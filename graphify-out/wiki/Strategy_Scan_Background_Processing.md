# Strategy Scan Background Processing

> 18 nodes

## Key Concepts

- **processors/strategy-scan.ts** (20 connections) — `workers/src/processors/strategy-scan.ts`
- **strategy-scan-logic.ts** (12 connections) — `workers/src/processors/strategy-scan-logic.ts`
- **processStrategyScan()** (11 connections) — `workers/src/processors/strategy-scan.ts`
- **routes/strategy-scan.ts** (9 connections) — `workers/src/routes/strategy-scan.ts`
- **StrategyScanMessage** (7 connections) — `packages/types/src/pubsub.ts`
- **StrategiesServiceDeps** (4 connections) — `packages/services/src/strategies.service.ts`
- **buildScanFailedNotification()** (4 connections) — `workers/src/processors/strategy-scan-logic.ts`
- **extractScanErrorMessage()** (4 connections) — `workers/src/processors/strategy-scan-logic.ts`
- **buildScanCompletedNotification()** (3 connections) — `workers/src/processors/strategy-scan-logic.ts`
- **shouldSkipScan()** (3 connections) — `workers/src/processors/strategy-scan-logic.ts`
- **shouldUpdateUsageCount()** (3 connections) — `workers/src/processors/strategy-scan-logic.ts`
- **StrategyScanLike** (2 connections) — `workers/src/processors/strategy-scan-logic.ts`
- **strategyScanRoute** (2 connections) — `workers/src/routes/strategy-scan.ts`
- **ScanNotification** (1 connections) — `workers/src/processors/strategy-scan-logic.ts`
- **ScanType** (1 connections) — `workers/src/processors/strategy-scan-logic.ts`
- **StrategyInput** (1 connections) — `workers/src/processors/strategy-scan-logic.ts`
- **StrategyLogic** (1 connections) — `workers/src/processors/strategy-scan-logic.ts`
- **buildStrategyInput()** (1 connections) — `workers/src/processors/strategy-scan-logic.ts`

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (6 shared connections)
- [Built-in Trading Strategies](Built-in_Trading_Strategies.md) (5 shared connections)
- [Technical Market Indicators](Technical_Market_Indicators.md) (4 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (4 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [PubSub Enrichment Jobs](PubSub_Enrichment_Jobs.md) (1 shared connections)

## Source Files

- `packages/services/src/strategies.service.ts`
- `packages/types/src/pubsub.ts`
- `workers/src/processors/strategy-scan-logic.ts`
- `workers/src/processors/strategy-scan.ts`
- `workers/src/routes/strategy-scan.ts`

## Audit Trail

- EXTRACTED: 57 (98%)
- INFERRED: 1 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*