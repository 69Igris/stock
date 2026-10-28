"use client";

import { useEffect, useRef } from "react";
import { useUser } from "@clerk/nextjs";
import { DEMO_SESSION_ENDED_EVENT } from "@/lib/hooks/useIsDemoMode";

/**
 * MONEY-439: When Clerk auth lands after `/api/demo/start` has already set
 * the `sb_demo` cookie + `tradebook_demo_mode` localStorage flag, the demo
 * state never gets cleaned up. Server-side `isDemoSession()` now ignores
 * the cookie when a Clerk user exists, but the leftover state still
 * pollutes any client-only demo checks and burns its 24 h TTL inside the
 * browser. This guard runs once globally and reconciles both layers the
 * moment Clerk reports an authenticated user.
 *
 * - localStorage: removed inline (no network round-trip needed).
 * - Cookies: cleared via the existing `POST /api/demo/end` route which
 *   already deletes both `sb_demo` and `sb_demo_did`. Fire-and-forget;
 *   the server-side short-circuit is the load-bearing protection.
 */
export default function DemoSessionGuard() {
  const { isLoaded, isSignedIn } = useUser();
  const cleanedRef = useRef(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    if (cleanedRef.current) return;
    cleanedRef.current = true;

    const hadFlag =
      typeof window !== "undefined" &&
      localStorage.getItem("tradebook_demo_mode") === "true";
    const hadCookie =
      typeof document !== "undefined" &&
      /(?:^|; )sb_demo=/.test(document.cookie);

    if (hadFlag) {
      localStorage.removeItem("tradebook_demo_mode");
      localStorage.removeItem("tradebook_user_id");
    }

    if (hadCookie) {
      fetch("/api/demo/end", { method: "POST", keepalive: true }).catch(() => {
        // Best-effort: the server-side isDemoSession() short-circuit
        // protects us even if this network call fails.
      });
    }

    // Broadcast same-tab so every mounted useIsDemoMode hook re-reads
    // localStorage and flips to false. Native `storage` events only
    // fire across tabs, not for same-tab writes — this dispatch is the
    // only signal that catches components mounted before sign-in.
    if (hadFlag || hadCookie) {
      window.dispatchEvent(new Event(DEMO_SESSION_ENDED_EVENT));
    }
  }, [isLoaded, isSignedIn]);

  return null;
}
