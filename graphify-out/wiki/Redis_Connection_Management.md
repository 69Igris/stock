# Redis Connection Management

> 54 nodes

## Key Concepts

- **redis.ts** (29 connections) — `packages/core/src/cache/redis.ts`
- **redis-singleton.test.ts** (18 connections) — `packages/core/__tests__/cache/redis-singleton.test.ts`
- **money705-sparkline-batch-cache.test.ts** (16 connections) — `packages/services/__tests__/money705-sparkline-batch-cache.test.ts`
- **resetRedisClient()** (15 connections) — `packages/core/src/cache/redis.ts`
- **__setRedisFactoryForTests()** (15 connections) — `packages/core/src/cache/redis.ts`
- **cache-batch-ops.test.ts** (15 connections) — `packages/core/__tests__/cache-batch-ops.test.ts`
- **us-quote-interest.test.ts** (14 connections) — `packages/core/__tests__/market-data/us-quote-interest.test.ts`
- **FakeRedis** (12 connections) — `packages/core/__tests__/cache/redis-singleton.test.ts`
- **openConnection()** (8 connections) — `packages/core/src/cache/redis.ts`
- **getRedisClientAsync()** (4 connections) — `packages/core/src/cache/redis.ts`
- **isRedisConfigured()** (4 connections) — `packages/core/src/cache/redis.ts`
- **closeRedisConnection()** (3 connections) — `packages/core/src/cache/redis.ts`
- **getRedisUrl()** (3 connections) — `packages/core/src/cache/redis.ts`
- **initRedisClient()** (3 connections) — `packages/core/src/cache/redis.ts`
- **isRedisConnected()** (3 connections) — `packages/core/src/cache/redis.ts`
- **isUsable()** (3 connections) — `packages/core/src/cache/redis.ts`
- **__setRedisClockForTests()** (3 connections) — `packages/core/src/cache/redis.ts`
- **installFakeRedis()** (3 connections) — `packages/core/__tests__/cache-batch-ops.test.ts`
- **installFakeRedis()** (3 connections) — `packages/core/__tests__/market-data/us-quote-interest.test.ts`
- **installFakeRedis()** (3 connections) — `packages/services/__tests__/money705-portfolio-stampede.test.ts`
- **installFakeRedis()** (3 connections) — `packages/services/__tests__/money705-sparkline-batch-cache.test.ts`
- **seed()** (3 connections) — `packages/services/__tests__/money705-sparkline-batch-cache.test.ts`
- **RedisClientFactory** (2 connections) — `packages/core/src/cache/redis.ts`
- **armCooldown()** (2 connections) — `packages/core/src/cache/redis.ts`
- **clientFactory()** (2 connections) — `packages/core/src/cache/redis.ts`
- *... and 29 more nodes in this community*

## Relationships

- [Cache Key Management](Cache_Key_Management.md) (29 shared connections)
- [Tiingo Real-Time Market Quotes](Tiingo_Real-Time_Market_Quotes.md) (12 shared connections)
- [Sparkline Generation and Caching](Sparkline_Generation_and_Caching.md) (6 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (4 shared connections)
- [XBRL Ratio Quality Gates](XBRL_Ratio_Quality_Gates.md) (1 shared connections)
- [OAuth State Token Management](OAuth_State_Token_Management.md) (1 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)
- [Tiingo API Rate Limiting](Tiingo_API_Rate_Limiting.md) (1 shared connections)
- [Stock Screener Engine Filtering](Stock_Screener_Engine_Filtering.md) (1 shared connections)
- [Tiingo Realtime Subscription Planning](Tiingo_Realtime_Subscription_Planning.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/cache-batch-ops.test.ts`
- `packages/core/__tests__/cache/redis-singleton.test.ts`
- `packages/core/__tests__/market-data/us-quote-interest.test.ts`
- `packages/core/src/cache/redis.ts`
- `packages/services/__tests__/money705-portfolio-stampede.test.ts`
- `packages/services/__tests__/money705-sparkline-batch-cache.test.ts`
- `packages/services/src/sparkline.service.ts`

## Audit Trail

- EXTRACTED: 140 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*