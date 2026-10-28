"use client";

/**
 * useMarketStatus - client-side companion to packages/core's
 * `getNseMarketStatus`. Re-evaluates the phase on a 30-second
 * interval so the UI badge transitions automatically across the
 * 09:15 / 15:30 boundaries without a page reload.
 *
 * Returns the same `MarketStatus` shape produced by core, plus a
 * derived `closedReason` string so a caller can render the badge in
 * one line.
 *
 * Usage:
 *   const status = useMarketStatus();
 *   const isLive = status.isLive;
 */

import { useEffect, useState } from "react";
// IMPORTANT: import from the dedicated subpath, NOT `@usemoney/core` barrel.
// The barrel transitively pulls in `gemini/client.ts` → `@google/genai`
// → `google-auth-library`, which uses `fs` / `child_process` and breaks the
// Next.js client bundle ("Module not found: Can't resolve 'fs'"). The
// market-hours module is pure logic + the holiday calendar; safe for client.
import {
  getNseMarketStatus,
  formatClosedReason,
  type MarketStatus,
} from "@usemoney/core/market-data/market-hours";

export interface UseMarketStatusResult {
  status: MarketStatus;
  /** Pre-formatted "Closed · Diwali Laxmi Pujan" / "Opens 09:15 IST" string,
   *  null when the market is open. */
  closedReason: string | null;
}

export function useMarketStatus(): UseMarketStatusResult {
  const [status, setStatus] = useState<MarketStatus>(() =>
    getNseMarketStatus()
  );

  useEffect(() => {
    // Re-evaluate every 30s so the badge flips on its own around the
    // open/close boundaries. Cheap (no I/O), so we don't bother
    // gating on visibility or focus.
    const id = setInterval(() => {
      setStatus(getNseMarketStatus());
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  return {
    status,
    closedReason: formatClosedReason(status),
  };
}

export default useMarketStatus;
