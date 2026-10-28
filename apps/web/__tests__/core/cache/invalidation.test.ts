/**
 * Core Cache Invalidation Tests
 *
 * Exercises the REAL invalidation utilities exported from
 * packages/core/src/cache/invalidation.ts (via `@usemoney/core/cache`):
 * `clearUserCache`, `clearBrokerSyncCache`, `clearTradeCache`,
 * `clearPositionCache`, `clearHoldingsCache`, `clearFireCache`,
 * `clearSubscriptionCache`, `clearBrokerConnectionCache`, `clearChatCache`,
 * `clearWatchlistCache`, `clearAllUserCache`, `clearCachePattern`.
 *
 * No inline reimplementation. The REAL functions run end-to-end; the ONLY
 * boundary mocked is the outermost Redis I/O — `cacheClient.deletePattern` is
 * spied (via `node:test` `mock.method`) so each real function's requested
 * patterns are captured. This is a side-effect assertion, not a shadow: the
 * pattern-building + dispatch logic asserted here is the production code path
 * (`deletePattern` is genuinely Redis-only and a no-op when Redis is
 * unconfigured, so it can't be observed via the memory cache).
 *
 * Divergence the old shadow hid: its inline `clearPositionCache` cleared FOUR
 * modules ([dashboard, positions, holdings, trades]) and asserted 4. The REAL
 * `clearPositionCache` clears only TWO ([dashboard, positions]) — its own
 * JSDoc says "holdings and trades not affected by position close". The shadow
 * over-cleared against its own copy and passed. Corrected below.
 *
 * Source: packages/core/src/cache/invalidation.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  clearUserCache,
  clearBrokerSyncCache,
  clearTradeCache,
  clearPositionCache,
  clearHoldingsCache,
  clearFireCache,
  clearSubscriptionCache,
  clearBrokerConnectionCache,
  clearChatCache,
  clearWatchlistCache,
  clearAllUserCache,
  clearCachePattern,
  generateCachePattern,
  cacheClient,
} from "@usemoney/core/cache";

// ============================================================================
// Spy harness — capture the patterns the REAL functions pass to deletePattern
// ============================================================================

let patterns: string[] = [];

/** Modules a pattern set touches, e.g. "dashboard:u:*" -> "dashboard". */
function modulesOf(captured: string[]): string[] {
  return captured.map((p) => p.split(":")[0]!);
}

beforeEach(() => {
  patterns = [];
  // Mock ONLY the Redis boundary; the real invalidation logic still runs.
  mock.method(cacheClient, "deletePattern", async (pattern: string) => {
    patterns.push(pattern);
    return 0;
  });
});

afterEach(() => {
  mock.restoreAll();
});

// ============================================================================
// Tests
// ============================================================================

describe("Core Cache Invalidation (real @usemoney/core exports)", () => {
  const testUserId = "test-user-456";

  // The full per-user module set cleared by clearAllUserCache.
  const ALL_MODULES = [
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
  ];

  // ==========================================================================
  // clearUserCache
  // ==========================================================================

  describe("clearUserCache", () => {
    describe("single module", () => {
      it("should clear a single module when passed as a string", async () => {
        await clearUserCache(testUserId, "dashboard");
        assert.strictEqual(patterns.length, 1);
        assert.strictEqual(patterns[0], `dashboard:${testUserId}:*`);
      });

      it("should request the correct pattern for positions", async () => {
        await clearUserCache(testUserId, "positions");
        assert.strictEqual(patterns[0], `positions:${testUserId}:*`);
      });

      it("should request the correct pattern for holdings", async () => {
        await clearUserCache(testUserId, "holdings");
        assert.strictEqual(patterns[0], `holdings:${testUserId}:*`);
      });

      it("should request the correct pattern for trades", async () => {
        await clearUserCache(testUserId, "trades");
        assert.strictEqual(patterns[0], `trades:${testUserId}:*`);
      });

      it("should request the correct pattern for fire", async () => {
        await clearUserCache(testUserId, "fire");
        assert.strictEqual(patterns[0], `fire:${testUserId}:*`);
      });

      it("should request the correct pattern for mutual-funds", async () => {
        await clearUserCache(testUserId, "mutual-funds");
        assert.strictEqual(patterns[0], `mutual-funds:${testUserId}:*`);
      });

      it("should request the correct pattern for brokers", async () => {
        await clearUserCache(testUserId, "brokers");
        assert.strictEqual(patterns[0], `brokers:${testUserId}:*`);
      });

      it("should request the correct pattern for chat", async () => {
        await clearUserCache(testUserId, "chat");
        assert.strictEqual(patterns[0], `chat:${testUserId}:*`);
      });

      it("should request the correct pattern for subscription", async () => {
        await clearUserCache(testUserId, "subscription");
        assert.strictEqual(patterns[0], `subscription:${testUserId}:*`);
      });

      it("should request the correct pattern for user", async () => {
        await clearUserCache(testUserId, "user");
        assert.strictEqual(patterns[0], `user:${testUserId}:*`);
      });
    });

    describe("multiple modules (array)", () => {
      it("should clear all modules passed in array", async () => {
        await clearUserCache(testUserId, [
          "dashboard",
          "positions",
          "holdings",
        ]);
        const mods = modulesOf(patterns);
        assert.strictEqual(mods.length, 3);
        assert.ok(mods.includes("dashboard"));
        assert.ok(mods.includes("positions"));
        assert.ok(mods.includes("holdings"));
      });

      it("should request a pattern for each module", async () => {
        await clearUserCache(testUserId, ["dashboard", "trades"]);
        assert.strictEqual(patterns.length, 2);
        assert.ok(patterns.includes(`dashboard:${testUserId}:*`));
        assert.ok(patterns.includes(`trades:${testUserId}:*`));
      });

      it("should handle all 10 modules at once", async () => {
        await clearUserCache(
          testUserId,
          ALL_MODULES as Parameters<typeof clearUserCache>[1]
        );
        const mods = modulesOf(patterns);
        assert.strictEqual(mods.length, 10);
        for (const module of ALL_MODULES) {
          assert.ok(mods.includes(module), `Should have cleared "${module}"`);
        }
      });

      it("should treat a single-element array the same as a string", async () => {
        await clearUserCache(testUserId, "dashboard");
        const single = patterns.slice();
        patterns = [];
        await clearUserCache(testUserId, ["dashboard"]);
        assert.deepStrictEqual(patterns, single);
      });
    });

    describe("user ID handling", () => {
      it("should include the user ID in all patterns", async () => {
        const userId = "user-abc-123";
        await clearUserCache(userId, ["dashboard", "trades"]);
        for (const pattern of patterns) {
          assert.ok(
            pattern.includes(userId),
            `"${pattern}" should contain "${userId}"`
          );
        }
      });

      it("should produce different patterns for different users", async () => {
        await clearUserCache("user-A", "dashboard");
        const a = patterns[0];
        patterns = [];
        await clearUserCache("user-B", "dashboard");
        assert.notStrictEqual(a, patterns[0]);
      });
    });
  });

  // ==========================================================================
  // clearBrokerSyncCache → dashboard, positions, holdings, trades, mutual-funds
  // ==========================================================================

  describe("clearBrokerSyncCache", () => {
    const SYNC_MODULES = [
      "dashboard",
      "positions",
      "holdings",
      "trades",
      "mutual-funds",
    ];

    it("should clear exactly 5 modules", async () => {
      await clearBrokerSyncCache(testUserId);
      assert.strictEqual(patterns.length, 5);
    });

    it("should clear exactly the broker-sync module set and nothing else", async () => {
      await clearBrokerSyncCache(testUserId);
      const mods = modulesOf(patterns);
      for (const module of SYNC_MODULES) {
        assert.ok(
          mods.includes(module),
          `Broker sync should clear "${module}"`
        );
      }
      const nonSync = ALL_MODULES.filter((m) => !SYNC_MODULES.includes(m));
      for (const module of nonSync) {
        assert.ok(
          !mods.includes(module),
          `Broker sync should NOT clear "${module}"`
        );
      }
    });
  });

  // ==========================================================================
  // clearTradeCache → dashboard, trades
  // ==========================================================================

  describe("clearTradeCache", () => {
    it("should clear exactly 2 modules (dashboard, trades)", async () => {
      await clearTradeCache(testUserId);
      assert.strictEqual(patterns.length, 2);
      const mods = modulesOf(patterns);
      assert.ok(mods.includes("dashboard"));
      assert.ok(mods.includes("trades"));
    });

    it("should NOT clear positions/holdings/fire/mutual-funds", async () => {
      await clearTradeCache(testUserId);
      const mods = modulesOf(patterns);
      for (const m of ["positions", "holdings", "fire", "mutual-funds"]) {
        assert.ok(!mods.includes(m), `Trade cache should NOT clear "${m}"`);
      }
    });

    it("should request the exact dashboard and trades patterns", async () => {
      await clearTradeCache(testUserId);
      assert.ok(patterns.includes(`dashboard:${testUserId}:*`));
      assert.ok(patterns.includes(`trades:${testUserId}:*`));
    });
  });

  // ==========================================================================
  // clearPositionCache → dashboard, positions  (REAL is 2, shadow said 4)
  // ==========================================================================

  describe("clearPositionCache", () => {
    it("should clear exactly 2 modules (dashboard, positions) — NOT 4", async () => {
      await clearPositionCache(testUserId);
      assert.strictEqual(patterns.length, 2);
      const mods = modulesOf(patterns);
      assert.ok(mods.includes("dashboard"));
      assert.ok(mods.includes("positions"));
    });

    it("should NOT clear holdings (per real source — shadow over-cleared this)", async () => {
      await clearPositionCache(testUserId);
      assert.ok(!modulesOf(patterns).includes("holdings"));
    });

    it("should NOT clear trades (per real source — shadow over-cleared this)", async () => {
      await clearPositionCache(testUserId);
      assert.ok(!modulesOf(patterns).includes("trades"));
    });

    it("should NOT clear fire/mutual-funds/user/subscription", async () => {
      await clearPositionCache(testUserId);
      const mods = modulesOf(patterns);
      for (const m of ["fire", "mutual-funds", "user", "subscription"]) {
        assert.ok(!mods.includes(m), `Position cache should NOT clear "${m}"`);
      }
    });
  });

  // ==========================================================================
  // clearHoldingsCache → dashboard, holdings  (real fn the shadow omitted)
  // ==========================================================================

  describe("clearHoldingsCache", () => {
    it("should clear exactly 2 modules (dashboard, holdings)", async () => {
      await clearHoldingsCache(testUserId);
      assert.strictEqual(patterns.length, 2);
      const mods = modulesOf(patterns);
      assert.ok(mods.includes("dashboard"));
      assert.ok(mods.includes("holdings"));
    });
  });

  // ==========================================================================
  // clearFireCache
  // ==========================================================================

  describe("clearFireCache", () => {
    it("should clear the fire module when no scenarioId provided", async () => {
      await clearFireCache(testUserId);
      assert.strictEqual(patterns.length, 1);
      assert.strictEqual(patterns[0], `fire:${testUserId}:*`);
    });

    it("should request a scenario-specific pattern when scenarioId provided", async () => {
      await clearFireCache(testUserId, "scenario-abc");
      assert.strictEqual(patterns.length, 1);
      assert.strictEqual(patterns[0], `fire:${testUserId}:scenario-abc:*`);
    });

    it("should NOT clear any other module", async () => {
      await clearFireCache(testUserId);
      const mods = modulesOf(patterns);
      for (const module of ALL_MODULES.filter((m) => m !== "fire")) {
        assert.ok(
          !mods.includes(module),
          `clearFireCache should NOT clear "${module}"`
        );
      }
    });

    it("should produce different patterns for different scenarioIds", async () => {
      await clearFireCache(testUserId, "scenario-1");
      const a = patterns[0];
      patterns = [];
      await clearFireCache(testUserId, "scenario-2");
      assert.notStrictEqual(a, patterns[0]);
    });

    it("should include the scenarioId in the pattern", async () => {
      await clearFireCache(testUserId, "my-retirement-plan");
      assert.ok(patterns[0]!.includes("my-retirement-plan"));
    });
  });

  // ==========================================================================
  // clearSubscriptionCache → subscription, user
  // ==========================================================================

  describe("clearSubscriptionCache", () => {
    it("should clear exactly 2 modules (subscription, user)", async () => {
      await clearSubscriptionCache(testUserId);
      assert.strictEqual(patterns.length, 2);
      const mods = modulesOf(patterns);
      assert.ok(mods.includes("subscription"));
      assert.ok(mods.includes("user"));
    });

    it("should NOT clear dashboard/trades/positions/brokers", async () => {
      await clearSubscriptionCache(testUserId);
      const mods = modulesOf(patterns);
      for (const m of ["dashboard", "trades", "positions", "brokers"]) {
        assert.ok(
          !mods.includes(m),
          `Subscription cache should NOT clear "${m}"`
        );
      }
    });

    it("should request the exact subscription and user patterns", async () => {
      await clearSubscriptionCache(testUserId);
      assert.ok(patterns.includes(`subscription:${testUserId}:*`));
      assert.ok(patterns.includes(`user:${testUserId}:*`));
    });
  });

  // ==========================================================================
  // clearBrokerConnectionCache → brokers
  // ==========================================================================

  describe("clearBrokerConnectionCache", () => {
    it("should clear exactly the brokers module", async () => {
      await clearBrokerConnectionCache(testUserId);
      assert.strictEqual(patterns.length, 1);
      assert.strictEqual(patterns[0], `brokers:${testUserId}:*`);
    });

    it("should NOT clear dashboard/positions", async () => {
      await clearBrokerConnectionCache(testUserId);
      const mods = modulesOf(patterns);
      assert.ok(!mods.includes("dashboard"));
      assert.ok(!mods.includes("positions"));
    });
  });

  // ==========================================================================
  // clearChatCache → chat
  // ==========================================================================

  describe("clearChatCache", () => {
    it("should clear exactly the chat module", async () => {
      await clearChatCache(testUserId);
      assert.strictEqual(patterns.length, 1);
      assert.strictEqual(patterns[0], `chat:${testUserId}:*`);
    });
  });

  // ==========================================================================
  // clearWatchlistCache → watchlist  (real fn the shadow omitted)
  // ==========================================================================

  describe("clearWatchlistCache", () => {
    it("should clear exactly the watchlist module", async () => {
      await clearWatchlistCache(testUserId);
      assert.strictEqual(patterns.length, 1);
      assert.strictEqual(patterns[0], `watchlist:${testUserId}:*`);
    });
  });

  // ==========================================================================
  // clearAllUserCache → all 10 per-user modules
  // ==========================================================================

  describe("clearAllUserCache", () => {
    it("should clear all 10 modules", async () => {
      await clearAllUserCache(testUserId);
      assert.strictEqual(patterns.length, 10);
    });

    it("should request a pattern for each of the 10 modules", async () => {
      await clearAllUserCache(testUserId);
      for (const module of ALL_MODULES) {
        assert.ok(
          patterns.includes(`${module}:${testUserId}:*`),
          `Should include pattern for "${module}"`
        );
      }
    });
  });

  // ==========================================================================
  // clearCachePattern — passthrough to deletePattern (returns its number)
  // ==========================================================================

  describe("clearCachePattern", () => {
    it("should forward the pattern to deletePattern and return its count", async () => {
      const deleted = await clearCachePattern("dashboard:user123:stats:*");
      assert.strictEqual(deleted, 0); // our spy returns 0
      assert.deepStrictEqual(patterns, ["dashboard:user123:stats:*"]);
    });
  });

  // ==========================================================================
  // Scope comparison (relative sizes of the real invalidation functions)
  // ==========================================================================

  describe("Scope comparison", () => {
    async function countPatterns(fn: () => Promise<void>): Promise<number> {
      patterns = [];
      await fn();
      return patterns.length;
    }

    it("clearBrokerSyncCache clears more modules than clearTradeCache", async () => {
      const sync = await countPatterns(() => clearBrokerSyncCache(testUserId));
      const trade = await countPatterns(() => clearTradeCache(testUserId));
      assert.ok(sync > trade, `broker sync (${sync}) > trade (${trade})`);
    });

    it("clearAllUserCache clears more modules than clearBrokerSyncCache", async () => {
      const all = await countPatterns(() => clearAllUserCache(testUserId));
      const sync = await countPatterns(() => clearBrokerSyncCache(testUserId));
      assert.ok(all > sync, `all (${all}) > sync (${sync})`);
    });

    it("clearTradeCache and clearPositionCache both clear exactly 2", async () => {
      const trade = await countPatterns(() => clearTradeCache(testUserId));
      const pos = await countPatterns(() => clearPositionCache(testUserId));
      assert.strictEqual(trade, 2);
      assert.strictEqual(pos, 2);
    });
  });

  // ==========================================================================
  // generateCachePattern (real @usemoney/cache export via the core barrel)
  // ==========================================================================

  describe("generateCachePattern", () => {
    it("should generate a module-only pattern when no userId", () => {
      assert.strictEqual(generateCachePattern("dashboard"), "dashboard:*");
    });

    it("should generate a module+userId pattern", () => {
      assert.strictEqual(
        generateCachePattern("dashboard", "user123"),
        "dashboard:user123:*"
      );
    });

    it("should generate a module+userId+identifier pattern", () => {
      assert.strictEqual(
        generateCachePattern("fire", "user123", "scenario1"),
        "fire:user123:scenario1:*"
      );
    });

    it("should handle hyphenated module names", () => {
      assert.strictEqual(
        generateCachePattern("mutual-funds", "user123"),
        "mutual-funds:user123:*"
      );
    });

    it("should handle special characters in userId", () => {
      assert.strictEqual(
        generateCachePattern("dashboard", "user_abc-123"),
        "dashboard:user_abc-123:*"
      );
    });

    it("should fall to module:* when identifier is given but userId is missing", () => {
      assert.strictEqual(
        generateCachePattern("fire", undefined, "scenario1"),
        "fire:*"
      );
    });
  });

  // ==========================================================================
  // Edge Cases — real functions must resolve cleanly
  // ==========================================================================

  describe("Edge Cases", () => {
    it("clearUserCache with an empty module array should request nothing", async () => {
      await clearUserCache(
        testUserId,
        [] as unknown as Parameters<typeof clearUserCache>[1]
      );
      assert.strictEqual(patterns.length, 0);
    });

    it("clearBrokerSyncCache should not throw on an empty userId", async () => {
      await clearBrokerSyncCache("");
      assert.ok(true);
    });

    it("clearFireCache without scenarioId should not throw", async () => {
      await clearFireCache("user123");
      assert.ok(true);
    });

    it("clearFireCache with scenarioId should not throw", async () => {
      await clearFireCache("user123", "nonexistent-scenario");
      assert.ok(true);
    });

    it("clearAllUserCache should not throw on any userId", async () => {
      await clearAllUserCache("any-user-id");
      assert.ok(true);
    });

    it("calling multiple invalidation functions sequentially accumulates requests", async () => {
      await clearTradeCache(testUserId);
      await clearSubscriptionCache(testUserId);
      const mods = modulesOf(patterns);
      assert.strictEqual(patterns.length, 4); // 2 + 2
      assert.ok(mods.includes("dashboard"));
      assert.ok(mods.includes("trades"));
      assert.ok(mods.includes("subscription"));
      assert.ok(mods.includes("user"));
    });

    it("should handle a very long userId in the pattern", async () => {
      const longUserId = "user-" + "a".repeat(200);
      await clearUserCache(longUserId, "dashboard");
      assert.ok(patterns[0]!.includes(longUserId));
    });
  });
});
