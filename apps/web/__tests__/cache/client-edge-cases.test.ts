/**
 * Cache Client Edge Cases — REAL source (apps/web/lib/cache/client.ts).
 *
 * De-shadowed (MONEY-620): the previous file defined an inline `CacheClient`
 * (with an injectable mock redis) and asserted that copy. This imports the REAL
 * `CacheClient`.
 *
 * Runner constraint: the real client reaches Redis via a module-level
 * `getRedisClient()` import (`@/lib/redis/client`); `node:test`'s `mock.module`
 * is unavailable under the `tsx` (CJS) loader, so a *throwing* fake redis can't
 * be injected to drive the Redis-error branches. Under the test runner no
 * REDIS_URL is set, so `getRedisClient()` returns `null` and the client takes
 * its real no-Redis path. The cases below assert the production behaviour that
 * IS reachable end-to-end through the real client:
 *   - falsy-value caching (null/0/false/"")
 *   - TTL=0 / negative TTL expiry
 *   - CACHE_ENABLED=false disabling (real `isCacheEnabled()`, env-driven)
 *   - graceful degrade with no Redis (memory still serves; deletePattern→0)
 *   - miss-tracking semantics (memory counted; redis NOT counted when the
 *     client is absent — a real detail the old mock-always-present shadow got
 *     wrong)
 *   - stats copy / reset
 *
 * The memory(L1)+stats live in module scope, so `clearMemory()`+`resetStats()`
 * run per-test, and CACHE_ENABLED is cleaned up in afterEach.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CacheClient } from "@/lib/cache/client";
import type { CacheConfig } from "@usemoney/cache";

const BOTH_LAYERS: CacheConfig = {
  ttl: 300,
  enableMemory: true,
  enableRedis: true,
};

const MEMORY_ONLY: CacheConfig = {
  ttl: 300,
  enableMemory: true,
  enableRedis: false,
};

describe("CacheClient Edge Cases (real @/lib/cache/client)", () => {
  let client: CacheClient;

  beforeEach(async () => {
    client = new CacheClient();
    await client.clearMemory();
    client.resetStats();
  });

  afterEach(() => {
    delete process.env.CACHE_ENABLED;
  });

  // ── Falsy value caching ──────────────────────────────────────────

  describe("Falsy value caching", () => {
    it("should cache null and retrieve null (indistinguishable from a miss)", async () => {
      await client.set("key-null", null, MEMORY_ONLY);

      const result = await client.get("key-null", MEMORY_ONLY);
      assert.strictEqual(result, null);

      // The entry WAS set (sets counter proves it).
      assert.strictEqual(client.getStats().memory.sets, 1);
    });

    it("should cache 0 and retrieve 0 correctly", async () => {
      await client.set("key-zero", 0, MEMORY_ONLY);
      const result = await client.get<number>("key-zero", MEMORY_ONLY);

      assert.strictEqual(result, 0);
      assert.strictEqual(client.getStats().memory.hits, 1);
    });

    it("should cache false and retrieve false correctly", async () => {
      await client.set("key-false", false, MEMORY_ONLY);
      const result = await client.get<boolean>("key-false", MEMORY_ONLY);

      assert.strictEqual(result, false);
      assert.strictEqual(client.getStats().memory.hits, 1);
    });

    it("should cache empty string and retrieve it correctly", async () => {
      await client.set("key-empty", "", MEMORY_ONLY);
      const result = await client.get<string>("key-empty", MEMORY_ONLY);

      assert.strictEqual(result, "");
      assert.strictEqual(client.getStats().memory.hits, 1);
    });
  });

  // ── TTL edge cases ───────────────────────────────────────────────

  describe("TTL edge cases", () => {
    it("TTL=0 should cause immediate expiry on next read", async () => {
      const zeroTTL: CacheConfig = {
        ttl: 0,
        enableMemory: true,
        enableRedis: false,
      };

      await client.set("key-ttl0", "value", zeroTTL);

      // now - timestamp < 0 is always false → expired immediately.
      const result = await client.get("key-ttl0", zeroTTL);
      assert.strictEqual(result, null);
      assert.strictEqual(client.getStats().memory.misses, 1);
    });

    it("negative TTL should be treated as expired", async () => {
      const negativeTTL: CacheConfig = {
        ttl: -10,
        enableMemory: true,
        enableRedis: false,
      };

      await client.set("key-neg-ttl", "value", negativeTTL);

      const result = await client.get("key-neg-ttl", negativeTTL);
      assert.strictEqual(result, null);
      assert.strictEqual(client.getStats().memory.misses, 1);
    });
  });

  // ── Graceful degrade when Redis is not configured ────────────────

  describe("No-Redis graceful degrade", () => {
    it("a memory hit still serves even when enableRedis is true (L1 first)", async () => {
      // Set memory-only, then read with BOTH layers: the real client checks L1
      // first, so the memory entry is returned without ever needing Redis.
      await client.set("key-fallback", "cached-value", MEMORY_ONLY);

      const result = await client.get<string>("key-fallback", BOTH_LAYERS);
      assert.strictEqual(result, "cached-value");
      assert.strictEqual(client.getStats().memory.hits, 1);
    });

    it("set with both layers enabled does not throw when Redis is absent", async () => {
      // The Redis write is guarded by `if (redis)`; with none configured it is
      // simply skipped — memory still holds the value.
      await client.set("key-bothset", { v: 1 }, BOTH_LAYERS);
      const got = await client.get<{ v: number }>("key-bothset", BOTH_LAYERS);
      assert.deepStrictEqual(got, { v: 1 });
    });
  });

  // ── deletePattern edge cases ───────────────────────────────────

  describe("deletePattern edge cases", () => {
    it("should return 0 when Redis is unavailable (deletePattern is Redis-only)", async () => {
      const deleted = await client.deletePattern("anything:*");
      assert.strictEqual(deleted, 0);
      // No Redis error counted — the function returns early on a null client.
      assert.strictEqual(client.getStats().redis.errors, 0);
    });
  });

  // ── CACHE_ENABLED=false ────────────────────────────────────────

  describe("Cache disabled (CACHE_ENABLED=false)", () => {
    it("get should return null when cache is disabled", async () => {
      process.env.CACHE_ENABLED = "false";
      await client.set("key", "value", MEMORY_ONLY);

      const result = await client.get("key", MEMORY_ONLY);
      assert.strictEqual(result, null);
    });

    it("set should be a no-op when cache is disabled", async () => {
      process.env.CACHE_ENABLED = "false";
      await client.set("key", "value", BOTH_LAYERS);

      // Re-enable and confirm nothing was stored.
      delete process.env.CACHE_ENABLED;
      const result = await client.get("key", MEMORY_ONLY);
      assert.strictEqual(result, null);
    });

    it("set should not increment stats when cache is disabled", async () => {
      process.env.CACHE_ENABLED = "false";
      await client.set("key", "value", BOTH_LAYERS);

      const stats = client.getStats();
      assert.strictEqual(stats.memory.sets, 0);
      assert.strictEqual(stats.redis.sets, 0);
    });
  });

  // ── Stats tracking ────────────────────────────────────────────

  describe("Stats tracking", () => {
    it("miss should be incremented once per get operation (memory only)", async () => {
      const result = await client.get("nonexistent", MEMORY_ONLY);
      assert.strictEqual(result, null);

      const stats = client.getStats();
      assert.strictEqual(stats.memory.misses, 1);
      assert.strictEqual(stats.redis.misses, 0); // Redis not enabled
    });

    it("a both-layers miss counts memory, but NOT redis when no client is configured", async () => {
      // REAL detail: the client only bumps redis.misses when
      // `config.enableRedis && getRedisClient()` is truthy. With no Redis it
      // stays 0 — the old shadow (mock redis always present) asserted 1 here.
      const result = await client.get("nonexistent", BOTH_LAYERS);
      assert.strictEqual(result, null);

      const stats = client.getStats();
      assert.strictEqual(stats.memory.misses, 1);
      assert.strictEqual(stats.redis.misses, 0);
    });

    it("resetStats should zero out all counters", async () => {
      await client.set("k", "v", BOTH_LAYERS);
      await client.get<string>("k", BOTH_LAYERS);
      await client.get("miss", BOTH_LAYERS);

      client.resetStats();
      const stats = client.getStats();

      assert.strictEqual(stats.memory.hits, 0);
      assert.strictEqual(stats.memory.misses, 0);
      assert.strictEqual(stats.memory.sets, 0);
      assert.strictEqual(stats.redis.hits, 0);
      assert.strictEqual(stats.redis.misses, 0);
      assert.strictEqual(stats.redis.sets, 0);
    });

    it("getStats should return a copy (not a live reference)", () => {
      const stats1 = client.getStats();
      stats1.memory.hits = 999;

      const stats2 = client.getStats();
      assert.strictEqual(stats2.memory.hits, 0);
    });
  });
});
