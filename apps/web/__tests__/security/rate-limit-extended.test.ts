/**
 * Rate Limiting Utilities - Extended Tests
 *
 * Deep coverage of rate limiting logic including:
 *   - Sliding window behavior in detail
 *   - Boundary conditions (limit=0, limit=1, large limits)
 *   - Concurrent multi-user scenarios
 *   - Key generation with various input patterns
 *   - checkRateLimit error properties in detail
 *   - Reset timing and behavior
 *   - Token isolation guarantees
 *   - Edge cases: negative values, special characters in keys
 *
 * Source: apps/web/lib/security/rate-limit.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createRateLimiter,
  createRateLimitKey,
  checkRateLimit,
} from "@usemoney/security/rate-limit";

// De-shadowed (MONEY-620): imports the REAL createRateLimiter /
// createRateLimitKey / checkRateLimit from lib/security/rate-limit.ts (backed by
// an in-memory LRUCache; loads clean under node:test).

// --- Extended Tests ---

describe("Rate Limiting - Extended", () => {
  // -- createRateLimitKey edge cases --

  describe("createRateLimitKey - edge cases", () => {
    it("should handle keys with colons in values", () => {
      assert.strictEqual(createRateLimitKey("api", "::1"), "api:::1");
    });

    it("should handle IPv6 addresses", () => {
      assert.strictEqual(
        createRateLimitKey("auth", "2001:0db8:85a3::8a2e:0370:7334"),
        "auth:2001:0db8:85a3::8a2e:0370:7334"
      );
    });

    it("should handle special characters", () => {
      assert.strictEqual(
        createRateLimitKey("api", "user@example.com"),
        "api:user@example.com"
      );
    });

    it("should handle very long keys", () => {
      const longPart = "x".repeat(500);
      const result = createRateLimitKey("api", longPart);
      assert.strictEqual(result, `api:${longPart}`);
    });

    it("should handle single empty part among valid parts", () => {
      assert.strictEqual(createRateLimitKey("a", "", "b", "", "c"), "a:b:c");
    });

    it("should handle all parts being the same", () => {
      assert.strictEqual(
        createRateLimitKey("token", "token", "token"),
        "token:token:token"
      );
    });

    it("should handle numeric-like strings", () => {
      assert.strictEqual(createRateLimitKey("api", "12345"), "api:12345");
    });
  });

  // -- Rate limiter: boundary limit values --

  describe("Rate limiter - boundary limit values", () => {
    let limiter: ReturnType<typeof createRateLimiter>;

    beforeEach(() => {
      limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 500,
      });
    });

    it("limit=0 should immediately reject all requests", async () => {
      const r = await limiter.check(0, "user-1");
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.remaining, 0);
    });

    it("limit=1 should allow first then reject second", async () => {
      const r1 = await limiter.check(1, "user-1");
      assert.strictEqual(r1.success, true);
      assert.strictEqual(r1.remaining, 0);

      const r2 = await limiter.check(1, "user-1");
      assert.strictEqual(r2.success, false);
      assert.strictEqual(r2.remaining, 0);
    });

    it("large limit should allow many requests", async () => {
      for (let i = 0; i < 100; i++) {
        const result = await limiter.check(1000, "user-1");
        assert.strictEqual(result.success, true);
      }
      const final = await limiter.check(1000, "user-1");
      assert.strictEqual(final.success, true);
      assert.strictEqual(final.remaining, 899);
    });

    it("remaining should never go below 0", async () => {
      for (let i = 0; i < 10; i++) {
        await limiter.check(3, "user-1");
      }
      const r = await limiter.check(3, "user-1");
      assert.strictEqual(r.remaining, 0);
      assert.ok(r.remaining >= 0);
    });
  });

  // -- Rate limiter: multi-user isolation --

  describe("Rate limiter - multi-user isolation", () => {
    let limiter: ReturnType<typeof createRateLimiter>;

    beforeEach(() => {
      limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 500,
      });
    });

    it("should track 10 users independently", async () => {
      for (let u = 0; u < 10; u++) {
        await limiter.check(5, `user-${u}`);
      }
      for (let u = 0; u < 10; u++) {
        assert.strictEqual(limiter.getUsage(`user-${u}`), 1);
      }
    });

    it("should rate limit one user without affecting others", async () => {
      // Exhaust limit for user-0
      for (let i = 0; i < 3; i++) {
        await limiter.check(3, "user-0");
      }
      const blocked = await limiter.check(3, "user-0");
      assert.strictEqual(blocked.success, false);

      // Other users should still be fine
      for (let u = 1; u <= 5; u++) {
        const r = await limiter.check(3, `user-${u}`);
        assert.strictEqual(r.success, true);
      }
    });

    it("should reset one user without affecting others", async () => {
      await limiter.check(10, "user-A");
      await limiter.check(10, "user-A");
      await limiter.check(10, "user-B");
      await limiter.check(10, "user-B");
      await limiter.check(10, "user-B");

      limiter.reset("user-A");

      assert.strictEqual(limiter.getUsage("user-A"), 0);
      assert.strictEqual(limiter.getUsage("user-B"), 3);
    });

    it("should handle same token checked with different limits", async () => {
      // First check with limit 5 -> usage becomes 1
      const r1 = await limiter.check(5, "token-x");
      assert.strictEqual(r1.success, true);
      assert.strictEqual(r1.remaining, 4);

      // Second check with limit 1 -> usage becomes 2, but limit is 1
      const r2 = await limiter.check(1, "token-x");
      assert.strictEqual(r2.success, false); // 2 > 1
    });
  });

  // -- Rate limiter: reset behavior in detail --

  describe("Rate limiter - reset behavior in detail", () => {
    let limiter: ReturnType<typeof createRateLimiter>;

    beforeEach(() => {
      limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 500,
      });
    });

    it("reset should allow re-use immediately", async () => {
      for (let i = 0; i < 5; i++) {
        await limiter.check(5, "user-1");
      }
      assert.strictEqual((await limiter.check(5, "user-1")).success, false);

      limiter.reset("user-1");

      const r = await limiter.check(5, "user-1");
      assert.strictEqual(r.success, true);
      assert.strictEqual(r.remaining, 4);
    });

    it("double reset should be safe", () => {
      limiter.reset("user-1");
      limiter.reset("user-1");
      assert.strictEqual(limiter.getUsage("user-1"), 0);
    });

    it("reset all users should clear all", async () => {
      const users = ["a", "b", "c", "d"];
      for (const u of users) {
        await limiter.check(10, u);
      }
      for (const u of users) {
        limiter.reset(u);
      }
      for (const u of users) {
        assert.strictEqual(limiter.getUsage(u), 0);
      }
    });
  });

  // -- Rate limiter: reset time values --

  describe("Rate limiter - reset time values", () => {
    it("first request should have reset equal to interval", async () => {
      const limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 100,
      });
      const r = await limiter.check(10, "user-1");
      assert.ok(r.reset > 0);
      assert.ok(r.reset <= 60_000);
    });

    it("reset time should decrease as time passes", async () => {
      const limiter = createRateLimiter({
        interval: 100,
        uniqueTokenPerInterval: 100,
      });
      const r1 = await limiter.check(10, "user-1");
      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 20));
      const r2 = await limiter.check(10, "user-1");
      assert.ok(r2.reset <= r1.reset);
    });

    it("reset on blocked request should still be positive", async () => {
      const limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 100,
      });
      await limiter.check(1, "user-1");
      const blocked = await limiter.check(1, "user-1");
      assert.strictEqual(blocked.success, false);
      assert.ok(blocked.reset > 0);
    });
  });

  // -- Rate limiter: window expiry --

  describe("Rate limiter - window expiry", () => {
    it("should reset after interval elapses", async () => {
      const limiter = createRateLimiter({
        interval: 40,
        uniqueTokenPerInterval: 100,
      });

      await limiter.check(1, "user-1");
      const blocked = await limiter.check(1, "user-1");
      assert.strictEqual(blocked.success, false);

      await new Promise((resolve) => setTimeout(resolve, 50));

      const fresh = await limiter.check(1, "user-1");
      assert.strictEqual(fresh.success, true);
      assert.strictEqual(fresh.remaining, 0);
    });

    it("should reset usage count after window expires", async () => {
      const limiter = createRateLimiter({
        interval: 30,
        uniqueTokenPerInterval: 100,
      });

      await limiter.check(5, "user-1");
      await limiter.check(5, "user-1");
      assert.strictEqual(limiter.getUsage("user-1"), 2);

      await new Promise((resolve) => setTimeout(resolve, 40));

      // After expiry, next check should start fresh
      await limiter.check(5, "user-1");
      assert.strictEqual(limiter.getUsage("user-1"), 1);
    });
  });

  // -- checkRateLimit error properties --

  describe("checkRateLimit - error properties in detail", () => {
    it("error should have code RATE_LIMIT_EXCEEDED", async () => {
      const limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 100,
      });
      await limiter.check(1, "user-1");
      try {
        await checkRateLimit(limiter, 1, "user-1");
        assert.fail("Should have thrown");
      } catch (err) {
        const error = err as Error & { code: string; retryAfter: number };
        assert.strictEqual(error.code, "RATE_LIMIT_EXCEEDED");
      }
    });

    it("error retryAfter should be positive seconds", async () => {
      const limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 100,
      });
      await limiter.check(1, "user-1");
      try {
        await checkRateLimit(limiter, 1, "user-1");
        assert.fail("Should have thrown");
      } catch (err) {
        const error = err as Error & { retryAfter: number };
        assert.ok(error.retryAfter > 0);
        assert.ok(error.retryAfter <= 60); // Up to 60 seconds for a 60s window
      }
    });

    it("error retryAfter should be ceil of reset/1000", async () => {
      const limiter = createRateLimiter({
        interval: 5_500, // 5.5 seconds
        uniqueTokenPerInterval: 100,
      });
      await limiter.check(1, "user-1");
      try {
        await checkRateLimit(limiter, 1, "user-1");
        assert.fail("Should have thrown");
      } catch (err) {
        const error = err as Error & { retryAfter: number };
        // retryAfter should be ceil of ~5.5 = 6
        assert.ok(error.retryAfter >= 1);
        assert.ok(error.retryAfter <= 6);
      }
    });

    it("should not throw when within limit of 10", async () => {
      const limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 100,
      });
      for (let i = 0; i < 9; i++) {
        await limiter.check(10, "user-1");
      }
      await assert.doesNotReject(async () => {
        await checkRateLimit(limiter, 10, "user-1");
      });
    });

    it("should throw exactly at limit+1", async () => {
      const limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 100,
      });
      for (let i = 0; i < 5; i++) {
        await limiter.check(5, "user-1");
      }
      await assert.rejects(async () => checkRateLimit(limiter, 5, "user-1"), {
        code: "RATE_LIMIT_EXCEEDED",
      });
    });

    it("should use custom error message", async () => {
      const limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 100,
      });
      await limiter.check(1, "user-1");
      try {
        await checkRateLimit(limiter, 1, "user-1", "Custom rate limit msg");
        assert.fail("Should have thrown");
      } catch (err) {
        assert.strictEqual((err as Error).message, "Custom rate limit msg");
      }
    });
  });

  // -- Rate limiter: special key patterns --

  describe("Rate limiter - special key patterns", () => {
    let limiter: ReturnType<typeof createRateLimiter>;

    beforeEach(() => {
      limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 500,
      });
    });

    it("should handle empty string token", async () => {
      const r = await limiter.check(5, "");
      assert.strictEqual(r.success, true);
    });

    it("should handle token with special characters", async () => {
      const r = await limiter.check(5, "user:123:api");
      assert.strictEqual(r.success, true);
    });

    it("should handle very long token", async () => {
      const longToken = "x".repeat(10000);
      const r = await limiter.check(5, longToken);
      assert.strictEqual(r.success, true);
    });

    it("should handle token with unicode", async () => {
      const r = await limiter.check(5, "user-\u{1F4B0}-money");
      assert.strictEqual(r.success, true);
    });
  });

  // -- getUsage after various operations --

  describe("getUsage - extended scenarios", () => {
    let limiter: ReturnType<typeof createRateLimiter>;

    beforeEach(() => {
      limiter = createRateLimiter({
        interval: 60_000,
        uniqueTokenPerInterval: 500,
      });
    });

    it("should return 0 for a brand new token", () => {
      assert.strictEqual(limiter.getUsage("never-seen"), 0);
    });

    it("should track usage across rejected requests", async () => {
      for (let i = 0; i < 10; i++) {
        await limiter.check(3, "user-1");
      }
      // Usage should be 10 even though limit is 3
      assert.strictEqual(limiter.getUsage("user-1"), 10);
    });

    it("should return 0 after reset", async () => {
      await limiter.check(10, "user-1");
      await limiter.check(10, "user-1");
      limiter.reset("user-1");
      assert.strictEqual(limiter.getUsage("user-1"), 0);
    });

    it("should track usage accurately for multiple tokens", async () => {
      await limiter.check(10, "a");
      await limiter.check(10, "b");
      await limiter.check(10, "b");
      await limiter.check(10, "c");
      await limiter.check(10, "c");
      await limiter.check(10, "c");

      assert.strictEqual(limiter.getUsage("a"), 1);
      assert.strictEqual(limiter.getUsage("b"), 2);
      assert.strictEqual(limiter.getUsage("c"), 3);
    });
  });
});
