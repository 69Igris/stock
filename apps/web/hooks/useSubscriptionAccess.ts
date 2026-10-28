"use client";

import { useState, useEffect } from "react";
import { withFetchRetry } from "@/lib/utils/retry";

interface SubscriptionAccessState {
  planId: string;
  isLoading: boolean;
}

export function useSubscriptionAccess(
  isDemoMode: boolean
): SubscriptionAccessState {
  const [planId, setPlanId] = useState<string>("FREE");
  const [isLoading, setIsLoading] = useState(!isDemoMode);

  useEffect(() => {
    if (isDemoMode) {
      setPlanId("PREMIUM");
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchAccess() {
      try {
        const response = await withFetchRetry(() =>
          fetch("/api/subscription/access")
        );
        if (response.ok && !cancelled) {
          const data = await response.json();
          setPlanId(data.planId ?? "FREE");
        }
      } catch {
        // Keep FREE on error
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchAccess();
    return () => {
      cancelled = true;
    };
  }, [isDemoMode]);

  return { planId, isLoading };
}
