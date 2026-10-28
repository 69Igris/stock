"use client";

/**
 * MONEY-438 / Pricing v2: shared billing-cycle hook.
 *
 * Reads / writes `?cycle=monthly|annual` on the URL so:
 *   - All 3 pricing surfaces (Landing, /pricing, Settings → Plan) share
 *     the same state when navigating between them.
 *   - Campaign deeplinks like `/pricing?cycle=annual` land users
 *     directly on the annual view.
 *   - State survives a hard refresh without needing localStorage.
 *
 * Uses `history.replaceState` (not `router.replace`) so the URL update
 * is cheap and doesn't trigger Next.js's re-fetch of server components
 * for the route.
 *
 * Lifetime is intentionally not a value — it is no longer a purchasable
 * cycle (see MONEY-438 scope). Existing PRO Lifetime customers still
 * see their plan rendered as "PRO · Lifetime" in Settings, but that is
 * a *data display* concern, not a *cycle selection* concern.
 */

import { useCallback, useEffect, useState } from "react";

export type BillingCycle = "monthly" | "annual";

const QUERY_KEY = "cycle";
const ALLOWED: readonly BillingCycle[] = ["monthly", "annual"] as const;

function isValidCycle(v: string | null): v is BillingCycle {
  return v === "monthly" || v === "annual";
}

/**
 * Read the cycle from the current URL on the client. SSR-safe (returns
 * the fallback when `window` is undefined).
 */
function readFromUrl(fallback: BillingCycle): BillingCycle {
  if (typeof window === "undefined") return fallback;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get(QUERY_KEY);
  return isValidCycle(raw) ? raw : fallback;
}

/**
 * Write the cycle to the URL via replaceState. Idempotent — if the
 * URL already matches, no-op. Removes the query when the cycle equals
 * the default so the URL stays clean for the common case.
 */
function writeToUrl(next: BillingCycle, defaultCycle: BillingCycle): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const current = url.searchParams.get(QUERY_KEY);
  const target = next === defaultCycle ? null : next;
  if (current === target) return;
  if (target === null) {
    url.searchParams.delete(QUERY_KEY);
  } else {
    url.searchParams.set(QUERY_KEY, target);
  }
  // MONEY-1082: forward the existing history state rather than `null`. Next
  // patches replaceState and only skips its router dispatch when the state
  // object carries the `__NA` marker it stamps on its own entries. Passing
  // `null` stripped that marker, so what looks like a URL-bar edit was
  // actually an ACTION_RESTORE — a real navigation that could land after the
  // user had moved to another page.
  window.history.replaceState(window.history.state, "", url.toString());
}

export interface UseBillingCycleOptions {
  /** Initial value if the URL has no `?cycle`. Defaults to "annual". */
  defaultCycle?: BillingCycle;
  /** Whether to persist changes back to the URL. Default true. */
  persist?: boolean;
}

/**
 * Returns `[cycle, setCycle]`. Defaults the initial state to "annual"
 * because annual is the higher-value path and most pricing pages lead
 * with it (industry convention: ProductHunt, Stripe, Linear). Override
 * per-surface if needed.
 */
export function useBillingCycle(
  options: UseBillingCycleOptions = {}
): [BillingCycle, (next: BillingCycle) => void] {
  const { defaultCycle = "annual", persist = true } = options;

  // SSR returns the default; the effect below hydrates from URL on mount.
  const [cycle, setCycleState] = useState<BillingCycle>(defaultCycle);

  useEffect(() => {
    const fromUrl = readFromUrl(defaultCycle);
    if (fromUrl !== cycle) setCycleState(fromUrl);
    // Intentionally re-run only on mount; URL hydration is one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setCycle = useCallback(
    (next: BillingCycle) => {
      setCycleState(next);
      if (persist) writeToUrl(next, defaultCycle);
    },
    [defaultCycle, persist]
  );

  return [cycle, setCycle];
}

/**
 * Compute the "Save X%" discount for an annual price vs a monthly
 * price. Returns a whole-number percentage (e.g., 17) or null when the
 * data is insufficient or annual is not actually a discount.
 */
export function computeAnnualSavings(
  monthlyPrice: number | undefined | null,
  annualPrice: number | undefined | null
): number | null {
  if (
    monthlyPrice == null ||
    annualPrice == null ||
    !Number.isFinite(monthlyPrice) ||
    !Number.isFinite(annualPrice) ||
    monthlyPrice <= 0 ||
    annualPrice <= 0
  ) {
    return null;
  }
  const monthlyAnnualised = monthlyPrice * 12;
  if (annualPrice >= monthlyAnnualised) return null;
  const savings = (1 - annualPrice / monthlyAnnualised) * 100;
  return Math.round(savings);
}

export const BILLING_CYCLES = ALLOWED;
