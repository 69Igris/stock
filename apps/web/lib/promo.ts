/**
 * Promo-code capture (MONEY-865 / MONEY-385).
 *
 * Marketing CTAs link to `usemoney.ai/?promo=CODE` (e.g. HINDIYT20). The public
 * pricing / sign-up pages capture that code into localStorage on load; the
 * in-app upgrade dialog (PlansTab) pre-fills the coupon input from it. The code
 * is still re-validated server-side at checkout — this is pure UX convenience.
 *
 * Client-only (guards `window`); all storage access is wrapped so private-mode /
 * disabled storage never throws.
 */

const PROMO_KEY = "usemoney_promo";

/** Capture a `?promo=CODE` from the current URL into localStorage. */
export function capturePromoFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const promo = new URLSearchParams(window.location.search).get("promo");
    if (promo && promo.trim().length >= 3) {
      window.localStorage.setItem(PROMO_KEY, promo.trim().toUpperCase());
    }
  } catch {
    // ignore (private mode / storage disabled)
  }
}

/** The stored promo code, or "" when none. */
export function getStoredPromo(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(PROMO_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Clear the stored promo (after it has been redeemed). */
export function clearStoredPromo(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PROMO_KEY);
  } catch {
    // ignore
  }
}
