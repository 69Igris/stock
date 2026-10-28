/**
 * Newsletter subscribe route CONTRACT test.
 *
 * Exercises the REAL exported symbols the POST /api/newsletter/subscribe
 * handler calls (from `@/app/api/newsletter/subscribe/route-logic`):
 *   - `SubscribeSchema` — the Zod email/name body schema (real validation +
 *     real error message).
 *   - `normalizeEmail` — lowercase used for the unique lookup.
 *   - `handleExistingSubscriber` — ACTIVE/PENDING short-circuit, UNSUBSCRIBED
 *     → null (re-subscribe).
 *   - `buildVerifyUrl` / `getAppUrl` — the verification link + default origin.
 *   - `parseIpFromHeader` — rate-limit key from x-forwarded-for.
 *   - `newsletterSuccessMessage` — the success body text.
 *
 * (Replaces the previous shadow version, which reimplemented `validateEmail`
 * / `handleExistingSubscriber` / `buildVerifyUrl` / `getAppUrl` /
 * `parseIpFromHeader` inline and asserted the copies.)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  SubscribeSchema,
  normalizeEmail,
  handleExistingSubscriber,
  buildVerifyUrl,
  getAppUrl,
  parseIpFromHeader,
  newsletterSuccessMessage,
} from "@/app/api/newsletter/subscribe/route-logic";

describe("Newsletter subscribe route", () => {
  let savedAppUrl: string | undefined;

  beforeEach(() => {
    savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  });

  afterEach(() => {
    if (savedAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
    }
  });

  describe("SubscribeSchema (Zod) - email validation", () => {
    it("accepts a valid email", () => {
      const parsed = SubscribeSchema.safeParse({ email: "user@example.com" });
      assert.strictEqual(parsed.success, true);
    });

    it("accepts an email with a subdomain", () => {
      const parsed = SubscribeSchema.safeParse({
        email: "user@mail.example.com",
      });
      assert.strictEqual(parsed.success, true);
    });

    it("accepts an optional name", () => {
      const parsed = SubscribeSchema.safeParse({
        email: "user@example.com",
        name: "Jane",
      });
      assert.strictEqual(parsed.success, true);
      assert.strictEqual(parsed.success && parsed.data.name, "Jane");
    });

    it("rejects an email without @ with the expected message", () => {
      const parsed = SubscribeSchema.safeParse({ email: "userexample.com" });
      assert.strictEqual(parsed.success, false);
      assert.strictEqual(
        !parsed.success && parsed.error.issues[0]?.message,
        "Please enter a valid email address"
      );
    });

    it("rejects an email without a domain", () => {
      const parsed = SubscribeSchema.safeParse({ email: "user@" });
      assert.strictEqual(parsed.success, false);
    });

    it("rejects an empty string", () => {
      const parsed = SubscribeSchema.safeParse({ email: "" });
      assert.strictEqual(parsed.success, false);
    });

    it("rejects a missing email field", () => {
      const parsed = SubscribeSchema.safeParse({ name: "Jane" });
      assert.strictEqual(parsed.success, false);
    });
  });

  describe("normalizeEmail", () => {
    it("lowercases the email", () => {
      assert.strictEqual(
        normalizeEmail("User@Example.COM"),
        "user@example.com"
      );
    });

    it("leaves an already-lowercase email unchanged", () => {
      assert.strictEqual(
        normalizeEmail("user@example.com"),
        "user@example.com"
      );
    });
  });

  describe("handleExistingSubscriber", () => {
    it("returns 'already subscribed' for ACTIVE", () => {
      const result = handleExistingSubscriber("ACTIVE");
      assert.ok(result);
      assert.strictEqual(result.message, "You're already subscribed!");
      assert.strictEqual(result.status, 200);
    });

    it("returns 'verification already sent' for PENDING", () => {
      const result = handleExistingSubscriber("PENDING");
      assert.ok(result);
      assert.ok(result.message.includes("verification email was already sent"));
      assert.strictEqual(result.status, 200);
    });

    it("returns null for UNSUBSCRIBED (route re-subscribes)", () => {
      assert.strictEqual(handleExistingSubscriber("UNSUBSCRIBED"), null);
    });
  });

  describe("buildVerifyUrl", () => {
    it("builds the verify URL with token query param", () => {
      assert.strictEqual(
        buildVerifyUrl("https://usemoney.ai", "abc123token"),
        "https://usemoney.ai/api/newsletter/verify?token=abc123token"
      );
    });

    it("composes with getAppUrl", () => {
      process.env.NEXT_PUBLIC_APP_URL = "https://dev.usemoney.ai";
      assert.strictEqual(
        buildVerifyUrl(getAppUrl(), "tok"),
        "https://dev.usemoney.ai/api/newsletter/verify?token=tok"
      );
    });
  });

  describe("getAppUrl", () => {
    it("falls back to the prod host when unset", () => {
      delete process.env.NEXT_PUBLIC_APP_URL;
      assert.strictEqual(getAppUrl(), "https://usemoney.ai");
    });

    it("uses the env value when set", () => {
      process.env.NEXT_PUBLIC_APP_URL = "https://dev.usemoney.ai";
      assert.strictEqual(getAppUrl(), "https://dev.usemoney.ai");
    });
  });

  describe("parseIpFromHeader", () => {
    it("extracts the first IP from a comma-separated list", () => {
      assert.strictEqual(parseIpFromHeader("1.2.3.4, 5.6.7.8"), "1.2.3.4");
    });

    it("handles a single IP", () => {
      assert.strictEqual(parseIpFromHeader("1.2.3.4"), "1.2.3.4");
    });

    it("returns 'anonymous' for a null header", () => {
      assert.strictEqual(parseIpFromHeader(null), "anonymous");
    });

    it("returns 'anonymous' for an empty header", () => {
      assert.strictEqual(parseIpFromHeader(""), "anonymous");
    });
  });

  describe("newsletterSuccessMessage", () => {
    it("returns the verify-your-subscription prompt", () => {
      assert.ok(newsletterSuccessMessage().includes("check your email"));
    });
  });
});
