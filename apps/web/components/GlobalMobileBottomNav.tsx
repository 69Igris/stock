"use client";

/**
 * GlobalMobileBottomNav
 *
 * Persistent 6-slot bottom nav rendered on every page below 1100px:
 *   Holdings · Screen · + (chat) · Brokers · More
 *
 * Hidden on marketing/auth routes (see HIDDEN_PREFIXES). On the StockSage
 * chat surface (/stocksage) the nav stays visible — the chat composer pads
 * its bottom to clear this bar rather than hiding it.
 *
 * Styling: playful design system (gmbn-* classes in global-mobile-nav.css).
 * CSS vars come from playful-app.css (:root / html.dark) — never hardcoded.
 */

import "./global-mobile-nav.css";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Briefcase,
  SlidersHorizontal,
  Plus,
  Link as LinkIcon,
  Target,
  Menu,
  Eye,
  BookOpen,
  Flame,
  Activity,
  Layers,
  FileText,
  Newspaper,
  Shield,
  Settings,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";

interface NavSlot {
  id: string;
  href: string;
  icon: LucideIcon;
  name: string;
}

/* The four primary route slots flanking the center "+" chat button. Five
   slots total (with the More button) keeps the + perfectly centered:
   Holdings · Screen · + · Brokers · More.
   FIRE moves into the More drawer alongside Risk / Tax / Tradebook. */
const PRIMARY_SLOTS: NavSlot[] = [
  { id: "holdings", href: "/holdings", icon: Briefcase, name: "Holdings" },
  {
    id: "screener",
    // Real route is /discover/screener - `/screener` is a 404. The
    // legacy Sidebar already pointed at /discover/screener; this nav
    // had drifted.
    href: "/discover/screener",
    icon: SlidersHorizontal,
    name: "Screener",
  },
  { id: "chat", href: "/stocksage", icon: Plus, name: "Chat" },
  { id: "brokers", href: "/brokers", icon: LinkIcon, name: "Brokers" },
];

/* Items revealed in the More drawer. */
const MORE_ITEMS: NavSlot[] = [
  // Routes that ship today. Aspirational MONEY-197 routes
  // (/research-lists, /news) and the chat-centric secondary surfaces
  // are deliberately omitted so we don't 404 the user mid-tap.
  { id: "fire", href: "/fire", icon: Target, name: "FIRE Calculator" },
  { id: "tradebook", href: "/tradebook", icon: BookOpen, name: "Tradebook" },
  { id: "watchlists", href: "/watchlist", icon: Eye, name: "Watchlists" },
  { id: "roast", href: "/roast", icon: Flame, name: "Portfolio Roast" },
  { id: "markets", href: "/discover/markets", icon: Activity, name: "Markets" },
  { id: "strategies", href: "/strategies", icon: Layers, name: "Strategies" },
  {
    id: "news",
    href: "/discover/news",
    icon: Newspaper,
    name: "News & Events",
  },
  // Risk Report + Tax Report hidden from More sheet for now.
  // { id: "risk", href: "/risk", icon: Shield, name: "Risk Report" },
  // { id: "tax", href: "/tax", icon: FileText, name: "Tax Report" },
  { id: "settings", href: "/settings", icon: Settings, name: "Settings" },
];

/* Routes where the bottom nav stays out of the way. /dashboard now SHOWS the
   bar (it's the single mobile nav after retiring Sidebar.MobileTabBar — the
   chat composer is padded to clear it); auth + onboarding pages render their
   own dedicated chrome. */
const HIDDEN_PREFIXES: readonly string[] = [
  "/sign-in",
  "/sign-up",
  "/sso-callback",
  "/onboarding",
  // Public / marketing routes — no bottom nav on the marketing site
  "/home",
  "/pricing",
  "/terms",
  "/privacy",
  "/subprocessors",
  "/data-usage",
  "/legal",
  "/risk-disclosure",
  "/blog",
  "/newsletter",
  "/glossary",
  "/docs",
  "/about",
  "/features",
  "/alternatives",
  "/changelog",
  "/security",
  "/integrations",
];

function shouldHide(pathname: string | null): boolean {
  if (!pathname) return true;
  return HIDDEN_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

export default function GlobalMobileBottomNav() {
  const router = useRouter();
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  if (shouldHide(pathname)) return null;

  const isActive = (href: string) =>
    pathname === href || pathname?.startsWith(`${href}/`);

  return (
    <>
      {/* ── Bottom nav bar ─────────────────────────────────────────── */}
      <nav className="gmbn-nav lg:hidden" aria-label="Primary navigation">
        {PRIMARY_SLOTS.map((slot) => {
          const Icon = slot.icon;
          const active = isActive(slot.href);
          const isChat = slot.id === "chat";

          if (isChat) {
            return (
              <button
                key={slot.id}
                type="button"
                className="gmbn-chat"
                onClick={() => router.push(slot.href)}
                aria-label="Open StockSage chat"
              >
                <span className="gmbn-chat-bubble">
                  <Plus style={{ width: 22, height: 22 }} />
                </span>
              </button>
            );
          }

          return (
            <button
              key={slot.id}
              type="button"
              className={"gmbn-item" + (active ? " active" : "")}
              onClick={() => router.push(slot.href)}
            >
              <span className="gmbn-ic">
                <Icon style={{ width: 18, height: 18 }} />
              </span>
              <span>{slot.name}</span>
            </button>
          );
        })}

        {/* More button */}
        <button
          type="button"
          className={
            "gmbn-item" +
            (MORE_ITEMS.some((it) => isActive(it.href)) ? " active" : "")
          }
          onClick={() => setMoreOpen(true)}
        >
          <span className="gmbn-ic">
            <Menu style={{ width: 18, height: 18 }} />
          </span>
          <span>More</span>
        </button>
      </nav>

      {/* ── More drawer ────────────────────────────────────────────── */}
      {moreOpen && (
        <>
          {/* Backdrop */}
          <div className="gmbn-backdrop" onClick={() => setMoreOpen(false)} />

          {/* Sheet */}
          <div
            role="dialog"
            aria-label="More navigation"
            className="gmbn-drawer"
          >
            {/* Header */}
            <div className="gmbn-drawer-head">
              <span className="gmbn-drawer-title">More</span>
              <button
                type="button"
                className="gmbn-drawer-close"
                onClick={() => setMoreOpen(false)}
                aria-label="Close"
              >
                <X style={{ width: 13, height: 13 }} />
              </button>
            </div>

            {/* Grid of nav items */}
            <div className="gmbn-drawer-grid">
              {MORE_ITEMS.map((it) => {
                const Icon = it.icon;
                const active = isActive(it.href);
                return (
                  <button
                    key={it.id}
                    type="button"
                    className={"gmbn-drawer-item" + (active ? " active" : "")}
                    onClick={() => {
                      router.push(it.href);
                      setMoreOpen(false);
                    }}
                  >
                    <Icon style={{ width: 14, height: 14 }} />
                    <span>{it.name}</span>
                  </button>
                );
              })}
            </div>

            {/* Footer hint */}
            <div className="gmbn-drawer-hint">
              <Sparkles style={{ width: 11, height: 11, flexShrink: 0 }} />
              Tap the green + to ask StockSage anything.
            </div>
          </div>
        </>
      )}
    </>
  );
}
