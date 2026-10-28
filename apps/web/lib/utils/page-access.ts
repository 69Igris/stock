"use server";

import { getSubscriptionAccess } from "@/lib/subscription/access";
import type { PageRoute, PageAccessInfo } from "@/lib/types/feature-flags";
import { PAGE_TO_FEATURE_MAP } from "@/lib/constants/page-features";
import { decidePageAccess } from "@/lib/utils/page-access-logic";

export async function getPageAccessInfo(
  route: PageRoute,
  isFeatureFlagEnabled: boolean,
  isDemoMode: boolean
): Promise<PageAccessInfo> {
  // Resolve the caller's plan only when it can actually affect the decision:
  // demo / disabled-flag / no-feature-required pages never read the plan, so we
  // skip the Clerk + DB round-trip for them. The pure decision itself lives in
  // `decidePageAccess` (the de-shadow seam) so production and tests share code.
  const needsPlan =
    !isDemoMode && isFeatureFlagEnabled && Boolean(PAGE_TO_FEATURE_MAP[route]);
  const planId = needsPlan
    ? ((await getSubscriptionAccess())?.planId ?? "FREE")
    : "FREE";

  return decidePageAccess({
    route,
    isFeatureFlagEnabled,
    isDemoMode,
    planId,
  });
}
