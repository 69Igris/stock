/**
 * User SERVICE pure-logic unit tests (MONEY-620).
 *
 * Imports the REAL exported symbols from the service-layer logic module
 * `packages/services/src/user-logic` (via a relative path — the services
 * package is ESM and these tests run under apps/web's CJS tsx loader, so we
 * cannot go through the `@usemoney/services` barrel here without the
 * recording-prisma seam; the sibling `user-poison-live.test.ts` drives the LIVE
 * service through that seam). The production `user.service.ts`
 * (getUserProfile / getCurrencyPreference / updateCurrencyPreference /
 * updateUserSettings / getAccountTrialInfo / getOnboardingState) calls these
 * SAME helpers, so a regression in the security/validation logic fails here too
 * — no shadow.
 *
 * This file also CLOSES the shadow in `__tests__/actions/user.test.ts`, which
 * re-declared `calculateTrialInfo` inline and asserted the copy. That logic is
 * now the real exported `calculateTrialInfo`.
 *
 * Focus: EXHAUSTIVE negative / edge / SECURITY bug-hunt —
 *   • currency allow-list (validation + defaulting; injection/garbage rejected)
 *   • settings PATCH mass-assignment guard (plan/role/credits/__proto__ stripped)
 *   • Invalid-Date guards (no throw on `.toISOString()`)
 *   • trial calc boundaries (the de-shadowed logic)
 *   • onboarding-state derivation (dedupe, non-array, terms gate)
 * Pure → exits clean (no DB/network/timers).
 *
 * Source: packages/services/src/user-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SUPPORTED_CURRENCIES,
  DEFAULT_CURRENCY,
  WRITABLE_USER_SETTINGS_KEYS,
  VALID_DEFAULT_PAGES,
  TRIAL_DAYS,
  isValidCurrency,
  normalizeCurrency,
  isValidDefaultPage,
  sanitizeUserSettingsPatch,
  isValidDate,
  safeIso,
  toUserProfile,
  calculateTrialInfo,
  deriveOnboardingState,
  type UserProfileRow,
} from "../../../../packages/services/src/user-logic";

// ===========================================================================
// isValidCurrency — strict allow-list gate (the REJECT path)
// ===========================================================================

describe("isValidCurrency", () => {
  it("accepts every supported currency verbatim", () => {
    for (const c of SUPPORTED_CURRENCIES) {
      assert.equal(isValidCurrency(c), true, `${c} should be valid`);
    }
    // The exact live allow-list (behaviour-preserving with actions/user.ts).
    assert.deepEqual(
      [...SUPPORTED_CURRENCIES],
      ["INR", "USD", "EUR", "GBP"],
      "allow-list must match the live VALID_CURRENCIES"
    );
  });

  it("is case-SENSITIVE — 'inr'/'Inr'/'usd' are NOT valid", () => {
    assert.equal(isValidCurrency("inr"), false);
    assert.equal(isValidCurrency("Inr"), false);
    assert.equal(isValidCurrency("usd"), false);
  });

  it("is whitespace-SENSITIVE — ' INR ' / 'INR\\n' are NOT valid", () => {
    assert.equal(isValidCurrency(" INR "), false);
    assert.equal(isValidCurrency("INR\n"), false);
    assert.equal(isValidCurrency("INR "), false);
  });

  it("[SECURITY] rejects injection / garbage / unsupported codes", () => {
    for (const bad of [
      "BTC",
      "ETH",
      "'; DROP TABLE users;--",
      "INR'||'1",
      "$ne",
      "INR;USD",
      "rupees",
      "₹",
      "",
      "   ",
    ]) {
      assert.equal(
        isValidCurrency(bad),
        false,
        `${JSON.stringify(bad)} must be rejected`
      );
    }
  });

  it("rejects non-string types (null/undefined/number/object/array)", () => {
    for (const bad of [
      null,
      undefined,
      0,
      123,
      NaN,
      true,
      {},
      { toString: () => "INR" },
      ["INR"],
      Symbol("INR"),
    ]) {
      assert.equal(isValidCurrency(bad), false);
    }
  });
});

// ===========================================================================
// normalizeCurrency — coerce-to-default (the READ / defaulting path)
// ===========================================================================

describe("normalizeCurrency", () => {
  it("returns a valid currency verbatim", () => {
    assert.equal(normalizeCurrency("USD"), "USD");
    assert.equal(normalizeCurrency("INR"), "INR");
    assert.equal(normalizeCurrency("EUR"), "EUR");
    assert.equal(normalizeCurrency("GBP"), "GBP");
  });

  it("[SECURITY] coerces garbage/invalid to the default (never echoes garbage)", () => {
    assert.equal(normalizeCurrency("BTC"), "INR");
    assert.equal(normalizeCurrency("inr"), "INR"); // wrong case → default
    assert.equal(normalizeCurrency(" INR "), "INR"); // padded → default
    assert.equal(normalizeCurrency("'; DROP"), "INR");
    assert.equal(normalizeCurrency(""), "INR");
  });

  it("coerces null/undefined/non-string to the default", () => {
    assert.equal(normalizeCurrency(null), "INR");
    assert.equal(normalizeCurrency(undefined), "INR");
    assert.equal(normalizeCurrency(42), "INR");
    assert.equal(normalizeCurrency({}), "INR");
    assert.equal(normalizeCurrency(["USD"]), "INR");
  });

  it("honours an explicit fallback", () => {
    assert.equal(normalizeCurrency("BTC", "USD"), "USD");
    assert.equal(normalizeCurrency(null, "EUR"), "EUR");
    // a valid value still beats the fallback
    assert.equal(normalizeCurrency("GBP", "USD"), "GBP");
  });

  it("DEFAULT_CURRENCY is INR (matches the Prisma column default)", () => {
    assert.equal(DEFAULT_CURRENCY, "INR");
  });
});

// ===========================================================================
// sanitizeUserSettingsPatch — mass-assignment guard (allow-list)
// ===========================================================================

describe("sanitizeUserSettingsPatch — mass-assignment guard", () => {
  it("passes a legitimate { name, preferredCurrency } patch unchanged", () => {
    const { patch, rejectedKeys } = sanitizeUserSettingsPatch({
      name: "Deep Shaswat",
      preferredCurrency: "USD",
    });
    assert.deepEqual(patch, { name: "Deep Shaswat", preferredCurrency: "USD" });
    assert.deepEqual(rejectedKeys, []);
  });

  it("[SECURITY] strips privileged fields — plan/role/credits/isActive never reach the patch", () => {
    const { patch, rejectedKeys } = sanitizeUserSettingsPatch({
      name: "Mallory",
      plan: "PRO",
      planId: "PRO",
      role: "admin",
      isAdmin: true,
      credits: 999999,
      creditsLimit: 999999,
      creditsUsed: 0,
      isActive: true,
      subscription: { planId: "PRO" },
    });
    // Only the legit name survives.
    assert.deepEqual(patch, { name: "Mallory" });
    // EVERY privileged key is recorded as rejected.
    for (const k of [
      "plan",
      "planId",
      "role",
      "isAdmin",
      "credits",
      "creditsLimit",
      "creditsUsed",
      "isActive",
      "subscription",
    ]) {
      assert.ok(
        rejectedKeys.includes(k),
        `${k} must be rejected (mass-assignment)`
      );
    }
    // The escalation fields are provably absent from the persist-safe object.
    const asRecord = patch as Record<string, unknown>;
    assert.equal("plan" in asRecord, false);
    assert.equal("role" in asRecord, false);
    assert.equal("credits" in asRecord, false);
    assert.equal("isActive" in asRecord, false);
  });

  it("[SECURITY] strips identity fields — id/email/clerkId/termsAcceptedAt cannot be hijacked", () => {
    const { patch, rejectedKeys } = sanitizeUserSettingsPatch({
      id: "victim-id",
      email: "attacker@evil.com",
      clerkId: "user_victim",
      termsAcceptedAt: new Date(0),
      passwordHash: "x",
      preferredCurrency: "INR",
    });
    assert.deepEqual(patch, { preferredCurrency: "INR" });
    for (const k of [
      "id",
      "email",
      "clerkId",
      "termsAcceptedAt",
      "passwordHash",
    ]) {
      assert.ok(rejectedKeys.includes(k), `${k} must be rejected`);
    }
  });

  it("[SECURITY] does not treat a __proto__ / prototype-pollution key as writable", () => {
    // Using a real own-enumerable "__proto__" key requires defineProperty;
    // Object.entries then surfaces it and the allow-list rejects it.
    const evil: Record<string, unknown> = {};
    Object.defineProperty(evil, "__proto__", {
      value: { isAdmin: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    evil.name = "ok";
    const { patch, rejectedKeys } = sanitizeUserSettingsPatch(evil);
    assert.deepEqual(patch, { name: "ok" });
    assert.ok(rejectedKeys.includes("__proto__"));
    // Sanity: the global Object prototype is NOT polluted.
    assert.equal(
      ({} as Record<string, unknown>).isAdmin,
      undefined,
      "Object.prototype must not be polluted"
    );
  });

  it("[SECURITY] rejects a present-but-INVALID preferredCurrency (does not coerce in a bulk patch)", () => {
    const { patch, rejectedKeys } = sanitizeUserSettingsPatch({
      preferredCurrency: "BTC",
    });
    assert.deepEqual(patch, {}); // garbage never persists
    assert.deepEqual(rejectedKeys, ["preferredCurrency"]);
  });

  it("accepts a valid preferredCurrency inside the patch", () => {
    const { patch } = sanitizeUserSettingsPatch({ preferredCurrency: "EUR" });
    assert.deepEqual(patch, { preferredCurrency: "EUR" });
  });

  it("trims name and rejects empty-after-trim / over-long / non-string name", () => {
    assert.deepEqual(sanitizeUserSettingsPatch({ name: "  Deep  " }).patch, {
      name: "Deep",
    });
    // empty after trim → rejected
    {
      const r = sanitizeUserSettingsPatch({ name: "   " });
      assert.deepEqual(r.patch, {});
      assert.deepEqual(r.rejectedKeys, ["name"]);
    }
    // over-long → rejected
    {
      const r = sanitizeUserSettingsPatch({ name: "x".repeat(101) });
      assert.deepEqual(r.patch, {});
      assert.deepEqual(r.rejectedKeys, ["name"]);
    }
    // non-string name → rejected
    {
      const r = sanitizeUserSettingsPatch({ name: 123 });
      assert.deepEqual(r.patch, {});
      assert.deepEqual(r.rejectedKeys, ["name"]);
    }
  });

  it("returns an empty patch (no throw) for non-object / null / array / primitive inputs", () => {
    for (const bad of [null, undefined, 42, "name=x", true, ["name"], NaN]) {
      const r = sanitizeUserSettingsPatch(bad);
      assert.deepEqual(r.patch, {}, `${JSON.stringify(bad)} → empty patch`);
      assert.deepEqual(r.rejectedKeys, []);
    }
  });

  it("the writable allow-list is exactly { name, preferredCurrency, defaultPage }", () => {
    assert.deepEqual([...WRITABLE_USER_SETTINGS_KEYS].sort(), [
      "defaultPage",
      "name",
      "preferredCurrency",
    ]);
  });

  it("a legit { name } patch carries an empty preferences bucket", () => {
    const { patch, preferences, rejectedKeys } = sanitizeUserSettingsPatch({
      name: "Deep",
    });
    assert.deepEqual(patch, { name: "Deep" });
    assert.deepEqual(preferences, {}); // no preference keys submitted
    assert.deepEqual(rejectedKeys, []);
  });
});

// ===========================================================================
// isValidDefaultPage / defaultPage routing — D8 (preferences allow-list)
// ===========================================================================

describe("isValidDefaultPage — strict page-id allow-list", () => {
  it("VALID_DEFAULT_PAGES matches the live web allow-list", () => {
    assert.deepEqual(
      [...VALID_DEFAULT_PAGES],
      ["dashboard", "stocksage"],
      "must match apps/web/lib/actions/user.ts VALID_DEFAULT_PAGES"
    );
  });

  it("accepts every valid page verbatim", () => {
    for (const p of VALID_DEFAULT_PAGES) {
      assert.equal(isValidDefaultPage(p), true, `${p} should be valid`);
    }
  });

  it("[SECURITY] rejects unlisted / garbage / injection page ids", () => {
    for (const bad of [
      "settings",
      "admin",
      "Dashboard", // case-sensitive
      "stocksage ", // padded
      "'; DROP TABLE users;--",
      "$ne",
      "",
      "   ",
    ]) {
      assert.equal(
        isValidDefaultPage(bad),
        false,
        `${JSON.stringify(bad)} must be rejected`
      );
    }
  });

  it("rejects non-string types (null/undefined/number/object/array)", () => {
    for (const bad of [null, undefined, 0, 1, true, {}, ["dashboard"]]) {
      assert.equal(isValidDefaultPage(bad), false);
    }
  });
});

describe("sanitizeUserSettingsPatch — defaultPage routing (D8)", () => {
  it("routes a valid defaultPage into `preferences` (NOT the column patch)", () => {
    for (const page of ["dashboard", "stocksage"] as const) {
      const { patch, preferences, rejectedKeys } = sanitizeUserSettingsPatch({
        defaultPage: page,
      });
      // A JSON-namespaced key must NEVER land in the column-spread patch.
      assert.deepEqual(patch, {});
      assert.equal("defaultPage" in patch, false);
      assert.deepEqual(preferences, { defaultPage: page });
      assert.deepEqual(rejectedKeys, []);
    }
  });

  it("[SECURITY] rejects a present-but-INVALID defaultPage (does not coerce)", () => {
    const { patch, preferences, rejectedKeys } = sanitizeUserSettingsPatch({
      defaultPage: "settings",
    });
    assert.deepEqual(patch, {});
    assert.deepEqual(preferences, {}); // garbage never persists
    assert.deepEqual(rejectedKeys, ["defaultPage"]);
  });

  it("rejects a non-string defaultPage", () => {
    for (const bad of [123, null, true, { page: "dashboard" }]) {
      const r = sanitizeUserSettingsPatch({ defaultPage: bad });
      assert.deepEqual(r.preferences, {});
      assert.deepEqual(r.rejectedKeys, ["defaultPage"]);
    }
  });

  it("splits a mixed patch: columns → patch, defaultPage → preferences", () => {
    const { patch, preferences, rejectedKeys } = sanitizeUserSettingsPatch({
      name: "Deep",
      preferredCurrency: "USD",
      defaultPage: "stocksage",
    });
    assert.deepEqual(patch, { name: "Deep", preferredCurrency: "USD" });
    assert.deepEqual(preferences, { defaultPage: "stocksage" });
    assert.deepEqual(rejectedKeys, []);
  });

  it("[SECURITY] a valid defaultPage alongside privileged keys still strips the privileged ones", () => {
    const { patch, preferences, rejectedKeys } = sanitizeUserSettingsPatch({
      defaultPage: "dashboard",
      plan: "PRO",
      role: "admin",
      isActive: true,
    });
    assert.deepEqual(patch, {});
    assert.deepEqual(preferences, { defaultPage: "dashboard" });
    for (const k of ["plan", "role", "isActive"]) {
      assert.ok(rejectedKeys.includes(k), `${k} must be rejected`);
    }
  });

  it("non-object input yields an empty preferences bucket (no throw)", () => {
    for (const bad of [null, undefined, 42, "x", ["defaultPage"]]) {
      const r = sanitizeUserSettingsPatch(bad);
      assert.deepEqual(r.preferences, {});
      assert.deepEqual(r.patch, {});
    }
  });
});

// ===========================================================================
// isValidDate / safeIso — Invalid-Date guards
// ===========================================================================

describe("isValidDate / safeIso", () => {
  it("isValidDate is true only for a real finite Date", () => {
    assert.equal(isValidDate(new Date("2026-01-01T00:00:00Z")), true);
    assert.equal(isValidDate(new Date(0)), true);
    assert.equal(isValidDate(new Date("not-a-date")), false);
    assert.equal(isValidDate(null), false);
    assert.equal(isValidDate(undefined), false);
    // a string that LOOKS like a date is not a Date instance
    assert.equal(isValidDate("2026-01-01" as unknown as Date), false);
  });

  it("safeIso never throws on an Invalid Date — returns null", () => {
    assert.equal(safeIso(new Date("garbage")), null);
    assert.equal(safeIso(null), null);
    assert.equal(safeIso(undefined), null);
    assert.equal(
      safeIso(new Date("2026-01-02T03:04:05Z")),
      "2026-01-02T03:04:05.000Z"
    );
  });
});

// ===========================================================================
// toUserProfile — profile-shape mapping
// ===========================================================================

describe("toUserProfile", () => {
  const base: UserProfileRow = {
    id: "u1",
    email: "deep@test.com",
    name: "Deep",
    preferredCurrency: "USD",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-02-01T00:00:00Z"),
  };

  it("maps a clean row, ISO-stringifying dates", () => {
    assert.deepEqual(toUserProfile(base), {
      id: "u1",
      email: "deep@test.com",
      name: "Deep",
      preferredCurrency: "USD",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
  });

  it("[SECURITY] normalises a garbage stored currency (never leaks it to the client)", () => {
    const out = toUserProfile({ ...base, preferredCurrency: "BTC" });
    assert.equal(out.preferredCurrency, "INR");
  });

  it("degrades a corrupt createdAt/updatedAt to null instead of throwing", () => {
    const out = toUserProfile({
      ...base,
      createdAt: new Date("nope"),
      updatedAt: new Date("also-nope"),
    });
    assert.equal(out.createdAt, null);
    assert.equal(out.updatedAt, null);
  });

  it("preserves a null name", () => {
    assert.equal(toUserProfile({ ...base, name: null }).name, null);
  });
});

// ===========================================================================
// calculateTrialInfo — the DE-SHADOWED trial logic
// ===========================================================================

describe("calculateTrialInfo (de-shadow of getAccountTrialInfoAction)", () => {
  it("brand-new account → 30 remaining, not expired", () => {
    const t = new Date("2026-06-15T12:00:00Z");
    const r = calculateTrialInfo(new Date("2026-06-15T12:00:00Z"), t);
    assert.equal(r.remainingDays, 30);
    assert.equal(r.isExpired, false);
    assert.equal(r.createdAt, "2026-06-15T12:00:00.000Z");
  });

  it("after 1 full day → 29 remaining", () => {
    const r = calculateTrialInfo(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-02T00:00:00Z")
    );
    assert.equal(r.remainingDays, 29);
    assert.equal(r.isExpired, false);
  });

  it("floors partial days — 23h59m elapsed = 0 days passed", () => {
    const r = calculateTrialInfo(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-01T23:59:59Z")
    );
    assert.equal(r.remainingDays, 30);
    assert.equal(r.isExpired, false);
  });

  it("exactly day 30 → 0 remaining AND expired (>= boundary)", () => {
    const r = calculateTrialInfo(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-07-01T00:00:00Z")
    );
    assert.equal(r.remainingDays, 0);
    assert.equal(r.isExpired, true);
  });

  it("day 29 + 23h → still 1 remaining, not expired", () => {
    const r = calculateTrialInfo(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-30T23:00:00Z")
    );
    assert.equal(r.remainingDays, 1);
    assert.equal(r.isExpired, false);
  });

  it("never produces negative remaining for very old accounts", () => {
    const r = calculateTrialInfo(
      new Date("2020-01-01T00:00:00Z"),
      new Date("2026-06-01T00:00:00Z")
    );
    assert.equal(r.remainingDays, 0);
    assert.ok(r.remainingDays >= 0);
    assert.equal(r.isExpired, true);
  });

  it("[EDGE] Invalid createdAt → fails CLOSED (expired, null timestamp, no throw)", () => {
    const r = calculateTrialInfo(new Date("garbage"), new Date("2026-06-01Z"));
    assert.equal(r.isExpired, true);
    assert.equal(r.remainingDays, 0);
    assert.equal(r.createdAt, null);
  });

  it("[EDGE] null createdAt → expired, null timestamp", () => {
    const r = calculateTrialInfo(null, new Date("2026-06-01Z"));
    assert.equal(r.isExpired, true);
    assert.equal(r.remainingDays, 0);
    assert.equal(r.createdAt, null);
  });

  it("[EDGE] Invalid now → fails closed (does not throw)", () => {
    const r = calculateTrialInfo(
      new Date("2026-06-01T00:00:00Z"),
      new Date("nonsense")
    );
    assert.equal(r.isExpired, true);
    assert.equal(r.remainingDays, 0);
  });

  it("TRIAL_DAYS constant is 30", () => {
    assert.equal(TRIAL_DAYS, 30);
  });
});

// ===========================================================================
// deriveOnboardingState — onboarding flag derivation
// ===========================================================================

describe("deriveOnboardingState", () => {
  it("fully onboarded: terms accepted + current tour seen", () => {
    const s = deriveOnboardingState({
      seenVersions: ["v1-core", "v2-roast"],
      termsAcceptedAt: new Date("2026-01-01Z"),
      currentVersion: "v2-roast",
    });
    assert.deepEqual(s.seenVersions, ["v1-core", "v2-roast"]);
    assert.equal(s.hasAcceptedTerms, true);
    assert.equal(s.hasSeenCurrentWalkthrough, true);
    assert.equal(s.isOnboarded, true);
  });

  it("terms accepted but current tour NOT seen → not onboarded", () => {
    const s = deriveOnboardingState({
      seenVersions: ["v1-core"],
      termsAcceptedAt: new Date("2026-01-01Z"),
      currentVersion: "v2-roast",
    });
    assert.equal(s.hasSeenCurrentWalkthrough, false);
    assert.equal(s.isOnboarded, false);
  });

  it("tour seen but terms NOT accepted (null) → not onboarded", () => {
    const s = deriveOnboardingState({
      seenVersions: ["v2-roast"],
      termsAcceptedAt: null,
      currentVersion: "v2-roast",
    });
    assert.equal(s.hasAcceptedTerms, false);
    assert.equal(s.isOnboarded, false);
  });

  it("brand-new user: empty seen + null terms → nothing onboarded", () => {
    const s = deriveOnboardingState({
      seenVersions: [],
      termsAcceptedAt: null,
      currentVersion: "v2-roast",
    });
    assert.deepEqual(s.seenVersions, []);
    assert.equal(s.hasAcceptedTerms, false);
    assert.equal(s.hasSeenCurrentWalkthrough, false);
    assert.equal(s.isOnboarded, false);
  });

  it("[EDGE] de-duplicates seenVersions", () => {
    const s = deriveOnboardingState({
      seenVersions: ["v1-core", "v1-core", "v2-roast", "v2-roast"],
      termsAcceptedAt: new Date(),
      currentVersion: "v1-core",
    });
    assert.deepEqual(s.seenVersions, ["v1-core", "v2-roast"]);
    assert.equal(s.hasSeenCurrentWalkthrough, true);
  });

  it("[EDGE] filters non-string entries out of a mixed seenVersions array", () => {
    const s = deriveOnboardingState({
      seenVersions: [
        "v1-core",
        42 as unknown as string,
        null as unknown as string,
        { x: 1 } as unknown as string,
        "v2-roast",
      ],
      termsAcceptedAt: new Date(),
      currentVersion: "v1-core",
    });
    assert.deepEqual(s.seenVersions, ["v1-core", "v2-roast"]);
  });

  it("[EDGE] non-array / null / undefined seenVersions → empty list (no throw)", () => {
    for (const bad of [null, undefined, "v1-core", 5, { length: 1 }]) {
      const s = deriveOnboardingState({
        seenVersions: bad as unknown as string[],
        termsAcceptedAt: null,
        currentVersion: "v1-core",
      });
      assert.deepEqual(s.seenVersions, []);
      assert.equal(s.hasSeenCurrentWalkthrough, false);
    }
  });

  it("[EDGE] an Invalid-Date termsAcceptedAt still counts as 'a decision recorded' (!= null)", () => {
    // Matches the live `termsAcceptedAt != null` gate — a stored (even corrupt)
    // value means terms were recorded; we don't re-pop the modal.
    const s = deriveOnboardingState({
      seenVersions: ["v1-core"],
      termsAcceptedAt: new Date("garbage"),
      currentVersion: "v1-core",
    });
    assert.equal(s.hasAcceptedTerms, true);
    assert.equal(s.isOnboarded, true);
  });
});
