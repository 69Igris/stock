/**
 * Subscription Entitlement Tests (MONEY-620) — DE-SHADOWED.
 *
 * The previous version reimplemented isProEntitlementExpired, isRecurringPlan,
 * resolveGracePeriodExpiry and calculateProDowngradeEndDate INLINE and asserted
 * the copies — a shadow (its inline PLAN_CONFIG had drifted: ULTIMATE price
 * 1999, PREMIUM annual 9999). It tested nothing in the real code path.
 *
 * This rewrite imports and asserts the REAL exported entitlement logic from
 * `packages/services/src/subscription-logic.ts` (the pure module the live
 * `subscription.service.ts` CALLS — `isProEntitlementExpired` now delegates to
 * it, and `getSubscription`'s grace-expiry decision is `resolveEntitlementPlan`).
 * So production and these tests run the SAME code.
 *
 * The PRO-entitlement webhook-builder helpers (buildProEntitlementFields /
 * preserveProEntitlement) live in the Dodo webhook route, not the subscription
 * service, and are covered by the webhook e2e tests — out of scope here.
 *
 * Source: packages/services/src/subscription-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isProEntitlementExpired,
  isRecurringPlan,
  resolveEntitlementPlan,
  getEffectivePlan,
  calculateGracePeriodEndDate,
  type EntitlementInput,
} from "../../../../packages/services/src/subscription-logic";

// ── isProEntitlementExpired (real export) ────────────────────────────

describe("Subscription Entitlement: isProEntitlementExpired", () => {
  it("lifetime within 10 years -> not expired", () => {
    assert.equal(
      isProEntitlementExpired(
        {
          proEntitlementType: "lifetime",
          proEntitlementStartDate: new Date("2025-01-01"),
        },
        new Date("2030-06-15")
      ),
      false
    );
  });

  it("lifetime past 10 years -> expired", () => {
    assert.equal(
      isProEntitlementExpired(
        {
          proEntitlementType: "lifetime",
          proEntitlementStartDate: new Date("2025-01-01"),
        },
        new Date("2036-01-02")
      ),
      true
    );
  });

  it("annual future end -> not expired; past end -> expired", () => {
    assert.equal(
      isProEntitlementExpired(
        {
          proEntitlementType: "annual",
          proEntitlementEndDate: new Date("2026-01-01"),
        },
        new Date("2025-06-15")
      ),
      false
    );
    assert.equal(
      isProEntitlementExpired(
        {
          proEntitlementType: "annual",
          proEntitlementEndDate: new Date("2026-01-01"),
        },
        new Date("2026-06-15")
      ),
      true
    );
  });

  it("monthly future end -> not expired; past end -> expired", () => {
    assert.equal(
      isProEntitlementExpired(
        {
          proEntitlementType: "monthly",
          proEntitlementEndDate: new Date("2025-01-31"),
        },
        new Date("2025-01-15")
      ),
      false
    );
    assert.equal(
      isProEntitlementExpired(
        {
          proEntitlementType: "monthly",
          proEntitlementEndDate: new Date("2025-01-31"),
        },
        new Date("2025-02-15")
      ),
      true
    );
  });

  it("no type / missing lifetime-start / Invalid-Date end -> expired (fail closed)", () => {
    assert.equal(isProEntitlementExpired({ proEntitlementType: null }), true);
    assert.equal(
      isProEntitlementExpired({
        proEntitlementType: "lifetime",
        proEntitlementStartDate: null,
      }),
      true
    );
    assert.equal(
      isProEntitlementExpired({
        proEntitlementType: "annual",
        proEntitlementEndDate: new Date("garbage"),
      }),
      true
    );
  });
});

// ── isRecurringPlan (real export) ────────────────────────────────────

describe("Subscription Entitlement: isRecurringPlan", () => {
  it("PRO recurs only with monthly/annual billing (lifetime PRO does not)", () => {
    assert.equal(isRecurringPlan("PRO", "annual"), true);
    assert.equal(isRecurringPlan("PRO", "monthly"), true);
    assert.equal(isRecurringPlan("PRO", null), false);
  });

  it("PREMIUM & ULTIMATE always recur", () => {
    assert.equal(isRecurringPlan("PREMIUM", null), true);
    assert.equal(isRecurringPlan("PREMIUM", "annual"), true);
    assert.equal(isRecurringPlan("ULTIMATE", null), true);
  });

  it("FREE / QUERY_PACK never recur", () => {
    assert.equal(isRecurringPlan("FREE", null), false);
    assert.equal(isRecurringPlan("QUERY_PACK", null), false);
  });
});

// ── grace-period expiry resolution (real export) ─────────────────────

describe("Subscription Entitlement: resolveEntitlementPlan grace fallback", () => {
  function sub(over: Partial<EntitlementInput> = {}): EntitlementInput {
    return {
      planId: "PREMIUM",
      status: "ACTIVE",
      endDate: new Date("2025-06-01"),
      ...over,
    };
  }
  const after = new Date("2025-07-01"); // past the grace endDate

  it("PREMIUM grace ended + lifetime PRO entitlement -> falls back to PRO (endDate null)", () => {
    const r = resolveEntitlementPlan(
      sub({
        proEntitlementType: "lifetime",
        proEntitlementStartDate: new Date("2025-01-01"),
      }),
      after
    );
    assert.equal(r.plan, "PRO");
    assert.equal(r.reason, "grace-expired-to-pro");
  });

  it("PREMIUM grace ended + valid annual PRO entitlement -> PRO", () => {
    const r = resolveEntitlementPlan(
      sub({
        proEntitlementType: "annual",
        proEntitlementStartDate: new Date("2025-01-01"),
        proEntitlementEndDate: new Date("2026-01-01"),
      }),
      after
    );
    assert.equal(r.plan, "PRO");
  });

  it("PREMIUM grace ended + EXPIRED PRO entitlement -> FREE", () => {
    const r = resolveEntitlementPlan(
      sub({
        proEntitlementType: "annual",
        proEntitlementStartDate: new Date("2024-01-01"),
        proEntitlementEndDate: new Date("2025-01-01"),
      }),
      after
    );
    assert.equal(r.plan, "FREE");
    assert.equal(r.reason, "grace-expired-to-free");
  });

  it("PREMIUM grace ended + NO PRO entitlement -> FREE", () => {
    const r = resolveEntitlementPlan(sub({ proEntitlementType: null }), after);
    assert.equal(r.plan, "FREE");
  });

  it("[BYPASS] EXPIRED-status PREMIUM grants nothing -> FREE regardless of entitlement", () => {
    assert.equal(
      getEffectivePlan(
        sub({
          status: "EXPIRED",
          proEntitlementType: "lifetime",
          proEntitlementStartDate: new Date("2025-01-01"),
        }),
        after
      ),
      "FREE"
    );
  });

  it("PRO whose grace ended never self-promotes to PRO -> FREE", () => {
    assert.equal(
      getEffectivePlan(
        sub({
          planId: "PRO",
          proEntitlementType: "lifetime",
          proEntitlementStartDate: new Date("2025-01-01"),
        }),
        after
      ),
      "FREE"
    );
  });
});

// ── grace-period end-date math for PRO/PREMIUM (real export) ──────────

describe("Subscription Entitlement: calculateGracePeriodEndDate", () => {
  it("PRO downgrade legacy path = start + 1 year", () => {
    const end = calculateGracePeriodEndDate(
      "PRO",
      null,
      new Date("2025-06-01T00:00:00.000Z")
    )!;
    assert.equal(end.getUTCFullYear(), 2026);
    assert.equal(end.getUTCMonth(), 5); // June
  });

  it("PREMIUM annual = +1y, monthly = +1mo", () => {
    const start = new Date("2025-01-01T00:00:00.000Z");
    assert.equal(
      calculateGracePeriodEndDate("PREMIUM", "annual", start)!.getUTCFullYear(),
      2026
    );
    assert.equal(
      calculateGracePeriodEndDate("PREMIUM", "monthly", start)!.getUTCMonth(),
      1 // Feb
    );
  });

  it("FREE -> null (immediate, no grace)", () => {
    assert.equal(
      calculateGracePeriodEndDate("FREE", null, new Date("2025-01-01")),
      null
    );
  });
});
