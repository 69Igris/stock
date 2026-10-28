# Strategy Stats Synchronization

> 10 nodes

## Key Concepts

- **processors/strategy-stats-sync.ts** (11 connections) — `workers/src/processors/strategy-stats-sync.ts`
- **routes/strategy-stats-sync.ts** (9 connections) — `workers/src/routes/strategy-stats-sync.ts`
- **StrategyStatsSyncMessage** (4 connections) — `packages/types/src/pubsub.ts`
- **processStrategyStatsSync()** (4 connections) — `workers/src/processors/strategy-stats-sync.ts`
- **computeStrategyStats()** (2 connections) — `workers/src/processors/strategy-stats-sync.ts`
- **strategyStatsSyncRoute** (2 connections) — `workers/src/routes/strategy-stats-sync.ts`
- **StrategyStats** (1 connections) — `workers/src/processors/strategy-stats-sync.ts`
- **BUILT_IN_STRATEGY_IDS** (1 connections) — `workers/src/processors/strategy-stats-sync.ts`
- **CACHE_NAMESPACE** (1 connections) — `workers/src/processors/strategy-stats-sync.ts`
- **TODO: import { runStrategyBacktest } from "@usemoney/research/strategies"** (1 connections) — `workers/src/processors/strategy-stats-sync.ts`

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (6 shared connections)
- [SEO and Chat Components](SEO_and_Chat_Components.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (1 shared connections)

## Source Files

- `packages/types/src/pubsub.ts`
- `workers/src/processors/strategy-stats-sync.ts`
- `workers/src/routes/strategy-stats-sync.ts`

## Audit Trail

- EXTRACTED: 24 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*