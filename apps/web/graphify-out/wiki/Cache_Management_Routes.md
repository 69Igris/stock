# Cache Management Routes

> 47 nodes

## Key Concepts

- **cache/client.ts** (20 connections) — `lib/cache/client.ts`
- **cacheClient** (18 connections) — `lib/cache/client.ts`
- **swr-wrapper.ts** (16 connections) — `lib/cache/swr-wrapper.ts`
- **wrapper.ts** (11 connections) — `lib/cache/wrapper.ts`
- **swr-wrapper.test.ts** (11 connections) — `__tests__/cache/swr-wrapper.test.ts`
- **wrapper-edge-cases.test.ts** (9 connections) — `__tests__/cache/wrapper-edge-cases.test.ts`
- **__tests__/cache/wrapper.test.ts** (9 connections) — `__tests__/cache/wrapper.test.ts`
- **setCached()** (7 connections) — `lib/cache/wrapper.ts`
- **swrCache()** (5 connections) — `lib/cache/swr-wrapper.ts`
- **client-edge-cases.test.ts** (5 connections) — `__tests__/cache/client-edge-cases.test.ts`
- **.get()** (4 connections) — `lib/cache/client.ts`
- **getCached()** (4 connections) — `lib/cache/wrapper.ts`
- **.delete()** (3 connections) — `lib/cache/client.ts`
- **.deletePattern()** (3 connections) — `lib/cache/client.ts`
- **.set()** (3 connections) — `lib/cache/client.ts`
- **isCacheEnabled()** (3 connections) — `lib/cache/client.ts`
- **fetchWithDedup()** (3 connections) — `lib/cache/swr-wrapper.ts`
- **prewarmCache()** (3 connections) — `lib/cache/swr-wrapper.ts`
- **revalidateInBackground()** (3 connections) — `lib/cache/swr-wrapper.ts`
- **withCache()** (3 connections) — `lib/cache/wrapper.ts`
- **status/route.ts** (3 connections) — `app/api/research/preview-plan/[jobId]/status/route.ts`
- **cacheKeys** (3 connections) — `lib/cache/swr-wrapper.ts`
- **.getStats()** (2 connections) — `lib/cache/client.ts`
- **.resetStats()** (2 connections) — `lib/cache/client.ts`
- **getCacheStats()** (2 connections) — `lib/cache/client.ts`
- *... and 22 more nodes in this community*

## Relationships

- [Redis Cache Client](Redis_Cache_Client.md) (7 shared connections)
- [Content Listing Pages](Content_Listing_Pages.md) (6 shared connections)
- [Preview Plan Route](Preview_Plan_Route.md) (2 shared connections)
- [Historical Bar Routes](Historical_Bar_Routes.md) (2 shared connections)
- [Primitive UI Components](Primitive_UI_Components.md) (1 shared connections)

## Source Files

- `__tests__/cache/client-edge-cases.test.ts`
- `__tests__/cache/client.test.ts`
- `__tests__/cache/swr-wrapper.test.ts`
- `__tests__/cache/wrapper-edge-cases.test.ts`
- `__tests__/cache/wrapper.test.ts`
- `app/api/research/preview-plan/[jobId]/status/route.ts`
- `lib/cache/client.ts`
- `lib/cache/keys.ts`
- `lib/cache/swr-wrapper.ts`
- `lib/cache/wrapper.ts`
- `package.json`

## Audit Trail

- EXTRACTED: 101 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*