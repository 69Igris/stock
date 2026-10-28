/**
 * Integration Tests: Redis Operations
 *
 * Tests Redis set/get, TTL expiry, deletion, pattern-based deletion,
 * and pipeline operations against the QA Redis instance.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type Redis from "ioredis";

if (!process.env.RUN_INTEGRATION_TESTS) {
  describe("Integration: Redis Operations (skipped)", () => {
    it("skipped - set RUN_INTEGRATION_TESTS=true to run", () => {
      assert.ok(true, "Skipped");
    });
  });
} else {
  let redis: Redis;

  // All keys use this prefix for easy identification and cleanup
  const KEY_PREFIX = "test_integration_redis_";

  // Helper to generate unique keys
  function testKey(suffix: string): string {
    return `${KEY_PREFIX}${Date.now()}_${suffix}`;
  }

  describe("Integration: Redis Operations", () => {
    before(async () => {
      const setupMod = await import("../setup.js");
      await import("../teardown.js");
      redis = setupMod.redis;
    });

    // Clean up all test keys after suite completes
    after(async () => {
      if (!redis) return;
      const keys = await redis.keys(`${KEY_PREFIX}*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    });

    // --- Set/Get string values ---

    describe("set/get string values", () => {
      it("should set and get a string value", async () => {
        const key = testKey("str1");
        await redis.set(key, "hello world");

        const result = await redis.get(key);
        assert.strictEqual(result, "hello world");
      });

      it("should set and get a JSON-serialized value", async () => {
        const key = testKey("json1");
        const data = { name: "test", value: 42, nested: { a: true } };
        await redis.set(key, JSON.stringify(data));

        const result = await redis.get(key);
        assert.deepStrictEqual(JSON.parse(result!), data);
      });

      it("should overwrite existing value", async () => {
        const key = testKey("overwrite");
        await redis.set(key, "first");
        await redis.set(key, "second");

        const result = await redis.get(key);
        assert.strictEqual(result, "second");
      });

      it("should return null for non-existent key", async () => {
        const result = await redis.get(`${KEY_PREFIX}nonexistent_key_xyz`);
        assert.strictEqual(result, null);
      });

      it("should handle empty string value", async () => {
        const key = testKey("empty");
        await redis.set(key, "");

        const result = await redis.get(key);
        assert.strictEqual(result, "");
      });

      it("should handle large string values", async () => {
        const key = testKey("large");
        const largeValue = "x".repeat(100_000); // 100KB
        await redis.set(key, largeValue);

        const result = await redis.get(key);
        assert.strictEqual(result!.length, 100_000);
      });
    });

    // --- TTL and expiry ---

    describe("TTL and expiry", () => {
      it("should set key with TTL in seconds (EX)", async () => {
        const key = testKey("ttl_ex");
        await redis.set(key, "expires soon", "EX", 60);

        const ttl = await redis.ttl(key);
        assert.ok(ttl > 0 && ttl <= 60, `TTL should be between 1-60, got ${ttl}`);
      });

      it("should set key with TTL in milliseconds (PX)", async () => {
        const key = testKey("ttl_px");
        await redis.set(key, "ms expiry", "PX", 60_000);

        const pttl = await redis.pttl(key);
        assert.ok(
          pttl > 0 && pttl <= 60_000,
          `PTTL should be between 1-60000, got ${pttl}`
        );
      });

      it("should expire key using EXPIRE command", async () => {
        const key = testKey("expire_cmd");
        await redis.set(key, "will expire");
        await redis.expire(key, 30);

        const ttl = await redis.ttl(key);
        assert.ok(ttl > 0 && ttl <= 30);
      });

      it("should verify key expires after TTL", async () => {
        const key = testKey("expire_verify");
        await redis.set(key, "short-lived", "PX", 200); // 200ms TTL

        // Key should exist right now
        const valueBefore = await redis.get(key);
        assert.strictEqual(valueBefore, "short-lived");

        // Wait for expiry
        await new Promise((resolve) => setTimeout(resolve, 350));

        const valueAfter = await redis.get(key);
        assert.strictEqual(valueAfter, null, "Key should have expired");
      });

      it("should return -1 TTL for key with no expiry", async () => {
        const key = testKey("no_ttl");
        await redis.set(key, "persistent");

        const ttl = await redis.ttl(key);
        assert.strictEqual(ttl, -1, "Key without TTL should return -1");
      });

      it("should return -2 TTL for non-existent key", async () => {
        const ttl = await redis.ttl(`${KEY_PREFIX}nonexistent_ttl_xyz`);
        assert.strictEqual(ttl, -2, "Non-existent key should return -2");
      });
    });

    // --- Delete keys ---

    describe("delete keys", () => {
      it("should delete a single key", async () => {
        const key = testKey("del1");
        await redis.set(key, "to delete");

        const deleted = await redis.del(key);
        assert.strictEqual(deleted, 1);

        const result = await redis.get(key);
        assert.strictEqual(result, null);
      });

      it("should delete multiple keys at once", async () => {
        const key1 = testKey("del_multi_1");
        const key2 = testKey("del_multi_2");
        const key3 = testKey("del_multi_3");

        await Promise.all([
          redis.set(key1, "a"),
          redis.set(key2, "b"),
          redis.set(key3, "c"),
        ]);

        const deleted = await redis.del(key1, key2, key3);
        assert.strictEqual(deleted, 3);
      });

      it("should return 0 when deleting non-existent key", async () => {
        const deleted = await redis.del(`${KEY_PREFIX}nonexistent_del_xyz`);
        assert.strictEqual(deleted, 0);
      });
    });

    // --- Pattern-based deletion (SCAN + DEL) ---

    describe("pattern-based deletion", () => {
      it("should find and delete keys matching a pattern", async () => {
        const prefix = testKey("pattern_");
        const keys = [
          `${prefix}a`,
          `${prefix}b`,
          `${prefix}c`,
        ];

        for (const key of keys) {
          await redis.set(key, "pattern value");
        }

        // Find keys by pattern using KEYS (acceptable for test data)
        const foundKeys = await redis.keys(`${prefix}*`);
        assert.strictEqual(foundKeys.length, 3);

        // Delete them
        if (foundKeys.length > 0) {
          const deleted = await redis.del(...foundKeys);
          assert.strictEqual(deleted, 3);
        }

        // Verify they are gone
        const remaining = await redis.keys(`${prefix}*`);
        assert.strictEqual(remaining.length, 0);
      });

      it("should use SCAN for safe iteration", async () => {
        const prefix = testKey("scan_");
        for (let i = 0; i < 5; i++) {
          await redis.set(`${prefix}${i}`, `val_${i}`);
        }

        // Use SCAN to find matching keys
        const foundKeys: string[] = [];
        let cursor = "0";

        do {
          const [nextCursor, keys] = await redis.scan(
            cursor,
            "MATCH",
            `${prefix}*`,
            "COUNT",
            10
          );
          cursor = nextCursor;
          foundKeys.push(...keys);
        } while (cursor !== "0");

        assert.strictEqual(foundKeys.length, 5);

        // Cleanup
        if (foundKeys.length > 0) {
          await redis.del(...foundKeys);
        }
      });
    });

    // --- Pipeline operations ---

    describe("pipeline operations", () => {
      it("should run multiple commands in a pipeline", async () => {
        const key1 = testKey("pipe_1");
        const key2 = testKey("pipe_2");
        const key3 = testKey("pipe_3");

        const pipeline = redis.pipeline();
        pipeline.set(key1, "val1");
        pipeline.set(key2, "val2");
        pipeline.set(key3, "val3");
        pipeline.get(key1);
        pipeline.get(key2);
        pipeline.get(key3);

        const results = await pipeline.exec();
        assert.ok(results, "Pipeline should return results");
        assert.strictEqual(results!.length, 6); // 3 sets + 3 gets

        // Check GET results (indices 3, 4, 5)
        assert.strictEqual(results![3]![1], "val1");
        assert.strictEqual(results![4]![1], "val2");
        assert.strictEqual(results![5]![1], "val3");
      });

      it("should handle pipeline with mixed operations", async () => {
        const key = testKey("pipe_mixed");

        const pipeline = redis.pipeline();
        pipeline.set(key, "initial");
        pipeline.get(key);
        pipeline.set(key, "updated");
        pipeline.get(key);

        const results = await pipeline.exec();
        assert.ok(results);

        // After pipeline: second GET should return "updated"
        assert.strictEqual(results![3]![1], "updated");
      });

      it("should handle INCR in pipeline", async () => {
        const key = testKey("pipe_incr");
        await redis.set(key, "0");

        const pipeline = redis.pipeline();
        pipeline.incr(key);
        pipeline.incr(key);
        pipeline.incr(key);
        pipeline.get(key);

        const results = await pipeline.exec();
        assert.ok(results);
        assert.strictEqual(results![3]![1], "3");
      });
    });

    // --- Hash operations ---

    describe("hash operations", () => {
      it("should set and get hash fields", async () => {
        const key = testKey("hash1");
        await redis.hset(key, "field1", "value1", "field2", "value2");

        const val1 = await redis.hget(key, "field1");
        const val2 = await redis.hget(key, "field2");

        assert.strictEqual(val1, "value1");
        assert.strictEqual(val2, "value2");
      });

      it("should get all hash fields with HGETALL", async () => {
        const key = testKey("hash_all");
        await redis.hset(key, "name", "test", "count", "42");

        const all = await redis.hgetall(key);
        assert.deepStrictEqual(all, { name: "test", count: "42" });
      });

      it("should return empty object for non-existent hash", async () => {
        const all = await redis.hgetall(`${KEY_PREFIX}nonexistent_hash`);
        assert.deepStrictEqual(all, {});
      });
    });

    // --- Connection handling ---

    describe("connection handling", () => {
      it("should report ready status", async () => {
        assert.strictEqual(redis.status, "ready", "Redis should be in ready state");
      });

      it("should handle PING command", async () => {
        const result = await redis.ping();
        assert.strictEqual(result, "PONG");
      });
    });
  });
}
