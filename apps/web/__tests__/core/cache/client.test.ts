/**
 * Core Cache Client Tests (Dual-Layer: Memory L1 + Redis L2)
 *
 * Exercises the REAL `CacheClient` exported from
 * packages/core/src/cache/client.ts (via `@usemoney/core/cache`) — its real
 * in-memory LRU (Layer 1), real statistics tracking, real TTL staleness check,
 * and real cache-enabled gate — instead of an inline reimplementation.
 *
 * Redis (Layer 2) is intentionally NOT configured here: with no
 * `REDIS_URL`/`KV_URL`/`UPSTASH_REDIS_REST_URL`, `getRedisClient()` returns
 * null and the client takes its memory-only path, so this suite stays pure and
 * hermetic (no network, no open handles). The Redis-hit / Redis-error /
 * dual-layer-fallback branches require a live Redis and are covered by the
 * gated `test:cache:redis` suite — they are deliberately not faked here, since
 * faking them would re-introduce the very shadow this de-shadows.
 *
 * The client keeps its memory cache and stats in module-level singletons, so
 * every test resets stats + clears memory in `beforeEach` and uses unique keys.
 *
 * Source: packages/core/src/cache/client.ts
 */

import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";

import { CacheClient, getRedisClient } from "@usemoney/core/cache";
import type { CacheConfig } from "@usemoney/cache";

// ============================================================================
// Tests
// ============================================================================

describe("Core Cache Client (real CacheClient, memory layer)", () => {
  let client: CacheClient;

  const memOnlyConfig: CacheConfig = {
    ttl: 60,
    enableMemory: true,
    enableRedis: false,
  };
  // enableRedis is true but Redis is unconfigured (getRedisClient() === null),
  // so these configs exercise the real "Redis enabled but unavailable" path.
  const redisEnabledNoClient: CacheConfig = {
    ttl: 60,
    enableMemory: false,
    enableRedis: true,
  };
  const dualConfig: CacheConfig = {
    ttl: 60,
    enableMemory: true,
    enableRedis: true,
  };

  // Guard the suite invariant: Redis must be unconfigured for the memory-only
  // path to be the one under test. (node --test does not load .env, so the
  // REDIS_URL in apps/web/.env is not present here.)
  let savedCacheEnabled: string | undefined;

  before(() => {
    assert.equal(
      getRedisClient(),
      null,
      "this suite assumes Redis is unconfigured; set no REDIS_URL when running it"
    );
  });

  beforeEach(async () => {
    client = new CacheClient();
    // The memory cache + stats are module-level singletons shared across the
    // whole process — isolate each test.
    await client.clearMemory();
    client.resetStats();
    savedCacheEnabled = process.env.CACHE_ENABLED;
    delete process.env.CACHE_ENABLED;
  });

  after(() => {
    if (savedCacheEnabled === undefined) {
      delete process.env.CACHE_ENABLED;
    } else {
      process.env.CACHE_ENABLED = savedCacheEnabled;
    }
  });

  // ==========================================================================
  // Memory Cache (Layer 1)
  // ==========================================================================

  describe("Memory Cache (Layer 1)", () => {
    it("should store and retrieve data from memory", async () => {
      await client.set("mem:key1", { value: "hello" }, memOnlyConfig);
      const result = await client.get<{ value: string }>(
        "mem:key1",
        memOnlyConfig
      );
      assert.deepStrictEqual(result, { value: "hello" });
    });

    it("should return null on memory miss", async () => {
      const result = await client.get("mem:missing", memOnlyConfig);
      assert.strictEqual(result, null);
    });

    it("should track memory hits", async () => {
      await client.set("mem:hit", "data", memOnlyConfig);
      await client.get("mem:hit", memOnlyConfig);

      const stats = client.getStats();
      assert.strictEqual(stats.memory.hits, 1);
    });

    it("should track memory misses", async () => {
      await client.get("mem:miss", memOnlyConfig);

      const stats = client.getStats();
      assert.strictEqual(stats.memory.misses, 1);
    });

    it("should track memory sets", async () => {
      await client.set("mem:set", "data", memOnlyConfig);

      const stats = client.getStats();
      assert.strictEqual(stats.memory.sets, 1);
    });

    it("should expire memory entries based on TTL staleness", async () => {
      const shortTTL: CacheConfig = {
        ttl: 0,
        enableMemory: true,
        enableRedis: false,
      };
      await client.set("mem:expire", "data", shortTTL);

      // ttl=0 means the client's own staleness check (now - timestamp < 0) is
      // immediately false → treated as expired.
      const result = await client.get("mem:expire", shortTTL);
      assert.strictEqual(result, null);
    });

    it("should not store in memory when enableMemory is false", async () => {
      await client.set("mem:none", "data", redisEnabledNoClient);

      const stats = client.getStats();
      assert.strictEqual(stats.memory.sets, 0);
    });

    it("should handle overwriting existing entry", async () => {
      await client.set("mem:overwrite", { v: 1 }, memOnlyConfig);
      await client.set("mem:overwrite", { v: 2 }, memOnlyConfig);
      const result = await client.get<{ v: number }>(
        "mem:overwrite",
        memOnlyConfig
      );
      assert.strictEqual(result?.v, 2);
    });
  });

  // ==========================================================================
  // Redis enabled but unavailable (no client) — real null-Redis behavior
  // ==========================================================================

  describe("Redis enabled but unavailable", () => {
    it("returns null and does not track a redis miss when Redis is unconfigured", async () => {
      const result = await client.get("noredis:get", redisEnabledNoClient);
      assert.strictEqual(result, null);

      const stats = client.getStats();
      // getRedisClient() is null, so the redis miss counter is NOT bumped.
      assert.strictEqual(stats.redis.misses, 0);
    });

    it("does not track a redis set when Redis is unconfigured", async () => {
      await client.set("noredis:set", "data", dualConfig);

      const stats = client.getStats();
      assert.strictEqual(stats.memory.sets, 1);
      assert.strictEqual(stats.redis.sets, 0);
    });
  });

  // ==========================================================================
  // Delete operations
  // ==========================================================================

  describe("Delete Operations", () => {
    it("should delete from memory", async () => {
      await client.set("del:key", "data", dualConfig);
      await client.delete("del:key");

      const result = await client.get("del:key", dualConfig);
      assert.strictEqual(result, null);
    });

    it("should track a memory delete (no redis delete when unconfigured)", async () => {
      await client.set("del:track", "data", dualConfig);
      await client.delete("del:track");

      const stats = client.getStats();
      assert.strictEqual(stats.memory.deletes, 1);
      assert.strictEqual(stats.redis.deletes, 0);
    });

    it("should not throw when deleting non-existent key", async () => {
      await client.delete("del:nonexistent");
      assert.ok(true, "Did not throw");
    });
  });

  // ==========================================================================
  // Delete pattern (Redis-only; returns 0 with no Redis client)
  // ==========================================================================

  describe("Delete Pattern", () => {
    it("should return 0 when Redis is unavailable", async () => {
      const deleted = await client.deletePattern("any:*");
      assert.strictEqual(deleted, 0);
    });
  });

  // ==========================================================================
  // Clear memory
  // ==========================================================================

  describe("Clear Memory", () => {
    it("should clear all entries from memory cache", async () => {
      await client.set("clear:1", "a", memOnlyConfig);
      await client.set("clear:2", "b", memOnlyConfig);

      await client.clearMemory();

      const r1 = await client.get("clear:1", memOnlyConfig);
      const r2 = await client.get("clear:2", memOnlyConfig);
      assert.strictEqual(r1, null);
      assert.strictEqual(r2, null);
    });
  });

  // ==========================================================================
  // Cache statistics
  // ==========================================================================

  describe("Cache Statistics", () => {
    it("should provide separated stats for memory and redis", () => {
      const stats = client.getStats();
      assert.ok("memory" in stats);
      assert.ok("redis" in stats);
    });

    it("should track all stat types", () => {
      const stats = client.getStats();
      for (const layer of ["memory", "redis"] as const) {
        assert.ok("hits" in stats[layer]);
        assert.ok("misses" in stats[layer]);
        assert.ok("sets" in stats[layer]);
        assert.ok("deletes" in stats[layer]);
        assert.ok("errors" in stats[layer]);
      }
    });

    it("should reset all statistics to zero", async () => {
      await client.set("stat:key", "data", memOnlyConfig);
      await client.get("stat:key", memOnlyConfig);
      await client.get("stat:missing", memOnlyConfig);
      await client.delete("stat:key");

      client.resetStats();

      const stats = client.getStats();
      assert.strictEqual(stats.memory.hits, 0);
      assert.strictEqual(stats.memory.misses, 0);
      assert.strictEqual(stats.memory.sets, 0);
      assert.strictEqual(stats.memory.deletes, 0);
      assert.strictEqual(stats.memory.errors, 0);
      assert.strictEqual(stats.redis.hits, 0);
      assert.strictEqual(stats.redis.misses, 0);
      assert.strictEqual(stats.redis.sets, 0);
      assert.strictEqual(stats.redis.deletes, 0);
      assert.strictEqual(stats.redis.errors, 0);
    });

    it("should return a copy of stats (not reference)", () => {
      const stats1 = client.getStats();
      const stats2 = client.getStats();
      assert.notStrictEqual(stats1.memory, stats2.memory);
      assert.deepStrictEqual(stats1, stats2);
    });

    it("should calculate hit rate from stats", async () => {
      await client.set("hr:key", "data", memOnlyConfig);
      // 3 hits
      await client.get("hr:key", memOnlyConfig);
      await client.get("hr:key", memOnlyConfig);
      await client.get("hr:key", memOnlyConfig);
      // 1 miss
      await client.get("hr:missing", memOnlyConfig);

      const stats = client.getStats();
      const hitRate =
        (stats.memory.hits / (stats.memory.hits + stats.memory.misses)) * 100;
      assert.strictEqual(hitRate, 75);
    });
  });

  // ==========================================================================
  // Cache enabled/disabled (real env-driven gate: CACHE_ENABLED)
  // ==========================================================================

  describe("Cache Enabled/Disabled", () => {
    it("should return null when cache is globally disabled via CACHE_ENABLED=false", async () => {
      // Seed while enabled, then disable.
      await client.set("disabled:read", "data", memOnlyConfig);
      process.env.CACHE_ENABLED = "false";
      const result = await client.get("disabled:read", memOnlyConfig);
      assert.strictEqual(result, null);
    });

    it("should not set when cache is globally disabled via CACHE_ENABLED=false", async () => {
      process.env.CACHE_ENABLED = "false";
      await client.set("disabled:set", "data", dualConfig);

      const stats = client.getStats();
      assert.strictEqual(stats.memory.sets, 0);
      assert.strictEqual(stats.redis.sets, 0);
    });
  });

  // ==========================================================================
  // Versioning
  // ==========================================================================

  describe("Versioning", () => {
    it("should store data with an explicit version", async () => {
      await client.set("ver:explicit", "data", memOnlyConfig, "v2.0");
      const result = await client.get<string>("ver:explicit", memOnlyConfig);
      assert.strictEqual(result, "data");
    });

    it("should store data with the default version", async () => {
      await client.set("ver:default", "data", memOnlyConfig);
      const result = await client.get<string>("ver:default", memOnlyConfig);
      assert.strictEqual(result, "data");
    });
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe("Edge Cases", () => {
    it("should handle empty string keys", async () => {
      await client.set("", "data", memOnlyConfig);
      const result = await client.get("", memOnlyConfig);
      assert.strictEqual(result, "data");
    });

    it("should handle special characters in keys", async () => {
      const key = "cache:user@1:data#main";
      await client.set(key, { special: true }, memOnlyConfig);
      const result = await client.get<{ special: boolean }>(key, memOnlyConfig);
      assert.deepStrictEqual(result, { special: true });
    });

    it("should handle boolean data", async () => {
      await client.set("edge:bool-true", true, memOnlyConfig);
      await client.set("edge:bool-false", false, memOnlyConfig);
      assert.strictEqual(
        await client.get("edge:bool-true", memOnlyConfig),
        true
      );
      assert.strictEqual(
        await client.get("edge:bool-false", memOnlyConfig),
        false
      );
    });

    it("should handle array data", async () => {
      const arr = [1, "two", { three: 3 }];
      await client.set("edge:arr", arr, memOnlyConfig);
      const result = await client.get("edge:arr", memOnlyConfig);
      assert.deepStrictEqual(result, arr);
    });

    it("should handle concurrent reads and writes", async () => {
      const writes = Array.from({ length: 10 }, (_, i) =>
        client.set(`edge:conc:${i}`, { idx: i }, memOnlyConfig)
      );
      await Promise.all(writes);

      const reads = Array.from({ length: 10 }, (_, i) =>
        client.get<{ idx: number }>(`edge:conc:${i}`, memOnlyConfig)
      );
      const results = await Promise.all(reads);

      for (let i = 0; i < 10; i++) {
        assert.deepStrictEqual(results[i], { idx: i });
      }
    });

    it("should handle deeply nested objects", async () => {
      const deep = { a: { b: { c: { d: { e: "deep" } } } } };
      await client.set("edge:deep", deep, memOnlyConfig);
      const result = await client.get<typeof deep>("edge:deep", memOnlyConfig);
      assert.strictEqual(result?.a.b.c.d.e, "deep");
    });
  });
});
