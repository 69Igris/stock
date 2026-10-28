/**
 * security/rate-limit + encryption coverage push.
 *
 * Migrated (W0-α) from apps/web/__tests__/security/rate-limit-helpers.test.ts.
 * Import paths rewritten to the package sources (`../src/rate-limit`,
 * `../src/encryption`). Covers:
 *   - createRateLimitKey edge cases (empty parts, single part, falsy mixed)
 *   - checkRateLimit success + throw paths with retryAfter math
 *   - pre-configured limiter configs (api/auth/broker/sync) export shape
 *   - encryption extra-large-payload + unicode edge cases
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createRateLimitKey,
  createRateLimiter,
  checkRateLimit,
  apiRateLimiter,
  authRateLimiter,
  brokerRateLimiter,
  syncRateLimiter,
} from "../src/rate-limit";
import { SecureEncryption, generateEncryptionKey } from "../src/encryption";

describe("createRateLimitKey edge cases", () => {
  it("[key] single part returns the part", () => {
    assert.equal(createRateLimitKey("user-1"), "user-1");
  });

  it("[key] joins multiple parts with colon", () => {
    assert.equal(
      createRateLimitKey("api", "user-1", "ep-2"),
      "api:user-1:ep-2",
    );
  });

  it("[key] filters out empty / falsy parts", () => {
    assert.equal(createRateLimitKey("api", "", "user-1"), "api:user-1");
    // Test the filter(Boolean) behavior - empty strings dropped.
    assert.equal(
      createRateLimitKey("a", "", "b", "", "c"),
      "a:b:c",
      "empty strings must be filtered out",
    );
  });

  it("[key] no parts returns empty string", () => {
    assert.equal(createRateLimitKey(), "");
  });

  it("[key] all-empty parts returns empty string", () => {
    assert.equal(createRateLimitKey("", "", ""), "");
  });
});

describe("pre-configured limiter shapes", () => {
  it("[limiters] apiRateLimiter / authRateLimiter / brokerRateLimiter / syncRateLimiter all exported as functions/objects", () => {
    for (const [name, limiter] of [
      ["apiRateLimiter", apiRateLimiter],
      ["authRateLimiter", authRateLimiter],
      ["brokerRateLimiter", brokerRateLimiter],
      ["syncRateLimiter", syncRateLimiter],
    ] as const) {
      assert.ok(limiter, `${name} must be exported`);
      // Each limiter is an object with a check() method (returned by
      // createRateLimiter).
      assert.equal(
        typeof (limiter as { check: unknown }).check,
        "function",
        `${name}.check must be a function`,
      );
    }
  });

  it("[limiters] apiRateLimiter accepts a positive token + limit", async () => {
    // Smoke: check that the limiter actually runs without throwing.
    const result = await apiRateLimiter.check(100, "test-token-helpers");
    // The result shape is { success, remaining, reset }.
    assert.equal(typeof result.success, "boolean");
    assert.equal(typeof result.remaining, "number");
    assert.equal(typeof result.reset, "number");
  });
});

describe("checkRateLimit throw path", () => {
  it("[check] succeeds when under the limit", async () => {
    const limiter = createRateLimiter({
      interval: 60_000,
      uniqueTokenPerInterval: 1000,
    });
    await assert.doesNotReject(() =>
      checkRateLimit(limiter, 10, "fresh-token-helpers"),
    );
  });

  it("[check] throws RATE_LIMIT_EXCEEDED with retryAfter when over the limit", async () => {
    const limiter = createRateLimiter({
      interval: 60_000,
      uniqueTokenPerInterval: 1000,
    });
    // Hammer the limiter to exhaust the 2-token budget.
    const token = "exhausted-token-helpers";
    await checkRateLimit(limiter, 2, token);
    await checkRateLimit(limiter, 2, token);
    // Third call must throw.
    try {
      await checkRateLimit(limiter, 2, token);
      assert.fail("expected checkRateLimit to throw on exhaustion");
    } catch (err) {
      const e = err as Error & { code?: string; retryAfter?: number };
      assert.equal(e.code, "RATE_LIMIT_EXCEEDED");
      assert.equal(typeof e.retryAfter, "number");
      assert.ok(e.retryAfter! > 0, "retryAfter must be positive");
    }
  });

  it("[check] custom error message is preserved", async () => {
    const limiter = createRateLimiter({
      interval: 60_000,
      uniqueTokenPerInterval: 1000,
    });
    const token = "exhausted-custom-msg-helpers";
    await checkRateLimit(limiter, 1, token);
    try {
      await checkRateLimit(
        limiter,
        1,
        token,
        "Custom: too many requests - try in 1 minute",
      );
      assert.fail("expected throw");
    } catch (err) {
      const e = err as Error;
      assert.ok(
        e.message.includes("Custom: too many requests"),
        `unexpected error message: ${e.message}`,
      );
    }
  });
});

describe("encryption edge cases", () => {
  let enc: SecureEncryption;

  function getEnc(): SecureEncryption {
    if (!enc) {
      enc = new SecureEncryption(generateEncryptionKey());
    }
    return enc;
  }

  it("[encryption] empty object round-trips correctly", () => {
    const data = {};
    const e = getEnc().encrypt(data);
    const d = getEnc().decrypt(e.encrypted, e.iv, e.authTag);
    assert.deepStrictEqual(d, data);
  });

  it("[encryption] very large payload (5KB) round-trips", () => {
    const data = { blob: "x".repeat(5000) };
    const e = getEnc().encrypt(data);
    const d = getEnc().decrypt<typeof data>(e.encrypted, e.iv, e.authTag);
    assert.equal(d.blob.length, 5000);
  });

  it("[encryption] unicode + emoji + non-ASCII round-trips", () => {
    const data = { msg: "🚀 emoji + ₹1,234 + Hindi: नमस्ते + Chinese: 你好" };
    const e = getEnc().encrypt(data);
    const d = getEnc().decrypt<typeof data>(e.encrypted, e.iv, e.authTag);
    assert.equal(d.msg, data.msg);
  });

  it("[encryption] deeply nested object round-trips", () => {
    const data = {
      l1: { l2: { l3: { l4: { l5: "deep-value", n: 42 } } } },
    };
    const e = getEnc().encrypt(data);
    const d = getEnc().decrypt<typeof data>(e.encrypted, e.iv, e.authTag);
    assert.deepStrictEqual(d, data);
  });

  it("[encryption] secureCompare on equal-length strings", () => {
    const e = getEnc();
    assert.equal(e.secureCompare("abc123", "abc123"), true);
    assert.equal(e.secureCompare("abc123", "xyz456"), false);
  });

  it("[encryption] secureCompare on different-length strings (early-return)", () => {
    const e = getEnc();
    // Early-return path before timing-safe comparison.
    assert.equal(e.secureCompare("short", "longer"), false);
    assert.equal(e.secureCompare("", "x"), false);
  });

  it("[encryption] hash produces 64-char hex SHA-256", async () => {
    const e = getEnc();
    const h = await e.hash("any-input-helpers");
    assert.equal(h.length, 64);
    assert.ok(/^[a-f0-9]{64}$/.test(h));
  });
});
