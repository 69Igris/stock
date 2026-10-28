/**
 * ensureSubscription self-heal tests (MONEY-295)
 *
 * Bug 4: FREE plan users with subscription.status !== "ACTIVE" (stale state from
 * a prior PRO/PREMIUM that didn't reset on downgrade) were locked out of all
 * credit-gated features. ensureSubscription self-heals BOTH creditsLimit drift
 * and FREE-plan status drift.
 *
 * De-shadowed (MONEY-620): previously this file re-implemented `decideHeal`
 * inline with a hand-written `PLAN_CREDITS` map whose values had DRIFTED from
 * production (it had PRO=200/PREMIUM=500/ULTIMATE=1000; the real
 * `getPlanCredits` is PRO=50/PREMIUM=200/ULTIMATE=750). It now imports the REAL
 * `decideSubscriptionHeal` from the services credit-logic — the same function
 * `ensureSubscription` in credit.service.ts calls — and feeds it the REAL
 * `getPlanCredits` from `@usemoney/core`, so the assertions track production.
 *
 * Source: packages/services/src/credit-logic.ts (decideSubscriptionHeal)
 *         packages/core/src/subscription/plans.ts (getPlanCredits)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decideSubscriptionHeal } from "../../../../packages/services/src/credit-logic";
import { getPlanCredits } from "@usemoney/core/subscription/plans";

type PlanId = "FREE" | "PRO" | "QUERY_PACK" | "PREMIUM" | "ULTIMATE";
type SubStatus = "ACTIVE" | "CANCELLED" | "EXPIRED" | "PAUSED";

interface Subscription {
  planId: PlanId;
  status: SubStatus;
  creditsLimit: number;
}

/** Mirror of the call ensureSubscription makes: real decision + real credits. */
function decideHeal(existing: Subscription) {
  return decideSubscriptionHeal(existing, getPlanCredits(existing.planId));
}

describe("ensureSubscription self-heal - FREE plan status normalization", () => {
  it("heals FREE + CANCELLED → ACTIVE", () => {
    const result = decideHeal({
      planId: "FREE",
      status: "CANCELLED",
      creditsLimit: getPlanCredits("FREE"),
    });
    assert.equal(result.needsStatusHeal, true);
    assert.equal(result.patch.status, "ACTIVE");
  });

  it("heals FREE + EXPIRED → ACTIVE", () => {
    assert.equal(
      decideHeal({
        planId: "FREE",
        status: "EXPIRED",
        creditsLimit: getPlanCredits("FREE"),
      }).needsStatusHeal,
      true
    );
  });

  it("heals FREE + PAUSED → ACTIVE", () => {
    assert.equal(
      decideHeal({
        planId: "FREE",
        status: "PAUSED",
        creditsLimit: getPlanCredits("FREE"),
      }).needsStatusHeal,
      true
    );
  });

  it("does NOT touch FREE + ACTIVE (no-op)", () => {
    const result = decideHeal({
      planId: "FREE",
      status: "ACTIVE",
      creditsLimit: getPlanCredits("FREE"),
    });
    assert.equal(result.needsStatusHeal, false);
    assert.equal(result.patch.status, undefined);
  });

  it("does NOT touch PRO + CANCELLED (paid plans can legitimately lapse)", () => {
    const result = decideHeal({
      planId: "PRO",
      status: "CANCELLED",
      creditsLimit: getPlanCredits("PRO"),
    });
    assert.equal(result.needsStatusHeal, false);
    assert.equal(result.patch.status, undefined);
  });

  it("does NOT touch PREMIUM + EXPIRED (paid plans can legitimately lapse)", () => {
    assert.equal(
      decideHeal({
        planId: "PREMIUM",
        status: "EXPIRED",
        creditsLimit: getPlanCredits("PREMIUM"),
      }).needsStatusHeal,
      false
    );
  });
});

describe("ensureSubscription self-heal - creditsLimit drift (real getPlanCredits)", () => {
  it("heals FREE creditsLimit=0 up to the real FREE credits", () => {
    const expected = getPlanCredits("FREE");
    const result = decideHeal({
      planId: "FREE",
      status: "ACTIVE",
      creditsLimit: 0,
    });
    assert.equal(result.needsCreditsHeal, true);
    assert.equal(result.patch.creditsLimit, expected);
  });

  it("heals PRO under-limit up to the real PRO credits", () => {
    const expected = getPlanCredits("PRO");
    const result = decideHeal({
      planId: "PRO",
      status: "ACTIVE",
      creditsLimit: expected - 1,
    });
    assert.equal(result.needsCreditsHeal, true);
    assert.equal(result.patch.creditsLimit, expected);
  });

  it("does NOT touch a creditsLimit already at the expected value", () => {
    assert.equal(
      decideHeal({
        planId: "FREE",
        status: "ACTIVE",
        creditsLimit: getPlanCredits("FREE"),
      }).needsCreditsHeal,
      false
    );
  });

  it("does NOT heal credits when expected credits is 0 (QUERY_PACK)", () => {
    // QUERY_PACK has no plan-credit floor → an add-on, not a tier.
    const expected = getPlanCredits("QUERY_PACK");
    if (expected === 0) {
      assert.equal(
        decideHeal({
          planId: "QUERY_PACK",
          status: "ACTIVE",
          creditsLimit: 0,
        }).needsCreditsHeal,
        false
      );
    }
  });
});

describe("ensureSubscription self-heal - combined drift", () => {
  it("heals BOTH creditsLimit AND status when FREE + CANCELLED + creditsLimit=0", () => {
    const expected = getPlanCredits("FREE");
    const result = decideHeal({
      planId: "FREE",
      status: "CANCELLED",
      creditsLimit: 0,
    });
    assert.equal(result.needsCreditsHeal, true);
    assert.equal(result.needsStatusHeal, true);
    assert.equal(result.patch.creditsLimit, expected);
    assert.equal(result.patch.status, "ACTIVE");
  });
});
