/**
 * Email Preferences Action Tests
 *
 * Exercises the REAL logic behind the email-preference server actions:
 *   - getEffectivePreferences        (@usemoney/email — merge-with-defaults)
 *   - DEFAULT_EMAIL_PREFERENCES      (@usemoney/email — canonical key set)
 *   - validateEmailPreferences       (apps/web/lib/actions/email-preferences-logic.ts)
 *
 * `getEmailPreferencesAction` reads via `getEffectivePreferences`;
 * `updateEmailPreferencesAction` gates on `validateEmailPreferences`. Both are
 * the exact units called by the `"use server"` actions, so the 6-key contract
 * (including `usageAnalytics`) is enforced here — the earlier inline shadow
 * silently omitted `usageAnalytics` and could not catch a missing key.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getEffectivePreferences,
  DEFAULT_EMAIL_PREFERENCES,
  type EmailPreferences,
} from "@usemoney/email";
import {
  validateEmailPreferences,
  EMAIL_PREFERENCE_KEYS,
} from "@/lib/actions/email-preferences-logic";

// Thin simulations of the two actions' deterministic core (post-auth,
// post-DB). They call the SAME real units the actions call, so a regression
// in either propagates here.
function simulateGetPreferences(userEmailPreferences: unknown): {
  success: boolean;
  data?: EmailPreferences;
} {
  return { success: true, data: getEffectivePreferences(userEmailPreferences) };
}

function simulateUpdatePreferences(input: Record<string, unknown>): {
  success: boolean;
  data?: EmailPreferences;
  error?: string;
} {
  const validation = validateEmailPreferences(input);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }
  // Action stores `input` then re-reads via getEffectivePreferences.
  return { success: true, data: getEffectivePreferences(input) };
}

describe("Email Preferences Actions (real logic)", () => {
  describe("Canonical key set", () => {
    it("includes usageAnalytics (the key the inline shadow missed)", () => {
      assert.ok(EMAIL_PREFERENCE_KEYS.includes("usageAnalytics"));
      assert.strictEqual(DEFAULT_EMAIL_PREFERENCES.usageAnalytics, true);
    });

    it("has exactly eight preference keys", () => {
      assert.strictEqual(EMAIL_PREFERENCE_KEYS.length, 8);
    });
  });

  describe("getEmailPreferencesAction (getEffectivePreferences)", () => {
    it("should return defaults for user with null emailPreferences", () => {
      const result = simulateGetPreferences(null);
      assert.equal(result.success, true);
      assert.deepStrictEqual(result.data, DEFAULT_EMAIL_PREFERENCES);
    });

    it("should return defaults for user with undefined emailPreferences", () => {
      const result = simulateGetPreferences(undefined);
      assert.equal(result.success, true);
      assert.deepStrictEqual(result.data, DEFAULT_EMAIL_PREFERENCES);
    });

    it("should return stored preferences merged with defaults", () => {
      const stored = { brokerNotifications: false, tradeAlerts: false };
      const result = simulateGetPreferences(stored);
      assert.equal(result.success, true);
      assert.equal(result.data!.brokerNotifications, false);
      assert.equal(result.data!.tradeAlerts, false);
      assert.equal(result.data!.paymentNotifications, true);
      assert.equal(result.data!.aiInsights, true);
      assert.equal(result.data!.marketingEmails, true);
      // Unspecified key falls back to the default (true).
      assert.equal(result.data!.usageAnalytics, true);
    });

    it("should return fully stored preferences", () => {
      const stored: EmailPreferences = {
        brokerNotifications: false,
        tradeAlerts: true,
        paymentNotifications: false,
        aiInsights: true,
        marketingEmails: false,
        tipsEducation: false,
        partnerOffers: true,
        usageAnalytics: false,
      };
      const result = simulateGetPreferences(stored);
      assert.equal(result.success, true);
      assert.deepStrictEqual(result.data, stored);
    });

    it("should ignore non-boolean stored values and keep defaults", () => {
      const stored = { brokerNotifications: "yes", usageAnalytics: 1 };
      const result = simulateGetPreferences(stored);
      // Non-boolean → default (true) for both.
      assert.equal(result.data!.brokerNotifications, true);
      assert.equal(result.data!.usageAnalytics, true);
    });
  });

  describe("updateEmailPreferencesAction (validateEmailPreferences)", () => {
    it("should validate and return updated preferences", () => {
      const input: EmailPreferences = {
        brokerNotifications: false,
        tradeAlerts: true,
        paymentNotifications: true,
        aiInsights: false,
        marketingEmails: true,
        tipsEducation: true,
        partnerOffers: false,
        usageAnalytics: false,
      };
      const result = simulateUpdatePreferences(
        input as unknown as Record<string, unknown>
      );
      assert.equal(result.success, true);
      assert.deepStrictEqual(result.data, input);
    });

    it("should reject non-boolean values", () => {
      const input = {
        brokerNotifications: "yes",
        tradeAlerts: true,
        paymentNotifications: true,
        aiInsights: true,
        marketingEmails: true,
        usageAnalytics: true,
      };
      const result = simulateUpdatePreferences(input);
      assert.equal(result.success, false);
      assert.ok(result.error?.includes("brokerNotifications"));
    });

    it("should reject a payload missing paymentNotifications", () => {
      const input = {
        brokerNotifications: true,
        tradeAlerts: true,
        // missing paymentNotifications
        aiInsights: true,
        marketingEmails: true,
        usageAnalytics: true,
      };
      const result = simulateUpdatePreferences(input);
      assert.equal(result.success, false);
      assert.ok(result.error?.includes("paymentNotifications"));
    });

    it("should reject a payload missing usageAnalytics (real key set)", () => {
      // This is the regression the inline shadow could NOT catch — it omitted
      // usageAnalytics from its key list, so a missing usageAnalytics passed.
      const input = {
        brokerNotifications: true,
        tradeAlerts: true,
        paymentNotifications: true,
        aiInsights: true,
        marketingEmails: true,
        tipsEducation: true,
        partnerOffers: false,
        // missing usageAnalytics
      };
      const result = simulateUpdatePreferences(input);
      assert.equal(result.success, false);
      assert.ok(result.error?.includes("usageAnalytics"));
    });

    it("should reject null values", () => {
      const input = {
        brokerNotifications: true,
        tradeAlerts: true,
        paymentNotifications: null,
        aiInsights: true,
        marketingEmails: true,
        usageAnalytics: true,
      };
      const result = simulateUpdatePreferences(input);
      assert.equal(result.success, false);
    });

    it("should accept all-false preferences", () => {
      const input: EmailPreferences = {
        brokerNotifications: false,
        tradeAlerts: false,
        paymentNotifications: false,
        aiInsights: false,
        marketingEmails: false,
        tipsEducation: false,
        partnerOffers: false,
        usageAnalytics: false,
      };
      const result = simulateUpdatePreferences(
        input as unknown as Record<string, unknown>
      );
      assert.equal(result.success, true);
      assert.deepStrictEqual(result.data, input);
    });

    it("should accept all-true defaults", () => {
      const result = simulateUpdatePreferences(
        DEFAULT_EMAIL_PREFERENCES as unknown as Record<string, unknown>
      );
      assert.equal(result.success, true);
      assert.deepStrictEqual(result.data, DEFAULT_EMAIL_PREFERENCES);
    });
  });

  describe("validateEmailPreferences (per-key)", () => {
    it("should reject each key independently", () => {
      for (const key of EMAIL_PREFERENCE_KEYS) {
        const input: Record<string, unknown> = {
          ...DEFAULT_EMAIL_PREFERENCES,
        };
        input[key] = "invalid";
        const result = validateEmailPreferences(input);
        assert.equal(result.valid, false, `Should reject invalid ${key}`);
        assert.ok(result.error?.includes(key));
      }
    });

    it("should pass for all boolean values", () => {
      const result = validateEmailPreferences(
        DEFAULT_EMAIL_PREFERENCES as unknown as Record<string, unknown>
      );
      assert.equal(result.valid, true);
      assert.strictEqual(result.error, undefined);
    });
  });
});
