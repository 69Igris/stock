"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Download,
  Plus,
  Sparkles,
  Flame,
  GraduationCap,
  Zap,
} from "lucide-react";
import { useUser } from "@clerk/nextjs";
import { getHoldingsAction } from "@/lib/actions/holdings";
import {
  getPortfolioReturnsAction,
  type PortfolioReturns,
} from "@/lib/actions/dashboard";
// getPaperPortfolioAction import removed 2026-05-28 — Paper Trading card no
// longer rendered on the dashboard. Action + service stay intact for /paper-trading.
// getDefaultPagePreferenceAction / updateDefaultPagePreferenceAction imports
// removed 2026-05-28 — DEFAULT LANDING toggle moved off the dashboard header;
// preference now lives in /settings → Preferences only.
import { PfPageHead } from "@/components/playful/PfPageHead";
import { IpoDashboardCard } from "@/components/discover/IpoDashboardCard";
import { sidenavConfig } from "@/components/Sidebar";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";
import {
  BrokerChip,
  toBrokerSlug,
} from "@/components/terminal-luxe/primitives";

type DashVariant = "beginner" | "advanced";
const VARIANT_KEY = "usemoney_dashboard_variant";

/**
 * Dashboard overview composition (MONEY-485) — the design's DashboardScreen:
 * stat strip + performance chart + Ask-Sage panel + top holdings + connected
 * brokers + FIRE tip. Renders on the dashboard's landing (empty-chat) state;
 * the live chat thread still takes over when a conversation is active, so the
 * chat-first IA and all streaming behaviour are preserved.
 *
 * Wired to real data: `stats` (getDashboardStatsAction) drives the strip +
 * performance chart; holdings are fetched here for the Top-Holdings table and
 * to derive the connected-broker chips. The Ask-Sage panel routes prompts
 * back through the existing chat via `onAsk`.
 */

// Minimal shape we read from DashboardStats (defensive — optional throughout).
interface OverviewStats {
  portfolio?: {
    totalValue?: number;
    totalPnL?: number;
    pnlPercentage?: string | number;
    holdingsInvested?: number;
  };
  trading?: {
    todaysPnL?: number;
    todaysChange?: number;
    totalUnrealizedPnL?: number;
  };
  charts?: { dailyPnL?: Array<{ cumulativePnL?: number }> };
}

interface HoldingRow {
  symbol?: string;
  name?: string;
  broker?: string;
  quantity?: number;
  currentPrice?: number;
  ltp?: number;
  currentValue?: number;
  pnl?: number;
  unrealizedPnL?: number;
  pnlPercentage?: number | string;
}

const BROKER_COLORS: Record<string, string> = {
  zerodha: "#387ed1",
  groww: "#5eb66e",
  upstox: "#7b2ff7",
  angel: "#e85454",
  "angel one": "#e85454",
  dhan: "#f59e42",
  fyers: "#2196f3",
  hdfc: "#004c8f",
  "hdfc sky": "#004c8f",
};

const SAGE_CHIPS = [
  "Roast my portfolio",
  "What's my XIRR?",
  "Show winners YTD",
  "Compare to NIFTY",
];

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

function brokerColor(b?: string) {
  return BROKER_COLORS[(b ?? "").toLowerCase()] ?? "#6b6b62";
}

function Sparkline({ up }: { up: boolean }) {
  const d = up
    ? "M2,18 L10,15 L18,16 L26,12 L34,14 L42,10 L50,11 L58,7 L66,5"
    : "M2,5 L10,7 L18,6 L26,10 L34,9 L42,12 L50,11 L58,15 L66,17";
  return (
    <svg
      viewBox="0 0 70 22"
      width={70}
      height={22}
      style={{ display: "block" }}
    >
      <path
        d={d}
        fill="none"
        stroke={up ? "var(--emerald)" : "#b91c1c"}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function DashboardOverview({
  stats,
  greeting,
  userName,
  onAsk,
}: {
  stats: OverviewStats | null | undefined;
  greeting: string | null;
  userName: string;
  onAsk: (q: string) => void;
}) {
  const { user } = useUser();
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [returns, setReturns] = useState<PortfolioReturns | null>(null);
  // paperSummary / paperLoading state removed 2026-05-28 — PaperTradingCard
  // is no longer rendered on the dashboard. Component definition retained
  // below for direct re-enablement if the product decision reverses.
  const [askValue, setAskValue] = useState("");

  // DEFAULT LANDING toggle removed 2026-05-28 — preference now lives only in
  // /settings → Preferences. The header was too cluttered for the inline pill.

  // Beginner vs advanced — seeded from the /welcome investor profile
  // (experience), overridable by the user and persisted to localStorage.
  const [variant, setVariant] = useState<DashVariant>("advanced");
  useEffect(() => {
    const saved =
      typeof window !== "undefined"
        ? (localStorage.getItem(VARIANT_KEY) as DashVariant | null)
        : null;
    if (saved === "beginner" || saved === "advanced") {
      setVariant(saved);
      return;
    }
    const profile = user?.unsafeMetadata?.investorProfile as
      | { experience?: string }
      | undefined;
    const exp = profile?.experience;
    if (exp === "new" || exp === "some") setVariant("beginner");
    else if (exp === "lots" || exp === "pro") setVariant("advanced");
  }, [user]);
  const setVariantPersist = (v: DashVariant) => {
    setVariant(v);
    if (typeof window !== "undefined") localStorage.setItem(VARIANT_KEY, v);
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await getHoldingsAction({});
        if (alive && res?.success && res.data?.holdings) {
          setHoldings(res.data.holdings as HoldingRow[]);
        }
      } catch {
        /* non-blocking — overview degrades gracefully without holdings */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Annualised return (XIRR) — MONEY-485. Computed from dated trade
  // cashflows; null when it can't be computed correctly, in which case the
  // TOTAL RETURN tile simply omits the XIRR sub-line (never faked).
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await getPortfolioReturnsAction();
        if (alive && res?.success && res.data) setReturns(res.data);
      } catch {
        /* non-blocking — tile falls back to the all-time return only */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Paper portfolio fetch useEffect removed 2026-05-28 — card no longer rendered.

  const topHoldings = useMemo(
    () =>
      [...holdings]
        .sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0))
        .slice(0, 5),
    [holdings]
  );

  const brokers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const h of holdings) {
      const b = h.broker?.trim();
      if (b && !seen.has(b.toLowerCase())) seen.set(b.toLowerCase(), b);
    }
    return Array.from(seen.values());
  }, [holdings]);

  const totalValue = stats?.portfolio?.totalValue ?? 0;
  const totalPnL = stats?.portfolio?.totalPnL ?? 0;
  const pnlPct = Number(stats?.portfolio?.pnlPercentage ?? 0);
  // MONEY-1074: prefer the mark-to-market TODAY (holdings dayChange + realized);
  // fall back to realized-only todaysPnL for a stale pre-deploy cached shape.
  const todaysPnL =
    stats?.trading?.todaysChange ?? stats?.trading?.todaysPnL ?? 0;
  const unrealised = stats?.trading?.totalUnrealizedPnL ?? totalPnL;

  // Performance series from real cumulative daily P&L.
  const series = (stats?.charts?.dailyPnL ?? [])
    .map((d) => d.cumulativePnL ?? 0)
    .slice(-60);
  const chartPath = useMemo(() => buildAreaPath(series), [series]);

  const submitAsk = () => {
    const q = askValue.trim();
    if (q) {
      onAsk(q);
      setAskValue("");
    }
  };

  return (
    <div className="pf-app" style={{ minHeight: "100%", width: "100%" }}>
      <div className="pf-page" style={{ paddingTop: 8 }}>
        <PfPageHead
          dataWalkthrough="dashboard-overview"
          eyebrow={`${brokers.length} ${brokers.length === 1 ? "BROKER" : "BROKERS"} · LIVE`}
          title={
            <>
              {greeting ?? "Welcome back,"}{" "}
              <span className="ser">{userName}.</span>
            </>
          }
          sub="Markets are moving. Here's where your money stands."
          right={
            <>
              <div
                style={{
                  display: "flex",
                  border: "1.5px solid var(--ink)",
                  borderRadius: 8,
                  padding: 3,
                  background: "var(--paper)",
                }}
              >
                {(["beginner", "advanced"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVariantPersist(v)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "5px 10px",
                      borderRadius: 5,
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 11.5,
                      fontWeight: 700,
                      textTransform: "capitalize",
                      cursor: "pointer",
                      background: variant === v ? "var(--ink)" : "transparent",
                      color: variant === v ? "var(--paper)" : "var(--ink-3)",
                    }}
                  >
                    {v === "beginner" ? (
                      <GraduationCap size={12} />
                    ) : (
                      <Zap size={12} />
                    )}
                    {v}
                  </button>
                ))}
              </div>
              <Link className="pf-bf" href="/tradebook/export">
                <Download size={14} /> Export
              </Link>
              <Link className="pf-bs" href="/holdings">
                <Plus size={14} /> Add holding
              </Link>
            </>
          }
        />

        {variant === "beginner" ? (
          <BeginnerBody
            totalValue={totalValue}
            todaysPnL={todaysPnL}
            pnlPct={pnlPct}
            brokerCount={brokers.length}
            onAsk={onAsk}
          />
        ) : (
          <>
            {/* Stat strip */}
            <div className="dash-strip" style={{ display: "grid", gap: 14 }}>
              <div className="pf-card pf-stat tilt-l">
                <div className="l">PORTFOLIO VALUE</div>
                <div className="v">{INR(totalValue)}</div>
                <div className={`d ${todaysPnL >= 0 ? "pos" : "neg"}`}>
                  {todaysPnL >= 0 ? "+" : ""}
                  {INR(todaysPnL)} today
                </div>
              </div>
              <div className="pf-card pf-stat">
                <div className="l">TOTAL RETURN</div>
                <div className="v">
                  {pnlPct}
                  <span style={{ fontSize: 18 }}>%</span>
                </div>
                {/* XIRR (annualised) when computable from trade cashflows —
                    MONEY-485. Omitted (not faked) when null. */}
                {returns?.xirrPct != null ? (
                  <div
                    className={`d ${returns.xirrPct >= 0 ? "pos" : "neg"}`}
                    title="Money-weighted annualised return (XIRR)"
                  >
                    {returns.xirrPct >= 0 ? "+" : ""}
                    {returns.xirrPct.toFixed(1)}% XIRR
                  </div>
                ) : (
                  <div className={`d ${totalPnL >= 0 ? "pos" : "neg"}`}>
                    {totalPnL >= 0 ? "+" : ""}
                    {INR(totalPnL)} all-time
                  </div>
                )}
              </div>
              <div className="pf-card pf-stat">
                <div className="l">TODAY&apos;S P&amp;L</div>
                <div
                  className="v"
                  style={{
                    color: todaysPnL >= 0 ? "var(--emerald-text)" : "#b91c1c",
                  }}
                >
                  {todaysPnL >= 0 ? "+" : ""}
                  {INR(todaysPnL)}
                </div>
                <div className="d">across {brokers.length || "—"} brokers</div>
              </div>
              <div className="pf-card pf-stat tilt-r">
                <div className="l">UNREALISED</div>
                <div
                  className="v"
                  style={{
                    color: unrealised >= 0 ? "var(--emerald-text)" : "#b91c1c",
                  }}
                >
                  {unrealised >= 0 ? "+" : ""}
                  {INR(unrealised)}
                </div>
                <div className="d">open P&amp;L</div>
              </div>
            </div>

            {/* Performance + Ask Sage */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.6fr 1fr",
                gap: 18,
                marginTop: 22,
              }}
              className="dash-twocol"
            >
              <div className="pf-card" style={{ padding: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "16px 20px",
                    borderBottom: "1.5px dashed var(--rule-soft)",
                  }}
                >
                  <div>
                    <div className="ttl">PERFORMANCE · CUMULATIVE P&amp;L</div>
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 20,
                        fontWeight: 800,
                        letterSpacing: -0.5,
                      }}
                    >
                      {totalPnL >= 0 ? "+" : ""}
                      {INR(totalPnL)}{" "}
                      <span
                        className="pf-pill emerald"
                        style={{ marginLeft: 8 }}
                      >
                        {pnlPct >= 0 ? "+" : ""}
                        {pnlPct}%
                      </span>
                    </div>
                  </div>
                </div>
                <div style={{ padding: 20 }}>
                  {series.length > 1 ? (
                    <svg
                      viewBox="0 0 600 180"
                      width="100%"
                      preserveAspectRatio="none"
                      style={{ height: 180, display: "block" }}
                    >
                      <defs>
                        <linearGradient id="dashgr" x1="0" x2="0" y1="0" y2="1">
                          <stop
                            offset="0%"
                            stopColor="var(--emerald)"
                            stopOpacity="0.35"
                          />
                          <stop
                            offset="100%"
                            stopColor="var(--emerald)"
                            stopOpacity="0"
                          />
                        </linearGradient>
                      </defs>
                      <path d={chartPath.area} fill="url(#dashgr)" />
                      <path
                        d={chartPath.line}
                        fill="none"
                        stroke="var(--emerald)"
                        strokeWidth="1.8"
                      />
                    </svg>
                  ) : (
                    <div
                      style={{
                        height: 180,
                        display: "grid",
                        placeItems: "center",
                        color: "var(--ink-3)",
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: 12,
                      }}
                    >
                      Sync a broker to see your performance curve.
                    </div>
                  )}
                </div>
              </div>

              {/* Ask Sage */}
              <div
                className="pf-card tilt-r"
                style={{ padding: 0, background: "#1d1d1b", color: "#f7f3e6" }}
              >
                <div
                  style={{
                    padding: "16px 20px",
                    borderBottom: "1.5px dashed rgba(255,255,255,0.16)",
                  }}
                >
                  <div className="ttl" style={{ color: "#fcd34d" }}>
                    STOCKSAGE · ASK ANYTHING
                  </div>
                  <div
                    style={{
                      marginTop: 8,
                      fontSize: 17,
                      fontWeight: 700,
                      fontFamily: "Instrument Serif, serif",
                      fontStyle: "italic",
                      color: "#f7f3e6",
                    }}
                  >
                    Try: &ldquo;Roast my portfolio.&rdquo;
                  </div>
                </div>
                <div style={{ padding: 14 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {SAGE_CHIPS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => onAsk(s)}
                        style={{
                          padding: "5px 10px",
                          borderRadius: 999,
                          background: "rgba(255,255,255,0.06)",
                          border: "1.5px solid rgba(255,255,255,0.18)",
                          fontSize: 12,
                          color: "#f7f3e6",
                          cursor: "pointer",
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  <div
                    style={{
                      marginTop: 14,
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      padding: "8px 12px",
                      background: "rgba(255,255,255,0.05)",
                      border: "1.5px solid rgba(255,255,255,0.18)",
                      borderRadius: 9,
                    }}
                  >
                    <Sparkles size={15} className="text-[#34d399] shrink-0" />
                    <input
                      value={askValue}
                      onChange={(e) => setAskValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitAsk();
                      }}
                      placeholder="Ask StockSage anything…"
                      style={{
                        background: "transparent",
                        border: 0,
                        color: "#f7f3e6",
                        flex: 1,
                        outline: "none",
                        fontSize: 14,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Top holdings + side cards */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.6fr 1fr",
                gap: 18,
                marginTop: 18,
              }}
              className="dash-twocol"
            >
              <div className="pf-card" style={{ padding: 0 }}>
                <div className="pf-sec-h" style={{ margin: "16px 20px 4px" }}>
                  <span className="n">TOP HOLDINGS</span>
                  <h3>
                    What&apos;s <span className="ser">moving today.</span>
                  </h3>
                  <span className="rule" />
                  <Link
                    href="/holdings"
                    className="meta"
                    style={{ color: "var(--emerald-text)" }}
                  >
                    View all →
                  </Link>
                </div>
                {topHoldings.length ? (
                  <table className="pf-tbl">
                    <thead>
                      <tr>
                        <th style={{ paddingLeft: 20 }}>STOCK</th>
                        <th style={{ textAlign: "right" }}>QTY</th>
                        <th style={{ textAlign: "right" }}>LTP</th>
                        <th style={{ textAlign: "right" }}>P&amp;L</th>
                        <th>TREND</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topHoldings.map((h, i) => {
                        const pnl = h.pnl ?? h.unrealizedPnL ?? 0;
                        const up = pnl >= 0;
                        return (
                          <tr key={h.symbol ?? i}>
                            <td style={{ paddingLeft: 20 }}>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                }}
                              >
                                <span
                                  className="pf-av-sq"
                                  style={{
                                    background: brokerColor(h.broker),
                                    color: "#fff",
                                  }}
                                >
                                  {(h.symbol ?? "··").slice(0, 2)}
                                </span>
                                <div>
                                  <div className="tk">{h.symbol ?? "—"}</div>
                                  {h.name ? (
                                    <div className="nm">{h.name}</div>
                                  ) : null}
                                </div>
                              </div>
                            </td>
                            <td className="num" style={{ textAlign: "right" }}>
                              {h.quantity ?? "—"}
                            </td>
                            <td className="num" style={{ textAlign: "right" }}>
                              {INR(h.ltp ?? h.currentPrice ?? 0)}
                            </td>
                            <td
                              className={`num ${up ? "pos" : "neg"}`}
                              style={{ textAlign: "right" }}
                            >
                              {up ? "+" : ""}
                              {INR(pnl)}
                            </td>
                            <td>
                              <Sparkline up={up} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div
                    style={{
                      padding: 28,
                      textAlign: "center",
                      color: "var(--ink-3)",
                      fontSize: 13,
                    }}
                  >
                    No holdings yet —{" "}
                    <Link
                      href="/brokers"
                      style={{ color: "var(--emerald-text)" }}
                    >
                      connect a broker
                    </Link>{" "}
                    to see them here.
                  </div>
                )}
              </div>

              <div
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
                <div className="pf-card tilt-l">
                  <div className="ttl">CONNECTED BROKERS</div>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                      marginTop: 12,
                    }}
                  >
                    {brokers.length ? (
                      brokers.map((b) => (
                        <BrokerChip
                          key={b}
                          slug={toBrokerSlug(b)}
                          name={b}
                          compact
                        />
                      ))
                    ) : (
                      <Link href="/brokers" className="pf-bf sm">
                        <Plus size={12} /> Connect broker
                      </Link>
                    )}
                  </div>
                </div>

                {/* Paper Trading summary card removed 2026-05-28 per product
                    decision. PaperTradingCard component definition was deleted
                    in the cleanup pass — re-add from git history if revived. */}

                <Link
                  href="/fire"
                  className="pf-card tilt-r"
                  style={{ display: "block", background: "var(--pop-2)" }}
                >
                  <div className="ttl" style={{ color: "#1d1d1b" }}>
                    FIRE PLANNER
                  </div>
                  <div
                    style={{
                      marginTop: 8,
                      fontFamily: "Instrument Serif, serif",
                      fontStyle: "italic",
                      fontSize: 17,
                      color: "#1d1d1b",
                      lineHeight: 1.3,
                    }}
                  >
                    Map the year you can stop — on real Indian numbers.
                  </div>
                  <span
                    className="pf-bf sm"
                    style={{
                      marginTop: 12,
                      // Theme-aware: --ink (bg/border) + --paper (text) flip
                      // together, so the pill stays readable in both themes.
                      // The old hardcoded #1d1d1b bg didn't flip while --paper
                      // text did → near-black text on a dark pill in dark mode.
                      background: "var(--ink)",
                      color: "var(--paper)",
                      borderColor: "var(--ink)",
                    }}
                  >
                    <Flame size={12} /> Open FIRE
                  </span>
                </Link>

                {/* MONEY-1204 / 14d.3 — IPO card. Renders NOTHING when nothing
                    is bidding and nothing is scheduled, so it costs no space on
                    a quiet week rather than showing an empty shell. It calls the
                    SAME service as /discover/ipo, so the two surfaces cannot
                    disagree about which issues are open. */}
                <IpoDashboardCard limit={3} />
              </div>
            </div>
          </>
        )}

        {/* Full overview hub (design web-index.html): level-aware quick
            actions + browse-everything from the real sidenavConfig. The
            Beginner/Advanced toggle drives the quick tiles. */}
        <DashboardExtras variant={variant} />
      </div>

      <style>{`
        .dash-strip { grid-template-columns: repeat(4, minmax(0,1fr)); }
        @media (max-width: 1000px) {
          .dash-twocol { grid-template-columns: 1fr !important; }
          .dash-strip { grid-template-columns: repeat(2, minmax(0,1fr)); }
        }
        @media (max-width: 560px) {
          .dash-strip { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}

/* Beginner variant — fewer numbers, an oversized Sage prompt, and friendly
   next-step cards. Same real data, gentler presentation. */
function BeginnerBody({
  totalValue,
  todaysPnL,
  pnlPct,
  brokerCount,
  onAsk,
}: {
  totalValue: number;
  todaysPnL: number;
  pnlPct: number;
  brokerCount: number;
  onAsk: (q: string) => void;
}) {
  // useFeatureFlags() destructure removed — only consumed by the now-hidden
  // "Learn the basics" beginner step. Re-add { flags, isLoading: flagsLoading }
  // when re-enabling Learning.
  const bigStats = [
    { l: "YOUR PORTFOLIO", v: INR(totalValue), tone: "ink" as const },
    {
      l: "TODAY",
      v: `${todaysPnL >= 0 ? "+" : ""}${INR(todaysPnL)}`,
      tone: todaysPnL >= 0 ? ("pos" as const) : ("neg" as const),
    },
    {
      l: "TOTAL RETURN",
      v: `${pnlPct >= 0 ? "+" : ""}${pnlPct}%`,
      tone: pnlPct >= 0 ? ("pos" as const) : ("neg" as const),
    },
  ];
  // Learning hidden per request — re-enable to restore. The "Learn the
  // basics" beginner step (gated on the /learning FF) is commented out so
  // the Learning section has no entry point from the beginner dashboard.
  const steps = [
    {
      t: "Connect a broker",
      s: "Read-only · 60 seconds · see your real holdings.",
      href: "/brokers",
      cta: "Connect →",
    },
    {
      t: "Plan your FIRE",
      s: "Map the year you can retire, on Indian numbers.",
      href: "/fire",
      cta: "Open FIRE →",
    },
    /* Learning hidden per request — re-enable to restore.
    ...(!flagsLoading && flags["/learning"]
      ? [
          {
            t: "Learn the basics",
            s: "Short lessons — XIRR, SIP, diversification.",
            href: "/learning",
            cta: "Start learning →",
          },
        ]
      : []),
    */
  ];
  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0,1fr))",
          gap: 16,
        }}
        className="dash-beg-stats"
      >
        {bigStats.map((s) => (
          <div key={s.l} className="pf-card pf-stat">
            <div className="l">{s.l}</div>
            <div
              className="v"
              style={{
                fontSize: 40,
                color:
                  s.tone === "pos"
                    ? "var(--emerald-text)"
                    : s.tone === "neg"
                      ? "#b91c1c"
                      : "var(--ink)",
              }}
            >
              {s.v}
            </div>
          </div>
        ))}
      </div>

      <div
        className="pf-card tilt-r"
        style={{
          marginTop: 18,
          background: "#1d1d1b",
          color: "#f7f3e6",
          padding: 24,
        }}
      >
        <div className="ttl" style={{ color: "#fcd34d" }}>
          STOCKSAGE · YOUR AI ANALYST
        </div>
        <div
          style={{
            marginTop: 10,
            fontFamily: "Instrument Serif, serif",
            fontStyle: "italic",
            fontSize: 24,
            lineHeight: 1.25,
          }}
        >
          Don&apos;t know where to start? Just ask.
        </div>
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}
        >
          {[
            "What should a beginner buy?",
            "Explain XIRR simply",
            "Is my portfolio risky?",
          ].map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onAsk(q)}
              style={{
                padding: "8px 14px",
                borderRadius: 999,
                background: "rgba(255,255,255,0.06)",
                border: "1.5px solid rgba(255,255,255,0.2)",
                fontSize: 13,
                color: "#f7f3e6",
                cursor: "pointer",
              }}
            >
              {q}
            </button>
          ))}
        </div>
        {brokerCount === 0 ? (
          <div
            style={{
              marginTop: 14,
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 11.5,
              color: "rgba(244,237,224,0.6)",
            }}
          >
            Tip: connect a broker so StockSage can see your real holdings.
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0,1fr))",
          gap: 16,
          marginTop: 18,
        }}
        className="dash-beg-stats"
      >
        {steps.map((s) => (
          <Link
            key={s.t}
            href={s.href}
            className="pf-card"
            style={{ display: "block" }}
          >
            <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: -0.3 }}>
              {s.t}
            </div>
            <div
              style={{
                marginTop: 6,
                fontFamily: "Instrument Serif, serif",
                fontStyle: "italic",
                fontSize: 14,
                color: "var(--ink-3)",
                lineHeight: 1.4,
              }}
            >
              {s.s}
            </div>
            <span
              className="pf-bs sm"
              style={{ marginTop: 12, display: "inline-flex" }}
            >
              {s.cta}
            </span>
          </Link>
        ))}
      </div>

      <style>{`
        @media (max-width: 760px) {
          .dash-beg-stats { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </>
  );
}

/* ── Level-aware quick actions (design web-index OverviewWeb) ──────────── */
type QuickTile = {
  href: string;
  title: string;
  desc: string;
  tone?: "feat" | "warm";
};
const QUICK_BEG: QuickTile[] = [
  {
    href: "/stocksage",
    title: "Ask StockSage",
    desc: "Plain-English questions, cited answers.",
    tone: "feat",
  },
  {
    href: "/holdings",
    title: "My Holdings",
    desc: "Everything you own, one view.",
    tone: "warm",
  },
  // Learning hidden per request — re-enable to restore.
  // {
  //   href: "/learning",
  //   title: "Learn the basics",
  //   desc: "Short, NSE-flavoured courses.",
  // },
  {
    href: "/calculators",
    title: "Calculators",
    desc: "SIP, FD, lumpsum — see your future.",
  },
  {
    href: "/tax",
    title: "Tax — done",
    desc: "STCG/LTCG computed. ITR-2 ready.",
  },
  { href: "/fire", title: "FIRE plan", desc: "When can you retire? Find out." },
];
const QUICK_ADV: QuickTile[] = [
  {
    href: "/stocksage",
    title: "Ask StockSage",
    desc: "Deep dives · /thesis /dcf /peer.",
    tone: "feat",
  },
  {
    href: "/discover/screener",
    title: "Screener",
    desc: "70+ filters · save & alert.",
    tone: "warm",
  },
  {
    href: "/strategies",
    title: "Strategies",
    desc: "Build + backtest + paper run.",
  },
  { href: "/risk", title: "Risk report", desc: "Drawdown, VaR, stress test." },
  {
    href: "/roast",
    title: "Portfolio roast",
    desc: "StockSage critiques your book.",
  },
];

/**
 * Spell out small counts so the QUICK header can read naturally
 * ("Four gentle first steps." vs "4 gentle first steps."). Bounded to
 * 1-6 because QUICK_BEG only ever has up to 6 tiles. Falls back to the
 * numeric form for unexpected values — defensive only.
 */
function numberWord(n: number): string {
  switch (n) {
    case 1:
      return "One";
    case 2:
      return "Two";
    case 3:
      return "Three";
    case 4:
      return "Four";
    case 5:
      return "Five";
    case 6:
      return "Six";
    default:
      return String(n);
  }
}

/* The full overview hub: up-to-6 level-aware quick tiles + a browse-everything
   grid sourced from the real sidenavConfig so it always matches the actual
   routes. Pure navigation — no faked market/portfolio numbers.

   Beginner-mode tiles are filtered by feature flag: "Learn the basics" hides
   when /learning is off, "Tax — done" hides when /tax is off. The QUICK header
   count adjusts to match the visible tile count. Advanced-mode tiles are not
   FF-filtered today (all their destinations live behind ALWAYS_ON_ROUTES or
   the variant's intended cohort is implicitly entitled). */
function DashboardExtras({ variant }: { variant: DashVariant }) {
  const { flags, isLoading: flagsLoading, isDemoMode } = useFeatureFlags();
  const flat = sidenavConfig.flatMap((s) => s.items);
  const iconFor = (href: string) =>
    flat.find((i) => i.href === href)?.icon ?? Sparkles;

  // Filter QUICK_BEG by FF — match by exact title literal, not index, so
  // future reorders stay safe. Other tiles ("Ask Sage", "My Holdings",
  // "Calculators", "FIRE plan") always render.
  const quick =
    variant === "beginner"
      ? QUICK_BEG.filter((q) => {
          if (q.title === "Learn the basics") {
            return !flagsLoading && flags["/learning"] === true;
          }
          if (q.title === "Tax — done") {
            return !flagsLoading && flags["/tax"] === true;
          }
          return true;
        })
      : QUICK_ADV;

  return (
    <>
      {/* QUICK */}
      <div className="pf-sec-h" style={{ marginTop: 30 }}>
        <span className="n">QUICK</span>
        <h3>
          {variant === "beginner" ? (
            quick.length === 0 ? (
              <>
                Quick <span className="ser">first steps.</span>
              </>
            ) : (
              <>
                {numberWord(quick.length)} gentle{" "}
                <span className="ser">first steps.</span>
              </>
            )
          ) : (
            <>
              Five tools <span className="ser">power-users</span> live in.
            </>
          )}
        </h3>
        <span className="rule" />
        <span className="meta">{variant} mode</span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
        }}
      >
        {quick.map((q) => {
          const I = iconFor(q.href);
          const feat = q.tone === "feat";
          const warm = q.tone === "warm";
          const fg = feat ? "#f7f3e6" : warm ? "#1d1d1b" : "var(--ink)";
          return (
            <Link
              key={q.href}
              href={q.href}
              className="pf-card"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 10,
                minHeight: 124,
                color: fg,
                background: feat
                  ? "#1d1d1b"
                  : warm
                    ? "var(--pop-2)"
                    : "var(--paper)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <span
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 9,
                    display: "grid",
                    placeItems: "center",
                    border: "1.5px solid var(--ink)",
                    transform: "rotate(-3deg)",
                    background: feat ? "var(--emerald)" : "var(--ink)",
                    color: feat
                      ? "#f7f3e6"
                      : warm
                        ? "var(--pop-2)"
                        : "var(--paper)",
                  }}
                >
                  <I className="h-[18px] w-[18px]" />
                </span>
              </div>
              <div>
                <div
                  style={{ fontSize: 16, fontWeight: 800, letterSpacing: -0.4 }}
                >
                  {q.title}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    lineHeight: 1.4,
                    marginTop: 4,
                    color: feat
                      ? "rgba(247,243,230,0.72)"
                      : warm
                        ? "#3a3a35"
                        : "var(--ink-3)",
                  }}
                >
                  {q.desc}
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {/* BROWSE — everything you can do, from the real nav config.
          Items with `featureFlag` are filtered using the same rule as the
          sidebar (see Sidebar.tsx ~L805): hide while flags load AND when the
          flag is false. This keeps Learning (and any future gated nav item)
          from showing up as a promo tile here when the underlying route is
          disabled. */}
      {(() => {
        const visibleSections = sidenavConfig
          .map((section) => ({
            ...section,
            items: section.items.filter(
              (item) =>
                item.href !== "/dashboard" &&
                !(item.hideInDemo && isDemoMode) &&
                (!item.featureFlag ||
                  (!flagsLoading && flags[item.featureFlag] === true))
            ),
          }))
          .filter((section) => section.items.length > 0);
        const visibleCount = visibleSections.reduce(
          (sum, s) => sum + s.items.length,
          0
        );
        return (
          <>
            <div className="pf-sec-h" style={{ marginTop: 30 }}>
              <span className="n">BROWSE</span>
              <h3>
                Everything you can <span className="ser">actually do.</span>
              </h3>
              <span className="rule" />
              <span className="meta">{visibleCount} pages</span>
            </div>
            {visibleSections.map((section) => (
              <div key={section.label} style={{ marginBottom: 20 }}>
                <div
                  style={{
                    fontFamily: "JetBrains Mono, monospace",
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: 1.8,
                    color: "var(--ink-3)",
                    padding: "0 2px 8px",
                  }}
                >
                  {section.label}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    gap: 10,
                  }}
                >
                  {section.items.map((it) => {
                    const I = it.icon;
                    return (
                      <Link
                        key={it.href}
                        href={it.href}
                        className="pf-card flat"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: 12,
                          background: "var(--paper)",
                        }}
                      >
                        <span
                          className={`pf-navi-ic ${it.color ? "p-" + it.color : ""}`}
                          style={{
                            width: 30,
                            height: 30,
                            borderRadius: 8,
                            border: "1.5px solid var(--ink)",
                            transform: "rotate(-3deg)",
                            flexShrink: 0,
                          }}
                        >
                          <I className="h-[15px] w-[15px]" />
                        </span>
                        <span style={{ minWidth: 0 }}>
                          <span
                            style={{
                              display: "block",
                              fontSize: 13.5,
                              fontWeight: 700,
                              color: "var(--ink)",
                            }}
                          >
                            {it.label}
                          </span>
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        );
      })()}
    </>
  );
}

// PaperTradingCard removed 2026-05-28 — Paper Trading card was hidden from the
// dashboard right-column in the prior pass; the component definition was
// retained as a dangling orphan and is now deleted. Restore from git history
// if Paper Trading is re-promoted to the dashboard surface.

// Build SVG area + line paths from a numeric series, normalised to 0..600 x
// 10..170 y (inverted, since SVG y grows downward).
function buildAreaPath(series: number[]): { line: string; area: string } {
  if (series.length < 2) return { line: "", area: "" };
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const stepX = 600 / (series.length - 1);
  const pts = series.map((v, i) => {
    const x = Math.round(i * stepX);
    const y = Math.round(170 - ((v - min) / range) * 160);
    return [x, y] as const;
  });
  const line = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`)
    .join(" ");
  const area = `${line} L600,180 L0,180 Z`;
  return { line, area };
}
