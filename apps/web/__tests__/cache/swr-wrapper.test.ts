/**
 * SWR (Stale-While-Revalidate) Cache Wrapper Tests — REAL source
 * (apps/web/lib/cache/swr-wrapper.ts).
 *
 * De-shadowed (MONEY-620): the previous version re-implemented `swrCache`,
 * `fetchWithDedup`, `revalidateInBackground`, `invalidateCache`,
 * `prewarmCache` and `cacheKeys` INLINE and threaded a `MockCacheClient` in as
 * a parameter — the real wrapper was never executed. This now imports the REAL
 * `swrCache` / `invalidateCache` / `prewarmCache` / `cacheKeys` exports, which
 * talk to the module-singleton `cacheClient`.
 *
 * Strategy: the singleton's Memory (L1) layer works with zero network when no
 * Redis is configured (the test runner). We drive the real functions with
 * `enableRedis: false` (memory-only) and assert behaviour through results and
 * by reading the singleton back. Where the old test inspected `setCalls`, we
 * spy the REAL `cacheClient.set` via `node:test` `mock.method` so the captured
 * key/data/config come from production code, not a stand-in.
 *
 * `clearMemory()` + `mock.restoreAll()` run per-test for isolation (L1 + the
 * in-flight dedup map live in module scope).
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  swrCache,
  invalidateCache,
  invalidateCachePattern,
  prewarmCache,
  cacheKeys,
} from "@/lib/cache/swr-wrapper";
import { cacheClient } from "@/lib/cache/client";
import type { CacheConfig } from "@usemoney/cache";

const MEMORY_ONLY = { enableRedis: false } as const;

interface SetCall {
  key: string;
  data: unknown;
  config: CacheConfig;
}

/** Spy the REAL singleton set; returns the captured calls. */
function spySet(): SetCall[] {
  const calls: SetCall[] = [];
  const original = cacheClient.set.bind(cacheClient);
  mock.method(
    cacheClient,
    "set",
    async (
      key: string,
      data: unknown,
      config: CacheConfig,
      version?: string
    ) => {
      calls.push({ key, data, config });
      return original(key, data, config, version);
    }
  );
  return calls;
}

describe("SWR Cache Wrapper (real @/lib/cache/swr-wrapper)", () => {
  beforeEach(async () => {
    await cacheClient.clearMemory();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  // ==========================================================================
  // Basic fetch behavior
  // ==========================================================================

  describe("Cache Miss (no cached data)", () => {
    it("should fetch fresh data when cache is empty", async () => {
      const fetcher = mock.fn(async () => ({ value: 42 }));
      const result = await swrCache<{ value: number }>({
        key: "test:fresh",
        fetcher,
        ...MEMORY_ONLY,
      });

      assert.deepStrictEqual(result.data, { value: 42 });
      assert.strictEqual(result.isStale, false);
      assert.strictEqual(result.isLoading, false);
      assert.strictEqual(result.error, null);
    });

    it("should call fetcher exactly once on cache miss", async () => {
      let callCount = 0;
      const fetcher = async () => {
        callCount++;
        return { count: callCount };
      };

      await swrCache({ key: "test:once", fetcher, ...MEMORY_ONLY });

      assert.strictEqual(callCount, 1);
    });

    it("should store fetched data in cache", async () => {
      const setCalls = spySet();
      const fetcher = async () => ({ stored: true });
      await swrCache({ key: "test:store", fetcher, ...MEMORY_ONLY });

      assert.ok(setCalls.length > 0, "Should have stored in cache");
      assert.strictEqual(setCalls[0]!.key, "test:store");
    });

    it("should wrap data with timestamp when storing", async () => {
      const setCalls = spySet();
      const fetcher = async () => ({ wrapped: true });
      const before = Date.now();
      await swrCache({ key: "test:wrap", fetcher, ...MEMORY_ONLY });
      const after = Date.now();

      const setData = setCalls[0]!.data as {
        data: unknown;
        timestamp: number;
      };
      assert.deepStrictEqual(setData.data, { wrapped: true });
      assert.ok(setData.timestamp >= before);
      assert.ok(setData.timestamp <= after);
    });
  });

  // ==========================================================================
  // Cache Hit behavior
  // ==========================================================================

  describe("Cache Hit (fresh data)", () => {
    it("should return cached data when it is fresh", async () => {
      // Pre-populate cache with fresh data via the SAME shape swrCache writes
      await cacheClient.set(
        "test:hit",
        { data: { cached: true }, timestamp: Date.now() },
        { ttl: 300, enableMemory: true, enableRedis: false }
      );

      const fetcher = mock.fn(async () => ({ cached: false }));
      const result = await swrCache<{ cached: boolean }>({
        key: "test:hit",
        fetcher,
        ttl: 300,
        ...MEMORY_ONLY,
      });

      assert.deepStrictEqual(result.data, { cached: true });
      assert.strictEqual(result.isStale, false);
      assert.strictEqual(fetcher.mock.callCount(), 0);
    });

    it("should not call fetcher for fresh cached data", async () => {
      await cacheClient.set(
        "test:nofetch",
        { data: "hello", timestamp: Date.now() },
        { ttl: 300, enableMemory: true, enableRedis: false }
      );

      let called = false;
      const fetcher = async () => {
        called = true;
        return "world";
      };

      await swrCache({
        key: "test:nofetch",
        fetcher,
        ttl: 300,
        ...MEMORY_ONLY,
      });
      assert.strictEqual(called, false);
    });
  });

  // ==========================================================================
  // Stale data behavior
  // ==========================================================================

  describe("Stale Data (within stale window)", () => {
    it("should return stale data with isStale=true", async () => {
      const ttl = 60;
      const staleTime = 120;
      const timestamp = Date.now() - (ttl + 10) * 1000; // 70s old

      await cacheClient.set(
        "test:stale",
        { data: { stale: true }, timestamp },
        { ttl, enableMemory: true, enableRedis: false }
      );

      const fetcher = async () => ({ stale: false });
      const result = await swrCache<{ stale: boolean }>({
        key: "test:stale",
        fetcher,
        ttl,
        staleTime,
        ...MEMORY_ONLY,
      });

      assert.deepStrictEqual(result.data, { stale: true });
      assert.strictEqual(result.isStale, true);
    });

    it("should trigger background revalidation for stale data", async () => {
      const ttl = 60;
      const staleTime = 120;
      const timestamp = Date.now() - (ttl + 5) * 1000;

      await cacheClient.set(
        "test:revalidate",
        { data: "old", timestamp },
        { ttl, enableMemory: true, enableRedis: false }
      );

      const setCalls = spySet();
      const fetcher = async () => "fresh";
      await swrCache({
        key: "test:revalidate",
        fetcher,
        ttl,
        staleTime,
        ...MEMORY_ONLY,
      });

      // Wait for background revalidation (fire-and-forget) to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const setForKey = setCalls.filter((c) => c.key === "test:revalidate");
      assert.ok(setForKey.length >= 1, "Should have revalidated in background");
      const latest = setForKey[setForKey.length - 1]!.data as { data: string };
      assert.strictEqual(latest.data, "fresh");
    });
  });

  // ==========================================================================
  // Too-old data behavior
  // ==========================================================================

  describe("Too-Old Data (beyond stale window)", () => {
    it("should fetch fresh data when cache is too old", async () => {
      const ttl = 60;
      const staleTime = 120;
      const timestamp = Date.now() - (staleTime + 10) * 1000; // 130s old

      await cacheClient.set(
        "test:tooold",
        { data: "ancient", timestamp },
        { ttl, enableMemory: true, enableRedis: false }
      );

      const fetcher = async () => "brand-new";
      const result = await swrCache<string>({
        key: "test:tooold",
        fetcher,
        ttl,
        staleTime,
        ...MEMORY_ONLY,
      });

      assert.strictEqual(result.data, "brand-new");
      assert.strictEqual(result.isStale, false);
    });

    it("should update cache with fresh data after fetching", async () => {
      const ttl = 60;
      const staleTime = 120;
      const timestamp = Date.now() - (staleTime + 10) * 1000;

      await cacheClient.set(
        "test:update",
        { data: "old", timestamp },
        { ttl, enableMemory: true, enableRedis: false }
      );

      const setCalls = spySet();
      const fetcher = async () => "new";
      await swrCache({
        key: "test:update",
        fetcher,
        ttl,
        staleTime,
        ...MEMORY_ONLY,
      });

      const latestSet = setCalls[setCalls.length - 1]!;
      const setData = latestSet.data as { data: string; timestamp: number };
      assert.strictEqual(setData.data, "new");
    });
  });

  // ==========================================================================
  // Default TTL and staleTime
  // ==========================================================================

  describe("TTL and staleTime defaults", () => {
    it("should use default TTL of 300 seconds", async () => {
      const setCalls = spySet();
      const fetcher = async () => "data";
      await swrCache({ key: "test:defaults", fetcher, ...MEMORY_ONLY });

      assert.strictEqual(setCalls[0]!.config.ttl, 300);
    });

    it("should use custom TTL when provided", async () => {
      const setCalls = spySet();
      const fetcher = async () => "data";
      await swrCache({
        key: "test:custom-ttl",
        fetcher,
        ttl: 60,
        ...MEMORY_ONLY,
      });

      assert.strictEqual(setCalls[0]!.config.ttl, 60);
    });

    it("should default staleTime to 2x TTL", async () => {
      const ttl = 30;
      // Data older than TTL but within 2*TTL should be stale (not too old)
      const timestamp = Date.now() - (ttl + 5) * 1000; // 35s old, staleTime=60

      await cacheClient.set(
        "test:stale-default",
        { data: "stale", timestamp },
        { ttl, enableMemory: true, enableRedis: false }
      );

      const fetcher = async () => "fresh";
      const result = await swrCache<string>({
        key: "test:stale-default",
        fetcher,
        ttl,
        ...MEMORY_ONLY,
      });

      // Should be stale but still returned
      assert.strictEqual(result.data, "stale");
      assert.strictEqual(result.isStale, true);
    });
  });

  // ==========================================================================
  // Concurrent deduplication
  // ==========================================================================

  describe("Concurrent Request Deduplication", () => {
    it("should deduplicate concurrent fetches for same key", async () => {
      let callCount = 0;
      const fetcher = async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 50));
        return { count: callCount };
      };

      // Launch 3 concurrent requests for the same key
      const results = await Promise.all([
        swrCache({ key: "test:dedup", fetcher, ...MEMORY_ONLY }),
        swrCache({ key: "test:dedup", fetcher, ...MEMORY_ONLY }),
        swrCache({ key: "test:dedup", fetcher, ...MEMORY_ONLY }),
      ]);

      // Fetcher should only be called once
      assert.strictEqual(callCount, 1);
      // All results should have the same data
      assert.deepStrictEqual(results[0].data, results[1].data);
      assert.deepStrictEqual(results[1].data, results[2].data);
    });

    it("should allow new fetch after previous one completes", async () => {
      let callCount = 0;
      const fetcher = async () => {
        callCount++;
        return { count: callCount };
      };

      await swrCache({ key: "test:sequential", fetcher, ...MEMORY_ONLY });
      // Clear cache to force a new fetch
      await cacheClient.clearMemory();
      await swrCache({ key: "test:sequential", fetcher, ...MEMORY_ONLY });

      assert.strictEqual(callCount, 2);
    });

    it("should not deduplicate requests for different keys", async () => {
      let callCount = 0;
      const fetcher = async () => {
        callCount++;
        return callCount;
      };

      await Promise.all([
        swrCache({ key: "test:key-a", fetcher, ...MEMORY_ONLY }),
        swrCache({ key: "test:key-b", fetcher, ...MEMORY_ONLY }),
      ]);

      assert.strictEqual(callCount, 2);
    });
  });

  // ==========================================================================
  // Error handling
  // ==========================================================================

  describe("Error Handling", () => {
    it("should return error when fetcher throws", async () => {
      const fetcher = async () => {
        throw new Error("Network failure");
      };

      const result = await swrCache({
        key: "test:error",
        fetcher,
        ...MEMORY_ONLY,
      });

      assert.strictEqual(result.data, null);
      assert.ok(result.error instanceof Error);
      assert.strictEqual(result.error.message, "Network failure");
    });

    it("should return isStale=false on error", async () => {
      const fetcher = async () => {
        throw new Error("fail");
      };
      const result = await swrCache({
        key: "test:err-stale",
        fetcher,
        ...MEMORY_ONLY,
      });
      assert.strictEqual(result.isStale, false);
    });

    it("should return isLoading=false on error", async () => {
      const fetcher = async () => {
        throw new Error("fail");
      };
      const result = await swrCache({
        key: "test:err-loading",
        fetcher,
        ...MEMORY_ONLY,
      });
      assert.strictEqual(result.isLoading, false);
    });
  });

  // ==========================================================================
  // Cache invalidation
  // ==========================================================================

  describe("Cache Invalidation", () => {
    it("should invalidate a specific cache key", async () => {
      await cacheClient.set(
        "test:invalidate",
        { data: "val", timestamp: Date.now() },
        { ttl: 300, enableMemory: true, enableRedis: false }
      );

      const deleteCalls: string[] = [];
      const originalDelete = cacheClient.delete.bind(cacheClient);
      mock.method(cacheClient, "delete", async (key: string) => {
        deleteCalls.push(key);
        return originalDelete(key);
      });

      await invalidateCache("test:invalidate");

      assert.ok(deleteCalls.includes("test:invalidate"));
      // And the entry is actually gone from the real L1 cache.
      const after = await cacheClient.get("test:invalidate", {
        ttl: 300,
        enableMemory: true,
        enableRedis: false,
      });
      assert.strictEqual(after, null);
    });

    it("should delegate pattern invalidation to deletePattern", async () => {
      // deletePattern is Redis-only; with no Redis it degrades to 0 without
      // throwing. Assert the REAL function reaches deletePattern with the
      // pattern, and the no-Redis count is 0.
      const patterns: string[] = [];
      mock.method(cacheClient, "deletePattern", async (p: string) => {
        patterns.push(p);
        return 0;
      });

      const count = await invalidateCachePattern("user:123:*");

      assert.deepStrictEqual(patterns, ["user:123:*"]);
      assert.strictEqual(count, 0);
    });
  });

  // ==========================================================================
  // Pre-warm cache
  // ==========================================================================

  describe("Pre-warm Cache", () => {
    it("should pre-warm cache with provided data", async () => {
      const setCalls = spySet();
      await prewarmCache("test:prewarm", { prewarmed: true });

      assert.ok(setCalls.length > 0);
      const setData = setCalls[0]!.data as {
        data: unknown;
        timestamp: number;
      };
      assert.deepStrictEqual(setData.data, { prewarmed: true });
    });

    it("should use custom TTL for pre-warmed data", async () => {
      const setCalls = spySet();
      await prewarmCache("test:prewarm-ttl", "data", 120);

      assert.strictEqual(setCalls[0]!.config.ttl, 120);
    });

    it("should make data available for subsequent swrCache calls", async () => {
      await prewarmCache("test:prewarm-use", { ready: true }, 300);

      let called = false;
      const fetcher = async () => {
        called = true;
        return { ready: false };
      };
      const result = await swrCache<{ ready: boolean }>({
        key: "test:prewarm-use",
        fetcher,
        ttl: 300,
        ...MEMORY_ONLY,
      });

      assert.deepStrictEqual(result.data, { ready: true });
      assert.strictEqual(called, false);
    });
  });

  // ==========================================================================
  // Cache key generators (real cacheKeys export)
  // ==========================================================================

  describe("Cache Key Generators", () => {
    it("should generate dashboard key", () => {
      assert.strictEqual(cacheKeys.dashboard("user1"), "dashboard:user1");
    });

    it("should generate holdings key with broker", () => {
      assert.strictEqual(
        cacheKeys.holdings("user1", "ZERODHA"),
        "holdings:user1:ZERODHA"
      );
    });

    it("should generate holdings key without broker", () => {
      assert.strictEqual(cacheKeys.holdings("user1"), "holdings:user1:all");
    });

    it("should generate positions key", () => {
      assert.strictEqual(cacheKeys.positions("user1"), "positions:user1");
    });

    it("should generate trades key with page", () => {
      assert.strictEqual(cacheKeys.trades("user1", 3), "trades:user1:page3");
    });

    it("should generate trades key without page", () => {
      assert.strictEqual(cacheKeys.trades("user1"), "trades:user1");
    });

    it("should generate mutualFunds key", () => {
      assert.strictEqual(cacheKeys.mutualFunds("user1"), "mutualFunds:user1");
    });

    it("should generate paperTrading key", () => {
      assert.strictEqual(cacheKeys.paperTrading("user1"), "paperTrading:user1");
    });
  });

  // ==========================================================================
  // Config flags
  // ==========================================================================

  describe("Config Flags", () => {
    it("should pass enableMemory to cache config", async () => {
      const setCalls = spySet();
      const fetcher = async () => "data";
      await swrCache({
        key: "test:mem-flag",
        fetcher,
        enableMemory: false,
        enableRedis: false,
      });

      assert.strictEqual(setCalls[0]!.config.enableMemory, false);
    });

    it("should pass enableRedis to cache config", async () => {
      const setCalls = spySet();
      const fetcher = async () => "data";
      await swrCache({
        key: "test:redis-flag",
        fetcher,
        enableRedis: false,
      });

      assert.strictEqual(setCalls[0]!.config.enableRedis, false);
    });
  });
});
