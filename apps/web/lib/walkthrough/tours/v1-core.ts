import type { TourDefinition, TourStep } from "@/components/walkthrough/types";

// --- Step fragments ---------------------------------------------------------
// The v1-core tour fires on /dashboard but the StockSage chat composer only
// lives on /dashboard?view=chat. We split the tour into three reusable
// fragments so WalkthroughProvider can reorder the "intro" steps based on the
// user's default-landing preference (Settings → Preferences):
//   • DASHBOARD-first (default): welcome → dashboard → chat → nav items
//   • STOCKSAGE-first (user set chat as their home): welcome → chat → dashboard
//     → nav items
// The nav/tail fragment is identical in both orderings. navigateTo + target +
// requiresMobileSidebar are intrinsic to each step and never change with the
// ordering, so the provider only has to concatenate fragments.

const WELCOME_STEP: TourStep = {
  id: "welcome",
  target: '[data-walkthrough="sidebar-logo"]',
  placement: "right",
  headline: "Welcome to UseMoney",
  body: "Your AI-powered command center for Indian markets.",
};

// Dashboard overview step. Navigates to the /dashboard overview (the chat
// steps live on ?view=chat, so whichever ordering puts chat adjacent, this
// step still has to return to / stay on the overview shell). It also serves as
// the launchpad for the sidebar-nav steps that follow, which all live on the
// overview shell.
const DASHBOARD_STEP: TourStep = {
  id: "dashboard",
  navigateTo: "/dashboard",
  target: '[data-walkthrough="dashboard-overview"]',
  placement: "bottom",
  headline: "Your portfolio at a glance",
  body: "Your live dashboard: total value, today's P&L, and returns across every connected broker — switch between Beginner and Advanced views any time.",
};

// StockSage chat steps. Both anchor composer UI that only renders on the chat
// view of the dashboard (/dashboard?view=chat), not on the /dashboard
// overview — so both declare that navigateTo and the tour navigates there
// before anchoring.
const CHAT_STEPS: TourStep[] = [
  {
    id: "ai-assistant",
    navigateTo: "/stocksage",
    target: '[data-walkthrough="dashboard-chat-input"]',
    placement: "top",
    headline: "AI Assistant for investment",
    body: "Ask anything - portfolio analysis, stock research, tax help. Try: How did my portfolio do this week?",
  },
  {
    id: "chat-plus",
    navigateTo: "/stocksage",
    target: '[data-walkthrough="chat-plus-icon"]',
    placement: "top",
    headline: "Research mode + attachments",
    body: "Tap the + icon to switch research depth (Quick / Deep / Comprehensive) and attach files for analysis.",
  },
];

// Sidebar-nav + tail steps. Identical regardless of the intro ordering.
const NAV_AND_TAIL_STEPS: TourStep[] = [
  {
    id: "holdings",
    target: '[data-walkthrough="nav-holdings"]',
    placement: "right",
    headline: "All holdings, live",
    body: "Every stock and mutual fund from every broker - auto-synced with live prices and P&L.",
    requiresMobileSidebar: true,
  },
  {
    id: "roast",
    target: '[data-walkthrough="nav-roast"]',
    placement: "right",
    headline: "Get roasted (kindly)",
    body: "Free AI portfolio analysis with a brutal-but-fair score and actionable suggestions.",
    requiresMobileSidebar: true,
  },
  {
    id: "brokers",
    target: '[data-walkthrough="nav-brokers"]',
    placement: "right",
    headline: "Every broker, one place",
    body: "Connect Zerodha, Upstox, Dhan, Angel One, Groww, and Fyers - one unified portfolio view.",
    requiresMobileSidebar: true,
  },
  {
    id: "screener",
    target: '[data-walkthrough="nav-screener"]',
    placement: "right",
    headline: "Find stocks fast",
    body: "Screen NSE/BSE on fundamentals, technicals, and AI themes - save your own scans.",
    requiresMobileSidebar: true,
  },
  // The "paper" step (nav-paper anchor) was removed 2026-05-28: Paper
  // Trading was pulled from the sidebar nav per product decision, so the
  // anchor no longer exists. Route + actions remain intact; re-add this
  // step (and the v1-paper tours) if the nav entry returns.
  {
    id: "fire",
    target: '[data-walkthrough="nav-fire"]',
    placement: "right",
    headline: "Plan your FIRE",
    body: "Project your path to financial independence - SIPs, lump sums, and target retirement corpus.",
    requiresMobileSidebar: true,
  },
  {
    id: "default-page",
    // Targets the sidebar user-menu trigger (the inline DEFAULT LANDING pill
    // was removed from the dashboard header 2026-05-28). This is the step that
    // teaches the user they can pick their home base — Dashboard overview vs
    // StockSage chat — which is the same preference the tour adapts its own
    // ordering to. Keep it in the tour.
    target: '[data-walkthrough="user-menu-trigger"]',
    placement: "top",
    headline: "Choose your home base",
    body: "Pick where you land each time you sign in: the Dashboard overview or straight into StockSage chat. Change it anytime from Settings → Preferences in this menu.",
  },
  {
    id: "finish",
    target: '[data-walkthrough="user-menu-trigger"]',
    placement: "top",
    headline: "You're set",
    body: "Re-run this tour anytime from the user menu.",
  },
];

/**
 * Default (dashboard-first) ordering:
 *   welcome → dashboard → ai-assistant → chat-plus → nav items → default-page → finish
 * Used when the user's default landing page is the dashboard (the signup
 * default) or the preference can't be read.
 */
export const v1CoreSteps: TourStep[] = [
  WELCOME_STEP,
  DASHBOARD_STEP,
  ...CHAT_STEPS,
  ...NAV_AND_TAIL_STEPS,
];

/**
 * StockSage-first ordering:
 *   welcome → ai-assistant → chat-plus → dashboard → nav items → default-page → finish
 * Used when the user has set StockSage chat as their default landing page —
 * we lead with the surface they actually start their day on.
 */
export const v1CoreStepsStockSageFirst: TourStep[] = [
  WELCOME_STEP,
  ...CHAT_STEPS,
  DASHBOARD_STEP,
  ...NAV_AND_TAIL_STEPS,
];

export const v1Core: TourDefinition = {
  version: "v1-core",
  trigger: { kind: "route", pathPrefix: "/dashboard" },
  priority: 100,
  steps: v1CoreSteps,
};
