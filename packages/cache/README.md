# @usemoney/cache

> Multi-layer caching utilities for UseMoney

L1 (Memory) + L2 (Redis) caching with stale-while-revalidate support.

## Usage

```typescript
import { cache, getCacheKey, invalidateCache } from "@usemoney/cache";

// Get or compute
const holdings = await cache.wrap(
  getCacheKey.holdings(userId),
  async () => fetchHoldings(userId),
  300, // TTL in seconds
);

// Manual operations
await cache.set(key, value, 60);
const value = await cache.get(key);
await cache.del(key);

// Invalidate
await invalidateCache(`holdings:${userId}*`);
```

## Cache Keys

| Key                             | Description     |
| ------------------------------- | --------------- |
| `getCacheKey.holdings(userId)`  | User holdings   |
| `getCacheKey.positions(userId)` | User positions  |
| `getCacheKey.trades(userId)`    | User trades     |
| `getCacheKey.dashboard(userId)` | Dashboard stats |

## Documentation

See **CLAUDE.md** for details.
