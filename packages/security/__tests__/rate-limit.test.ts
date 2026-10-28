/**
 * Rate Limiting Utility Tests
 *
 * Migrated (W0-α) from apps/web/__tests__/security/rate-limit.test.ts; the only
 * change is the import path (`@/lib/security/rate-limit` → `../src/rate-limit`).
 * The limiter is backed by an in-memory LRUCache (no network/timers at load), so
 * it runs clean under node:test. The pre-configured-limiter block asserts the
 * REAL limiters' configured limit + reset window behaviourally (the configs
 * aren't exported as data), using unique per-test tokens so the module-singleton
 * state never collides.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createRateLimiter,
  createRateLimitKey,
  checkRateLimit,
  apiRateLimiter,
  authRateLimiter,
  brokerRateLimiter,
  syncRateLimiter,
} from "../src/rate-limit";

interface RateLimitResult {
  success: boolean;
  remaining: number;
  reset: number;
}

/** Unique token per assertion so the shared singletons never collide. */
let tokenSeq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${tokenSeq++}`;

// --- Tests ---

describe("Rate Limiting Utilities", () => {
  // -- createRateLimitKey --

  describe("createRateLimitKey", () => {
    it("should join two parts with colon", () => {
      assert.strictEqual(createRateLimitKey("api", "user-123"), "api:user-123");
    });

    it("should join three parts with colons", () => {
      assert.strictEqual(
        createRateLimitKey("broker", "zerodha", "user-1"),
        "broker:zerodha:user-1",
      );
    });

    it("should return a single part without colon", () => {
      assert.strictEqual(createRateLimitKey("api"), "api");
    });

    it("should filter out empty strings", () => {
      assert.strictEqual(createRateLimitKey("api", "", "user-1"), "api:user-1");
    });

    it("should return empty string when all parts are empty", () => {
      assert.strictEqual(createRateLimitKey("", "", ""), "");
    });

    it("should handle IP-based keys", () => {
      assert.strictEqual(
        createRateLimitKey("auth", "10.0.0.1"),
        "auth:10.0.0.1",
      );
    });
  });

  // -- createRateLimiter --

  describe("createRateLimiter", () => {
    let limiter: ReturnType<typeof createRateLimiter>;

    beforeEach(() => {
      limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 500,
      });
    });

    describe("check()", () => {
      it("should allow the first request", async () => {
        const result = await limiter.check(10, "user-1");
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.remaining, 9);
      });

      it("should decrement remaining on each request", async () => {
        const r1 = await limiter.check(5, "user-1");
        assert.strictEqual(r1.remaining, 4);

        const r2 = await limiter.check(5, "user-1");
        assert.strictEqual(r2.remaining, 3);
      });

      it("should allow requests up to the limit", async () => {
        for (let i = 0; i < 5; i++) {
          const result = await limiter.check(5, "user-1");
          assert.strictEqual(result.success, true);
        }
      });

      it("should reject request that exceeds the limit", async () => {
        for (let i = 0; i < 3; i++) {
          await limiter.check(3, "user-1");
        }
        const result = await limiter.check(3, "user-1");
        assert.strictEqual(result.success, false);
      });

      it("should return remaining=0 when over limit", async () => {
        for (let i = 0; i < 5; i++) {
          await limiter.check(5, "user-1");
        }
        const result = await limiter.check(5, "user-1");
        assert.strictEqual(result.remaining, 0);
      });

      it("should return success=true at exactly the limit", async () => {
        let result: RateLimitResult;
        for (let i = 0; i < 3; i++) {
          result = await limiter.check(3, "user-1");
        }
        assert.strictEqual(result!.success, true);
        assert.strictEqual(result!.remaining, 0);
      });

      it("should include a positive reset time", async () => {
        const result = await limiter.check(10, "user-1");
        assert.ok(result.reset > 0);
        assert.ok(result.reset <= 60_000);
      });

      it("should handle a limit of 1", async () => {
        const r1 = await limiter.check(1, "token-a");
        assert.strictEqual(r1.success, true);
        assert.strictEqual(r1.remaining, 0);

        const r2 = await limiter.check(1, "token-a");
        assert.strictEqual(r2.success, false);
      });

      it("should handle a limit of 0 (always reject)", async () => {
        const r1 = await limiter.check(0, "token-x");
        assert.strictEqual(r1.success, false);
      });
    });

    describe("key isolation", () => {
      it("should track different keys independently", async () => {
        for (let i = 0; i < 3; i++) {
          await limiter.check(3, "user-1");
        }
        const overLimit = await limiter.check(3, "user-1");
        assert.strictEqual(overLimit.success, false);

        const fresh = await limiter.check(3, "user-2");
        assert.strictEqual(fresh.success, true);
        assert.strictEqual(fresh.remaining, 2);
      });

      it("should not mix counts between keys", async () => {
        await limiter.check(10, "key-a");
        await limiter.check(10, "key-a");
        await limiter.check(10, "key-b");

        assert.strictEqual(limiter.getUsage("key-a"), 2);
        assert.strictEqual(limiter.getUsage("key-b"), 1);
      });
    });

    describe("reset()", () => {
      it("should clear usage for a specific key", async () => {
        await limiter.check(5, "user-1");
        await limiter.check(5, "user-1");

        limiter.reset("user-1");
        assert.strictEqual(limiter.getUsage("user-1"), 0);
      });

      it("should not affect other keys when resetting one", async () => {
        await limiter.check(5, "user-1");
        await limiter.check(5, "user-2");

        limiter.reset("user-1");

        assert.strictEqual(limiter.getUsage("user-1"), 0);
        assert.strictEqual(limiter.getUsage("user-2"), 1);
      });

      it("should allow requests again after reset", async () => {
        for (let i = 0; i < 3; i++) {
          await limiter.check(3, "user-1");
        }
        const blocked = await limiter.check(3, "user-1");
        assert.strictEqual(blocked.success, false);

        limiter.reset("user-1");
        const allowed = await limiter.check(3, "user-1");
        assert.strictEqual(allowed.success, true);
      });

      it("should be a no-op for non-existent keys", () => {
        limiter.reset("non-existent-key");
        assert.strictEqual(limiter.getUsage("non-existent-key"), 0);
      });
    });

    describe("getUsage()", () => {
      it("should return 0 for unknown keys", () => {
        assert.strictEqual(limiter.getUsage("unknown"), 0);
      });

      it("should return correct count after multiple checks", async () => {
        await limiter.check(10, "user-1");
        await limiter.check(10, "user-1");
        await limiter.check(10, "user-1");
        assert.strictEqual(limiter.getUsage("user-1"), 3);
      });

      it("should count even beyond the limit", async () => {
        for (let i = 0; i < 5; i++) {
          await limiter.check(3, "user-1");
        }
        assert.strictEqual(limiter.getUsage("user-1"), 5);
      });
    });

    describe("window expiry", () => {
      it("should reset counter when interval has passed", async () => {
        const shortLimiter = createRateLimiter({
          interval: 50,
          uniqueTokenPerInterval: 100,
        });

        await shortLimiter.check(2, "user-1");
        await shortLimiter.check(2, "user-1");
        const blocked = await shortLimiter.check(2, "user-1");
        assert.strictEqual(blocked.success, false);

        await new Promise((resolve) => setTimeout(resolve, 60));

        const allowed = await shortLimiter.check(2, "user-1");
        assert.strictEqual(allowed.success, true);
        assert.strictEqual(allowed.remaining, 1);
      });
    });
  });

  // -- checkRateLimit helper --

  describe("checkRateLimit", () => {
    it("should not throw when within limit", async () => {
      const limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 100,
      });
      await assert.doesNotReject(async () => {
        await checkRateLimit(limiter, 10, "user-1");
      });
    });

    it("should throw with RATE_LIMIT_EXCEEDED code when over limit", async () => {
      const limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 100,
      });
      for (let i = 0; i < 2; i++) {
        await limiter.check(2, "user-1");
      }
      try {
        await checkRateLimit(limiter, 2, "user-1");
        assert.fail("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string; retryAfter: number };
        assert.strictEqual(error.code, "RATE_LIMIT_EXCEEDED");
        assert.ok(error.retryAfter > 0);
      }
    });

    it("should use custom error message", async () => {
      const limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 100,
      });
      await limiter.check(1, "user-1");
      try {
        await checkRateLimit(limiter, 1, "user-1", "Too many requests");
        assert.fail("Should have thrown");
      } catch (err) {
        assert.strictEqual((err as Error).message, "Too many requests");
      }
    });

    it("should use default error message when none provided", async () => {
      const limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 100,
      });
      await limiter.check(1, "user-1");
      try {
        await checkRateLimit(limiter, 1, "user-1");
        assert.fail("Should have thrown");
      } catch (err) {
        assert.strictEqual(
          (err as Error).message,
          "Rate limit exceeded. Please try again later.",
        );
      }
    });
  });

  // -- Pre-configured limiter singletons (behavioural) --

  describe("Pre-configured limiters (real singletons)", () => {
    /** Run `n` checks at `limit` against a fresh token; return the last result. */
    async function runN(
      limiter: {
        check: (limit: number, token: string) => Promise<RateLimitResult>;
      },
      limit: number,
      n: number,
      token: string,
    ): Promise<RateLimitResult> {
      let last: RateLimitResult = { success: true, remaining: limit, reset: 0 };
      for (let i = 0; i < n; i++) last = await limiter.check(limit, token);
      return last;
    }

    it("apiRateLimiter allows 60/min then blocks the 61st; reset ≤ 60s", async () => {
      const token = uniq("api");
      const at60 = await runN(apiRateLimiter, 60, 60, token);
      assert.strictEqual(at60.success, true);
      assert.ok(at60.reset > 0 && at60.reset <= 60_000);
      const at61 = await apiRateLimiter.check(60, token);
      assert.strictEqual(at61.success, false);
    });

    it("authRateLimiter allows 10/15min then blocks the 11th; reset ≤ 15min", async () => {
      const token = uniq("auth");
      const at10 = await runN(authRateLimiter, 10, 10, token);
      assert.strictEqual(at10.success, true);
      assert.ok(at10.reset > 0 && at10.reset <= 15 * 60_000);
      const at11 = await authRateLimiter.check(10, token);
      assert.strictEqual(at11.success, false);
    });

    it("brokerRateLimiter allows 30/min then blocks the 31st", async () => {
      const token = uniq("broker");
      const at30 = await runN(brokerRateLimiter, 30, 30, token);
      assert.strictEqual(at30.success, true);
      const at31 = await brokerRateLimiter.check(30, token);
      assert.strictEqual(at31.success, false);
    });

    it("syncRateLimiter allows 5/hour then blocks the 6th; reset ≤ 1h (longest window)", async () => {
      const token = uniq("sync");
      const at5 = await runN(syncRateLimiter, 5, 5, token);
      assert.strictEqual(at5.success, true);
      assert.ok(at5.reset > 0 && at5.reset <= 60 * 60_000);
      const at6 = await syncRateLimiter.check(5, token);
      assert.strictEqual(at6.success, false);
    });

    it("sync window is the longest, api window is short", async () => {
      const sync = await syncRateLimiter.check(5, uniq("sync"));
      const api = await apiRateLimiter.check(60, uniq("api"));
      // sync resets within an hour; api within a minute — sync > api.
      assert.ok(sync.reset > api.reset);
    });
  });
});
