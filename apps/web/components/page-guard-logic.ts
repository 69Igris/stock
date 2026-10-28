/**
 * Pure logic for {@link PageGuard} — extracted from the React component so the
 * gate decision and per-route metadata can be unit-tested under node:test
 * (the component itself pulls Next router / Clerk / icon side-effects and
 * cannot be imported there).
 *
 * The component imports `computeGuardDecision` + `PAGE_META` and renders their
 * output; tests assert the same exports. The subscription predicates
 * (`isPlanAtLeast`, `getMinimumPlanForFeature`) and the route→feature map
 * (`PAGE_TO_FEATURE_MAP`) are the REAL shared sources, not re-declared here.
 */

import type { PageRoute } from "@/lib/types/feature-flags";
import { PAGE_TO_FEATURE_MAP } from "@/lib/constants/page-features";
import {
  isPlanAtLeast,
  getMinimumPlanForFeature,
} from "@usemoney/core/subscription";

/**
 * Routes that act as feature kill-switches rather than "coming soon" paywalls.
 * When the flag is off (or demo hits one), the guard redirects to /dashboard
 * instead of rendering the ComingSoon teaser. MONEY-444.
 */
export const KILL_SWITCH_REDIRECT_ROUTES = new Set<PageRoute>([
  "/paper-trading",
  // MONEY-1058: Scans is founder-only while in active dev. Redirect
  // non-allowlisted users AND demo to /dashboard instead of teasing a
  // ComingSoon page for an unfinished surface.
  "/discover/scans",
]);

/**
 * Per-route display metadata used by the ComingSoon / Upgrade fallbacks and the
 * loading-stage title. The component layers a lucide `icon` on top of this; the
 * icon is intentionally NOT here so this module stays pure + `any`-free.
 */
export const PAGE_META: Record<
  PageRoute,
  { name: string; description: string; breadcrumb: string }
> = {
  "/tradebook": {
    name: "Tradebook",
    description: "Your trading journal & logbook",
    breadcrumb: "Portfolio",
  },
  "/positions": {
    name: "Positions",
    description: "Monitor your open positions",
    breadcrumb: "",
  },
  "/holdings": {
    name: "Holdings",
    description: "View your portfolio holdings",
    breadcrumb: "Portfolio",
  },
  "/paper-trading": {
    name: "Paper Trading",
    description: "Practice trading without real money",
    breadcrumb: "Tools",
  },
  "/discover": {
    name: "Discover",
    description: "Discover new investment opportunities",
    breadcrumb: "",
  },
  "/analysis": {
    name: "Analysis",
    description: "AI-powered stock analysis and insights",
    breadcrumb: "Research List",
  },
  "/sage-tutor": {
    name: "StockSage Tutor",
    description: "AI-powered trading education and tutoring",
    breadcrumb: "Account",
  },
  "/learning": {
    name: "Courses",
    description: "Courses, AI tutor, and financial glossary",
    breadcrumb: "Account",
  },
  "/watchlist": {
    name: "Watchlists",
    description: "Track your favorite instruments",
    breadcrumb: "Workspace",
  },
  "/roast": {
    name: "Roast",
    description: "Get a brutally honest AI analysis of your portfolio",
    breadcrumb: "",
  },
  "/risk": {
    name: "Risk Report",
    description:
      "Analyze portfolio concentration, VaR, drawdowns & risk metrics",
    breadcrumb: "Tools",
  },
  "/tax": {
    name: "Tax Report",
    description: "Capital gains tax computation, harvesting & ITR schedule",
    breadcrumb: "Tools",
  },
  "/documents": {
    name: "Document Vault",
    description: "Upload, store, and manage your financial documents",
    breadcrumb: "Tools",
  },
  "/strategies": {
    name: "Strategies",
    description: "Pre-built and AI-generated trading strategies",
    breadcrumb: "Research",
  },
  "/quizzes": {
    name: "Quiz",
    description: "AI-powered quizzes to test your financial knowledge",
    breadcrumb: "Account",
  },
  "/discover/scans": {
    name: "Scans",
    description: "Pre-built market scans — momentum, value, volume & more",
    breadcrumb: "Discover",
  },
};

/** The gate decision the component renders from. */
export interface GuardDecision {
  shouldShowComingSoon: boolean;
  shouldRedirect: boolean;
  showUpgrade: boolean;
  requiredPlan: string;
}

const NO_GATE: GuardDecision = {
  shouldShowComingSoon: false,
  shouldRedirect: false,
  showUpgrade: false,
  requiredPlan: "",
};

/**
 * Decide what {@link PageGuard} should render for a route, synchronously.
 * Precedence (mirrors PageGuard's useMemo exactly):
 *   1. loading            → no-gate defaults (caller renders skeleton first)
 *   2. demo mode          → allow, EXCEPT kill-switch routes redirect
 *   3. kill-switch route WITHOUT an explicit `true` flag (non-shipped)
 *      → redirect. Fail-CLOSED: `undefined` (stale/missing flag key)
 *      redirects too, not just `false` — MONEY-1053.
 *   4. flag `false` (non-shipped, non-kill-switch) → ComingSoon. These keep
 *      the optimistic-true default (`undefined` renders children) so a
 *      briefly-missing key never flashes ComingSoon over a live surface.
 *   5. feature requires a higher plan → upgrade
 *   6. otherwise          → children
 *
 * `isShipped` (ALWAYS_ON_ROUTES) skips the flag checks in steps 3–4.
 */
export function computeGuardDecision(args: {
  route: PageRoute;
  flags: Record<string, boolean>;
  isDemoMode: boolean;
  planId: string;
  isLoading: boolean;
  isShipped: boolean;
}): GuardDecision {
  const { route, flags, isDemoMode, planId, isLoading, isShipped } = args;

  if (isLoading) return NO_GATE;

  if (isDemoMode) {
    if (KILL_SWITCH_REDIRECT_ROUTES.has(route)) {
      return { ...NO_GATE, shouldRedirect: true };
    }
    return NO_GATE;
  }

  // Kill-switch routes FAIL CLOSED (MONEY-1053): require an EXPLICIT `true`,
  // not merely "not false". A stale pre-deploy flag map (localStorage/Redis
  // caches written before the route's flag key existed — version hashing
  // never invalidates them) yields `undefined` for the new key; the old
  // `=== false` gate skipped it and, with a null PAGE_TO_FEATURE_MAP entry,
  // rendered the founder-only page for any signed-in user until caches
  // refreshed (~10 min). Accepted consequence: a user with a stale map
  // (including the founder) is redirected to /dashboard until their flags
  // refresh — fail-closed is the point for founder-only in-dev surfaces.
  // NOTE: the demo branch above must stay FIRST (demo redirects regardless).
  if (
    !isShipped &&
    KILL_SWITCH_REDIRECT_ROUTES.has(route) &&
    flags[route] !== true
  ) {
    return { ...NO_GATE, shouldRedirect: true };
  }

  // Non-kill-switch gated routes deliberately keep the optimistic-true
  // default (`undefined` ≠ `false` → children) to avoid ComingSoon flashes
  // while a fresh flag map loads. Do not tighten this to `!== true`.
  if (!isShipped && flags[route] === false) {
    return { ...NO_GATE, shouldShowComingSoon: true };
  }

  const feature = PAGE_TO_FEATURE_MAP[route];
  if (feature) {
    const minPlan = getMinimumPlanForFeature(feature);
    if (!isPlanAtLeast(planId, minPlan)) {
      return { ...NO_GATE, showUpgrade: true, requiredPlan: minPlan };
    }
  }

  return NO_GATE;
}
