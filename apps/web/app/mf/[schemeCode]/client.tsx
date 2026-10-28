"use client";

/**
 * Mutual Fund Detail Client Component — Playful re-skin (MONEY-485)
 *
 * Renders:
 * - Fund name, NAV, AMC
 * - NAV history chart (FundChartCard — emerald area vs benchmark)
 * - Key stats grid (FundKeyStatsGrid)
 * - SIP calculator
 * - About this fund
 * - Portfolio: the AMC's own monthly disclosure (MfPortfolioTab), with the
 *   AI/Kuvera reading + sector/cap donuts (FundCompositionSection) shown only
 *   when no such disclosure exists — see the `disclosure` note in the body.
 *
 * Only the page chrome (hero header, section labels, action buttons) is
 * re-skinned to the playful `pf-*` system; the chart + stats + holdings
 * components and all data wiring are untouched. NAV history is fetched from
 * /api/market/mf-historical (MFAPI.in-backed) for the period-change badge.
 */

import { useState, useEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { DemoBanner } from "@/components/DemoBanner";

import { PageGuard } from "@/components/PageGuard";
import { StockDetailSkeleton } from "@/components/skeletons";
import { TerminalLuxeShell } from "@/components/terminal-luxe/Shell";
import { BarChart2, GitCompare, Calculator, Sparkles } from "lucide-react";
import FundCompositionSection from "@/components/FundCompositionSection";
// MONEY-1204 / 14d.1 — the AMC's own SEBI-mandated monthly disclosure.
import { MfPortfolioTab } from "@/components/mf/MfPortfolioTab";
import { getMfPortfolioSectionAction } from "@/lib/actions/mf-portfolio-section";
import ResearchModal from "@/components/analysis/ResearchModal";
import { getOrGenerateMfDescriptionAction } from "@/lib/actions/mf-description";
import { WatchlistPopover } from "@/components/watchlist/WatchlistPopover";
import { SipCalculator } from "@/components/mf/SipCalculator";
import { FundChartCard } from "@/components/mf/FundChartCard";
import {
  FundKeyStatsGrid,
  type FundStatsHistory,
} from "@/components/mf/FundKeyStatsGrid";
import { FundAboutCard } from "@/components/mf/FundAboutCard";
import BrokerReauthBanner from "@/components/BrokerReauthBanner";
import { useBrokerStatus } from "@/hooks/useBrokerStatus";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

// ============== TYPES ==============

interface MfDetailClientProps {
  schemeCode: string;
  schemeName: string;
  amcName: string;
  category: string;
  subCategory: string | null;
  plan: string | null;
  nav: number;
  navDate: Date;
  aum: number | null;
  returns1Y: number | null;
  returns3Y: number | null;
  returns5Y: number | null;
  expenseRatio: number | null;
  riskLevel: string | null;
  fundManager: string | null;
  crisilRating: string | null;
  volatility: string | null;
  returnsInception: number | null;
  fundType: string | null;
  description: string | null;
  /**
   * MONEY-1205 — NAV-derived numbers, computed on the SERVER by
   * `getFundNavDerivatives` (packages/services). They used to be two `useMemo`s
   * in this file with a hand-rolled anchor search, no minimum-observation floor
   * and no way to say WHY a value was missing, which `/etf/[symbol]` could not
   * reach at all — so the same fund showed a 52-week range on one route and a
   * bare "-" on the other.
   */
  navHigh: number | null;
  navLow: number | null;
  navReturns3Y: number | null;
  navReturns5Y: number | null;
  /** Distinguishes "history not loaded" from "fund younger than the window". */
  navStats: FundStatsHistory | null;
}

interface NavChartPoint {
  time: string; // YYYY-MM-DD
  value: number;
}

// ============== HELPERS ==============

function formatNav(nav: number): string {
  return nav.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatAum(aum: number | null): string {
  if (!aum) return "—";
  if (aum >= 10000) return `₹${(aum / 10000).toFixed(1)}L Cr`;
  if (aum >= 100) return `₹${aum.toFixed(0)} Cr`;
  return `₹${aum.toFixed(2)} Cr`;
}

// ============== DEMO NAV DATA ==============

function generateDemoNavHistory(): NavChartPoint[] {
  const points: NavChartPoint[] = [];
  let navVal = 45;
  const now = new Date();
  for (let i = 365 * 3; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const change = (Math.random() - 0.47) * 0.8;
    navVal = Math.max(30, Math.min(100, navVal + change));
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    points.push({ time: dateStr, value: parseFloat(navVal.toFixed(4)) });
  }
  return points;
}

// ============== COMPONENT ==============

export default function MfDetailClient({
  schemeCode,
  schemeName,
  amcName,
  category,
  subCategory,
  plan,
  nav,
  navDate,
  aum,
  returns1Y,
  returns3Y,
  returns5Y,
  expenseRatio,
  riskLevel,
  fundManager,
  crisilRating,
  returnsInception,
  description,
  navHigh,
  navLow,
  navReturns3Y,
  navReturns5Y,
  navStats,
}: MfDetailClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromPage = searchParams?.get("from");
  // MONEY-1137: demo state must not survive a real sign-in. `user` is null
  // for a signed-out demo visitor, so demo browsing of /mf/[schemeCode] is
  // unaffected; a signed-in user with a stale flag stops seeing demo data.
  const { user } = useUser();
  const isDemoMode = useIsDemoMode({ user });
  const [navHistory, setNavHistory] = useState<NavChartPoint[]>([]);
  const [isLoadingNav, setIsLoadingNav] = useState(true);

  // Broker status for the reauth banner at the top of the page.
  const { brokerStatus: brokerInfo } = useBrokerStatus();

  const [desc, setDesc] = useState<string | null>(description);
  const [descLoading, setDescLoading] = useState(false);

  // MONEY-446 — StockSage MF deep dive. The picker is lazy-mounted only
  // when opened so its preference hooks (which fire server actions on
  // mount) don't run on every fund detail page load.
  const [researchOpen, setResearchOpen] = useState(false);

  // ── MONEY-1204 / 14d.1 — which holdings panel(s) this page shows ─────────
  //
  // `MfPortfolioTab` reads the AMC's own SEBI-mandated monthly disclosure and
  // is the authoritative panel; `FundCompositionSection` is the AI/Kuvera
  // reading this lane was written to DEMOTE. It is demoted, not deleted:
  //
  //   - It is the only surface that TRIGGERS the Gemini extraction which
  //     writes `FundHolding` — the very table `getMfPortfolioSection` falls
  //     back to. Deleting it would slowly starve the fallback it feeds.
  //   - It carries the sector and market-cap donuts, which the AMC disclosure
  //     does not provide at all.
  //
  // So the rule is: hide it ONLY when the AMC's own disclosure is present,
  // because that is the one case where two tables on one screen would show
  // DIFFERENT numbers for the same fund. When the section is on its fallback
  // both panels read the same `FundHolding` rows and cannot disagree, and when
  // the section is empty the composition panel is the only route to any data.
  //
  // COST, stated plainly: this repeats the child's own call. The action is
  // cache-first in `@usemoney/services` so the second call is a cache hit, but
  // the clean fix is an `onResolved` callback on MfPortfolioTab mirroring
  // `StockDerivativesTab.onFnoResolved` — deliberately not folded into this
  // wiring pass.
  const [disclosure, setDisclosure] = useState<
    "unknown" | "official" | "no-official"
  >("unknown");

  useEffect(() => {
    let cancelled = false;
    setDisclosure("unknown");
    getMfPortfolioSectionAction({ schemeCode })
      .then((r) => {
        if (cancelled) return;
        // A failed read is NOT evidence that an official disclosure exists, and
        // "no-official" is the branch that shows the reader MORE — which is
        // also the pre-change behaviour of this page. Distinct from "unknown",
        // which is strictly the pre-answer state.
        if (!r.success) {
          setDisclosure("no-official");
          return;
        }
        setDisclosure(
          r.data.empty || r.data.fallback ? "no-official" : "official"
        );
      })
      .catch(() => {
        if (!cancelled) setDisclosure("no-official");
      });
    return () => {
      cancelled = true;
    };
  }, [schemeCode]);

  useEffect(() => {
    if (desc !== null) return;
    if (isDemoMode) {
      setDesc(
        "A well-managed fund with a diversified portfolio offering consistent returns across market cycles."
      );
      return;
    }
    let cancelled = false;
    setDescLoading(true);
    getOrGenerateMfDescriptionAction(schemeCode).then((res) => {
      if (cancelled) return;
      if (res?.success && res.description) {
        setDesc(res.description);
      }
      setDescLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [desc, schemeCode, isDemoMode]);

  // Fetch NAV history from our API (backed by MFAPI.in with DB caching).
  // Drives the headline NAV-change badge; the chart owns its own fetch.
  useEffect(() => {
    if (isDemoMode) {
      setNavHistory(generateDemoNavHistory());
      setIsLoadingNav(false);
      return;
    }

    async function fetchNavHistory() {
      setIsLoadingNav(true);
      try {
        const response = await fetch(
          `/api/market/mf-historical?schemeCode=${schemeCode}&period=max`
        );
        if (!response.ok) throw new Error("Failed to fetch NAV history");

        const result = await response.json();
        if (result?.data && Array.isArray(result?.data)) {
          const points: NavChartPoint[] = result?.data
            .map((d: { date: string; nav: number }) => {
              if (!d.date || isNaN(d.nav)) return null;
              return { time: d.date, value: d.nav };
            })
            .filter(Boolean) as NavChartPoint[];

          setNavHistory(points);
        }
      } catch (error) {
        console.error("Failed to fetch NAV history:", error);
        setNavHistory([]);
      } finally {
        setIsLoadingNav(false);
      }
    }

    fetchNavHistory();
  }, [schemeCode, isDemoMode]);

  // Headline 1Y change for the NAV badge (closest point ~1 year ago).
  const headlineChange = useMemo(() => {
    if (navHistory.length < 2) return null;
    const last = navHistory[navHistory.length - 1].value;
    const now = new Date();
    const target = new Date(now);
    target.setFullYear(target.getFullYear() - 1);
    let closest: NavChartPoint | null = null;
    let closestDiff = Infinity;
    for (const p of navHistory) {
      const diff = Math.abs(new Date(p.time).getTime() - target.getTime());
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = p;
      }
    }
    if (!closest || closestDiff > 45 * 24 * 60 * 60 * 1000) return null;
    const first = closest.value;
    return { percent: ((last - first) / first) * 100, span: "1Y" };
  }, [navHistory]);

  // MONEY-1205 — the 52-week range and the 1/3/5-year returns used to be two
  // `useMemo`s here, re-derived from the chart's own fetch. They are now
  // computed once on the SERVER (`getFundNavDerivatives` -> `navHigh`,
  // `navLow`, `navReturns3Y/5Y`, `navStats`) so `/etf/[symbol]` renders the
  // same numbers for the same fund, and so a missing value can say WHICH kind
  // of missing it is. `returns1Y` is surfaced through the chart/stats
  // components downstream.
  void returns1Y;
  const effective3Y = returns3Y ?? navReturns3Y;
  const effective5Y = returns5Y ?? navReturns5Y;

  const isPositive = (headlineChange?.percent ?? 0) >= 0;

  const handleBack = () => {
    if (fromPage) {
      router.push(fromPage);
    } else {
      router.back();
    }
  };

  const riskTone = (() => {
    const r = (riskLevel ?? "").toLowerCase();
    if (r.includes("very high")) return "var(--pop-1)";
    if (r.includes("high") || r.includes("moderat")) return "var(--pop-2)";
    return "var(--emerald)";
  })();

  const initials = amcName.slice(0, 2).toUpperCase();

  return (
    <PageGuard
      route="/discover"
      fallback={<StockDetailSkeleton />}
      containerClassName="p-6 pb-44"
    >
      <TerminalLuxeShell
        active="markets"
        title={
          schemeName.length > 42 ? `${schemeName.slice(0, 42)}…` : schemeName
        }
        breadcrumb={`FUND · /mf/${schemeCode}`}
        onBack={handleBack}
      >
        {isDemoMode && <DemoBanner />}

        {/* Broker reauth banner — data-source notice up top. */}
        {brokerInfo.status === "needs_reauth" &&
          brokerInfo.reauthUrl &&
          brokerInfo.brokerDisplayName && (
            <BrokerReauthBanner
              brokerName={brokerInfo.brokerDisplayName}
              reauthUrl={brokerInfo.reauthUrl}
              className="mb-4"
            />
          )}

        {/* ── Hero header (design: FundDetailScreen pf-ph) ── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto",
            gap: 20,
            alignItems: "center",
            paddingBottom: 16,
            borderBottom: "2px solid var(--ink)",
            marginBottom: 22,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              minWidth: 0,
            }}
          >
            <div
              className="pf-av-sq"
              style={{
                background: "var(--pop-3)",
                color: "var(--paper)",
                width: 52,
                height: 52,
                fontSize: 16,
                borderRadius: 12,
                boxShadow: "var(--shadow-soft)",
                flexShrink: 0,
              }}
            >
              {initials}
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 6,
                  flexWrap: "wrap",
                }}
              >
                <span
                  className="pf-pill"
                  style={{
                    background: "var(--pop-3)",
                    color: "var(--paper)",
                    borderColor: "var(--pop-3)",
                    fontSize: 10,
                  }}
                >
                  {category || "Fund"}
                </span>
                {crisilRating && (
                  <span className="pf-pill emerald" style={{ fontSize: 10 }}>
                    {crisilRating} CRISIL
                  </span>
                )}
                {plan && (
                  <span className="pf-pill outline" style={{ fontSize: 10 }}>
                    {plan === "DIRECT" ? "DIRECT" : "REGULAR"}
                  </span>
                )}
                {riskLevel && (
                  <span
                    className="pf-pill"
                    style={{
                      background: riskTone,
                      color: "var(--paper)",
                      borderColor: riskTone,
                      fontSize: 10,
                    }}
                  >
                    RISK · {riskLevel.toUpperCase()}
                  </span>
                )}
              </div>
              <h1
                style={{
                  fontSize: 30,
                  fontWeight: 800,
                  letterSpacing: -1.2,
                  lineHeight: 1.05,
                  color: "var(--ink)",
                }}
              >
                {schemeName}
              </h1>
              <div
                style={{
                  marginTop: 4,
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 11.5,
                  color: "var(--ink-3)",
                }}
              >
                {amcName}
                {fundManager ? ` · Mgr ${fundManager}` : ""} · Scheme{" "}
                {schemeCode}
                {aum != null ? ` · AUM ${formatAum(aum)}` : ""}
              </div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 10,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                fontWeight: 700,
                color: "var(--ink-3)",
              }}
            >
              NAV ·{" "}
              {new Date(navDate).toLocaleDateString("en-IN", {
                day: "2-digit",
                month: "short",
              })}
            </div>
            <div
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 32,
                fontWeight: 800,
                color: "var(--ink)",
                letterSpacing: -1,
                marginTop: 2,
              }}
            >
              ₹{formatNav(nav)}
            </div>
            {isLoadingNav ? (
              <div
                className="animate-pulse"
                style={{
                  height: 14,
                  width: 110,
                  background: "var(--rule-soft)",
                  borderRadius: 4,
                  marginTop: 8,
                  marginLeft: "auto",
                }}
              />
            ) : headlineChange ? (
              <div
                style={{
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 12,
                  color: isPositive ? "var(--emerald)" : "var(--pop-1)",
                  fontWeight: 700,
                  marginTop: 4,
                }}
              >
                {isPositive ? "+" : ""}
                {headlineChange.percent.toFixed(2)}% · {headlineChange.span}
              </div>
            ) : null}
            <div
              style={{
                marginTop: 10,
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                flexWrap: "wrap",
              }}
            >
              <WatchlistPopover
                target={{ symbol: schemeCode, exchange: "MF", kind: "MF" }}
              />
              {/* MONEY-446: StockSage — single-fund deep dive. Opens the
                  ResearchModal in MF mode (forces `mf-analysis` skill +
                  `mf_analysis` credit estimate) and routes to
                  /analysis/[sessionId], the same surface as stock research. */}
              <button
                type="button"
                className="pf-bf sm"
                onClick={() => setResearchOpen(true)}
              >
                <Sparkles size={11} /> StockSage
              </button>
              <Link
                href={`/compare?items=${encodeURIComponent(`MF:${schemeCode}`)}`}
              >
                <button type="button" className="pf-bf sm">
                  <GitCompare size={11} /> Compare
                </button>
              </Link>
              <a href="#sip-calculator">
                <button type="button" className="pf-bs sm">
                  <Calculator size={11} /> Start SIP →
                </button>
              </a>
            </div>
          </div>
        </div>

        {/* ── NAV chart — Native emerald area + benchmark (FundChartCard).
            Component owns its own period tabs + fetch; only the demo
            placeholder chrome is restyled. ── */}
        {isDemoMode ? (
          <div
            className="pf-card"
            style={{ padding: 0, overflow: "hidden", marginBottom: 24 }}
          >
            <div
              className="flex items-center justify-center text-center"
              style={{ height: 400 }}
            >
              <div style={{ maxWidth: 360, padding: "0 24px" }}>
                <BarChart2
                  style={{
                    width: 40,
                    height: 40,
                    color: "var(--ink-4)",
                    margin: "0 auto 12px",
                  }}
                />
                <h3
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: "var(--ink-2)",
                    marginBottom: 4,
                  }}
                >
                  Charts disabled in demo mode
                </h3>
                <p
                  style={{
                    fontSize: 13.5,
                    color: "var(--ink-3)",
                    marginBottom: 16,
                  }}
                >
                  Sign up to view live NAV charts with technical indicators.
                </p>
                <Link href="/sign-up">
                  <button type="button" className="pf-bs sm">
                    Create free account
                  </button>
                </Link>
              </div>
            </div>
          </div>
        ) : (
          <div id="chart" className="mb-6">
            <FundChartCard
              schemeCode={schemeCode}
              schemeName={schemeName}
              benchmarkName="Nifty 50 TRI"
              initialPeriod="3Y"
            />
          </div>
        )}

        {/* ── Key stats grid (design: KEY METRICS) ── */}
        <div className="pf-sec-h">
          <span className="n">METRICS</span>
          <h3>
            Key <span className="ser">numbers.</span>
          </h3>
          <span className="rule" />
        </div>
        <div className="mb-6">
          <FundKeyStatsGrid
            aum={aum}
            expenseRatio={expenseRatio}
            returns3Y={effective3Y}
            returns5Y={effective5Y}
            returnsInception={returnsInception}
            navHigh={navHigh}
            navLow={navLow}
            history={navStats}
            benchmarkName={null}
          />
        </div>

        {/* ── Embedded SIP Calculator ── */}
        <div id="sip-calculator" className="scroll-mt-24 mb-6">
          <SipCalculator defaultAnnualReturn={returns5Y ?? returns3Y ?? null} />
        </div>

        {/* ── About this fund ── */}
        <div className="pf-sec-h">
          <span className="n">ABOUT</span>
          <h3>
            About this <span className="ser">fund.</span>
          </h3>
          <span className="rule" />
        </div>
        <div className="mb-6">
          <FundAboutCard
            description={desc}
            descriptionLoading={descLoading}
            subCategory={subCategory}
            fundManager={fundManager}
            amcName={amcName}
            launchDate={null}
            exitLoad={null}
            benchmarkName={null}
          />
        </div>

        {/* ── Top-10 holdings + sector + cap mix (design: HOLDINGS) ── */}
        <div className="pf-sec-h">
          <span className="n">HOLDINGS</span>
          <h3>
            Top <span className="ser">holdings.</span>
          </h3>
          <span className="rule" />
          <span className="meta">portfolio composition</span>
        </div>

        {/* MONEY-1204 / 14d.1 — the AMC's own monthly disclosure, always
            mounted. It owns its empty state and its provenance chip, so a
            scheme with nothing published says so rather than rendering
            silence. */}
        <div className="mb-6">
          <MfPortfolioTab schemeCode={schemeCode} schemeName={schemeName} />
        </div>

        {/* Sector + market-cap donuts — MONEY-1405 D4.
            Mounted for BOTH disclosure states now. The reason the old
            `no-official` gate existed — never two tables of different numbers
            for one fund — is preserved one layer down rather than abandoned:
            `FundCompositionSection` suppresses its OWN holdings table when the
            composition came from the disclosure, because `MfPortfolioTab` above
            is already rendering those exact rows, with the MoM diff this
            snapshot cannot produce. What is left is the sector and market-cap
            donuts, which the disclosure does not carry and which are now
            derived from it rather than recalled by a model. Still hidden while
            UNKNOWN: an appearing panel is an ordinary progressive load, a
            disappearing one moves the page under a reader already in it. */}
        {disclosure !== "unknown" && (
          <FundCompositionSection
            fundType="MF"
            fundId={schemeCode}
            schemeCode={schemeCode}
            hasOfficialDisclosure={disclosure === "official"}
          />
        )}
      </TerminalLuxeShell>

      {/* Keyframes for FundCompositionSection's loading bar animation. */}
      <style>{`
        @keyframes sectionLoadingBar {
          0% { width: 0%; margin-left: 0; }
          50% { width: 70%; margin-left: 15%; }
          100% { width: 0%; margin-left: 100%; }
        }
      `}</style>

      {/* MONEY-446: StockSage MF deep dive picker. Lazy-mounted (see the
          researchOpen state above) so its preference hooks don't fire on
          every detail page load. type: "mf" forces the `mf-analysis` skill
          + `mf_analysis` credit estimate and routes to /analysis/[id]. */}
      {researchOpen && (
        <ResearchModal
          open={researchOpen}
          onOpenChange={setResearchOpen}
          entity={{
            symbol: schemeCode,
            name: schemeName,
            type: "mf",
          }}
        />
      )}
    </PageGuard>
  );
}
