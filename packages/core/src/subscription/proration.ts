/**
 * Plan-change proration helpers (MONEY-482).
 *
 * All math here uses LIST prices (originalMonthlyPrice / originalAnnualPrice
 * on `packages/core/plans.ts`), never the launch-offer prices. List price
 * is the stable contract value; using the discounted price would create
 * perverse incentives (upgrading today gets you more days than tomorrow
 * if the marketing discount changes).
 *
 * Rounding convention: `Math.ceil` everywhere for bonus days. Any non-zero
 * residual credit yields at least one full bonus day — generous to the
 * user, predictable for the business.
 */

import type { PlanConfig } from "./plans";

export type BillingCycle = "monthly" | "annual";

/** Standard term lengths in days. */
export const STANDARD_TERM_DAYS: Record<BillingCycle, number> = {
  monthly: 30,
  annual: 365,
};

/**
 * Days remaining on a current subscription term.
 * Clamped to 0 to avoid negative bonus when the record is stale.
 */
export function daysRemaining(
  now: Date,
  currentPeriodEnd: Date | null | undefined,
): number {
  if (!currentPeriodEnd) return 0;
  const ms = currentPeriodEnd.getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

/**
 * Per-day list price for a (plan, cycle) pair.
 *
 * Returns null if the requested cycle has no list price configured —
 * e.g. FREE plan or PRO Lifetime (handled separately by the caller).
 */
export function listPricePerDay(
  plan: Pick<PlanConfig, "monthlyOriginalPrice" | "annualOriginalPrice">,
  cycle: BillingCycle,
): number | null {
  if (cycle === "monthly") {
    const p = plan.monthlyOriginalPrice;
    return typeof p === "number" && p > 0
      ? p / STANDARD_TERM_DAYS.monthly
      : null;
  }
  const p = plan.annualOriginalPrice;
  return typeof p === "number" && p > 0 ? p / STANDARD_TERM_DAYS.annual : null;
}

export interface TierUpgradeInput {
  /** The user's current tier plan (e.g. PLAN_CONFIG.PRO). */
  fromPlan: Pick<PlanConfig, "monthlyOriginalPrice" | "annualOriginalPrice">;
  /** The cycle the user is currently on. */
  fromCycle: BillingCycle;
  /** The user's target tier plan (e.g. PLAN_CONFIG.PREMIUM). */
  toPlan: Pick<PlanConfig, "monthlyOriginalPrice" | "annualOriginalPrice">;
  /** The cycle the user is upgrading to (can differ from fromCycle). */
  toCycle: BillingCycle;
  /** Days remaining on the current subscription. Non-negative integer. */
  daysRemainingOnCurrent: number;
}

export interface TierUpgradeResult {
  /** Rupee credit value of the unused current-term time, at list price. */
  remainingCredit: number;
  /** Per-day list price on the target plan + cycle. */
  newPerDayRate: number;
  /** Bonus days added to the new term. Math.ceil — minimum 1 if credit > 0. */
  bonusDays: number;
  /** Total term length: standardTerm(toCycle) + bonusDays. */
  totalTermDays: number;
}

/**
 * Tier UPGRADE (Pro → Premium): convert remaining current-term value to
 * bonus days on the new plan.
 *
 *   remainingCredit  = daysRemaining × listPricePerDay(from, fromCycle)
 *   bonusDays        = Math.ceil(remainingCredit / listPricePerDay(to, toCycle))
 *   totalTermDays    = standardTerm(toCycle) + bonusDays
 *
 * Throws if either plan/cycle has no list price (caller should not call
 * this for FREE, lifetime, or unsold tiers — those have separate paths).
 */
export function computeTierUpgradeBonusDays(
  input: TierUpgradeInput,
): TierUpgradeResult {
  if (input.daysRemainingOnCurrent < 0) {
    throw new Error("daysRemainingOnCurrent must be >= 0");
  }
  const fromRate = listPricePerDay(input.fromPlan, input.fromCycle);
  const toRate = listPricePerDay(input.toPlan, input.toCycle);
  if (fromRate == null || toRate == null) {
    throw new Error(
      "computeTierUpgradeBonusDays requires list prices on both sides",
    );
  }
  const remainingCredit = input.daysRemainingOnCurrent * fromRate;
  const bonusDays =
    remainingCredit > 0 ? Math.ceil(remainingCredit / toRate) : 0;
  return {
    remainingCredit,
    newPerDayRate: toRate,
    bonusDays,
    totalTermDays: STANDARD_TERM_DAYS[input.toCycle] + bonusDays,
  };
}

/**
 * Cycle change SAME tier, Monthly → Annual: append remaining monthly
 * days to the annual term. No money conversion because per-day value
 * is identical on the same tier — the only thing changing is billing
 * frequency.
 */
export function computeCycleAppendDays(daysRemainingOnMonthly: number): {
  bonusDays: number;
  totalTermDays: number;
} {
  const bonus = Math.max(0, Math.floor(daysRemainingOnMonthly));
  return {
    bonusDays: bonus,
    totalTermDays: STANDARD_TERM_DAYS.annual + bonus,
  };
}

/**
 * Classify a requested plan change. The dispatcher in createCheckoutAction
 * uses this to pick the right path: append, tier upgrade with bonus days,
 * scheduled downgrade, or scheduled cancel.
 *
 * Tier ranks: FREE=0, PRO=1, PREMIUM=2, ULTIMATE=3.
 */
export type TransitionKind =
  | "noop"
  | "first_purchase" // FREE → paid tier
  | "cycle_append" // same tier, monthly → annual (immediate)
  | "cycle_downgrade" // same tier, annual → monthly (scheduled)
  | "tier_upgrade" // higher tier (immediate, bonus days)
  | "tier_downgrade" // lower tier or paid → FREE (scheduled)
  | "cancel"; // → FREE (scheduled)

const TIER_RANK: Record<string, number> = {
  FREE: 0,
  PRO: 1,
  PREMIUM: 2,
  ULTIMATE: 3,
};

/**
 * Fulfillment-side twin of previewPlanChangeAction's bonus-days promise:
 * given the OLD subscription row state at grant time and the NEW purchase,
 * return the bonus days the upgrade dialog showed — tier_upgrade →
 * value-converted days, cycle_append → 1:1 days, everything else → 0.
 * Pure so both fulfillment routes (webhook + callback) and tests share one
 * source of truth. Missing list prices (FREE / lifetime) or cycles return
 * 0, mirroring the preview's no-bonus fallback.
 */
export function computeFulfillmentBonusDays(input: {
  fromPlanId: string;
  fromCycle: BillingCycle | null;
  fromPlan:
    | Pick<PlanConfig, "monthlyOriginalPrice" | "annualOriginalPrice">
    | undefined;
  toPlanId: string;
  toCycle: BillingCycle | null;
  toPlan:
    | Pick<PlanConfig, "monthlyOriginalPrice" | "annualOriginalPrice">
    | undefined;
  /** OLD row's term anchor: endDate ?? nextBillingDate. */
  termAnchor: Date | null | undefined;
  now?: Date;
}): number {
  const kind = classifyTransition(
    input.fromPlanId,
    input.fromCycle,
    input.toPlanId,
    input.toCycle,
  );
  const remaining = daysRemaining(input.now ?? new Date(), input.termAnchor);
  if (remaining <= 0) return 0;
  if (kind === "cycle_append")
    return computeCycleAppendDays(remaining).bonusDays;
  if (kind !== "tier_upgrade") return 0;
  if (!input.fromPlan || !input.toPlan || !input.fromCycle || !input.toCycle) {
    return 0;
  }
  try {
    return computeTierUpgradeBonusDays({
      fromPlan: input.fromPlan,
      fromCycle: input.fromCycle,
      toPlan: input.toPlan,
      toCycle: input.toCycle,
      daysRemainingOnCurrent: remaining,
    }).bonusDays;
  } catch {
    return 0;
  }
}

export function classifyTransition(
  fromPlanId: string,
  fromCycle: BillingCycle | null,
  toPlanId: string,
  toCycle: BillingCycle | null,
): TransitionKind {
  if (fromPlanId === toPlanId && fromCycle === toCycle) return "noop";
  if (toPlanId === "FREE") return "cancel";
  if (fromPlanId === "FREE") return "first_purchase";

  const fromRank = TIER_RANK[fromPlanId] ?? 0;
  const toRank = TIER_RANK[toPlanId] ?? 0;

  if (fromPlanId === toPlanId) {
    // Same tier — only cycle differs.
    if (fromCycle === "monthly" && toCycle === "annual") return "cycle_append";
    if (fromCycle === "annual" && toCycle === "monthly")
      return "cycle_downgrade";
    return "noop";
  }
  if (toRank > fromRank) return "tier_upgrade";
  return "tier_downgrade";
}
