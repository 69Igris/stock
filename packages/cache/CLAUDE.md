# @usemoney/cache - CLAUDE.md

## Overview

Multi-layer caching utilities for UseMoney. Provides in-memory cache (L1) and Redis cache (L2) with stale-while-revalidate support.

**Package:** `@usemoney/cache`

---

## Exports

```typescript
import {
  generateCacheKey,
  generateCachePattern,
  parseCacheKey,
  sanitizeUserId,
  DEFAULT_TTL,
} from "@usemoney/cache";
import type {
  CacheConfig,
  CacheEntry,
  CacheModule,
} from "@usemoney/cache/types";
// NOTE: this package is key generation + shared types ONLY. The dual-layer
// Memory+Redis client (withCache/getCached/setCached, clear*Cache) lives in @usemoney/core/cache.
```

---

## Caching Strategy

```
Request → L1 (Memory, 10s TTL) → L2 (Redis, 5min TTL) → Database
```

**Features:**

- Automatic L1 → L2 fallback
- Stale-while-revalidate for expensive operations
- Pattern-based cache invalidation
- User-scoped cache keys

---

## Key Functions

| Function                                         | Description                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `generateCacheKey(module, userId, id, filters?)` | `{module}:{userId}:{id}:{version}` — version = 8-char md5 of filters, else "default" |
| `generateCachePattern(module, userId?, id?)`     | Wildcard pattern for bulk Redis deletes                                              |
| `parseCacheKey(key)`                             | Round-trips a key back into segments (or null)                                       |
| `withCache(key, fn, config)`                     | Get-or-compute — lives in `@usemoney/core/cache`, NOT here                           |

---

## Cache Keys

```typescript
// User-scoped keys — generateCacheKey(module, userId, id, filters?)
generateCacheKey("holdings", userId, "all");
generateCacheKey("positions", userId, "all");
generateCacheKey("trades", userId, "list", { page: 1 }); // filters → 8-char md5 version segment

// Wildcard pattern for bulk Redis deletes
generateCachePattern("holdings", userId);
```

---

## Usage

```typescript
import {
  generateCacheKey,
  generateCachePattern,
  DEFAULT_TTL,
} from "@usemoney/cache";
import { withCache } from "@usemoney/core/cache"; // the actual Memory+Redis client

// Get or compute (key built here, caching done by @usemoney/core/cache)
const holdings = await withCache(
  generateCacheKey("holdings", userId, "all"),
  async () => fetchHoldings(userId),
  { ttl: DEFAULT_TTL.MEDIUM }, // 300s
);

// Invalidate on mutation — pattern for bulk Redis deletes
const pattern = generateCachePattern("holdings", userId);
```

---

## Configuration

```bash
REDIS_URL=redis://...   # consumed by @usemoney/core/cache and apps/web/lib/cache — this package needs no env
# TTLs are code constants: DEFAULT_TTL = SHORT 60 / MEDIUM 300 / LONG 900 / HOUR 3600 / DAY 86400
```

---

## Test Coverage

This package has no standalone tests. Cache logic is tested via the web app tests in `apps/web/__tests__/cache/` (4 files, 107 test cases).

See [`../../TEST-COVERAGE.md`](../../TEST-COVERAGE.md) for the full report.

> **Rule:** When adding tests, update `TEST-COVERAGE.md` in the repo root.

---

## What's Been Completed

- [x] Memory cache (L1)
- [x] Redis cache (L2)
- [x] Cache key generators
- [x] Pattern-based invalidation
- [x] Wrap pattern (get-or-compute)

---

_Last Updated: July 2026_
