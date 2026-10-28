"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { PageRoute } from "@/lib/types/feature-flags";
import { ALWAYS_ON_ROUTES } from "@/lib/types/feature-flags";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";
import { useSubscriptionAccess } from "@/hooks/useSubscriptionAccess";
import {
  computeGuardDecision,
  PAGE_META,
  KILL_SWITCH_REDIRECT_ROUTES,
} from "@/components/page-guard-logic";
import { ComingSoon } from "@/components/ComingSoon";
import { UpgradePrompt } from "@/components/UpgradePrompt";
import Sidebar from "@/components/Sidebar";
import { PageSkeletonShell } from "@/components/skeletons";

const ALWAYS_ON_SET = new Set<string>(ALWAYS_ON_ROUTES);

import {
  BookOpen,
  Target,
  PieChart,
  FileSpreadsheet,
  Search,
  Brain,
  GraduationCap,
  Eye,
  Flame,
  ShieldAlert,
  Receipt,
  FileText,
  Sparkles,
  Trophy,
  Sliders,
  type LucideIcon,
} from "lucide-react";

interface PageGuardProps {
  route: PageRoute;
  children: React.ReactNode;
  /** Page-specific skeleton shown while feature flags load.
   *  Wrapped automatically in Sidebar + main layout. */
  fallback?: React.ReactNode;
  /**
   * MONEY-392: page title rendered above the fallback during PageGuard's
   * loading state. Without this, users see the route's `loading.tsx`
   * skeleton (with title from PageLoadingWrapper) → then a flash of the
   * bare skeleton with no title while PageGuard is checking flags +
   * subscription → then the real TerminalLuxeShell title. Passing the
   * same string the page passes to `<TerminalLuxeShell title=>` keeps
   * the page name visible across the entire loading chain.
   *
   * Falls back to `PAGE_CONFIG[route].name` when omitted.
   */
  title?: string;
  /** Optional uppercase breadcrumb chip rendered next to the title. */
  breadcrumb?: string;
  /**
   * Optional description line rendered under the title (full-row basis).
   * When omitted, no description is shown — the PAGE_CONFIG `description`
   * is only used by ComingSoon / Upgrade fallbacks, not the loading
   * stage. Pass this when the hydrated page has a sub-title (e.g. News
   * page's "Feeds, alerts & notifications" line) so stage 2 matches.
   */
  description?: string;
  /**
   * Optional slot rendered on the right of the title row (e.g. action
   * button placeholders for the Strategies stage-2 skeleton). Pushed to
   * the right with `ml-auto` so it stays inline with the title.
   */
  headerRight?: React.ReactNode;
  /**
   * MONEY-392: when PageGuard is nested inside an existing layout that
   * already provides Sidebar + main + header chrome (e.g. paper-trading's
   * layout.tsx), set `bare={true}` so the loading state renders only the
   * fallback skeleton - no second Sidebar, no duplicate title - avoiding
   * a double-chrome bug.
   */
  bare?: boolean;
  /**
   * MONEY-392: container classes for PageGuard's loading-state inner
   * wrapper. Default = `px-4 sm:px-6 py-5 max-w-[1600px] mx-auto pb-24
   * lg:pb-12` (matches TerminalLuxeShell). Pages that use a different
   * container width (e.g. /settings at max-w-[1180px], /analysis with
   * no max-w cap) should pass their own classes so stage 2 doesn't
   * snap to 1600px width.
   */
  containerClassName?: string;
}

// MONEY-392: `name` + `breadcrumb` values aligned to each page's *hydrated*
// header (either TerminalLuxeShell title/breadcrumb props or the inline
// `<h1>` + chip pattern), so the title stays stable across the entire
// loading chain (loading.tsx → PageGuard → hydrated). Empty `breadcrumb`
// = no chip rendered, matching pages that don't show a breadcrumb chip.
// Per-route icons. Name/description/breadcrumb come from the shared, testable
// PAGE_META (components/page-guard-logic.ts) so the copy has one source of truth.
const PAGE_ICONS: Record<PageRoute, LucideIcon> = {
  "/tradebook": BookOpen,
  "/positions": Target,
  "/holdings": PieChart,
  "/paper-trading": FileSpreadsheet,
  "/discover": Search,
  "/analysis": Brain,
  "/sage-tutor": Sparkles,
  "/learning": GraduationCap,
  "/watchlist": Eye,
  "/roast": Flame,
  "/risk": ShieldAlert,
  "/tax": Receipt,
  "/documents": FileText,
  "/strategies": Target,
  "/quizzes": Trophy,
  "/discover/scans": Sliders,
};

const PAGE_CONFIG: Record<
  PageRoute,
  { name: string; description: string; breadcrumb: string; icon: LucideIcon }
> = Object.fromEntries(
  (Object.keys(PAGE_META) as PageRoute[]).map((route) => [
    route,
    { ...PAGE_META[route], icon: PAGE_ICONS[route] },
  ])
) as Record<
  PageRoute,
  { name: string; description: string; breadcrumb: string; icon: LucideIcon }
>;

/**
 * MONEY-485 — generic loading fallback, re-skinned to the playful surface.
 * Uses the shared `PageSkeletonShell` (same as Stage-1 PageLoadingWrapper)
 * so both stages are pixel-identical: Sidebar + offset main + shimmer cards.
 * No breadcrumb/title header (Task B). No second TopBar (layout provides it).
 */
function PageLoadingSkeleton() {
  return (
    <PageSkeletonShell>
      <style>{`
        .pf-guard-skel {
          position: relative;
          overflow: hidden;
          background: var(--rule-softer);
          border-radius: 8px;
        }
        .pf-guard-skel::after {
          content: "";
          position: absolute;
          inset: 0;
          transform: translateX(-100%);
          background: linear-gradient(90deg, transparent 0%, var(--paper-2) 50%, transparent 100%);
          opacity: 0.55;
          animation: pf-guard-sweep 1.5s ease-in-out infinite;
        }
        @keyframes pf-guard-sweep { 100% { transform: translateX(100%); } }
        @media (prefers-reduced-motion: reduce) {
          .pf-guard-skel::after { animation: none; transform: none; opacity: 0.35; }
        }
      `}</style>
      {/* Ink-bordered shimmer cards — no heading, matching Task B */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-40 rounded-[14px]"
            style={{
              border: "2px solid var(--ink)",
              boxShadow: "var(--shadow-soft)",
              background: "var(--rule-softer)",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div className="pf-guard-skel absolute inset-0 !rounded-none" />
          </div>
        ))}
      </div>
    </PageSkeletonShell>
  );
}

export function PageGuard({
  route,
  children,
  fallback,
  // title, breadcrumb, description, headerRight are kept for API compat
  // (all existing callers pass them) but no longer rendered in the loading
  // stage — page content owns its own hero (Task B). They are still
  // rendered in the ComingSoon / UpgradePrompt branches via PAGE_CONFIG.
  title: _title,
  breadcrumb: _breadcrumb,
  description: _description,
  headerRight: _headerRight,
  bare = false,
  containerClassName,
}: PageGuardProps) {
  // Shipped routes skip flag evaluation entirely - render immediately
  const isShipped = ALWAYS_ON_SET.has(route);
  const router = useRouter();

  const { flags, isLoading: isFlagsLoading, isDemoMode } = useFeatureFlags();
  const { planId, isLoading: isSubLoading } = useSubscriptionAccess(isDemoMode);

  // Shipped routes only wait for subscription, not flags
  const isLoading = isShipped ? isSubLoading : isFlagsLoading || isSubLoading;

  // Derive the gate decision synchronously during render — replaces the
  // previous useEffect that ran AFTER the first non-loading render and
  // caused a single-frame flash of the protected page content (tax,
  // risk, learning) before the upgrade prompt swapped in. With useMemo,
  // the first non-loading render already has the correct gate.
  const { shouldShowComingSoon, shouldRedirect, showUpgrade, requiredPlan } =
    useMemo(
      () =>
        computeGuardDecision({
          route,
          flags,
          isDemoMode,
          planId,
          isLoading,
          isShipped,
        }),
      [route, flags, isLoading, isDemoMode, planId, isShipped]
    );

  // Fire-and-forget redirect for kill-switch routes. We schedule it in
  // an effect (not during render) so React doesn't see a state mutation
  // in a render path. The page renders the existing isLoading-style
  // shimmer until the navigation completes.
  useEffect(() => {
    if (shouldRedirect) router.replace("/dashboard");
  }, [shouldRedirect, router]);

  // Show loading state - use page-specific fallback if provided.
  // MONEY-392: always render the page title at the top so the title stays
  // visible across the entire loading chain (loading.tsx → PageGuard →
  // hydrated TerminalLuxeShell).
  if (isLoading) {
    // Bare mode: PageGuard is nested inside an existing chrome (parent
    // layout already provides Sidebar + main + header). Emit the
    // fallback if provided; otherwise render a generic shimmer block
    // (matches the post-load content height roughly) instead of `null`,
    // which would briefly blank out the content area between stages
    // 1 → 2 - the "blank page in between" regression.
    if (bare) {
      if (fallback) return <>{fallback}</>;
      return (
        <div className="space-y-4 animate-pulse" aria-hidden="true">
          <div className="h-32 w-full bg-muted/30 rounded-xl" />
          <div className="h-64 w-full bg-muted/30 rounded-xl" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <div className="h-40 bg-muted/30 rounded-xl" />
            <div className="h-40 bg-muted/30 rounded-xl" />
            <div className="h-40 bg-muted/30 rounded-xl" />
          </div>
        </div>
      );
    }
    if (fallback) {
      // Task B: breadcrumb/title header removed — page content owns its own
      // hero. The props (title, breadcrumb, headerRight, description) are kept
      // on PageGuardProps for API compat but are no longer rendered here.
      // PageSkeletonShell guarantees stage-2 matches stage-1 shell exactly.
      return (
        <PageSkeletonShell containerClassName={containerClassName}>
          {fallback}
        </PageSkeletonShell>
      );
    }
    return <PageLoadingSkeleton />;
  }

  // Kill-switch redirect in flight — render the loading skeleton so we
  // don't briefly flash the protected page content while router.replace()
  // navigates to /dashboard.
  if (shouldRedirect) {
    if (bare) {
      if (fallback) return <>{fallback}</>;
      return (
        <div className="space-y-4 animate-pulse" aria-hidden="true">
          <div className="h-32 w-full bg-muted/30 rounded-xl" />
          <div className="h-64 w-full bg-muted/30 rounded-xl" />
        </div>
      );
    }
    return <PageLoadingSkeleton />;
  }

  // Show coming soon page
  // MONEY-394 - outer header mirrors the hydrated page (text title +
  // breadcrumb mono chip + description, no icon) so stages 1/2 don't
  // present a different chrome from the live page underneath.
  // When `bare`, the parent layout already provides Sidebar + chrome
  // (e.g. paper-trading's layout.tsx with its sub-nav + clock), so we
  // render only the ComingSoon body to avoid a double-Sidebar regression.
  if (shouldShowComingSoon) {
    const config = PAGE_CONFIG[route];

    if (bare) {
      return <ComingSoon pageName={config.name} />;
    }

    // Container class mirrors the loading branch so stage-1 (loading.tsx),
    // stage-2 (PageGuard loading), and stage-3 (ComingSoon) all share the
    // same box. Caller can override via `containerClassName` to match a
    // page-specific layout (e.g. Strategies passes the 1600px Discover
    // canonical).
    const containerCls =
      containerClassName ??
      "px-4 sm:px-6 py-5 max-w-[1600px] mx-auto pb-24 lg:pb-12";
    return (
      <div className="min-h-screen bg-background">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)] pb-20 lg:pb-0">
          <div className={containerCls}>
            <div className="mb-6 flex items-baseline gap-3 flex-wrap">
              <h1 className="text-[28px] font-bold tracking-[-0.5px] text-[var(--text-primary)]">
                {config.name}
              </h1>
              {config.breadcrumb && (
                <span className="font-mono text-[11px] uppercase tracking-[1.2px] text-[var(--text-muted)] font-bold">
                  {config.breadcrumb}
                </span>
              )}
              <p className="basis-full text-[13px] text-[var(--text-muted)] mt-1">
                {config.description}
              </p>
            </div>
            <ComingSoon pageName={config.name} />
          </div>
        </main>
      </div>
    );
  }

  // Show upgrade prompt
  // MONEY-394 - outer header now mirrors the hydrated page chrome
  // (title + breadcrumb mono chip + description, no icon) so the user
  // sees the page identity consistently. UpgradePrompt owns the inner
  // unlock card. When `bare`, the parent layout already provides
  // Sidebar + chrome, so we render only the inner card to avoid double
  // chrome (mirrors the ComingSoon branch).
  if (showUpgrade) {
    const config = PAGE_CONFIG[route];

    if (bare) {
      return (
        <UpgradePrompt
          pageName={config.name}
          requiredPlan={requiredPlan}
          currentPlan={planId}
        />
      );
    }

    // Same containerClassName respect as the ComingSoon branch so stages
    // 1/2/3 stay visually anchored.
    const containerCls =
      containerClassName ??
      "px-4 sm:px-6 py-5 max-w-[1600px] mx-auto pb-24 lg:pb-12";
    return (
      <div className="min-h-screen bg-background">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)] pb-20 lg:pb-0">
          <div className={containerCls}>
            <div className="mb-6 flex items-baseline gap-3 flex-wrap">
              <h1 className="text-[28px] font-bold tracking-[-0.5px] text-[var(--text-primary)]">
                {config.name}
              </h1>
              {config.breadcrumb && (
                <span className="font-mono text-[11px] uppercase tracking-[1.2px] text-[var(--text-muted)] font-bold">
                  {config.breadcrumb}
                </span>
              )}
              <p className="basis-full text-[13px] text-[var(--text-muted)] mt-1">
                {config.description}
              </p>
            </div>
            <UpgradePrompt
              pageName={config.name}
              requiredPlan={requiredPlan}
              currentPlan={planId}
            />
          </div>
        </main>
      </div>
    );
  }

  // Render children if access granted
  return <>{children}</>;
}
