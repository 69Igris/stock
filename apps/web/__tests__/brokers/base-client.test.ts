/**
 * Base Broker Client Tests — REAL SOURCE
 *
 * Exercises the REAL abstract `BaseBrokerClient` from
 * `@/lib/brokers/base-client` — NOT an inline copy. A minimal concrete subclass
 * drives the real methods:
 * - constructor baseUrl assignment (real getBrokerConfig(broker).baseUrl lookup)
 * - isTokenValid() (real, reads this.credentials.tokenExpiry)
 * - default getMutualFunds() / refreshToken()
 * - makeRequest(): URL concatenation, header merge (Content-Type + auth +
 *   custom), and the SANITIZED error format — driven against a stubbed global
 *   `fetch` so the real method body runs with no network. Also covers the real
 *   exported retry helpers (isRetryableStatus, backoffMs) and constants.
 *
 * (Replaces the previous shadow version, which reimplemented isTokenValid,
 * constructRequestUrl, formatApiError, mergeHeaders, the broker-base-URL map and
 * the defaults inline and asserted the copies — note the copy's error format
 * used the response BODY, while the real makeRequest uses statusText and never
 * surfaces the upstream body.)
 *
 * Pure/offline: `fetch` is replaced with a synchronous stub for the duration of
 * each makeRequest test (save/restore), so no real socket, and the request
 * timeout timer is cleared immediately — no open handles / orphans.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  BaseBrokerClient,
  BrokerCredentials,
  isRetryableStatus,
  backoffMs,
  BROKER_HTTP_TIMEOUT_MS,
  BROKER_MAX_RETRIES,
} from "@/lib/brokers/base-client";
import type { BrokerType } from "@usemoney/types/broker";
import type {
  NormalizedHolding,
  NormalizedPosition,
  NormalizedTrade,
  NormalizedOrder,
  NormalizedMargins,
  BrokerProfile,
} from "@/lib/brokers/types";

// Minimal concrete subclass so the abstract class can be instantiated. Abstract
// data methods are stubbed (never called by these tests); the inherited
// isTokenValid / getMutualFunds / refreshToken / makeRequest are the REAL ones.
class TestBrokerClient extends BaseBrokerClient {
  // Echo the real auth headers the makeRequest tests assert on.
  authHeaders: Record<string, string> = { Authorization: "Bearer test-token" };

  async getProfile(): Promise<BrokerProfile> {
    throw new Error("not used");
  }
  async getHoldings(): Promise<NormalizedHolding[]> {
    return [];
  }
  async getPositions(): Promise<NormalizedPosition[]> {
    return [];
  }
  async getTrades(): Promise<NormalizedTrade[]> {
    return [];
  }
  async getOrders(): Promise<NormalizedOrder[]> {
    return [];
  }
  async getMargins(): Promise<NormalizedMargins> {
    throw new Error("not used");
  }
  protected getAuthHeaders(): Record<string, string> {
    return this.authHeaders;
  }

  // Test-only escape hatches onto the protected surface.
  get exposedBaseUrl(): string {
    return this.baseUrl;
  }
  callMakeRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return this.makeRequest<T>(endpoint, options);
  }
}

function createCredentials(
  overrides: Partial<BrokerCredentials> = {}
): BrokerCredentials {
  return { accessToken: "test-access-token-abc123", ...overrides };
}

function makeClient(
  broker: BrokerType,
  overrides: Partial<BrokerCredentials> = {}
): TestBrokerClient {
  return new TestBrokerClient(broker, createCredentials(overrides));
}

/** Stub global fetch with `impl` for the duration of `fn`, then restore. */
async function withFetch(
  impl: typeof fetch,
  fn: () => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe("BaseBrokerClient", () => {
  // ---------- Constructor / baseUrl ----------
  describe("Constructor and baseUrl assignment", () => {
    it("should resolve baseUrl for ZERODHA", () => {
      assert.strictEqual(
        makeClient("ZERODHA").exposedBaseUrl,
        "https://api.kite.trade"
      );
    });

    it("should resolve baseUrl for UPSTOX", () => {
      assert.strictEqual(
        makeClient("UPSTOX").exposedBaseUrl,
        "https://api.upstox.com/v2"
      );
    });

    it("should resolve baseUrl for DHAN", () => {
      assert.strictEqual(
        makeClient("DHAN").exposedBaseUrl,
        "https://api.dhan.co/v2"
      );
    });

    it("should resolve baseUrl for FYERS", () => {
      assert.strictEqual(
        makeClient("FYERS").exposedBaseUrl,
        "https://api-t1.fyers.in/api/v3"
      );
    });

    it("should resolve baseUrl for ANGEL_ONE", () => {
      assert.strictEqual(
        makeClient("ANGEL_ONE").exposedBaseUrl,
        "https://apiconnect.angelone.in"
      );
    });

    it("should resolve baseUrl for GROWW", () => {
      assert.strictEqual(
        makeClient("GROWW").exposedBaseUrl,
        "https://api.groww.in"
      );
    });

    it("should resolve baseUrl for ICICI", () => {
      assert.strictEqual(
        makeClient("ICICI").exposedBaseUrl,
        "https://api.icicidirect.com"
      );
    });

    it("should resolve baseUrl for HDFC", () => {
      assert.strictEqual(
        makeClient("HDFC").exposedBaseUrl,
        "https://api.hdfcsec.com"
      );
    });

    it("should store credentials accessToken", () => {
      const creds = createCredentials({ accessToken: "my-token" });
      assert.strictEqual(creds.accessToken, "my-token");
    });

    it("should allow optional refreshToken in credentials", () => {
      const creds = createCredentials({ refreshToken: "refresh-abc" });
      assert.strictEqual(creds.refreshToken, "refresh-abc");
    });

    it("should allow optional apiKey in credentials", () => {
      const creds = createCredentials({ apiKey: "key-123" });
      assert.strictEqual(creds.apiKey, "key-123");
    });
  });

  // ---------- isTokenValid() ----------
  describe("isTokenValid", () => {
    it("should return true when tokenExpiry is undefined", () => {
      assert.strictEqual(makeClient("ZERODHA").isTokenValid(), true);
    });

    it("should return true when tokenExpiry is in the future", () => {
      const futureDate = new Date(Date.now() + 60 * 60 * 1000);
      assert.strictEqual(
        makeClient("ZERODHA", { tokenExpiry: futureDate }).isTokenValid(),
        true
      );
    });

    it("should return false when tokenExpiry is in the past", () => {
      const pastDate = new Date(Date.now() - 60 * 60 * 1000);
      assert.strictEqual(
        makeClient("ZERODHA", { tokenExpiry: pastDate }).isTokenValid(),
        false
      );
    });

    it("should return false when tokenExpiry is well in the past", () => {
      const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      assert.strictEqual(
        makeClient("ZERODHA", { tokenExpiry: longAgo }).isTokenValid(),
        false
      );
    });

    it("should return true when tokenExpiry is far in the future", () => {
      const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      assert.strictEqual(
        makeClient("ZERODHA", { tokenExpiry: farFuture }).isTokenValid(),
        true
      );
    });

    it("should handle boundary: expiry ~1 second from now returns true", () => {
      const almostNow = new Date(Date.now() + 1000);
      assert.strictEqual(
        makeClient("ZERODHA", { tokenExpiry: almostNow }).isTokenValid(),
        true
      );
    });

    it("should handle boundary: expiry ~1 second ago returns false", () => {
      const justPast = new Date(Date.now() - 1000);
      assert.strictEqual(
        makeClient("ZERODHA", { tokenExpiry: justPast }).isTokenValid(),
        false
      );
    });
  });

  // ---------- makeRequest URL construction ----------
  describe("makeRequest URL construction", () => {
    afterEach(() => {});

    async function captureUrl(
      broker: BrokerType,
      endpoint: string
    ): Promise<string> {
      let seenUrl = "";
      await withFetch(
        (async (input: RequestInfo | URL) => {
          seenUrl = String(input);
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
        async () => {
          await makeClient(broker).callMakeRequest(endpoint);
        }
      );
      return seenUrl;
    }

    it("should concatenate baseUrl and endpoint", async () => {
      assert.strictEqual(
        await captureUrl("ZERODHA", "/portfolio/holdings"),
        "https://api.kite.trade/portfolio/holdings"
      );
    });

    it("should handle root endpoint", async () => {
      assert.strictEqual(
        await captureUrl("ZERODHA", "/"),
        "https://api.kite.trade/"
      );
    });

    it("should handle empty endpoint", async () => {
      assert.strictEqual(
        await captureUrl("ZERODHA", ""),
        "https://api.kite.trade"
      );
    });

    it("should handle endpoint with query parameters", async () => {
      assert.strictEqual(
        await captureUrl("DHAN", "/trades?from=2024-01-01&to=2024-01-31"),
        "https://api.dhan.co/v2/trades?from=2024-01-01&to=2024-01-31"
      );
    });

    it("should handle nested endpoint paths", async () => {
      assert.strictEqual(
        await captureUrl(
          "ANGEL_ONE",
          "/rest/secure/angelbroking/portfolio/v1/getAllHolding"
        ),
        "https://apiconnect.angelone.in/rest/secure/angelbroking/portfolio/v1/getAllHolding"
      );
    });

    it("should handle baseUrl with trailing path segments", async () => {
      assert.strictEqual(
        await captureUrl("UPSTOX", "/portfolio/long-term-holdings"),
        "https://api.upstox.com/v2/portfolio/long-term-holdings"
      );
    });
  });

  // ---------- makeRequest error formatting (sanitized) ----------
  describe("makeRequest error formatting", () => {
    /** Drive makeRequest against a non-ok response and capture the thrown msg. */
    async function captureError(
      broker: BrokerType,
      status: number,
      statusText: string
    ): Promise<string> {
      let message = "";
      await withFetch(
        (async () =>
          new Response("ignored upstream body", {
            status,
            statusText,
          })) as typeof fetch,
        async () => {
          await assert.rejects(
            makeClient(broker).callMakeRequest("/x"),
            (err: Error) => {
              message = err.message;
              return true;
            }
          );
        }
      );
      return message;
    }

    it("should format error with broker name, status, and statusText", async () => {
      assert.strictEqual(
        await captureError("ZERODHA", 401, "Unauthorized"),
        "ZERODHA API Error: 401 - Unauthorized"
      );
    });

    it("should format 403 forbidden", async () => {
      assert.strictEqual(
        await captureError("UPSTOX", 403, "Forbidden"),
        "UPSTOX API Error: 403 - Forbidden"
      );
    });

    it("should NOT surface the raw upstream response body", async () => {
      const msg = await captureError("ZERODHA", 400, "Bad Request");
      assert.ok(!msg.includes("ignored upstream body"));
    });

    it("should preserve the 'API Error: <status>' shape (classifier keys on it)", async () => {
      const msg = await captureError("GROWW", 401, "Unauthorized");
      assert.ok(msg.includes("API Error: 401"));
    });
  });

  // ---------- makeRequest header merging ----------
  describe("makeRequest header merging", () => {
    /** Drive makeRequest and capture the outgoing headers as a plain object. */
    async function captureHeaders(
      client: TestBrokerClient,
      options?: RequestInit
    ): Promise<Record<string, string>> {
      let headers: Record<string, string> = {};
      await withFetch(
        (async (_input: RequestInfo | URL, init?: RequestInit) => {
          headers = (init?.headers as Record<string, string>) || {};
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
        async () => {
          await client.callMakeRequest("/x", options);
        }
      );
      return headers;
    }

    it("should always include Content-Type application/json", async () => {
      const client = makeClient("ZERODHA");
      client.authHeaders = {};
      const headers = await captureHeaders(client);
      assert.strictEqual(headers["Content-Type"], "application/json");
    });

    it("should include the adapter's auth headers", async () => {
      const client = makeClient("ZERODHA");
      client.authHeaders = { Authorization: "Bearer test-token" };
      const headers = await captureHeaders(client);
      assert.strictEqual(headers["Authorization"], "Bearer test-token");
      assert.strictEqual(headers["Content-Type"], "application/json");
    });

    it("should include custom (per-request) headers", async () => {
      const client = makeClient("ZERODHA");
      client.authHeaders = { Authorization: "Bearer token" };
      const headers = await captureHeaders(client, {
        headers: { "X-Custom": "value" },
      });
      assert.strictEqual(headers["X-Custom"], "value");
    });

    it("should allow custom headers to override Content-Type", async () => {
      const client = makeClient("ZERODHA");
      client.authHeaders = {};
      const headers = await captureHeaders(client, {
        headers: { "Content-Type": "text/plain" },
      });
      assert.strictEqual(headers["Content-Type"], "text/plain");
    });

    it("should allow custom headers to override auth headers", async () => {
      const client = makeClient("ZERODHA");
      client.authHeaders = { Authorization: "Bearer original" };
      const headers = await captureHeaders(client, {
        headers: { Authorization: "Bearer override" },
      });
      assert.strictEqual(headers["Authorization"], "Bearer override");
    });

    it("should handle a request with no custom headers", async () => {
      const client = makeClient("ZERODHA");
      client.authHeaders = { Authorization: "Bearer token" };
      const headers = await captureHeaders(client);
      assert.strictEqual(headers["Authorization"], "Bearer token");
      assert.strictEqual(headers["Content-Type"], "application/json");
    });

    it("should merge empty auth headers with custom headers", async () => {
      const client = makeClient("ZERODHA");
      client.authHeaders = {};
      const headers = await captureHeaders(client, {
        headers: { "X-API-Key": "key123" },
      });
      assert.strictEqual(headers["X-API-Key"], "key123");
      assert.strictEqual(headers["Content-Type"], "application/json");
    });

    it("should return parsed JSON on a 200 response", async () => {
      let result: unknown;
      await withFetch(
        (async () =>
          new Response(JSON.stringify({ ok: true, n: 7 }), {
            status: 200,
          })) as typeof fetch,
        async () => {
          result = await makeClient("ZERODHA").callMakeRequest<{
            ok: boolean;
            n: number;
          }>("/x");
        }
      );
      assert.deepStrictEqual(result, { ok: true, n: 7 });
    });
  });

  // ---------- Retry helpers (exported pure functions) ----------
  describe("Retry helpers", () => {
    it("isRetryableStatus is true for 429", () => {
      assert.strictEqual(isRetryableStatus(429), true);
    });

    it("isRetryableStatus is true for 5xx", () => {
      assert.strictEqual(isRetryableStatus(500), true);
      assert.strictEqual(isRetryableStatus(503), true);
    });

    it("isRetryableStatus is false for other 4xx", () => {
      assert.strictEqual(isRetryableStatus(401), false);
      assert.strictEqual(isRetryableStatus(400), false);
      assert.strictEqual(isRetryableStatus(404), false);
    });

    it("backoffMs grows exponentially from 500ms", () => {
      assert.strictEqual(backoffMs(0), 500);
      assert.strictEqual(backoffMs(1), 1000);
      assert.strictEqual(backoffMs(2), 2000);
    });

    it("exposes the timeout + retry constants", () => {
      assert.strictEqual(BROKER_HTTP_TIMEOUT_MS, 15_000);
      assert.strictEqual(BROKER_MAX_RETRIES, 2);
    });
  });

  // ---------- Default getMutualFunds() ----------
  describe("Default getMutualFunds", () => {
    it("should return an empty array", async () => {
      const result = await makeClient("ZERODHA").getMutualFunds();
      assert.deepStrictEqual(result, []);
    });

    it("should return a new array each time", async () => {
      const client = makeClient("ZERODHA");
      const a = await client.getMutualFunds();
      const b = await client.getMutualFunds();
      assert.notStrictEqual(a, b);
    });

    it("should return an array with length 0", async () => {
      const result = await makeClient("ZERODHA").getMutualFunds();
      assert.strictEqual(result.length, 0);
    });
  });

  // ---------- Default refreshToken() ----------
  describe("Default refreshToken", () => {
    it("should return null", async () => {
      const result = await makeClient("ZERODHA").refreshToken();
      assert.strictEqual(result, null);
    });

    it("should not return undefined", async () => {
      const result = await makeClient("ZERODHA").refreshToken();
      assert.notStrictEqual(result, undefined);
    });
  });

  // ---------- BrokerCredentials structure ----------
  describe("BrokerCredentials structure", () => {
    it("should create credentials with only accessToken", () => {
      const creds = createCredentials();
      assert.ok(creds.accessToken);
      assert.strictEqual(creds.refreshToken, undefined);
      assert.strictEqual(creds.apiKey, undefined);
      assert.strictEqual(creds.apiSecret, undefined);
      assert.strictEqual(creds.userId, undefined);
      assert.strictEqual(creds.tokenExpiry, undefined);
    });

    it("should create credentials with all optional fields", () => {
      const expiry = new Date(Date.now() + 86400000);
      const creds = createCredentials({
        accessToken: "tok",
        refreshToken: "ref",
        apiKey: "key",
        apiSecret: "secret",
        userId: "user1",
        tokenExpiry: expiry,
      });
      assert.strictEqual(creds.accessToken, "tok");
      assert.strictEqual(creds.refreshToken, "ref");
      assert.strictEqual(creds.apiKey, "key");
      assert.strictEqual(creds.apiSecret, "secret");
      assert.strictEqual(creds.userId, "user1");
      assert.strictEqual(creds.tokenExpiry, expiry);
    });

    it("should allow tokenExpiry to be a Date object", () => {
      const expiry = new Date("2025-12-31T23:59:59Z");
      const creds = createCredentials({ tokenExpiry: expiry });
      assert.ok(creds.tokenExpiry instanceof Date);
    });
  });
});
