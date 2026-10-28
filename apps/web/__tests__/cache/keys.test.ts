import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { generateCacheKey, generateVersionHash } from "@usemoney/cache";

describe("Cache Key Generation", () => {
  describe("generateCacheKey", () => {
    it("should generate a valid cache key with all parameters", () => {
      const key = generateCacheKey("dashboard", "user123", "stats", {
        page: 1,
        limit: 10,
      });

      assert.ok(key.startsWith("dashboard:user123:stats:"));
      assert.ok(key.length > "dashboard:user123:stats:".length);
    });

    it("should generate same key for same parameters", () => {
      const filters = { page: 1, limit: 10, sort: "desc" };
      const key1 = generateCacheKey("dashboard", "user123", "stats", filters);
      const key2 = generateCacheKey("dashboard", "user123", "stats", filters);

      assert.strictEqual(key1, key2);
    });

    it("should generate different keys for different filters", () => {
      const filters1 = { page: 1, limit: 10 };
      const filters2 = { page: 2, limit: 10 };

      const key1 = generateCacheKey("dashboard", "user123", "stats", filters1);
      const key2 = generateCacheKey("dashboard", "user123", "stats", filters2);

      assert.notStrictEqual(key1, key2);
    });

    it("should generate key without filters", () => {
      const key = generateCacheKey("dashboard", "user123", "stats");

      assert.strictEqual(key, "dashboard:user123:stats:default");
    });

    it("should handle empty filters object", () => {
      const key = generateCacheKey("dashboard", "user123", "stats", {});

      // Empty object generates a hash, not "default"
      assert.ok(key.startsWith("dashboard:user123:stats:"));
      assert.notStrictEqual(key, "dashboard:user123:stats:default");
    });

    it("should generate different keys for different modules", () => {
      const key1 = generateCacheKey("dashboard", "user123", "stats");
      const key2 = generateCacheKey("positions", "user123", "stats");

      assert.notStrictEqual(key1, key2);
    });

    it("should generate different keys for different users", () => {
      const key1 = generateCacheKey("dashboard", "user123", "stats");
      const key2 = generateCacheKey("dashboard", "user456", "stats");

      assert.notStrictEqual(key1, key2);
    });

    it("should generate different keys for different identifiers", () => {
      const key1 = generateCacheKey("dashboard", "user123", "stats");
      const key2 = generateCacheKey("dashboard", "user123", "chart");

      assert.notStrictEqual(key1, key2);
    });
  });

  describe("generateVersionHash", () => {
    it("should generate consistent hash for same filters", () => {
      const filters = { page: 1, limit: 10, sort: "desc" };
      const hash1 = generateVersionHash(filters);
      const hash2 = generateVersionHash(filters);

      assert.strictEqual(hash1, hash2);
    });

    it("should generate different hash for different filters", () => {
      const filters1 = { page: 1, limit: 10 };
      const filters2 = { page: 2, limit: 10 };

      const hash1 = generateVersionHash(filters1);
      const hash2 = generateVersionHash(filters2);

      assert.notStrictEqual(hash1, hash2);
    });

    it("should generate hash of 8 characters", () => {
      const hash = generateVersionHash({ page: 1, limit: 10 });

      assert.strictEqual(hash.length, 8);
    });

    it("should handle undefined filters", () => {
      // generateVersionHash expects data, but generateCacheKey handles undefined
      // Testing the actual usage pattern from generateCacheKey
      const key = generateCacheKey("dashboard", "user123", "stats", undefined);

      assert.strictEqual(key, "dashboard:user123:stats:default");
    });

    it("should generate hash for empty object", () => {
      const hash = generateVersionHash({});

      // Empty object still generates a hash (not "default")
      assert.strictEqual(hash.length, 8);
      assert.ok(/^[a-f0-9]{8}$/.test(hash));
    });

    it("should be case-sensitive for filter values", () => {
      const hash1 = generateVersionHash({ sort: "DESC" });
      const hash2 = generateVersionHash({ sort: "desc" });

      assert.notStrictEqual(hash1, hash2);
    });

    it("should ignore key order in filters", () => {
      const filters1 = { page: 1, limit: 10, sort: "desc" };
      const filters2 = { sort: "desc", limit: 10, page: 1 };

      const hash1 = generateVersionHash(filters1);
      const hash2 = generateVersionHash(filters2);

      assert.strictEqual(hash1, hash2);
    });

    it("should handle nested objects in filters", () => {
      const filters = {
        page: 1,
        filters: {
          status: "active",
          type: "stock",
        },
      };

      const hash = generateVersionHash(filters);

      assert.ok(hash.length === 8);
    });

    it("should handle array values in filters", () => {
      const filters = {
        statuses: ["active", "pending"],
        types: ["stock", "option"],
      };

      const hash = generateVersionHash(filters);

      assert.ok(hash.length === 8);
    });
  });

  describe("Cache Key + Version Hash Integration", () => {
    it("should automatically invalidate cache when filters change", () => {
      const filters1 = { page: 1, status: "open" };
      const filters2 = { page: 1, status: "closed" };

      const key1 = generateCacheKey("positions", "user123", "list", filters1);
      const key2 = generateCacheKey("positions", "user123", "list", filters2);

      // Keys should be different because filter values changed
      assert.notStrictEqual(key1, key2);
    });

    it("should not invalidate cache when filter order changes", () => {
      const filters1 = { page: 1, limit: 10, status: "open" };
      const filters2 = { status: "open", page: 1, limit: 10 };

      const key1 = generateCacheKey("positions", "user123", "list", filters1);
      const key2 = generateCacheKey("positions", "user123", "list", filters2);

      // Keys should be identical because filter order doesn't matter
      assert.strictEqual(key1, key2);
    });
  });
});
