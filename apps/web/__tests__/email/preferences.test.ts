/**
 * Email Preferences Tests — REAL source (packages/email/src/preferences.ts via
 * `@usemoney/email`).
 *
 * De-shadowed (MONEY-620): the previous file re-implemented
 * `getEffectivePreferences` / `shouldSendEmail` / `buildUnsubscribeUrl` and a
 * COPY of `DEFAULT_EMAIL_PREFERENCES` / `EMAIL_CATEGORY_MAP` inline. This
 * imports the REAL exports.
 *
 * Divergence the shadow hid: the real `DEFAULT_EMAIL_PREFERENCES` has SIX keys
 * — it added `usageAnalytics` (PostHog consent) — but the shadow's copy had
 * only five and its "exactly 5 preference keys" test stayed green against the
 * stale copy. Corrected to 6 below.
 *
 * `buildUnsubscribeUrl` builds an HMAC token (env `EMAIL_UNSUBSCRIBE_SECRET`)
 * and uses `APP_URL` (env `NEXT_PUBLIC_APP_URL`); both are resolved at module
 * load, so env is set in `before()` and the module is `await import`ed after.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

const TEST_SECRET = "test-secret-for-email-preferences";
const TEST_APP_URL = "https://usemoney.ai";

interface EmailPreferences {
  brokerNotifications: boolean;
  tradeAlerts: boolean;
  paymentNotifications: boolean;
  aiInsights: boolean;
  marketingEmails: boolean;
  tipsEducation: boolean;
  partnerOffers: boolean;
  usageAnalytics: boolean;
}

let getEffectivePreferences: (raw: unknown) => EmailPreferences;
let shouldSendEmail: (prefs: EmailPreferences, template: string) => boolean;
let buildUnsubscribeUrl: (
  email: string,
  category: keyof EmailPreferences
) => string;
let DEFAULT_EMAIL_PREFERENCES: EmailPreferences;
let EMAIL_CATEGORY_MAP: Record<string, keyof EmailPreferences>;

before(async () => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = TEST_SECRET;
  process.env.NEXT_PUBLIC_APP_URL = TEST_APP_URL;
  const mod = await import("@usemoney/email");
  getEffectivePreferences = mod.getEffectivePreferences;
  shouldSendEmail = mod.shouldSendEmail;
  buildUnsubscribeUrl = mod.buildUnsubscribeUrl;
  DEFAULT_EMAIL_PREFERENCES = mod.DEFAULT_EMAIL_PREFERENCES;
  EMAIL_CATEGORY_MAP = mod.EMAIL_CATEGORY_MAP;
});

describe("Email Preferences (real @usemoney/email)", () => {
  describe("getEffectivePreferences", () => {
    it("should return all defaults for null input", () => {
      const prefs = getEffectivePreferences(null);
      assert.deepStrictEqual(prefs, DEFAULT_EMAIL_PREFERENCES);
    });

    it("should return all defaults for undefined input", () => {
      const prefs = getEffectivePreferences(undefined);
      assert.deepStrictEqual(prefs, DEFAULT_EMAIL_PREFERENCES);
    });

    it("should return all defaults for non-object input", () => {
      assert.deepStrictEqual(
        getEffectivePreferences("string"),
        DEFAULT_EMAIL_PREFERENCES
      );
      assert.deepStrictEqual(
        getEffectivePreferences(42),
        DEFAULT_EMAIL_PREFERENCES
      );
      assert.deepStrictEqual(
        getEffectivePreferences(true),
        DEFAULT_EMAIL_PREFERENCES
      );
    });

    it("should return all defaults for empty object", () => {
      const prefs = getEffectivePreferences({});
      assert.deepStrictEqual(prefs, DEFAULT_EMAIL_PREFERENCES);
    });

    it("should merge partial preferences with defaults", () => {
      const prefs = getEffectivePreferences({ brokerNotifications: false });
      assert.equal(prefs.brokerNotifications, false);
      assert.equal(prefs.tradeAlerts, true);
      assert.equal(prefs.paymentNotifications, true);
      assert.equal(prefs.aiInsights, true);
      assert.equal(prefs.marketingEmails, true);
      assert.equal(prefs.usageAnalytics, true);
    });

    it("should handle all preferences set to false", () => {
      const prefs = getEffectivePreferences({
        brokerNotifications: false,
        tradeAlerts: false,
        paymentNotifications: false,
        aiInsights: false,
        marketingEmails: false,
        usageAnalytics: false,
      });
      assert.equal(prefs.brokerNotifications, false);
      assert.equal(prefs.tradeAlerts, false);
      assert.equal(prefs.paymentNotifications, false);
      assert.equal(prefs.aiInsights, false);
      assert.equal(prefs.marketingEmails, false);
      assert.equal(prefs.usageAnalytics, false);
    });

    it("should handle full preferences object", () => {
      const input: EmailPreferences = {
        brokerNotifications: true,
        tradeAlerts: false,
        paymentNotifications: true,
        aiInsights: false,
        marketingEmails: true,
        tipsEducation: false,
        partnerOffers: true,
        usageAnalytics: false,
      };
      const prefs = getEffectivePreferences(input);
      assert.deepStrictEqual(prefs, input);
    });

    it("should ignore non-boolean values", () => {
      const prefs = getEffectivePreferences({
        brokerNotifications: "yes",
        tradeAlerts: 1,
        paymentNotifications: null,
        aiInsights: undefined,
        marketingEmails: false,
      });
      assert.equal(prefs.brokerNotifications, true); // default
      assert.equal(prefs.tradeAlerts, true); // default
      assert.equal(prefs.paymentNotifications, true); // default
      assert.equal(prefs.aiInsights, true); // default
      assert.equal(prefs.marketingEmails, false); // actual boolean
    });

    it("should ignore unknown keys", () => {
      const prefs = getEffectivePreferences({
        unknownKey: false,
        brokerNotifications: false,
      });
      assert.equal(prefs.brokerNotifications, false);
      assert.equal(
        (prefs as unknown as Record<string, unknown>)["unknownKey"],
        undefined
      );
    });

    it("should not mutate the module's default object", () => {
      const prefs = getEffectivePreferences({ brokerNotifications: false });
      prefs.brokerNotifications = true;
      // The shared DEFAULT_EMAIL_PREFERENCES must remain unchanged (returns a copy)
      assert.equal(DEFAULT_EMAIL_PREFERENCES.brokerNotifications, true);
    });
  });

  describe("shouldSendEmail", () => {
    let allEnabled: EmailPreferences;
    let allDisabled: EmailPreferences;
    const ALWAYS_SEND = [
      "welcome",
      "account-deleted",
      "newsletter-verify",
      "newsletter-welcome",
    ];

    before(() => {
      allEnabled = { ...DEFAULT_EMAIL_PREFERENCES };
      allDisabled = {
        brokerNotifications: false,
        tradeAlerts: false,
        paymentNotifications: false,
        aiInsights: false,
        marketingEmails: false,
        tipsEducation: false,
        partnerOffers: false,
        usageAnalytics: false,
      };
    });

    it("should return true for ALWAYS_SEND templates regardless of preferences", () => {
      for (const template of ALWAYS_SEND) {
        assert.equal(
          shouldSendEmail(allDisabled, template),
          true,
          `${template} should always send`
        );
      }
    });

    it("should return true for unknown templates", () => {
      assert.equal(shouldSendEmail(allDisabled, "unknown-template"), true);
      assert.equal(shouldSendEmail(allDisabled, "something-new"), true);
    });

    it("should check brokerNotifications for broker templates", () => {
      const templates = [
        "broker-connected",
        "broker-disconnected",
        "sync-complete",
      ];
      for (const template of templates) {
        assert.equal(
          shouldSendEmail(allEnabled, template),
          true,
          `${template} with enabled`
        );
        assert.equal(
          shouldSendEmail(allDisabled, template),
          false,
          `${template} with disabled`
        );
      }
    });

    it("should check tradeAlerts for trade templates", () => {
      const templates = ["trade-import-complete", "trade-import-failed"];
      for (const template of templates) {
        assert.equal(shouldSendEmail(allEnabled, template), true);
        assert.equal(shouldSendEmail(allDisabled, template), false);
      }
    });

    it("should check paymentNotifications for payment templates", () => {
      const templates = [
        "payment-success",
        "payment-failed",
        "subscription-renewed",
        "subscription-cancelled",
      ];
      for (const template of templates) {
        assert.equal(shouldSendEmail(allEnabled, template), true);
        assert.equal(shouldSendEmail(allDisabled, template), false);
      }
    });

    it("should check aiInsights for AI templates", () => {
      assert.equal(shouldSendEmail(allEnabled, "ai-query-limit"), true);
      assert.equal(shouldSendEmail(allDisabled, "ai-query-limit"), false);
    });

    it("should respect individual preference toggles", () => {
      const mixed: EmailPreferences = {
        brokerNotifications: false,
        tradeAlerts: true,
        paymentNotifications: false,
        aiInsights: true,
        marketingEmails: false,
        tipsEducation: true,
        partnerOffers: false,
        usageAnalytics: true,
      };
      assert.equal(shouldSendEmail(mixed, "broker-connected"), false);
      assert.equal(shouldSendEmail(mixed, "trade-import-complete"), true);
      assert.equal(shouldSendEmail(mixed, "payment-success"), false);
      assert.equal(shouldSendEmail(mixed, "ai-query-limit"), true);
    });
  });

  describe("EMAIL_CATEGORY_MAP", () => {
    it("should map all broker templates to brokerNotifications", () => {
      assert.equal(
        EMAIL_CATEGORY_MAP["broker-connected"],
        "brokerNotifications"
      );
      assert.equal(
        EMAIL_CATEGORY_MAP["broker-disconnected"],
        "brokerNotifications"
      );
      assert.equal(EMAIL_CATEGORY_MAP["sync-complete"], "brokerNotifications");
    });

    it("should map all trade templates to tradeAlerts", () => {
      assert.equal(EMAIL_CATEGORY_MAP["trade-import-complete"], "tradeAlerts");
      assert.equal(EMAIL_CATEGORY_MAP["trade-import-failed"], "tradeAlerts");
    });

    it("should map all payment templates to paymentNotifications", () => {
      assert.equal(
        EMAIL_CATEGORY_MAP["payment-success"],
        "paymentNotifications"
      );
      assert.equal(
        EMAIL_CATEGORY_MAP["payment-failed"],
        "paymentNotifications"
      );
      assert.equal(
        EMAIL_CATEGORY_MAP["subscription-renewed"],
        "paymentNotifications"
      );
      assert.equal(
        EMAIL_CATEGORY_MAP["subscription-cancelled"],
        "paymentNotifications"
      );
    });

    it("should map AI template to aiInsights", () => {
      assert.equal(EMAIL_CATEGORY_MAP["ai-query-limit"], "aiInsights");
    });

    it("should have 10 total mappings", () => {
      assert.equal(Object.keys(EMAIL_CATEGORY_MAP).length, 10);
    });
  });

  describe("buildUnsubscribeUrl", () => {
    it("should build a valid URL with all parameters", () => {
      const url = buildUnsubscribeUrl(
        "test@example.com",
        "brokerNotifications"
      );
      assert.ok(url.startsWith(TEST_APP_URL));
      assert.ok(url.includes("/api/email/preferences/unsubscribe?"));
      assert.ok(url.includes("email=test%40example.com"));
      assert.ok(url.includes("category=brokerNotifications"));
      assert.ok(url.includes("token="));
    });

    it("should lowercase the email", () => {
      const url = buildUnsubscribeUrl("Test@EXAMPLE.com", "tradeAlerts");
      assert.ok(url.includes("email=test%40example.com"));
    });

    it("should trim whitespace from email", () => {
      const url = buildUnsubscribeUrl("  test@example.com  ", "aiInsights");
      assert.ok(url.includes("email=test%40example.com"));
    });

    it("should generate deterministic URLs for same email", () => {
      const url1 = buildUnsubscribeUrl(
        "test@example.com",
        "brokerNotifications"
      );
      const url2 = buildUnsubscribeUrl(
        "test@example.com",
        "brokerNotifications"
      );
      assert.equal(url1, url2);
    });

    it("should generate different URLs for different categories", () => {
      const url1 = buildUnsubscribeUrl(
        "test@example.com",
        "brokerNotifications"
      );
      const url2 = buildUnsubscribeUrl("test@example.com", "tradeAlerts");
      assert.notEqual(url1, url2); // same token but different category param
    });

    it("should generate different tokens for different emails", () => {
      const url1 = buildUnsubscribeUrl(
        "user1@example.com",
        "brokerNotifications"
      );
      const url2 = buildUnsubscribeUrl(
        "user2@example.com",
        "brokerNotifications"
      );

      const token1 = new URL(url1).searchParams.get("token");
      const token2 = new URL(url2).searchParams.get("token");
      assert.notEqual(token1, token2);
    });

    it("should handle all valid categories", () => {
      const categories: Array<keyof EmailPreferences> = [
        "brokerNotifications",
        "tradeAlerts",
        "paymentNotifications",
        "aiInsights",
        "marketingEmails",
        "usageAnalytics",
      ];
      for (const category of categories) {
        const url = buildUnsubscribeUrl("test@example.com", category);
        assert.ok(
          url.includes(`category=${category}`),
          `Missing category ${category}`
        );
      }
    });
  });

  describe("DEFAULT_EMAIL_PREFERENCES", () => {
    it("should have all preferences enabled by default", () => {
      assert.equal(DEFAULT_EMAIL_PREFERENCES.brokerNotifications, true);
      assert.equal(DEFAULT_EMAIL_PREFERENCES.tradeAlerts, true);
      assert.equal(DEFAULT_EMAIL_PREFERENCES.paymentNotifications, true);
      assert.equal(DEFAULT_EMAIL_PREFERENCES.aiInsights, true);
      assert.equal(DEFAULT_EMAIL_PREFERENCES.marketingEmails, true);
      assert.equal(DEFAULT_EMAIL_PREFERENCES.usageAnalytics, true);
    });

    it("should have exactly 8 preference keys (incl. tips & partner)", () => {
      assert.equal(Object.keys(DEFAULT_EMAIL_PREFERENCES).length, 8);
    });
  });
});
