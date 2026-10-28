/**
 * Core Cache Wrapper Tests
 *
 * Tests the REAL cache wrapper utilities exported from
 * packages/core/src/cache/wrapper.ts:
 *   DEFAULT_CACHE_CONFIGS, getCacheConfig, withCache, getCached,
 *   setCached, deleteCached — plus the real generateCacheKey from
 *   @usemoney/cache.
 *
 * These exercise the production singleton `cacheClient` in MEMORY-ONLY mode
 * (every call overrides `enableRedis: false`), so no Redis is required and the
 * real dual-layer client code path is exercised. Each test uses a unique userId
 * to stay isolated within the shared in-process LRU.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CACHE_CONFIGS,
  getCacheConfig,
  withCache,
  getCached,
  setCached,
  deleteCached,
  generateCacheKey,
  type CacheModule,
  type CacheConfig,
} from "@usemoney/core/cache";

// Memory-only override so the real cacheClient never touches Redis in tests.
const MEM: Partial<CacheConfig> = { enableRedis: false };

// Unique-userId helper to keep each test isolated within the shared LRU.
let uidCounter = 0;
function uid(label: string): string {
  uidCounter += 1;
  return `wrapper-test-${label}-${uidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function createDashboardData() {
  return { totalValue: 500000, dayChange: 1200, dayChangePercent: 0.24 };
}

function createHoldingsData() {
  return {
    holdings: [
      { symbol: "RELIANCE", qty: 10, avgPrice: 2500 },
      { symbol: "TCS", qty: 5, avgPrice: 3200 },
    ],
  };
}

function createPositionsData() {
  return {
    positions: [{ symbol: "NIFTY24JANFUT", qty: 50, pnl: 3500 }],
  };
}

function createTradesData() {
  return {
    trades: [
      { symbol: "INFY", side: "BUY", qty: 20, price: 1500 },
      { symbol: "INFY", side: "SELL", qty: 20, price: 1550 },
    ],
  };
}

describe("Core Cache Wrapper (real source)", () => {
  // ==========================================================================
  // DEFAULT_CACHE_CONFIGS — assert the REAL shipped config (catches drift)
  // ==========================================================================

  describe("DEFAULT_CACHE_CONFIGS", () => {
    it("dashboard TTL is 300 seconds (5 min)", () => {
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.dashboard.ttl, 5 * 60);
    });

    it("positions TTL is 180 seconds (3 min)", () => {
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.positions.ttl, 3 * 60);
    });

    it("holdings TTL is 300 seconds (5 min)", () => {
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.holdings.ttl, 5 * 60);
    });

    it("trades TTL is 300 seconds (5 min)", () => {
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.trades.ttl, 5 * 60);
    });

    it("subscription TTL is 300 seconds (5 min)", () => {
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.subscription.ttl, 5 * 60);
    });

    it("brokers TTL is 3600 seconds (1 hour)", () => {
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.brokers.ttl, 60 * 60);
    });

    it("chat TTL is 3600 seconds (1 hour)", () => {
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.chat.ttl, 60 * 60);
    });

    it("instrument TTL is 3600 seconds (1 hour)", () => {
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.instrument.ttl, 60 * 60);
    });

    it("discover is long-lived reference data (24h)", () => {
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.discover.ttl, 24 * 60 * 60);
    });

    it("discover-mf is long-lived reference data (24h)", () => {
      assert.strictEqual(
        DEFAULT_CACHE_CONFIGS["discover-mf"].ttl,
        24 * 60 * 60
      );
    });

    it("mf-nav is Redis-only (no memory layer) at 24h", () => {
      assert.strictEqual(DEFAULT_CACHE_CONFIGS["mf-nav"].ttl, 24 * 60 * 60);
      assert.strictEqual(DEFAULT_CACHE_CONFIGS["mf-nav"].enableMemory, false);
      assert.strictEqual(DEFAULT_CACHE_CONFIGS["mf-nav"].enableRedis, true);
    });

    it("fund-composition is Redis-only at 24h", () => {
      assert.strictEqual(
        DEFAULT_CACHE_CONFIGS["fund-composition"].enableMemory,
        false
      );
    });

    it("every config has a positive numeric TTL", () => {
      for (const [module, config] of Object.entries(DEFAULT_CACHE_CONFIGS)) {
        assert.ok(
          Number.isFinite(config.ttl) && config.ttl > 0,
          `${module} TTL should be a positive finite number, got ${config.ttl}`
        );
      }
    });

    it("every config has enableRedis=true (Redis is the shared layer)", () => {
      for (const [module, config] of Object.entries(DEFAULT_CACHE_CONFIGS)) {
        assert.strictEqual(
          config.enableRedis,
          true,
          `${module} should have enableRedis=true`
        );
      }
    });

    it("includes the core money modules", () => {
      const required: CacheModule[] = [
        "dashboard",
        "positions",
        "holdings",
        "trades",
        "fire",
        "user",
        "brokers",
        "chat",
        "subscription",
        "mutual-funds",
        "instrument",
        "risk",
        "tax",
        "watchlist",
      ];
      for (const module of required) {
        assert.ok(
          module in DEFAULT_CACHE_CONFIGS,
          `DEFAULT_CACHE_CONFIGS should contain "${module}"`
        );
      }
    });

    it("short-lived money modules have TTL <= 300s", () => {
      const shortLived: CacheModule[] = [
        "dashboard",
        "positions",
        "holdings",
        "subscription",
        "mutual-funds",
      ];
      for (const module of shortLived) {
        assert.ok(
          DEFAULT_CACHE_CONFIGS[module].ttl <= 300,
          `${module} should have TTL <= 300 seconds, got ${DEFAULT_CACHE_CONFIGS[module].ttl}`
        );
      }
    });

    it("reference-data modules have TTL >= 3600s", () => {
      const longLived: CacheModule[] = ["brokers", "chat", "instrument"];
      for (const module of longLived) {
        assert.ok(
          DEFAULT_CACHE_CONFIGS[module].ttl >= 3600,
          `${module} should have TTL >= 3600 seconds`
        );
      }
    });
  });

  // ==========================================================================
  // getCacheConfig
  // ==========================================================================

  describe("getCacheConfig", () => {
    it("returns the dashboard config", () => {
      const config = getCacheConfig("dashboard");
      assert.strictEqual(config.ttl, DEFAULT_CACHE_CONFIGS.dashboard.ttl);
      assert.strictEqual(config.enableMemory, true);
      assert.strictEqual(config.enableRedis, true);
    });

    it("returns the brokers config", () => {
      assert.strictEqual(getCacheConfig("brokers").ttl, 3600);
    });

    it("merges a TTL override", () => {
      const config = getCacheConfig("dashboard", { ttl: 30 });
      assert.strictEqual(config.ttl, 30);
      assert.strictEqual(config.enableMemory, true);
      assert.strictEqual(config.enableRedis, true);
    });

    it("merges an enableMemory override", () => {
      const config = getCacheConfig("dashboard", { enableMemory: false });
      assert.strictEqual(config.ttl, DEFAULT_CACHE_CONFIGS.dashboard.ttl);
      assert.strictEqual(config.enableMemory, false);
      assert.strictEqual(config.enableRedis, true);
    });

    it("merges an enableRedis override", () => {
      const config = getCacheConfig("dashboard", { enableRedis: false });
      assert.strictEqual(config.enableRedis, false);
    });

    it("merges multiple overrides at once", () => {
      const config = getCacheConfig("dashboard", {
        ttl: 10,
        enableMemory: false,
        enableRedis: false,
      });
      assert.strictEqual(config.ttl, 10);
      assert.strictEqual(config.enableMemory, false);
      assert.strictEqual(config.enableRedis, false);
    });

    it("does not mutate the underlying default when overriding", () => {
      const before = DEFAULT_CACHE_CONFIGS.dashboard.ttl;
      getCacheConfig("dashboard", { ttl: 999 });
      assert.strictEqual(DEFAULT_CACHE_CONFIGS.dashboard.ttl, before);
    });

    it("returns a fresh object each call (not a shared reference)", () => {
      const a = getCacheConfig("dashboard");
      const b = getCacheConfig("dashboard");
      assert.notStrictEqual(a, b);
      assert.deepStrictEqual(a, b);
    });

    it("handles an empty overrides object", () => {
      const config = getCacheConfig("dashboard", {});
      assert.strictEqual(config.ttl, DEFAULT_CACHE_CONFIGS.dashboard.ttl);
    });

    it("handles undefined overrides", () => {
      const config = getCacheConfig("dashboard", undefined);
      assert.strictEqual(config.ttl, DEFAULT_CACHE_CONFIGS.dashboard.ttl);
    });
  });

  // ==========================================================================
  // withCache — exercises the real cacheClient (memory layer)
  // ==========================================================================

  describe("withCache", () => {
    it("calls the wrapped function on cache miss", async () => {
      let callCount = 0;
      const userId = uid("miss");
      const fn = async (_userId: string) => {
        callCount++;
        return createDashboardData();
      };

      const cached = withCache("dashboard", `stats-${userId}`, fn, MEM);
      await cached(userId);

      assert.strictEqual(callCount, 1);
    });

    it("returns the wrapped function's result", async () => {
      const userId = uid("result");
      const data = createDashboardData();
      const cached = withCache(
        "dashboard",
        `stats-${userId}`,
        async (_userId: string) => data,
        MEM
      );
      const result = await cached(userId);
      assert.deepStrictEqual(result, data);
    });

    it("returns cached data on the second call (cache hit, fn called once)", async () => {
      let callCount = 0;
      const userId = uid("hit");
      const cached = withCache(
        "dashboard",
        `stats-${userId}`,
        async (_userId: string) => {
          callCount++;
          return { value: callCount };
        },
        MEM
      );

      const result1 = await cached(userId);
      const result2 = await cached(userId);

      assert.strictEqual(callCount, 1);
      assert.deepStrictEqual(result1, { value: 1 });
      assert.deepStrictEqual(result2, { value: 1 });
    });

    it("generates distinct cache entries for different filters", async () => {
      let callCount = 0;
      const userId = uid("filters");
      const cached = withCache(
        "positions",
        `list-${userId}`,
        async (_userId: string, _filters?: unknown) => {
          callCount++;
          return { call: callCount };
        },
        MEM
      );

      const a = await cached(userId, { broker: "ZERODHA" });
      const b = await cached(userId, { broker: "UPSTOX" });

      // Different filters → different keys → fn runs twice
      assert.strictEqual(callCount, 2);
      assert.notDeepStrictEqual(a, b);
    });

    it("propagates errors from the wrapped function", async () => {
      const userId = uid("err");
      const cached = withCache(
        "dashboard",
        `stats-${userId}`,
        async (_userId: string) => {
          throw new Error("Database connection failed");
        },
        MEM
      );

      await assert.rejects(async () => cached(userId), {
        message: "Database connection failed",
      });
    });

    it("keeps separate cache entries per user", async () => {
      let callCount = 0;
      const id = uid("multiuser");
      const cached = withCache(
        "dashboard",
        `stats-${id}`,
        async (userId: string) => {
          callCount++;
          return { userId, count: callCount };
        },
        MEM
      );

      const r1 = await cached(`${id}-A`);
      const r2 = await cached(`${id}-B`);

      assert.strictEqual(callCount, 2);
      assert.deepStrictEqual(r1, { userId: `${id}-A`, count: 1 });
      assert.deepStrictEqual(r2, { userId: `${id}-B`, count: 2 });
    });

    it("returns pre-populated cached data without calling fn", async () => {
      const userId = uid("preload");
      const identifier = `stats-${userId}`;
      await setCached(
        "dashboard",
        userId,
        identifier,
        { preloaded: true },
        undefined,
        MEM
      );

      let fnCalled = false;
      const cached = withCache(
        "dashboard",
        identifier,
        async (_userId: string) => {
          fnCalled = true;
          return createDashboardData();
        },
        MEM
      );
      const result = await cached(userId);

      assert.strictEqual(fnCalled, false);
      assert.deepStrictEqual(result, { preloaded: true });
    });
  });

  // ==========================================================================
  // getCached / setCached
  // ==========================================================================

  describe("getCached / setCached", () => {
    it("returns null when nothing is cached", async () => {
      const result = await getCached(
        "dashboard",
        uid("empty"),
        "stats",
        undefined,
        MEM
      );
      assert.strictEqual(result, null);
    });

    it("round-trips data set then get", async () => {
      const userId = uid("roundtrip");
      const data = createDashboardData();
      await setCached("dashboard", userId, "stats", data, undefined, MEM);

      const result = await getCached(
        "dashboard",
        userId,
        "stats",
        undefined,
        MEM
      );
      assert.deepStrictEqual(result, data);
    });

    it("returns null for a different user", async () => {
      const userA = uid("userA");
      const userB = uid("userB");
      await setCached(
        "dashboard",
        userA,
        "stats",
        createDashboardData(),
        undefined,
        MEM
      );

      const result = await getCached(
        "dashboard",
        userB,
        "stats",
        undefined,
        MEM
      );
      assert.strictEqual(result, null);
    });

    it("returns null for a different identifier", async () => {
      const userId = uid("ident");
      await setCached(
        "dashboard",
        userId,
        "stats",
        createDashboardData(),
        undefined,
        MEM
      );

      const result = await getCached(
        "dashboard",
        userId,
        "chart",
        undefined,
        MEM
      );
      assert.strictEqual(result, null);
    });

    it("supports filters for versioned cache keys", async () => {
      const userId = uid("vers");
      const filters = { broker: "ZERODHA", segment: "equity" };
      const data = createHoldingsData();
      await setCached("holdings", userId, "list", data, filters, MEM);

      const result = await getCached("holdings", userId, "list", filters, MEM);
      assert.deepStrictEqual(result, data);
    });

    it("returns null when filters differ", async () => {
      const userId = uid("difffilter");
      await setCached(
        "holdings",
        userId,
        "list",
        createHoldingsData(),
        { broker: "ZERODHA" },
        MEM
      );

      const result = await getCached(
        "holdings",
        userId,
        "list",
        { broker: "UPSTOX" },
        MEM
      );
      assert.strictEqual(result, null);
    });

    it("overwrites existing cached data", async () => {
      const userId = uid("overwrite");
      await setCached(
        "dashboard",
        userId,
        "stats",
        { value: "old" },
        undefined,
        MEM
      );
      await setCached(
        "dashboard",
        userId,
        "stats",
        { value: "new" },
        undefined,
        MEM
      );

      const result = await getCached(
        "dashboard",
        userId,
        "stats",
        undefined,
        MEM
      );
      assert.deepStrictEqual(result, { value: "new" });
    });

    it("stores modules independently", async () => {
      const userId = uid("modindep");
      const dashData = createDashboardData();
      const holdData = createHoldingsData();

      await setCached("dashboard", userId, "stats", dashData, undefined, MEM);
      await setCached("holdings", userId, "list", holdData, undefined, MEM);

      assert.deepStrictEqual(
        await getCached("dashboard", userId, "stats", undefined, MEM),
        dashData
      );
      assert.deepStrictEqual(
        await getCached("holdings", userId, "list", undefined, MEM),
        holdData
      );
    });

    it("round-trips array data", async () => {
      const userId = uid("arr");
      const data = [1, 2, 3, 4, 5];
      await setCached("trades", userId, "ids", data, undefined, MEM);
      const result = await getCached<number[]>(
        "trades",
        userId,
        "ids",
        undefined,
        MEM
      );
      assert.deepStrictEqual(result, data);
    });

    it("round-trips deeply nested data", async () => {
      const userId = uid("nested");
      const nested = {
        level1: { level2: { level3: { value: "deep", array: [{ x: true }] } } },
      };
      await setCached("fire", userId, "scenario", nested, undefined, MEM);
      assert.deepStrictEqual(
        await getCached("fire", userId, "scenario", undefined, MEM),
        nested
      );
    });
  });

  // ==========================================================================
  // deleteCached
  // ==========================================================================

  describe("deleteCached", () => {
    it("deletes a cached entry", async () => {
      const userId = uid("del");
      await setCached(
        "dashboard",
        userId,
        "stats",
        createDashboardData(),
        undefined,
        MEM
      );

      await deleteCached("dashboard", userId, "stats");

      const result = await getCached(
        "dashboard",
        userId,
        "stats",
        undefined,
        MEM
      );
      assert.strictEqual(result, null);
    });

    it("does not affect other entries", async () => {
      const userId = uid("delother");
      const holdData = createHoldingsData();
      await setCached(
        "dashboard",
        userId,
        "stats",
        createDashboardData(),
        undefined,
        MEM
      );
      await setCached("holdings", userId, "list", holdData, undefined, MEM);

      await deleteCached("dashboard", userId, "stats");

      assert.deepStrictEqual(
        await getCached("holdings", userId, "list", undefined, MEM),
        holdData
      );
    });

    it("does not throw when deleting a non-existent entry", async () => {
      await deleteCached("dashboard", uid("noexist"), "stats");
      assert.ok(true);
    });

    it("deletes the correct entry when filters are provided", async () => {
      const userId = uid("delfilter");
      const filters = { broker: "ZERODHA" };
      await setCached(
        "holdings",
        userId,
        "list",
        createHoldingsData(),
        filters,
        MEM
      );

      await deleteCached("holdings", userId, "list", filters);

      const result = await getCached("holdings", userId, "list", filters, MEM);
      assert.strictEqual(result, null);
    });

    it("does not delete an entry with different filters", async () => {
      const userId = uid("delwrongfilter");
      const data2 = { holdings: [{ symbol: "TCS" }] };
      await setCached(
        "holdings",
        userId,
        "list",
        { holdings: [{ symbol: "RELIANCE" }] },
        { broker: "ZERODHA" },
        MEM
      );
      await setCached(
        "holdings",
        userId,
        "list",
        data2,
        { broker: "UPSTOX" },
        MEM
      );

      await deleteCached("holdings", userId, "list", { broker: "ZERODHA" });

      assert.deepStrictEqual(
        await getCached("holdings", userId, "list", { broker: "UPSTOX" }, MEM),
        data2
      );
    });
  });

  // ==========================================================================
  // generateCacheKey (real key generator from @usemoney/cache)
  // ==========================================================================

  describe("generateCacheKey", () => {
    it("uses the 'default' version when no filters are given", () => {
      const key = generateCacheKey("dashboard", "user123", "stats");
      assert.ok(
        key.startsWith("dashboard:"),
        `key should be namespaced by module: ${key}`
      );
      assert.ok(key.includes("stats"));
    });

    it("produces a different key when filters are supplied", () => {
      const plain = generateCacheKey("positions", "user123", "list");
      const filtered = generateCacheKey("positions", "user123", "list", {
        broker: "ZERODHA",
      });
      assert.notStrictEqual(plain, filtered);
    });

    it("produces distinct keys for distinct filters", () => {
      const a = generateCacheKey("holdings", "user123", "list", {
        broker: "ZERODHA",
      });
      const b = generateCacheKey("holdings", "user123", "list", {
        broker: "UPSTOX",
      });
      assert.notStrictEqual(a, b);
    });

    it("produces distinct keys for distinct users", () => {
      assert.notStrictEqual(
        generateCacheKey("dashboard", "userA", "stats"),
        generateCacheKey("dashboard", "userB", "stats")
      );
    });

    it("produces distinct keys for distinct modules", () => {
      assert.notStrictEqual(
        generateCacheKey("dashboard", "user123", "stats"),
        generateCacheKey("holdings", "user123", "stats")
      );
    });

    it("produces distinct keys for distinct identifiers", () => {
      assert.notStrictEqual(
        generateCacheKey("dashboard", "user123", "stats"),
        generateCacheKey("dashboard", "user123", "chart")
      );
    });
  });

  // ==========================================================================
  // Integration: withCache + getCached/setCached/deleteCached
  // ==========================================================================

  describe("Integration scenarios", () => {
    it("setCached value is returned by withCache on the next call", async () => {
      const userId = uid("int-preload");
      const identifier = `stats-${userId}`;
      const preloaded = { totalValue: 999999 };
      await setCached(
        "dashboard",
        userId,
        identifier,
        preloaded,
        undefined,
        MEM
      );

      let fnCalled = false;
      const cached = withCache(
        "dashboard",
        identifier,
        async (_userId: string) => {
          fnCalled = true;
          return createDashboardData();
        },
        MEM
      );
      const result = await cached(userId);

      assert.strictEqual(fnCalled, false);
      assert.deepStrictEqual(result, preloaded);
    });

    it("deleteCached forces withCache to re-execute fn", async () => {
      const userId = uid("int-delete");
      const identifier = `stats-${userId}`;
      let callCount = 0;
      const cached = withCache(
        "dashboard",
        identifier,
        async (_userId: string) => {
          callCount++;
          return { count: callCount };
        },
        MEM
      );

      await cached(userId);
      assert.strictEqual(callCount, 1);

      await deleteCached("dashboard", userId, identifier);

      const result = await cached(userId);
      assert.strictEqual(callCount, 2);
      assert.deepStrictEqual(result, { count: 2 });
    });

    it("getCached returns what withCache stored", async () => {
      const userId = uid("int-store");
      const identifier = `list-${userId}`;
      const data = createHoldingsData();
      const cached = withCache(
        "holdings",
        identifier,
        async (_userId: string) => data,
        MEM
      );
      await cached(userId);

      const retrieved = await getCached(
        "holdings",
        userId,
        identifier,
        undefined,
        MEM
      );
      assert.deepStrictEqual(retrieved, data);
    });

    it("handles multiple modules independently under concurrent use", async () => {
      const userId = uid("int-concurrent");
      const cachedDash = withCache(
        "dashboard",
        `stats-${userId}`,
        async (_u: string) => createDashboardData(),
        MEM
      );
      const cachedHold = withCache(
        "holdings",
        `list-${userId}`,
        async (_u: string) => createHoldingsData(),
        MEM
      );
      const cachedPos = withCache(
        "positions",
        `list-${userId}`,
        async (_u: string) => createPositionsData(),
        MEM
      );

      const [dash, hold, pos] = await Promise.all([
        cachedDash(userId),
        cachedHold(userId),
        cachedPos(userId),
      ]);

      assert.deepStrictEqual(dash, createDashboardData());
      assert.deepStrictEqual(hold, createHoldingsData());
      assert.deepStrictEqual(pos, createPositionsData());
    });

    it("trades data round-trips through withCache", async () => {
      const userId = uid("int-trades");
      const identifier = `list-${userId}`;
      const data = createTradesData();
      const cached = withCache(
        "trades",
        identifier,
        async (_u: string) => data,
        MEM
      );
      assert.deepStrictEqual(await cached(userId), data);
      assert.deepStrictEqual(await cached(userId), data);
    });
  });

  // ==========================================================================
  // Single-flight / stampede protection (MONEY-705)
  // ==========================================================================

  describe("withCache single-flight (MONEY-705)", () => {
    it("runs fn() exactly once for concurrent misses on the same key", async () => {
      let callCount = 0;
      const userId = uid("sf-one");
      const cached = withCache(
        "dashboard",
        `stats-${userId}`,
        async (_userId: string) => {
          callCount++;
          // Slow enough that all callers overlap on the miss window.
          await new Promise((r) => setTimeout(r, 50));
          return { value: callCount };
        },
        MEM
      );

      const results = await Promise.all(
        Array.from({ length: 8 }, () => cached(userId))
      );

      assert.strictEqual(
        callCount,
        1,
        "concurrent misses must collapse to a single fn() execution"
      );
      for (const r of results) assert.deepStrictEqual(r, { value: 1 });
    });

    it("clears the in-flight entry after settle (a later miss re-runs fn)", async () => {
      let callCount = 0;
      const userId = uid("sf-clear");
      const identifier = `stats-${userId}`;
      const cached = withCache(
        "dashboard",
        identifier,
        async (_userId: string) => {
          callCount++;
          await new Promise((r) => setTimeout(r, 10));
          return { count: callCount };
        },
        MEM
      );

      await Promise.all(Array.from({ length: 4 }, () => cached(userId)));
      assert.strictEqual(callCount, 1);

      // Force a real miss; if the in-flight promise were stuck this would hang
      // or return stale — it must re-run fn exactly once more.
      await deleteCached("dashboard", userId, identifier);
      const again = await cached(userId);
      assert.strictEqual(callCount, 2);
      assert.deepStrictEqual(again, { count: 2 });
    });

    it("keys single-flight per cache key (distinct keys each run once)", async () => {
      let aCalls = 0;
      let bCalls = 0;
      const base = uid("sf-keys");
      const cached = withCache(
        "positions",
        `list-${base}`,
        async (_userId: string, filters?: { broker: string }) => {
          if (filters?.broker === "ZERODHA") aCalls++;
          else bCalls++;
          await new Promise((r) => setTimeout(r, 30));
          return { broker: filters?.broker };
        },
        MEM
      );

      await Promise.all([
        cached(base, { broker: "ZERODHA" }),
        cached(base, { broker: "ZERODHA" }),
        cached(base, { broker: "UPSTOX" }),
        cached(base, { broker: "UPSTOX" }),
      ]);

      // Distinct keys are independent single-flights — one run each, not a
      // single global lock serializing everything.
      assert.strictEqual(aCalls, 1);
      assert.strictEqual(bCalls, 1);
    });
  });
});
