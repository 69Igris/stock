"use server";

import { currentUser } from "@clerk/nextjs/server";

// MONEY-481: PRO Monthly/Annual + Premium Annual were previously gated
// behind PostHog flags during the launch ramp. They are now GA, so the
// only remaining billing-related flag is the Ultimate-tier gate (Ultimate
// is not yet shipped end-to-end). When Ultimate launches, drop this file
// entirely.
const BILLING_FLAG_KEYS = {
  ultimate_plan: "ultimatePlan",
} as const;

type BillingFlags = {
  ultimatePlan: boolean;
};

const DEFAULT_BILLING_FLAGS: BillingFlags = {
  ultimatePlan: false,
};

// In-memory cache with 5min TTL
const billingFlagsCache = new Map<
  string,
  { flags: BillingFlags; timestamp: number }
>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

/**
 * Call PostHog's Decide API to fetch billing feature flags
 */
async function fetchBillingFlagsFromPostHog(
  distinctId: string
): Promise<Record<string, boolean | string | undefined>> {
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

  if (!apiKey) {
    return {};
  }

  try {
    const response = await fetch("https://us.i.posthog.com/decide?v=3", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        distinct_id: distinctId,
      }),
    });

    if (!response.ok) {
      return {};
    }

    const data = await response.json();
    return data.featureFlags || {};
  } catch {
    return {};
  }
}

/**
 * Fetch billing feature flags from PostHog with in-memory caching (5min TTL).
 * Returns all flags as `false` when unauthenticated or on error.
 */
export async function getBillingFlagsAction(): Promise<BillingFlags> {
  try {
    const user = await currentUser();

    if (!user || !user.id) {
      return DEFAULT_BILLING_FLAGS;
    }

    const now = Date.now();

    // Check in-memory cache
    const cached = billingFlagsCache.get(user.id);
    if (cached && now - cached.timestamp < CACHE_TTL) {
      return cached.flags;
    }

    // Cache miss - call PostHog Decide API
    const posthogFlags = await fetchBillingFlagsFromPostHog(user.id);

    const flags: BillingFlags = { ...DEFAULT_BILLING_FLAGS };

    for (const [flagKey, propName] of Object.entries(BILLING_FLAG_KEYS)) {
      const flagValue = posthogFlags[flagKey];

      if (flagValue === true) {
        flags[propName] = true;
      } else if (typeof flagValue === "string") {
        flags[propName] =
          flagValue.length > 0 && flagValue !== "false" && flagValue !== "off";
      }
      // undefined / false / anything else stays false (from the spread default)
    }

    // Store in cache
    billingFlagsCache.set(user.id, { flags, timestamp: now });

    // Evict stale entries if cache grows large
    if (billingFlagsCache.size > 1000) {
      const cutoff = now - CACHE_TTL;
      for (const [key, value] of Array.from(billingFlagsCache.entries())) {
        if (value.timestamp < cutoff) {
          billingFlagsCache.delete(key);
        }
      }
    }

    return flags;
  } catch {
    return DEFAULT_BILLING_FLAGS;
  }
}
