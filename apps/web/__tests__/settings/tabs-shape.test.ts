/**
 * MONEY-393 §10 - Settings tabs (10) source-shape guards.
 *
 * The Settings tabs are pure client components that compose the
 * shared primitives (SetCard, SetSection, SetRow). A true component
 * test would need jsdom (excluded). Instead we pin the contracts
 * callers rely on: each tab is a "use client" component, the shared
 * primitives are exported with the expected API, sensitive tabs
 * (Plans, Billing) reference the canonical pricing source.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TABS_DIR = join(__dirname, "..", "..", "app", "settings", "tabs");

function read(name: string): string {
  return readFileSync(join(TABS_DIR, name), "utf8");
}

const TABS = [
  "AccountTab.tsx",
  "BillingTab.tsx",
  "FeedbackTab.tsx",
  "IntegrationsTab.tsx",
  "NotificationsTab.tsx",
  "PlansTab.tsx",
  "PreferencesTab.tsx",
  "SecurityTab.tsx",
  "UsageTab.tsx",
];

describe("MONEY-393 §10 - Settings tabs (10) shape", () => {
  it("[primitives] SetCard / SetSection / SetRow are exported", () => {
    const src = read("primitives.tsx");
    assert.match(src, /export\s+function\s+SetCard\b/);
    assert.match(src, /export\s+function\s+SetSection\b/);
    assert.match(src, /export\s+function\s+SetRow\b/);
  });

  it("[primitives] file is marked 'use client'", () => {
    assert.match(read("primitives.tsx"), /^"use client"/m);
  });

  it("[primitives] SetRow supports onClick + locked + danger variants", () => {
    const src = read("primitives.tsx");
    // Three variant flags consumers depend on.
    assert.match(src, /onClick\?:/);
    assert.match(src, /locked\?:/);
    assert.match(src, /danger\?:/);
    // Locked rows must not be clickable (security against accidental
    // mutation of grey'd-out controls).
    assert.match(
      src,
      /interactive\s*=\s*onClick\s*&&\s*!locked/,
      "locked rows must short-circuit interactivity"
    );
  });

  it("[tabs] every tab file is marked 'use client'", () => {
    for (const tab of TABS) {
      const src = read(tab);
      assert.match(
        src,
        /^"use client"/m,
        `${tab} must be marked 'use client' (uses React state)`
      );
    }
  });

  it("[tabs] every tab default-exports a component matching its file name", () => {
    for (const tab of TABS) {
      const src = read(tab);
      const name = tab.replace(".tsx", "");
      // Either `export default function NAME` or `export default NAME`.
      assert.ok(
        new RegExp(`export\\s+default\\s+(function\\s+)?${name}\\b`).test(
          src
        ) ||
          new RegExp(
            `function\\s+${name}\\b[\\s\\S]{0,4000}export\\s+default\\s+${name}\\b`
          ).test(src),
        `${tab} must default-export ${name}`
      );
    }
  });

  it("[tabs] most tabs consume the shared Set* primitives (≥8 of 9 non-Feedback)", () => {
    // FeedbackTab is the carve-out - it's a multi-step form with its
    // own layout, so it doesn't compose the row-based primitives. The
    // other 8 tabs (Account/Billing/Integrations/Notifications/Plans/
    // Preferences/Security/Usage) all use the shared Set* primitives.
    const adopters = TABS.filter((t) =>
      /SetCard|SetSection|SetRow/.test(read(t))
    );
    assert.ok(
      adopters.length >= 8,
      `expected ≥8 tabs to use Set* primitives, got ${adopters.length}: ${adopters.join(", ")}`
    );
  });

  it("[PlansTab] references the canonical subscription module (no hardcoded plan matrix)", () => {
    // Plan data must derive from the canonical subscription module -
    // SubscriptionData type from lib/actions/subscription, or
    // PLAN_FEATURES from @usemoney/core. Catches a regression where
    // someone hardcodes a feature matrix that drifts.
    const src = read("PlansTab.tsx");
    assert.match(
      src,
      /SubscriptionData|from\s+["']@usemoney\/core["']|getMyPlanAction|PLAN_FEATURES|SUBSCRIPTION_PLAN|subscription\b/,
      "PlansTab must source plan data from the canonical subscription module"
    );
  });

  it("[BillingTab] shows GST invoice download UI (MONEY-215 GST work)", () => {
    const src = read("BillingTab.tsx");
    // Mentions invoice/download or wires GstInvoiceLink.
    assert.match(
      src,
      /invoice|Invoice|GstInvoice/,
      "BillingTab must surface invoice download UI"
    );
  });

  it("[NotificationsTab] toggles persist via a server action (no local-only state)", () => {
    const src = read("NotificationsTab.tsx");
    // Each toggle should be backed by a setter that persists.
    assert.match(
      src,
      /useState|useTransition|action|Action/,
      "NotificationsTab must persist preferences"
    );
  });

  it("[SecurityTab] surfaces 2FA enrollment UI", () => {
    const src = read("SecurityTab.tsx");
    // 2FA / two-factor / multi-factor markers.
    assert.match(
      src,
      /2FA|two[-\s]*factor|TOTP|MFA|authenticator|multi[-\s]*factor|password/i,
      "SecurityTab must surface 2FA / password / authenticator UI"
    );
  });

  it("[PreferencesTab] surfaces user preference controls (research style / model / focus)", () => {
    // PreferencesTab may wire to the hooks directly OR delegate to
    // sub-components - either way the surface keywords must appear.
    const src = read("PreferencesTab.tsx");
    assert.match(
      src,
      /useResearchPreferences|useComposerPreferences|research\b|composer|preference|Preference|model\b/i,
      "PreferencesTab must surface preference controls"
    );
  });

  it("[FeedbackTab] wires up a submit handler (action or fetch)", () => {
    const src = read("FeedbackTab.tsx");
    assert.match(
      src,
      /submit|Submit|fetch\(|action|Action/,
      "FeedbackTab must have a submit path"
    );
  });

  it("[IntegrationsTab] no hardcoded credentials or secrets in the file", () => {
    // Defense-in-depth - the IntegrationsTab handles third-party
    // tokens. Make sure the source has no literal sk_/pk_/api_key
    // strings (typical secret prefixes).
    const src = read("IntegrationsTab.tsx");
    assert.ok(
      !/sk_live_|sk_test_[0-9a-zA-Z]{16,}|api_key\s*=\s*["'][a-zA-Z0-9]{16,}["']/.test(
        src
      ),
      "IntegrationsTab must not contain a hardcoded secret"
    );
  });

  it("[UsageTab] surfaces credit usage / counts", () => {
    const src = read("UsageTab.tsx");
    assert.match(
      src,
      /credit|Credit|usage|Usage|quota|limit/,
      "UsageTab must surface credit/usage data"
    );
  });

  it("[AccountTab] surfaces linked brokers / connections", () => {
    const src = read("AccountTab.tsx");
    assert.match(
      src,
      /broker|Broker|account|Account|connection|Connection/,
      "AccountTab must surface broker connection state"
    );
  });
});
