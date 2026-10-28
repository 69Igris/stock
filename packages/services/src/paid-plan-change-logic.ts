/**
 * Paid plan-change routing (MONEY-865, Issue #4).
 *
 * Decides HOW a paid plan change reaches Dodo so we never open a SECOND active
 * subscription for a customer who already has one (the "could not start
 * checkout" failure on PRO → PREMIUM). Pure + deterministic so the routing and
 * the discount math — flat OR percent (up to 100), monthly OR annual — are
 * unit-tested without a Dodo sandbox.
 *
 * @see docs/architecture/MONEY-865-paid-tier-change.md
 */
import { couponFinalPrice, type CouponDiscountShape } from "./coupon-logic";

/** Plan tier ordering — drives the upgrade vs downgrade classification. */
const PLAN_TIER: Record<string, number> = {
  FREE: 0,
  PRO: 1,
  PREMIUM: 2,
  ULTIMATE: 3,
};

/** Tier rank of a plan id; an unknown plan reads as FREE-level (0). */
export function planTier(plan: string | null | undefined): number {
  return plan ? (PLAN_TIER[plan] ?? 0) : 0;
}

export type PaidChangeRoute =
  // No active Dodo sub (FREE / coupon-grant / lapsed) → create-new + Dodo
  // checkout page. Unchanged from today.
  | "checkout"
  // Existing active Dodo sub + an UPGRADE → modify it in place via
  // subscriptions.changePlan. THE FIX: no second subscription is created.
  | "change-plan"
  // Existing active Dodo sub + a DOWNGRADE → schedule at term end. Unchanged.
  | "scheduled-downgrade";

export interface PaidChangeDecision {
  route: PaidChangeRoute;
  isUpgrade: boolean;
  /** Target plan list price for the chosen cycle, pre-discount, floored at 0. */
  listPrice: number;
  /** Price after the coupon (flat or percent up to 100, floored at 0). */
  finalPrice: number;
  /**
   * Discount covers the whole price → the change must NOT raise a charge (the
   * changePlan is a pure entitlement move, e.g. a 100% / flat-≥-price coupon).
   */
  fullyCovered: boolean;
}

export interface PaidChangeInput {
  currentPlan: string;
  /** The current subscription's billing cycle — for same-tier cycle changes. */
  currentBillingPeriod?: string | null;
  /** True ONLY when the user has an ACTIVE, non-FREE Dodo subscription. */
  hasActiveDodoSub: boolean;
  targetPlan: string;
  /** The selected target billing cycle — for same-tier cycle changes. */
  targetBillingPeriod?: string | null;
  /** The target plan's list price for the SELECTED cycle (monthly OR annual). */
  targetListPrice: number;
  /** Validated coupon (or null). Handles both flat and percent kinds. */
  coupon?: CouponDiscountShape | null;
}

/**
 * Route a paid plan change AND compute its discounted price. Cycle-agnostic: the
 * caller passes the correct per-cycle `targetListPrice` (e.g. ₹249 vs ₹1,999),
 * so monthly and annual both flow through identically.
 */
export function decidePaidPlanChange(
  input: PaidChangeInput,
): PaidChangeDecision {
  const isUpgrade = planTier(input.targetPlan) > planTier(input.currentPlan);

  // MONEY-866: a SAME-tier change to a different billing cycle (e.g. PRO-monthly
  // → PRO-annual) is a CYCLE CHANGE — it must modify the existing subscription in
  // place via changePlan, NOT fall through to create a SECOND Dodo subscription.
  // `isUpgrade` is false for same-tier, so without this it routed to
  // "scheduled-downgrade" and the action then created a duplicate sub.
  // MONEY-872: but route in place ONLY for the cycle UPGRADE direction
  // (monthly → annual). The reverse, annual → monthly, is a cycle DOWNGRADE — it
  // must be SCHEDULED at term end like any downgrade; an immediate change-plan
  // would raise a prorated charge to move the customer to a CHEAPER cycle.
  const isSameTierCycleUpgrade =
    input.targetPlan === input.currentPlan &&
    input.currentBillingPeriod === "monthly" &&
    input.targetBillingPeriod === "annual";

  const listPrice = Math.max(
    0,
    Number.isFinite(input.targetListPrice) ? input.targetListPrice : 0,
  );
  const finalPrice = input.coupon
    ? couponFinalPrice(listPrice, input.coupon).finalPrice
    : listPrice;
  const fullyCovered = finalPrice <= 0;

  let route: PaidChangeRoute;
  if (!input.hasActiveDodoSub) {
    route = "checkout";
  } else if (isUpgrade || isSameTierCycleUpgrade) {
    route = "change-plan";
  } else {
    route = "scheduled-downgrade";
  }

  return { route, isUpgrade, listPrice, finalPrice, fullyCovered };
}
