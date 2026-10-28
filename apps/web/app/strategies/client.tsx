"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import Sidebar from "@/components/Sidebar";

import { PageGuard } from "@/components/PageGuard";
import {
  StrategiesSkeleton,
  StrategiesHeaderRightSkeleton,
} from "@/components/skeletons";
import { DemoBanner, DemoGate } from "@/components/DemoBanner";
import { Textarea } from "@usemoney/ui/textarea";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { toast } from "sonner";
import {
  Zap,
  ArrowRight,
  Sparkles,
  Loader2,
  Clock,
  Target,
  BarChart3,
  Search,
  type LucideIcon,
} from "lucide-react";
import { generateStrategyAction } from "@/lib/actions/strategy";
import {
  getStrategiesStatsAction,
  type StrategyStatsMap,
} from "@/lib/actions/strategy-stats";
import {
  STRATEGIES,
  STRATEGY_TABS,
  type StrategyMeta,
  type StrategyCategory,
} from "./strategies-data";
import { BuildCustomBody } from "./build/client";
import { CreateAIBody } from "./create/client";
import { DetailBody } from "./[id]/client";
import { BacktestBody } from "./[id]/backtest/client";
import { ForwardBody } from "./[id]/forward/client";
import { getDefaultBasket } from "./strategy-baskets";
import { useSearchParams } from "next/navigation";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

// Risk → playful pop accent for the AI-generated risk badge.
const RISK_PILL: Record<string, string> = {
  Low: "emerald",
  Medium: "gold",
  High: "coral",
  "Very High": "coral",
};

// Strategy catalog imported from ./strategies-data - shared with detail page.
type StrategyUniverse = "NIFTY 50" | "NIFTY 500" | "Sector";
type StrategySort = "CAGR" | "Sharpe" | "1Y";
// Primary tabs in the design row above the strategy grid
type PrimaryTab =
  | "catalog"
  | "detail"
  | "backtest"
  | "forward"
  | "build"
  | "create-ai";

// Playful pop-accent per strategy category (used on catalog card pills).
const CATEGORY_POP: Record<StrategyCategory, string> = {
  Trend: "blue",
  Momentum: "emerald",
  Value: "gold",
  Quality: "blue",
  "Mean-reversion": "violet",
  Pattern: "coral",
  Custom: "pink",
};

function StrategySparkline({ data }: { data: number[] }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 280;
  const h = 40;
  const pts = data
    .map(
      (v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`
    )
    .join(" ");
  const gradId = "um-strat-spark";
  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="block"
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--emerald)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--emerald)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill={`url(#${gradId})`} />
      <polyline
        points={pts}
        fill="none"
        stroke="var(--emerald)"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface GeneratedStrategy {
  name: string;
  description: string;
  type: string;
  risk: string;
  timeframe: string;
  rules: { entry: string; exit: string; stopLoss: string };
  params?: Record<string, unknown>;
  overlays?: string[];
}

export default function StrategiesClient() {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const { flags } = useFeatureFlags();
  const paperTradingEnabled = flags["/paper-trading"];
  const [mounted, setMounted] = useState(false);
  const [strategyPrompt, setStrategyPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedStrategy, setGeneratedStrategy] =
    useState<GeneratedStrategy | null>(null);
  // MONEY-203 design - full picker state
  const [primaryTab, setPrimaryTab] = useState<PrimaryTab>("catalog");
  const [activeStrategy, setActiveStrategy] = useState<StrategyMeta | null>(
    null
  );
  const [activeBasket, setActiveBasket] = useState<string[]>([]);
  const [autoRunBacktest, setAutoRunBacktest] = useState(false);
  const [autoRunForward, setAutoRunForward] = useState(false);

  // Wire ?tab=...&id=... so deep links land on the right tab.
  const searchParams = useSearchParams();
  useEffect(() => {
    const tab = searchParams.get("tab") as PrimaryTab | null;
    const id = searchParams.get("id");
    if (id) {
      const s = STRATEGIES.find((x) => x.id === id);
      if (s) {
        setActiveStrategy(s);
        setActiveBasket(getDefaultBasket(s.id));
      }
    }
    if (tab) setPrimaryTab(tab);
  }, [searchParams]);

  const selectStrategy = (s: StrategyMeta, tab: PrimaryTab = "detail") => {
    setActiveStrategy(s);
    setActiveBasket(getDefaultBasket(s.id));
    setPrimaryTab(tab);
    if (typeof window !== "undefined")
      window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const goToTab = (
    tab: PrimaryTab,
    autoRun: "backtest" | "forward" | null = null
  ) => {
    setPrimaryTab(tab);
    setAutoRunBacktest(autoRun === "backtest");
    setAutoRunForward(autoRun === "forward");
    if (typeof window !== "undefined")
      window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const [activeCategory, setActiveCategory] =
    useState<(typeof STRATEGY_TABS)[number]>("All");
  const [universe, setUniverse] = useState<StrategyUniverse>("NIFTY 500");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<StrategySort>("CAGR");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Live worker-computed stats by strategy id.
  const [liveStats, setLiveStats] = useState<StrategyStatsMap>({});
  useEffect(() => {
    let cancelled = false;
    getStrategiesStatsAction()
      .then((r) => {
        if (!cancelled && r?.success && r.data) setLiveStats(r.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const parsePct = (s: string): number =>
    parseFloat(s.replace(/[^\d.\-+]/g, "")) || 0;

  const visibleStrategies = useMemo(() => {
    let list =
      activeCategory === "All"
        ? STRATEGIES
        : STRATEGIES.filter((s) => s.category === activeCategory);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q)
      );
    }
    const sorted = [...list].sort((a, b) => {
      const va =
        sortBy === "CAGR"
          ? parsePct(a.cagr)
          : sortBy === "Sharpe"
            ? parseFloat(a.sharpe)
            : parsePct(a.return1Y);
      const vb =
        sortBy === "CAGR"
          ? parsePct(b.cagr)
          : sortBy === "Sharpe"
            ? parseFloat(b.sharpe)
            : parsePct(b.return1Y);
      return sortDir === "asc" ? va - vb : vb - va;
    });
    return sorted;
  }, [activeCategory, search, sortBy, sortDir]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDemoMode = useIsDemoMode({ user });

  useEffect(() => {
    if (!isLoaded || !mounted) return;
    if (!user && !isDemoMode) {
      router.push("/home");
    }
  }, [isLoaded, mounted, user, isDemoMode, router]);

  const handleGenerate = async () => {
    if (!strategyPrompt.trim()) {
      toast.error("Please describe your strategy idea");
      return;
    }

    setIsGenerating(true);
    setGeneratedStrategy(null);
    try {
      const result = await generateStrategyAction(strategyPrompt.trim());
      if (result?.success && result?.data) {
        setGeneratedStrategy(result?.data);
        toast.success("Strategy generated!");
      } else {
        toast.error(result?.error || "Failed to generate strategy");
      }
    } catch {
      toast.error("Failed to generate strategy");
    } finally {
      setIsGenerating(false);
    }
  };

  const isAiTab = primaryTab === "create-ai";

  return (
    <PageGuard
      route="/strategies"
      fallback={<StrategiesSkeleton />}
      headerRight={<StrategiesHeaderRightSkeleton />}
      containerClassName="px-4 lg:px-6 pt-4 lg:pt-6 pb-24 space-y-6 max-w-[1600px] mx-auto"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="pf-page">
            {isDemoMode && <DemoBanner />}

            {/* Header - playful pf-ph with Build custom + Create with AI */}
            <PfPageHead
              eyebrow="RESEARCH · STRATEGIES"
              title={
                <>
                  Strategies that <span className="ser">earn</span>{" "}
                  <span className="hl">their keep.</span>
                </>
              }
              sub="Backtested on 8 years of NSE data — fork, run, or paper-trade any of them."
              right={
                <>
                  <button
                    type="button"
                    onClick={() => setPrimaryTab("build")}
                    className="pf-bf"
                  >
                    <Target className="h-3.5 w-3.5" /> Build custom
                  </button>
                  <button
                    type="button"
                    onClick={() => setPrimaryTab("create-ai")}
                    className="pf-bs"
                  >
                    <Sparkles className="h-3.5 w-3.5" /> Create with AI
                  </button>
                </>
              }
            />

            {/* Primary tab row - all 6 tabs swap inline. Detail/Backtest/
                  Forward require an activeStrategy; the catalog auto-picks
                  the first visible card if none is selected. */}
            <div
              style={{
                display: "flex",
                gap: 4,
                flexWrap: "wrap",
                borderBottom: "2px solid var(--ink)",
                marginBottom: 20,
              }}
            >
              {(() => {
                const items: Array<{
                  id: PrimaryTab;
                  label: string;
                  Icon: LucideIcon;
                }> = [
                  { id: "catalog", label: "Catalog", Icon: BarChart3 },
                  { id: "detail", label: "Detail", Icon: Search },
                  { id: "backtest", label: "Backtest", Icon: Zap },
                  { id: "forward", label: "Forward", Icon: ArrowRight },
                  { id: "build", label: "Build custom", Icon: Target },
                  { id: "create-ai", label: "Create AI", Icon: Sparkles },
                ];
                return items.map((t) => {
                  const active = primaryTab === t.id;
                  const needsStrategy =
                    t.id === "detail" ||
                    t.id === "backtest" ||
                    t.id === "forward";
                  return (
                    <button
                      key={t.id}
                      onClick={() => {
                        if (needsStrategy && !activeStrategy) {
                          const fallback =
                            visibleStrategies[0] ?? STRATEGIES[0];
                          if (fallback) selectStrategy(fallback, t.id);
                        } else {
                          goToTab(t.id);
                        }
                      }}
                      style={{
                        position: "relative",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "10px 14px",
                        fontFamily: "JetBrains Mono, monospace",
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: 0.3,
                        color: active ? "var(--ink)" : "var(--ink-3)",
                        background: "transparent",
                        border: 0,
                        cursor: "pointer",
                      }}
                    >
                      <t.Icon className="h-3.5 w-3.5" /> {t.label}
                      {active && (
                        <span
                          style={{
                            position: "absolute",
                            bottom: -2,
                            left: 0,
                            right: 0,
                            height: 3,
                            background: "var(--emerald)",
                            borderRadius: "3px 3px 0 0",
                          }}
                        />
                      )}
                    </button>
                  );
                });
              })()}
            </div>

            {/* Inline Detail / Backtest / Forward - everything in the
                  same window. The /strategies/[id]/* routes still exist for
                  direct deep links. */}
            {primaryTab === "detail" && activeStrategy && (
              <DetailBody
                strategy={activeStrategy}
                basket={activeBasket}
                onBasketChange={setActiveBasket}
                onRunBacktest={() => goToTab("backtest", "backtest")}
                onForwardPredict={() => goToTab("forward", "forward")}
              />
            )}
            {primaryTab === "backtest" && activeStrategy && (
              <BacktestBody
                strategy={activeStrategy}
                basket={activeBasket}
                autoRun={autoRunBacktest}
              />
            )}
            {primaryTab === "forward" && activeStrategy && (
              <ForwardBody
                strategy={activeStrategy}
                basket={activeBasket}
                autoRun={autoRunForward}
              />
            )}

            {/* Embedded Build Custom + Create with AI bodies. */}
            {primaryTab === "build" && <BuildCustomBody />}

            {/* Create with AI - playful re-skin around the existing
                  Gemini generateStrategyAction. */}
            {isAiTab && (
              <DemoGate
                isDemoMode={isDemoMode}
                message="Sign up to generate AI strategies"
              >
                <div
                  className="strat-ai-grid"
                  style={{ display: "grid", gap: 18 }}
                >
                  {/* Input */}
                  <div className="pf-card" style={{ padding: 0 }}>
                    <div
                      style={{
                        padding: "14px 20px",
                        borderBottom: "1.5px dashed var(--rule-soft)",
                      }}
                    >
                      <div className="ttl">
                        STOCKSAGE · DESCRIBE YOUR STRATEGY
                      </div>
                      <div
                        style={{
                          marginTop: 6,
                          fontFamily: "Instrument Serif, serif",
                          fontStyle: "italic",
                          fontSize: 16,
                          color: "var(--ink-3)",
                        }}
                      >
                        Plain English in, a structured strategy out.
                      </div>
                    </div>
                    <div style={{ padding: 20 }}>
                      <Textarea
                        placeholder="e.g., I want a momentum strategy that buys stocks breaking 52-week highs with strong volume and sells when momentum fades..."
                        value={strategyPrompt}
                        onChange={(e) => setStrategyPrompt(e.target.value)}
                        className="pf-input"
                        style={{ minHeight: 150, resize: "vertical" }}
                      />
                      <button
                        type="button"
                        onClick={handleGenerate}
                        disabled={isGenerating || !strategyPrompt.trim()}
                        className="pf-bs"
                        style={{
                          width: "100%",
                          justifyContent: "center",
                          marginTop: 14,
                          opacity:
                            isGenerating || !strategyPrompt.trim() ? 0.55 : 1,
                          cursor:
                            isGenerating || !strategyPrompt.trim()
                              ? "not-allowed"
                              : "pointer",
                        }}
                      >
                        {isGenerating ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Generating…
                          </>
                        ) : (
                          <>
                            <Sparkles className="h-4 w-4" />
                            Generate strategy
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Output */}
                  {generatedStrategy ? (
                    <div className="pf-card tilt-r" style={{ padding: 0 }}>
                      <div
                        style={{
                          padding: "14px 20px",
                          borderBottom: "1.5px dashed var(--rule-soft)",
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          gap: 12,
                        }}
                      >
                        <div>
                          <div
                            style={{
                              fontSize: 18,
                              fontWeight: 800,
                              letterSpacing: -0.3,
                            }}
                          >
                            {generatedStrategy.name}
                          </div>
                          <div
                            style={{
                              marginTop: 6,
                              fontFamily: "Instrument Serif, serif",
                              fontStyle: "italic",
                              fontSize: 14,
                              color: "var(--ink-3)",
                              lineHeight: 1.35,
                            }}
                          >
                            {generatedStrategy.description}
                          </div>
                        </div>
                        <span
                          className={`pf-pill ${
                            RISK_PILL[generatedStrategy.risk] ?? "outline"
                          }`}
                          style={{ flexShrink: 0 }}
                        >
                          {generatedStrategy.risk}
                        </span>
                      </div>
                      <div
                        style={{
                          padding: 20,
                          display: "flex",
                          flexDirection: "column",
                          gap: 14,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            flexWrap: "wrap",
                          }}
                        >
                          <span
                            className="mono"
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 5,
                              fontSize: 11.5,
                              color: "var(--ink-3)",
                            }}
                          >
                            <Clock className="h-3 w-3" />
                            {generatedStrategy.timeframe}
                          </span>
                          <span className="pf-pill outline">
                            {generatedStrategy.type}
                          </span>
                        </div>
                        <div className="pf-codeblock">
                          <span className="em">entry</span> ·{" "}
                          {generatedStrategy.rules.entry}
                          <br />
                          <span className="gold">exit</span> ·{" "}
                          {generatedStrategy.rules.exit}
                          <br />
                          <span className="dim">stop-loss</span> ·{" "}
                          {generatedStrategy.rules.stopLoss}
                        </div>
                        {generatedStrategy.overlays &&
                          generatedStrategy.overlays.length > 0 && (
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 6,
                              }}
                            >
                              {generatedStrategy.overlays.map((overlay, i) => (
                                <span key={i} className="pf-pill outline">
                                  {overlay}
                                </span>
                              ))}
                            </div>
                          )}
                        {paperTradingEnabled && (
                          <Link
                            href="/paper-trading/terminal"
                            className="pf-bf"
                            style={{ justifyContent: "center" }}
                          >
                            Use in paper trading
                            <ArrowRight className="h-4 w-4" />
                          </Link>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div
                      className="pf-card"
                      style={{
                        display: "grid",
                        placeItems: "center",
                        textAlign: "center",
                        padding: 32,
                      }}
                    >
                      <div>
                        <Sparkles
                          className="h-10 w-10"
                          style={{
                            color: "var(--ink-4)",
                            margin: "0 auto 14px",
                          }}
                        />
                        <div
                          style={{
                            fontSize: 17,
                            fontWeight: 800,
                            letterSpacing: -0.3,
                          }}
                        >
                          Your AI strategy will appear here
                        </div>
                        <div
                          style={{
                            marginTop: 8,
                            fontFamily: "Instrument Serif, serif",
                            fontStyle: "italic",
                            fontSize: 14,
                            color: "var(--ink-3)",
                            lineHeight: 1.4,
                            maxWidth: 320,
                          }}
                        >
                          Describe your idea and the AI structures it into entry
                          / exit rules, risk params, and indicators.
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </DemoGate>
            )}

            {/* Catalog tab - sub-tabs + search/universe + sort + card grid */}
            {primaryTab === "catalog" && (
              <>
                {/* Sub-tab strip (category pills with active ink fill) */}
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    marginBottom: 12,
                  }}
                >
                  {STRATEGY_TABS.map((t) => {
                    const active = t === activeCategory;
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setActiveCategory(t)}
                        className={`pf-pill ${active ? "" : "outline"}`}
                        style={{
                          cursor: "pointer",
                          ...(active
                            ? {
                                background: "var(--ink)",
                                color: "var(--paper)",
                              }
                            : {}),
                        }}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>

                {/* Search + universe chips + sort */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                    marginBottom: 18,
                  }}
                >
                  <div
                    style={{
                      flex: "1 1 220px",
                      minWidth: 220,
                      position: "relative",
                    }}
                  >
                    <Search
                      className="h-3.5 w-3.5"
                      style={{
                        position: "absolute",
                        left: 12,
                        top: "50%",
                        transform: "translateY(-50%)",
                        color: "var(--ink-3)",
                      }}
                    />
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search strategy…"
                      className="pf-input"
                      style={{ paddingLeft: 34 }}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {(
                      ["NIFTY 50", "NIFTY 500", "Sector"] as StrategyUniverse[]
                    ).map((u) => {
                      const active = universe === u;
                      return (
                        <button
                          key={u}
                          type="button"
                          onClick={() => setUniverse(u)}
                          className={`pf-pill ${active ? "emerald" : "outline"}`}
                          style={{ cursor: "pointer" }}
                        >
                          {u}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setSortDir(sortDir === "asc" ? "desc" : "asc")
                    }
                    className="pf-bf sm"
                    style={{ marginLeft: "auto" }}
                  >
                    {sortBy} {sortDir === "desc" ? "↓" : "↑"}
                  </button>
                </div>

                {visibleStrategies.length === 0 ? (
                  <div
                    className="pf-card"
                    style={{
                      textAlign: "center",
                      padding: 40,
                      borderStyle: "dashed",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 800,
                        letterSpacing: -0.3,
                        marginBottom: 6,
                      }}
                    >
                      No strategies yet
                    </div>
                    <div
                      style={{
                        fontFamily: "Instrument Serif, serif",
                        fontStyle: "italic",
                        fontSize: 15,
                        color: "var(--ink-3)",
                      }}
                    >
                      {activeCategory === "Custom"
                        ? "Use Create with AI to extract a strategy from a YouTube URL, blog, or X thread."
                        : "No strategies match the current filter."}
                    </div>
                  </div>
                ) : (
                  <div
                    className="strat-grid"
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fill, minmax(300px, 1fr))",
                      gap: 14,
                    }}
                  >
                    {visibleStrategies.map((s, idx) => {
                      const live = liveStats[s.id];
                      const curve = live?.curve ?? s.curve;
                      const tilt =
                        idx % 3 === 0
                          ? "tilt-l"
                          : idx % 3 === 1
                            ? ""
                            : "tilt-r";
                      const stats: Array<[string, string, string]> = [
                        ["CAGR", s.cagr, "var(--emerald-text)"],
                        ["SHARPE", s.sharpe, "var(--ink)"],
                        ["MAX DD", s.maxDD, "#b91c1c"],
                        ["1Y", s.return1Y, "var(--emerald-text)"],
                        ["WIN-RATE", s.winRate, "var(--ink)"],
                        ["AVG-HOLD", s.avgHold, "var(--ink)"],
                      ];
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => selectStrategy(s, "detail")}
                          className={`pf-card ${tilt}`}
                          style={{
                            padding: 18,
                            display: "flex",
                            flexDirection: "column",
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                        >
                          {/* Header row: name + category pill */}
                          <div
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              justifyContent: "space-between",
                              gap: 12,
                              marginBottom: 6,
                            }}
                          >
                            <div
                              style={{
                                fontSize: 16,
                                fontWeight: 800,
                                letterSpacing: -0.2,
                                lineHeight: 1.2,
                              }}
                            >
                              {s.name}
                            </div>
                            <span
                              className={`pf-pill ${CATEGORY_POP[s.category]}`}
                              style={{ flexShrink: 0 }}
                            >
                              {s.category}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: 12.5,
                              color: "var(--ink-3)",
                              lineHeight: 1.35,
                              marginBottom: 16,
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical",
                              overflow: "hidden",
                            }}
                          >
                            {s.description}
                          </div>

                          {/* 6-stat grid - 2 rows × 3 columns */}
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(3, 1fr)",
                              columnGap: 12,
                              rowGap: 10,
                              marginBottom: 16,
                            }}
                          >
                            {stats.map(([label, value, color]) => (
                              <div key={label}>
                                <div
                                  className="mono"
                                  style={{
                                    fontSize: 9,
                                    letterSpacing: 1,
                                    color: "var(--ink-4)",
                                    fontWeight: 700,
                                  }}
                                >
                                  {label}
                                </div>
                                <div
                                  className="mono"
                                  style={{
                                    fontSize: 13.5,
                                    fontWeight: 700,
                                    marginTop: 2,
                                    color,
                                  }}
                                >
                                  {value}
                                </div>
                              </div>
                            ))}
                          </div>

                          {/* Curve + status footer */}
                          <div
                            style={{
                              display: "flex",
                              alignItems: "flex-end",
                              justifyContent: "space-between",
                              gap: 12,
                              paddingTop: 12,
                              borderTop: "1.5px dashed var(--rule-soft)",
                            }}
                          >
                            <div style={{ flex: 1 }}>
                              <StrategySparkline data={curve} />
                              <div
                                className="mono"
                                style={{
                                  fontSize: 10,
                                  color: "var(--ink-4)",
                                  marginTop: 4,
                                }}
                              >
                                5Y curve
                              </div>
                            </div>
                            <span
                              className={`pf-pill ${
                                s.status === "LIVE"
                                  ? "emerald"
                                  : s.status === "CUSTOM"
                                    ? "violet"
                                    : "outline"
                              }`}
                              style={{ flexShrink: 0 }}
                            >
                              {s.status === "LIVE" && (
                                <span
                                  style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: 999,
                                    background: "var(--paper)",
                                  }}
                                />
                              )}
                              {s.status}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>

          <style>{`
              .strat-ai-grid { grid-template-columns: 1fr 1fr; }
              @media (max-width: 1000px) {
                .strat-ai-grid { grid-template-columns: 1fr !important; }
              }
            `}</style>
        </main>
      </div>
    </PageGuard>
  );
}
