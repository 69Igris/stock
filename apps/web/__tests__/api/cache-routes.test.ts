/**
 * Cache Routes - REAL logic tests (web app).
 *
 * Exercises the ACTUAL exported helpers the cache `clear` / `stats` route
 * handlers call:
 *   - clear-logic: validateActionType + the per-action ClearResult builders
 *   - stats-logic: calculateHitRate / calculateOverallStats / parseRedisInfo /
 *     buildRedisConnectedInfo / buildRedisDisconnectedInfo
 *
 * (Replaces the previous SHADOW version, which reimplemented the hit-rate
 * maths, the Redis-INFO parser, and every result builder inline and asserted
 * the copies. The routes now import & call these, so this guards the real code.
 * The trivial admin-guard / body-presence checks remain inline 1-liners in the
 * route bodies and are covered by the route-level admin/auth tests.)
 *
 * Source: apps/web/app/api/cache/clear/route.ts + clear-logic.ts
 *         apps/web/app/api/cache/stats/route.ts + stats-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type CacheStats,
  calculateHitRate,
  calculateOverallStats,
  parseRedisInfo,
  buildRedisConnectedInfo,
  buildRedisDisconnectedInfo,
} from "@/app/api/cache/stats-logic";
import {
  validateActionType,
  buildAllClearResult,
  buildUserModulesClearResult,
  buildUserAllClearResult,
  buildPatternClearResult,
  buildMemoryClearResult,
} from "@/app/api/cache/clear-logic";

// --- Mock Data ---

function createMockCacheStats(overrides: Partial<CacheStats> = {}): CacheStats {
  return {
    memory: { hits: 100, misses: 20, sets: 50, deletes: 5, errors: 1 },
    redis: { hits: 200, misses: 30, sets: 80, deletes: 10, errors: 2 },
    ...overrides,
  };
}

// --- Tests ---

describe("Cache Routes", () => {
  describe("validateActionType", () => {
    it("accepts 'all' action", () => {
      assert.strictEqual(validateActionType("all"), null);
    });

    it("accepts 'user' action", () => {
      assert.strictEqual(validateActionType("user"), null);
    });

    it("accepts 'pattern' action", () => {
      assert.strictEqual(validateActionType("pattern"), null);
    });

    it("accepts 'memory' action", () => {
      assert.strictEqual(validateActionType("memory"), null);
    });

    it("rejects an unknown action with the valid-actions hint", () => {
      const result = validateActionType("nuke");
      assert.ok(result?.includes("Invalid action: nuke"));
      assert.ok(result?.includes("all, user, pattern, memory"));
    });

    it("rejects empty string", () => {
      assert.ok(validateActionType("") !== null);
    });
  });

  describe("buildAllClearResult", () => {
    it("includes the key count in the message", () => {
      const result = buildAllClearResult(150);
      assert.ok(result.message.includes("150"));
      assert.strictEqual(result.details?.keysCleared, 150);
      assert.strictEqual(result.success, true);
    });

    it("handles zero keys", () => {
      const result = buildAllClearResult(0);
      assert.ok(result.message.includes("0 keys"));
    });
  });

  describe("buildUserModulesClearResult", () => {
    it("includes userId and modules", () => {
      const result = buildUserModulesClearResult("user_123", [
        "dashboard",
        "positions",
      ]);
      assert.ok(result.message.includes("user_123"));
      assert.ok(result.message.includes("dashboard"));
      assert.ok(result.message.includes("positions"));
      assert.deepStrictEqual(result.details?.modules, [
        "dashboard",
        "positions",
      ]);
    });
  });

  describe("buildUserAllClearResult", () => {
    it("includes userId and the allModules flag", () => {
      const result = buildUserAllClearResult("user_456");
      assert.ok(result.message.includes("user_456"));
      assert.strictEqual(result.details?.allModules, true);
    });
  });

  describe("buildPatternClearResult", () => {
    it("includes the pattern and keys-deleted count", () => {
      const result = buildPatternClearResult("dashboard:*", 25);
      assert.ok(result.message.includes("dashboard:*"));
      assert.ok(result.message.includes("25"));
      assert.strictEqual(result.details?.keysDeleted, 25);
    });
  });

  describe("buildMemoryClearResult", () => {
    it("returns a success message with no details", () => {
      const result = buildMemoryClearResult();
      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes("memory cache"));
      assert.strictEqual(result.details, undefined);
    });
  });

  describe("calculateHitRate", () => {
    it("calculates the correct hit rate", () => {
      assert.strictEqual(calculateHitRate(80, 20), "80.00");
    });

    it("returns 0.00 for no hits or misses (div-by-zero safe)", () => {
      assert.strictEqual(calculateHitRate(0, 0), "0.00");
    });

    it("handles a 100% hit rate", () => {
      assert.strictEqual(calculateHitRate(100, 0), "100.00");
    });

    it("handles a 0% hit rate", () => {
      assert.strictEqual(calculateHitRate(0, 100), "0.00");
    });

    it("handles fractional percentages", () => {
      assert.strictEqual(calculateHitRate(1, 2), "33.33");
    });
  });

  describe("calculateOverallStats", () => {
    it("sums the memory and redis layers", () => {
      const overall = calculateOverallStats(createMockCacheStats());
      assert.strictEqual(overall.hits, 300);
      assert.strictEqual(overall.misses, 50);
      assert.strictEqual(overall.sets, 130);
      assert.strictEqual(overall.deletes, 15);
      assert.strictEqual(overall.errors, 3);
    });

    it("calculates the combined hit rate", () => {
      const overall = calculateOverallStats(createMockCacheStats());
      // 300 / (300 + 50) = 85.71%
      assert.strictEqual(overall.hitRate, "85.71%");
    });

    it("handles all zeros (no NaN)", () => {
      const overall = calculateOverallStats(
        createMockCacheStats({
          memory: { hits: 0, misses: 0, sets: 0, deletes: 0, errors: 0 },
          redis: { hits: 0, misses: 0, sets: 0, deletes: 0, errors: 0 },
        })
      );
      assert.strictEqual(overall.hitRate, "0.00%");
      assert.strictEqual(overall.hits, 0);
    });

    it("handles only memory stats", () => {
      const overall = calculateOverallStats(
        createMockCacheStats({
          redis: { hits: 0, misses: 0, sets: 0, deletes: 0, errors: 0 },
        })
      );
      assert.strictEqual(overall.hits, 100);
      assert.strictEqual(overall.misses, 20);
    });
  });

  describe("parseRedisInfo", () => {
    it("parses a valid Redis INFO string", () => {
      const info =
        "# Stats\r\ntotal_connections_received:42\r\ntotal_commands_processed:1000\r\n";
      const result = parseRedisInfo(info);
      assert.strictEqual(result.total_connections_received, "42");
      assert.strictEqual(result.total_commands_processed, "1000");
    });

    it("skips comment lines", () => {
      const info =
        "# Server\r\nredis_version:7.0.0\r\n# Clients\r\nconnected_clients:5\r\n";
      const result = parseRedisInfo(info);
      assert.strictEqual(result.redis_version, "7.0.0");
      assert.strictEqual(result.connected_clients, "5");
      assert.strictEqual(result["# Server"], undefined);
    });

    it("handles an empty info string", () => {
      assert.deepStrictEqual(parseRedisInfo(""), {});
    });

    it("skips lines without a colon separator", () => {
      const info = "no_colon_line\r\nvalid_key:valid_value\r\n";
      const result = parseRedisInfo(info);
      assert.strictEqual(result.valid_key, "valid_value");
      assert.strictEqual(Object.keys(result).length, 1);
    });
  });

  describe("buildRedisConnectedInfo", () => {
    it("includes connection stats", () => {
      const result = buildRedisConnectedInfo(
        {
          total_connections_received: "42",
          total_commands_processed: "1000",
        },
        250
      );
      assert.strictEqual(result.connected, true);
      assert.strictEqual(result.totalConnectionsReceived, "42");
      assert.strictEqual(result.totalCommandsProcessed, "1000");
      assert.strictEqual(result.keyCount, 250);
    });

    it("uses N/A for missing stats", () => {
      const result = buildRedisConnectedInfo({}, 0);
      assert.strictEqual(result.totalConnectionsReceived, "N/A");
      assert.strictEqual(result.totalCommandsProcessed, "N/A");
    });
  });

  describe("buildRedisDisconnectedInfo", () => {
    it("returns disconnected status", () => {
      const result = buildRedisDisconnectedInfo();
      assert.strictEqual(result.connected, false);
      assert.ok(result.message.includes("not available"));
    });
  });
});
