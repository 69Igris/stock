/**
 * Cache Wrapper Tests — REAL source (apps/web/lib/cache/wrapper.ts +
 * @/lib/cache/swr-wrapper + @usemoney/cache keys).
 *
 * De-shadowed (MONEY-620): the previous file asserted hand-built strings and
 * arithmetic INLINE (`` `dashboard:${userId}` ``, `ttl * 2`, etc.) — pure
 * tautologies that never touched production code. This now imports the REAL
 * `withCache` / `getCached` / `setCached` (the higher-order caching wrapper used
 * by `lib/actions/content.ts`), the REAL `cacheKeys` SWR generators, and the
 * REAL `generateCacheKey` / `generateCachePattern` key builders.
 *
 * The wrapper talks to the module-singleton `cacheClient`; its L1 (memory)
 * layer works with zero network when no Redis is configured (the test runner).
 * `clearMemory()` runs per-test for isolation.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  withCache,
  getCached,
  setCached,
  DEFAULT_CACHE_CONFIGS,
} from "@/lib/cache/wrapper";
import { cacheKeys } from "@/lib/cache/swr-wrapper";
import { generateCacheKey, generateCachePattern } from "@usemoney/cache";
import { cacheClient } from "@/lib/cache/client";

describe("Cache Wrapper (real @/lib/cache/wrapper)", () => {
  beforeEach(async () => {
    await cacheClient.clearMemory();
  });

  describe("withCache (higher-order caching)", () => {
    it("executes the wrapped fn on a cache miss and returns its result", async () => {
      let calls = 0;
      const cached = withCache(
        "dashboard",
        "stats",
        async (_userId: string) => {
          calls++;
          return { total: 42 };
        }
      );

      const result = await cached("user-1");
      assert.deepStrictEqual(result, { total: 42 });
      assert.strictEqual(calls, 1);
    });

    it("serves the second call from cache (fn runs only once)", async () => {
      let calls = 0;
      const cached = withCache(
        "dashboard",
        "stats",
        async (_userId: string) => {
          calls++;
          return { total: calls };
        }
      );

      const first = await cached("user-2");
      const second = await cached("user-2");

      assert.deepStrictEqual(first, { total: 1 });
      assert.deepStrictEqual(second, { total: 1 }); // cached, not re-computed
      assert.strictEqual(calls, 1);
    });

    it("namespaces by userId (different users do not share an entry)", async () => {
      let calls = 0;
      const cached = withCache("holdings", "list", async (userId: string) => {
        calls++;
        return { owner: userId };
      });

      const a = await cached("userA");
      const b = await cached("userB");

      assert.deepStrictEqual(a, { owner: "userA" });
      assert.deepStrictEqual(b, { owner: "userB" });
      assert.strictEqual(calls, 2);
    });

    it("versions the entry by the second-arg filters (different filters → re-compute)", async () => {
      let calls = 0;
      const cached = withCache(
        "positions",
        "list",
        async (_userId: string, _filters?: { page: number }) => {
          calls++;
          return { page: _filters?.page ?? 0 };
        }
      );

      const p1 = await cached("user-3", { page: 1 });
      const p2 = await cached("user-3", { page: 2 });
      const p1again = await cached("user-3", { page: 1 });

      assert.deepStrictEqual(p1, { page: 1 });
      assert.deepStrictEqual(p2, { page: 2 });
      assert.deepStrictEqual(p1again, { page: 1 }); // served from cache
      assert.strictEqual(calls, 2); // page-1 and page-2 only
    });
  });

  describe("getCached / setCached (manual)", () => {
    it("round-trips a value through the real key builder", async () => {
      await setCached("dashboard", "user-4", "stats", { net: 100 });
      const got = await getCached<{ net: number }>(
        "dashboard",
        "user-4",
        "stats"
      );
      assert.deepStrictEqual(got, { net: 100 });
    });

    it("returns null for an entry that was never set", async () => {
      const got = await getCached("dashboard", "user-unknown", "stats");
      assert.strictEqual(got, null);
    });

    it("a colon inside the identifier no longer aliases another entry (task-139 fix on live path)", async () => {
      // REGRESSION (MONEY-620): the web lib/cache/keys.ts copy used to join
      // segments with a bare ':' and never escape — so ("a:b","c") and
      // ("a","b:c") collided to the same Redis key. The web copy now re-exports
      // the escaped builder from @usemoney/cache, so these two are distinct.
      await setCached("content", "a:b", "c", { which: 1 });
      await setCached("content", "a", "b:c", { which: 2 });

      const first = await getCached<{ which: number }>("content", "a:b", "c");
      const second = await getCached<{ which: number }>("content", "a", "b:c");

      assert.deepStrictEqual(first, { which: 1 });
      assert.deepStrictEqual(second, { which: 2 }); // would be { which: 1 } if colliding
    });
  });

  describe("generateCacheKey (real builder behind the wrapper)", () => {
    it("builds the documented {module}:{userId}:{identifier}:{version} shape", () => {
      assert.strictEqual(
        generateCacheKey("dashboard", "user123", "stats"),
        "dashboard:user123:stats:default"
      );
    });

    it("hashes filters into the version segment (different filters → different keys)", () => {
      const k1 = generateCacheKey("positions", "u1", "list", { page: 1 });
      const k2 = generateCacheKey("positions", "u1", "list", { page: 2 });
      assert.notStrictEqual(k1, k2);
      assert.ok(k1.startsWith("positions:u1:list:"));
    });

    it("is filter-order independent", () => {
      const a = generateCacheKey("trades", "u1", "x", { p: 1, q: 2 });
      const b = generateCacheKey("trades", "u1", "x", { q: 2, p: 1 });
      assert.strictEqual(a, b);
    });
  });

  describe("generateCachePattern (real invalidation pattern builder)", () => {
    it("module + userId → 'module:userId:*'", () => {
      assert.strictEqual(
        generateCachePattern("dashboard", "user123"),
        "dashboard:user123:*"
      );
    });

    it("module only → 'module:*'", () => {
      assert.strictEqual(generateCachePattern("holdings"), "holdings:*");
    });
  });

  describe("cacheKeys (real SWR generators)", () => {
    it("dashboard", () => {
      assert.strictEqual(cacheKeys.dashboard("user123"), "dashboard:user123");
    });

    it("holdings with broker", () => {
      assert.strictEqual(
        cacheKeys.holdings("user123", "ZERODHA"),
        "holdings:user123:ZERODHA"
      );
    });

    it("holdings without broker", () => {
      assert.strictEqual(cacheKeys.holdings("user123"), "holdings:user123:all");
    });

    it("positions", () => {
      assert.strictEqual(cacheKeys.positions("user123"), "positions:user123");
    });

    it("trades with page", () => {
      assert.strictEqual(
        cacheKeys.trades("user123", 2),
        "trades:user123:page2"
      );
    });

    it("pairedTrades with filters", () => {
      assert.strictEqual(
        cacheKeys.pairedTrades("user123", "status=CLOSED&symbol=RELIANCE"),
        "pairedTrades:user123:status=CLOSED&symbol=RELIANCE"
      );
    });

    it("mutualFunds / paperTrading / brokerConnections / fireScenarios", () => {
      assert.strictEqual(
        cacheKeys.mutualFunds("user123"),
        "mutualFunds:user123"
      );
      assert.strictEqual(
        cacheKeys.paperTrading("user123"),
        "paperTrading:user123"
      );
      assert.strictEqual(
        cacheKeys.brokerConnections("user123"),
        "brokerConnections:user123"
      );
      assert.strictEqual(
        cacheKeys.fireScenarios("user123"),
        "fireScenarios:user123"
      );
    });
  });

  describe("DEFAULT_CACHE_CONFIGS (real config table)", () => {
    it("dashboard defaults to a 5-minute TTL with both layers on", () => {
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.dashboard.ttl, 5 * 60);
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.dashboard.enableMemory, true);
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.dashboard.enableRedis, true);
    });

    it("chat is memory-only (no Redis) with a 30-second TTL", () => {
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.chat.ttl, 30);
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.chat.enableRedis, false);
    });
  });
});
