/**
 * Pure plan-display + checkout pricing/period logic (MONEY-865 / MONEY-866).
 *
 * Extracted from the inline glue in apps/web (createCheckoutAction + the Settings
 * BillingTab / header / UsageTab) so the decisions that produced live bugs —
 * "PRO · Lifetime" on a paid PRO-annual, a ₹999 PREMIUM-monthly charge, and a PRO
 * checkout resolving to "one-time" — are unit-tested against the REAL exports.
 */
import { PLAN_CONFIG, type PlanConfig } from "./plans";

/**
 * MONEY-866: the one-time "lifetime" PRO is deprecated. A PRO with a real billing
 * cycle (annual/monthly) is NOT lifetime — only a legacy grandfathered PRO with
 * NO recurring cycle is. (BillingTab/header/UsageTab previously hardcoded
 * `planId === "PRO"`, so a paid PRO-annual rendered as "Lifetime · ₹999".)
 */
export function isLifetimePlan(
  planId: string | null | undefined,
  billingPeriod: string | null | undefined,
): boolean {
  return planId === "PRO" && !billingPeriod;
}

/**
 * Settings header / badge label for a plan + cycle:
 * "FREE" · "PRO · Annual" · "PRO · Monthly" · "PRO · Lifetime" (grandfathered) ·
 * "PREMIUM" · "ULTIMATE".
 */
export function planDisplayLabel(
  planId: string | null | undefined,
  billingPeriod: string | null | undefined,
): string {
  if (!planId || planId === "FREE") return "FREE";
  if (planId === "PRO") {
    if (billingPeriod === "annual") return "PRO · Annual";
    if (billingPeriod === "monthly") return "PRO · Monthly";
    return "PRO · Lifetime"; // legacy grandfathered (no cycle)
  }
  return planId; // PREMIUM / ULTIMATE
}

export type CheckoutPeriod = "monthly" | "annual" | "one-time";

/**
 * MONEY-866: the checkout billing period. PRO and PREMIUM are monthly/annual
 * ONLY — never "one-time" (the lifetime PRO is deprecated). A missing cycle
 * defaults to monthly. Credit packs and any other plan are one-time.
 */
export function resolveCheckoutPeriod(
  resolvedPlanId: string,
  billingPeriod: string | null | undefined,
  isCreditPack: boolean,
): CheckoutPeriod {
  if (isCreditPack) return "one-time";
  if (resolvedPlanId === "PRO" || resolvedPlanId === "PREMIUM") {
    return billingPeriod === "annual" ? "annual" : "monthly";
  }
  return "one-time";
}

/**
 * MONEY-865/866: the checkout amount (₹). The synced Dodo product price is the
 * single source of truth; PLAN_CONFIG is only a cold-sync-miss fallback — and the
 * fallback resolves to the plan's per-cycle price, then its base `price`, NEVER
 * the legacy ₹999 shadow that made PREMIUM-monthly charge wrong. Credit packs
 * price from their own SKU (`creditPackPrice`).
 */
export function resolveCheckoutAmount(input: {
  resolvedPlanId: string;
  billingPeriod: string | null | undefined;
  isCreditPack: boolean;
  /** Synced Dodo product price (source of truth), or null/undefined on a cold miss. */
  dodoPrice: number | null | undefined;
  /** Credit-pack SKU price, when isCreditPack. */
  creditPackPrice?: number | null;
}): number {
  const planConfig = PLAN_CONFIG[
    input.resolvedPlanId as keyof typeof PLAN_CONFIG
  ] as PlanConfig | undefined;

  if (input.isCreditPack) {
    return input.creditPackPrice ?? planConfig?.price ?? 0;
  }

  // Source of truth: the synced Dodo product price.
  if (input.dodoPrice != null && Number.isFinite(input.dodoPrice)) {
    return input.dodoPrice;
  }

  // Cold-miss fallback: per-cycle PLAN_CONFIG, then the plan's base price.
  const cyclePrice =
    input.billingPeriod === "annual"
      ? planConfig?.annualPrice
      : input.billingPeriod === "monthly"
        ? planConfig?.monthlyPrice
        : undefined;
  return cyclePrice ?? planConfig?.price ?? 0;
}
