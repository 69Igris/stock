"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import type {
  FeatureFlagMap,
  PageRoute,
  FeatureFlagsResponse,
  GatedPageRoute,
  UsFeatureFlag,
  UsFeatureFlagMap,
  UsFeatureFlagsResponse,
  AppFeatureFlag,
  AppFeatureFlagMap,
  AppFeatureFlagsResponse,
} from "@/lib/types/feature-flags";
import { ALWAYS_ON_ROUTES } from "@/lib/types/feature-flags";
import {
  getCachedFlags,
  setCachedFlags,
  clearCachedFlags,
  clearAllCachedFlags as clearAllRedisFlags,
} from "@/lib/redis/cache";
import crypto from "crypto";
import { featureFlagsLogger as logger } from "@usemoney/logger";

/**
 * Only gated pages need PostHog evaluation.
 * Shipped pages (ALWAYS_ON_ROUTES) are hardcoded to true - no API call needed.
 */
const GATED_FLAG_KEYS: Record<GatedPageRoute, string> = {
  "/paper-trading": "page-visibility-paper-trading",
  "/sage-tutor": "page-visibility-sage-tutor",
  "/learning": "page-visibility-learning",
  "/risk": "page-visibility-risk",
  "/tax": "page-visibility-tax",
  "/strategies": "page-visibility-strategies",
  "/quizzes": "page-visibility-quizzes",
  // MONEY-1058: founder-only Scans library — the PostHog flag targets the
  // founder email only; everyone else (and demo) is kill-switch redirected.
  "/discover/scans": "page-visibility-scans",
};

/**
 * MONEY-457: Kill-switched routes whose feature flag is force-disabled
 * regardless of what PostHog returns. Use this when a route needs to be
 * removed from all users (e.g. compliance, security incident, deprecated
 * surface) without depending on PostHog targeting / cohort rules being
 * correct, and without a PostHog write call.
 *
 * Behaviour: any route listed here returns `false` from every feature-flag
 * evaluation path (server action and per-user cache), short-circuiting the
 * PostHog flag value. The PostHog flag itself is left untouched so the
 * targeting history is preserved for audit.
 *
 * To re-enable a route: remove it from this set in a follow-up PR.
 */
const FORCE_DISABLED_ROUTES = new Set<PageRoute>(["/paper-trading"]);

// In-memory cache fallback (used when Redis is unavailable)
const flagsCache = new Map<string, FeatureFlagsResponse>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

/**
 * Generate a version hash from feature flags
 */
function generateFlagVersion(flags: FeatureFlagMap): string {
  const flagString = JSON.stringify(flags, Object.keys(flags).sort());
  return crypto.createHash("md5").update(flagString).digest("hex").slice(0, 8);
}

/**
 * Generate cache key that includes user email hash for proper isolation
 */
function generateCacheKey(userId: string, email?: string): string {
  const emailHash = email
    ? crypto
        .createHash("md5")
        .update(email.toLowerCase())
        .digest("hex")
        .slice(0, 8)
    : "no-email";
  return `${userId}:${emailHash}`;
}

/**
 * A SUCCESSFUL PostHog Decide evaluation. An EMPTY object is a valid result and
 * means "PostHog answered, and this person matched no flags".
 */
type PostHogFlagPayload = Record<string, boolean | string | undefined>;

/**
 * MONEY-1123: hard ceiling on the PostHog Decide round trip. Flag evaluation
 * sits on hot request paths (e.g. `/api/market/search`, hit on every debounced
 * keystroke), so a hung PostHog must not stall the whole request.
 */
const POSTHOG_DECIDE_TIMEOUT_MS = 2000;

/**
 * Call PostHog's Decide API directly for reliable server-side flag evaluation.
 *
 * MONEY-1123: returns `null` when the evaluation FAILED TRANSIENTLY — network
 * error, timeout, or a non-OK status — as distinct from `{}`, which means the
 * evaluation succeeded and matched nothing. A missing API key is `{}`, not
 * `null`: it cannot be cured by retrying, so it must stay cacheable.
 *
 * That distinction is load-bearing: `{}` makes every gated route evaluate to
 * `false`, and callers CACHE their evaluation for `CACHE_TTL` (5 min). Caching
 * a failure would lock paying users out of gated pages for five minutes after a
 * two-second PostHog blip. Callers must serve defaults for the current request
 * only and write NO cache when this returns `null`.
 */
async function fetchFlagsFromPostHog(
  distinctId: string,
  personProperties: Record<string, string>
): Promise<PostHogFlagPayload | null> {
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

  // An absent key is a permanent property of the environment, not a blip, so it
  // is `{}` (a successful evaluation that matched nothing) rather than `null`.
  // Returning `null` here would make every request an uncacheable miss, and each
  // miss pays a ~200ms Clerk `currentUser()` — the exact cost this ticket removes.
  if (!apiKey) {
    logger.warn({}, "PostHog API key not configured - evaluating as no flags");
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
        person_properties: personProperties,
      }),
      // The timer behind AbortSignal.timeout is unref'd by Node, so this never
      // holds the event loop open (no orphaned-timer risk in tests/CI).
      signal: AbortSignal.timeout(POSTHOG_DECIDE_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.error(
        { status: response.status, statusText: response.statusText },
        "PostHog API error"
      );
      return null;
    }

    const data = (await response.json()) as {
      featureFlags?: PostHogFlagPayload;
    };

    logger.debug(
      { email: personProperties.email, flags: data.featureFlags },
      "PostHog Decide API response"
    );

    return data.featureFlags || {};
  } catch (error) {
    // AbortSignal.timeout rejects with a TimeoutError; an explicit abort would
    // surface as AbortError. Both mean "we never got an answer".
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    logger.error(
      { error, timeoutMs: POSTHOG_DECIDE_TIMEOUT_MS },
      timedOut
        ? "PostHog Decide API timed out"
        : "Error calling PostHog Decide API"
    );
    return null;
  }
}

/**
 * Internal function to evaluate feature flags from PostHog.
 * Only evaluates the 7 gated routes - shipped routes are hardcoded true.
 *
 * Returns `null` when PostHog could not be evaluated (see
 * `fetchFlagsFromPostHog`) so the caller can serve defaults WITHOUT caching.
 */
async function evaluateFeatureFlags(
  userId: string,
  userEmail?: string,
  userName?: string
): Promise<FeatureFlagMap | null> {
  logger.debug({ userId, email: userEmail }, "Evaluating feature flags");

  const personProperties: Record<string, string> = {};
  if (userEmail) personProperties.email = userEmail;
  if (userName) personProperties.name = userName;

  const posthogFlags = await fetchFlagsFromPostHog(userId, personProperties);

  if (posthogFlags === null) {
    logger.warn(
      { userId },
      "PostHog evaluation failed - serving defaults uncached"
    );
    return null;
  }

  // Start with shipped routes always on
  const flags: FeatureFlagMap = {} as FeatureFlagMap;
  for (const route of ALWAYS_ON_ROUTES) {
    flags[route] = true;
  }

  // Evaluate only gated routes from PostHog
  for (const [route, flagKey] of Object.entries(GATED_FLAG_KEYS)) {
    const pageRoute = route as PageRoute;

    // MONEY-457: kill-switched routes bypass PostHog entirely.
    if (FORCE_DISABLED_ROUTES.has(pageRoute)) {
      (flags as FeatureFlagMap)[pageRoute] = false;
      continue;
    }

    const flagValue = posthogFlags[flagKey];

    let isEnabled: boolean;

    if (flagValue === true) {
      isEnabled = true;
    } else if (flagValue === false) {
      isEnabled = false;
    } else if (flagValue === undefined) {
      logger.warn({ flagKey }, "Flag not found in PostHog, denying access");
      isEnabled = false;
    } else if (typeof flagValue === "string") {
      isEnabled =
        flagValue.length > 0 && flagValue !== "false" && flagValue !== "off";
    } else {
      isEnabled = false;
    }

    flags[pageRoute] = isEnabled;
  }

  logger.debug({ flags }, "Feature flags evaluated");

  return flags;
}

/**
 * Drop expired entries once the in-memory map grows past 1000. `flagsCache` is
 * shared by the page-visibility, US and app flag paths (distinct key prefixes),
 * so every writer prunes — extracted from `getFeatureFlags` in MONEY-1123 so
 * the US/app writers stop relying on the page-visibility path to bound the map.
 */
function pruneFlagsCache(now: number): void {
  if (flagsCache.size <= 1000) return;
  const cutoff = now - CACHE_TTL;
  for (const [key, value] of Array.from(flagsCache.entries())) {
    if (value.timestamp < cutoff) {
      flagsCache.delete(key);
    }
  }
}

/** Default flags: shipped routes ON, gated routes OFF */
function getDefaultFlags(): FeatureFlagMap {
  return {
    "/tradebook": true,
    "/positions": true,
    "/holdings": true,
    "/discover": true,
    "/analysis": true,
    "/watchlist": true,
    "/roast": true,
    "/documents": true,
    "/paper-trading": false,
    "/sage-tutor": false,
    "/learning": false,
    "/risk": false,
    "/tax": false,
    "/strategies": false,
    "/quizzes": false,
    "/discover/scans": false,
  };
}

/**
 * Server-side feature flag evaluation with smart caching.
 *
 * PERF: Uses auth() (fast, reads signed cookie ~2ms) instead of
 * currentUser() (slow, HTTP to Clerk API ~200ms) for the common path.
 * currentUser() is only called on cache miss when we need the email
 * for PostHog person-property targeting.
 *
 * Only the 8 gated routes hit PostHog. The 7 shipped routes are
 * hardcoded true - zero API overhead.
 */
export async function getFeatureFlags(): Promise<FeatureFlagsResponse> {
  try {
    const { userId: clerkUserId } = await auth();

    if (!clerkUserId) {
      const flags = applyKillSwitch(getDefaultFlags());
      return {
        flags,
        version: generateFlagVersion(flags),
        timestamp: Date.now(),
      };
    }

    const cacheKey = generateCacheKey(clerkUserId);
    const now = Date.now();

    // Try Redis cache first
    const redisCached = await getCachedFlags(cacheKey);
    if (redisCached && now - redisCached.timestamp < CACHE_TTL) {
      return withKillSwitch(redisCached);
    }

    // Fallback to in-memory cache
    const cached = flagsCache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_TTL) {
      return withKillSwitch(cached);
    }

    // Cache miss - need email for PostHog person-property targeting.
    // Only call currentUser() here, not on every request.
    const user = await currentUser();
    const userEmail = user?.emailAddresses?.[0]?.emailAddress;
    const userName = user?.fullName || user?.firstName || undefined;

    const evaluated = await evaluateFeatureFlags(
      clerkUserId,
      userEmail,
      userName
    );

    if (evaluated === null) {
      // MONEY-1123: PostHog could not be evaluated. Serve safe defaults for
      // THIS request only and write NEITHER cache, so the next request retries.
      // The kill switch still applies, so this path fails CLOSED.
      const fallback = applyKillSwitch(getDefaultFlags());
      return {
        flags: fallback,
        version: generateFlagVersion(fallback),
        timestamp: now,
      };
    }

    const flags = applyKillSwitch(evaluated);
    const version = await setCachedFlags(cacheKey, flags);

    const response: FeatureFlagsResponse = { flags, version, timestamp: now };
    flagsCache.set(cacheKey, response);
    pruneFlagsCache(now);

    return response;
  } catch (error) {
    logger.error({ error }, "Critical error getting feature flags");
    const flags = applyKillSwitch(getDefaultFlags());
    return {
      flags,
      version: generateFlagVersion(flags),
      timestamp: Date.now(),
    };
  }
}

/**
 * MONEY-457: Enforce FORCE_DISABLED_ROUTES at the response boundary. Even
 * if a stale Redis / in-memory cache entry still carries `true` for a
 * kill-switched route, the user sees `false`. The cache itself is
 * untouched — it will refresh on next miss with the correct value.
 */
function applyKillSwitch(flags: FeatureFlagMap): FeatureFlagMap {
  const killed = Array.from(FORCE_DISABLED_ROUTES);
  const needsRewrite = killed.some((route) => flags[route] !== false);
  if (!needsRewrite) return flags;
  const out: FeatureFlagMap = { ...flags };
  for (const route of killed) {
    out[route] = false;
  }
  return out;
}

function withKillSwitch(response: FeatureFlagsResponse): FeatureFlagsResponse {
  const flags = applyKillSwitch(response.flags);
  if (flags === response.flags) return response;
  return {
    ...response,
    flags,
    version: generateFlagVersion(flags),
  };
}

// ── US / International Feature Flags ──────────────────────────────

const US_FEATURE_FLAG_KEYS: Record<UsFeatureFlag, string> = {
  "us-stocks-listing": "us-stocks-listing",
  "us-stocks-search": "us-stocks-search",
  "us-broker-ib": "us-broker-ib",
  "global-mf": "global-mf",
  "us-stock-research": "us-stock-research",
};

const US_FLAGS_DEFAULT: UsFeatureFlagMap = {
  "us-stocks-listing": false,
  "us-stocks-search": false,
  "us-broker-ib": false,
  "global-mf": false,
  "us-stock-research": false,
};

/**
 * Server-side evaluation of US / International feature flags.
 * These flags are separate from page-visibility flags and control
 * cross-cutting US stock, IB broker, and global MF features.
 *
 * PostHog targeting: flags should be set to match only
 * specific users (e.g., email = deepshaswat@gmail.com).
 *
 * PERF (MONEY-1123): mirrors `getFeatureFlags` — `auth()` (signed-cookie read,
 * ~2ms) resolves the user id, the cache is consulted, and `currentUser()` (HTTP
 * to Clerk, ~200ms) is only called on a cache MISS to obtain the email/name for
 * PostHog person-property targeting. This used to call `currentUser()` FIRST,
 * so even a 100% cache hit paid the Clerk round trip — on `/api/market/search`
 * that is every debounced keystroke.
 */
export async function getUsFeatureFlags(): Promise<UsFeatureFlagsResponse> {
  try {
    const { userId } = await auth();
    if (!userId) {
      const version = generateFlagVersion(
        US_FLAGS_DEFAULT as unknown as FeatureFlagMap
      );
      return { flags: { ...US_FLAGS_DEFAULT }, version, timestamp: Date.now() };
    }

    // MONEY-1123: keyed by userId ONLY (no email hash), matching
    // `getFeatureFlags`. Changing the key shape is safe here because this cache
    // is in-process (`flagsCache` is a Map, never Redis), so there is no
    // cross-deploy / cross-instance compatibility concern. Trade-off: an email
    // change is now reflected on the next TTL expiry (<= 5 min) rather than
    // instantly, which is the behaviour `getFeatureFlags` already has.
    const cacheKey = `us:${generateCacheKey(userId)}`;
    const now = Date.now();

    // Check in-memory cache BEFORE any Clerk API call.
    const cached = flagsCache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_TTL) {
      return {
        flags: cached.flags as unknown as UsFeatureFlagMap,
        version: cached.version,
        timestamp: cached.timestamp,
      };
    }

    // Cache miss - only now do we need the email/name for PostHog targeting.
    const user = await currentUser();
    if (!user?.id) {
      // A session cookie whose Clerk user cannot be resolved (deleted user or
      // a Clerk outage). Unchanged behaviour: defaults, no PostHog call, and
      // deliberately NOT cached since it is a transient condition.
      const version = generateFlagVersion(
        US_FLAGS_DEFAULT as unknown as FeatureFlagMap
      );
      return { flags: { ...US_FLAGS_DEFAULT }, version, timestamp: Date.now() };
    }

    const userEmail = user.emailAddresses?.[0]?.emailAddress;
    const userName = user.fullName || user.firstName || undefined;

    // Fetch from PostHog
    const personProperties: Record<string, string> = {};
    if (userEmail) personProperties.email = userEmail;
    if (userName) personProperties.name = userName;

    const posthogFlags = await fetchFlagsFromPostHog(userId, personProperties);

    if (posthogFlags === null) {
      // MONEY-1123: evaluation FAILED. US flags default to false (fail closed)
      // for this request only - do NOT cache, so the next request retries.
      const version = generateFlagVersion(
        US_FLAGS_DEFAULT as unknown as FeatureFlagMap
      );
      return { flags: { ...US_FLAGS_DEFAULT }, version, timestamp: Date.now() };
    }

    const flags: UsFeatureFlagMap = { ...US_FLAGS_DEFAULT };
    for (const [flag, key] of Object.entries(US_FEATURE_FLAG_KEYS)) {
      const val = posthogFlags[key];
      flags[flag as UsFeatureFlag] =
        val === true ||
        (typeof val === "string" &&
          val !== "false" &&
          val !== "off" &&
          val.length > 0);
    }

    const version = generateFlagVersion(flags as unknown as FeatureFlagMap);
    const response = { flags, version, timestamp: now };
    flagsCache.set(cacheKey, {
      flags: flags as unknown as FeatureFlagMap,
      version,
      timestamp: now,
    });
    pruneFlagsCache(now);

    return response;
  } catch (error) {
    logger.error({ error }, "Error getting US feature flags");
    const version = generateFlagVersion(
      US_FLAGS_DEFAULT as unknown as FeatureFlagMap
    );
    return { flags: { ...US_FLAGS_DEFAULT }, version, timestamp: Date.now() };
  }
}

// ── App-level Feature Flags ──────────────────────────────────────
// MONEY-394 E - Non-route UI gates (e.g. a single button). Modelled on
// the US flag system: separate PostHog evaluation, default-false on
// unauthenticated / error, in-memory + Redis-backed caching.

const APP_FEATURE_FLAG_KEYS: Record<AppFeatureFlag, string> = {
  "generate-report": "generate-report",
  "terminal-luxe-sectors": "terminal-luxe-sectors",
  "terminal-luxe-news": "terminal-luxe-news",
  "terminal-luxe-analysis-v2": "terminal-luxe-analysis-v2",
  "terminal-luxe-risk-v2": "terminal-luxe-risk-v2",
  "terminal-luxe-tax-v2": "terminal-luxe-tax-v2",
  "terminal-luxe-strategies-v2": "terminal-luxe-strategies-v2",
  "doc-vault-research-pin": "doc-vault-research-pin",
  "holdings-research-trigger": "holdings-research-trigger",
  "federated-data": "federated-data",
};

const APP_FLAGS_DEFAULT: AppFeatureFlagMap = {
  "generate-report": false,
  "terminal-luxe-sectors": false,
  "terminal-luxe-news": false,
  "terminal-luxe-analysis-v2": false,
  "terminal-luxe-risk-v2": false,
  "terminal-luxe-tax-v2": false,
  "terminal-luxe-strategies-v2": false,
  "doc-vault-research-pin": false,
  "holdings-research-trigger": false,
  "federated-data": false,
};

/**
 * Server-side evaluation of app-level feature flags. These gate specific
 * UI surfaces that aren't tied to a single page route (e.g. the
 * Generate Report button on /documents).
 *
 * PERF (MONEY-1123): same auth() → cache → currentUser()-only-on-miss ordering
 * as `getFeatureFlags` / `getUsFeatureFlags`; this path carried the identical
 * copy-drift (Clerk HTTP call ahead of the cache read).
 */
export async function getAppFeatureFlags(): Promise<AppFeatureFlagsResponse> {
  try {
    const { userId } = await auth();
    if (!userId) {
      const version = generateFlagVersion(
        APP_FLAGS_DEFAULT as unknown as FeatureFlagMap
      );
      return {
        flags: { ...APP_FLAGS_DEFAULT },
        version,
        timestamp: Date.now(),
      };
    }

    // userId-only key — see the note on getUsFeatureFlags' cache key.
    const cacheKey = `app:${generateCacheKey(userId)}`;
    const now = Date.now();

    const cached = flagsCache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_TTL) {
      return {
        flags: cached.flags as unknown as AppFeatureFlagMap,
        version: cached.version,
        timestamp: cached.timestamp,
      };
    }

    // Cache miss - only now do we need the email/name for PostHog targeting.
    const user = await currentUser();
    if (!user?.id) {
      const version = generateFlagVersion(
        APP_FLAGS_DEFAULT as unknown as FeatureFlagMap
      );
      return {
        flags: { ...APP_FLAGS_DEFAULT },
        version,
        timestamp: Date.now(),
      };
    }

    const userEmail = user.emailAddresses?.[0]?.emailAddress;
    const userName = user.fullName || user.firstName || undefined;

    const personProperties: Record<string, string> = {};
    if (userEmail) personProperties.email = userEmail;
    if (userName) personProperties.name = userName;

    const posthogFlags = await fetchFlagsFromPostHog(userId, personProperties);

    if (posthogFlags === null) {
      // MONEY-1123: evaluation FAILED - defaults (fail closed) for this request
      // only, NOT cached, so the next request retries.
      const version = generateFlagVersion(
        APP_FLAGS_DEFAULT as unknown as FeatureFlagMap
      );
      return {
        flags: { ...APP_FLAGS_DEFAULT },
        version,
        timestamp: Date.now(),
      };
    }

    const flags: AppFeatureFlagMap = { ...APP_FLAGS_DEFAULT };
    for (const [flag, key] of Object.entries(APP_FEATURE_FLAG_KEYS)) {
      const val = posthogFlags[key];
      flags[flag as AppFeatureFlag] =
        val === true ||
        (typeof val === "string" &&
          val !== "false" &&
          val !== "off" &&
          val.length > 0);
    }

    const version = generateFlagVersion(flags as unknown as FeatureFlagMap);
    const response = { flags, version, timestamp: now };
    flagsCache.set(cacheKey, {
      flags: flags as unknown as FeatureFlagMap,
      version,
      timestamp: now,
    });
    pruneFlagsCache(now);

    return response;
  } catch (error) {
    logger.error({ error }, "Error getting app feature flags");
    const version = generateFlagVersion(
      APP_FLAGS_DEFAULT as unknown as FeatureFlagMap
    );
    return { flags: { ...APP_FLAGS_DEFAULT }, version, timestamp: Date.now() };
  }
}

/**
 * Clear feature flags cache for a specific user or all users
 */
export async function clearFeatureFlagsCache(
  userId?: string,
  userEmail?: string
) {
  if (userId) {
    const cacheKey = generateCacheKey(userId, userEmail);
    await clearCachedFlags(cacheKey);
    await clearCachedFlags(userId);
    flagsCache.delete(cacheKey);
    flagsCache.delete(userId);
    logger.info({ userId }, "Cleared feature flags cache for user");
  } else {
    await clearAllRedisFlags();
    flagsCache.clear();
    logger.info({}, "Cleared all feature flags cache");
  }
}
