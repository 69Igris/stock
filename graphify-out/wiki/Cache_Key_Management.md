# Cache Key Management

> 62 nodes

## Key Concepts

- **cache/index.ts** (77 connections) — `packages/core/src/cache/index.ts`
- **getRedisClient()** (37 connections) — `packages/core/src/cache/redis.ts`
- **generateCacheKey()** (25 connections) — `packages/cache/src/keys.ts`
- **cache/client.ts** (25 connections) — `packages/core/src/cache/client.ts`
- **cacheClient** (23 connections) — `packages/core/src/cache/client.ts`
- **cache/src/index.ts** (22 connections) — `packages/cache/src/index.ts`
- **wrapper.ts** (22 connections) — `packages/core/src/cache/wrapper.ts`
- **invalidation.ts** (21 connections) — `packages/core/src/cache/invalidation.ts`
- **sanitizeUserId()** (17 connections) — `packages/cache/src/keys.ts`
- **clearTradeCache()** (16 connections) — `packages/core/src/cache/invalidation.ts`
- **clearUserCache()** (16 connections) — `packages/core/src/cache/invalidation.ts`
- **memory-ttl.test.ts** (13 connections) — `packages/core/__tests__/cache/memory-ttl.test.ts`
- **CacheConfig** (12 connections) — `packages/cache/src/types.ts`
- **CacheKey** (11 connections) — `packages/cache/src/types.ts`
- **keys.ts** (11 connections) — `packages/cache/src/keys.ts`
- **clearFireCache()** (9 connections) — `packages/core/src/cache/invalidation.ts`
- **cache/src/types.ts** (9 connections) — `packages/cache/src/types.ts`
- **CacheModule** (8 connections) — `packages/cache/src/types.ts`
- **.get()** (8 connections) — `packages/core/src/cache/client.ts`
- **.getMany()** (8 connections) — `packages/core/src/cache/client.ts`
- **clearBrokerConnectionCache()** (8 connections) — `packages/core/src/cache/invalidation.ts`
- **clearBrokerSyncCache()** (8 connections) — `packages/core/src/cache/invalidation.ts`
- **clearPositionCache()** (8 connections) — `packages/core/src/cache/invalidation.ts`
- **getCacheConfig()** (8 connections) — `packages/core/src/cache/wrapper.ts`
- **generateCachePattern()** (7 connections) — `packages/cache/src/keys.ts`
- *... and 37 more nodes in this community*

## Relationships

- [Redis Connection Management](Redis_Connection_Management.md) (29 shared connections)
- [Stale-While-Error Cache Utility](Stale-While-Error_Cache_Utility.md) (11 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (8 shared connections)
- [Trade History Analytics](Trade_History_Analytics.md) (8 shared connections)
- [Tiingo Minute Bar Aggregation](Tiingo_Minute_Bar_Aggregation.md) (7 shared connections)
- [Sparkline Generation and Caching](Sparkline_Generation_and_Caching.md) (6 shared connections)
- [User Account Deletion Pipeline](User_Account_Deletion_Pipeline.md) (6 shared connections)
- [Portfolio Holdings Grouping Logic](Portfolio_Holdings_Grouping_Logic.md) (5 shared connections)
- [Trading Position Calculations](Trading_Position_Calculations.md) (5 shared connections)
- [Broker Connection Auth Logic](Broker_Connection_Auth_Logic.md) (5 shared connections)
- [Candle Cold Storage](Candle_Cold_Storage.md) (4 shared connections)
- [Chat History Pagination Logic](Chat_History_Pagination_Logic.md) (4 shared connections)

## Source Files

- `packages/cache/src/index.ts`
- `packages/cache/src/keys.ts`
- `packages/cache/src/types.ts`
- `packages/core/__tests__/cache/memory-ttl.test.ts`
- `packages/core/src/cache/client.ts`
- `packages/core/src/cache/index.ts`
- `packages/core/src/cache/invalidation.ts`
- `packages/core/src/cache/redis.ts`
- `packages/core/src/cache/stale-while-error.ts`
- `packages/core/src/cache/wrapper.ts`
- `packages/logger/src/index.ts`
- `packages/services/src/broker-connection.service.ts`
- `packages/services/src/holdings.service.ts`

## Audit Trail

- EXTRACTED: 358 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*