/**
 * UNIT + CONTRACT TEST — broker OAuth token exchange guards (MONEY-1158).
 *
 * Drives the REAL `static exchangeToken()` of each client with a stubbed
 * `globalThis.fetch`, so the guard under test is the one that ships.
 *
 * ## The defect
 *
 * Four clients read `access_token` off the parsed response with no presence
 * check. On a 200 whose body carried an error envelope instead of a token:
 *
 *   upstox / fyers / interactive-brokers  ->  returned `accessToken: undefined`
 *   zerodha                               ->  TypeError on `data.data.access_token`
 *
 * The caller (`apps/web/lib/actions/broker-connection.ts`) then encrypts and
 * persists that value as a `BrokerConnection`, so the connection LOOKS
 * established while every subsequent sync fails against a credential that was
 * never real. The three silent ones are the dangerous case.
 *
 * A 200 carrying an error envelope is a normal OAuth failure mode under rate
 * limiting or a revoked app — not a hypothetical.
 *
 * ## What is asserted
 *
 * 1. A 200 with no token THROWS (never returns undefined) — per client.
 * 2. The throw is classified: `payload` when the provider answered but gave no
 *    token, `transport` when we never got a usable answer. That is what makes a
 *    `BrokerIntegrationFailure` row triageable without re-reading the message.
 * 3. The happy path still returns the token — so the guard cannot be "passing"
 *    by rejecting everything.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  BrokerTokenExchangeError,
  requireAccessToken,
  requireTokenField,
  brokerTransportFailure,
} from "../../src/brokers/clients/token-exchange";
import { UpstoxClient } from "../../src/brokers/clients/upstox";
import { FyersClient } from "../../src/brokers/clients/fyers";
import { ZerodhaClient } from "../../src/brokers/clients/zerodha";
import { InteractiveBrokersClient } from "../../src/brokers/clients/interactive-brokers";

const realFetch = globalThis.fetch;

/** Stub fetch with one canned response. */
function stubFetch(
  status: number,
  body: unknown,
  { asText = false }: { asText?: boolean } = {},
): void {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (asText ? String(body) : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Every client whose exchangeToken was unguarded, with a caller that supplies
 * whatever argument shape it needs. Driving them from one table means a NEW
 * client cannot quietly skip the guard — it has to be added here.
 */
const CLIENTS: Array<{
  name: string;
  exchange: () => Promise<{ accessToken: string }>;
  /** A 200 body shaped like that provider's error envelope. */
  errorEnvelope: unknown;
  /** A 200 body carrying a real token. */
  successEnvelope: unknown;
}> = [
  {
    name: "Upstox",
    exchange: () => UpstoxClient.exchangeToken("k", "s", "code", "https://cb"),
    errorEnvelope: {
      error: "invalid_grant",
      error_description: "code already used",
    },
    successEnvelope: { access_token: "tok_upstox", expires_in: 3600 },
  },
  {
    name: "Fyers",
    exchange: () => FyersClient.exchangeToken("app", "secret", "authcode"),
    errorEnvelope: { s: "error", message: "invalid auth code" },
    successEnvelope: { access_token: "tok_fyers" },
  },
  {
    name: "Interactive Brokers",
    exchange: () =>
      InteractiveBrokersClient.exchangeToken("c", "s", "code", "https://cb"),
    errorEnvelope: { error: "invalid_client" },
    successEnvelope: { access_token: "tok_ibkr", expires_in: 600 },
  },
  {
    name: "Zerodha",
    exchange: () => ZerodhaClient.exchangeToken("k", "s", "reqtok"),
    // Kite's failure shape: the `data` envelope is absent entirely. This used
    // to throw a bare TypeError on `data.data.access_token`.
    errorEnvelope: { status: "error", message: "Token is invalid or expired" },
    successEnvelope: {
      data: { access_token: "tok_kite", user_id: "AB1234" },
    },
  },
];

describe("MONEY-1158 — a 200 with no access token must never be persisted", () => {
  for (const client of CLIENTS) {
    test(`${client.name}: a 200 error envelope THROWS instead of returning undefined`, async () => {
      stubFetch(200, client.errorEnvelope);

      const err = await client.exchange().then(
        (result) => {
          assert.fail(
            `${client.name} returned instead of throwing: ` +
              `accessToken=${JSON.stringify(result.accessToken)}. This value ` +
              `would be encrypted and persisted as a working BrokerConnection.`,
          );
        },
        (e: unknown) => e,
      );

      assert.ok(
        err instanceof BrokerTokenExchangeError,
        `${client.name} threw ${(err as Error)?.name} — it must throw a ` +
          `classified BrokerTokenExchangeError, not a bare Error/TypeError`,
      );
      assert.equal(
        err.kind,
        "payload",
        `${client.name}: the provider ANSWERED, so this is a payload failure, ` +
          `not a transport one — the distinction is what makes the failure ` +
          `row triageable`,
      );
    });

    test(`${client.name}: the happy path still returns the token`, async () => {
      // Without this the guard could "pass" by rejecting everything.
      stubFetch(200, client.successEnvelope);
      const result = await client.exchange();
      assert.ok(
        typeof result.accessToken === "string" && result.accessToken.length > 0,
        `${client.name} did not return a usable token on a valid response`,
      );
    });

    test(`${client.name}: a non-2xx is classified as transport, not payload`, async () => {
      stubFetch(503, "upstream unavailable", { asText: true });
      const err = await client.exchange().then(
        () => assert.fail(`${client.name} accepted a 503`),
        (e) => e,
      );
      assert.ok(err instanceof BrokerTokenExchangeError);
      assert.equal(err.kind, "transport");
      assert.equal(err.status, 503);
      // The historical message must survive. `classifyBrokerError` and
      // `mapKnownBrokerError` read these strings by substring, so adding the
      // typed classification must not reword them — a contract test in
      // apps/web pins Zerodha's two variants exactly.
      assert.match(
        err.message,
        /Failed to exchange token|^Zerodha: /,
        `${client.name} reworded its transport message; downstream matchers ` +
          `classify on that text`,
      );
    });
  }
});

describe("requireAccessToken", () => {
  test("rejects every unusable token shape", () => {
    // The empty string matters as much as null/undefined: it is encryptable and
    // persistable in exactly the same way, producing the same broken
    // connection with no error anywhere.
    for (const bad of [undefined, null, "", 0, false, {}, []]) {
      assert.throws(
        () => requireAccessToken("TestBroker", bad),
        BrokerTokenExchangeError,
        `${JSON.stringify(bad)} was accepted as an access token`,
      );
    }
  });

  test("returns the token so the call site cannot use the unchecked value", () => {
    assert.equal(requireAccessToken("TestBroker", "tok_abc"), "tok_abc");
  });

  test("surfaces the provider's own message when it supplied one", () => {
    const err = (() => {
      try {
        requireAccessToken("TestBroker", null, "app revoked");
        return null;
      } catch (e) {
        return e as BrokerTokenExchangeError;
      }
    })();
    assert.ok(err);
    assert.equal(err.upstreamMessage, "app revoked");
    assert.match(err.message, /app revoked/);
  });

  test("says something actionable when the provider supplied nothing", () => {
    const err = (() => {
      try {
        requireAccessToken("TestBroker", undefined);
        return null;
      } catch (e) {
        return e as BrokerTokenExchangeError;
      }
    })();
    assert.ok(err);
    assert.match(err.message, /revoked|rate-limited/i);
  });
});

describe("requireTokenField", () => {
  test("guards non-token required fields too", () => {
    // Kite's user_id: a connection persisted without it looks established and
    // fails every later sync, exactly like a missing token.
    assert.throws(
      () => requireTokenField("Zerodha", "user_id", undefined),
      BrokerTokenExchangeError,
    );
    assert.equal(requireTokenField("Zerodha", "user_id", "AB1234"), "AB1234");
  });
});

describe("brokerTransportFailure", () => {
  test("carries the status and the upstream text for triage", () => {
    const err = brokerTransportFailure(
      "Upstox",
      429,
      "Failed to exchange token: rate limited",
      "  rate limited  ",
    );
    assert.equal(err.kind, "transport");
    assert.equal(err.status, 429);
    assert.equal(err.upstreamMessage, "rate limited");
  });

  test("does NOT rewrite the message it is given", () => {
    // The whole point of the signature. Broker error messages in this repo are
    // load-bearing strings: `mapKnownBrokerError` matches
    // "zerodha: the user is not enabled" to render a specific support card,
    // and `classifyBrokerError` derives errorClass/recoveryAction by
    // substring. A generic "<Broker> token exchange failed: HTTP <n>" wrapper
    // broke BOTH — it lost the card, and (because it contains "token") it
    // reclassified every 5xx as AUTH_EXPIRED with a "reauth" recovery action.
    const err = brokerTransportFailure(
      "Zerodha",
      403,
      "Zerodha: The user is not enabled for the app",
      "The user is not enabled for the app",
    );
    assert.equal(err.message, "Zerodha: The user is not enabled for the app");
    assert.doesNotMatch(
      err.message,
      /HTTP 403/,
      "the wrapper must add structure via typed fields, never by editing the string",
    );
  });

  test("omits an empty upstream detail rather than storing whitespace", () => {
    const err = brokerTransportFailure(
      "Fyers",
      500,
      "Failed to exchange token",
      "   ",
    );
    assert.equal(err.upstreamMessage, undefined);
    assert.equal(err.message, "Failed to exchange token");
  });
});
