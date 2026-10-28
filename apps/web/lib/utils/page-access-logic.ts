/**
 * Page-access pure decision (de-shadow seam for MONEY-620).
 *
 * `page-access.ts` is a `"use server"` action that resolves the caller's plan
 * via Clerk/DB (`getSubscriptionAccess`) and then makes a pure decision. That
 * decision used to be inlined in the action — untestable without Clerk, and
 * shadow-tested with a stale inline copy that had drifted badly (it lacked the
 * upgrade branch entirely and asserted an outdated `PAGE_TO_FEATURE_MAP`).
 *
 * This module is the single source of truth for that decision. `page-access.ts`
 * imports `decidePageAccess` and only supplies the resolved `planId`, so the
 * production code path and the unit test execute the SAME code.
 */

import type { PageRoute, PageAccessInfo } from "@/lib/types/feature-flags";
// Subpath import (not the root barrel) so this pure module never drags
// GCS/payments/fs into the client or test bundle — STANDING RULE.
import {
  hasFeatureAccess,
  getMinimumPlanForFeature,
  type Feature,
} from "@usemoney/core/subscription";
import { PAGE_TO_FEATURE_MAP } from "@/lib/constants/page-features";

/** Inputs to the page-access decision, with the subscription already resolved. */
export interface PageAccessDecisionInput {
  route: PageRoute;
  isFeatureFlagEnabled: boolean;
  isDemoMode: boolean;
  /** Resolved plan id for the caller; defaults to "FREE" when unknown. */
  planId: string;
}

/**
 * Pure page-access decision. Order matters and is load-bearing:
 *   1. Demo mode → always allow (the demo walkthrough must reach every page).
 *   2. Feature flag OFF → "Coming Soon" (page not shipped yet).
 *   3. Flag ON + page requires a feature the plan lacks → "Upgrade" + requiredPlan.
 *   4. Otherwise → allow.
 */
export function decidePageAccess(
  input: PageAccessDecisionInput
): PageAccessInfo {
  const { route, isFeatureFlagEnabled, isDemoMode, planId } = input;

  // 1. Demo mode: always allow.
  if (isDemoMode) {
    return {
      route,
      isEnabled: true,
      showComingSoon: false,
      showUpgrade: false,
    };
  }

  // 2. Feature flag disabled: show "Coming Soon".
  if (!isFeatureFlagEnabled) {
    return {
      route,
      isEnabled: false,
      showComingSoon: true,
      showUpgrade: false,
    };
  }

  // 3. Flag enabled — gate on subscription if the page requires a feature.
  const requiredFeature: Feature | null = PAGE_TO_FEATURE_MAP[route];
  if (requiredFeature) {
    if (!hasFeatureAccess(planId, requiredFeature)) {
      return {
        route,
        isEnabled: false,
        showComingSoon: false,
        showUpgrade: true,
        requiredPlan: getMinimumPlanForFeature(requiredFeature),
      };
    }
  }

  // 4. Allowed.
  return {
    route,
    isEnabled: true,
    showComingSoon: false,
    showUpgrade: false,
  };
}
