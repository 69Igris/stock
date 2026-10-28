"use client";

import { ReactNode } from "react";
import Sidebar from "@/components/Sidebar";
import {
  Sparkles,
  Briefcase,
  Eye,
  BookOpen,
  Flame,
  Activity,
  SlidersHorizontal,
  Layers,
  Target,
  Shield,
  FileText,
  Link as LinkIcon,
  Settings,
  Plus,
  Search,
  Menu,
  ArrowLeft,
  LogOut,
  LucideIcon,
} from "lucide-react";

/* ─────────────────────────────────────────────────────────────────────
   Information architecture - matches design Shell.jsx
   The sidebar is intentionally local to the Terminal Luxe pages
   (Holdings/Tradebook/FIRE/Brokers) and does not replace the global
   Sidebar component, which is updated separately under MONEY-185.
   ───────────────────────────────────────────────────────────────────── */

interface NavItem {
  id: string;
  href: string;
  icon: LucideIcon;
  name: string;
  badge?: string;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    label: "WORKSPACE",
    items: [
      {
        id: "dashboard",
        href: "/dashboard",
        icon: Sparkles,
        name: "StockSage",
      },
      { id: "holdings", href: "/holdings", icon: Briefcase, name: "Holdings" },
      { id: "watchlists", href: "/watchlist", icon: Eye, name: "Watchlists" },
      {
        id: "tradebook",
        href: "/tradebook",
        icon: BookOpen,
        name: "Tradebook",
      },
      { id: "roast", href: "/roast", icon: Flame, name: "Portfolio Roast" },
    ],
  },
  {
    label: "DISCOVER",
    items: [
      { id: "markets", href: "/discover", icon: Activity, name: "Markets" },
      {
        id: "screener",
        // Real route lives under /discover; `/screener` is a 404. Legacy
        // Sidebar already pointed at /discover/screener - this sidebar
        // had drifted.
        href: "/discover/screener",
        icon: SlidersHorizontal,
        name: "Screener",
      },
      {
        id: "strategies",
        href: "/strategies",
        icon: Layers,
        name: "Strategies",
      },
      // Research Lists + News are MONEY-197 (Phase 5) - design exists
      // but the routes aren't shipped yet. Leaving them out of the
      // sidebar prevents 404s when users tap.
    ],
  },
  {
    label: "TOOLS",
    items: [
      { id: "fire", href: "/fire", icon: Target, name: "FIRE Calculator" },
      // Risk Report + Tax Report hidden from sub-nav for now.
      // { id: "risk", href: "/risk", icon: Shield, name: "Risk Report" },
      // { id: "tax", href: "/tax", icon: FileText, name: "Tax Report" },
    ],
  },
  {
    label: "ACCOUNT",
    items: [
      { id: "brokers", href: "/brokers", icon: LinkIcon, name: "Brokers" },
      { id: "settings", href: "/settings", icon: Settings, name: "Settings" },
    ],
  },
];

const MOBILE_NAV: NavItem[] = [
  { id: "holdings", href: "/holdings", icon: Briefcase, name: "Holdings" },
  { id: "tradebook", href: "/tradebook", icon: BookOpen, name: "Trades" },
  { id: "brokers", href: "/brokers", icon: LinkIcon, name: "Brokers" },
  { id: "fire", href: "/fire", icon: Target, name: "FIRE" },
  { id: "roast", href: "/roast", icon: Flame, name: "Roast" },
];

/* ───────────── Sidebar (desktop + drawer share content) ─────────────── */

function SidebarContent({
  activeId,
  onNav,
  userInitials,
  userName,
  userSubtitle,
}: {
  activeId: string;
  onNav: (item: NavItem) => void;
  userInitials: string;
  userName: string;
  userSubtitle: string;
}) {
  return (
    <>
      <div
        style={{
          padding: "16px 18px",
          borderBottom: "1px solid var(--border-default)",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            background: "var(--ink)",
            borderRadius: 7,
            transform: "rotate(-3deg)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--paper)",
            fontFamily: "var(--font-jetbrains), monospace",
            fontWeight: 900,
            fontSize: 14,
          }}
        >
          U
        </div>
        <div
          style={{
            fontWeight: 700,
            fontSize: 15,
            letterSpacing: "-.3px",
            color: "var(--text-primary)",
          }}
        >
          UseMoney<span style={{ color: "var(--accent-primary)" }}> AI</span>
        </div>
        <span
          style={{
            marginLeft: "auto",
            fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
            fontSize: 9,
            padding: "2px 6px",
            background: "rgba(167,139,250,.15)",
            color: "#a78bfa",
            borderRadius: 4,
            fontWeight: 700,
            letterSpacing: 1,
          }}
        >
          PRO
        </span>
      </div>

      <button
        type="button"
        onClick={() =>
          onNav({
            id: "dashboard",
            href: "/dashboard",
            icon: Sparkles,
            name: "StockSage",
          })
        }
        style={{
          margin: "12px 14px 4px",
          padding: "10px 12px",
          background: "linear-gradient(135deg,#34d399,#10b981)",
          color: "#16140e",
          border: 0,
          borderRadius: 8,
          fontWeight: 600,
          fontSize: 13,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
          boxShadow: "0 0 22px rgba(52,211,153,.2)",
        }}
      >
        <Plus style={{ width: 14, height: 14 }} /> New chat
        <span
          style={{
            marginLeft: "auto",
            fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
            fontSize: 10,
            opacity: 0.7,
            background: "var(--rule-softer)",
            padding: "2px 5px",
            borderRadius: 4,
          }}
        >
          ⌘K
        </span>
      </button>

      <div style={{ flex: 1, overflow: "auto", padding: "8px 10px" }}>
        {SECTIONS.map((sec) => (
          <div key={sec.label} style={{ marginTop: 12 }}>
            <div
              style={{
                fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
                fontSize: 9.5,
                letterSpacing: 1.8,
                // MONEY-438 follow-up: bumped from --text-muted to --text-dim
                // so section labels read crisply in light mode (was slate-400
                // on near-white, almost invisible).
                color: "var(--text-dim)",
                fontWeight: 700,
                padding: "6px 8px",
              }}
            >
              {sec.label}
            </div>
            {sec.items.map((it) => {
              const isActive = activeId === it.id;
              const Icon = it.icon;
              return (
                <div
                  key={it.id}
                  onClick={() => onNav(it)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 7,
                    cursor: "pointer",
                    marginBottom: 1,
                    background: isActive
                      ? "rgba(52,211,153,.1)"
                      : "transparent",
                    // MONEY-438 follow-up: bumped from --text-dim to
                    // --text-secondary so inactive nav items read at the
                    // same contrast as the user-menu dialog in light
                    // mode. --text-secondary resolves to slate-800 in
                    // light and slate-200 in dark — works in both.
                    color: isActive ? "#34d399" : "var(--text-secondary)",
                    borderLeft: isActive
                      ? "2px solid #34d399"
                      : "2px solid transparent",
                    paddingLeft: isActive ? 10 : 12,
                    fontSize: 13,
                    fontWeight: 500,
                    transition: "all .15s",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive)
                      // Theme-aware hover: --bg-card-hover is an emerald-
                      // tinted alpha that reads in both modes (white-alpha
                      // hover was invisible against the light sidebar bg).
                      e.currentTarget.style.background = "var(--bg-card-hover)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive)
                      e.currentTarget.style.background = "transparent";
                  }}
                >
                  <Icon style={{ width: 15, height: 15, flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{it.name}</span>
                  {it.badge && (
                    <span
                      style={{
                        fontFamily:
                          "var(--font-jetbrains), ui-monospace, monospace",
                        fontSize: 9.5,
                        fontWeight: 700,
                        padding: "1px 6px",
                        borderRadius: 999,
                        background: isActive
                          ? "var(--emerald-bg)"
                          : "var(--rule-softer)",
                        color: isActive
                          ? "var(--emerald-text)"
                          : "var(--text-muted)",
                      }}
                    >
                      {it.badge}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div
        style={{
          padding: 14,
          borderTop: "1px solid var(--border-default)",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 999,
            background: "linear-gradient(135deg,#a78bfa,#3b82f6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          {userInitials}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--text-primary)",
            }}
          >
            {userName}
          </div>
          <div
            style={{
              fontSize: 10.5,
              color: "var(--text-muted)",
              fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
            }}
          >
            {userSubtitle}
          </div>
        </div>
        <LogOut
          style={{
            width: 14,
            height: 14,
            color: "var(--text-muted)",
            cursor: "pointer",
          }}
        />
      </div>
    </>
  );
}

/* ──────────────────────── Topbar + Ticker ──────────────────────── */

interface TopbarProps {
  title: ReactNode;
  breadcrumb?: ReactNode;
  right?: ReactNode;
  showAskSage?: boolean;
  onMenu: () => void;
  onBack?: () => void;
}

export function Topbar({
  title,
  breadcrumb,
  right,
  showAskSage = false,
  onMenu,
  onBack,
}: TopbarProps) {
  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        background: "rgba(6,11,24,.82)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderBottom: "1px solid var(--border-default)",
      }}
    >
      <div
        style={{
          height: 56,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 18px",
        }}
      >
        <button
          type="button"
          className="um-mobile-trigger"
          onClick={onMenu}
          aria-label="Open navigation"
          style={{
            width: 36,
            height: 36,
            padding: 0,
            background: "var(--rule-softer)",
            border: "1px solid var(--border-default)",
            borderRadius: 8,
            color: "var(--text-primary)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Menu style={{ width: 18, height: 18 }} />
        </button>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            flex: "0 1 auto",
          }}
        >
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              style={{
                width: 30,
                height: 30,
                padding: 0,
                background: "var(--rule-softer)",
                border: "1px solid var(--border-default)",
                borderRadius: 7,
                color: "var(--text-secondary)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <ArrowLeft style={{ width: 14, height: 14 }} />
            </button>
          )}
          {breadcrumb && (
            <span
              className="um-hide-mobile"
              style={{
                fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
                fontSize: 11,
                color: "var(--text-muted)",
                letterSpacing: 1,
                textTransform: "uppercase",
                whiteSpace: "nowrap",
              }}
            >
              {breadcrumb} /
            </span>
          )}
          <h1
            style={{
              fontWeight: 700,
              fontSize: 16,
              letterSpacing: "-.2px",
              margin: 0,
              color: "var(--text-primary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </h1>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {showAskSage && (
            <button
              type="button"
              className="um-hide-mobile"
              style={{
                padding: "7px 12px",
                background: "rgba(52,211,153,.12)",
                border: "1px solid rgba(52,211,153,.3)",
                color: "#34d399",
                borderRadius: 9999,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Sparkles style={{ width: 12, height: 12 }} /> Ask StockSage
            </button>
          )}
          <div
            className="um-topbar-search"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 11px",
              background: "var(--rule-softer)",
              border: "1px solid var(--border-default)",
              borderRadius: 8,
              fontSize: 12.5,
              color: "var(--text-dim)",
              minWidth: 200,
            }}
          >
            <Search style={{ width: 13, height: 13 }} />
            Search markets, stocks…
            <span
              style={{
                marginLeft: "auto",
                fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
                fontSize: 10,
                padding: "1px 5px",
                background: "rgba(255,255,255,.05)",
                border: "1px solid var(--border-default)",
                borderRadius: 4,
                color: "var(--text-muted)",
              }}
            >
              ⌘K
            </span>
          </div>
          <div
            className="um-hide-mobile"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 10px",
              background: "rgba(74,222,128,.08)",
              border: "1px solid rgba(74,222,128,.2)",
              borderRadius: 7,
              fontSize: 11.5,
              fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
              color: "#4ade80",
              fontWeight: 600,
            }}
          >
            <span className="um-pulse-dot" /> MARKET OPEN
          </div>
          {right}
        </div>
      </div>
      <TickerStrip />
    </div>
  );
}

/* Ticker fed from `MarketTicker` exists in repo, but its style differs.
   We render a static rolling strip to match the design exactly. Live data
   integration will come later via /api/market/indices. */

const TICKER_DATA: [string, string, string, boolean][] = [
  ["NIFTY 50", "24,687.55", "+0.82%", true],
  ["SENSEX", "81,240.12", "+0.74%", true],
  ["BANKNIFTY", "52,481.20", "+0.64%", true],
  ["NIFTY IT", "38,125.40", "+1.82%", true],
  ["RELIANCE", "2,892.50", "+1.24%", true],
  ["HDFCBANK", "1,687.80", "+0.21%", true],
  ["INFY", "1,812.65", "+0.92%", true],
  ["TCS", "4,105.20", "−0.12%", false],
  ["ICICIBANK", "1,245.10", "+1.18%", true],
  ["ITC", "448.20", "+0.84%", true],
  ["BAJFINANCE", "7,215.60", "+0.58%", true],
  ["PAYTM", "482.10", "−3.80%", false],
  ["KOTAKBANK", "1,748.30", "+0.42%", true],
  ["USDINR", "83.42", "−0.08%", false],
  ["GOLD", "71,284", "+0.42%", true],
  ["CRUDE", "6,124", "−1.24%", false],
];

export function TickerStrip() {
  // Duplicate the array so the marquee loops seamlessly.
  const data = [...TICKER_DATA, ...TICKER_DATA];
  return (
    <div
      style={{
        borderTop: "1px solid var(--border-default)",
        background: "rgba(0,0,0,.25)",
        overflow: "hidden",
        position: "relative",
        height: 32,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 80,
          background: "linear-gradient(90deg,rgba(6,11,24,1),rgba(6,11,24,0))",
          zIndex: 2,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: 80,
          background: "linear-gradient(-90deg,rgba(6,11,24,1),rgba(6,11,24,0))",
          zIndex: 2,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          display: "inline-flex",
          whiteSpace: "nowrap",
          height: "100%",
          alignItems: "center",
          animation: "um-ticker 120s linear infinite",
          willChange: "transform",
        }}
      >
        {data.map(([sym, px, chg, pos], i) => (
          <div
            key={i}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "0 16px",
              borderRight: "1px solid var(--border-default)",
              fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <span
              style={{
                color: "var(--text-secondary)",
                fontWeight: 700,
                letterSpacing: 0.3,
              }}
            >
              {sym}
            </span>
            <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>
              {px}
            </span>
            <span
              style={{
                color: pos ? "#4ade80" : "#f87171",
                fontWeight: 600,
              }}
            >
              {pos ? "▲" : "▼"} {chg}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ──────────────────────── Mobile drawer + bottom nav ──────────────────────── */

function MobileDrawer({
  open,
  onClose,
  activeId,
  onNav,
  userInitials,
  userName,
  userSubtitle,
}: {
  open: boolean;
  onClose: () => void;
  activeId: string;
  onNav: (item: NavItem) => void;
  userInitials: string;
  userName: string;
  userSubtitle: string;
}) {
  if (!open) return null;
  return (
    <>
      <div className="um-drawer-backdrop" onClick={onClose} />
      <aside
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          width: 280,
          background: "rgba(6,11,24,.98)",
          borderRight: "1px solid var(--border-default)",
          display: "flex",
          flexDirection: "column",
          zIndex: 95,
          animation: "um-fade-in .18s ease",
          boxShadow: "8px 0 40px rgba(0,0,0,.6)",
        }}
      >
        <SidebarContent
          activeId={activeId}
          onNav={(item) => {
            onNav(item);
            onClose();
          }}
          userInitials={userInitials}
          userName={userName}
          userSubtitle={userSubtitle}
        />
      </aside>
    </>
  );
}

function MobileBottomNav({
  activeId,
  onNav,
  onMore,
}: {
  activeId: string;
  onNav: (item: NavItem) => void;
  onMore: () => void;
}) {
  return (
    <nav className="um-mobile-nav">
      {MOBILE_NAV.map((it) => {
        const Icon = it.icon;
        return (
          <button
            type="button"
            key={it.id}
            className={
              "um-mobile-nav-item" + (activeId === it.id ? " active" : "")
            }
            onClick={() => onNav(it)}
          >
            <Icon style={{ width: 18, height: 18 }} />
            <span>{it.name}</span>
          </button>
        );
      })}
      <button type="button" className="um-mobile-nav-item" onClick={onMore}>
        <Menu style={{ width: 18, height: 18 }} />
        <span>More</span>
      </button>
    </nav>
  );
}

/* ──────────────────────── Main wrapper ──────────────────────── */

export interface ShellProps {
  /** Identifier of the currently-active sidebar item.
   *  Kept on the props for backwards compatibility - the legacy Sidebar
   *  derives its own active state from `usePathname()` so this prop is
   *  effectively a no-op now. */
  active?: string;
  /** Page content. */
  children: ReactNode;
  /** Page title shown in the in-content header. */
  title: ReactNode;
  /** Breadcrumb shown above the title (uppercase, monospace). */
  breadcrumb?: ReactNode;
  /** Right-aligned page actions (e.g. "+ Add manually"). */
  topbarRight?: ReactNode;
  /** Deprecated - Markets / Discover does not show this affordance, so we
   *  no longer render it. The prop stays so existing callers don't break. */
  showAskSage?: boolean;
  /** Optional back arrow handler. */
  onBack?: () => void;
}

/**
 * TerminalLuxeShell - page layout used by Holdings/Tradebook/FIRE/Brokers
 * and friends.
 *
 * **Source of truth is now the Markets/Discover page chrome** - it mounts
 * the legacy `<Sidebar />` (canonical IA: Markets / Screener / Strategies
 * / Research, Paper Trading, FIRE, Calculators, Risk, Tax, Document Vault,
 * Brokers, Learning, Settings) and lets the global `<TopBar />` from
 * `app/layout.tsx` provide the search bar + market badge + theme toggle
 * + notifications.
 *
 * The breadcrumb / title / `topbarRight` props that pages already pass
 * render as a section header **inside** the main content column, so each
 * redesigned page keeps its existing API while the chrome around it
 * matches every other page in the app.
 */
export function TerminalLuxeShell({
  children,
  title,
  breadcrumb,
  topbarRight,
  onBack,
}: ShellProps) {
  return (
    // pf-app on the OUTERMOST element so the playful dotted background covers
    // the full viewport AND grows with the scrollable page (Roast pattern).
    // Using bg-background here left the area below short content un-dotted.
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-5 max-w-[1600px] mx-auto pb-24 lg:pb-12">
          {(title || breadcrumb || topbarRight || onBack) && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 18,
                flexWrap: "wrap",
              }}
            >
              {onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  aria-label="Back"
                  style={{
                    width: 32,
                    height: 32,
                    padding: 0,
                    background: "var(--rule-softer)",
                    border: "1px solid var(--border-default)",
                    borderRadius: 8,
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <ArrowLeft style={{ width: 14, height: 14 }} />
                </button>
              )}
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 12,
                  minWidth: 0,
                  flex: 1,
                  flexWrap: "wrap",
                }}
              >
                {/* Title comes first; the breadcrumb / section label sits
                    inline to the right on the same baseline - Markets
                    pattern: "Markets DISCOVER", "Holdings PORTFOLIO",
                    "Brokers ACCOUNT". Stacking them looked like an
                    afterthought next to the canonical layout. */}
                {title && (
                  <h1
                    style={{
                      fontWeight: 700,
                      fontSize: 28,
                      letterSpacing: "-.5px",
                      margin: 0,
                      color: "var(--text-primary)",
                      lineHeight: 1.1,
                    }}
                  >
                    {title}
                  </h1>
                )}
                {breadcrumb && (
                  <span
                    style={{
                      fontFamily:
                        "var(--font-jetbrains), ui-monospace, monospace",
                      fontSize: 11,
                      color: "var(--text-muted)",
                      letterSpacing: 1.2,
                      textTransform: "uppercase",
                      fontWeight: 700,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {breadcrumb}
                  </span>
                )}
              </div>
              {topbarRight && (
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  {topbarRight}
                </div>
              )}
            </div>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}
