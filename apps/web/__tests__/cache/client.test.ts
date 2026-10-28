/**
 * Cache Client Tests — REAL source (apps/web/lib/cache/client.ts).
 *
 * De-shadowed (MONEY-620): the previous version defined a `TestCacheClient`
 * that re-implemented the dual-layer logic inline and asserted that copy — it
 * stayed green even if the real client broke. This now imports the REAL
 * `CacheClient` from `@/lib/cache/client`.
 *
 * The web `CacheClient` reaches Redis via a module-level `getRedisClient()`
 * (`@/lib/redis/client`) that returns `null` when no REDIS_URL/REDIS_HOST is
 * configured — which is the case under the test runner. With `enableRedis:
 * false` (or simply no Redis configured) the Memory (L1) layer is exercised
 * end-to-end with zero network. Redis-failure fallback paths need a fake redis
 * and are covered in `client-edge-cases.test.ts`.
 *
 * Each test uses a fresh `new CacheClient()`, but the L1 LRU + stats live in
 * module scope shared across instances, so `clearMemory()` + `resetStats()`
 * run in `beforeEach` to isolate cases.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CacheClient } from "@/lib/cache/client";
import type { CacheConfig } from "@usemoney/cache";

describe("Cache Client (real @/lib/cache/client)", () => {
  let cacheClient: CacheClient;

  beforeEach(async () => {
    cacheClient = new CacheClient();
    await cacheClient.clearMemory();
    cacheClient.resetStats();
  });

  describe("Memory Cache (Layer 1)", () => {
    const config: CacheConfig = {
      ttl: 60,
      enableMemory: true,
      enableRedis: false,
    };

    it("should cache data in memory", async () => {
      const testData = { value: "test" };
      const key = "test:user1:data";

      await cacheClient.set(key, testData, config);
      const result = await cacheClient.get<typeof testData>(key, config);

      assert.deepStrictEqual(result, testData);
    });

    it("should return null for cache miss", async () => {
      const result = await cacheClient.get<unknown>("nonexistent:key", config);

      assert.strictEqual(result, null);
    });

    it("should track cache hits", async () => {
      const key = "test:user1:hits";
      await cacheClient.set(key, { count: 1 }, config);

      await cacheClient.get(key, config);

      const stats = cacheClient.getStats();
      assert.ok(stats.memory.hits > 0);
    });

    it("should track cache misses", async () => {
      await cacheClient.get("missing:key", config);

      const stats = cacheClient.getStats();
      assert.ok(stats.memory.misses > 0);
    });

    it("should track cache sets", async () => {
      await cacheClient.set("test:key", { data: "value" }, config);

      const stats = cacheClient.getStats();
      assert.ok(stats.memory.sets > 0);
    });

    it("should track cache deletes", async () => {
      const key = "test:delete";
      await cacheClient.set(key, { data: "value" }, config);
      await cacheClient.delete(key);

      const stats = cacheClient.getStats();
      assert.ok(stats.memory.deletes > 0);
    });

    it("should handle complex data types", async () => {
      const complexData = {
        user: "test",
        positions: [
          { symbol: "AAPL", quantity: 10 },
          { symbol: "GOOGL", quantity: 5 },
        ],
        metadata: {
          timestamp: Date.now(),
          source: "test",
        },
      };

      const key = "test:complex";
      await cacheClient.set(key, complexData, config);
      const result = await cacheClient.get<typeof complexData>(key, config);

      assert.deepStrictEqual(result, complexData);
    });

    it("should overwrite existing cache entry", async () => {
      const key = "test:overwrite";

      await cacheClient.set(key, { version: 1 }, config);
      await cacheClient.set(key, { version: 2 }, config);

      const result = await cacheClient.get<{ version: number }>(key, config);

      assert.strictEqual(result?.version, 2);
    });

    it("should delete cache entry", async () => {
      const key = "test:delete:entry";

      await cacheClient.set(key, { data: "value" }, config);
      await cacheClient.delete(key);

      const result = await cacheClient.get(key, config);

      assert.strictEqual(result, null);
    });

    it("should clear memory cache", async () => {
      await cacheClient.set("test:key1", { data: 1 }, config);
      await cacheClient.set("test:key2", { data: 2 }, config);

      await cacheClient.clearMemory();

      const result1 = await cacheClient.get("test:key1", config);
      const result2 = await cacheClient.get("test:key2", config);

      assert.strictEqual(result1, null);
      assert.strictEqual(result2, null);
    });
  });

  describe("Cache Statistics", () => {
    const config: CacheConfig = {
      ttl: 60,
      enableMemory: true,
      enableRedis: false,
    };

    it("should provide separated stats for memory and Redis", () => {
      const stats = cacheClient.getStats();

      assert.ok("memory" in stats);
      assert.ok("redis" in stats);
      assert.ok("hits" in stats.memory);
      assert.ok("misses" in stats.memory);
      assert.ok("sets" in stats.memory);
      assert.ok("deletes" in stats.memory);
      assert.ok("errors" in stats.memory);
    });

    it("should reset statistics", async () => {
      await cacheClient.set("test:key", { data: "value" }, config);
      await cacheClient.get("test:key", config);

      cacheClient.resetStats();

      const stats = cacheClient.getStats();

      assert.strictEqual(stats.memory.hits, 0);
      assert.strictEqual(stats.memory.misses, 0);
      assert.strictEqual(stats.memory.sets, 0);
      assert.strictEqual(stats.memory.deletes, 0);
      assert.strictEqual(stats.memory.errors, 0);
    });

    it("should calculate hit rate correctly", async () => {
      const key = "test:hitrate";
      await cacheClient.set(key, { data: "value" }, config);

      // 3 hits
      await cacheClient.get(key, config);
      await cacheClient.get(key, config);
      await cacheClient.get(key, config);

      // 1 miss
      await cacheClient.get("nonexistent", config);

      const stats = cacheClient.getStats();

      // Hit rate should be 75% (3 hits out of 4 total)
      const hitRate =
        (stats.memory.hits / (stats.memory.hits + stats.memory.misses)) * 100;
      assert.strictEqual(hitRate, 75);
    });
  });

  describe("Cache Versioning", () => {
    const config: CacheConfig = {
      ttl: 60,
      enableMemory: true,
      enableRedis: false,
    };

    it("should store version with cache entry", async () => {
      const key = "test:versioned";
      const version = "v1.0.0";

      await cacheClient.set(key, { data: "value" }, config, version);
      const result = await cacheClient.get(key, config);

      assert.deepStrictEqual(result, { data: "value" });
    });

    it('should default to "default" version if not provided', async () => {
      const key = "test:no:version";

      await cacheClient.set(key, { data: "value" }, config);
      const result = await cacheClient.get(key, config);

      assert.deepStrictEqual(result, { data: "value" });
    });
  });

  describe("Cache Configuration", () => {
    it("should respect enableMemory flag", async () => {
      const configDisabled: CacheConfig = {
        ttl: 60,
        enableMemory: false,
        enableRedis: false,
      };

      const key = "test:disabled";
      await cacheClient.set(key, { data: "value" }, configDisabled);
      const result = await cacheClient.get(key, configDisabled);

      // With memory disabled (and no Redis), cache should not work
      assert.strictEqual(result, null);
    });

    it("should handle different TTL values", async () => {
      const shortTTL: CacheConfig = {
        ttl: 1, // 1 second
        enableMemory: true,
        enableRedis: false,
      };

      const key = "test:ttl";
      await cacheClient.set(key, { data: "value" }, shortTTL);

      // Should be cached immediately
      const result1 = await cacheClient.get(key, shortTTL);
      assert.deepStrictEqual(result1, { data: "value" });

      // Wait for TTL to expire (1.5 seconds to be safe)
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Should be expired
      const result2 = await cacheClient.get(key, shortTTL);
      assert.strictEqual(result2, null);
    });
  });

  describe("Concurrent Access", () => {
    const config: CacheConfig = {
      ttl: 60,
      enableMemory: true,
      enableRedis: false,
    };

    it("should handle concurrent reads", async () => {
      const key = "test:concurrent:read";
      await cacheClient.set(key, { data: "value" }, config);

      // Simulate 10 concurrent reads
      const promises = Array.from({ length: 10 }, () =>
        cacheClient.get(key, config)
      );

      const results = await Promise.all(promises);

      // All reads should succeed
      results.forEach((result) => {
        assert.deepStrictEqual(result, { data: "value" });
      });
    });

    it("should handle concurrent writes", async () => {
      const key = "test:concurrent:write";

      // Simulate 5 concurrent writes with different values
      const promises = Array.from({ length: 5 }, (_, i) =>
        cacheClient.set(key, { version: i }, config)
      );

      await Promise.all(promises);

      // Last write wins (indeterminate which one)
      const result = await cacheClient.get<{ version: number }>(key, config);
      assert.ok(result !== null);
      assert.ok(typeof result.version === "number");
      assert.ok(result.version >= 0 && result.version < 5);
    });

    it("should handle mixed concurrent operations", async () => {
      const baseKey = "test:concurrent:mixed";

      // Mix of reads, writes, and deletes
      const operations = [
        cacheClient.set(`${baseKey}:1`, { data: "value1" }, config),
        cacheClient.set(`${baseKey}:2`, { data: "value2" }, config),
        cacheClient.get(`${baseKey}:1`, config),
        cacheClient.delete(`${baseKey}:3`),
        cacheClient.set(`${baseKey}:3`, { data: "value3" }, config),
        cacheClient.get(`${baseKey}:2`, config),
      ];

      await Promise.all(operations);

      // Verify final state
      const result1 = await cacheClient.get(`${baseKey}:1`, config);
      const result2 = await cacheClient.get(`${baseKey}:2`, config);
      const result3 = await cacheClient.get(`${baseKey}:3`, config);

      assert.deepStrictEqual(result1, { data: "value1" });
      assert.deepStrictEqual(result2, { data: "value2" });
      assert.deepStrictEqual(result3, { data: "value3" });
    });
  });

  describe("Error Handling", () => {
    const config: CacheConfig = {
      ttl: 60,
      enableMemory: true,
      enableRedis: false,
    };

    it("should handle null data", async () => {
      const key = "test:null:data";

      await cacheClient.set(key, null, config);
      const result = await cacheClient.get(key, config);
      assert.strictEqual(result, null);
    });

    it("should handle undefined gracefully", async () => {
      const key = "test:undefined:data";

      await cacheClient.set(key, undefined, config);
      const result = await cacheClient.get(key, config);

      // Undefined is stored as-is
      assert.strictEqual(result, undefined);
    });

    it("should handle large data", async () => {
      const largeData = {
        items: Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          name: `Item ${i}`,
          data: Array(100).fill(`data-${i}`).join(","),
        })),
      };

      const key = "test:large:data";
      await cacheClient.set(key, largeData, config);
      const result = await cacheClient.get<typeof largeData>(key, config);

      assert.strictEqual(result?.items.length, 1000);
      assert.strictEqual(result?.items[0]!.id, 0);
      assert.strictEqual(result?.items[999]!.id, 999);
    });

    it("should handle empty string keys", async () => {
      const key = "";
      await cacheClient.set(key, { data: "value" }, config);
      const result = await cacheClient.get(key, config);

      assert.deepStrictEqual(result, { data: "value" });
    });

    it("should handle special characters in keys", async () => {
      const key = "test:special:chars:!@#$%^&*()";
      await cacheClient.set(key, { data: "value" }, config);
      const result = await cacheClient.get(key, config);

      assert.deepStrictEqual(result, { data: "value" });
    });
  });

  describe("Edge Cases", () => {
    const config: CacheConfig = {
      ttl: 60,
      enableMemory: true,
      enableRedis: false,
    };

    it("should handle zero TTL", async () => {
      const zeroTTL: CacheConfig = {
        ttl: 0,
        enableMemory: true,
        enableRedis: false,
      };

      const key = "test:zero:ttl";
      await cacheClient.set(key, { data: "value" }, zeroTTL);

      // With 0 TTL, entry should be expired immediately
      const result = await cacheClient.get(key, zeroTTL);
      assert.strictEqual(result, null);
    });

    it("should handle boolean data", async () => {
      await cacheClient.set("test:bool:true", true, config);
      await cacheClient.set("test:bool:false", false, config);

      const resultTrue = await cacheClient.get("test:bool:true", config);
      const resultFalse = await cacheClient.get("test:bool:false", config);

      assert.strictEqual(resultTrue, true);
      assert.strictEqual(resultFalse, false);
    });

    it("should handle number data", async () => {
      await cacheClient.set("test:num:int", 42, config);
      await cacheClient.set("test:num:float", 3.14159, config);
      await cacheClient.set("test:num:negative", -100, config);

      assert.strictEqual(await cacheClient.get("test:num:int", config), 42);
      assert.strictEqual(
        await cacheClient.get("test:num:float", config),
        3.14159
      );
      assert.strictEqual(
        await cacheClient.get("test:num:negative", config),
        -100
      );
    });

    it("should handle array data", async () => {
      const arr = [1, 2, 3, "four", { five: 5 }];
      await cacheClient.set("test:array", arr, config);
      const result = await cacheClient.get("test:array", config);

      assert.deepStrictEqual(result, arr);
    });

    it("should handle deeply nested data", async () => {
      const nested = {
        level1: {
          level2: {
            level3: {
              level4: {
                value: "deep",
              },
            },
          },
        },
      };

      await cacheClient.set("test:nested", nested, config);
      const result = await cacheClient.get<typeof nested>(
        "test:nested",
        config
      );

      assert.strictEqual(result?.level1.level2.level3.level4.value, "deep");
    });
  });
});
