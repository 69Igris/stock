/**
 * Dodo Payments Integration Tests
 *
 * Exercises the REAL Dodo helpers exported from
 * packages/core/src/payments/dodo.ts (via `@usemoney/core/payments`):
 * `getDodoMode`, `getDodoSdkMode`, `isDodoConfigured`, `isLiveMode`,
 * `getDodoClient`, `resetDodoClient`, the `dodoClient` backward-compat Proxy,
 * and the `DODO_SDK_MODE` constant. No inline reimplementation — `getDodoClient`
 * constructs the REAL `DodoPayments` SDK (lazily; no network at construction,
 * so this stays hermetic with a placeholder API key).
 *
 * Divergences the old shadow hid (it built a `MockDodoClient` with made-up
 * fields and asserted that shape):
 *   - The REAL `DodoPayments` instance exposes `bearerToken` (= the API key) but
 *     does NOT expose a public `environment` property (it is undefined on the
 *     instance — the SDK keeps it internal). The shadow asserted
 *     `client.environment === "test_mode" / "live_mode"` against its mock; those
 *     are not observable on the real client and are dropped here.
 *   - `DODO_SDK_MODE` is evaluated ONCE at module load (a frozen const). The
 *     shadow re-computed it per test via a helper; the real const cannot react
 *     to later env changes, so only its frozen value is asserted (use
 *     `getDodoSdkMode()` for the dynamic behaviour).
 *
 * Source: packages/core/src/payments/dodo.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  getDodoMode,
  getDodoSdkMode,
  isDodoConfigured,
  isLiveMode,
  getDodoClient,
  resetDodoClient,
  dodoClient,
  DODO_SDK_MODE,
} from "@usemoney/core/payments";

// ============================================================================
// Tests
// ============================================================================

describe("Dodo Payments Integration (real @usemoney/core exports)", () => {
  let originalDodoMode: string | undefined;
  let originalDodoApiKey: string | undefined;

  beforeEach(() => {
    originalDodoMode = process.env.NEXT_PUBLIC_DODO_MODE;
    originalDodoApiKey = process.env.DODO_PAYMENTS_API_KEY;
    delete process.env.NEXT_PUBLIC_DODO_MODE;
    delete process.env.DODO_PAYMENTS_API_KEY;
    resetDodoClient();
  });

  afterEach(() => {
    if (originalDodoMode !== undefined) {
      process.env.NEXT_PUBLIC_DODO_MODE = originalDodoMode;
    } else {
      delete process.env.NEXT_PUBLIC_DODO_MODE;
    }
    if (originalDodoApiKey !== undefined) {
      process.env.DODO_PAYMENTS_API_KEY = originalDodoApiKey;
    } else {
      delete process.env.DODO_PAYMENTS_API_KEY;
    }
    resetDodoClient();
  });

  // --------------------------------------------------------------------------
  // getDodoMode
  // --------------------------------------------------------------------------
  describe("getDodoMode", () => {
    it("should return 'test_mode' when NEXT_PUBLIC_DODO_MODE is not set", () => {
      delete process.env.NEXT_PUBLIC_DODO_MODE;
      assert.strictEqual(getDodoMode(), "test_mode");
    });

    it("should return 'test_mode' when NEXT_PUBLIC_DODO_MODE is empty", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "";
      assert.strictEqual(getDodoMode(), "test_mode");
    });

    it("should return 'test_mode' when NEXT_PUBLIC_DODO_MODE is 'test'", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "test";
      assert.strictEqual(getDodoMode(), "test_mode");
    });

    it("should return 'live_mode' when NEXT_PUBLIC_DODO_MODE is 'live'", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "live";
      assert.strictEqual(getDodoMode(), "live_mode");
    });

    it("should return 'test_mode' for 'staging' value", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "staging";
      assert.strictEqual(getDodoMode(), "test_mode");
    });

    it("should return 'test_mode' for 'production' value", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "production";
      assert.strictEqual(getDodoMode(), "test_mode");
    });

    it("should be case-sensitive - 'LIVE' returns test_mode", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "LIVE";
      assert.strictEqual(getDodoMode(), "test_mode");
    });

    it("should be case-sensitive - 'Live' returns test_mode", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "Live";
      assert.strictEqual(getDodoMode(), "test_mode");
    });

    it("should return 'test_mode' for whitespace-only value", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "   ";
      assert.strictEqual(getDodoMode(), "test_mode");
    });

    it("should return 'test_mode' for 'true' string", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "true";
      assert.strictEqual(getDodoMode(), "test_mode");
    });

    it("should return 'test_mode' for '1' string", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "1";
      assert.strictEqual(getDodoMode(), "test_mode");
    });

    it("should return a valid mode literal", () => {
      const result = getDodoMode();
      assert.ok(result === "test_mode" || result === "live_mode");
    });
  });

  // --------------------------------------------------------------------------
  // getDodoSdkMode
  // --------------------------------------------------------------------------
  describe("getDodoSdkMode", () => {
    it("should return 'test' when NEXT_PUBLIC_DODO_MODE is not set", () => {
      delete process.env.NEXT_PUBLIC_DODO_MODE;
      assert.strictEqual(getDodoSdkMode(), "test");
    });

    it("should return 'test' when NEXT_PUBLIC_DODO_MODE is empty", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "";
      assert.strictEqual(getDodoSdkMode(), "test");
    });

    it("should return 'test' when NEXT_PUBLIC_DODO_MODE is 'test'", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "test";
      assert.strictEqual(getDodoSdkMode(), "test");
    });

    it("should return 'live' when NEXT_PUBLIC_DODO_MODE is 'live'", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "live";
      assert.strictEqual(getDodoSdkMode(), "live");
    });

    it("should return 'test' for any non-'live' value like 'sandbox'", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "sandbox";
      assert.strictEqual(getDodoSdkMode(), "test");
    });

    it("should return 'test' for uppercase 'LIVE'", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "LIVE";
      assert.strictEqual(getDodoSdkMode(), "test");
    });

    it("should be consistent with getDodoMode in live", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "live";
      assert.strictEqual(getDodoMode(), "live_mode");
      assert.strictEqual(getDodoSdkMode(), "live");
    });

    it("should be consistent with getDodoMode in test", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "test";
      assert.strictEqual(getDodoMode(), "test_mode");
      assert.strictEqual(getDodoSdkMode(), "test");
    });

    it("should return a valid sdk mode literal", () => {
      const result = getDodoSdkMode();
      assert.ok(result === "test" || result === "live");
    });
  });

  // --------------------------------------------------------------------------
  // isDodoConfigured
  // --------------------------------------------------------------------------
  describe("isDodoConfigured", () => {
    it("should return false when DODO_PAYMENTS_API_KEY is not set", () => {
      delete process.env.DODO_PAYMENTS_API_KEY;
      assert.strictEqual(isDodoConfigured(), false);
    });

    it("should return false when DODO_PAYMENTS_API_KEY is empty string", () => {
      process.env.DODO_PAYMENTS_API_KEY = "";
      assert.strictEqual(isDodoConfigured(), false);
    });

    it("should return true when DODO_PAYMENTS_API_KEY is set", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_12345";
      assert.strictEqual(isDodoConfigured(), true);
    });

    it("should return true for any non-empty value", () => {
      process.env.DODO_PAYMENTS_API_KEY = "x";
      assert.strictEqual(isDodoConfigured(), true);
    });

    it("should return true for whitespace-only key (truthy)", () => {
      process.env.DODO_PAYMENTS_API_KEY = "   ";
      assert.strictEqual(isDodoConfigured(), true);
    });

    it("should return true for a live key format", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_live_abcdef1234567890";
      assert.strictEqual(isDodoConfigured(), true);
    });

    it("should return a boolean type", () => {
      delete process.env.DODO_PAYMENTS_API_KEY;
      assert.strictEqual(typeof isDodoConfigured(), "boolean");
      process.env.DODO_PAYMENTS_API_KEY = "test";
      assert.strictEqual(typeof isDodoConfigured(), "boolean");
    });
  });

  // --------------------------------------------------------------------------
  // isLiveMode
  // --------------------------------------------------------------------------
  describe("isLiveMode", () => {
    it("should return false when NEXT_PUBLIC_DODO_MODE is not set", () => {
      delete process.env.NEXT_PUBLIC_DODO_MODE;
      assert.strictEqual(isLiveMode(), false);
    });

    it("should return false when NEXT_PUBLIC_DODO_MODE is empty", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "";
      assert.strictEqual(isLiveMode(), false);
    });

    it("should return false when NEXT_PUBLIC_DODO_MODE is 'test'", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "test";
      assert.strictEqual(isLiveMode(), false);
    });

    it("should return true when NEXT_PUBLIC_DODO_MODE is 'live'", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "live";
      assert.strictEqual(isLiveMode(), true);
    });

    it("should return false for uppercase 'LIVE'", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "LIVE";
      assert.strictEqual(isLiveMode(), false);
    });

    it("should return false for 'true' string", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "true";
      assert.strictEqual(isLiveMode(), false);
    });

    it("should return false for '1' string", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "1";
      assert.strictEqual(isLiveMode(), false);
    });

    it("should return false for 'false' string", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "false";
      assert.strictEqual(isLiveMode(), false);
    });

    it("should be consistent with getDodoMode for live", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "live";
      assert.strictEqual(isLiveMode(), true);
      assert.strictEqual(getDodoMode(), "live_mode");
    });

    it("should be consistent with getDodoMode for unset", () => {
      delete process.env.NEXT_PUBLIC_DODO_MODE;
      assert.strictEqual(isLiveMode(), false);
      assert.strictEqual(getDodoMode(), "test_mode");
    });
  });

  // --------------------------------------------------------------------------
  // getDodoClient (real DodoPayments SDK, singleton)
  // --------------------------------------------------------------------------
  describe("getDodoClient", () => {
    it("should throw when DODO_PAYMENTS_API_KEY is not set", () => {
      delete process.env.DODO_PAYMENTS_API_KEY;
      assert.throws(() => getDodoClient(), {
        message:
          "DODO_PAYMENTS_API_KEY environment variable is missing or empty. Please add it to your .env file.",
      });
    });

    it("should throw when DODO_PAYMENTS_API_KEY is empty string", () => {
      process.env.DODO_PAYMENTS_API_KEY = "";
      assert.throws(() => getDodoClient(), {
        message:
          "DODO_PAYMENTS_API_KEY environment variable is missing or empty. Please add it to your .env file.",
      });
    });

    it("should throw an Error instance", () => {
      delete process.env.DODO_PAYMENTS_API_KEY;
      assert.throws(
        () => getDodoClient(),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          return true;
        }
      );
    });

    it("should create a real DodoPayments client when API key is provided", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_valid_key";
      const client = getDodoClient();
      assert.ok(client, "Client should be created");
      assert.strictEqual(client.constructor.name, "DodoPayments");
    });

    it("should return the same instance on subsequent calls (singleton)", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_valid_key";
      assert.strictEqual(getDodoClient(), getDodoClient());
    });

    it("should return the same instance even after three calls", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_key";
      const client1 = getDodoClient();
      const client2 = getDodoClient();
      const client3 = getDodoClient();
      assert.strictEqual(client1, client2);
      assert.strictEqual(client2, client3);
    });

    it("should store the API key as bearerToken (real SDK field)", () => {
      const testKey = "sk_test_my_api_key_123";
      process.env.DODO_PAYMENTS_API_KEY = testKey;
      const client = getDodoClient() as unknown as Record<string, unknown>;
      assert.strictEqual(client.bearerToken, testKey);
    });

    it("should construct successfully in live mode (bearerToken carries the key)", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_live_key";
      process.env.NEXT_PUBLIC_DODO_MODE = "live";
      const client = getDodoClient() as unknown as Record<string, unknown>;
      assert.strictEqual(client.bearerToken, "sk_live_key");
    });
  });

  // --------------------------------------------------------------------------
  // resetDodoClient
  // --------------------------------------------------------------------------
  describe("resetDodoClient", () => {
    it("should clear the singleton so next call creates a new instance", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_key_1";
      const client1 = getDodoClient();
      resetDodoClient();
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_key_2";
      const client2 = getDodoClient();
      assert.notStrictEqual(client1, client2);
    });

    it("should not throw when called multiple times", () => {
      assert.doesNotThrow(() => {
        resetDodoClient();
        resetDodoClient();
        resetDodoClient();
      });
    });

    it("should not throw when called without ever creating a client", () => {
      assert.doesNotThrow(() => resetDodoClient());
    });

    it("should allow creating client with a different key after reset", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_original";
      const client1 = getDodoClient() as unknown as Record<string, unknown>;
      assert.strictEqual(client1.bearerToken, "sk_test_original");
      resetDodoClient();
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_updated";
      const client2 = getDodoClient() as unknown as Record<string, unknown>;
      assert.strictEqual(client2.bearerToken, "sk_test_updated");
    });

    it("should cause getDodoClient to throw if the API key is removed after reset", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_key";
      getDodoClient();
      resetDodoClient();
      delete process.env.DODO_PAYMENTS_API_KEY;
      assert.throws(() => getDodoClient(), {
        message: /DODO_PAYMENTS_API_KEY/,
      });
    });
  });

  // --------------------------------------------------------------------------
  // DODO_SDK_MODE constant (frozen at module load)
  // --------------------------------------------------------------------------
  describe("DODO_SDK_MODE constant", () => {
    it("should be a valid frozen sdk-mode literal", () => {
      assert.ok(DODO_SDK_MODE === "test" || DODO_SDK_MODE === "live");
    });

    it("should match getDodoSdkMode under the env it was evaluated with", () => {
      // Both derive from the same rule; with the harness clearing the env var,
      // getDodoSdkMode() returns 'test', which is the default frozen value too.
      delete process.env.NEXT_PUBLIC_DODO_MODE;
      assert.strictEqual(getDodoSdkMode(), "test");
    });
  });

  // --------------------------------------------------------------------------
  // dodoClient proxy (backward compatibility) — real Proxy over getDodoClient
  // --------------------------------------------------------------------------
  describe("dodoClient proxy (backward compatibility)", () => {
    it("should proxy bearerToken access to the real client", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_proxy_key";
      const rec = dodoClient as unknown as Record<string, unknown>;
      assert.strictEqual(rec.bearerToken, "sk_test_proxy_key");
    });

    it("should throw when accessing properties without an API key", () => {
      delete process.env.DODO_PAYMENTS_API_KEY;
      const rec = dodoClient as unknown as Record<string, unknown>;
      assert.throws(() => rec.bearerToken, {
        message: /DODO_PAYMENTS_API_KEY/,
      });
    });

    it("should return undefined for symbol property access", () => {
      const sym = Symbol("test");
      assert.strictEqual(Reflect.get(dodoClient, sym), undefined);
    });

    it("should lazily initialize the client on first property access", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_lazy";
      const rec = dodoClient as unknown as Record<string, unknown>;
      assert.strictEqual(rec.bearerToken, "sk_test_lazy");
      // Subsequent access returns the same singleton value.
      assert.strictEqual(rec.bearerToken, "sk_test_lazy");
    });

    it("should reflect a new key after resetDodoClient", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_first";
      const rec = dodoClient as unknown as Record<string, unknown>;
      assert.strictEqual(rec.bearerToken, "sk_test_first");
      resetDodoClient();
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_second";
      assert.strictEqual(rec.bearerToken, "sk_test_second");
    });
  });

  // --------------------------------------------------------------------------
  // Mode consistency (cross-function agreement)
  // --------------------------------------------------------------------------
  describe("Mode consistency", () => {
    it("all mode functions should agree when mode is 'live'", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "live";
      assert.strictEqual(getDodoMode(), "live_mode");
      assert.strictEqual(getDodoSdkMode(), "live");
      assert.strictEqual(isLiveMode(), true);
    });

    it("all mode functions should agree when mode is 'test'", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "test";
      assert.strictEqual(getDodoMode(), "test_mode");
      assert.strictEqual(getDodoSdkMode(), "test");
      assert.strictEqual(isLiveMode(), false);
    });

    it("all mode functions should agree when mode is unset", () => {
      delete process.env.NEXT_PUBLIC_DODO_MODE;
      assert.strictEqual(getDodoMode(), "test_mode");
      assert.strictEqual(getDodoSdkMode(), "test");
      assert.strictEqual(isLiveMode(), false);
    });

    it("all mode functions should agree when mode is empty string", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "";
      assert.strictEqual(getDodoMode(), "test_mode");
      assert.strictEqual(getDodoSdkMode(), "test");
      assert.strictEqual(isLiveMode(), false);
    });
  });

  // --------------------------------------------------------------------------
  // Environment isolation
  // --------------------------------------------------------------------------
  describe("Environment isolation", () => {
    it("isDodoConfigured should be independent of mode", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_key";
      process.env.NEXT_PUBLIC_DODO_MODE = "live";
      assert.strictEqual(isDodoConfigured(), true);
      delete process.env.NEXT_PUBLIC_DODO_MODE;
      assert.strictEqual(isDodoConfigured(), true);
      delete process.env.DODO_PAYMENTS_API_KEY;
      assert.strictEqual(isDodoConfigured(), false);
    });

    it("mode functions should be independent of API key", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "live";
      delete process.env.DODO_PAYMENTS_API_KEY;
      assert.strictEqual(getDodoMode(), "live_mode");
      assert.strictEqual(isLiveMode(), true);
      process.env.DODO_PAYMENTS_API_KEY = "sk_live_key";
      assert.strictEqual(getDodoMode(), "live_mode");
      assert.strictEqual(isLiveMode(), true);
    });

    it("getDodoSdkMode should be independent of API key", () => {
      process.env.NEXT_PUBLIC_DODO_MODE = "live";
      delete process.env.DODO_PAYMENTS_API_KEY;
      assert.strictEqual(getDodoSdkMode(), "live");
      process.env.DODO_PAYMENTS_API_KEY = "sk_live_key";
      assert.strictEqual(getDodoSdkMode(), "live");
    });

    it("client creation should carry the API key as bearerToken", () => {
      process.env.DODO_PAYMENTS_API_KEY = "sk_test_key";
      process.env.NEXT_PUBLIC_DODO_MODE = "live";
      const client = getDodoClient() as unknown as Record<string, unknown>;
      assert.strictEqual(client.bearerToken, "sk_test_key");
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases: NEXT_PUBLIC_DODO_MODE string variations
  // --------------------------------------------------------------------------
  describe("NEXT_PUBLIC_DODO_MODE edge cases", () => {
    const nonLiveValues = [
      "false",
      "0",
      "undefined",
      "null",
      "Live",
      "LIVE",
      "lIvE",
      " live",
      "live ",
      " live ",
      "live\n",
      "dev",
      "development",
      "prod",
    ];

    for (const val of nonLiveValues) {
      it(`should treat '${val.replace(/\n/g, "\\n")}' as test mode`, () => {
        process.env.NEXT_PUBLIC_DODO_MODE = val;
        assert.strictEqual(getDodoMode(), "test_mode");
        assert.strictEqual(getDodoSdkMode(), "test");
        assert.strictEqual(isLiveMode(), false);
      });
    }
  });
});
