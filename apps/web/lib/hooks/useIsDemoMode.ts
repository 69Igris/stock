"use client";

import { useEffect, useState } from "react";

/**
 * Canonical demo-mode hook.
 *
 * The demo session is signalled two ways:
 *   1. Server-side: an HMAC-signed `sb_demo` cookie (24 h TTL). Components
 *      that already receive `isDemo` from a server boundary (page.tsx
 *      passes it down) should prefer that — it's authoritative.
 *   2. Client-side: `localStorage["tradebook_demo_mode"] === "true"`,
 *      written by the marketing-page Try Demo button before the hard
 *      navigation that sets the cookie, and as a recovery fallback for
 *      surfaces that mounted before the cookie hydrated.
 *
 * The hazard with the client-side signal is hydration: reading
 * `localStorage` synchronously during render returns `false` on SSR
 * (no window) and `true` on the first client paint — React then blames
 * the developer for the mismatch. The fix is the standard "deferred
 * useEffect" pattern: initial state matches the SSR result (`false`),
 * an effect runs after mount and re-renders with the real value.
 *
 * Most call sites previously inlined this logic, with subtle drift:
 *   - some used `=== "true"`, one writer used `=== "1"` (root cause of
 *     the May 2026 demo-mode regression),
 *   - some forgot the `typeof window` guard,
 *   - some forgot the `mounted` gate and emitted hydration warnings,
 *   - some hard-coded the localStorage key.
 *
 * Centralising the read here removes all four classes of drift.
 *
 * Usage:
 *   const isDemoMode = useIsDemoMode({ user });          // gates on user
 *   const isDemoMode = useIsDemoMode({ isDemo, user });  // + server flag
 *   const isDemoMode = useIsDemoMode({ user: null });    // deliberately
 *                                                       // signed-out surface
 *
 * Parameters:
 *   isDemo  — authoritative server-side flag if available (cookie was
 *             read in a server component / middleware). Pass it through
 *             from the page boundary; the hook will OR it into the
 *             returned value so server-aware surfaces don't depend on
 *             the localStorage round trip at all. Optional.
 *   user    — REQUIRED (MONEY-1137). When present, the localStorage signal
 *             is ignored: a real authenticated user is never in demo mode,
 *             regardless of whatever stale flag happens to live in their
 *             browser. See the note on `UseIsDemoModeOptions.user` for why
 *             this is required rather than optional.
 */

/**
 * The identity signal the demo gate reads. Deliberately accepts the two
 * shapes call sites already have in hand — the Clerk `user` object
 * (`useUser()`) and the Clerk `userId` string (`useAuth()`) — plus an
 * explicit `null`/`undefined` for a surface that is knowingly signed out.
 *
 * It does NOT accept `boolean`, which is the mistake this type exists to
 * catch: `{ user: isSignedIn }` reads plausibly and would have inverted the
 * gate for every signed-OUT visitor (`isSignedIn === false` → falls through
 * to the localStorage flag) while doing nothing for signed-IN ones.
 */
export type DemoModeUser = { id: string } | string | null | undefined;

export interface UseIsDemoModeOptions {
  /** Authoritative server-supplied demo flag (from `isDemoSession()`). */
  isDemo?: boolean;
  /**
   * Real authenticated user; if truthy, demo mode is forced off.
   *
   * REQUIRED, and required on purpose (MONEY-1137). When this was optional,
   * 14 of 41 call sites omitted it — including `Sidebar`, `useIDBCache` and
   * every stock/MF/ETF detail page — so a stale `tradebook_demo_mode`
   * localStorage flag left over from an earlier "Try Demo" visit turned demo
   * state back ON for a fully authenticated, paying session. Because
   * `isDemoMode` gates more than banners (sample-data substitution, disabled
   * actions), that renders FAKE portfolio data to a real user.
   *
   * A surface that is genuinely signed-out (or has no Clerk context) says so
   * deliberately with `{ user: null }`; forgetting it is now a compile error
   * instead of a silent downgrade.
   */
  user: DemoModeUser;
}

/** localStorage key written by the marketing Try Demo button. */
export const DEMO_LOCALSTORAGE_KEY = "tradebook_demo_mode";
/** The single source of truth for the flag's positive value. */
export const DEMO_LOCALSTORAGE_VALUE = "true";

/**
 * Custom event dispatched by `DemoSessionGuard` after it clears the
 * `tradebook_demo_mode` localStorage flag and POSTs `/api/demo/end`.
 * Same-tab storage updates don't fire `window.storage` events, so this
 * gives the hook a way to re-read after the guard wipes state on auth.
 */
export const DEMO_SESSION_ENDED_EVENT = "usemoney:demo-session-ended";

/**
 * Pure read of the client-side demo flag. Exported so the localStorage half
 * of the decision is testable without a DOM renderer (this repo has no RTL);
 * `useIsDemoMode`'s mount effect calls exactly this function, so there is no
 * second copy of the key/value comparison to drift.
 *
 * Returns `false` when there is no `window` (SSR) or when localStorage throws
 * — private-mode Safari and strict privacy settings both do. Demo mode simply
 * stays off in that case.
 */
export function readDemoFlagFromStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(DEMO_LOCALSTORAGE_KEY) ===
      DEMO_LOCALSTORAGE_VALUE
    );
  } catch {
    return false;
  }
}

/**
 * Pure demo-state decision — the precedence `useIsDemoMode` returns, lifted
 * out of the hook body so it can be asserted directly (no shadow copy).
 *
 * Precedence, highest first:
 *   1. `isDemo` (authoritative server cookie read) → demo ON.
 *   2. A real `user` → demo OFF, whatever localStorage says. This is the
 *      clause the MONEY-1137 hardening exists to guarantee reaches every
 *      authenticated surface.
 *   3. Otherwise the client flag.
 */
export function resolveClientDemoState(input: {
  isDemo: boolean;
  user: DemoModeUser;
  clientFlag: boolean;
}): boolean {
  if (input.isDemo) return true;
  if (input.user) return false;
  return input.clientFlag;
}

export function useIsDemoMode(opts: UseIsDemoModeOptions): boolean {
  const { isDemo = false, user } = opts;

  // Initial value matches SSR — never read localStorage during render.
  const [clientFlag, setClientFlag] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const readFlag = () => setClientFlag(readDemoFlagFromStorage());

    readFlag();

    // Cross-tab: native storage events fire when another tab clears the
    // flag (e.g. user signs in on tab B; tab A should drop demo state).
    const onStorage = (e: StorageEvent) => {
      if (e.key === DEMO_LOCALSTORAGE_KEY) readFlag();
    };

    // Same-tab: DemoSessionGuard dispatches this when it cleans up after
    // a Clerk sign-in. Native storage events don't fire on same-tab
    // writes, so the explicit dispatch is load-bearing here.
    const onDemoEnded = () => readFlag();

    window.addEventListener("storage", onStorage);
    window.addEventListener(DEMO_SESSION_ENDED_EVENT, onDemoEnded);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(DEMO_SESSION_ENDED_EVENT, onDemoEnded);
    };
  }, []);

  return resolveClientDemoState({ isDemo, user, clientFlag });
}

/**
 * Companion to `useIsDemoMode`: returns `false` on first paint and flips
 * to `true` after the mount effect runs. Pages whose redirect gate runs
 * in a `useEffect` (`if (!user && !isDemoMode) router.push("/home")`)
 * race the hook's deferred localStorage read — on first paint the hook
 * still reports `false`, the gate fires, the demo visitor lands back on
 * /home. Wait on this hook before evaluating the gate.
 *
 *   const isDemoMode = useIsDemoMode({ user });
 *   const demoModeReady = useIsDemoModeReady();
 *
 *   useEffect(() => {
 *     if (!isLoaded) return;
 *     if (!demoModeReady) return;
 *     if (!user && !isDemoMode) router.push("/home");
 *   }, [isLoaded, demoModeReady, user, isDemoMode, router]);
 *
 * Pages with their own `mounted` gate (or that already receive the
 * authoritative server `isDemo` prop) don't need this — the hook
 * short-circuits to `true` synchronously in those cases.
 */
export function useIsDemoModeReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}
