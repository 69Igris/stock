# Cache Clear Endpoints

> 28 nodes

## Key Concepts

- **cache-routes.test.ts** (15 connections) — `__tests__/api/cache-routes.test.ts`
- **stats-logic.ts** (12 connections) — `app/api/cache/stats-logic.ts`
- **clear-logic.ts** (11 connections) — `app/api/cache/clear-logic.ts`
- **stats/route.ts** (10 connections) — `app/api/cache/stats/route.ts`
- **clear/route.ts** (8 connections) — `app/api/cache/clear/route.ts`
- **POST()** (6 connections) — `app/api/cache/clear/route.ts`
- **GET()** (6 connections) — `app/api/cache/stats/route.ts`
- **calculateHitRate()** (5 connections) — `app/api/cache/stats-logic.ts`
- **calculateOverallStats()** (5 connections) — `app/api/cache/stats-logic.ts`
- **buildAllClearResult()** (4 connections) — `app/api/cache/clear-logic.ts`
- **buildMemoryClearResult()** (4 connections) — `app/api/cache/clear-logic.ts`
- **buildPatternClearResult()** (4 connections) — `app/api/cache/clear-logic.ts`
- **buildUserAllClearResult()** (4 connections) — `app/api/cache/clear-logic.ts`
- **buildUserModulesClearResult()** (4 connections) — `app/api/cache/clear-logic.ts`
- **buildRedisConnectedInfo()** (4 connections) — `app/api/cache/stats-logic.ts`
- **buildRedisDisconnectedInfo()** (4 connections) — `app/api/cache/stats-logic.ts`
- **parseRedisInfo()** (4 connections) — `app/api/cache/stats-logic.ts`
- **ClearResult** (2 connections) — `app/api/cache/clear-logic.ts`
- **CacheStats** (2 connections) — `app/api/cache/stats-logic.ts`
- **RedisConnectedInfo** (2 connections) — `app/api/cache/stats-logic.ts`
- **RedisDisconnectedInfo** (2 connections) — `app/api/cache/stats-logic.ts`
- **validateActionType()** (2 connections) — `app/api/cache/clear-logic.ts`
- **CacheClearBody** (1 connections) — `app/api/cache/clear-logic.ts`
- **CacheLayerStats** (1 connections) — `app/api/cache/stats-logic.ts`
- **OverallCacheStats** (1 connections) — `app/api/cache/stats-logic.ts`
- *... and 3 more nodes in this community*

## Relationships

- No strong cross-community connections detected

## Source Files

- `__tests__/api/cache-routes.test.ts`
- `app/api/cache/clear-logic.ts`
- `app/api/cache/clear/route.ts`
- `app/api/cache/stats-logic.ts`
- `app/api/cache/stats/route.ts`

## Audit Trail

- EXTRACTED: 63 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*