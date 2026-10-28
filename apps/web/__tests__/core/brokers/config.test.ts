/**
 * Broker Configuration Tests (Core Package)
 *
 * Comprehensive tests for broker configuration utilities exported from
 * @usemoney/core/brokers including getBrokerConfig, getBrokerEnvKeys,
 * getAllBrokerTypes, getTier1Brokers, and getTier2Brokers.
 *
 * Uses Node.js native test runner (node:test) and assertions (node:assert/strict).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  BROKER_CONFIGS,
  getBrokerConfig,
  getBrokerEnvKeys,
  getAllBrokerTypes,
  getTier1Brokers,
  getTier2Brokers,
} from "@usemoney/core/brokers";
import type { BrokerType, BrokerConfig } from "@usemoney/types";

// All broker types for iteration
const ALL_BROKER_TYPES: BrokerType[] = [
  "ZERODHA",
  "UPSTOX",
  "DHAN",
  "FYERS",
  "ANGEL_ONE",
  "GROWW",
  "ICICI",
  "HDFC",
  "INTERACTIVE_BROKERS",
];

// Expected tier groupings
const TIER_1_BROKERS: BrokerType[] = ["ZERODHA", "UPSTOX", "FYERS", "DHAN"];
const TIER_2_BROKERS: BrokerType[] = ["ANGEL_ONE", "GROWW", "ICICI", "HDFC"];

// MONEY-837 / MONEY-1065: ZERODHA_CONNECT is a live-data CONNECTOR (founder-only
// paid Kite app for quotes/candles/WS), NOT a portfolio-sync broker — so it is
// deliberately excluded from ALL_BROKER_TYPES (the per-broker holdings/positions/
// orders capability assertions below iterate portfolio brokers only). It IS a
// first-class BROKER_CONFIGS entry, so the config-enumeration assertions count it.
const CONNECTOR_BROKER_TYPES: BrokerType[] = ["ZERODHA_CONNECT"];
const ALL_CONFIGURED_BROKER_TYPES: BrokerType[] = [
  ...ALL_BROKER_TYPES,
  ...CONNECTOR_BROKER_TYPES,
];

// Required fields every broker config must have
const REQUIRED_CONFIG_FIELDS = [
  "id",
  "name",
  "displayName",
  "logo",
  "authType",
  "baseUrl",
  "tokenRefreshStrategy",
  "tokenValidity",
  "features",
  "envKeys",
] as const;

// All feature flags that must be boolean
const FEATURE_FLAGS = [
  "holdings",
  "positions",
  "orders",
  "trades",
  "mutualFunds",
  "margins",
] as const;

// Valid auth types
const VALID_AUTH_TYPES = ["oauth2", "api_key", "totp"] as const;

// Valid token refresh strategies
const VALID_REFRESH_STRATEGIES = [
  "daily",
  "extended",
  "on_expiry",
  "none",
] as const;

// Expected env key mappings per broker
const EXPECTED_ENV_KEYS: Record<
  BrokerType,
  { apiKey: string; apiSecret: string; redirectUri?: string }
> = {
  ZERODHA: {
    apiKey: "ZERODHA_API_KEY",
    apiSecret: "ZERODHA_API_SECRET",
    redirectUri: "ZERODHA_REDIRECT_URI",
  },
  UPSTOX: {
    apiKey: "UPSTOX_API_KEY",
    apiSecret: "UPSTOX_API_SECRET",
    redirectUri: "UPSTOX_REDIRECT_URI",
  },
  DHAN: {
    apiKey: "DHAN_CLIENT_ID",
    apiSecret: "DHAN_ACCESS_TOKEN",
    redirectUri: undefined,
  },
  FYERS: {
    apiKey: "FYERS_APP_ID",
    apiSecret: "FYERS_SECRET_KEY",
    redirectUri: "FYERS_REDIRECT_URI",
  },
  ANGEL_ONE: {
    apiKey: "ANGEL_API_KEY",
    apiSecret: "ANGEL_CLIENT_ID",
    redirectUri: undefined,
  },
  GROWW: {
    apiKey: "GROWW_API_KEY",
    apiSecret: "GROWW_API_SECRET",
    redirectUri: undefined,
  },
  ICICI: {
    apiKey: "ICICI_API_KEY",
    apiSecret: "ICICI_API_SECRET",
    redirectUri: "ICICI_REDIRECT_URI",
  },
  HDFC: {
    apiKey: "HDFC_API_KEY",
    apiSecret: "HDFC_API_SECRET",
    redirectUri: "HDFC_REDIRECT_URI",
  },
  INTERACTIVE_BROKERS: {
    apiKey: "INTERACTIVE_BROKERS_CLIENT_ID",
    apiSecret: "INTERACTIVE_BROKERS_CLIENT_SECRET",
    redirectUri: "INTERACTIVE_BROKERS_REDIRECT_URI",
  },
  // MONEY-837: the paid Connect app MUST carry its own credentials — reusing
  // the free Personal app's ZERODHA_* keys is the failure mode this pins.
  ZERODHA_CONNECT: {
    apiKey: "ZERODHA_CONNECT_API_KEY",
    apiSecret: "ZERODHA_CONNECT_API_SECRET",
    redirectUri: "ZERODHA_CONNECT_REDIRECT_URI",
  },
};

// Expected broker display names
const EXPECTED_DISPLAY_NAMES: Record<BrokerType, string> = {
  ZERODHA: "Zerodha (Kite)",
  UPSTOX: "Upstox",
  DHAN: "Dhan",
  FYERS: "Fyers",
  ANGEL_ONE: "Angel One",
  GROWW: "Groww",
  ICICI: "ICICI Direct",
  HDFC: "HDFC Securities",
  INTERACTIVE_BROKERS: "Interactive Brokers",
  ZERODHA_CONNECT: "Zerodha Connect (live data)",
};

// Expected auth types per broker
const EXPECTED_AUTH_TYPES: Record<BrokerType, string> = {
  ZERODHA: "oauth2",
  UPSTOX: "oauth2",
  DHAN: "api_key",
  FYERS: "oauth2",
  ANGEL_ONE: "totp",
  GROWW: "api_key",
  ICICI: "oauth2",
  HDFC: "oauth2",
  INTERACTIVE_BROKERS: "oauth2",
  ZERODHA_CONNECT: "oauth2",
};

describe("Broker Configuration (Core Package)", () => {
  // ── getBrokerConfig ──────────────────────────────────────────────────

  describe("getBrokerConfig", () => {
    it("should return a valid config for every broker type", () => {
      for (const broker of ALL_BROKER_TYPES) {
        const config = getBrokerConfig(broker);
        assert.ok(config, `getBrokerConfig should return config for ${broker}`);
        assert.strictEqual(
          config.id,
          broker,
          `Config id should match broker type ${broker}`
        );
      }
    });

    it("should return config with correct id for ZERODHA", () => {
      const config = getBrokerConfig("ZERODHA");
      assert.strictEqual(config.id, "ZERODHA");
      assert.strictEqual(config.displayName, "Zerodha (Kite)");
    });

    it("should return config with correct id for UPSTOX", () => {
      const config = getBrokerConfig("UPSTOX");
      assert.strictEqual(config.id, "UPSTOX");
      assert.strictEqual(config.displayName, "Upstox");
    });

    it("should return config with correct id for DHAN", () => {
      const config = getBrokerConfig("DHAN");
      assert.strictEqual(config.id, "DHAN");
      assert.strictEqual(config.displayName, "Dhan");
    });

    it("should return config with correct id for FYERS", () => {
      const config = getBrokerConfig("FYERS");
      assert.strictEqual(config.id, "FYERS");
      assert.strictEqual(config.displayName, "Fyers");
    });

    it("should return config with correct id for ANGEL_ONE", () => {
      const config = getBrokerConfig("ANGEL_ONE");
      assert.strictEqual(config.id, "ANGEL_ONE");
      assert.strictEqual(config.displayName, "Angel One");
    });

    it("should return config with correct id for GROWW", () => {
      const config = getBrokerConfig("GROWW");
      assert.strictEqual(config.id, "GROWW");
      assert.strictEqual(config.displayName, "Groww");
    });

    it("should return config with correct id for ICICI", () => {
      const config = getBrokerConfig("ICICI");
      assert.strictEqual(config.id, "ICICI");
      assert.strictEqual(config.displayName, "ICICI Direct");
    });

    it("should return config with correct id for HDFC", () => {
      const config = getBrokerConfig("HDFC");
      assert.strictEqual(config.id, "HDFC");
      assert.strictEqual(config.displayName, "HDFC Securities");
    });

    it("should return the same reference as BROKER_CONFIGS for each broker", () => {
      for (const broker of ALL_BROKER_TYPES) {
        const config = getBrokerConfig(broker);
        assert.strictEqual(
          config,
          BROKER_CONFIGS[broker],
          `getBrokerConfig(${broker}) should return reference from BROKER_CONFIGS`
        );
      }
    });

    it("should return correct display name for every broker", () => {
      for (const broker of ALL_CONFIGURED_BROKER_TYPES) {
        const config = getBrokerConfig(broker);
        assert.strictEqual(
          config.displayName,
          EXPECTED_DISPLAY_NAMES[broker],
          `${broker} displayName mismatch`
        );
      }
    });

    it("should return correct auth type for every broker", () => {
      for (const broker of ALL_CONFIGURED_BROKER_TYPES) {
        const config = getBrokerConfig(broker);
        assert.strictEqual(
          config.authType,
          EXPECTED_AUTH_TYPES[broker],
          `${broker} authType mismatch`
        );
      }
    });
  });

  // ── Required config fields ──────────────────────────────────────────

  describe("Each broker config has required fields", () => {
    for (const broker of ALL_BROKER_TYPES) {
      describe(`${broker} config`, () => {
        const config = getBrokerConfig(broker);

        it("should have a non-empty id", () => {
          assert.ok(config.id, `${broker} should have id`);
          assert.strictEqual(typeof config.id, "string");
        });

        it("should have a non-empty name", () => {
          assert.ok(config.name, `${broker} should have name`);
          assert.strictEqual(typeof config.name, "string");
        });

        it("should have a non-empty displayName", () => {
          assert.ok(config.displayName, `${broker} should have displayName`);
          assert.strictEqual(typeof config.displayName, "string");
        });

        it("should have a non-empty logo path", () => {
          assert.ok(config.logo, `${broker} should have logo`);
          assert.strictEqual(typeof config.logo, "string");
          assert.ok(
            config.logo.startsWith("/brokers/"),
            `${broker} logo should start with /brokers/`
          );
        });

        it("should have a valid authType", () => {
          assert.ok(config.authType, `${broker} should have authType`);
          assert.ok(
            (VALID_AUTH_TYPES as readonly string[]).includes(config.authType),
            `${broker} has invalid authType: ${config.authType}`
          );
        });

        it("should have a non-empty baseUrl starting with https", () => {
          assert.ok(config.baseUrl, `${broker} should have baseUrl`);
          assert.ok(
            config.baseUrl.startsWith("https://"),
            `${broker} baseUrl should start with https://`
          );
        });

        it("should have a valid tokenRefreshStrategy", () => {
          assert.ok(
            config.tokenRefreshStrategy,
            `${broker} should have tokenRefreshStrategy`
          );
          assert.ok(
            (VALID_REFRESH_STRATEGIES as readonly string[]).includes(
              config.tokenRefreshStrategy
            ),
            `${broker} has invalid tokenRefreshStrategy: ${config.tokenRefreshStrategy}`
          );
        });

        it("should have a non-empty tokenValidity", () => {
          assert.ok(
            config.tokenValidity,
            `${broker} should have tokenValidity`
          );
          assert.strictEqual(typeof config.tokenValidity, "string");
        });

        it("should have features object with all boolean flags", () => {
          assert.ok(config.features, `${broker} should have features`);
          for (const flag of FEATURE_FLAGS) {
            assert.strictEqual(
              typeof config.features[flag],
              "boolean",
              `${broker}.features.${flag} should be boolean`
            );
          }
        });

        it("should have envKeys with apiKey and apiSecret strings", () => {
          assert.ok(config.envKeys, `${broker} should have envKeys`);
          assert.strictEqual(
            typeof config.envKeys.apiKey,
            "string",
            `${broker}.envKeys.apiKey should be a string`
          );
          assert.ok(
            config.envKeys.apiKey.length > 0,
            `${broker}.envKeys.apiKey should not be empty`
          );
          assert.strictEqual(
            typeof config.envKeys.apiSecret,
            "string",
            `${broker}.envKeys.apiSecret should be a string`
          );
          assert.ok(
            config.envKeys.apiSecret.length > 0,
            `${broker}.envKeys.apiSecret should not be empty`
          );
        });

        it("should have correct env key names", () => {
          const expected = EXPECTED_ENV_KEYS[broker];
          assert.strictEqual(
            config.envKeys.apiKey,
            expected.apiKey,
            `${broker} envKeys.apiKey mismatch`
          );
          assert.strictEqual(
            config.envKeys.apiSecret,
            expected.apiSecret,
            `${broker} envKeys.apiSecret mismatch`
          );
          assert.strictEqual(
            config.envKeys.redirectUri,
            expected.redirectUri,
            `${broker} envKeys.redirectUri mismatch`
          );
        });
      });
    }
  });

  // ── OAuth2 brokers should have auth/token URLs ──────────────────────

  describe("OAuth2 brokers have auth and token URLs", () => {
    const oauth2Brokers = ALL_BROKER_TYPES.filter(
      (b) => getBrokerConfig(b).authType === "oauth2"
    );

    for (const broker of oauth2Brokers) {
      it(`${broker} should have authUrl and tokenUrl`, () => {
        const config = getBrokerConfig(broker);
        assert.ok(
          config.authUrl,
          `OAuth2 broker ${broker} should have authUrl`
        );
        assert.ok(
          config.authUrl!.startsWith("https://"),
          `${broker} authUrl should start with https://`
        );
        assert.ok(
          config.tokenUrl,
          `OAuth2 broker ${broker} should have tokenUrl`
        );
        assert.ok(
          config.tokenUrl!.startsWith("https://"),
          `${broker} tokenUrl should start with https://`
        );
      });

      it(`${broker} should have redirectUri env key`, () => {
        const config = getBrokerConfig(broker);
        assert.ok(
          config.envKeys.redirectUri,
          `OAuth2 broker ${broker} should have envKeys.redirectUri`
        );
      });
    }
  });

  // ── Non-OAuth2 brokers should not require redirect URI ──────────────

  describe("Non-OAuth2 brokers should not have redirectUri", () => {
    const nonOauth2Brokers = ALL_BROKER_TYPES.filter(
      (b) => getBrokerConfig(b).authType !== "oauth2"
    );

    for (const broker of nonOauth2Brokers) {
      it(`${broker} should not have redirectUri env key`, () => {
        const config = getBrokerConfig(broker);
        assert.strictEqual(
          config.envKeys.redirectUri,
          undefined,
          `Non-OAuth2 broker ${broker} should not have envKeys.redirectUri`
        );
      });
    }
  });

  // ── getBrokerEnvKeys ────────────────────────────────────────────────

  describe("getBrokerEnvKeys", () => {
    // Save and restore env vars around tests
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      // Save current env state for all broker env keys
      for (const broker of ALL_BROKER_TYPES) {
        const config = BROKER_CONFIGS[broker];
        savedEnv[config.envKeys.apiKey] = process.env[config.envKeys.apiKey];
        savedEnv[config.envKeys.apiSecret] =
          process.env[config.envKeys.apiSecret];
        if (config.envKeys.redirectUri) {
          savedEnv[config.envKeys.redirectUri] =
            process.env[config.envKeys.redirectUri];
        }
      }
    });

    afterEach(() => {
      // Restore env state
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });

    it("should return an object with apiKey and apiSecret properties for every broker", () => {
      for (const broker of ALL_BROKER_TYPES) {
        const envKeys = getBrokerEnvKeys(broker);
        assert.ok(
          "apiKey" in envKeys,
          `getBrokerEnvKeys(${broker}) should have apiKey`
        );
        assert.ok(
          "apiSecret" in envKeys,
          `getBrokerEnvKeys(${broker}) should have apiSecret`
        );
      }
    });

    it("should return empty strings when env vars are not set", () => {
      // Clear relevant env vars
      delete process.env.ZERODHA_API_KEY;
      delete process.env.ZERODHA_API_SECRET;
      delete process.env.ZERODHA_REDIRECT_URI;

      const envKeys = getBrokerEnvKeys("ZERODHA");
      assert.strictEqual(envKeys.apiKey, "");
      assert.strictEqual(envKeys.apiSecret, "");
    });

    it("should return actual env var values when set", () => {
      process.env.ZERODHA_API_KEY = "test_api_key_123";
      process.env.ZERODHA_API_SECRET = "test_api_secret_456";
      process.env.ZERODHA_REDIRECT_URI = "https://example.com/callback";

      const envKeys = getBrokerEnvKeys("ZERODHA");
      assert.strictEqual(envKeys.apiKey, "test_api_key_123");
      assert.strictEqual(envKeys.apiSecret, "test_api_secret_456");
      assert.strictEqual(envKeys.redirectUri, "https://example.com/callback");
    });

    it("should return undefined for redirectUri when broker does not support it", () => {
      const envKeys = getBrokerEnvKeys("DHAN");
      assert.strictEqual(
        envKeys.redirectUri,
        undefined,
        "DHAN should not have redirectUri"
      );
    });

    it("should return undefined for redirectUri when broker does not support it (ANGEL_ONE)", () => {
      const envKeys = getBrokerEnvKeys("ANGEL_ONE");
      assert.strictEqual(
        envKeys.redirectUri,
        undefined,
        "ANGEL_ONE should not have redirectUri"
      );
    });

    it("should return undefined for redirectUri when broker does not support it (GROWW)", () => {
      const envKeys = getBrokerEnvKeys("GROWW");
      assert.strictEqual(
        envKeys.redirectUri,
        undefined,
        "GROWW should not have redirectUri"
      );
    });

    it("should read UPSTOX env vars correctly", () => {
      process.env.UPSTOX_API_KEY = "upstox_key";
      process.env.UPSTOX_API_SECRET = "upstox_secret";
      process.env.UPSTOX_REDIRECT_URI = "https://upstox.callback.com";

      const envKeys = getBrokerEnvKeys("UPSTOX");
      assert.strictEqual(envKeys.apiKey, "upstox_key");
      assert.strictEqual(envKeys.apiSecret, "upstox_secret");
      assert.strictEqual(envKeys.redirectUri, "https://upstox.callback.com");
    });

    it("should read FYERS env vars correctly", () => {
      process.env.FYERS_APP_ID = "fyers_app";
      process.env.FYERS_SECRET_KEY = "fyers_secret";
      process.env.FYERS_REDIRECT_URI = "https://fyers.callback.com";

      const envKeys = getBrokerEnvKeys("FYERS");
      assert.strictEqual(envKeys.apiKey, "fyers_app");
      assert.strictEqual(envKeys.apiSecret, "fyers_secret");
      assert.strictEqual(envKeys.redirectUri, "https://fyers.callback.com");
    });

    it("should read DHAN env vars correctly", () => {
      process.env.DHAN_CLIENT_ID = "dhan_client";
      process.env.DHAN_ACCESS_TOKEN = "dhan_token";

      const envKeys = getBrokerEnvKeys("DHAN");
      assert.strictEqual(envKeys.apiKey, "dhan_client");
      assert.strictEqual(envKeys.apiSecret, "dhan_token");
      assert.strictEqual(envKeys.redirectUri, undefined);
    });
  });

  // ── getAllBrokerTypes ────────────────────────────────────────────────

  describe("getAllBrokerTypes", () => {
    it("should return all 10 configured broker types (9 portfolio + 1 connector)", () => {
      const brokers = getAllBrokerTypes();
      assert.strictEqual(brokers.length, 10);
    });

    it("should return an array", () => {
      const brokers = getAllBrokerTypes();
      assert.ok(Array.isArray(brokers));
    });

    it("should include every expected broker", () => {
      const brokers = getAllBrokerTypes();
      for (const expected of ALL_BROKER_TYPES) {
        assert.ok(
          brokers.includes(expected),
          `getAllBrokerTypes() should include ${expected}`
        );
      }
    });

    it("should not include any unknown broker types", () => {
      const brokers = getAllBrokerTypes();
      for (const broker of brokers) {
        assert.ok(
          ALL_CONFIGURED_BROKER_TYPES.includes(broker),
          `Unknown broker type found: ${broker}`
        );
      }
    });

    it("should not have duplicate entries", () => {
      const brokers = getAllBrokerTypes();
      const unique = new Set(brokers);
      assert.strictEqual(
        unique.size,
        brokers.length,
        "getAllBrokerTypes should not have duplicates"
      );
    });

    it("should match the keys of BROKER_CONFIGS", () => {
      const brokers = getAllBrokerTypes();
      const configKeys = Object.keys(BROKER_CONFIGS);
      assert.deepStrictEqual(
        brokers.sort(),
        configKeys.sort(),
        "getAllBrokerTypes should match BROKER_CONFIGS keys"
      );
    });
  });

  // ── getTier1Brokers ─────────────────────────────────────────────────

  describe("getTier1Brokers", () => {
    it("should return exactly 4 brokers", () => {
      const brokers = getTier1Brokers();
      assert.strictEqual(brokers.length, 4);
    });

    it("should return ZERODHA, UPSTOX, FYERS, DHAN", () => {
      const brokers = getTier1Brokers();
      for (const expected of TIER_1_BROKERS) {
        assert.ok(
          brokers.includes(expected),
          `Tier 1 should include ${expected}`
        );
      }
    });

    it("should not include any tier 2 brokers", () => {
      const brokers = getTier1Brokers();
      for (const tier2 of TIER_2_BROKERS) {
        assert.ok(
          !brokers.includes(tier2),
          `Tier 1 should not include ${tier2}`
        );
      }
    });

    it("should not have duplicate entries", () => {
      const brokers = getTier1Brokers();
      const unique = new Set(brokers);
      assert.strictEqual(unique.size, brokers.length);
    });

    it("should return only valid broker types", () => {
      const brokers = getTier1Brokers();
      for (const broker of brokers) {
        assert.ok(
          ALL_BROKER_TYPES.includes(broker),
          `Tier 1 broker ${broker} should be a valid broker type`
        );
      }
    });

    it("should be a subset of getAllBrokerTypes", () => {
      const tier1 = getTier1Brokers();
      const all = getAllBrokerTypes();
      for (const broker of tier1) {
        assert.ok(
          all.includes(broker),
          `Tier 1 broker ${broker} should be in getAllBrokerTypes`
        );
      }
    });
  });

  // ── getTier2Brokers ─────────────────────────────────────────────────

  describe("getTier2Brokers", () => {
    it("should return exactly 4 brokers", () => {
      const brokers = getTier2Brokers();
      assert.strictEqual(brokers.length, 4);
    });

    it("should return ANGEL_ONE, GROWW, ICICI, HDFC", () => {
      const brokers = getTier2Brokers();
      for (const expected of TIER_2_BROKERS) {
        assert.ok(
          brokers.includes(expected),
          `Tier 2 should include ${expected}`
        );
      }
    });

    it("should not include any tier 1 brokers", () => {
      const brokers = getTier2Brokers();
      for (const tier1 of TIER_1_BROKERS) {
        assert.ok(
          !brokers.includes(tier1),
          `Tier 2 should not include ${tier1}`
        );
      }
    });

    it("should not have duplicate entries", () => {
      const brokers = getTier2Brokers();
      const unique = new Set(brokers);
      assert.strictEqual(unique.size, brokers.length);
    });

    it("should return only valid broker types", () => {
      const brokers = getTier2Brokers();
      for (const broker of brokers) {
        assert.ok(
          ALL_BROKER_TYPES.includes(broker),
          `Tier 2 broker ${broker} should be a valid broker type`
        );
      }
    });

    it("should be a subset of getAllBrokerTypes", () => {
      const tier2 = getTier2Brokers();
      const all = getAllBrokerTypes();
      for (const broker of tier2) {
        assert.ok(
          all.includes(broker),
          `Tier 2 broker ${broker} should be in getAllBrokerTypes`
        );
      }
    });
  });

  // ── Tier completeness ───────────────────────────────────────────────

  describe("Tier completeness", () => {
    it("tier 1 and tier 2 together should be a subset of all brokers", () => {
      const tier1 = getTier1Brokers();
      const tier2 = getTier2Brokers();
      const all = getAllBrokerTypes();
      for (const broker of [...tier1, ...tier2]) {
        assert.ok(
          all.includes(broker),
          `Tiered broker ${broker} should be in getAllBrokerTypes`
        );
      }
    });

    it("tier 1 and tier 2 should not overlap", () => {
      const tier1 = new Set(getTier1Brokers());
      const tier2 = getTier2Brokers();
      for (const broker of tier2) {
        assert.ok(
          !tier1.has(broker),
          `${broker} should not appear in both tiers`
        );
      }
    });
  });

  // ── Feature support matrix ──────────────────────────────────────────

  describe("Feature support matrix", () => {
    it("all brokers should support holdings", () => {
      for (const broker of ALL_BROKER_TYPES) {
        const config = getBrokerConfig(broker);
        assert.strictEqual(
          config.features.holdings,
          true,
          `${broker} should support holdings`
        );
      }
    });

    it("all brokers should support positions", () => {
      for (const broker of ALL_BROKER_TYPES) {
        const config = getBrokerConfig(broker);
        assert.strictEqual(
          config.features.positions,
          true,
          `${broker} should support positions`
        );
      }
    });

    it("all brokers should support orders", () => {
      for (const broker of ALL_BROKER_TYPES) {
        const config = getBrokerConfig(broker);
        assert.strictEqual(
          config.features.orders,
          true,
          `${broker} should support orders`
        );
      }
    });

    it("all brokers should support trades", () => {
      for (const broker of ALL_BROKER_TYPES) {
        const config = getBrokerConfig(broker);
        assert.strictEqual(
          config.features.trades,
          true,
          `${broker} should support trades`
        );
      }
    });

    it("ZERODHA should support mutual funds", () => {
      assert.strictEqual(getBrokerConfig("ZERODHA").features.mutualFunds, true);
    });

    it("GROWW should support mutual funds", () => {
      assert.strictEqual(getBrokerConfig("GROWW").features.mutualFunds, true);
    });

    it("ICICI should support mutual funds", () => {
      assert.strictEqual(getBrokerConfig("ICICI").features.mutualFunds, true);
    });

    it("HDFC should support mutual funds", () => {
      assert.strictEqual(getBrokerConfig("HDFC").features.mutualFunds, true);
    });

    it("UPSTOX should not support mutual funds", () => {
      assert.strictEqual(getBrokerConfig("UPSTOX").features.mutualFunds, false);
    });

    it("DHAN should not support mutual funds", () => {
      assert.strictEqual(getBrokerConfig("DHAN").features.mutualFunds, false);
    });

    it("FYERS should not support mutual funds", () => {
      assert.strictEqual(getBrokerConfig("FYERS").features.mutualFunds, false);
    });

    it("ANGEL_ONE should not support mutual funds", () => {
      assert.strictEqual(
        getBrokerConfig("ANGEL_ONE").features.mutualFunds,
        false
      );
    });

    it("INTERACTIVE_BROKERS should not support mutual funds", () => {
      assert.strictEqual(
        getBrokerConfig("INTERACTIVE_BROKERS").features.mutualFunds,
        false
      );
    });

    it("at least 4 brokers should support mutual funds", () => {
      const mfBrokers = ALL_BROKER_TYPES.filter(
        (b) => getBrokerConfig(b).features.mutualFunds
      );
      assert.ok(
        mfBrokers.length >= 4,
        `Expected at least 4 MF-supporting brokers, got ${mfBrokers.length}`
      );
    });

    it("GROWW should not support margins", () => {
      assert.strictEqual(getBrokerConfig("GROWW").features.margins, false);
    });

    it("at least 7 brokers should support margins", () => {
      const marginBrokers = ALL_BROKER_TYPES.filter(
        (b) => getBrokerConfig(b).features.margins
      );
      assert.ok(
        marginBrokers.length >= 7,
        `Expected at least 7 margin-supporting brokers, got ${marginBrokers.length}`
      );
    });
  });

  // ── Specific broker properties ──────────────────────────────────────

  describe("Specific broker properties", () => {
    it("ZERODHA should have daily token refresh and 1 day validity", () => {
      const config = getBrokerConfig("ZERODHA");
      assert.strictEqual(config.tokenRefreshStrategy, "daily");
      assert.strictEqual(config.tokenValidity, "1 day");
    });

    it("UPSTOX should have extended token refresh and 1 year validity", () => {
      const config = getBrokerConfig("UPSTOX");
      assert.strictEqual(config.tokenRefreshStrategy, "extended");
      assert.strictEqual(config.tokenValidity, "1 year");
    });

    it("UPSTOX should have scopes defined", () => {
      const config = getBrokerConfig("UPSTOX");
      assert.ok(Array.isArray(config.scopes), "UPSTOX should have scopes");
      assert.ok(config.scopes!.includes("holdings"));
      assert.ok(config.scopes!.includes("positions"));
      assert.ok(config.scopes!.includes("orders"));
    });

    it("DHAN should have no token refresh and 30 days validity", () => {
      const config = getBrokerConfig("DHAN");
      assert.strictEqual(config.tokenRefreshStrategy, "none");
      assert.strictEqual(config.tokenValidity, "30 days");
    });

    it("FYERS should have on_expiry token refresh and 1 day validity", () => {
      const config = getBrokerConfig("FYERS");
      assert.strictEqual(config.tokenRefreshStrategy, "on_expiry");
      assert.strictEqual(config.tokenValidity, "1 day");
    });

    it("ANGEL_ONE should have daily token refresh", () => {
      const config = getBrokerConfig("ANGEL_ONE");
      assert.strictEqual(config.tokenRefreshStrategy, "daily");
      assert.strictEqual(config.tokenValidity, "1 day");
    });

    it("GROWW should have no token refresh and 1-day validity (expires 6AM IST)", () => {
      const config = getBrokerConfig("GROWW");
      assert.strictEqual(config.tokenRefreshStrategy, "none");
      assert.strictEqual(config.tokenValidity, "1 day (expires 6AM IST)");
    });
  });

  // ── BROKER_CONFIGS object ───────────────────────────────────────────

  describe("BROKER_CONFIGS", () => {
    it("should contain exactly 10 entries", () => {
      assert.strictEqual(Object.keys(BROKER_CONFIGS).length, 10);
    });

    it("should contain all supported brokers", () => {
      for (const broker of ALL_BROKER_TYPES) {
        assert.ok(
          broker in BROKER_CONFIGS,
          `BROKER_CONFIGS should contain ${broker}`
        );
      }
    });

    it("each config id should match its key", () => {
      for (const [key, config] of Object.entries(BROKER_CONFIGS)) {
        assert.strictEqual(
          config.id,
          key,
          `Config id (${config.id}) should match key (${key})`
        );
      }
    });

    it("each config name should be lowercase", () => {
      for (const [key, config] of Object.entries(BROKER_CONFIGS)) {
        assert.strictEqual(
          config.name,
          config.name.toLowerCase(),
          `${key} name should be lowercase`
        );
      }
    });

    it("each config logo should end with .png", () => {
      for (const [key, config] of Object.entries(BROKER_CONFIGS)) {
        assert.ok(
          config.logo.endsWith(".png"),
          `${key} logo should end with .png`
        );
      }
    });
  });
});
