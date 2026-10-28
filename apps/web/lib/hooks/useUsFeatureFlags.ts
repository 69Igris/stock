"use client";

import { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { getUsFeatureFlags } from "@/lib/actions/feature-flags";
import type { UsFeatureFlagMap } from "@/lib/types/feature-flags";

const US_FLAGS_DEFAULT: UsFeatureFlagMap = {
  "us-stocks-listing": false,
  "us-stocks-search": false,
  "us-broker-ib": false,
  "global-mf": false,
  "us-stock-research": false,
};

/**
 * Client hook for US / International feature flags.
 * Returns flags that control visibility of:
 * - US stock listings in discover/search
 * - Interactive Brokers broker option
 * - Global MF features
 * - US stock research in AI agent
 */
export function useUsFeatureFlags(): {
  flags: UsFeatureFlagMap;
  isLoading: boolean;
} {
  const { user, isLoaded } = useUser();
  const [flags, setFlags] = useState<UsFeatureFlagMap>(US_FLAGS_DEFAULT);
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
        const result = await getUsFeatureFlags();
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
