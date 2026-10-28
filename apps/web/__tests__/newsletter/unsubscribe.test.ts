/**
 * Newsletter Unsubscribe Tests — REAL source.
 *
 * De-shadowed (MONEY-620): the previous file re-implemented the HMAC token
 * generate/verify, the status→message decision, and the confirmation HTML page
 * INLINE and asserted those copies.
 *
 * Now:
 *   - `verifyUnsubscribeToken` (and `generateUnsubscribeToken` for the
 *     round-trip) come from the REAL `@usemoney/email` (HMAC-SHA256 +
 *     timing-safe compare; secret from env, set in `before()` before import).
 *   - `unsubscribePageHtml` + `determineUnsubscribeOutcome` are the REAL
 *     exports extracted into
 *     `app/api/newsletter/unsubscribe/route-logic.ts`, which the route now
 *     imports — so the page markup and the 404 / already-unsubscribed / success
 *     decision asserted here ARE the production code path (no dead exports).
 *
 * Param validation + URL construction use stdlib (`URL`, `encodeURIComponent`)
 * and are kept as end-to-end glue exercised against the real token + real page.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  unsubscribePageHtml,
  determineUnsubscribeOutcome,
} from "@/app/api/newsletter/unsubscribe/route-logic";

const TEST_SECRET = "test-secret-key-for-unsubscribe-testing";

let generateUnsubscribeToken: (email: string) => string;
let verifyUnsubscribeToken: (email: string, token: string) => boolean;

before(async () => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = TEST_SECRET;
  const mod = await import("@usemoney/email");
  generateUnsubscribeToken = mod.generateUnsubscribeToken;
  verifyUnsubscribeToken = mod.verifyUnsubscribeToken;
});

/** The route builds this URL shape; assert against the real token. */
function buildUnsubscribeUrl(
  appUrl: string,
  email: string,
  token: string
): string {
  return `${appUrl}/api/newsletter/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
}

describe("Unsubscribe URL Construction (real token)", () => {
  it("should build a parseable unsubscribe URL", () => {
    const email = "user@example.com";
    const token = generateUnsubscribeToken(email);
    const url = buildUnsubscribeUrl("https://usemoney.ai", email, token);
    assert.ok(
      url.startsWith("https://usemoney.ai/api/newsletter/unsubscribe?")
    );
    assert.ok(url.includes("email=user%40example.com"));
    assert.ok(url.includes(`token=${token}`));

    const parsed = new URL(url);
    assert.strictEqual(parsed.searchParams.get("email"), email);
    assert.strictEqual(parsed.searchParams.get("token"), token);
  });

  it("should properly encode email with special characters", () => {
    const email = "user+tag@example.com";
    const token = generateUnsubscribeToken(email);
    const url = buildUnsubscribeUrl("https://usemoney.ai", email, token);
    assert.ok(url.includes(encodeURIComponent(email)));
  });
});

describe("Unsubscribe Token Verification Flow (real)", () => {
  it("should verify a token generated for the same email", () => {
    const email = "user@example.com";
    const token = generateUnsubscribeToken(email);
    assert.strictEqual(verifyUnsubscribeToken(email, token), true);
  });

  it("should reject a token generated for a different email (tampered email)", () => {
    const token = generateUnsubscribeToken("other@example.com");
    assert.strictEqual(
      verifyUnsubscribeToken("user@example.com", token),
      false
    );
  });

  it("should verify case-insensitively (URL email may differ from stored)", () => {
    const token = generateUnsubscribeToken("user@example.com");
    assert.strictEqual(verifyUnsubscribeToken("USER@EXAMPLE.COM", token), true);
  });

  it("should reject a completely fabricated token", () => {
    assert.strictEqual(
      verifyUnsubscribeToken("user@example.com", "f".repeat(64)),
      false
    );
  });

  it("should reject a single-character tampered token", () => {
    const email = "user@example.com";
    const realToken = generateUnsubscribeToken(email);
    const tamperedToken =
      realToken.substring(0, 62) +
      (realToken[62] === "a" ? "b" : "a") +
      realToken[63];
    assert.strictEqual(verifyUnsubscribeToken(email, tamperedToken), false);
  });
});

describe("determineUnsubscribeOutcome (real route-logic)", () => {
  it("should return 404 for a non-existing subscriber", () => {
    const result = determineUnsubscribeOutcome(false, null);
    assert.strictEqual(result.status, 404);
    assert.ok(result.message.includes("not found"));
  });

  it("should return success for an ACTIVE subscriber", () => {
    const result = determineUnsubscribeOutcome(true, "ACTIVE");
    assert.strictEqual(result.status, 200);
    assert.ok(result.message.includes("successfully unsubscribed"));
  });

  it("should return success for a PENDING subscriber", () => {
    const result = determineUnsubscribeOutcome(true, "PENDING");
    assert.strictEqual(result.status, 200);
    assert.ok(result.message.includes("successfully unsubscribed"));
  });

  it("should return already-unsubscribed (idempotent) for UNSUBSCRIBED", () => {
    const result = determineUnsubscribeOutcome(true, "UNSUBSCRIBED");
    assert.strictEqual(result.status, 200);
    assert.ok(result.message.includes("already been unsubscribed"));
  });
});

describe("unsubscribePageHtml (real route-logic)", () => {
  it("should contain the message", () => {
    const html = unsubscribePageHtml("Test message here");
    assert.ok(html.includes("Test message here"));
  });

  it("should be valid HTML with DOCTYPE", () => {
    const html = unsubscribePageHtml("test");
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("</html>"));
  });

  it("should contain UseMoney branding and a link back", () => {
    const html = unsubscribePageHtml("test");
    assert.ok(html.includes("UseMoney Newsletter"));
    assert.ok(html.includes('href="https://usemoney.ai"'));
    assert.ok(html.includes("Back to UseMoney"));
  });

  it("should contain proper meta tags and title", () => {
    const html = unsubscribePageHtml("test");
    assert.ok(html.includes('charset="utf-8"'));
    assert.ok(html.includes("viewport"));
    assert.ok(html.includes("<title>Unsubscribe - UseMoney</title>"));
  });
});

describe("End-to-End Unsubscribe Flow (real token + real decision + real page)", () => {
  it("generates a token, builds + parses the URL, verifies, and renders the success page", () => {
    const email = "newsletter-reader@example.com";
    const token = generateUnsubscribeToken(email);
    const url = buildUnsubscribeUrl("https://usemoney.ai", email, token);

    // Parse the URL as the server route does.
    const parsed = new URL(url);
    const parsedEmail = parsed.searchParams.get("email")!;
    const parsedToken = parsed.searchParams.get("token")!;
    assert.ok(parsedEmail && parsedToken);

    // Verify the HMAC token (real).
    assert.strictEqual(verifyUnsubscribeToken(parsedEmail, parsedToken), true);

    // Decide + render (real).
    const outcome = determineUnsubscribeOutcome(true, "ACTIVE");
    assert.strictEqual(outcome.status, 200);
    const page = unsubscribePageHtml(outcome.message);
    assert.ok(page.includes("successfully unsubscribed"));
  });

  it("rejects a tampered email in the URL against the original token", () => {
    const email = "real@example.com";
    const token = generateUnsubscribeToken(email);
    assert.strictEqual(
      verifyUnsubscribeToken("attacker@example.com", token),
      false
    );
  });
});
