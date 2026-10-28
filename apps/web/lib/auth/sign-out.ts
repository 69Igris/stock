"use client";

/**
 * Instant sign-out (MONEY-484).
 *
 * Logout should feel instant and abandon any in-flight work. Calling Clerk's
 * `signOut({ redirectUrl })` alone leaves the current page mounted during the
 * session-revoke round-trip, so page skeletons / loaders can keep flashing.
 *
 * `showSignOutOverlay()` synchronously paints a full-screen mask (z-index max)
 * the instant logout is clicked, so every loader/skeleton disappears at once.
 * `instantSignOut()` then clears the session and HARD-navigates — a real browser
 * navigation tears down all in-flight fetches, timers, and React state.
 *
 * MONEY-1134: it also drops the persisted plan, so nothing of the outgoing
 * user survives into the next session on a shared browser.
 */

import { clearCachedPlan } from "@/lib/subscription/plan-cache";

let overlayShown = false;

export function showSignOutOverlay(label = "Signing out…"): void {
  if (typeof document === "undefined" || overlayShown) return;
  overlayShown = true;
  const o = document.createElement("div");
  o.id = "um-signing-out";
  o.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;" +
    "background:var(--paper,#f7f3e6);color:var(--ink,#1d1d1b);" +
    "font-family:var(--font-dm-sans,system-ui),sans-serif;" +
    "font-size:14px;font-weight:600;letter-spacing:-0.2px;";
  o.textContent = label;
  document.body.appendChild(o);
}

// Accepts both Clerk's `useClerk().signOut` and the narrower `(opts) => void`
// signOut prop some Sidebar sub-components are typed with.
type ClerkSignOut = (opts: { redirectUrl: string }) => unknown;

export function instantSignOut(
  signOut: ClerkSignOut,
  redirectUrl = "/home"
): void {
  showSignOutOverlay();
  // MONEY-1134 — drop the persisted plan BEFORE the session goes away.
  //
  // `clearCachedPlan` was written for exactly this path and its doc comment
  // says so ("sign-out path"), but it had ZERO production call sites — tests
  // only. So `um_plan_v1` survived sign-out in localStorage, and on a shared
  // browser the next person hydrated the previous user's plan.
  //
  // Impact is presentational today (the tier chip and walkthrough copy;
  // `entitlement-isolation.test.ts` pins that no gate reads this value), which
  // is why it is not a privilege escalation. It is still someone else's billing
  // tier rendered as yours.
  //
  // Called synchronously, not in the `.finally`: this is pure localStorage work
  // and must happen even if `signOut()` rejects or the hard-navigate races it.
  // `clearCachedPlan` also bumps a generation, so a fetch already in flight
  // cannot write the old plan back after this point.
  clearCachedPlan();
  // Clear the Clerk session, then hard-navigate regardless of outcome so the
  // user is never stranded behind the overlay.
  Promise.resolve(signOut({ redirectUrl }))
    .catch(() => {})
    .finally(() => {
      if (typeof window !== "undefined") window.location.replace(redirectUrl);
    });
}

/**
 * Instant demo-exit — the "End Demo" counterpart to instantSignOut.
 *
 * Same contract as sign-out: paint the full-screen overlay synchronously so the
 * page never looks stuck, then clear the demo session and HARD-navigate. The
 * overlay covers the `POST /api/demo/end` round-trip — which must finish before
 * we land on /home, else it re-renders in demo mode — so it FEELS instant while
 * still clearing the cookie correctly. All demo localStorage is wiped first.
 */
export function instantEndDemo(redirectUrl = "/home"): void {
  showSignOutOverlay("Exiting demo…");
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem("paper_trading_data");
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("tradebook_")) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore — cookie clear + redirect still happen */
  }
  Promise.resolve(
    fetch("/api/demo/end", { method: "POST" }).catch(() => {})
  ).finally(() => {
    window.location.replace(redirectUrl);
  });
}
