"use client";

import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { NotificationBell } from "@/components/NotificationBell";
import { MarketTicker } from "@/components/MarketTicker";
import { useCommandPalette } from "@/components/CommandPalette";
import { isPublicShellRoute } from "@/components/Sidebar";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { useMarketTickerStore } from "@/lib/stores/market-ticker";

// deriveMeta is kept but no longer rendered in the topbar row.
// It's preserved here so no import changes are needed downstream and
// can be reinstated if another surface needs it.
function deriveMeta(pathname: string): { crumb: string; title: string } {
  const seg = pathname.split("/").filter(Boolean);
  if (seg.length === 0) return { crumb: "HOME · OVERVIEW", title: "Dashboard" };
  const first = seg[0];

  if (first === "discover") {
    const subMap: Record<string, { crumb: string; title: string }> = {
      markets: { crumb: "DISCOVER · MARKETS", title: "Markets" },
      screener: { crumb: "DISCOVER · SCREENER", title: "Screener" },
      sectors: { crumb: "DISCOVER · SECTORS", title: "Sectors" },
      news: { crumb: "DISCOVER · NEWS", title: "News & Events" },
      lists: { crumb: "DISCOVER · LISTS", title: "Curated Lists" },
    };
    if (seg[1] && subMap[seg[1]]) return subMap[seg[1]];
    return { crumb: "DISCOVER", title: "Discover" };
  }

  const map: Record<string, { crumb: string; title: string }> = {
    dashboard: { crumb: "HOME · OVERVIEW", title: "Dashboard" },
    holdings: { crumb: "TRADE · HOLDINGS", title: "Holdings" },
    positions: { crumb: "TRADE · POSITIONS", title: "Positions" },
    tradebook: { crumb: "TRADE · TRADEBOOK", title: "Tradebook" },
    watchlist: { crumb: "TRADE · WATCHLIST", title: "Watchlists" },
    roast: { crumb: "TRADE · ROAST", title: "Portfolio Roast" },
    strategies: { crumb: "DISCOVER · STRATEGIES", title: "Strategies" },
    analysis: { crumb: "DISCOVER · RESEARCH", title: "Research" },
    compare: { crumb: "DISCOVER · COMPARE", title: "Compare" },
    stock: { crumb: "DISCOVER · STOCK", title: "Stock" },
    mf: { crumb: "DISCOVER · FUND", title: "Mutual Fund" },
    etf: { crumb: "DISCOVER · ETF", title: "ETF" },
    "paper-trading": { crumb: "TOOLS · PAPER", title: "Paper Trading" },
    fire: { crumb: "TOOLS · FIRE", title: "FIRE Calculator" },
    calculators: { crumb: "TOOLS · CALCULATORS", title: "Calculators" },
    risk: { crumb: "TOOLS · RISK", title: "Risk Report" },
    tax: { crumb: "TOOLS · TAX", title: "Tax Report" },
    documents: { crumb: "TOOLS · VAULT", title: "Document Vault" },
    brokers: { crumb: "ACCOUNT · BROKERS", title: "Brokers" },
    learning: { crumb: "LEARN · COURSES", title: "Learning" },
    "sage-tutor": { crumb: "LEARN · TUTOR", title: "StockSage Tutor" },
    quizzes: { crumb: "LEARN · QUIZ", title: "Quizzes" },
    settings: { crumb: "ACCOUNT · SETTINGS", title: "Settings" },
    notifications: { crumb: "ACCOUNT · ALERTS", title: "Notifications" },
    help: { crumb: "SUPPORT · HELP", title: "Help & Docs" },
  };
  if (map[first]) return map[first];
  return {
    crumb: first.replace(/-/g, " ").toUpperCase(),
    title: first.charAt(0).toUpperCase() + first.slice(1).replace(/-/g, " "),
  };
}

// Suppress unused-variable lint warning — deriveMeta is intentionally kept
// for future reuse.
void deriveMeta;

export default function TopBar() {
  const { setOpen } = useCommandPalette();
  const pathname = usePathname();
  const { marketStatus } = useMarketTickerStore();

  if (isPublicShellRoute(pathname)) return null;

  // Market status badge (design: pf-tb-pill). Emerald when active; muted +
  // non-pulsing when the market is closed.
  const indiaStatus = marketStatus?.IN;
  const isOpen = indiaStatus === "OPEN";
  const isPre = indiaStatus === "PRE";
  const isPost = indiaStatus === "POST";
  const live = isOpen || isPre || isPost;
  const statusLabel = isOpen
    ? "MARKET OPEN · NSE"
    : isPre
      ? "PRE-MARKET · NSE"
      : isPost
        ? "POST-MARKET · NSE"
        : "MARKET CLOSED · NSE";
  const pillStyle = live
    ? undefined
    : {
        background: "var(--rule-softer)",
        color: "var(--ink-3)",
        borderColor: "var(--ink-3)",
      };

  // Total height: pf-tb-row min-height 56px + ticker h-7 (28px) = 84px = 5.25rem
  // This matches --topbar-h: 5.25rem defined in globals.css. No change needed.
  return (
    <div className="hidden lg:block fixed top-0 right-0 left-[var(--sidebar-w)] z-30 transition-all duration-200">
      {/* Top row — search LEFT, right side: market-status pill, theme toggle, bell.
          Breadcrumb + page title removed (Task C-b): page content owns its hero. */}
      <div className="pf-tb-row bg-[var(--paper)] border-b-2 border-[var(--ink)]">
        {/* Search bar — LEFT side (Task C-a) */}
        <button
          type="button"
          className="pf-tb-search"
          onClick={() => setOpen(true)}
          aria-label="Search markets, stocks, brokers"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span>Search markets, stocks, brokers…</span>
          <span className="pf-kbd">⌘K</span>
        </button>

        {/* Spacer pushes right-side controls to the edge */}
        <div className="pf-tb-spacer" />

        {/* Right side: market-status pill · theme toggle · notifications bell (Task C-c) */}
        <div className="pf-tb-pill" style={pillStyle}>
          <span
            className="d"
            style={
              live
                ? undefined
                : { background: "var(--ink-3)", animation: "none" }
            }
          />
          {statusLabel}
        </div>
        <AnimatedThemeToggler
          iconSize="h-[15px] w-[15px]"
          className="pf-tb-icon-btn"
        />
        <NotificationBell />
      </div>

      {/* Ticker strip — stays BELOW the topbar row (Task C-d).
          Combined height: 56px row + 28px ticker = 84px = --topbar-h (5.25rem). */}
      <div className="h-7 bg-[var(--nav-bg-scrolled)] backdrop-blur-[20px] border-b-2 border-[var(--ink)] overflow-hidden">
        <MarketTicker />
      </div>
    </div>
  );
}
