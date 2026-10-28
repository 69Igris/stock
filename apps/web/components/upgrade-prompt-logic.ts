/**
 * Pure copy/derivation for {@link UpgradePrompt} (MONEY-484), extracted from the
 * "use client" component so the plan-keyed copy + price logic is unit-testable.
 * The component imports `PLAN_DISPLAY_NAMES`, `PLAN_FEATURES`, and
 * `resolveUpgradeCopy` and renders from them — one source of truth.
 *
 * Note: the icon-bearing `PLAN_PREVIEWS` and the hero icon/color stay in the
 * component (they reference lucide components) — only the `any`-free, render-
 * independent data lives here.
 */

export const PLAN_DISPLAY_NAMES: Record<string, string> = {
  PRO: "Pro",
  PREMIUM: "Premium",
  ULTIMATE: "Ultimate",
};

export const PLAN_FEATURES: Record<string, string[]> = {
  PRO: [
    "This feature (now unlocked)",
    "200 research credits / month",
    "Portfolio analysis with StockSage",
    "5 parallel L2 research runs",
    "All Pro pages + future features",
    "Priority support",
  ],
  PREMIUM: [
    "This feature (now unlocked)",
    "200 research credits / month",
    "Deep AI research with StockSage",
    "Document Vault + Tax tools",
    "All Premium pages + future features",
    "Priority support",
  ],
};

/** Resolved, render-independent copy for the upgrade prompt. */
export interface UpgradeCopy {
  /** Human-friendly plan name; falls back to the raw id for unknown plans. */
  displayPlan: string;
  /** Feature checklist; falls back to the PRO list for unknown plans. */
  checklist: string[];
  /** Discounted Indian-market price (PRO is cheaper than Premium). */
  price: string;
  /** Struck-through original price. */
  origPrice: string;
}

/**
 * Derive the upgrade copy for a required plan. Mirrors UpgradePrompt exactly:
 * PRO gets ₹249/₹499, every other (Premium+) gets ₹1,499/₹2,999; unknown plans
 * fall back to the raw id for the name and the PRO checklist.
 */
export function resolveUpgradeCopy(requiredPlan: string): UpgradeCopy {
  return {
    displayPlan: PLAN_DISPLAY_NAMES[requiredPlan] ?? requiredPlan,
    checklist: PLAN_FEATURES[requiredPlan] ?? PLAN_FEATURES.PRO ?? [],
    price: requiredPlan === "PRO" ? "₹249" : "₹1,499",
    origPrice: requiredPlan === "PRO" ? "₹499" : "₹2,999",
  };
}
