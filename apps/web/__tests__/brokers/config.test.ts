/**
 * Broker Configuration Tests
 *
 * Tests for broker configuration utilities.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BROKER_CONFIGS,
  getBrokerConfig,
  getAllBrokerTypes,
  getTier1Brokers,
  getTier2Brokers,
} from "@usemoney/core/brokers";

describe("Broker Configuration", () => {
  describe("BROKER_CONFIGS", () => {
    it("should contain all supported brokers", () => {
      const expectedBrokers = [
        "ZERODHA",
        "UPSTOX",
        "DHAN",
        "FYERS",
        "ANGEL_ONE",
        "GROWW",
        "ICICI",
        "HDFC",
      ];

      for (const broker of expectedBrokers) {
        assert.ok(
          broker in BROKER_CONFIGS,
          `Broker ${broker} should be in BROKER_CONFIGS`
        );
      }
    });

    it("should have valid config structure for each broker", () => {
      for (const [brokerId, config] of Object.entries(BROKER_CONFIGS)) {
        assert.ok(config.id, `${brokerId} should have id`);
        assert.ok(config.name, `${brokerId} should have name`);
        assert.ok(config.displayName, `${brokerId} should have displayName`);
        assert.ok(config.logo, `${brokerId} should have logo`);
        assert.ok(config.authType, `${brokerId} should have authType`);
        assert.ok(config.baseUrl, `${brokerId} should have baseUrl`);
        assert.ok(config.features, `${brokerId} should have features`);
        assert.ok(config.envKeys, `${brokerId} should have envKeys`);
      }
    });

    it("should have valid auth types", () => {
      const validAuthTypes = ["oauth2", "api_key", "totp"];

      for (const [brokerId, config] of Object.entries(BROKER_CONFIGS)) {
        assert.ok(
          validAuthTypes.includes(config.authType),
          `${brokerId} has invalid authType: ${config.authType}`
        );
      }
    });

    it("should have valid feature flags", () => {
      const featureKeys = [
        "holdings",
        "positions",
        "orders",
        "trades",
        "mutualFunds",
        "margins",
      ];

      for (const [brokerId, config] of Object.entries(BROKER_CONFIGS)) {
        for (const feature of featureKeys) {
          assert.ok(
            typeof config.features[feature as keyof typeof config.features] ===
              "boolean",
            `${brokerId}.features.${feature} should be boolean`
          );
        }
      }
    });

    it("should have valid env keys structure", () => {
      for (const [brokerId, config] of Object.entries(BROKER_CONFIGS)) {
        assert.ok(
          typeof config.envKeys.apiKey === "string",
          `${brokerId} should have apiKey env key`
        );
        assert.ok(
          typeof config.envKeys.apiSecret === "string",
          `${brokerId} should have apiSecret env key`
        );
      }
    });
  });

  describe("Zerodha Config", () => {
    const config = BROKER_CONFIGS.ZERODHA;

    it("should have correct id", () => {
      assert.strictEqual(config.id, "ZERODHA");
    });

    it("should have correct display name", () => {
      assert.strictEqual(config.displayName, "Zerodha (Kite)");
    });

    it("should use oauth2 auth", () => {
      assert.strictEqual(config.authType, "oauth2");
    });

    it("should have correct base URL", () => {
      assert.strictEqual(config.baseUrl, "https://api.kite.trade");
    });

    it("should support all features", () => {
      assert.strictEqual(config.features.holdings, true);
      assert.strictEqual(config.features.positions, true);
      assert.strictEqual(config.features.orders, true);
      assert.strictEqual(config.features.trades, true);
      assert.strictEqual(config.features.mutualFunds, true);
      assert.strictEqual(config.features.margins, true);
    });

    it("should have correct env keys", () => {
      assert.strictEqual(config.envKeys.apiKey, "ZERODHA_API_KEY");
      assert.strictEqual(config.envKeys.apiSecret, "ZERODHA_API_SECRET");
      assert.strictEqual(config.envKeys.redirectUri, "ZERODHA_REDIRECT_URI");
    });

    it("should have daily token refresh strategy", () => {
      assert.strictEqual(config.tokenRefreshStrategy, "daily");
    });
  });

  describe("Upstox Config", () => {
    const config = BROKER_CONFIGS.UPSTOX;

    it("should have correct id", () => {
      assert.strictEqual(config.id, "UPSTOX");
    });

    it("should not support mutual funds", () => {
      assert.strictEqual(config.features.mutualFunds, false);
    });

    it("should have extended token validity", () => {
      assert.strictEqual(config.tokenValidity, "1 year");
    });

    it("should have scopes defined", () => {
      assert.ok(Array.isArray(config.scopes));
      assert.ok(config.scopes?.includes("holdings"));
    });
  });

  describe("Dhan Config", () => {
    const config = BROKER_CONFIGS.DHAN;

    it("should use api_key auth", () => {
      assert.strictEqual(config.authType, "api_key");
    });

    it("should not have redirect URI", () => {
      assert.strictEqual(config.envKeys.redirectUri, undefined);
    });

    it("should have 30 day token validity", () => {
      assert.strictEqual(config.tokenValidity, "30 days");
    });
  });

  describe("Angel One Config", () => {
    const config = BROKER_CONFIGS.ANGEL_ONE;

    it("should use totp auth", () => {
      assert.strictEqual(config.authType, "totp");
    });

    it("should not support mutual funds", () => {
      assert.strictEqual(config.features.mutualFunds, false);
    });
  });

  describe("getBrokerConfig", () => {
    it("should return correct config for ZERODHA", () => {
      const config = getBrokerConfig("ZERODHA");
      assert.strictEqual(config.id, "ZERODHA");
      assert.strictEqual(config.displayName, "Zerodha (Kite)");
    });

    it("should return correct config for UPSTOX", () => {
      const config = getBrokerConfig("UPSTOX");
      assert.strictEqual(config.id, "UPSTOX");
    });

    it("should return correct config for DHAN", () => {
      const config = getBrokerConfig("DHAN");
      assert.strictEqual(config.id, "DHAN");
    });

    it("should return correct config for FYERS", () => {
      const config = getBrokerConfig("FYERS");
      assert.strictEqual(config.id, "FYERS");
    });

    it("should return correct config for ANGEL_ONE", () => {
      const config = getBrokerConfig("ANGEL_ONE");
      assert.strictEqual(config.id, "ANGEL_ONE");
    });

    it("should return correct config for GROWW", () => {
      const config = getBrokerConfig("GROWW");
      assert.strictEqual(config.id, "GROWW");
    });

    it("should return correct config for ICICI", () => {
      const config = getBrokerConfig("ICICI");
      assert.strictEqual(config.id, "ICICI");
    });

    it("should return correct config for HDFC", () => {
      const config = getBrokerConfig("HDFC");
      assert.strictEqual(config.id, "HDFC");
    });
  });

  describe("getAllBrokerTypes", () => {
    it("should return all 10 broker types", () => {
      const brokers = getAllBrokerTypes();
      // MONEY-837: ZERODHA_CONNECT (founder-only paid Connect app) is a 10th
      // config entry so the OAuth/config machinery resolves it; sync paths skip it.
      assert.strictEqual(brokers.length, 10);
    });

    it("should include all expected brokers", () => {
      const brokers = getAllBrokerTypes();
      const expected = [
        "ZERODHA",
        "ZERODHA_CONNECT",
        "UPSTOX",
        "DHAN",
        "FYERS",
        "ANGEL_ONE",
        "GROWW",
        "ICICI",
        "HDFC",
        "INTERACTIVE_BROKERS",
      ];

      for (const broker of expected) {
        assert.ok(brokers.includes(broker as any), `Should include ${broker}`);
      }
    });
  });

  describe("getTier1Brokers", () => {
    it("should return 4 tier 1 brokers", () => {
      const brokers = getTier1Brokers();
      assert.strictEqual(brokers.length, 4);
    });

    it("should include ZERODHA, UPSTOX, FYERS, DHAN", () => {
      const brokers = getTier1Brokers();
      assert.ok(brokers.includes("ZERODHA" as any));
      assert.ok(brokers.includes("UPSTOX" as any));
      assert.ok(brokers.includes("FYERS" as any));
      assert.ok(brokers.includes("DHAN" as any));
    });

    it("should not include tier 2 brokers", () => {
      const brokers = getTier1Brokers();
      assert.ok(!brokers.includes("ANGEL_ONE" as any));
      assert.ok(!brokers.includes("GROWW" as any));
      assert.ok(!brokers.includes("ICICI" as any));
      assert.ok(!brokers.includes("HDFC" as any));
    });
  });

  describe("getTier2Brokers", () => {
    it("should return 4 tier 2 brokers", () => {
      const brokers = getTier2Brokers();
      assert.strictEqual(brokers.length, 4);
    });

    it("should include ANGEL_ONE, GROWW, ICICI, HDFC", () => {
      const brokers = getTier2Brokers();
      assert.ok(brokers.includes("ANGEL_ONE" as any));
      assert.ok(brokers.includes("GROWW" as any));
      assert.ok(brokers.includes("ICICI" as any));
      assert.ok(brokers.includes("HDFC" as any));
    });

    it("should not include tier 1 brokers", () => {
      const brokers = getTier2Brokers();
      assert.ok(!brokers.includes("ZERODHA" as any));
      assert.ok(!brokers.includes("UPSTOX" as any));
      assert.ok(!brokers.includes("FYERS" as any));
      assert.ok(!brokers.includes("DHAN" as any));
    });
  });

  describe("Feature Support Matrix", () => {
    it("should have at least 6 brokers supporting holdings", () => {
      const brokers = Object.values(BROKER_CONFIGS).filter(
        (c) => c.features.holdings
      );
      assert.ok(brokers.length >= 6);
    });

    it("should have at least 6 brokers supporting positions", () => {
      const brokers = Object.values(BROKER_CONFIGS).filter(
        (c) => c.features.positions
      );
      assert.ok(brokers.length >= 6);
    });

    it("should have at least 6 brokers supporting trades", () => {
      const brokers = Object.values(BROKER_CONFIGS).filter(
        (c) => c.features.trades
      );
      assert.ok(brokers.length >= 6);
    });

    it("should have at least 2 brokers supporting mutual funds", () => {
      const brokers = Object.values(BROKER_CONFIGS).filter(
        (c) => c.features.mutualFunds
      );
      assert.ok(brokers.length >= 2);
    });
  });
});
