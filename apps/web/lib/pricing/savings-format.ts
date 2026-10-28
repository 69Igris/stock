/**
 * MONEY-438 / Pricing v2: helpers for the "Save X%" badge and
 * "you're saving ₹X with yearly plan" supporting copy.
 *
 * Reference design (2026-05-21) uses both formats together:
 *   - Headline badge inside the toggle:  "Save 40%"
 *   - Supporting line under price:        "you're saving ₹4,800 with yearly plan"
 *
 * Percentage is skim-friendly, absolute ₹ is the concrete anchor that
 * makes the savings feel real. Both are computed from the same
 * (monthlyPrice, annualPrice) pair so they always agree.
 */

import { computeAnnualSavings } from "./useBillingCycle";

export interface SavingsBadgeInput {
  monthlyPrice: number | undefined | null;
  annualPrice: number | undefined | null;
}

/**
 * Headline percentage string for the toggle badge — e.g. "40%".
 * Returns null when annual is not actually cheaper than monthly × 12.
 */
export function formatSavingsPct(input: SavingsBadgeInput): string | null {
  const pct = computeAnnualSavings(input.monthlyPrice, input.annualPrice);
  return pct == null ? null : `${pct}%`;
}

/**
 * Absolute rupee savings string — e.g. "₹4,800" — for the
 * "you're saving … with yearly plan" supporting copy.
 * Uses Indian number formatting (lakhs/crores via toLocaleString).
 */
export function formatSavingsAbsolute(input: SavingsBadgeInput): string | null {
  if (
    input.monthlyPrice == null ||
    input.annualPrice == null ||
    !Number.isFinite(input.monthlyPrice) ||
    !Number.isFinite(input.annualPrice) ||
    input.monthlyPrice <= 0 ||
    input.annualPrice <= 0
  ) {
    return null;
  }
  const monthlyAnnualised = input.monthlyPrice * 12;
  const saved = monthlyAnnualised - input.annualPrice;
  if (saved <= 0) return null;
  return `₹${saved.toLocaleString("en-IN")}`;
}

/**
 * Monthly-annualised price for the strikethrough above the annual
 * price — e.g. ₹11,999 if monthly is ₹999. This is what the user
 * WOULD pay at monthly rate × 12 if they did not pick annual.
 */
export function formatMonthlyAnnualised(
  monthlyPrice: number | undefined | null
): string | null {
  if (
    monthlyPrice == null ||
    !Number.isFinite(monthlyPrice) ||
    monthlyPrice <= 0
  ) {
    return null;
  }
  return `₹${(monthlyPrice * 12).toLocaleString("en-IN")}`;
}

/**
 * Launch-discount badge for the card top-right — e.g. "50% OFF" from
 * (currentPrice=249, originalPrice=499). Returns null when the original
 * is missing, not actually higher than current, or invalid.
 *
 * Used so the "50% OFF" / "60% OFF" badge on each card stays honest as
 * we switch between Monthly / Annual cycles (PRO is 50% off monthly,
 * 60% off annual; Premium is 50% off in both).
 */
export function formatLaunchDiscount(
  currentPrice: number | undefined | null,
  originalPrice: number | undefined | null
): string | null {
  if (
    currentPrice == null ||
    originalPrice == null ||
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(originalPrice) ||
    currentPrice <= 0 ||
    originalPrice <= currentPrice
  ) {
    return null;
  }
  const pct = Math.round((1 - currentPrice / originalPrice) * 100);
  return `${pct}% OFF`;
}
