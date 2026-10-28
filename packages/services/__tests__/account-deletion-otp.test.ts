/**
 * OTP + helper tests for account-deletion.service (MONEY-391).
 *
 * Uses the in-memory OTP store path (the service falls back to memory
 * when getRedisClient() returns null — i.e. REDIS_URL not set during tests).
 *
 * Source: packages/services/src/account-deletion.service.ts
 */

import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";

// Ensure Redis is disabled for these tests so the memory fallback path runs
before(() => {
  delete process.env.REDIS_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.KV_URL;
});

import {
  generateDeleteOtp,
  verifyDeleteOtp,
} from "../src/account-deletion.service";

describe("generateDeleteOtp", () => {
  afterEach(async () => {
    // Cleanup: burn any active OTPs for the test user IDs
    await verifyDeleteOtp("test-user-1", "000000").catch(() => {});
    await verifyDeleteOtp("test-user-2", "000000").catch(() => {});
  });

  it("returns a 6-digit OTP", async () => {
    const result = await generateDeleteOtp({
      userId: "test-user-1",
      email: "shaswat@example.com",
    });
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.match(result.data.otp, /^\d{6}$/);
  });

  it("returns a masked email", async () => {
    const result = await generateDeleteOtp({
      userId: "test-user-1",
      email: "shaswat@example.com",
    });
    assert.equal(result.success, true);
    if (!result.success) return;
    // s***t@example.com (first + last char + domain, middle masked)
    assert.match(result.data.result.maskedEmail, /^s\*+t@example\.com$/);
  });

  it("returns an expiry ~10 minutes in the future", async () => {
    const result = await generateDeleteOtp({
      userId: "test-user-1",
      email: "shaswat@example.com",
    });
    assert.equal(result.success, true);
    if (!result.success) return;
    const ms = result.data.result.expiresAt.getTime() - Date.now();
    // Should be between 9 and 11 minutes
    assert.ok(ms > 9 * 60 * 1000, `expected >9min, got ${ms}ms`);
    assert.ok(ms < 11 * 60 * 1000, `expected <11min, got ${ms}ms`);
  });

  it("rate-limits to 3 OTPs per hour per user", async () => {
    const input = { userId: "test-user-2", email: "test@example.com" };
    // First 3 succeed
    for (let i = 0; i < 3; i++) {
      const r = await generateDeleteOtp(input);
      assert.equal(r.success, true, `attempt ${i + 1} should succeed`);
    }
    // 4th should fail
    const fourth = await generateDeleteOtp(input);
    assert.equal(fourth.success, false);
    if (!fourth.success) {
      assert.match(fourth.error!, /Too many/i);
    }
  });
});

describe("verifyDeleteOtp", () => {
  it("rejects non-numeric OTPs without hitting storage", async () => {
    const result = await verifyDeleteOtp("any-user", "abcdef");
    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error!, /Invalid OTP format/);
    }
  });

  it("rejects OTPs of wrong length", async () => {
    const r1 = await verifyDeleteOtp("any-user", "12345");
    assert.equal(r1.success, false);
    const r2 = await verifyDeleteOtp("any-user", "1234567");
    assert.equal(r2.success, false);
  });

  it("rejects when no OTP has been generated", async () => {
    const result = await verifyDeleteOtp("never-requested-user", "123456");
    assert.equal(result.success, false);
    if (!result.success) {
      assert.match(result.error!, /not found|expired/i);
    }
  });

  it("rejects an incorrect OTP", async () => {
    const userId = "test-user-verify-wrong";
    const gen = await generateDeleteOtp({ userId, email: "v@example.com" });
    assert.equal(gen.success, true);
    if (!gen.success) return;
    const wrongCode = gen.data.otp === "000000" ? "111111" : "000000";
    const verify = await verifyDeleteOtp(userId, wrongCode);
    assert.equal(verify.success, false);
    if (!verify.success) {
      assert.match(verify.error!, /Incorrect|not found|expired/i);
    }
  });

  it("accepts the correct OTP and burns it on success", async () => {
    const userId = "test-user-verify-correct";
    const gen = await generateDeleteOtp({ userId, email: "v@example.com" });
    assert.equal(gen.success, true);
    if (!gen.success) return;

    const verify1 = await verifyDeleteOtp(userId, gen.data.otp);
    assert.equal(verify1.success, true);

    // Replay attack — same OTP should now be gone
    const verify2 = await verifyDeleteOtp(userId, gen.data.otp);
    assert.equal(verify2.success, false);
  });

  it("locks out after 5 failed attempts", async () => {
    const userId = "test-user-lockout";
    const gen = await generateDeleteOtp({ userId, email: "v@example.com" });
    assert.equal(gen.success, true);
    if (!gen.success) return;
    const wrong = gen.data.otp === "000000" ? "111111" : "000000";

    // 5 bad attempts
    for (let i = 0; i < 5; i++) {
      await verifyDeleteOtp(userId, wrong);
    }
    // 6th — should be locked out, not just "incorrect"
    const sixth = await verifyDeleteOtp(userId, wrong);
    assert.equal(sixth.success, false);
    if (!sixth.success) {
      assert.match(sixth.error!, /Too many|failed/i);
    }

    // And the OTP is burned — even the correct one no longer works
    const correctAfterLockout = await verifyDeleteOtp(userId, gen.data.otp);
    assert.equal(correctAfterLockout.success, false);
  });
});
