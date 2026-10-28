/**
 * Pure access + render-branch logic for {@link FeatureGate}, extracted from the
 * "use client" component so the tier comparison, demo-mode bypass, API-result
 * handling, and render-path selection are unit-testable. FeatureGate's
 * `checkAccess` callback and its render branches call these — one source of truth.
 */

export const PLAN_NAMES: Record<string, string> = {
  PRO: "Pro",
  PREMIUM: "Premium",
  ULTIMATE: "Ultimate",
};

/** Plan tier ordering; unknown plans resolve to 0 (same as FREE). */
export const TIER_ORDER: Record<string, number> = {
  FREE: 0,
  PRO: 1,
  PREMIUM: 2,
  ULTIMATE: 3,
};

/** A FREE plan meets a requirement iff its tier ≥ the required tier. */
export function planMeetsRequirement(
  planId: string,
  requiredPlan: string
): boolean {
  const currentTier = TIER_ORDER[planId] ?? 0;
  const requiredTier = TIER_ORDER[requiredPlan] ?? 0;
  return currentTier >= requiredTier;
}

/** The /api/subscription/access result, or "error" for a thrown/failed fetch. */
export type AccessFetchResult =
  | { ok: true; data?: { planId?: string } | null }
  | { ok: false }
  | "error";

export interface AccessDecision {
  hasAccess: boolean;
  currentPlan: string;
}

/**
 * Resolve gate access. Mirrors FeatureGate.checkAccess:
 *   - demo mode (localStorage tradebook_demo_mode) → access as PRO
 *   - fetch error / non-OK → no access, plan stays FREE
 *   - OK → planId (default FREE) compared against requiredPlan by tier
 */
export function resolveAccess(
  demoMode: boolean,
  fetchResult: AccessFetchResult,
  requiredPlan: string
): AccessDecision {
  if (demoMode) return { hasAccess: true, currentPlan: "PRO" };

  if (fetchResult === "error" || !fetchResult.ok) {
    return { hasAccess: false, currentPlan: "FREE" };
  }

  const planId = fetchResult.data?.planId ?? "FREE";
  return {
    hasAccess: planMeetsRequirement(planId, requiredPlan),
    currentPlan: planId,
  };
}

export type RenderPath =
  | "loading"
  | "children"
  | "fallback"
  | "upgrade"
  | "null";

/**
 * What FeatureGate renders, in precedence order: loading → children (access) →
 * fallback (if provided) → null (if upgrade prompt suppressed) → upgrade.
 */
export function resolveRenderPath(
  isLoading: boolean,
  hasAccess: boolean | null,
  hasFallback: boolean,
  showUpgradePrompt: boolean
): RenderPath {
  if (isLoading) return "loading";
  if (hasAccess) return "children";
  if (hasFallback) return "fallback";
  if (!showUpgradePrompt) return "null";
  return "upgrade";
}
