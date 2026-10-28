"use client";

/**
 * SessionGuard (MONEY-144)
 *
 * Catches the "ghost session" state where Clerk still has the user
 * authenticated but the underlying account is being deleted (audit
 * row in PENDING/PROCESSING/LOCKED). This happens because:
 *
 *   - Clerk's `lockUser` blocks future sign-ins but doesn't revoke
 *     active session cookies (we now also revoke in the worker, but
 *     this guard is the belt-and-braces fallback).
 *   - The worker may have hard-deleted the User row before the
 *     browser session expires, so any server action that does a User
 *     lookup will 500.
 *
 * Asks the server once the user is loaded. If the answer is
 * "ghosted", forces signOut and bounces to homepage. Silent on
 * errors - we never want to accidentally sign out a healthy user.
 *
 * MONEY-1126: the effect keys on `pathname`, so this fired one
 * `isSessionGhostedAction` per client-side navigation for the whole
 * session. It now resolves once per page load instead. The gate is
 * strictly no weaker: only a definitive NOT-ghosted answer is
 * remembered, so a rejected call (or a ghosted one, which signs the
 * user out anyway) leaves the slot empty and the next navigation
 * re-checks exactly as it did before. The path/demo skips below still
 * run on every navigation, so a user who lands on a checked route
 * later in the session is still checked there.
 */

import { useEffect } from "react";
import { useUser, useClerk } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { isSessionGhostedAction } from "@/lib/actions/user";
import { createOncePerUserCache } from "@/lib/utils/once-per-user-cache";
import { clearCachedPlan } from "@/lib/subscription/plan-cache";

// Module singleton: memory only, single slot, keyed by Clerk user id.
const ghostCheck = createOncePerUserCache<{
  ghosted: boolean;
  determined: boolean;
}>({
  // Remember ONLY a DETERMINED "this session is healthy".
  //
  // `determined` is load-bearing, not decoration: `isSessionGhostedAction`
  // never rejects — it converts a DB failure into the non-blocking `ghosted:
  // false` — so the helper's "a rejection is never remembered" guarantee does
  // nothing here on its own. Keying on the boolean alone meant one transient
  // error was cached as "healthy" and the check never ran again for the rest of
  // the page load, even after the database recovered.
  shouldRemember: (r) => r.determined && r.ghosted === false,
});

export default function SessionGuard() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoaded || !user) return;
    // Skip on demo + auth routes so the check doesn't run before sign-in
    // or while browsing the marketing site as a logged-out demo viewer.
    if (
      pathname === "/" ||
      pathname.startsWith("/sign-in") ||
      pathname.startsWith("/sign-up") ||
      pathname.startsWith("/api/")
    ) {
      return;
    }
    if (
      typeof window !== "undefined" &&
      localStorage.getItem("tradebook_demo_mode") === "true"
    ) {
      return;
    }

    // Already DEFINITIVELY confirmed healthy this page load — nothing to ask.
    if (ghostCheck.peek(user.id)?.ghosted === false) return;

    let cancelled = false;
    ghostCheck
      .get(user.id, isSessionGhostedAction)
      .then(({ ghosted }) => {
        if (cancelled || !ghosted) return;
        // MONEY-1134 — drop the persisted plan first. A ghosted session is a
        // user whose DB row is gone; leaving `um_plan_v1` behind means the next
        // person on this browser hydrates a deleted user's billing tier.
        clearCachedPlan();
        // Force-signout + bounce to homepage. Use replace to avoid
        // leaving the ghost-state page in browser history.
        void signOut({ redirectUrl: "/" });
      })
      .catch(() => {
        // Stay silent; healthy users should never be signed out.
      });

    return () => {
      cancelled = true;
    };
  }, [isLoaded, user, pathname, signOut]);

  return null;
}
