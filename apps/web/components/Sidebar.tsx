"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  forwardRef,
  Suspense,
} from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { instantSignOut, instantEndDemo } from "@/lib/auth/sign-out";
import { useUser, useClerk } from "@clerk/nextjs";
import { Button } from "@usemoney/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@usemoney/ui/tooltip";
import { Sheet, SheetContent, SheetTrigger } from "@usemoney/ui/sheet";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import UseMoneyLogo from "@/components/UseMoneyLogo";
import { MarketTicker } from "@/components/MarketTicker";
import {
  Activity,
  BookOpen,
  Target,
  PieChart,
  Search,
  Eye,
  Brain,
  GraduationCap,
  Flame,
  Link2,
  Menu,
  Settings,
  LogOut,
  MessageSquare,
  Home,
  HelpCircle,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldAlert,
  Receipt,
  FileText,
  ChevronDown,
  Sparkles,
  Trophy,
  Zap,
  LayoutDashboard,
  User,
  Crown,
  CreditCard,
  Bell,
  MessageSquarePlus,
  Moon,
  Sun,
  Monitor,
  Scroll,
  Pen,
  Calculator,
  Sliders,
  ShieldCheck,
  Plug,
  Newspaper,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@usemoney/ui/dropdown-menu";
import { useSidebar } from "@/components/SidebarContext";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import {
  getCachedPlan,
  fetchPlanCached,
  subscribeCachedPlan,
} from "@/lib/subscription/plan-cache";
import { createOncePerUserCache } from "@/lib/utils/once-per-user-cache";
import { useCommandPalette } from "@/components/CommandPalette";
import { NotificationBell } from "@/components/NotificationBell";
import {
  AnimatedThemeToggler,
  animateThemeTransition,
} from "@/components/ui/animated-theme-toggler";
import { cn } from "@usemoney/utils";
import { resetWalkthroughAction } from "@/lib/actions/walkthrough";
import { CURRENT_WALKTHROUGH_VERSION } from "@/lib/walkthrough/tours";
import { PfUserProfileMenu } from "@/components/playful/PfUserProfileMenu";
import { PUBLIC_SHELL_ROUTES } from "@/lib/route-lists";

/**
 * "Take the tour again" - always restart the onboarding tour (v1-core).
 * v1-core anchors live on /dashboard, so we navigate there first if the
 * user is elsewhere, then dispatch the restart event once the route
 * settles. A short delay gives the Next router enough time for the
 * pathname effect to fire before the provider re-evaluates eligibility.
 */
function triggerWalkthroughRestart() {
  if (typeof window === "undefined") return;
  void resetWalkthroughAction(CURRENT_WALKTHROUGH_VERSION).catch(() => {
    // Silent - fire restart anyway so user gets the tour
  });
  const dispatchRestart = () => {
    window.dispatchEvent(
      new CustomEvent("walkthrough:restart", {
        detail: CURRENT_WALKTHROUGH_VERSION,
      })
    );
  };
  if (window.location.pathname !== "/dashboard") {
    window.location.href = "/dashboard?walkthrough=v1-core";
    return;
  }
  dispatchRestart();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string; // optional color override for the icon
  labelClassName?: string; // optional color override for the label text
  /** Playful accent color key for the icon wrapper (maps to .pf-navi-ic.p-*). */
  color?: "emerald" | "pink" | "blue" | "coral" | "violet";
  /** Small badge pill rendered at the right of the row (e.g. "AI"). */
  badge?: string;
  /**
   * Walkthrough anchor id (e.g. "nav-holdings"). When set, the rendered nav
   * link carries the matching `data-walkthrough` attribute so the onboarding
   * tour (apps/web/lib/walkthrough/tours/*) can target this row.
   */
  walkthrough?: string;
  children?: NavSubItem[];
  /**
   * MONEY-394 D - if set, hide this nav item when the gated flag is false.
   * Uses the same FeatureFlagMap keys returned by useFeatureFlags().
   */
  featureFlag?:
    | "/sage-tutor"
    | "/learning"
    | "/risk"
    | "/tax"
    | "/documents"
    | "/strategies"
    | "/quizzes"
    | "/discover/scans";
  /**
   * Hide this nav item when the user is in demo mode. Use for destinations
   * that require a real Clerk session (e.g. /notifications) — otherwise
   * the demo visitor would click it and be bounced to /sign-in by Clerk
   * middleware.
   */
  hideInDemo?: boolean;
}

export interface NavSubItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Same gating contract as NavItem.featureFlag. */
  featureFlag?:
    | "/sage-tutor"
    | "/learning"
    | "/risk"
    | "/tax"
    | "/documents"
    | "/strategies"
    | "/quizzes"
    | "/discover/scans";
  /** Same demo-hide contract as NavItem.hideInDemo. */
  hideInDemo?: boolean;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

// ---------------------------------------------------------------------------
// Navigation configuration
// ---------------------------------------------------------------------------

export const sidenavConfig: NavSection[] = [
  // WORKSPACE - your portfolio + your AI chats
  {
    label: "WORKSPACE",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      {
        href: "/stocksage",
        label: "StockSage",
        icon: Sparkles,
        color: "emerald",
        badge: "AI",
      },
      {
        href: "/holdings",
        label: "Holdings",
        icon: PieChart,
        walkthrough: "nav-holdings",
      },
      { href: "/watchlist", label: "Watchlists", icon: Eye },
      { href: "/tradebook", label: "Tradebook", icon: BookOpen },
      {
        href: "/roast",
        label: "Portfolio Roast",
        icon: Flame,
        color: "pink",
        walkthrough: "nav-roast",
      },
    ],
  },
  // DISCOVER - the market at large
  {
    label: "DISCOVER",
    items: [
      {
        href: "/discover/markets",
        label: "Markets",
        icon: Activity,
        color: "blue",
      },
      {
        href: "/discover/screener",
        label: "Screener",
        icon: Search,
        walkthrough: "nav-screener",
      },
      // MONEY-795 (C2): Scans library — browse + one-click run pre-built
      // technical/fundamental scans. Sits beside the Screener (its inline
      // run path is the screener engine).
      //
      // MONEY-1138: REMOVED FROM NAVIGATION, deliberately not deleted.
      //
      // Hidden for EVERY user, the founder included — previously it was
      // founder-visible via the `page-visibility-scans` PostHog flag
      // (MONEY-1058), which is why it still showed in the sidebar.
      //
      // The ROUTE is untouched and stays reachable by URL. `/discover/scans`
      // is deliberately NOT added to FORCE_DISABLED_ROUTES: that is
      // /paper-trading's mechanism and it closes the route as well as the nav
      // entry. Access is still governed by the PostHog flag (targeting
      // deepshaswat@gmail.com) via PageGuard route="/discover/scans", so the
      // founder can open the page directly while Scans finishes development.
      //
      // To bring it back, restore this entry — the flag, the route, the page
      // and its PageGuard are all still in place:
      //   { href: "/discover/scans", label: "Scans", icon: Sliders,
      //     featureFlag: "/discover/scans", hideInDemo: true },
      // The legacy /discover grid (stocks + MF + ETFs browse + search) is
      // intentionally NOT in the primary nav. Screener supersedes it once
      // MF + ETF modes land. /discover stays reachable by URL as a fallback
      // until then - /compare's empty-state redirect still points there.
      { href: "/strategies", label: "Strategies", icon: Zap },
      { href: "/analysis", label: "Research List", icon: Brain },
      // Design Shell.jsx DISCOVER section includes "News & Events" - the
      // /discover/news route already ships (MONEY-197) but had no sidebar
      // entry. Added here so the design's IA is complete.
      { href: "/discover/news", label: "News & Events", icon: Newspaper },
    ],
  },
  // TOOLS - calculators + simulators
  {
    label: "TOOLS",
    items: [
      // Paper Trading entry removed 2026-05-28 per product decision.
      // Route, server actions, services, and DB models intact; hidden from nav.
      {
        href: "/fire",
        label: "FIRE Calculator",
        icon: Target,
        color: "coral",
        walkthrough: "nav-fire",
      },
      { href: "/calculators", label: "Calculators", icon: Calculator },
      // MONEY-394 D - Risk + Tax nav entries are gated on the same FF
      // that protects the underlying page. The renderer filters them out
      // when the flag is false; users without access never see them.
      {
        href: "/risk",
        label: "Risk Report",
        icon: ShieldAlert,
        featureFlag: "/risk",
      },
      {
        href: "/tax",
        label: "Tax Report",
        icon: Receipt,
        featureFlag: "/tax",
      },
      { href: "/documents", label: "Document Vault", icon: FileText },
    ],
  },
  // ACCOUNT - config
  {
    label: "ACCOUNT",
    items: [
      {
        href: "/brokers",
        label: "Brokers",
        icon: Link2,
        walkthrough: "nav-brokers",
      },
      // Learning section hidden per request (commented out — re-enable to restore).
      /*
      {
        href: "/learning",
        label: "Learning",
        icon: GraduationCap,
        featureFlag: "/learning",
        children: [
          {
            href: "/learning",
            label: "Courses",
            icon: BookOpen,
            featureFlag: "/learning",
          },
          {
            href: "/sage-tutor",
            label: "StockSage Tutor",
            icon: Sparkles,
            featureFlag: "/sage-tutor",
          },
          {
            href: "/quizzes",
            label: "Quiz",
            icon: Trophy,
            featureFlag: "/quizzes",
          },
        ],
      },
      */
      // Settings - single button. Tabs (Account/Plans/Billing/Usage/
      // Preferences/Notifications/Security/Integrations/Feedback) live
      // inside the page's left rail rather than as a collapsible sub-nav
      // (the rail is the canonical surface for switching between them).
      {
        href: "/settings",
        label: "Settings",
        icon: Settings,
      },
      // Notifications sits at the bottom of Account — quieter
      // utility surface than Brokers / Learning / Settings.
      // Visible in demo: the /notifications page goes through PageGuard's
      // always-on /discover route and the server action returns the static
      // `demoNotifications` set when `sb_demo` is present, so a demo
      // visitor sees a fully populated feed instead of being bounced.
      {
        href: "/notifications",
        label: "Notifications",
        icon: Bell,
      },
    ],
  },
];

export const bottomNavItems: NavItem[] = [];

// ---------------------------------------------------------------------------
// Prefetch budget (MONEY-1132)
// ---------------------------------------------------------------------------
//
// Every `<Link>` below prefetches by default the moment it enters the viewport,
// and the whole sidenav is in the viewport on a desktop screen. Each prefetch is
// a real network request: all 19 destinations are `force-dynamic` AND ship a
// `loading.tsx`, so Next's default ("partial prefetch to the nearest loading
// boundary") is a server round trip, not a cache read. Every one of those
// requests is matched by the proxy matcher — the compiled regexp in
// `.next/server/functions-config-manifest.json` ends in
// `(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?`, so RSC payload URLs are in
// scope — and the proxy runs on the Node.js runtime (Next 16 removed the Edge
// option for proxy files) out of a ~462 KB bundle that is almost entirely Clerk.
// So one sidebar mount = 19 middleware invocations, each doing `await auth()`.
// Prod RUM measured those at 550–1300 ms TTFB apiece, pushing network-settle on
// /dashboard past 16 s.
//
// It is not a once-per-session cost either: `NavContent` re-mounts on every
// navigation (each page renders its own `<Sidebar/>`). MONEY-1136's
// `staleTimes.dynamic: 30` caps the damage — a re-mount inside 30 s is served
// from the client Router Cache — but the burst still fires on every cold load
// and again after each 30 s gap.
//
// So the eager budget is spent only where the traffic is. PostHog `$pageview`,
// 90 days to 2026-08-04, all 19 sidenav destinations (785 pageviews total):
//
//     /dashboard 391 · /settings 94 · /brokers 72 · /stocksage 52
//     /holdings   37 · /tradebook 34 · /fire  31 · /discover/screener 28
//     ---- cliff: 28 → 8, a 3.5x drop ----
//     /analysis 8 · /discover/news 8 · /watchlist 7 · /discover/markets 7
//     /documents 6 · /calculators 3 · /roast 2 · /risk 2 · /strategies 2
//     /notifications 1 · /tax 0
//
// The eight above the cliff are 739 / 785 = 94% of in-app sidenav traffic, so
// keeping them eager preserves nearly all of the "navigation feels instant"
// benefit for 42% of the requests. (/stocksage is understated — it only became
// the post-login landing route recently — which is an argument for keeping it,
// and it already is.)
//
// This is an ALLOWLIST rather than a `prefetch: false` field per item on
// purpose: a nav entry added later should default to costing nothing, because
// the failure mode this ticket exists for is a prefetch budget that grew without
// anyone noticing. Adding a route here is a deliberate, reviewable act.
//
// The long tail is NOT dead to prefetching — `useNavPrefetcher` below prefetches
// on hover/focus instead, so a deliberate click still lands warm. What is gone
// is the unconditional burst on mount. Their `loading.tsx` covers the rest.
export const NAV_PREFETCH_ALLOWLIST: ReadonlySet<string> = new Set([
  "/dashboard",
  "/settings",
  "/brokers",
  "/stocksage",
  "/holdings",
  "/tradebook",
  "/fire",
  "/discover/screener",
]);

/**
 * Prefetch-on-intent for the destinations that are NOT in
 * {@link NAV_PREFETCH_ALLOWLIST}.
 *
 * `prefetch={false}` in Next 16 disables prefetch on viewport AND on hover
 * (`prefetchEnabled = prefetchProp !== false` gates both the intersection
 * observer and the `onMouseEnter` / `onTouchStart` handlers in
 * next/dist/client/app-dir/link.js). Hover is exactly the signal we still want:
 * it means the user is about to click, and one request at that moment is not a
 * burst. So we re-add it by hand.
 *
 * Returns a stable callback rather than a per-link hook so it can be used inside
 * `.map()` over sub-items without breaking the rules of hooks. Allowlisted hrefs
 * are ignored (Next already prefetched them); the ref dedupes repeat hovers
 * within a mount, and Next's own prefetch cache dedupes across mounts.
 */
function useNavPrefetcher(): (href: string) => void {
  const router = useRouter();
  const requested = useRef<Set<string>>(new Set());
  return useCallback(
    (href: string) => {
      if (NAV_PREFETCH_ALLOWLIST.has(href)) return;
      if (requested.current.has(href)) return;
      requested.current.add(href);
      router.prefetch(href);
    },
    [router]
  );
}

// ---------------------------------------------------------------------------
// Flatten helper (backward compat for CommandPalette, etc.)
// ---------------------------------------------------------------------------

export function flattenNavItems(config: NavSection[]): NavItem[] {
  const items: NavItem[] = [];
  for (const section of config) {
    for (const item of section.items) {
      items.push(item);
      if (item.children) {
        for (const child of item.children) {
          items.push({ ...child });
        }
      }
    }
  }
  return items;
}

export const navItems = flattenNavItems(sidenavConfig);

// ---------------------------------------------------------------------------
// Walkthrough anchor parity
// ---------------------------------------------------------------------------
//
// The onboarding tours (apps/web/lib/walkthrough/tours/*) target nav rows by
// `[data-walkthrough="nav-*"]`. Each id below is rendered onto the matching
// sidebar link via `item.walkthrough` (see NavLink / CollapsibleNavItem /
// MobileNavSheet). This map is the single static record of the contract so the
// tour-selector parity check can see the literal selectors and a config edit
// that drops a `walkthrough` field fails type-checking here.
//
//   data-walkthrough="nav-holdings"  → /holdings
//   data-walkthrough="nav-roast"     → /roast
//   data-walkthrough="nav-brokers"   → /brokers
//   data-walkthrough="nav-screener"  → /discover/screener
//   data-walkthrough="nav-fire"      → /fire
//
export const NAV_WALKTHROUGH_ANCHORS: Record<string, string> = {
  "/holdings": "nav-holdings",
  "/roast": "nav-roast",
  "/brokers": "nav-brokers",
  "/discover/screener": "nav-screener",
  "/fire": "nav-fire",
};

// Fail fast in dev if a config item lost its `walkthrough` field in a future
// rework (the exact regression this guards against — MONEY-485 sidebar rework).
if (process.env.NODE_ENV !== "production") {
  for (const [href, id] of Object.entries(NAV_WALKTHROUGH_ANCHORS)) {
    const found = navItems.find((i) => i.href === href);
    if (found && found.walkthrough !== id) {
      // eslint-disable-next-line no-console
      console.warn(
        `[walkthrough] nav item ${href} is missing its walkthrough anchor "${id}" — onboarding tour step will break.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Section label
// ---------------------------------------------------------------------------

function SectionLabel({
  label,
  collapsed,
}: {
  label: string;
  collapsed: boolean;
}) {
  if (collapsed) {
    return <div className="border-t border-[var(--rule-soft)] my-2" />;
  }
  return (
    <div className="flex items-center gap-2 px-2.5 pt-4 pb-1.5">
      <span className="font-mono text-[10.5px] font-bold tracking-[1.8px] text-[var(--ink-3)] uppercase">
        {label}
      </span>
      <span className="flex-1 h-[1.5px] bg-[var(--ink)] opacity-25" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// NavLink (flat item)
// ---------------------------------------------------------------------------

function NavLink({
  item,
  isActive,
  collapsed,
  onClick,
}: {
  item: NavItem;
  isActive: boolean;
  collapsed: boolean;
  onClick?: () => void;
}) {
  const Icon = item.icon;
  // MONEY-1132 — eager prefetch only for the allowlisted destinations; the rest
  // prefetch on hover/focus via onIntent. `undefined` is passed rather than
  // omitted so both branches read from one expression; Next's own default for
  // the prop is `null`, and `undefined` resolves to it identically.
  const eager = NAV_PREFETCH_ALLOWLIST.has(item.href);
  const onIntent = useNavPrefetcher();
  const link = (
    <Link
      href={item.href}
      prefetch={eager ? undefined : false}
      onMouseEnter={() => onIntent(item.href)}
      onFocus={() => onIntent(item.href)}
      onClick={onClick}
      data-walkthrough={item.walkthrough}
      className={cn("pf-navi", isActive && "is-active", collapsed && "is-coll")}
    >
      <span className={cn("pf-navi-ic", item.color && `p-${item.color}`)}>
        <Icon className="h-4 w-4" />
      </span>
      {!collapsed && <span className="pf-navi-l">{item.label}</span>}
      {!collapsed && item.badge && (
        <span className="pf-navi-b">{item.badge}</span>
      )}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {item.label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return link;
}

// ---------------------------------------------------------------------------
// CollapsibleNavItem (for items with children, e.g. Paper Trading)
// ---------------------------------------------------------------------------

function CollapsibleNavItem({
  item,
  isActive,
  isChildActive,
  collapsed,
  open,
  onOpenChange,
  onItemClick,
}: {
  item: NavItem;
  isActive: boolean;
  isChildActive: (href: string) => boolean;
  collapsed: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onItemClick?: () => void;
}) {
  const Icon = item.icon;
  const anyChildActive =
    item.children?.some((child) => isChildActive(child.href)) ?? false;
  const parentHighlighted = isActive || anyChildActive;
  const walkthroughId = item.walkthrough;
  // MONEY-1132 — same prefetch budget as NavLink. One prefetcher for the parent
  // and every child, so the `.map()` below needs no hook of its own.
  const onIntent = useNavPrefetcher();
  const eagerParent = NAV_PREFETCH_ALLOWLIST.has(item.href);

  // ---- Collapsed sidebar: show tooltip with clickable sub-items ----------
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-walkthrough={walkthroughId}
            className={cn("pf-navi is-coll", parentHighlighted && "is-active")}
          >
            <span className={cn("pf-navi-ic", item.color && `p-${item.color}`)}>
              <Icon className="h-4 w-4" />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="right"
          sideOffset={8}
          className="p-2 space-y-1"
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <p className="text-xs font-semibold mb-1 px-2">{item.label}</p>
          {item.children?.map((child) => {
            const ChildIcon = child.icon;
            return (
              <Link
                key={child.href}
                href={child.href}
                prefetch={
                  NAV_PREFETCH_ALLOWLIST.has(child.href) ? undefined : false
                }
                onMouseEnter={() => onIntent(child.href)}
                onFocus={() => onIntent(child.href)}
                onClick={onItemClick}
                className={cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors",
                  isChildActive(child.href)
                    ? "bg-[var(--rule-softer)] text-[var(--ink)] font-semibold"
                    : "text-[var(--ink-3)] hover:text-[var(--ink)] hover:bg-[var(--rule-softer)]"
                )}
              >
                <ChildIcon className="h-3.5 w-3.5 shrink-0" />
                <span>{child.label}</span>
              </Link>
            );
          })}
        </TooltipContent>
      </Tooltip>
    );
  }

  // ---- Expanded sidebar: collapsible sub-menu (pf-navi parent + pf-sub) ---
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className={cn("pf-navi", parentHighlighted && "is-active")}>
        <Link
          href={item.href}
          prefetch={eagerParent ? undefined : false}
          onMouseEnter={() => onIntent(item.href)}
          onFocus={() => onIntent(item.href)}
          onClick={onItemClick}
          data-walkthrough={walkthroughId}
          className="flex items-center gap-[11px] flex-1 min-w-0"
        >
          <span className={cn("pf-navi-ic", item.color && `p-${item.color}`)}>
            <Icon className="h-4 w-4" />
          </span>
          <span className="pf-navi-l">{item.label}</span>
        </Link>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="pf-navi-chev shrink-0"
            onClick={(e) => e.stopPropagation()}
            aria-label={`Toggle ${item.label}`}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !open) {
                onOpenChange(true);
              }
            }}
          >
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform duration-200",
                open && "rotate-180"
              )}
            />
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="pf-sub">
          {item.children?.map((child) => {
            const ChildIcon = child.icon;
            const childActive = isChildActive(child.href);
            return (
              <Link
                key={child.href}
                href={child.href}
                prefetch={
                  NAV_PREFETCH_ALLOWLIST.has(child.href) ? undefined : false
                }
                onMouseEnter={() => onIntent(child.href)}
                onFocus={() => onIntent(child.href)}
                onClick={onItemClick}
                className={childActive ? "is-active" : undefined}
              >
                <span className="sic">
                  <ChildIcon className="h-3 w-3" />
                </span>
                <span>{child.label}</span>
              </Link>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// NavContent
// ---------------------------------------------------------------------------

function NavContent({
  onItemClick,
  collapsed = false,
}: {
  onItemClick?: () => void;
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, isLoaded } = useUser();
  const { setOpen: setPaletteOpen } = useCommandPalette();
  // MONEY-1137: `user` comes from the useUser() call above — no second hook.
  const isDemoMode = useIsDemoMode({ user });
  const [mounted, setMounted] = useState(false);
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  // null = plan not yet resolved (loading). Distinct from "FREE" so paying
  // users never flash the upgrade sticker / "Free" tag during the fetch.
  const [planId, setPlanId] = useState<string | null>(() => getCachedPlan());

  // Collapsible open/closed state keyed by parent href
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(
    () => {
      // Default Paper Trading open if any child route is active on first render
      const initial: Record<string, boolean> = {};
      return initial;
    }
  );

  // URL-aware auto-expand on initial render
  const initialExpandDone = useRef(false);
  useEffect(() => {
    if (initialExpandDone.current) return;
    initialExpandDone.current = true;

    const updates: Record<string, boolean> = {};
    // Check both main nav and bottom nav items
    const allItems = [
      ...sidenavConfig.flatMap((s) => s.items),
      ...bottomNavItems,
    ];
    for (const item of allItems) {
      if (item.children) {
        const anyChildActive = item.children.some(
          (child) =>
            pathname === child.href || pathname?.startsWith(child.href + "/")
        );
        const parentActive =
          pathname === item.href || pathname?.startsWith(item.href + "/");
        if (anyChildActive || parentActive) {
          updates[item.href] = true;
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      setOpenSections((prev) => ({ ...prev, ...updates }));
    }
  }, [pathname]);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Plan tier via the session cache — fetches once per session; the sidebar
  // re-mounts on every navigation (each page renders its own <Sidebar/>), so
  // this reads synchronously from cache on re-mount with no FREE→plan flash.
  useEffect(() => {
    if (!isLoaded || !user) return;
    fetchPlanCached().then(setPlanId);
    // Live-update the tier tag when the plan is reseeded after an upgrade
    // (the billing page seeds it post-payment) — no reload needed.
    return subscribeCachedPlan(setPlanId);
  }, [isLoaded, user]);

  // End Demo mirrors sign-out: instant full-screen overlay + hard-navigate, so the
  // page never looks stuck during the cookie-clear round-trip (see instantEndDemo).
  const handleDemoSignOut = () => instantEndDemo();

  const isItemActive = useCallback(
    (href: string) => {
      // Query-param-aware: if the href contains a "?", match both pathname
      // and the query params. Kept generic for any future query-scoped nav
      // item (StockSage no longer needs it — it has its own /stocksage route).
      if (href.includes("?")) {
        const qIdx = href.indexOf("?");
        const hrefPath = href.slice(0, qIdx);
        if (pathname !== hrefPath) return false;
        const expectedParams = new URLSearchParams(href.slice(qIdx + 1));
        let allMatch = true;
        expectedParams.forEach((value, key) => {
          if (searchParams?.get(key) !== value) allMatch = false;
        });
        return allMatch;
      }
      // Plain href: exact pathname match OR startsWith for sub-routes.
      // StockSage moved to its own /stocksage route, so /dashboard and
      // /stocksage are distinct pathnames that resolve to distinct active
      // items — no query-param disambiguation needed on either.
      if (pathname === href) {
        return true;
      }
      return pathname?.startsWith(href + "/") ?? false;
    },
    [pathname, searchParams]
  );

  // For collapsible children, collect all child hrefs for the current
  // collapsible group so we can distinguish the "root" child (whose href
  // matches the parent) from deeper sub-routes.
  const allChildHrefs = useMemo(() => {
    const hrefs: string[] = [];
    const allItems = [
      ...sidenavConfig.flatMap((s) => s.items),
      ...bottomNavItems,
    ];
    for (const item of allItems) {
      if (item.children) {
        for (const child of item.children) {
          hrefs.push(child.href);
        }
      }
    }
    return hrefs;
  }, []);

  const isChildActive = useCallback(
    (href: string) => {
      // Handle query-param-based hrefs (e.g. /settings?tab=account)
      if (href.includes("?")) {
        const qIdx = href.indexOf("?");
        const hrefPath = href.slice(0, qIdx);
        const hrefQuery = href.slice(qIdx + 1);
        if (pathname !== hrefPath) return false;
        if (typeof window === "undefined") return false;
        const currentParams = new URLSearchParams(window.location.search);
        const expectedParams = new URLSearchParams(hrefQuery);
        // Check all expected params match current URL
        let allMatch = true;
        expectedParams.forEach((value, key) => {
          if (currentParams.get(key) !== value) allMatch = false;
        });
        return allMatch;
      }
      // Exact match always wins
      if (pathname === href) return true;
      // For startsWith, only match if no MORE-specific sibling matches.
      // e.g. /paper-trading should NOT highlight on /paper-trading/terminal
      // because /paper-trading/terminal is a more specific child.
      if (pathname?.startsWith(href + "/")) {
        const moreSpecificMatch = allChildHrefs.some(
          (other: string) =>
            other !== href &&
            other.startsWith(href + "/") &&
            (pathname === other || pathname?.startsWith(other + "/"))
        );
        return !moreSpecificMatch;
      }
      return false;
    },
    [pathname, allChildHrefs]
  );

  const handleOpenChange = useCallback((key: string, open: boolean) => {
    setOpenSections((prev) => ({ ...prev, [key]: open }));
  }, []);

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex flex-col h-full">
        {/* Brand header */}
        <div
          className={cn(
            "shrink-0 border-b border-[var(--border-default)]",
            collapsed ? "p-3" : "px-[18px] py-4"
          )}
        >
          <Link
            href="/dashboard"
            onClick={onItemClick}
            data-walkthrough="sidebar-logo"
          >
            <div className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
              <div className="w-7 h-7 rounded-[7px] bg-[var(--ink)] -rotate-3 flex items-center justify-center text-[var(--paper)] font-mono font-black text-sm shrink-0">
                U
              </div>
              {!collapsed && (
                <span className="font-display font-bold text-[15px] tracking-[-0.3px] text-[var(--text-primary)]">
                  UseMoney
                  <span className="text-[var(--accent-primary)]"> AI</span>
                </span>
              )}
              {/* Plan tier now lives only in the footer user-card (pf-tag-pro),
                  not the brand header. */}
            </div>
          </Link>
        </div>

        {/* Search markets — opens the ⌘K command palette (design: pf-sb-search) */}
        <div className={cn("pf-sb-search", collapsed && "coll")}>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search markets, stocks, brokers"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span>Search markets…</span>
            <span className="pf-kbd">⌘K</span>
          </button>
        </div>

        {/* Scrollable nav area */}
        <div
          className={cn(
            "flex-1 overflow-y-auto min-h-0 py-2 flex flex-col",
            collapsed ? "px-2" : "px-6"
          )}
        >
          {/* Main navigation */}
          <nav className="space-y-1">
            {sidenavConfig.map((section, sIdx) => {
              // MONEY-394 D - drop items + sub-items whose FF is false.
              // While flags are still resolving (cache miss + network in
              // flight), treat every gated item as hidden. Without this
              // guard the optimistic `DEFAULT_FLAGS=true` causes gated
              // items to flash IN on every nav/reload before the real
              // flag value lands and hides them again. Better to render
              // nothing for ~1 frame than to flash-then-hide.
              // For demo sessions the "wait for flags to land" gate is a
              // no-op: useFeatureFlags skips the server fetch entirely
              // (Effect 1 returns early when localStorage demo flag is
              // set), so `flags` stays at DEFAULT_FLAGS forever and
              // `flagsLoading` doesn't resolve to a more authoritative
              // answer. Treating flagsLoading as `false` for demo makes
              // the sidebar consistent across routes — without it, any
              // page that observes the brief initial-render window
              // (e.g. /settings, which mounts heavier internal state and
              // re-renders more before settling) hides Risk / Tax /
              // Learning while another page on the same demo session
              // (e.g. /dashboard) shows them.
              const effectiveLoading = isDemoMode ? false : flagsLoading;
              const visibleItems = section.items
                .map((item) => {
                  if (item.hideInDemo && isDemoMode) {
                    return null;
                  }
                  if (
                    item.featureFlag &&
                    (effectiveLoading || !flags[item.featureFlag])
                  ) {
                    return null;
                  }
                  if (item.children) {
                    const visibleChildren = item.children.filter(
                      (child) =>
                        (!child.hideInDemo || !isDemoMode) &&
                        (!child.featureFlag ||
                          (!effectiveLoading && flags[child.featureFlag]))
                    );
                    if (visibleChildren.length === 0) return null;
                    return { ...item, children: visibleChildren };
                  }
                  return item;
                })
                .filter((item): item is NavItem => item !== null);

              if (visibleItems.length === 0) return null;

              return (
                <div key={sIdx} className="space-y-0.5">
                  {section.label && (
                    <SectionLabel label={section.label} collapsed={collapsed} />
                  )}
                  {visibleItems.map((item) =>
                    item.children ? (
                      <CollapsibleNavItem
                        key={item.href}
                        item={item}
                        isActive={isItemActive(item.href)}
                        isChildActive={isChildActive}
                        collapsed={collapsed}
                        open={!!openSections[item.href]}
                        onOpenChange={(open) =>
                          handleOpenChange(item.href, open)
                        }
                        onItemClick={onItemClick}
                      />
                    ) : (
                      <NavLink
                        key={item.href}
                        item={item}
                        isActive={isItemActive(item.href)}
                        collapsed={collapsed}
                        onClick={onItemClick}
                      />
                    )
                  )}
                </div>
              );
            })}
          </nav>

          {/* Gold upgrade sticker — FREE tier only (design: pf-sticker). Gated on
              `mounted` so it renders ONLY after client mount: planId is seeded from
              a CLIENT cache (getCachedPlan), so rendering it during SSR/hydration
              mismatched the server (no/other plan) vs the client (FREE) — the
              hydration error. Still hidden while planId is null (loading) so paid
              users never flash "Upgrade?". */}
          {mounted && !collapsed && planId === "FREE" && (
            <Link
              href="/settings?tab=plans"
              onClick={onItemClick}
              className="pf-sticker"
              style={{ display: "block" }}
            >
              <strong>Upgrade?</strong> Unlock unlimited broker sync &amp; deep
              research.
              <div>
                <span className="pf-stcta">Go PRO →</span>
              </div>
            </Link>
          )}
        </div>

        {/* User Menu (Grok-style dropdown) */}
        <UserMenu
          collapsed={collapsed}
          onItemClick={onItemClick}
          isDemoMode={isDemoMode}
          handleDemoSignOut={handleDemoSignOut}
          mounted={mounted}
          planId={planId}
        />
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// UserMenu - Grok-style dropdown at sidebar bottom
// ---------------------------------------------------------------------------

/** Cosmetic account numbers shown in the user-menu plan strip. */
interface SubDetails {
  creditsLimit: number | null;
  creditsUsed: number | null;
  creditsResetAt: string | null;
  nextBillingDate: string | null;
}

/**
 * MONEY-1126: one flight per page load instead of one per navigation. Memory
 * only and keyed by Clerk user id — these are real account balances, so they
 * must never touch localStorage (contrast `lib/subscription/billing-summary-cache`,
 * which persists but validates the user id on read).
 *
 * `null` (nothing to show) is not remembered, so a failed/empty response
 * retries on the next navigation.
 */
const subDetailsCache = createOncePerUserCache<SubDetails | null>({
  shouldRemember: (details) => details !== null,
});

async function fetchSubDetails(): Promise<SubDetails | null> {
  const { getSubscriptionAction } = await import("@/lib/actions/subscription");
  const r = await getSubscriptionAction();
  if (!r?.data) return null;
  return {
    creditsLimit: r.data.creditsLimit ?? null,
    creditsUsed: r.data.creditsUsed ?? null,
    creditsResetAt: r.data.creditsResetAt ?? null,
    nextBillingDate: r.data.nextBillingDate ?? null,
  };
}

function UserMenu({
  collapsed,
  onItemClick,
  isDemoMode,
  handleDemoSignOut,
  mounted,
  planId,
}: {
  collapsed: boolean;
  onItemClick?: () => void;
  isDemoMode: boolean;
  handleDemoSignOut: () => void;
  mounted: boolean;
  planId: string | null;
}) {
  const { user, isLoaded } = useUser();
  const { signOut, openUserProfile } = useClerk();
  const { resolvedTheme, setTheme } = useTheme();
  const router = useRouter();

  const userName =
    user?.fullName || user?.firstName || user?.username || "Trader";
  const userImage = user?.imageUrl;
  const isDark = resolvedTheme === "dark";

  const userEmail = user?.primaryEmailAddress?.emailAddress;

  // Subscription detail state — fetched once when the user is loaded.
  // creditsLimit / creditsUsed / creditsResetAt are nullable so the plan
  // strip can degrade gracefully when the data hasn't loaded yet.
  const [subDetails, setSubDetails] = useState<SubDetails>({
    creditsLimit: null,
    creditsUsed: null,
    creditsResetAt: null,
    nextBillingDate: null,
  });

  // MONEY-1126: every page renders its own <Sidebar/>, so this fired one
  // `getSubscriptionAction` per client-side navigation. `plan-cache` can't serve
  // it (that cache holds only the plan id, and these are account numbers that
  // must never be persisted), so it gets the memory-only, user-id-keyed
  // once-per-page-load cache instead. Cosmetic: the credits line and renewal
  // date in the user menu. Nothing gates on it.
  useEffect(() => {
    if (!isLoaded || !user || isDemoMode) return;
    let cancelled = false;
    subDetailsCache
      .get(user.id, fetchSubDetails)
      .then((details) => {
        if (!cancelled && details) setSubDetails(details);
      })
      .catch(() => {
        // silently ignore — credits line just won't show
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, user, isDemoMode]);

  // menuItems legacy dropdown JSX removed 2026-05-28 — both the demo and the
  // authenticated branches now render the playful PfUserProfileMenu card, so
  // the old DropdownMenuLabel/Sub/SubContent tree was no longer rendered by
  // any branch. The Settings/Help submenus live inside PfUserProfileMenu now.

  // Loading state
  if (!mounted || (!isLoaded && !isDemoMode)) {
    return (
      <div
        className={cn(
          "border-t border-[var(--border-default)] shrink-0",
          collapsed ? "p-2" : "p-4"
        )}
      >
        <div className="flex items-center gap-3 justify-center">
          <div className="h-8 w-8 rounded-full bg-[var(--bg-card)] animate-pulse" />
          {!collapsed && (
            <div className="h-4 w-24 bg-[var(--bg-card)] rounded animate-pulse" />
          )}
        </div>
      </div>
    );
  }

  // Demo user — mirrors the authenticated pf-sb-foot shell so demo visitors
  // see the user card + Theme/Settings/Help quick-row + Settings link the same
  // way real users do. Clerk-specific bits (avatar URL, plan fetch, credits)
  // are skipped; sign-out is wired to handleDemoSignOut which ends the demo
  // cookie and clears local state before hard-navigating to /home.
  if (isDemoMode) {
    return (
      <div className="pf-sb-foot">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-walkthrough="user-menu-trigger"
              className={cn("pf-user", collapsed && "coll")}
            >
              <span className="pf-av">D</span>
              {!collapsed && (
                <>
                  <div className="pf-uinfo">
                    <div className="pf-un">
                      <span className="truncate">Demo User</span>
                    </div>
                  </div>
                  <ChevronDown className="pf-uchev h-3.5 w-3.5 shrink-0" />
                </>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align={collapsed ? "center" : "start"}
            className="p-0 border-0 shadow-none bg-transparent rounded-none overflow-visible"
            style={{ width: "auto" }}
          >
            <PfUserProfileMenu
              userName="Demo User"
              planId="FREE"
              creditsLimit={null}
              creditsUsed={null}
              creditsResetAt={null}
              nextBillingDate={null}
              onFeedback={() => {
                router.push("/settings?tab=feedback");
                onItemClick?.();
              }}
              onSubscription={() => {
                router.push("/settings?tab=plans");
                onItemClick?.();
              }}
              onNavigate={(href) => {
                router.push(href);
                onItemClick?.();
              }}
              onTourAgain={() => {
                triggerWalkthroughRestart();
                onItemClick?.();
              }}
              onHomePage={() => {
                router.push("/home");
                onItemClick?.();
              }}
              onLogOut={handleDemoSignOut}
              logOutLabel="End demo"
            />
          </DropdownMenuContent>
        </DropdownMenu>

        {!collapsed && (
          <div className="pf-sb-foot-row">
            <button
              type="button"
              className="pf-ttl"
              onClick={(e) =>
                animateThemeTransition(
                  isDark ? "light" : "dark",
                  setTheme,
                  e.currentTarget
                )
              }
            >
              {isDark ? (
                <Sun className="h-3 w-3" />
              ) : (
                <Moon className="h-3 w-3" />
              )}
              Theme
            </button>
            <button
              type="button"
              className="pf-sett"
              onClick={() => {
                router.push("/settings");
                onItemClick?.();
              }}
            >
              <Settings className="h-3 w-3" /> Settings
            </button>
            <button
              type="button"
              className="pf-help"
              aria-label="Help &amp; docs"
              onClick={() => {
                router.push("/help");
                onItemClick?.();
              }}
            >
              <span style={{ fontWeight: 800, fontSize: 13 }}>?</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  // Authenticated user — pf-user card + Theme/Settings/Help quick-row
  if (isLoaded && user) {
    return (
      <div className="pf-sb-foot">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-walkthrough="user-menu-trigger"
              className={cn("pf-user", collapsed && "coll")}
            >
              {userImage ? (
                <Image
                  src={userImage}
                  alt={userName}
                  width={28}
                  height={28}
                  className="pf-av"
                  style={{ objectFit: "cover" }}
                />
              ) : (
                <span className="pf-av">
                  {userName.charAt(0).toUpperCase()}
                </span>
              )}
              {!collapsed && (
                <>
                  <div className="pf-uinfo">
                    <div className="pf-un">
                      <span className="truncate">{userName}</span>
                      {(planId === "PRO" || planId === "PREMIUM") && (
                        <span className="pf-tag-pro">{planId}</span>
                      )}
                    </div>
                    {userEmail && <div className="pf-ue">{userEmail}</div>}
                  </div>
                  <ChevronDown className="pf-uchev h-3.5 w-3.5 shrink-0" />
                </>
              )}
            </button>
          </DropdownMenuTrigger>
          {/* PfUserProfileMenu — playful 320 px card (MONEY-489). The
              DropdownMenuContent wrapper is kept borderless/shadowless because
              the card itself carries border + hard-shadow styling. */}
          <DropdownMenuContent
            side="top"
            align={collapsed ? "center" : "start"}
            // overflow-visible: the DropdownMenuContent base class includes
            // overflow-hidden which clipped the right-side Settings/Help
            // flyout that escapes the card (#120). The card supplies its
            // own border/shadow/bg/radius, so the rest of the overrides stay.
            className="p-0 border-0 shadow-none bg-transparent rounded-none overflow-visible"
            style={{ width: "auto" }}
          >
            <PfUserProfileMenu
              userName={userName}
              userEmail={userEmail}
              userImage={userImage}
              planId={planId}
              creditsLimit={subDetails.creditsLimit}
              creditsUsed={subDetails.creditsUsed}
              creditsResetAt={subDetails.creditsResetAt}
              nextBillingDate={subDetails.nextBillingDate}
              onFeedback={() => {
                router.push("/settings?tab=feedback");
                onItemClick?.();
              }}
              onSubscription={() => {
                router.push("/settings?tab=plans");
                onItemClick?.();
              }}
              onNavigate={(href) => {
                router.push(href);
                onItemClick?.();
              }}
              onTourAgain={() => {
                triggerWalkthroughRestart();
                onItemClick?.();
              }}
              onHomePage={() => {
                router.push("/home");
                onItemClick?.();
              }}
              onLogOut={() => instantSignOut(signOut)}
            />
          </DropdownMenuContent>
        </DropdownMenu>

        {!collapsed && (
          <div className="pf-sb-foot-row">
            <button
              type="button"
              className="pf-ttl"
              onClick={(e) =>
                animateThemeTransition(
                  isDark ? "light" : "dark",
                  setTheme,
                  e.currentTarget
                )
              }
            >
              {isDark ? (
                <Sun className="h-3 w-3" />
              ) : (
                <Moon className="h-3 w-3" />
              )}
              Theme
            </button>
            <button
              type="button"
              className="pf-sett"
              onClick={() => {
                router.push("/settings");
                onItemClick?.();
              }}
            >
              <Settings className="h-3 w-3" /> Settings
            </button>
            <button
              type="button"
              className="pf-help"
              aria-label="Help &amp; docs"
              onClick={() => {
                router.push("/help");
                onItemClick?.();
              }}
            >
              <span style={{ fontWeight: 800, fontSize: 13 }}>?</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper for mobile sheet menu items
// ---------------------------------------------------------------------------

function MobileSheetItem({
  icon: Icon,
  label,
  onClick,
  variant = "default",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  variant?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 mx-2 my-0.5 rounded-lg text-[13.5px] font-medium transition-colors ${
        variant === "danger"
          ? "text-red-400 hover:bg-red-500/10"
          : "text-[var(--text-primary)] hover:bg-emerald-500/10 hover:text-emerald-400"
      }`}
      style={{ width: "calc(100% - 16px)" }}
    >
      <Icon
        className={`h-4 w-4 ${
          variant === "danger" ? "text-red-400/80" : "text-emerald-400/70"
        }`}
      />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// MobileProfileAvatar - Sheet on phones, DropdownMenu on tablets
// ---------------------------------------------------------------------------

const ProfileAvatarButton = forwardRef<
  HTMLButtonElement,
  {
    userImage?: string;
    userName: string;
    isDemoMode: boolean;
    isLoaded: boolean;
    user: ReturnType<typeof useUser>["user"];
    className?: string;
    onClick?: () => void;
  }
>(
  (
    {
      userImage,
      userName,
      isDemoMode,
      isLoaded,
      user,
      className,
      onClick,
      ...props
    },
    ref
  ) => {
    return (
      <button
        type="button"
        ref={ref}
        onClick={onClick}
        data-walkthrough="user-menu-trigger"
        className={cn(
          "h-9 w-9 rounded-full overflow-hidden flex items-center justify-center",
          className
        )}
        {...props}
      >
        {isLoaded && user && userImage ? (
          <Image
            src={userImage}
            alt={userName}
            width={32}
            height={32}
            className="h-8 w-8 rounded-full object-cover"
          />
        ) : (
          <div className="h-8 w-8 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-500 flex items-center justify-center">
            <span className="text-xs font-bold text-[var(--text-inverse)]">
              {isDemoMode ? "D" : userName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
      </button>
    );
  }
);
ProfileAvatarButton.displayName = "ProfileAvatarButton";

function MobileProfileAvatar({
  userImage,
  userName,
  userEmail,
  isDemoMode,
  isLoaded,
  user,
  isDark,
  resolvedTheme,
  setTheme,
  signOut,
  router,
}: {
  userImage?: string;
  userName: string;
  userEmail?: string;
  isDemoMode: boolean;
  isLoaded: boolean;
  user: ReturnType<typeof useUser>["user"];
  isDark: boolean;
  resolvedTheme?: string;
  setTheme: (theme: string) => void;
  signOut: (opts: { redirectUrl: string }) => void;
  router: ReturnType<typeof useRouter>;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);

  const themeToggle = (
    <div className="flex items-center bg-[var(--bg-card)] rounded-lg p-0.5 gap-0.5">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          animateThemeTransition("system", setTheme, e.currentTarget);
        }}
        className={cn(
          "p-1 rounded transition-colors",
          resolvedTheme === undefined
            ? "bg-[var(--bg-primary)] shadow-sm"
            : "hover:bg-[var(--bg-primary)]/50"
        )}
        title="System"
      >
        <Monitor className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          animateThemeTransition("light", setTheme, e.currentTarget);
        }}
        className={cn(
          "p-1 rounded transition-colors",
          !isDark && resolvedTheme === "light"
            ? "bg-[var(--bg-primary)] shadow-sm"
            : "hover:bg-[var(--bg-primary)]/50"
        )}
        title="Light"
      >
        <Sun className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          animateThemeTransition("dark", setTheme, e.currentTarget);
        }}
        className={cn(
          "p-1 rounded transition-colors",
          isDark && resolvedTheme === "dark"
            ? "bg-[var(--bg-primary)] shadow-sm"
            : "hover:bg-[var(--bg-primary)]/50"
        )}
        title="Dark"
      >
        <Moon className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  const handleSignOut = () => {
    if (isDemoMode) {
      instantEndDemo();
    } else {
      instantSignOut(signOut);
    }
  };

  return (
    <>
      {/* Phones: Sheet */}
      <div className="sm:hidden ml-1">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <ProfileAvatarButton
              userImage={userImage}
              userName={userName}
              isDemoMode={isDemoMode}
              isLoaded={isLoaded}
              user={user}
            />
          </SheetTrigger>
          <SheetContent
            side="right"
            className="w-80 bg-background border-emerald-500/20 p-0 overflow-y-auto"
            style={{
              boxShadow:
                "0 0 0 1px rgba(52,211,153,.05), 0 0 60px rgba(52,211,153,.06)",
            }}
          >
            {/* Profile header - emerald accent on avatar, tighter padding */}
            <div className="px-5 py-5 border-b border-border bg-emerald-500/[0.02]">
              <div className="flex items-center gap-3">
                {isLoaded && user && userImage ? (
                  <Image
                    src={userImage}
                    alt={userName}
                    width={48}
                    height={48}
                    className="h-12 w-12 rounded-full object-cover ring-2 ring-emerald-500/30"
                  />
                ) : (
                  <div className="h-12 w-12 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-500 shadow-[0_0_18px_rgba(52,211,153,0.35)] flex items-center justify-center">
                    <span className="text-lg font-bold text-[#16140e]">
                      {isDemoMode ? "D" : userName.charAt(0).toUpperCase()}
                    </span>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">
                    {isDemoMode ? "Demo User" : userName}
                  </p>
                  {userEmail && (
                    <p className="font-mono text-[11px] text-muted-foreground truncate mt-0.5">
                      {userEmail}
                    </p>
                  )}
                </div>
              </div>
            </div>
            <div className="py-2">
              <MobileSheetItem
                icon={MessageSquarePlus}
                label="Feedback"
                onClick={() => {
                  router.push("/settings?tab=feedback");
                  setSheetOpen(false);
                }}
              />
              <MobileSheetItem
                icon={Crown}
                label="Subscription"
                onClick={() => {
                  router.push("/settings?tab=plans");
                  setSheetOpen(false);
                }}
              />
              <div className="flex items-center justify-between px-6 py-3">
                <div className="flex items-center gap-3 text-[13.5px] font-medium text-foreground">
                  {isDark ? (
                    <Moon className="h-4 w-4 text-emerald-400/70" />
                  ) : (
                    <Sun className="h-4 w-4 text-emerald-400/70" />
                  )}
                  Theme
                </div>
                {themeToggle}
              </div>
              <div className="border-t border-border my-2" />
              <p className="px-6 pt-2 pb-1 font-mono text-[10px] font-bold tracking-[1.5px] text-emerald-400 uppercase">
                Settings
              </p>
              <MobileSheetItem
                icon={User}
                label="Account"
                onClick={() => {
                  router.push("/settings?tab=account");
                  setSheetOpen(false);
                }}
              />
              <MobileSheetItem
                icon={Crown}
                label="Plans"
                onClick={() => {
                  router.push("/settings?tab=plans");
                  setSheetOpen(false);
                }}
              />
              <MobileSheetItem
                icon={CreditCard}
                label="Billing"
                onClick={() => {
                  router.push("/settings?tab=billing");
                  setSheetOpen(false);
                }}
              />
              <MobileSheetItem
                icon={Bell}
                label="Notifications"
                onClick={() => {
                  router.push("/settings?tab=notifications");
                  setSheetOpen(false);
                }}
              />
              <div className="border-t border-border my-2" />
              <MobileSheetItem
                icon={Sparkles}
                label="Take the tour again"
                onClick={() => {
                  triggerWalkthroughRestart();
                  setSheetOpen(false);
                }}
              />
              <div className="border-t border-border my-2" />
              <p className="px-6 pt-2 pb-1 font-mono text-[10px] font-bold tracking-[1.5px] text-emerald-400 uppercase">
                Help &amp; Info
              </p>
              <MobileSheetItem
                icon={HelpCircle}
                label="Help Center"
                onClick={() => {
                  router.push("/help");
                  setSheetOpen(false);
                }}
              />
              <MobileSheetItem
                icon={Scroll}
                label="Docs"
                onClick={() => {
                  router.push("/docs");
                  setSheetOpen(false);
                }}
              />
              <MobileSheetItem
                icon={Home}
                label="Home Page"
                onClick={() => {
                  router.push("/home");
                  setSheetOpen(false);
                }}
              />
              <div className="border-t border-border my-2" />
              <MobileSheetItem
                icon={LogOut}
                label={isDemoMode ? "End Demo" : "Log Out"}
                variant="danger"
                onClick={() => {
                  setSheetOpen(false);
                  handleSignOut();
                }}
              />
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* Tablets/small screens: DropdownMenu */}
      <div className="hidden sm:block lg:hidden ml-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ProfileAvatarButton
              userImage={userImage}
              userName={userName}
              isDemoMode={isDemoMode}
              isLoaded={isLoaded}
              user={user}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-60 bg-popover border border-emerald-500/20 backdrop-blur-md shadow-[0_8px_32px_rgba(0,0,0,.4),0_0_24px_rgba(52,211,153,.1)] rounded-[12px] p-1.5"
          >
            {!isDemoMode && isLoaded && user && (
              <>
                <DropdownMenuLabel className="py-3">
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-semibold text-[var(--text-primary)] truncate">
                      {userName}
                    </span>
                    {userEmail && (
                      <span className="text-xs text-[var(--text-muted)] truncate font-normal">
                        {userEmail}
                      </span>
                    )}
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              onClick={() => router.push("/settings?tab=feedback")}
            >
              <MessageSquarePlus className="h-4 w-4 mr-2 text-emerald-400" />{" "}
              Feedback
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => router.push("/settings?tab=plans")}
            >
              <Crown className="h-4 w-4 mr-2 text-emerald-400" /> Subscription
            </DropdownMenuItem>
            <div className="flex items-center justify-between px-2 py-1.5">
              <div className="flex items-center gap-2 text-sm">
                {isDark ? (
                  <Moon className="h-4 w-4" />
                ) : (
                  <Sun className="h-4 w-4" />
                )}
                Theme
              </div>
              {themeToggle}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Settings className="h-4 w-4 mr-2" /> Settings
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="bg-popover border border-emerald-500/20 backdrop-blur-md rounded-[10px]">
                <DropdownMenuItem
                  onClick={() => router.push("/settings?tab=account")}
                >
                  <User className="h-4 w-4 mr-2" /> Account
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/settings?tab=plans")}
                >
                  <Crown className="h-4 w-4 mr-2" /> Plans
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/settings?tab=billing")}
                >
                  <CreditCard className="h-4 w-4 mr-2" /> Billing
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/settings?tab=usage")}
                >
                  <Activity className="h-4 w-4 mr-2" /> Usage
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/settings?tab=preferences")}
                >
                  <Sliders className="h-4 w-4 mr-2" /> Preferences
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/settings?tab=notifications")}
                >
                  <Bell className="h-4 w-4 mr-2" /> Notifications
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/settings?tab=security")}
                >
                  <ShieldCheck className="h-4 w-4 mr-2" /> Security
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/settings?tab=integrations")}
                >
                  <Plug className="h-4 w-4 mr-2" /> Integrations
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onClick={() => triggerWalkthroughRestart()}>
              <Sparkles className="h-4 w-4 mr-2 text-emerald-400" /> Take the
              tour again
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push("/home")}>
              <Home className="h-4 w-4 mr-2" /> Home Page
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <HelpCircle className="h-4 w-4 mr-2" /> Help
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                alignOffset={-120}
                sideOffset={4}
                className="bg-popover border border-emerald-500/20 backdrop-blur-md rounded-[10px]"
              >
                <DropdownMenuItem
                  onClick={() => router.push("/help?tab=prompts")}
                >
                  <Sparkles className="h-4 w-4 mr-2" /> Prompts
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/help?tab=commands")}
                >
                  <MessageSquare className="h-4 w-4 mr-2" /> Commands
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/help?tab=guides")}
                >
                  <BookOpen className="h-4 w-4 mr-2" /> Guides
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push("/help?tab=docs")}>
                  <Scroll className="h-4 w-4 mr-2" /> Docs
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push("/help?tab=faq")}>
                  <HelpCircle className="h-4 w-4 mr-2" /> FAQ
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/help?tab=glossary")}
                >
                  <BookOpen className="h-4 w-4 mr-2" /> Glossary
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut}>
              <LogOut className="h-4 w-4 mr-2" />{" "}
              {isDemoMode ? "End Demo" : "Log Out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// MobileNavSheet — full-screen takeover (design mobile-nav.jsx · Option A)
// Renders the real sidenavConfig (so every route stays reachable) in the
// big-tile playful style, with the same feature-flag + demo gating as the
// desktop NavContent. Self-contained: owns its hooks; closes via onNavigate.
// ---------------------------------------------------------------------------

function MobileNavSheet({ onNavigate }: { onNavigate: () => void }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const { resolvedTheme, setTheme } = useTheme();
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  // MONEY-1137: `user` comes from the useUser() call above — no second hook.
  const isDemoMode = useIsDemoMode({ user });
  const [planId, setPlanId] = useState(() => getCachedPlan() ?? "FREE");

  useEffect(() => {
    if (!isLoaded || !user) return;
    fetchPlanCached().then(setPlanId);
    // Live-update the tier tag when the plan is reseeded after an upgrade
    // (the billing page seeds it post-payment) — no reload needed.
    return subscribeCachedPlan(setPlanId);
  }, [isLoaded, user]);

  const userName =
    user?.fullName || user?.firstName || user?.username || "Trader";
  const userEmail = user?.primaryEmailAddress?.emailAddress;
  const userImage = user?.imageUrl;
  const isDark = resolvedTheme === "dark";
  const isPro = planId === "PRO" || planId === "PREMIUM";

  const isActive = (href: string) => {
    if (href.includes("?")) {
      const qIdx = href.indexOf("?");
      const hrefPath = href.slice(0, qIdx);
      if (pathname !== hrefPath) return false;
      const expectedParams = new URLSearchParams(href.slice(qIdx + 1));
      let allMatch = true;
      expectedParams.forEach((value, key) => {
        if (searchParams?.get(key) !== value) allMatch = false;
      });
      return allMatch;
    }
    if (pathname === href) {
      if (href === "/dashboard") return !searchParams?.get("view");
      return true;
    }
    return pathname?.startsWith(href + "/") ?? false;
  };

  // Demo sessions don't fetch flags — DEFAULT_FLAGS is authoritative,
  // so don't gate on flagsLoading (see desktop nav comment above).
  const effectiveLoading = isDemoMode ? false : flagsLoading;
  const visible = (item: NavItem | NavSubItem) =>
    !(item.hideInDemo && isDemoMode) &&
    !(item.featureFlag && (effectiveLoading || !flags[item.featureFlag]));

  const go = (href: string) => {
    router.push(href);
    onNavigate();
  };

  const handleSignOut = () => {
    if (isDemoMode) {
      instantEndDemo();
    } else {
      instantSignOut(signOut);
    }
  };

  return (
    <div className="pf-msheet">
      <div className="pf-msheet-top">
        <Link
          href="/dashboard"
          onClick={onNavigate}
          className="brand"
          data-walkthrough="sidebar-logo"
        >
          <span className="pf-brand-mark">U</span>
          <span>UseMoney</span>
        </Link>
        <button
          type="button"
          className="pf-msheet-x"
          aria-label="Close menu"
          onClick={onNavigate}
        >
          <span
            aria-hidden
            style={{ fontSize: 16, fontWeight: 700, lineHeight: 1 }}
          >
            ✕
          </span>
        </button>
      </div>

      {!isDemoMode && (
        <div className="pf-msheet-pcard">
          {userImage ? (
            <Image
              src={userImage}
              alt={userName}
              width={42}
              height={42}
              className="av"
              style={{ objectFit: "cover" }}
            />
          ) : (
            <span className="av">{userName.charAt(0).toUpperCase()}</span>
          )}
          <div className="pi">
            <div className="pn">
              <span className="truncate">{userName}</span>
              <span className="ser">— hey there.</span>
            </div>
            {userEmail && <div className="pe">{userEmail}</div>}
          </div>
          {isPro && <span className="pro">{planId}</span>}
        </div>
      )}

      <div className="pf-msheet-scroll">
        {sidenavConfig.map((section) => {
          const items = section.items.filter(visible);
          if (items.length === 0) return null;
          return (
            <div key={section.label}>
              <div className="pf-msheet-grp">
                <span>{section.label}</span>
                <span className="r" />
              </div>
              {items.map((item) => {
                const ItemIcon = item.icon;
                const kids = item.children?.filter(visible) ?? [];
                return (
                  <div key={item.href}>
                    <button
                      type="button"
                      className={cn(
                        "pf-mitem",
                        isActive(item.href) && "active"
                      )}
                      onClick={() => go(item.href)}
                      data-walkthrough={item.walkthrough}
                    >
                      <span className={cn("ic", item.color)}>
                        <ItemIcon className="h-[17px] w-[17px]" />
                      </span>
                      <span className="lbl">{item.label}</span>
                      {item.badge && (
                        <span className="badge">{item.badge}</span>
                      )}
                    </button>
                    {kids.map((c) => {
                      const ChildIcon = c.icon;
                      return (
                        <button
                          type="button"
                          key={c.href}
                          className={cn(
                            "pf-mitem sub",
                            isActive(c.href) && "active"
                          )}
                          onClick={() => go(c.href)}
                        >
                          <span className="ic">
                            <ChildIcon className="h-3.5 w-3.5" />
                          </span>
                          <span className="lbl">{c.label}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="pf-msheet-foot">
        <button
          type="button"
          className="b"
          onClick={(e) =>
            animateThemeTransition(
              isDark ? "light" : "dark",
              setTheme,
              e.currentTarget
            )
          }
        >
          {isDark ? (
            <Sun className="h-3.5 w-3.5" />
          ) : (
            <Moon className="h-3.5 w-3.5" />
          )}{" "}
          Theme
        </button>
        <button type="button" className="b" onClick={() => go("/settings")}>
          <Settings className="h-3.5 w-3.5" /> Settings
        </button>
        <button type="button" className="b solid" onClick={handleSignOut}>
          <LogOut className="h-3.5 w-3.5" />{" "}
          {isDemoMode ? "End demo" : "Sign out"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile Header with left nav Sheet + right profile Sheet
// ---------------------------------------------------------------------------

export function MobileHeader() {
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();
  const { resolvedTheme, setTheme } = useTheme();
  const { setOpen: setCommandOpen } = useCommandPalette();
  const router = useRouter();

  // MONEY-1137: `user` comes from the useUser() call above — no second hook.
  const isDemoMode = useIsDemoMode({ user });

  // Walkthrough provider asks us to open/close the nav Sheet so nav-anchored
  // tour steps have a visible target on mobile (sidebar otherwise hidden).
  // While the walkthrough is driving the Sheet we also lock its outside-close
  // behavior - the walkthrough popover is rendered outside the Sheet, so a
  // tap on Next would otherwise count as "interact outside" and slam the
  // Sheet shut between steps.
  const walkthroughControlsSheetRef = useRef(false);
  useEffect(() => {
    function onSet(event: Event) {
      const detail = (event as CustomEvent<{ open: boolean }>).detail;
      if (detail && typeof detail.open === "boolean") {
        walkthroughControlsSheetRef.current = detail.open;
        setNavOpen(detail.open);
      }
    }
    window.addEventListener("walkthrough:set-mobile-nav", onSet);
    return () => {
      window.removeEventListener("walkthrough:set-mobile-nav", onSet);
    };
  }, []);

  const handleSheetOpenChange = useCallback((open: boolean) => {
    // Block user-initiated close while the walkthrough is driving the Sheet.
    if (!open && walkthroughControlsSheetRef.current) return;
    setNavOpen(open);
  }, []);

  const preventIfWalkthroughDriven = useCallback(
    (e: { preventDefault: () => void }) => {
      if (walkthroughControlsSheetRef.current) e.preventDefault();
    },
    []
  );

  if (isPublicShellRoute(pathname)) return null;

  const userName =
    user?.fullName || user?.firstName || user?.username || "Trader";
  const userEmail = user?.primaryEmailAddress?.emailAddress;
  const userImage = user?.imageUrl;
  const isDark = resolvedTheme === "dark";

  return (
    <header className="lg:hidden fixed top-0 left-0 right-0 z-50">
      {/* Main bar */}
      <div className="h-14 bg-[var(--bg-primary)] border-b border-[var(--border-default)] flex items-center justify-between px-4">
        {/* Left: nav menu + logo */}
        <div className="flex items-center">
          <Sheet open={navOpen} onOpenChange={handleSheetOpenChange}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-[var(--text-primary)]"
              >
                <Menu className="h-6 w-6" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-screen max-w-none p-0 border-0 [&>button]:hidden"
              onPointerDownOutside={preventIfWalkthroughDriven}
              onInteractOutside={preventIfWalkthroughDriven}
              onEscapeKeyDown={preventIfWalkthroughDriven}
            >
              {/* Next 15+ : MobileNavSheet reads useSearchParams(); Suspense
                  satisfies the CSR-bailout (defensive — the Sheet is closed at
                  prerender time). fallback={null} preserves prior behavior. */}
              <Suspense fallback={null}>
                <MobileNavSheet
                  onNavigate={() => {
                    // Don't manually close while the walkthrough is anchoring.
                    if (!walkthroughControlsSheetRef.current) setNavOpen(false);
                  }}
                />
              </Suspense>
            </SheetContent>
          </Sheet>
          <Link
            href="/dashboard"
            data-walkthrough="sidebar-logo"
            className="flex items-center gap-2 ml-3 hover:opacity-80 transition-opacity"
          >
            <div className="w-6 h-6 rounded-md bg-[var(--ink)] -rotate-3 flex items-center justify-center text-[var(--paper)] font-mono font-black text-[11px]">
              U
            </div>
            <span className="font-display font-bold text-[15px] tracking-[-0.3px] text-[var(--text-primary)]">
              UseMoney<span className="text-[var(--accent-primary)]"> AI</span>
            </span>
          </Link>
        </div>

        {/* Right: search + theme + notifications + profile */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] h-9 w-9"
            onClick={() => setCommandOpen(true)}
          >
            <Search className="h-5 w-5" />
          </Button>
          <AnimatedThemeToggler
            iconSize="h-5 w-5"
            className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors h-9 w-9 flex items-center justify-center"
          />
          <NotificationBell />

          {/*
           * Mobile profile avatar removed: the same account / settings /
           * sign-out actions are reachable from the bottom-tab "More"
           * surface, so this top-right slot was duplicate. The
           * MobileProfileAvatar component definition above is currently
           * orphaned — safe to delete in a follow-up sweep when no other
           * surface needs it.
           */}
        </div>
      </div>

      <div className="h-[var(--mobile-ticker-h)] bg-[var(--nav-bg-scrolled)] border-b border-[var(--border-default)] overflow-hidden">
        <MarketTicker />
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// MobileTabBar — persistent bottom primary nav on phones (design: pf-btab)
// ---------------------------------------------------------------------------

const MOBILE_TABS: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/holdings", label: "Holdings", icon: PieChart },
  { href: "/discover/markets", label: "Markets", icon: Activity },
  { href: "/watchlist", label: "Watch", icon: Eye },
  { href: "/tradebook", label: "Trades", icon: BookOpen },
];

export function MobileTabBar() {
  const pathname = usePathname();
  const prefetchOnIntent = useNavPrefetcher();
  if (isPublicShellRoute(pathname)) return null;
  const isActive = (href: string) =>
    pathname === href || (pathname?.startsWith(href + "/") ?? false);
  return (
    <nav className="pf-btab lg:hidden" aria-label="Primary">
      {MOBILE_TABS.map((t) => {
        const TabIcon = t.icon;
        // MONEY-1132 — the bottom bar obeys the same prefetch budget as the
        // sidebar. It is rendered on EVERY phone page load, so leaving it on
        // Next's eager default meant five RSC payloads per mount regardless of
        // the allowlist — and two of these five (`/discover/markets`,
        // `/watchlist`) sit below the traffic cliff the allowlist was drawn at,
        // so they were exactly what the budget was meant to exclude. Mobile is
        // also where the wasted payloads cost the most.
        const eager = NAV_PREFETCH_ALLOWLIST.has(t.href);
        return (
          <Link
            key={t.label}
            href={t.href}
            prefetch={eager ? undefined : false}
            onMouseEnter={eager ? undefined : () => prefetchOnIntent(t.href)}
            onTouchStart={eager ? undefined : () => prefetchOnIntent(t.href)}
            onFocus={eager ? undefined : () => prefetchOnIntent(t.href)}
            className={cn(isActive(t.href) && "active")}
          >
            <span className="ic">
              <TabIcon className="h-[18px] w-[18px]" />
            </span>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

// Routes where sidebar and topbar should NOT appear are in the dependency-free
// `@/lib/route-lists` module (imported at the top of this file) so the list
// can't drift from TermsGate's excluded paths or the route-access test.
export function isPublicShellRoute(pathname: string | null): boolean {
  if (!pathname) return true;
  return PUBLIC_SHELL_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(r + "/")
  );
}

// Desktop Sidebar
export default function Sidebar() {
  const { collapsed, toggleSidebar } = useSidebar();
  const pathname = usePathname();

  if (isPublicShellRoute(pathname)) return null;

  return (
    <>
      {/* Desktop Sidebar */}
      <aside
        className={cn(
          "fixed left-0 top-0 h-full bg-[var(--bg-primary)] border-r-2 border-[var(--ink)] hidden lg:block z-40 transition-all duration-200",
          collapsed ? "w-16" : "w-64"
        )}
      >
        {/* Collapse toggle button */}
        <button
          onClick={toggleSidebar}
          className="absolute -right-4 top-7 z-50 h-8 w-8 rounded-full flex items-center justify-center text-[var(--ink-3)] hover:text-[var(--ink)] transition-colors"
          style={{
            background: "var(--paper)",
            border: "1.5px solid var(--ink)",
            boxShadow: "2px 2px 0 var(--ink)",
          }}
          title={
            collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"
          }
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
        {/* Next 15+ : NavContent reads request-time useSearchParams(); wrapping
            it in <Suspense> is the canonical fix for the CSR-bailout so any page
            rendering <Sidebar/> can still be prerendered. fallback={null} keeps
            the prior client-render behavior (chrome appears once hydrated). */}
        <Suspense fallback={null}>
          <NavContent collapsed={collapsed} />
        </Suspense>
      </aside>

      {/* Mobile Header. The persistent bottom tab bar is rendered globally by
          GlobalMobileBottomNav (layout root) so there is a single, consistent
          mobile nav across every authenticated route — MobileTabBar used to
          render a second, divergent bar here (Home/Markets/Watch/Trades) which
          collided with GlobalMobileBottomNav's Chat/Holdings/Screener/Brokers/
          More set. Retired to avoid the duplicate (MONEY-484). */}
      <MobileHeader />
    </>
  );
}
