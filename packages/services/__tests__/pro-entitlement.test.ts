/**
 * MONEY-866 — buildProEntitlementFields: the PRO downgrade-anchor shared by all
 * three grant paths (Dodo webhook, payments callback, updateSubscriptionPlan).
 * The callback + changePlan-upgrade + coupon-grant paths previously wrote NO
 * entitlement, so a later downgrade from a higher tier collapsed to FREE instead
 * of falling back to the PRO the user paid for.
 *
 * Source: packages/services/src/subscription-logic.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildProEntitlementFields } from "../src/subscription-logic.ts";

const NOW = new Date("2026-06-24T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("MONEY-866 buildProEntitlementFields — PRO grant sets its own anchor", () => {
  it("PRO annual → annual entitlement, +365d end", () => {
    const f = buildProEntitlementFields({
      resolvedPlan: "PRO",
      period: "annual",
      now: NOW,
    });
    assert.equal(f.proEntitlementType, "annual");
    assert.equal(f.proEntitlementStartDate?.getTime(), NOW.getTime());
    assert.equal(f.proEntitlementEndDate?.getTime(), NOW.getTime() + 365 * DAY);
  });

  it("PRO monthly → monthly entitlement, +30d end", () => {
    const f = buildProEntitlementFields({
      resolvedPlan: "PRO",
      period: "monthly",
      now: NOW,
    });
    assert.equal(f.proEntitlementType, "monthly");
    assert.equal(f.proEntitlementEndDate?.getTime(), NOW.getTime() + 30 * DAY);
  });

  it("PRO unknown/missing period → monthly (NEVER the deprecated 'lifetime')", () => {
    const f = buildProEntitlementFields({
      resolvedPlan: "PRO",
      period: null,
      now: NOW,
    });
    assert.equal(f.proEntitlementType, "monthly");
    assert.notEqual(f.proEntitlementType, "lifetime");
    assert.notEqual(f.proEntitlementEndDate, null); // never a 10-year null-end cap
  });
});

describe("MONEY-866 buildProEntitlementFields — higher tier preserves the anchor", () => {
  it("PREMIUM preserves an existing PRO entitlement (the downgrade anchor)", () => {
    const existing = {
      proEntitlementType: "annual",
      proEntitlementStartDate: new Date("2026-01-01"),
      proEntitlementEndDate: new Date("2027-01-01"),
    };
    const f = buildProEntitlementFields({
      resolvedPlan: "PREMIUM",
      period: "monthly",
      now: NOW,
      existing,
    });
    assert.equal(f.proEntitlementType, "annual");
    assert.equal(
      f.proEntitlementEndDate?.getTime(),
      existing.proEntitlementEndDate.getTime(),
    );
  });

  it("PREMIUM with no existing PRO entitlement → empty (nothing to preserve)", () => {
    const f = buildProEntitlementFields({
      resolvedPlan: "PREMIUM",
      period: "monthly",
      now: NOW,
      existing: null,
    });
    assert.deepEqual(f, {});
  });

  it("ULTIMATE preserves a grandfathered lifetime PRO (null end kept)", () => {
    const existing = {
      proEntitlementType: "lifetime",
      proEntitlementStartDate: new Date("2025-01-01"),
      proEntitlementEndDate: null,
    };
    const f = buildProEntitlementFields({
      resolvedPlan: "ULTIMATE",
      period: "annual",
      now: NOW,
      existing,
    });
    assert.equal(f.proEntitlementType, "lifetime");
    assert.equal(f.proEntitlementEndDate, null);
  });
});
