/**
 * Broker OAuth login-URL CSRF-state CONTRACT test (MONEY-619 follow-up).
 *
 * Exercises the REAL exported `buildBrokerOAuthUrl()` — NOT a shadow copy — so a
 * regression in how any broker carries the CSRF `state` is caught here instead
 * of in production. This is the test that would have caught the Zerodha
 * "Authentication failed (security state missing)" outage: Kite silently drops
 * a bare `&state=` and only echoes values passed via `redirect_params`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildBrokerOAuthUrl } from "@/lib/brokers/oauth-url";

const STATE = "deadbeef".repeat(8); // 64-char hex-like CSRF state
const baseOpts = {
  apiKey: "test_api_key",
  redirectUri: "https://usemoney.ai/api/brokers/x/callback",
  csrfState: STATE as string | null,
  fallbackState: "user_internal_id_123",
  angelApiKey: "angel_publisher_key",
};

describe("Broker OAuth login-URL CSRF-state contract", () => {
  describe("ZERODHA (Kite) — state MUST ride on redirect_params", () => {
    it("carries the state via redirect_params=state=<value>", () => {
      const r = buildBrokerOAuthUrl("ZERODHA", baseOpts);
      assert.equal(r.success, true);
      if (!r.success) return;
      assert.ok(
        r.url.includes(
          `redirect_params=${encodeURIComponent(`state=${STATE}`)}`
        ),
        `expected redirect_params=state=… in: ${r.url}`
      );
    });

    it("REGRESSION GUARD: never relies on a bare &state= (Kite drops it)", () => {
      const r = buildBrokerOAuthUrl("ZERODHA", baseOpts);
      assert.equal(r.success, true);
      if (!r.success) return;
      // The exact failure mode of the outage: a `?state=`/`&state=` query param
      // that Kite discards. The state must travel inside redirect_params (state%3D).
      assert.doesNotMatch(r.url, /[?&]state=/);
    });

    it("omits redirect_params when csrfState is null (Redis down)", () => {
      const r = buildBrokerOAuthUrl("ZERODHA", {
        ...baseOpts,
        csrfState: null,
      });
      assert.equal(r.success, true);
      if (!r.success) return;
      assert.doesNotMatch(r.url, /redirect_params/);
    });
  });

  describe("Standard-OAuth brokers — state echoed as a state= query param", () => {
    for (const broker of [
      "UPSTOX",
      "ICICI",
      "HDFC",
      "INTERACTIVE_BROKERS",
    ] as const) {
      it(`${broker} carries the state as state=<value>`, () => {
        const r = buildBrokerOAuthUrl(broker, baseOpts);
        assert.equal(r.success, true);
        if (!r.success) return;
        assert.ok(
          r.url.includes(`state=${encodeURIComponent(STATE)}`),
          `expected state=… in: ${r.url}`
        );
      });
    }
  });

  describe("FYERS — state embedded via the client helper", () => {
    it("includes the csrf state in the URL", () => {
      const r = buildBrokerOAuthUrl("FYERS", baseOpts);
      assert.equal(r.success, true);
      if (!r.success) return;
      assert.ok(r.url.includes(STATE), `expected state in: ${r.url}`);
    });

    it("falls back to fallbackState (user id) when csrfState is null", () => {
      const r = buildBrokerOAuthUrl("FYERS", { ...baseOpts, csrfState: null });
      assert.equal(r.success, true);
      if (!r.success) return;
      assert.ok(r.url.includes("user_internal_id_123"));
    });
  });

  describe("ANGEL_ONE — publisher-login redirect", () => {
    it("uses the publisher-login endpoint and carries the state", () => {
      const r = buildBrokerOAuthUrl("ANGEL_ONE", baseOpts);
      assert.equal(r.success, true);
      if (!r.success) return;
      assert.ok(
        r.url.startsWith("https://smartapi.angelone.in/publisher-login"),
        `expected publisher-login URL, got: ${r.url}`
      );
      assert.ok(r.url.includes(`state=${encodeURIComponent(STATE)}`));
      assert.ok(r.url.includes("api_key=angel_publisher_key"));
    });
  });

  describe("Non-OAuth brokers — clear error, no URL", () => {
    it("GROWW returns an API-key / TOTP guidance error", () => {
      const r = buildBrokerOAuthUrl("GROWW", baseOpts);
      assert.equal(r.success, false);
      if (r.success) return;
      assert.match(r.error, /API key|TOTP/i);
    });

    it("DHAN returns an API-key guidance error", () => {
      const r = buildBrokerOAuthUrl("DHAN", baseOpts);
      assert.equal(r.success, false);
      if (r.success) return;
      assert.match(r.error, /API key/i);
    });
  });
});
