# Redis Cache Client

> 13 nodes

## Key Concepts

- **getRedisClient()** (15 connections) — `lib/redis/client.ts`
- **redis/client.ts** (14 connections) — `lib/redis/client.ts`
- **redis/cache.ts** (12 connections) — `lib/redis/cache.ts`
- **redis/index.ts** (9 connections) — `lib/redis/index.ts`
- **setCachedFlags()** (6 connections) — `lib/redis/cache.ts`
- **clearCachedFlags()** (5 connections) — `lib/redis/cache.ts`
- **getCachedFlags()** (5 connections) — `lib/redis/cache.ts`
- **isRedisAvailable()** (5 connections) — `lib/redis/client.ts`
- **clearAllCachedFlags()** (4 connections) — `lib/redis/cache.ts`
- **test-redis.ts** (4 connections) — `scripts/test-redis.ts`
- **testRedisConnection()** (3 connections) — `scripts/test-redis.ts`
- **generateFlagVersion()** (2 connections) — `lib/redis/cache.ts`
- **closeRedisClient()** (2 connections) — `lib/redis/client.ts`

## Relationships

- [Feature App Layouts](Feature_App_Layouts.md) (8 shared connections)
- [Cache Management Routes](Cache_Management_Routes.md) (7 shared connections)
- [Chat Narrative Routing](Chat_Narrative_Routing.md) (3 shared connections)
- [Page Access Guards](Page_Access_Guards.md) (2 shared connections)
- [Learned Pattern Caching](Learned_Pattern_Caching.md) (2 shared connections)
- [Usage and Feature Flags](Usage_and_Feature_Flags.md) (1 shared connections)
- [Product Sync and Clear](Product_Sync_and_Clear.md) (1 shared connections)

## Source Files

- `lib/redis/cache.ts`
- `lib/redis/client.ts`
- `lib/redis/index.ts`
- `scripts/test-redis.ts`

## Audit Trail

- EXTRACTED: 55 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*