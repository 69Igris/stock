/**
 * Email Unsubscribe Token Tests — REAL source (packages/email/src/tokens.ts via
 * `@usemoney/email`).
 *
 * De-shadowed (MONEY-620): the previous file re-implemented
 * `generateUnsubscribeToken` / `verifyUnsubscribeToken` INLINE with a
 * test-only `secret` parameter and asserted those copies. The REAL functions
 * take NO secret argument — they read `EMAIL_UNSUBSCRIBE_SECRET` from env via
 * `packages/email/src/constants.ts` (resolved once at module load). So this
 * sets the env var in a `before()` hook and `await import`s the module AFTER,
 * then drives the genuine HMAC-SHA256 + `timingSafeEqual` implementation.
 *
 * The shadow's "different secret → different token" and "empty secret" cases
 * relied on swapping the secret per-call; that is not a capability of the real
 * API (the secret is process-global). They are re-expressed against the single
 * configured secret: deterministic generation, case/whitespace normalization,
 * and full tamper rejection — the security-relevant guarantees of the source.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

const TEST_SECRET = "test-secret-key-for-hmac-testing-12345";

let generateUnsubscribeToken: (email: string) => string;
let verifyUnsubscribeToken: (email: string, token: string) => boolean;

before(async () => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = TEST_SECRET;
  const mod = await import("@usemoney/email");
  generateUnsubscribeToken = mod.generateUnsubscribeToken;
  verifyUnsubscribeToken = mod.verifyUnsubscribeToken;
});

describe("Unsubscribe Token Generation (real)", () => {
  it("should generate a 64-char hex string token", () => {
    const token = generateUnsubscribeToken("user@example.com");
    assert.match(token, /^[a-f0-9]{64}$/);
  });

  it("should generate deterministic tokens for the same email", () => {
    const token1 = generateUnsubscribeToken("user@example.com");
    const token2 = generateUnsubscribeToken("user@example.com");
    assert.strictEqual(token1, token2);
  });

  it("should generate different tokens for different emails", () => {
    const token1 = generateUnsubscribeToken("user1@example.com");
    const token2 = generateUnsubscribeToken("user2@example.com");
    assert.notStrictEqual(token1, token2);
  });

  it("should be case-insensitive for email addresses", () => {
    const token1 = generateUnsubscribeToken("User@Example.COM");
    const token2 = generateUnsubscribeToken("user@example.com");
    assert.strictEqual(token1, token2);
  });

  it("should trim whitespace from email addresses", () => {
    const token1 = generateUnsubscribeToken("  user@example.com  ");
    const token2 = generateUnsubscribeToken("user@example.com");
    assert.strictEqual(token1, token2);
  });

  it("should handle mixed case and whitespace", () => {
    const token1 = generateUnsubscribeToken("  USER@Example.Com  ");
    const token2 = generateUnsubscribeToken("user@example.com");
    assert.strictEqual(token1, token2);
  });
});

describe("Unsubscribe Token Verification (real)", () => {
  it("should verify a valid token", () => {
    const email = "user@example.com";
    const token = generateUnsubscribeToken(email);
    assert.strictEqual(verifyUnsubscribeToken(email, token), true);
  });

  it("should reject an invalid token", () => {
    const email = "user@example.com";
    const fakeToken = "a".repeat(64);
    assert.strictEqual(verifyUnsubscribeToken(email, fakeToken), false);
  });

  it("should reject a token for a different email", () => {
    const token = generateUnsubscribeToken("user1@example.com");
    assert.strictEqual(
      verifyUnsubscribeToken("user2@example.com", token),
      false
    );
  });

  it("should verify case-insensitively", () => {
    const token = generateUnsubscribeToken("user@example.com");
    assert.strictEqual(verifyUnsubscribeToken("USER@EXAMPLE.COM", token), true);
  });

  it("should verify with trimmed whitespace", () => {
    const token = generateUnsubscribeToken("user@example.com");
    assert.strictEqual(
      verifyUnsubscribeToken("  user@example.com  ", token),
      true
    );
  });

  it("should reject a truncated token", () => {
    const token = generateUnsubscribeToken("user@example.com");
    const truncated = token.substring(0, 32);
    assert.strictEqual(
      verifyUnsubscribeToken("user@example.com", truncated),
      false
    );
  });

  it("should reject a token with extra characters appended", () => {
    const token = generateUnsubscribeToken("user@example.com");
    const extended = token + "abcd";
    assert.strictEqual(
      verifyUnsubscribeToken("user@example.com", extended),
      false
    );
  });

  it("should reject non-hex string tokens", () => {
    assert.strictEqual(
      verifyUnsubscribeToken("user@example.com", "not-a-hex-token"),
      false
    );
  });

  it("should reject empty token", () => {
    assert.strictEqual(verifyUnsubscribeToken("user@example.com", ""), false);
  });

  it("should reject a single-bit tampered token (timing-safe compare)", () => {
    const email = "user@example.com";
    const token = generateUnsubscribeToken(email);
    // Flip one hex character
    const chars = token.split("");
    chars[0] = chars[0] === "a" ? "b" : "a";
    const tampered = chars.join("");
    assert.strictEqual(verifyUnsubscribeToken(email, tampered), false);
  });
});
