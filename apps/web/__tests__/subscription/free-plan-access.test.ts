/**
 * Free Plan Access Tests (MONEY-295)
 *
 * Verifies the FEATURE_ACCESS map + DEFAULT_FREE_ACCESS now allow FREE
 * users on `aiQueries`, while still gating premium features. Catches
 * regressions where a future change re-excludes FREE from aiQueries.
 *
 * Source:
 *   - packages/core/src/subscription/features.ts
 *   - apps/web/lib/subscription/access.ts (DEFAULT_FREE_ACCESS)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FEATURE_ACCESS,
  hasFeatureAccess,
} from "../../../../packages/core/src/subscription/features";

describe("subscription: FEATURE_ACCESS - FREE plan", () => {
  it("FREE has aiQueries (Flash chat free + 5 research credits)", () => {
    assert.equal(hasFeatureAccess("FREE", "aiQueries"), true);
  });

  it("FREE has fireCalculator + paperTrading + manualTradebook", () => {
    assert.equal(hasFeatureAccess("FREE", "fireCalculator"), true);
    assert.equal(hasFeatureAccess("FREE", "paperTrading"), true);
    assert.equal(hasFeatureAccess("FREE", "manualTradebook"), true);
    assert.equal(hasFeatureAccess("FREE", "basicPortfolio"), true);
    assert.equal(hasFeatureAccess("FREE", "brokerSync"), true);
  });

  it("FREE does NOT have premium features", () => {
    assert.equal(hasFeatureAccess("FREE", "aiStrategies"), false);
    assert.equal(hasFeatureAccess("FREE", "aiLearning"), false);
    assert.equal(hasFeatureAccess("FREE", "stockDiscovery"), false);
    assert.equal(hasFeatureAccess("FREE", "unlimitedConnections"), false);
    assert.equal(hasFeatureAccess("FREE", "portfolioRoast"), false);
    assert.equal(hasFeatureAccess("FREE", "taxAnalysis"), false);
    assert.equal(hasFeatureAccess("FREE", "riskAnalysis"), false);
    assert.equal(hasFeatureAccess("FREE", "documentVault"), false);
  });

  it("PRO + PREMIUM + ULTIMATE retain aiQueries", () => {
    assert.equal(hasFeatureAccess("PRO", "aiQueries"), true);
    assert.equal(hasFeatureAccess("PREMIUM", "aiQueries"), true);
    assert.equal(hasFeatureAccess("ULTIMATE", "aiQueries"), true);
  });

  it("aiQueries list includes FREE - guards against regression", () => {
    assert.ok(
      FEATURE_ACCESS.aiQueries.includes("FREE"),
      "FREE must be in aiQueries to unblock the chat - see MONEY-295 deepdive"
    );
  });
});
