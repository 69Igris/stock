"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { getAppFeatureFlags } from "@/lib/actions/feature-flags";
import type { AppFeatureFlagMap } from "@/lib/types/feature-flags";

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
 * Client hook for app-level (non-route) feature flags.
 *
 * MONEY-394 E - Returns flags that control individual UI surfaces:
 * - `generate-report`: gates the Generate Report dropdown on /documents
 *
 * Mirrors the useUsFeatureFlags pattern: default-false on initial mount,
 * fetched server-side via getAppFeatureFlags() once the user is loaded.
 * Cancellation guard on unmount.
 */
export function useAppFeatureFlags(): {
  flags: AppFeatureFlagMap;
  isLoading: boolean;
} {
  const { user, isLoaded } = useUser();
  const [flags, setFlags] = useState<AppFeatureFlagMap>(APP_FLAGS_DEFAULT);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isLoaded) return;
    if (!user) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const result = await getAppFeatureFlags();
        if (!cancelled) setFlags(result.flags);
      } catch {
        // Keep defaults (all false)
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, isLoaded]);

  return { flags, isLoading };
}
