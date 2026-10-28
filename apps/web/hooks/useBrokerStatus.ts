"use client";

/**
 * useBrokerStatus Hook
 *
 * Fetches the user's broker connection status for market data.
 * Caches the result in-memory for the session to avoid repeated API calls.
 * Used to conditionally show the BrokerReauthBanner and disable Zerodha-only intervals.
 */

import { useState, useEffect, useRef } from "react";

// ============== TYPES ==============

export interface BrokerStatus {
  hasBroker: boolean;
  broker: string | null;
  status: "active" | "needs_reauth" | "none";
  brokerDisplayName: string | null;
  reauthUrl: string | null;
}

export interface UseBrokerStatusResult {
  /** Broker connection status */
  brokerStatus: BrokerStatus;
  /** Whether the status is still loading */
  isLoading: boolean;
  /** Force re-check broker status */
  refresh: () => void;
}

// ============== SESSION CACHE ==============

let cachedStatus: BrokerStatus | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 60 seconds

function getCachedStatus(): BrokerStatus | null {
  if (cachedStatus && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedStatus;
  }
  return null;
}

function setCachedStatus(status: BrokerStatus): void {
  cachedStatus = status;
  cacheTimestamp = Date.now();
}

// ============== HOOK ==============

const DEFAULT_STATUS: BrokerStatus = {
  hasBroker: false,
  broker: null,
  status: "none",
  brokerDisplayName: null,
  reauthUrl: null,
};

export function useBrokerStatus(): UseBrokerStatusResult {
  const [status, setStatus] = useState<BrokerStatus>(
    () => getCachedStatus() ?? DEFAULT_STATUS
  );
  const [isLoading, setIsLoading] = useState(() => getCachedStatus() === null);
  const mountedRef = useRef(true);
  const fetchingRef = useRef(false);

  const fetchStatus = () => {
    // Skip API call in demo mode
    if (
      typeof window !== "undefined" &&
      localStorage.getItem("tradebook_demo_mode") === "true"
    ) {
      setStatus(DEFAULT_STATUS);
      setIsLoading(false);
      return;
    }

    // Avoid duplicate concurrent requests
    if (fetchingRef.current) return;

    const cached = getCachedStatus();
    if (cached) {
      setStatus(cached);
      setIsLoading(false);
      return;
    }

    fetchingRef.current = true;
    setIsLoading(true);

    fetch("/api/market/broker-status")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch broker status");
        return res.json();
      })
      .then((data) => {
        if (!mountedRef.current) return;

        const brokerStatus: BrokerStatus = {
          hasBroker: data.hasBroker ?? false,
          broker: data.broker ?? null,
          status: data.status ?? "none",
          brokerDisplayName: data.brokerDisplayName ?? null,
          reauthUrl: data.reauthUrl ?? null,
        };

        setCachedStatus(brokerStatus);
        setStatus(brokerStatus);
      })
      .catch(() => {
        // Silently fail - default to Yahoo
      })
      .finally(() => {
        if (mountedRef.current) {
          setIsLoading(false);
        }
        fetchingRef.current = false;
      });
  };

  const refresh = () => {
    // Clear cache to force re-fetch
    cachedStatus = null;
    cacheTimestamp = 0;
    fetchStatus();
  };

  useEffect(() => {
    mountedRef.current = true;
    fetchStatus();

    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { brokerStatus: status, isLoading, refresh };
}

export default useBrokerStatus;
