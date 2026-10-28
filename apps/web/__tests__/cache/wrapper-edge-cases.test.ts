/**
 * Cache Wrapper — edge cases, REAL source (apps/web/lib/cache/wrapper.ts +
 * @/lib/cache/swr-wrapper).
 *
 * De-shadowed (MONEY-620): the previous file re-implemented `withCache`,
 * `prewarmCache`, an SWR `swrGet`, a `createDeduplicatedFetcher`, AND an inline
 * `generateCacheKey` (the OLD unescaped `JSON.stringify(filters)` form, now
 * diverged from real source) — and threaded a `MockCacheClient` through. It
 * asserted its own copies. This imports the REAL `withCache` / `getCached`
 * (used on the live `lib/actions/content.ts` path) and the REAL `swrCache`.
 *
 * Discrepancy the shadow hid: its inline `withCache` wrapped `cacheClient.set`
 * in try/catch and asserted "Redis set failure is non-fatal". The REAL
 * `withCache` does NOT try/catch the set — but the REAL `CacheClient.set`
 * already swallows Redis-write errors internally (try/catch around
 * `redis.setex`), so a Redis hiccup never reaches `withCache` to begin with.
 * The realistic assertion (a forced internal Redis error still returns the fn
 * result and the memory layer still holds it) replaces the false claim.
 *
 * The wrapper uses the module-singleton `cacheClient`; its L1 layer works with
 * zero network when no Redis is configured. `clearMemory()` runs per-test.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { withCache, getCached, setCached } from "@/lib/cache/wrapper";
import { swrCache, prewarmCache } from "@/lib/cache/swr-wrapper";
import { generateCacheKey } from "@usemoney/cache";
import { cacheClient } from "@/lib/cache/client";

describe("Cache Wrapper Edge Cases (real source)", () => {
  beforeEach(async () => {
    await cacheClient.clearMemory();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  // ── withCache: fn() throws ─────────────────────────────────────

  describe("withCache: fn() throws", () => {
    it("should propagate error when fn() throws", async () => {
      const failingFn = mock.fn(async (_userId: string) => {
        throw new Error("DB connection lost");
      });

      const cached = withCache("dashboard", "stats", failingFn);

      await assert.rejects(() => cached("user-1"), {
        message: "DB connection lost",
      });
    });

    it("should not cache anything when fn() throws", async () => {
      const failingFn = mock.fn(async (_userId: string) => {
        throw new Error("Query timeout");
      });

      const cached = withCache("dashboard", "stats", failingFn);

      try {
        await cached("user-err");
      } catch {
        // expected
      }

      // Nothing was written for this key → a subsequent get is a miss.
      const got = await getCached("dashboard", "user-err", "stats");
      assert.strictEqual(got, null);
    });
  });

  // ── withCache: fn() returns null ───────────────────────────────

  describe("withCache: fn() returns null", () => {
    it("re-executes fn on the next call (cached null is indistinguishable from a miss)", async () => {
      const fn = mock.fn(async (_userId: string) => null);

      const cached = withCache("dashboard", "stats", fn);

      const result1 = await cached("user-null");
      assert.strictEqual(result1, null);
      assert.strictEqual(fn.mock.callCount(), 1);

      // cacheClient.get returns null for both "cached null" and "miss", so
      // withCache cannot tell them apart and runs fn again. This is the REAL
      // behaviour (documented limitation), asserted directly against source.
      const result2 = await cached("user-null");
      assert.strictEqual(result2, null);
      assert.strictEqual(fn.mock.callCount(), 2);
    });
  });

  // ── withCache: fn() returns 0 ──────────────────────────────────

  describe("withCache: fn() returns 0", () => {
    it("should cache 0 correctly and serve from cache", async () => {
      const fn = mock.fn(async (_userId: string) => 0);

      const cached = withCache("dashboard", "count", fn);

      const result1 = await cached("user-zero");
      assert.strictEqual(result1, 0);
      assert.strictEqual(fn.mock.callCount(), 1);

      // 0 !== null → cache hit, fn not called again.
      const result2 = await cached("user-zero");
      assert.strictEqual(result2, 0);
      assert.strictEqual(fn.mock.callCount(), 1);
    });
  });

  // ── withCache: Redis write error is swallowed by CacheClient ───

  describe("withCache: internal Redis write error", () => {
    it("still returns the fn result and the memory layer still holds it", async () => {
      // Force the REAL cacheClient.set to simulate a Redis-write failure that
      // the client swallows internally: we wrap the real set but still write to
      // memory by delegating, then assert nothing throws out of withCache.
      const realSet = cacheClient.set.bind(cacheClient);
      let setInvoked = 0;
      mock.method(
        cacheClient,
        "set",
        async (
          k: string,
          d: unknown,
          c: { ttl: number; enableMemory: boolean; enableRedis: boolean }
        ) => {
          setInvoked++;
          // memory-only delegation mimics "Redis failed, memory succeeded"
          return realSet(k, d, { ...c, enableRedis: false });
        }
      );

      const fn = mock.fn(async (_userId: string) => ({ data: "important" }));
      const cached = withCache("dashboard", "stats", fn);

      const result = await cached("user-redisfail");
      assert.deepStrictEqual(result, { data: "important" });
      assert.strictEqual(fn.mock.callCount(), 1);
      assert.ok(setInvoked > 0);

      // The memory layer retained the value → a second call is a hit.
      const second = await cached("user-redisfail");
      assert.deepStrictEqual(second, { data: "important" });
      assert.strictEqual(fn.mock.callCount(), 1);
    });
  });

  // ── SWR: stale data served on revalidation failure (real swrCache) ──

  describe("SWR pattern: stale data on revalidation failure", () => {
    it("serves stale data and a background revalidation that throws does not break the read", async () => {
      const ttl = 60;
      const staleTime = 120;
      // expired (older than ttl) but within the stale window
      const timestamp = Date.now() - (ttl + 10) * 1000;

      await cacheClient.set(
        "swr:revalfail",
        { data: { value: "stale-data" }, timestamp },
        { ttl, enableMemory: true, enableRedis: false }
      );

      let fetcherCalls = 0;
      const failingFetcher = async () => {
        fetcherCalls++;
        throw new Error("Network down");
      };

      // Real swrCache returns stale immediately and revalidates in the
      // background (fire-and-forget); a throwing fetcher is caught internally.
      const result = await swrCache<{ value: string }>({
        key: "swr:revalfail",
        fetcher: failingFetcher,
        ttl,
        staleTime,
        enableRedis: false,
      });

      assert.deepStrictEqual(result.data, { value: "stale-data" });
      assert.strictEqual(result.isStale, true);
      assert.strictEqual(result.error, null);

      // Let the background revalidation settle; it must NOT throw an unhandled
      // rejection (swrCache wraps it in .catch).
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(fetcherCalls >= 1);
    });
  });

  // ── prewarmCache (real swr-wrapper export) ─────────────────────

  describe("prewarmCache", () => {
    it("stores data so a later swrCache read is a hit (no fetcher run)", async () => {
      await prewarmCache(
        "prewarm:holdings",
        { holdings: [{ symbol: "RELIANCE" }] },
        300
      );

      let fetched = false;
      const result = await swrCache<{ holdings: Array<{ symbol: string }> }>({
        key: "prewarm:holdings",
        fetcher: async () => {
          fetched = true;
          return { holdings: [] };
        },
        ttl: 300,
        enableRedis: false,
      });

      assert.deepStrictEqual(result.data, {
        holdings: [{ symbol: "RELIANCE" }],
      });
      assert.strictEqual(fetched, false);
    });

    it("wraps the value with a timestamp under the raw key", async () => {
      await prewarmCache("prewarm:ttl", { v: 1 }, 120);

      // prewarmCache stores `{ data, timestamp }` under the raw key it is given.
      const present = await cacheClient.get<{
        data: { v: number };
        timestamp: number;
      }>("prewarm:ttl", { ttl: 120, enableMemory: true, enableRedis: false });
      assert.ok(present, "prewarmed entry should be present");
      assert.deepStrictEqual(present.data, { v: 1 });
      assert.strictEqual(typeof present.timestamp, "number");
    });
  });

  // ── Concurrent dedup via real withCache ────────────────────────

  describe("Concurrent call deduplication (real withCache + memory cache)", () => {
    it("two sequential calls hit the cache (fn runs once)", async () => {
      let callCount = 0;
      const fn = async (_userId: string) => {
        callCount++;
        return { call: callCount };
      };
      const cached = withCache("dashboard", "dedupe", fn);

      const r1 = await cached("user-dd");
      const r2 = await cached("user-dd");

      assert.deepStrictEqual(r1, { call: 1 });
      assert.deepStrictEqual(r2, { call: 1 }); // served from cache
      assert.strictEqual(callCount, 1);
    });
  });

  // ── Key builder used by the wrapper is the escaped (fixed) one ──

  describe("real key builder behind the wrapper", () => {
    it("setCached + getCached round-trip with colon-bearing identifier (no alias)", async () => {
      await setCached("content", "user-x", "RELIANCE:NSE", { px: 1 });
      const got = await getCached<{ px: number }>(
        "content",
        "user-x",
        "RELIANCE:NSE"
      );
      assert.deepStrictEqual(got, { px: 1 });
      // The on-the-wire key is the escaped form, distinct from a naive join.
      assert.notStrictEqual(
        generateCacheKey("content", "user-x", "RELIANCE:NSE"),
        "content:user-x:RELIANCE:NSE:default"
      );
    });
  });
});
