/**
 * Demo API Route - REAL logic tests.
 *
 * Asserts the ACTUAL helpers the demo `start` / `end` route handlers call
 * (from `@/app/api/demo/route-logic`):
 *
 *   - extractDemoIp                  — x-forwarded-for → x-real-ip → "unknown"
 *   - demoSessionCookieAttributes    — the `sb_demo` cookie set on session mint
 *   - demoClearCookieAttributes      — the maxAge-0 cookie that clears it
 *   - DEMO_COOKIE_MAX_AGE            — 24h TTL constant
 *
 * plus the real `COOKIE_NAME` from `@/lib/demo/session`.
 *
 * (Replaces the previous SHADOW version, which reimplemented extractIp, the
 * cookie attributes, AND a fictional `checkRateLimit` inline. The real route's
 * rate-limit / PostHog / 500 branches are exercised end-to-end by
 * demo-start.test.ts, demo-end.test.ts and demo-routes-branches.test.ts —
 * which import the actual POST handlers and the real `createRateLimiter`.)
 *
 * Source: apps/web/app/api/demo/start/route.ts
 *         apps/web/app/api/demo/end/route.ts
 *         apps/web/app/api/demo/route-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractDemoIp,
  demoSessionCookieAttributes,
  demoClearCookieAttributes,
  DEMO_COOKIE_MAX_AGE,
} from "@/app/api/demo/route-logic";
import { COOKIE_NAME } from "@/lib/demo/session";

/** Adapt a header bag into the `(name) => value` getter the routes pass. */
function headerGetter(
  headers: Record<string, string | undefined>
): (name: string) => string | null | undefined {
  return (name) => headers[name];
}

describe("Demo API Routes", () => {
  // ── IP Extraction ────────────────────────────────────────────

  describe("extractDemoIp", () => {
    it("extracts IP from x-forwarded-for header", () => {
      const ip = extractDemoIp(
        headerGetter({ "x-forwarded-for": "192.168.1.1" })
      );
      assert.strictEqual(ip, "192.168.1.1");
    });

    it("takes the first IP from a comma-separated x-forwarded-for", () => {
      const ip = extractDemoIp(
        headerGetter({
          "x-forwarded-for": "10.0.0.1, 172.16.0.1, 192.168.1.1",
        })
      );
      assert.strictEqual(ip, "10.0.0.1");
    });

    it("trims whitespace from x-forwarded-for", () => {
      const ip = extractDemoIp(
        headerGetter({ "x-forwarded-for": "  10.0.0.1  " })
      );
      assert.strictEqual(ip, "10.0.0.1");
    });

    it("falls back to x-real-ip", () => {
      const ip = extractDemoIp(headerGetter({ "x-real-ip": "172.16.0.1" }));
      assert.strictEqual(ip, "172.16.0.1");
    });

    it("prefers x-forwarded-for over x-real-ip", () => {
      const ip = extractDemoIp(
        headerGetter({
          "x-forwarded-for": "10.0.0.1",
          "x-real-ip": "172.16.0.1",
        })
      );
      assert.strictEqual(ip, "10.0.0.1");
    });

    it("returns 'unknown' when no IP headers are present", () => {
      const ip = extractDemoIp(headerGetter({}));
      assert.strictEqual(ip, "unknown");
    });

    it("handles IPv6 in x-forwarded-for", () => {
      const ip = extractDemoIp(headerGetter({ "x-forwarded-for": "::1" }));
      assert.strictEqual(ip, "::1");
    });

    it("handles undefined x-forwarded-for gracefully", () => {
      const ip = extractDemoIp(headerGetter({ "x-forwarded-for": undefined }));
      assert.strictEqual(ip, "unknown");
    });
  });

  // ── Cookie Attributes (Start Route) ──────────────────────────

  describe("demoSessionCookieAttributes (start route)", () => {
    it("sets httpOnly to true", () => {
      assert.strictEqual(demoSessionCookieAttributes(true).httpOnly, true);
    });

    it("sets secure to true in production", () => {
      assert.strictEqual(demoSessionCookieAttributes(true).secure, true);
    });

    it("sets secure to false in development", () => {
      assert.strictEqual(demoSessionCookieAttributes(false).secure, false);
    });

    it("sets sameSite to lax", () => {
      assert.strictEqual(demoSessionCookieAttributes(true).sameSite, "lax");
    });

    it("sets maxAge to 86400 (24 hours)", () => {
      assert.strictEqual(demoSessionCookieAttributes(true).maxAge, 86400);
      assert.strictEqual(DEMO_COOKIE_MAX_AGE, 86400);
    });

    it("sets path to /", () => {
      assert.strictEqual(demoSessionCookieAttributes(true).path, "/");
    });

    it("the session cookie name is sb_demo", () => {
      assert.strictEqual(COOKIE_NAME, "sb_demo");
    });
  });

  // ── Cookie Attributes (End Route) ────────────────────────────

  describe("demoClearCookieAttributes (end route)", () => {
    it("sets httpOnly to true", () => {
      assert.strictEqual(demoClearCookieAttributes(true).httpOnly, true);
    });

    it("sets maxAge to 0 (clears the cookie)", () => {
      assert.strictEqual(demoClearCookieAttributes(true).maxAge, 0);
    });

    it("sets sameSite to lax", () => {
      assert.strictEqual(demoClearCookieAttributes(true).sameSite, "lax");
    });

    it("sets secure to true in production", () => {
      assert.strictEqual(demoClearCookieAttributes(true).secure, true);
    });

    it("sets secure to false in development", () => {
      assert.strictEqual(demoClearCookieAttributes(false).secure, false);
    });

    it("sets path to /", () => {
      assert.strictEqual(demoClearCookieAttributes(true).path, "/");
    });
  });

  // ── Cookie Security properties ───────────────────────────────

  describe("Cookie security properties", () => {
    it("httpOnly prevents JavaScript access (XSS protection)", () => {
      assert.strictEqual(demoSessionCookieAttributes(true).httpOnly, true);
    });

    it("secure flag ensures HTTPS-only in production", () => {
      assert.strictEqual(demoSessionCookieAttributes(true).secure, true);
    });

    it("sameSite=lax provides CSRF protection", () => {
      assert.strictEqual(demoSessionCookieAttributes(true).sameSite, "lax");
    });

    it("maxAge matches the token TTL (86400s = 24h)", () => {
      assert.strictEqual(
        demoSessionCookieAttributes(true).maxAge * 1000,
        24 * 60 * 60 * 1000
      );
    });

    it("path=/ ensures the cookie is sent for all routes", () => {
      assert.strictEqual(demoSessionCookieAttributes(true).path, "/");
    });
  });
});
