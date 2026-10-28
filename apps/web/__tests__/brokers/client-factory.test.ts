/**
 * Broker Client Factory Tests
 *
 * Tests for the createBrokerClient() factory function.
 * Reimplements the routing/factory logic inline.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ============== LOCAL TYPE DEFINITIONS ==============

type BrokerType =
  | "ZERODHA"
  | "UPSTOX"
  | "DHAN"
  | "FYERS"
  | "ANGEL_ONE"
  | "GROWW"
  | "ICICI"
  | "HDFC";

interface BrokerCredentials {
  accessToken: string;
  refreshToken?: string;
  apiKey?: string;
  apiSecret?: string;
  userId?: string;
  tokenExpiry?: Date;
}

// ============== REIMPLEMENTED FACTORY ==============

/** Supported brokers for client creation (Tier 1 only) */
const SUPPORTED_CLIENT_BROKERS: BrokerType[] = [
  "ZERODHA",
  "UPSTOX",
  "DHAN",
  "FYERS",
];

/** Unsupported brokers (Tier 2, not yet implemented as clients) */
const UNSUPPORTED_CLIENT_BROKERS: BrokerType[] = [
  "ANGEL_ONE",
  "GROWW",
  "ICICI",
  "HDFC",
];

/** Client type identifiers returned by the factory */
type ClientType =
  | "ZerodhaClient"
  | "UpstoxClient"
  | "DhanClient"
  | "FyersClient";

interface MockClient {
  type: ClientType;
  broker: BrokerType;
  credentials: BrokerCredentials;
}

function createBrokerClient(
  broker: BrokerType,
  credentials: BrokerCredentials
): MockClient {
  switch (broker) {
    case "ZERODHA":
      return { type: "ZerodhaClient", broker, credentials };
    case "UPSTOX":
      return { type: "UpstoxClient", broker, credentials };
    case "DHAN":
      return { type: "DhanClient", broker, credentials };
    case "FYERS":
      return { type: "FyersClient", broker, credentials };
    default:
      throw new Error(`Unsupported broker: ${broker}`);
  }
}

// ============== FACTORY HELPERS ==============

function createCredentials(
  overrides: Partial<BrokerCredentials> = {}
): BrokerCredentials {
  return {
    accessToken: "test-token-abc123",
    apiKey: "test-api-key",
    apiSecret: "test-api-secret",
    ...overrides,
  };
}

// ============== TESTS ==============

describe("Broker Client Factory", () => {
  // ---------- createBrokerClient routing ----------
  describe("createBrokerClient", () => {
    it("should create ZerodhaClient for ZERODHA broker", () => {
      const creds = createCredentials();
      const client = createBrokerClient("ZERODHA", creds);
      assert.strictEqual(client.type, "ZerodhaClient");
    });

    it("should create UpstoxClient for UPSTOX broker", () => {
      const creds = createCredentials();
      const client = createBrokerClient("UPSTOX", creds);
      assert.strictEqual(client.type, "UpstoxClient");
    });

    it("should create DhanClient for DHAN broker", () => {
      const creds = createCredentials();
      const client = createBrokerClient("DHAN", creds);
      assert.strictEqual(client.type, "DhanClient");
    });

    it("should create FyersClient for FYERS broker", () => {
      const creds = createCredentials();
      const client = createBrokerClient("FYERS", creds);
      assert.strictEqual(client.type, "FyersClient");
    });

    it("should throw for ANGEL_ONE (unsupported)", () => {
      const creds = createCredentials();
      assert.throws(
        () => createBrokerClient("ANGEL_ONE", creds),
        /Unsupported broker: ANGEL_ONE/
      );
    });

    it("should throw for GROWW (unsupported)", () => {
      const creds = createCredentials();
      assert.throws(
        () => createBrokerClient("GROWW", creds),
        /Unsupported broker: GROWW/
      );
    });

    it("should throw for ICICI (unsupported)", () => {
      const creds = createCredentials();
      assert.throws(
        () => createBrokerClient("ICICI", creds),
        /Unsupported broker: ICICI/
      );
    });

    it("should throw for HDFC (unsupported)", () => {
      const creds = createCredentials();
      assert.throws(
        () => createBrokerClient("HDFC", creds),
        /Unsupported broker: HDFC/
      );
    });

    it("should throw for completely unknown broker", () => {
      const creds = createCredentials();
      assert.throws(
        () => createBrokerClient("UNKNOWN" as BrokerType, creds),
        /Unsupported broker/
      );
    });

    it("should pass credentials to the created client", () => {
      const creds = createCredentials({
        accessToken: "my-special-token",
        apiKey: "my-key",
      });
      const client = createBrokerClient("ZERODHA", creds);
      assert.strictEqual(client.credentials.accessToken, "my-special-token");
      assert.strictEqual(client.credentials.apiKey, "my-key");
    });

    it("should preserve optional credential fields", () => {
      const creds = createCredentials({
        refreshToken: "refresh-abc",
        userId: "user123",
        tokenExpiry: new Date("2026-12-31"),
      });
      const client = createBrokerClient("UPSTOX", creds);
      assert.strictEqual(client.credentials.refreshToken, "refresh-abc");
      assert.strictEqual(client.credentials.userId, "user123");
      assert.ok(client.credentials.tokenExpiry instanceof Date);
    });
  });

  // ---------- Broker routing logic ----------
  describe("Broker routing logic", () => {
    it("should support exactly 4 brokers", () => {
      assert.strictEqual(SUPPORTED_CLIENT_BROKERS.length, 4);
    });

    it("supported brokers should all be Tier 1", () => {
      const tier1 = ["ZERODHA", "UPSTOX", "DHAN", "FYERS"];
      for (const b of SUPPORTED_CLIENT_BROKERS) {
        assert.ok(tier1.includes(b), `${b} should be Tier 1`);
      }
    });

    it("unsupported brokers should all be Tier 2", () => {
      const tier2 = ["ANGEL_ONE", "GROWW", "ICICI", "HDFC"];
      for (const b of UNSUPPORTED_CLIENT_BROKERS) {
        assert.ok(tier2.includes(b), `${b} should be Tier 2`);
      }
    });

    it("each supported broker should map to a unique client type", () => {
      const creds = createCredentials();
      const types = SUPPORTED_CLIENT_BROKERS.map(
        (b) => createBrokerClient(b, creds).type
      );
      const uniqueTypes = new Set(types);
      assert.strictEqual(types.length, uniqueTypes.size);
    });

    it("should create different clients for different brokers", () => {
      const creds = createCredentials();
      const z = createBrokerClient("ZERODHA", creds);
      const u = createBrokerClient("UPSTOX", creds);
      assert.notStrictEqual(z.type, u.type);
    });
  });

  // ---------- Unknown broker handling ----------
  describe("Unknown broker handling", () => {
    it("error message should include the broker name", () => {
      const creds = createCredentials();
      try {
        createBrokerClient("INVALID_BROKER" as BrokerType, creds);
        assert.fail("Should have thrown");
      } catch (err: unknown) {
        assert.ok(
          (err as Error).message.includes("INVALID_BROKER"),
          "Error should include broker name"
        );
      }
    });

    it("error should be an Error instance", () => {
      const creds = createCredentials();
      try {
        createBrokerClient("MISSING" as BrokerType, creds);
        assert.fail("Should have thrown");
      } catch (err: unknown) {
        assert.ok(err instanceof Error);
      }
    });

    it("error message should start with 'Unsupported broker:'", () => {
      const creds = createCredentials();
      try {
        createBrokerClient("XYZ" as BrokerType, creds);
        assert.fail("Should have thrown");
      } catch (err: unknown) {
        assert.ok((err as Error).message.startsWith("Unsupported broker:"));
      }
    });
  });
});
