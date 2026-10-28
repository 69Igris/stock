"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { useSidebar } from "@/components/SidebarContext";
import { PageGuard } from "@/components/PageGuard";
import { getMarketSnapshot } from "@/lib/market/market-hours";

const PAPER_NAV: Array<{
  id: string;
  label: string;
  href: string;
  title: string;
}> = [
  {
    id: "chat",
    label: "Chat",
    href: "/paper-trading",
    title: "Chat",
  },
  {
    id: "overview",
    label: "Overview",
    href: "/paper-trading/overview",
    title: "Overview",
  },
  {
    id: "terminal",
    label: "Terminal",
    href: "/paper-trading/terminal",
    title: "Terminal",
  },
  {
    id: "positions",
    label: "Positions",
    href: "/paper-trading/positions",
    title: "Positions",
  },
  {
    id: "history",
    label: "History",
    href: "/paper-trading/history",
    title: "History",
  },
  {
    id: "analytics",
    label: "Analytics",
    href: "/paper-trading/analytics",
    title: "Analytics",
  },
];

/**
 * Subscribes to the IST market clock. Re-renders every second with the
 * current time + market-open flag (driven by `getMarketSnapshot` so the
 * gating logic is testable in isolation).
 */
function useMarketClock() {
  const [state, setState] = useState(() => getMarketSnapshot());
  useEffect(() => {
    const tick = () => setState(getMarketSnapshot());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return state;
}

export default function PaperTradingLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { collapsed } = useSidebar();
  const isTerminal = pathname === "/paper-trading/terminal";
  const { time: marketTime, isOpen: marketOpen } = useMarketClock();

  // Active route detection - exact match for every entry.
  // /paper-trading is now the Chat tab (default landing); Overview moved
  // to /paper-trading/overview.
  const activeRoute = PAPER_NAV.find((n) => pathname === n.href)?.id || "chat";

  // MONEY-392: PageGuard used to wrap the entire layout, which stripped
  // the sub-nav + per-route title during its loading state. Moved it to
  // gate only the `{children}` content area so stages 1-3 share the
  // same chrome (sub-nav, h1, market clock) and the user sees a stable
  // header across the whole loading chain.
  return (
    <div className="flex min-h-screen pf-app relative">
      <Sidebar />
      <main className="flex-1 lg:ml-[var(--sidebar-w)] pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        {/* Sub-nav (playful) — VIRTUAL pill + ink-filled tabs + LIVE clock */}
        <div className="flex items-center gap-2 px-4 lg:px-6 py-2.5 border-b-2 border-[var(--ink)] bg-[var(--paper)] flex-wrap">
          <span className="pf-pill emerald" style={{ fontSize: 10 }}>
            VIRTUAL
          </span>
          <div className="w-px h-4 bg-[var(--rule-soft)] mx-1" />
          {PAPER_NAV.map((n) => {
            const active = activeRoute === n.id;
            return (
              <button
                key={n.id}
                onClick={() => router.push(n.href)}
                className="font-mono text-[11.5px] font-semibold tracking-[0.3px] cursor-pointer transition-colors"
                style={{
                  padding: "5px 12px",
                  borderRadius: 7,
                  border: active
                    ? "1.5px solid var(--ink)"
                    : "1.5px solid transparent",
                  background: active ? "var(--ink)" : "transparent",
                  color: active ? "var(--paper)" : "var(--ink-3)",
                }}
              >
                {n.label}
              </button>
            );
          })}
          <div className="flex-1" />
          <span
            className="pf-pill mono"
            style={{
              fontSize: 10,
              background: marketOpen
                ? "var(--emerald-bg)"
                : "var(--rule-softer)",
              borderColor: marketOpen ? "var(--emerald)" : "var(--ink-3)",
              color: marketOpen ? "var(--emerald-text)" : "var(--ink-3)",
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: marketOpen ? "var(--emerald)" : "var(--ink-3)",
                boxShadow: marketOpen ? "0 0 6px var(--emerald)" : undefined,
                animation: marketOpen ? "ph-pulse 1.6s infinite" : undefined,
              }}
            />
            {marketOpen ? `LIVE · NSE ${marketTime}` : "CLOSED · 09:15 IST"}
          </span>
        </div>

        <div
          className={`px-4 lg:px-6 pt-4 lg:pt-6 pb-48 sm:pb-44 space-y-4 mx-auto ${
            isTerminal && collapsed ? "" : "max-w-7xl"
          }`}
        >
          {/* Per-route H1 + VIRTUAL breadcrumb + LIVE indicator
                (Paper.jsx Positions/Overview/Terminal headers) */}
          <div className="flex items-baseline gap-3.5 flex-wrap">
            <h1
              style={{
                fontSize: 28,
                fontWeight: 800,
                letterSpacing: "-0.5px",
                color: "var(--ink)",
                margin: 0,
              }}
            >
              {PAPER_NAV.find((n) => n.id === activeRoute)?.title ||
                "Paper Trading"}
            </h1>
            <span
              className="mono"
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 1.2,
                color: "var(--ink-3)",
                fontWeight: 700,
              }}
            >
              VIRTUAL
            </span>
            <div className="flex-1" />
            <span
              className="pf-pill mono"
              style={{
                fontSize: 11,
                background: marketOpen
                  ? "var(--emerald-bg)"
                  : "var(--rule-softer)",
                borderColor: marketOpen ? "var(--emerald)" : "var(--ink-3)",
                color: marketOpen ? "var(--emerald-text)" : "var(--ink-3)",
              }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{
                  background: marketOpen ? "var(--emerald)" : "var(--ink-3)",
                  boxShadow: marketOpen ? "0 0 6px var(--emerald)" : undefined,
                  animation: marketOpen ? "ph-pulse 1.6s infinite" : undefined,
                }}
              />
              {marketOpen ? "LIVE · last tick 0.4s" : "MARKET CLOSED"}
            </span>
          </div>
          {/* PageGuard wraps only the content area so the header stays
                visible across feature-flag + subscription resolution.
                `bare` skips PageGuard's own Sidebar+main chrome (the
                parent layout already provides it). */}
          <PageGuard route="/paper-trading" bare>
            {children}
          </PageGuard>
        </div>
      </main>
    </div>
  );
}
