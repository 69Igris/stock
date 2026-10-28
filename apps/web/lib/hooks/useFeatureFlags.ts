"use client";

import { useState, useEffect, useRef } from "react";
import { useUser } from "@clerk/nextjs";
import { getFeatureFlags } from "@/lib/actions/feature-flags";
import type {
  FeatureFlagState,
  FeatureFlagMap,
} from "@/lib/types/feature-flags";
import {
  getCachedFeatureFlagsLocal,
  setCachedFeatureFlagsLocal,
  clearCachedFeatureFlagsLocal,
  getCachedUserId,
  setCachedUserId,
} from "@/lib/utils/feature-flag-cache";
import {
  readDemoFlagFromStorage,
  resolveClientDemoState,
  DEMO_LOCALSTORAGE_KEY,
  DEMO_SESSION_ENDED_EVENT,
} from "@/lib/hooks/useIsDemoMode";

/**
 * Default flags: shipped routes are always ON (no PostHog evaluation needed).
 * Gated routes default to TRUE here so pages don't flash "Coming Soon" while
 * the real flags load from cache/server. The server response corrects them.
 */
const DEFAULT_FLAGS: FeatureFlagMap = {
  // Shipped - always on, never checked against PostHog
  "/tradebook": true,
  "/positions": true,
  "/holdings": true,
  "/discover": true,
  "/analysis": true,
  "/watchlist": true,
  "/roast": true,
  // Kill-switch (MONEY-444): paper-trading is hidden by default; only
  // allowlisted cohort flips it on. Start false so anonymous landing
  // visitors never see paper-trading mentions in the brief pre-hydration
  // window before the real flag loads.
  "/paper-trading": false,
  // MONEY-1058: founder-only Scans library — default FALSE (like
  // paper-trading) so it never flashes to non-allowlisted users in the
  // brief pre-hydration window; the server flag flips it on for the founder.
  "/discover/scans": false,
  // Gated - optimistically true to avoid flash, server corrects on load
  "/sage-tutor": true,
  "/learning": true,
  "/risk": true,
  "/tax": true,
  "/documents": true,
  "/strategies": true,
  "/quizzes": true,
};

const BACKGROUND_REFRESH_THRESHOLD = 2 * 60 * 1000; // 2 minutes
const LOADING_TIMEOUT = 3000; // 3s max wait when no cache exists

export function useFeatureFlags(): FeatureFlagState {
  const { user, isLoaded: isUserLoaded } = useUser();
  const [clientDemoFlag, setClientDemoFlag] = useState(false);
  const [flags, setFlags] = useState<FeatureFlagMap>(DEFAULT_FLAGS);
  const [isLoading, setIsLoading] = useState(true);
  const resolvedFromCacheRef = useRef(false);

  /**
   * MONEY-1137 — DERIVED, not stored, and gated on the authenticated user.
   *
   * This hook's `isDemoMode` is not cosmetic: `PageGuard` feeds it straight
   * into `computeGuardDecision`, whose demo branch returns NO_GATE for every
   * non-kill-switch route — skipping the plan check entirely. Reading the
   * localStorage flag WITHOUT a user gate therefore made the premium paywall
   * self-service: a signed-in FREE user setting `tradebook_demo_mode=true` in
   * devtools opened `/risk`, `/tax` and `/documents`. Worse, the old code also
   * early-returned out of Effect 2, so the real flags were never fetched and
   * the state never self-corrected.
   *
   * That devtools flip no longer yields premium DATA: MONEY-1142 gave the
   * server actions their own tier check (`requireFeature` in `risk.ts`,
   * `tax.ts`, `documents.ts`, …), so the actions deny regardless of what any
   * client believes. This gate is now the OUTER of two independent layers, not
   * the only one — but it still decides what the UI offers, and a client-side
   * paywall that lies is its own bug. Keep both: the server check is what makes
   * it safe, this one is what makes it correct.
   *
   * Deriving instead of storing is what makes the correction automatic: while
   * Clerk is still loading we pass `user: null`, so a genuine demo visitor
   * keeps the fast path with no flash; the moment Clerk resolves a real user
   * this flips to false and Effect 2 stops early-returning and fetches the
   * true flags.
   *
   * Shares `resolveClientDemoState` with `useIsDemoMode` so there is exactly
   * one copy of the precedence rule.
   */
  const isDemoMode = resolveClientDemoState({
    isDemo: false,
    user: isUserLoaded ? (user ?? null) : null,
    clientFlag: clientDemoFlag,
  });

  // Effect 1: Immediate - read localStorage cache on mount (no Clerk needed)
  useEffect(() => {
    const demoFlag = readDemoFlagFromStorage();
    setClientDemoFlag(demoFlag);

    // Re-read when the flag changes: cross-tab via the native storage event,
    // same-tab via DemoSessionGuard's explicit dispatch after it clears the
    // flag on sign-in (same-tab writes do not fire `storage`).
    const reread = () => setClientDemoFlag(readDemoFlagFromStorage());
    const onStorage = (e: StorageEvent) => {
      if (e.key === DEMO_LOCALSTORAGE_KEY) reread();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("storage", onStorage);
      window.addEventListener(DEMO_SESSION_ENDED_EVENT, reread);
    }
    const unsubscribe = () => {
      if (typeof window === "undefined") return;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(DEMO_SESSION_ENDED_EVENT, reread);
    };

    if (demoFlag) {
      setIsLoading(false);
      return unsubscribe;
    }

    // Read cache immediately - doesn't require authentication
    const localCached = getCachedFeatureFlagsLocal();
    if (localCached) {
      setFlags(localCached.flags);
      setIsLoading(false);
      resolvedFromCacheRef.current = true;
      return unsubscribe;
    }

    // No cache available - timeout fallback so pages aren't blocked forever
    const timeout = setTimeout(() => {
      setIsLoading(false);
    }, LOADING_TIMEOUT);

    return () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  }, []);

  // Effect 2: Clerk-dependent - user validation, fresh fetch, background refresh
  useEffect(() => {
    if (isDemoMode || !isUserLoaded) return;

    const currentUserId = user?.id || null;
    const cachedUserId = getCachedUserId();

    // User changed - invalidate old cache and re-fetch
    const userChanged = cachedUserId !== null && cachedUserId !== currentUserId;
    if (userChanged) {
      clearCachedFeatureFlagsLocal();
      resolvedFromCacheRef.current = false;
      setIsLoading(true);
    }

    if (currentUserId) {
      setCachedUserId(currentUserId);
    }

    async function fetchFlags() {
      try {
        // Already resolved from cache in Effect 1 - just background-refresh if stale
        if (resolvedFromCacheRef.current) {
          const localCached = getCachedFeatureFlagsLocal();
          if (localCached) {
            const age = Date.now() - localCached.timestamp;
            if (age > BACKGROUND_REFRESH_THRESHOLD) {
              refreshFlagsInBackground();
            }
            return;
          }
          // Cache was invalidated (user changed) - fall through to server fetch
        }

        // Fetch fresh flags from server
        const response = await getFeatureFlags();
        setFlags(response.flags);
        setCachedFeatureFlagsLocal(response.flags, response.version);
        resolvedFromCacheRef.current = true;
      } catch {
        // Keep current flags on error
      } finally {
        setIsLoading(false);
      }
    }

    async function refreshFlagsInBackground() {
      try {
        const response = await getFeatureFlags();
        setFlags(response.flags);
        setCachedFeatureFlagsLocal(response.flags, response.version);
      } catch {
        // Silent fail for background refresh
      }
    }

    fetchFlags();
  }, [isUserLoaded, user?.id, isDemoMode]);

  return { flags, isLoading, isDemoMode };
}
