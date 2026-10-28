/**
 * Broker OAuth callback CONTRACT test.
 *
 * Exercises the REAL exported helpers from `@/lib/brokers/oauth-callback` that
 * the per-broker callback routes (`app/api/brokers/<x>/callback/route.ts`) use —
 * NOT inline copies. Pins each broker's callback wire contract: which query
 * param carries the auth code, how cancellation is detected, the CSRF-state
 * round-trip, and the exact success / cancel / failure redirect URLs.
 *
 * (Replaces the previous shadow version, which reimplemented `extractOAuthCode`
 * / `detectOAuthError` / `resolveRedirect` inline and asserted the copies.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BrokerType } from "@usemoney/types";
import {
  BROKER_CALLBACK_CONFIG,
  getBrokerCallbackCode,
  parseBrokerCallback,
  resolveCallbackBaseUrl,
  brokerCancelRedirect,
  brokerSuccessRedirect,
  brokerFailureRedirect,
} from "@/lib/brokers/oauth-callback";

const sp = (entries: Record<string, string>) => new URLSearchParams(entries);
const BASE = "https://usemoney.ai";

describe("Broker OAuth callback contract", () => {
  describe("auth-code param per broker", () => {
    const cases: Array<[BrokerType, string, string]> = [
      ["ZERODHA", "request_token", "rt_123"],
      ["UPSTOX", "code", "code_123"],
      ["FYERS", "auth_code", "ac_123"],
      ["ANGEL_ONE", "auth_token", "jwt_123"],
      ["INTERACTIVE_BROKERS", "code", "ibkr_123"],
    ];
    for (const [broker, param, val] of cases) {
      it(`${broker} reads the code from ?${param}=`, () => {
        assert.equal(getBrokerCallbackCode(broker, sp({ [param]: val })), val);
      });
      it(`${broker} returns null when ${param} is absent`, () => {
        assert.equal(getBrokerCallbackCode(broker, sp({})), null);
      });
    }

    it("ICICI falls back apiSession → session_token → code", () => {
      assert.equal(
        getBrokerCallbackCode("ICICI", sp({ apiSession: "a" })),
        "a"
      );
      assert.equal(
        getBrokerCallbackCode("ICICI", sp({ session_token: "s" })),
        "s"
      );
      assert.equal(getBrokerCallbackCode("ICICI", sp({ code: "c" })), "c");
      // priority: apiSession wins over later params
      assert.equal(
        getBrokerCallbackCode("ICICI", sp({ session_token: "s", code: "c" })),
        "s"
      );
    });

    it("HDFC falls back request_token → code", () => {
      assert.equal(
        getBrokerCallbackCode("HDFC", sp({ request_token: "rt" })),
        "rt"
      );
      assert.equal(getBrokerCallbackCode("HDFC", sp({ code: "c" })), "c");
    });
  });

  describe("cancellation detection", () => {
    it("ZERODHA cancels on status=cancelled (not an error param)", () => {
      const p = parseBrokerCallback(
        "ZERODHA",
        sp({ status: "cancelled", request_token: "rt" })
      );
      assert.equal(p.cancelled, true);
    });

    it("ZERODHA is NOT cancelled by a stray error param when code present", () => {
      const p = parseBrokerCallback(
        "ZERODHA",
        sp({ error: "x", request_token: "rt", status: "success" })
      );
      assert.equal(p.cancelled, false);
    });

    it("error-param brokers cancel on ?error=", () => {
      assert.equal(
        parseBrokerCallback("UPSTOX", sp({ error: "access_denied" })).cancelled,
        true
      );
      assert.equal(
        parseBrokerCallback("FYERS", sp({ error: "denied", auth_code: "x" }))
          .cancelled,
        true
      );
    });

    it("missing code is always cancellation", () => {
      assert.equal(parseBrokerCallback("UPSTOX", sp({})).cancelled, true);
      assert.equal(parseBrokerCallback("ZERODHA", sp({})).cancelled, true);
    });

    it("round-trips the CSRF state", () => {
      assert.equal(
        parseBrokerCallback("UPSTOX", sp({ code: "c", state: "csrf_abc" }))
          .state,
        "csrf_abc"
      );
      assert.equal(
        parseBrokerCallback("UPSTOX", sp({ code: "c" })).state,
        undefined
      );
    });
  });

  describe("redirect URLs", () => {
    it("resolveCallbackBaseUrl prefers origin, then env, then localhost", () => {
      assert.equal(resolveCallbackBaseUrl("https://x.ai"), "https://x.ai");
      const saved = process.env.NEXT_PUBLIC_BASE_URL;
      delete process.env.NEXT_PUBLIC_BASE_URL;
      assert.equal(resolveCallbackBaseUrl(null), "http://localhost:3000");
      if (saved !== undefined) process.env.NEXT_PUBLIC_BASE_URL = saved;
    });

    it("success redirect uses the broker slug (hyphenated, not toLowerCase)", () => {
      assert.equal(
        brokerSuccessRedirect("ANGEL_ONE", BASE),
        `${BASE}/brokers?success=connected&broker=angel-one`
      );
      assert.equal(
        brokerSuccessRedirect("INTERACTIVE_BROKERS", BASE),
        `${BASE}/brokers?success=connected&broker=interactive-brokers`
      );
      assert.equal(
        brokerSuccessRedirect("ZERODHA", BASE),
        `${BASE}/brokers?success=connected&broker=zerodha`
      );
    });

    it("cancel redirect: generic brokers → auth_cancelled (ignore error param)", () => {
      assert.equal(
        brokerCancelRedirect("ZERODHA", BASE, "some_error"),
        `${BASE}/brokers?error=auth_cancelled`
      );
      assert.equal(
        brokerCancelRedirect("UPSTOX", BASE, "access_denied"),
        `${BASE}/brokers?error=auth_cancelled`
      );
    });

    it("cancel redirect: Angel/ICICI/HDFC surface the broker error param", () => {
      assert.equal(
        brokerCancelRedirect("ANGEL_ONE", BASE, "user_denied"),
        `${BASE}/brokers?error=user_denied`
      );
      assert.equal(
        brokerCancelRedirect("ICICI", BASE, null),
        `${BASE}/brokers?error=auth_cancelled`
      );
    });

    it("failure redirect uses the broker-specific fallback when action has no message", () => {
      assert.equal(
        brokerFailureRedirect("ANGEL_ONE", BASE, null),
        `${BASE}/brokers?error=${encodeURIComponent("Failed to connect Angel One. Please try again.")}`
      );
      assert.equal(
        brokerFailureRedirect("ZERODHA", BASE, null),
        `${BASE}/brokers?error=auth_failed`
      );
    });

    it("failure redirect surfaces & URL-encodes the action's error message", () => {
      assert.equal(
        brokerFailureRedirect("UPSTOX", BASE, "token expired & invalid"),
        `${BASE}/brokers?error=${encodeURIComponent("token expired & invalid")}`
      );
    });
  });

  describe("config integrity", () => {
    it("every wired callback route has a complete config entry", () => {
      const wired: BrokerType[] = [
        "ZERODHA",
        "UPSTOX",
        "FYERS",
        "ANGEL_ONE",
        "ICICI",
        "HDFC",
        "INTERACTIVE_BROKERS",
      ];
      for (const b of wired) {
        const cfg = BROKER_CALLBACK_CONFIG[b];
        assert.ok(cfg, `missing config for ${b}`);
        assert.ok(cfg.codeParams.length > 0, `${b} has no code params`);
        assert.ok(cfg.slug.length > 0, `${b} has no slug`);
        assert.ok(cfg.errorFallback.length > 0, `${b} has no error fallback`);
      }
    });
  });
});
