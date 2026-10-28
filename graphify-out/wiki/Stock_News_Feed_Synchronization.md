# Stock News Feed Synchronization

> 36 nodes

## Key Concepts

- **processors/news-sync.ts** (27 connections) — `workers/src/processors/news-sync.ts`
- **news-sync-population-and-rotation.test.ts** (19 connections) — `workers/__tests__/processors/news-sync-population-and-rotation.test.ts`
- **news-sync-logic.ts** (14 connections) — `workers/src/processors/news-sync-logic.ts`
- **processNewsSync()** (12 connections) — `workers/src/processors/news-sync.ts`
- **NewsRefreshResult** (4 connections) — `packages/research/src/data-sources/db-store.ts`
- **buildNewsDiscoveryWhere()** (4 connections) — `workers/src/processors/news-sync-logic.ts`
- **needsSymbolDiscovery()** (4 connections) — `workers/src/processors/news-sync-logic.ts`
- **normalizeDiscoverySymbols()** (4 connections) — `workers/src/processors/news-sync-logic.ts`
- **describeNewsShortfall()** (3 connections) — `workers/src/processors/news-sync.ts`
- **loadDiscoverySymbols()** (3 connections) — `workers/src/processors/news-sync.ts`
- **resolveNewsSyncParams()** (3 connections) — `workers/src/processors/news-sync-logic.ts`
- **applyOrderBy()** (3 connections) — `workers/__tests__/processors/news-sync-population-and-rotation.test.ts`
- **makeDb()** (3 connections) — `workers/__tests__/processors/news-sync-population-and-rotation.test.ts`
- **matches()** (3 connections) — `workers/__tests__/processors/news-sync-population-and-rotation.test.ts`
- **NEWS_DISCOVERY_EXCHANGE** (3 connections) — `workers/src/processors/news-sync-logic.ts`
- **NewsRefreshCounts** (2 connections) — `packages/research/src/data-sources/db-store.ts`
- **NewsSyncDeps** (2 connections) — `workers/src/processors/news-sync.ts`
- **NewsSyncMessage** (2 connections) — `workers/src/processors/news-sync.ts`
- **stampSyncMarker()** (2 connections) — `workers/src/processors/news-sync.ts`
- **leafMatches()** (2 connections) — `workers/__tests__/processors/news-sync-population-and-rotation.test.ts`
- **rank()** (2 connections) — `workers/__tests__/processors/news-sync-population-and-rotation.test.ts`
- **DEFAULT_NEWS_LIMIT** (2 connections) — `workers/src/processors/news-sync-logic.ts`
- **NEWS_PER_SYMBOL** (2 connections) — `workers/src/processors/news-sync-logic.ts`
- **Db** (1 connections) — `workers/src/processors/news-sync.ts`
- **DiscoveryPopulations** (1 connections) — `workers/src/processors/news-sync.ts`
- *... and 11 more nodes in this community*

## Relationships

- [Stock Document Synchronization](Stock_Document_Synchronization.md) (4 shared connections)
- [Stock Financials Normalization](Stock_Financials_Normalization.md) (3 shared connections)
- [PubSub Message Handlers](PubSub_Message_Handlers.md) (3 shared connections)
- [Datadog Telemetry Metrics](Datadog_Telemetry_Metrics.md) (3 shared connections)
- [Portfolio Roast Agent Pipeline](Portfolio_Roast_Agent_Pipeline.md) (2 shared connections)
- [PubSub Pull Subscription Workers](PubSub_Pull_Subscription_Workers.md) (2 shared connections)
- [News Scraping and Fetching Tool](News_Scraping_and_Fetching_Tool.md) (1 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)

## Source Files

- `packages/research/src/data-sources/db-store.ts`
- `workers/__tests__/processors/news-sync-population-and-rotation.test.ts`
- `workers/src/processors/news-sync-logic.ts`
- `workers/src/processors/news-sync.ts`

## Audit Trail

- EXTRACTED: 78 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*