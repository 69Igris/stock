"use server";

import { auth } from "@clerk/nextjs/server";
import { FEATURE_ACCESS, hasFeatureAccess } from "@usemoney/core/subscription";
import {
  getSubscriptionAccessForUser,
  resolveUserId,
  DEFAULT_FREE_ACCESS,
  type SubscriptionAccess,
} from "@usemoney/services";
import { getCached, setCached } from "@usemoney/core/cache";
import { dbLogger as logger } from "@usemoney/logger";
import {
  readThroughSubscriptionAccess,
  SUBSCRIPTION_ACCESS_CACHE_IDENTIFIER,
  SUBSCRIPTION_ACCESS_CACHE_CONFIG,
} from "./access-cache";

// The `SubscriptionAccess` interface + the pure builder + `DEFAULT_FREE_ACCESS`
// now live in @usemoney/services (the `subscription-logic` seam). This file is
// the thin 'use server' wrapper: Clerk auth → internal userId → service call.
// Re-exported so existing consumers (e.g. components/PageAccessModal) keep
// importing the type from `@/lib/subscription/access`.
export type { SubscriptionAccess };

export async function getSubscriptionAccess(): Promise<SubscriptionAccess> {
  try {
    // First check if we have an authenticated session
    let clerkUserId: string | null = null;

    try {
      const authResult = await auth();
      clerkUserId = authResult.userId;
    } catch (clerkError: any) {
      // Handle Clerk API errors gracefully (network issues, expired sessions, etc.)
      if (
        clerkError?.clerkError ||
        clerkError?.message?.includes("fetch failed")
      ) {
        logger.warn(
          { err: clerkError?.message },
          "Clerk unavailable, returning free access"
        );
        return DEFAULT_FREE_ACCESS;
      }
      throw clerkError; // Re-throw unexpected errors
    }

    if (!clerkUserId) {
      return DEFAULT_FREE_ACCESS;
    }

    // Resolve Clerk → internal userId via the cached service resolver
    // (narrow select + 5-min TTL) instead of an inline full-row findUnique.
    // resolveUserId fails-to-null on a DB error, preserving fail-to-FREE.
    const userId = await resolveUserId(clerkUserId);
    if (!userId) {
      return DEFAULT_FREE_ACCESS;
    }

    // Row lookup + entitlement computation live in the service layer, behind a
    // short user-scoped cache (MONEY-1126). `readThroughSubscriptionAccess`
    // enforces the rule that makes caching a fail-open gate safe: an
    // unsuccessful resolution yields DEFAULT_FREE_ACCESS for THIS request and
    // is never written, so a transient DB error can't pin a paying user to FREE
    // for the TTL. See ./access-cache.ts.
    return await readThroughSubscriptionAccess<SubscriptionAccess>(userId, {
      read: (id) =>
        getCached<SubscriptionAccess>(
          "subscription",
          id,
          SUBSCRIPTION_ACCESS_CACHE_IDENTIFIER,
          undefined,
          SUBSCRIPTION_ACCESS_CACHE_CONFIG
        ),
      write: (id, value) =>
        setCached(
          "subscription",
          id,
          SUBSCRIPTION_ACCESS_CACHE_IDENTIFIER,
          value,
          undefined,
          SUBSCRIPTION_ACCESS_CACHE_CONFIG
        ),
      resolve: async (id) => {
        const result = await getSubscriptionAccessForUser(id);
        // `null` (not DEFAULT_FREE_ACCESS) so the failure stays uncached.
        return result.success ? result.data : null;
      },
      fallback: DEFAULT_FREE_ACCESS,
    });
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "Error getting subscription access"
    );
    return DEFAULT_FREE_ACCESS;
  }
}

export async function checkFeatureAccess(
  feature: keyof typeof FEATURE_ACCESS
): Promise<boolean> {
  const access = await getSubscriptionAccess();
  return hasFeatureAccess(access.planId, feature);
}

export async function canUseAIQuery(
  queryType: "fast" | "advanced" = "fast"
): Promise<{ allowed: boolean; remaining: number; message?: string }> {
  const access = await getSubscriptionAccess();

  if (!access.canAccessAIQueries) {
    return {
      allowed: false,
      remaining: 0,
      message: "Upgrade to Pro to use AI queries",
    };
  }

  if (queryType === "advanced") {
    if (access.advancedQueriesLimit === -1) {
      return { allowed: true, remaining: Infinity };
    }
    const remaining = access.advancedQueriesLimit - access.advancedQueriesUsed;
    if (remaining <= 0) {
      return {
        allowed: false,
        remaining: 0,
        message: "No advanced queries remaining",
      };
    }
    return { allowed: true, remaining };
  }

  // Fast queries
  if (access.fastQueriesLimit === -1) {
    return { allowed: true, remaining: Infinity };
  }
  const remaining = access.fastQueriesLimit - access.fastQueriesUsed;
  if (remaining <= 0) {
    return {
      allowed: false,
      remaining: 0,
      message:
        "No fast queries remaining. Purchase AI Query Pack for 150 more queries.",
    };
  }
  return { allowed: true, remaining };
}
