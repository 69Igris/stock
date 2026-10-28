/**
 * Rate Limiting Middleware Tests - API Server
 *
 * Exercises the REAL rate-limit logic exported from
 * apps/api/src/middleware/ratelimit-logic.ts (`getClientId`, `RateLimiter`,
 * and the window/limit constants) that the Hono middleware imports & calls.
 * No inline reimplementation.
 *
 * Covers the security-relevant client-id HASH (NOT a `substring(7,20)`
 * truncation), IP fallback, window/counter behaviour, 429 response shaping,
 * rate-limit headers, multi-client isolation, and cleanup.
 *
 * Source: apps/api/src/middleware/ratelimit-logic.ts
 *         apps/api/src/middleware/ratelimit.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  RateLimiter,
  getClientId,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_CLEANUP_INTERVAL_MS,
} from "../../src/middleware/ratelimit-logic";

// ============================================================================
// Environment Save/Restore
// ============================================================================

let savedEnv: NodeJS.ProcessEnv;

// ============================================================================
// Tests: Client ID Hashing (Security Fix)
// ============================================================================

describe("Rate Limiter - Client ID Hashing", () => {
  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("should hash the full token, not truncate to 13 chars", () => {
    const id = getClientId({
      authorizationHeader:
        "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
    });
    assert.ok(id.startsWith("auth_"));
    assert.ok(id.includes("_"));
  });

  it("should produce different IDs for tokens that share first 13 chars", () => {
    // SECURITY: a substring(7,20) truncation would collapse these to one bucket.
    const id1 = getClientId({
      authorizationHeader: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.AAA",
    });
    const id2 = getClientId({
      authorizationHeader: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.BBB",
    });
    assert.notEqual(id1, id2);
  });

  it("should NOT equal the old substring(7,20) truncation", () => {
    const header = "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload";
    const id = getClientId({ authorizationHeader: header });
    const oldTruncation = header.substring(7, 20); // "eyJhbGciOiJSU"
    assert.notEqual(id, oldTruncation);
  });

  it("should include token length in client ID for uniqueness", () => {
    const id = getClientId({ authorizationHeader: "Bearer shortToken" });
    // "shortToken" has length 10
    assert.ok(id.endsWith("_10"));
  });

  it("should produce consistent hash for same token", () => {
    const header = "Bearer myConsistentToken12345";
    const id1 = getClientId({ authorizationHeader: header });
    const id2 = getClientId({ authorizationHeader: header });
    assert.equal(id1, id2);
  });

  it("should format as auth_{hash}_{length}", () => {
    const id = getClientId({ authorizationHeader: "Bearer test-token-abc" });
    const parts = id.split("_");
    assert.equal(parts[0], "auth");
    assert.ok(parts.length >= 3);
    const tokenLength = parseInt(parts[parts.length - 1]!, 10);
    assert.equal(tokenLength, "test-token-abc".length);
  });

  it("should use base-36 for hash representation", () => {
    const id = getClientId({ authorizationHeader: "Bearer somevalidtoken" });
    const hashPart = id.split("_")[1];
    assert.ok(/^-?[0-9a-z]+$/.test(hashPart!));
  });

  it("should fallback to X-Forwarded-For when auth header is short", () => {
    const id = getClientId({
      authorizationHeader: "Bearer ", // length 7, so > 7 is false
      xForwardedFor: "192.168.1.1",
    });
    assert.equal(id, "192.168.1.1");
  });

  it("should fallback to X-Forwarded-For when no auth header", () => {
    const id = getClientId({ xForwardedFor: "10.0.0.1, 172.16.0.1" });
    assert.equal(id, "10.0.0.1");
  });

  it("should use first IP from X-Forwarded-For", () => {
    const id = getClientId({
      xForwardedFor: "203.0.113.42, 10.0.0.1, 172.16.0.1",
    });
    assert.equal(id, "203.0.113.42");
  });

  it("should fallback to X-Real-IP when no auth and no X-Forwarded-For", () => {
    const id = getClientId({ xRealIP: "10.0.0.55" });
    assert.equal(id, "10.0.0.55");
  });

  it("should fallback to 'anonymous' when no identifying headers", () => {
    const id = getClientId({});
    assert.equal(id, "anonymous");
  });

  it("should prefer auth token hash over IP headers", () => {
    const id = getClientId({
      authorizationHeader: "Bearer myToken12345678",
      xForwardedFor: "1.2.3.4",
      xRealIP: "5.6.7.8",
    });
    assert.ok(id.startsWith("auth_"));
  });

  it("should prefer X-Forwarded-For over X-Real-IP", () => {
    const id = getClientId({
      xForwardedFor: "192.168.0.1",
      xRealIP: "10.0.0.1",
    });
    assert.equal(id, "192.168.0.1");
  });
});

// ============================================================================
// Tests: Rate Limit Window Behavior
// ============================================================================

describe("Rate Limiter - Window Behavior", () => {
  let limiter: RateLimiter;
  const fixedNow = 1700000000000;

  beforeEach(() => {
    savedEnv = { ...process.env };
    limiter = new RateLimiter();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("should allow the first request", () => {
    const result = limiter.processRequest("client1", fixedNow);
    assert.equal(result.allowed, true);
    assert.equal(result.status, undefined);
  });

  it("should set remaining to 99 after first request", () => {
    const result = limiter.processRequest("client1", fixedNow);
    assert.equal(result.headers["X-RateLimit-Remaining"], "99");
  });

  it("should set limit header to 100", () => {
    const result = limiter.processRequest("client1", fixedNow);
    assert.equal(result.headers["X-RateLimit-Limit"], "100");
  });

  it("should set reset header to now + window", () => {
    const result = limiter.processRequest("client1", fixedNow);
    assert.equal(
      result.headers["X-RateLimit-Reset"],
      (fixedNow + RATE_LIMIT_WINDOW_MS).toString(),
    );
  });

  it("should decrement remaining with each request", () => {
    limiter.processRequest("client1", fixedNow);
    const result = limiter.processRequest("client1", fixedNow);
    assert.equal(result.headers["X-RateLimit-Remaining"], "98");
  });

  it("should allow exactly 100 requests (the limit)", () => {
    for (let i = 0; i < 99; i++) {
      limiter.processRequest("client1", fixedNow);
    }
    const result = limiter.processRequest("client1", fixedNow);
    assert.equal(result.allowed, true);
    assert.equal(result.headers["X-RateLimit-Remaining"], "0");
  });

  it("should reject the 101st request", () => {
    for (let i = 0; i < 100; i++) {
      limiter.processRequest("client1", fixedNow);
    }
    const result = limiter.processRequest("client1", fixedNow);
    assert.equal(result.allowed, false);
    assert.equal(result.status, 429);
  });

  it("should reset count after window expires", () => {
    for (let i = 0; i < 100; i++) {
      limiter.processRequest("client1", fixedNow);
    }
    const afterWindow = fixedNow + RATE_LIMIT_WINDOW_MS + 1;
    const result = limiter.processRequest("client1", afterWindow);
    assert.equal(result.allowed, true);
    assert.equal(result.headers["X-RateLimit-Remaining"], "99");
  });

  it("should start a new window with reset time in the future", () => {
    limiter.processRequest("client1", fixedNow);
    const afterWindow = fixedNow + RATE_LIMIT_WINDOW_MS + 1;
    const result = limiter.processRequest("client1", afterWindow);
    const resetTime = parseInt(result.headers["X-RateLimit-Reset"]!, 10);
    assert.equal(resetTime, afterWindow + RATE_LIMIT_WINDOW_MS);
  });

  it("should not reset if still within window", () => {
    for (let i = 0; i < 100; i++) {
      limiter.processRequest("client1", fixedNow);
    }
    const justBefore = fixedNow + RATE_LIMIT_WINDOW_MS - 1;
    const result = limiter.processRequest("client1", justBefore);
    assert.equal(result.allowed, false);
  });

  it("should stay in the same window at the exact boundary (now === resetTime)", () => {
    limiter.processRequest("client1", fixedNow);
    // now > resetTime is false when equal, so the window is NOT reset.
    const exactReset = fixedNow + RATE_LIMIT_WINDOW_MS;
    const result = limiter.processRequest("client1", exactReset);
    assert.equal(result.allowed, true);
    assert.equal(result.headers["X-RateLimit-Remaining"], "98");
  });
});

// ============================================================================
// Tests: 429 Response Format
// ============================================================================

describe("Rate Limiter - 429 Response", () => {
  let limiter: RateLimiter;
  const fixedNow = 1700000000000;

  beforeEach(() => {
    savedEnv = { ...process.env };
    limiter = new RateLimiter();
    for (let i = 0; i < 100; i++) {
      limiter.processRequest("client1", fixedNow);
    }
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("should return RATE_LIMIT_EXCEEDED error code", () => {
    const result = limiter.processRequest("client1", fixedNow);
    assert.equal(result.body?.error.code, "RATE_LIMIT_EXCEEDED");
  });

  it("should return success: false", () => {
    const result = limiter.processRequest("client1", fixedNow);
    assert.equal(result.body?.success, false);
  });

  it("should include Retry-After header", () => {
    const result = limiter.processRequest("client1", fixedNow);
    assert.ok(result.headers["Retry-After"]);
    const retryAfter = parseInt(result.headers["Retry-After"], 10);
    assert.ok(retryAfter > 0);
    assert.ok(retryAfter <= 60);
  });

  it("should include message with retry seconds", () => {
    const result = limiter.processRequest("client1", fixedNow);
    assert.ok(result.body?.error.message.includes("Too many requests"));
    assert.ok(result.body?.error.message.includes("retry after"));
  });

  it("should show X-RateLimit-Remaining as 0", () => {
    const result = limiter.processRequest("client1", fixedNow);
    assert.equal(result.headers["X-RateLimit-Remaining"], "0");
  });

  it("should compute Retry-After as ceiling of remaining seconds (mid-window)", () => {
    // Request at now + 500ms (59.5 seconds remaining) -> ceil(59.5) = 60
    const result = limiter.processRequest("client1", fixedNow + 500);
    const retryAfter = parseInt(result.headers["Retry-After"]!, 10);
    assert.equal(retryAfter, 60);
  });

  it("should compute Retry-After of 30 at 30s into the window", () => {
    const result = limiter.processRequest("client1", fixedNow + 30_000);
    const retryAfter = parseInt(result.headers["Retry-After"]!, 10);
    assert.equal(retryAfter, 30);
  });

  it("should compute correct Retry-After near end of window", () => {
    // Request at now + 59500ms (0.5 seconds remaining) -> ceil(0.5) = 1
    const result = limiter.processRequest("client1", fixedNow + 59500);
    const retryAfter = parseInt(result.headers["Retry-After"]!, 10);
    assert.equal(retryAfter, 1);
  });

  it("should keep blocking further requests until the window resets", () => {
    for (let i = 1; i <= 5; i++) {
      const result = limiter.processRequest("client1", fixedNow + i * 100);
      assert.equal(result.allowed, false);
      assert.equal(result.status, 429);
    }
  });
});

// ============================================================================
// Tests: Multiple Clients (isolation)
// ============================================================================

describe("Rate Limiter - Multiple Clients", () => {
  let limiter: RateLimiter;
  const fixedNow = 1700000000000;

  beforeEach(() => {
    savedEnv = { ...process.env };
    limiter = new RateLimiter();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("should track clients independently", () => {
    for (let i = 0; i < 100; i++) {
      limiter.processRequest("client1", fixedNow);
    }
    const result = limiter.processRequest("client2", fixedNow);
    assert.equal(result.allowed, true);
    assert.equal(result.headers["X-RateLimit-Remaining"], "99");
  });

  it("should maintain separate counters per client", () => {
    for (let i = 0; i < 50; i++) limiter.processRequest("clientA", fixedNow);
    for (let i = 0; i < 30; i++) limiter.processRequest("clientB", fixedNow);

    const resultA = limiter.processRequest("clientA", fixedNow);
    const resultB = limiter.processRequest("clientB", fixedNow);
    assert.equal(resultA.headers["X-RateLimit-Remaining"], "49");
    assert.equal(resultB.headers["X-RateLimit-Remaining"], "69");
  });

  it("should block one client without affecting another", () => {
    for (let i = 0; i < 100; i++) limiter.processRequest("client1", fixedNow);
    const blocked = limiter.processRequest("client1", fixedNow);
    assert.equal(blocked.allowed, false);

    const allowed = limiter.processRequest("client2", fixedNow);
    assert.equal(allowed.allowed, true);
  });

  it("should track many concurrent clients", () => {
    for (let c = 0; c < 10; c++) {
      for (let r = 0; r < 10; r++) {
        const result = limiter.processRequest(`client${c}`, fixedNow + r);
        assert.equal(result.allowed, true);
      }
    }
    assert.equal(limiter.getEntryCount(), 10);
  });
});

// ============================================================================
// Tests: Cleanup
// ============================================================================

describe("Rate Limiter - Cleanup", () => {
  let limiter: RateLimiter;
  const fixedNow = 1700000000000;

  beforeEach(() => {
    savedEnv = { ...process.env };
    limiter = new RateLimiter();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("should remove expired entries on cleanup", () => {
    limiter.processRequest("client1", fixedNow);
    limiter.processRequest("client2", fixedNow);
    assert.equal(limiter.getEntryCount(), 2);

    const afterExpiry = fixedNow + RATE_LIMIT_WINDOW_MS + 1;
    const cleaned = limiter.cleanup(afterExpiry);
    assert.equal(cleaned, 2);
    assert.equal(limiter.getEntryCount(), 0);
  });

  it("should not remove active entries", () => {
    limiter.processRequest("client1", fixedNow);
    const cleaned = limiter.cleanup(fixedNow + 1000);
    assert.equal(cleaned, 0);
    assert.equal(limiter.getEntryCount(), 1);
  });

  it("should only remove expired entries, keeping active ones", () => {
    limiter.processRequest("old_client", fixedNow);
    const later = fixedNow + RATE_LIMIT_WINDOW_MS + 1;
    limiter.processRequest("new_client", later);

    const cleaned = limiter.cleanup(later);
    assert.equal(cleaned, 1); // only old_client removed
    assert.equal(limiter.getEntryCount(), 1); // new_client remains
  });

  it("should handle cleanup on empty map", () => {
    const cleaned = limiter.cleanup(fixedNow);
    assert.equal(cleaned, 0);
    assert.equal(limiter.getEntryCount(), 0);
  });

  it("should clear all entries on reset()", () => {
    limiter.processRequest("client1", fixedNow);
    limiter.processRequest("client2", fixedNow);
    limiter.reset();
    assert.equal(limiter.getEntryCount(), 0);
  });
});

// ============================================================================
// Tests: Configuration Constants
// ============================================================================

describe("Rate Limiter - Configuration", () => {
  it("should have 1 minute (60000ms) window", () => {
    assert.equal(RATE_LIMIT_WINDOW_MS, 60000);
  });

  it("should allow 100 requests per window", () => {
    assert.equal(RATE_LIMIT_MAX_REQUESTS, 100);
  });

  it("should have a cleanup interval of 5 minutes (300000ms)", () => {
    assert.equal(RATE_LIMIT_CLEANUP_INTERVAL_MS, 300000);
  });
});
