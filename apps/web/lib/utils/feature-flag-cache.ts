/**
 * Client-side feature flag caching utility
 * Stores feature flags in localStorage to minimize server calls
 */

import type { FeatureFlagMap } from "@/lib/types/feature-flags";

const CACHE_KEY = "ff_cache";
const CACHE_VERSION_KEY = "ff_cache_version";
const CACHE_TIMESTAMP_KEY = "ff_cache_timestamp";
const CACHE_USER_KEY = "ff_cache_user";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface CachedFeatureFlags {
  flags: FeatureFlagMap;
  version: string;
  timestamp: number;
}

/**
 * Get the cached user ID
 */
export function getCachedUserId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return localStorage.getItem(CACHE_USER_KEY);
  } catch {
    return null;
  }
}

/**
 * Set the cached user ID
 */
export function setCachedUserId(userId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(CACHE_USER_KEY, userId);
  } catch {
    // Silent fail
  }
}

/**
 * Get cached feature flags from localStorage
 */
export function getCachedFeatureFlagsLocal(): CachedFeatureFlags | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const cached = localStorage.getItem(CACHE_KEY);
    const version = localStorage.getItem(CACHE_VERSION_KEY);
    const timestamp = localStorage.getItem(CACHE_TIMESTAMP_KEY);

    if (!cached || !version || !timestamp) {
      return null;
    }

    const parsedTimestamp = parseInt(timestamp, 10);
    const now = Date.now();

    if (now - parsedTimestamp > CACHE_TTL_MS) {
      return null;
    }

    const flags = JSON.parse(cached) as FeatureFlagMap;

    return {
      flags,
      version,
      timestamp: parsedTimestamp,
    };
  } catch {
    return null;
  }
}

/**
 * Set feature flags in localStorage
 */
export function setCachedFeatureFlagsLocal(
  flags: FeatureFlagMap,
  version: string
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const timestamp = Date.now();
    localStorage.setItem(CACHE_KEY, JSON.stringify(flags));
    localStorage.setItem(CACHE_VERSION_KEY, version);
    localStorage.setItem(CACHE_TIMESTAMP_KEY, timestamp.toString());
  } catch {
    // Silent fail
  }
}

/**
 * Clear local feature flag cache
 */
export function clearCachedFeatureFlagsLocal(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_VERSION_KEY);
    localStorage.removeItem(CACHE_TIMESTAMP_KEY);
    localStorage.removeItem(CACHE_USER_KEY);
  } catch {
    // Silent fail
  }
}

/**
 * Check if local cache needs refresh by comparing version
 */
export function shouldRefreshCache(serverVersion: string): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  try {
    const localVersion = localStorage.getItem(CACHE_VERSION_KEY);
    return localVersion !== serverVersion;
  } catch {
    return true;
  }
}

/**
 * Debug utility: Expose cache clearing function to window for console access
 */
if (typeof window !== "undefined") {
  (window as any).clearFeatureFlagCache = () => {
    clearCachedFeatureFlagsLocal();
    console.log(
      "✅ Feature flag cache cleared! Refresh the page to fetch new flags."
    );
  };
}
