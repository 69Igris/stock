"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { detectTier } from "./analysis-tier-logic";
import Sidebar from "@/components/Sidebar";
import { Skeleton } from "@usemoney/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@usemoney/ui/alert-dialog";
import { toast } from "sonner";
import {
  Brain,
  Search,
  Loader2,
  History,
  Clock,
  Trash2,
  AlertTriangle,
  XCircle,
  RotateCcw,
  GitCompare,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import Link from "next/link";
import { PageGuard } from "@/components/PageGuard";
import { PaginationControls } from "@/components/PaginationControls";
import { AnalysisSkeleton } from "@/components/skeletons";
import { DemoBanner } from "@/components/DemoBanner";
import {
  getResearchHistoryAction,
  getRunningResearchAction,
  getResearchStatusAction,
  deleteResearchAction,
  cancelResearchAction,
  type ResearchHistoryItem,
} from "@/lib/actions/research";
import { ResearchRunBlock } from "@/components/stocksage/ResearchRunBlock";
import type { TaskProgressItem } from "@usemoney/types";
import ResearchModal, {
  type ResearchEntity,
} from "@/components/analysis/ResearchModal";
import { ViewToggle, useScreenerView } from "@/components/screener/ViewToggle";
import { useIsDemoMode, useIsDemoModeReady } from "@/lib/hooks/useIsDemoMode";
import { useOwnedRoute } from "@/lib/hooks/useOwnedRoute";

// ── Helpers ──────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

function relativeTime(date: Date | string): string {
  const d = new Date(date);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

type TypeFilter = "all" | "stock" | "mf" | "etf" | "comparison";
type StatusFilter = "all" | "COMPLETED" | "FAILED";
type TierFilter = "all" | "L1" | "L2" | "L3" | "L4";

// detectTier (skill → UI tier) lives in ./analysis-tier-logic.ts (unit-tested).

/** Tier metadata — colour drawn from the playful pop palette so it tracks
 *  the active theme via CSS vars instead of hardcoded RGBA. */
const TIER_META: Record<
  "L1" | "L2" | "L3" | "L4",
  { label: string; color: string; credits: number; steps: number }
> = {
  L1: { label: "Quick", color: "var(--emerald)", credits: 1, steps: 4 },
  L2: { label: "Deep Dive", color: "var(--pop-3)", credits: 2, steps: 9 },
  L3: { label: "Comprehensive", color: "var(--pop-5)", credits: 6, steps: 14 },
  L4: { label: "Advanced", color: "var(--pop-1)", credits: 12, steps: 22 },
};

function detectEntityType(
  item: ResearchHistoryItem
): "stock" | "mf" | "etf" | "comparison" {
  // Multi-symbol or peer-comparison skill → comparison
  if (item.symbols.length > 1 || item.skill === "peer-comparison")
    return "comparison";
  // Mixed types from chat @ mentions (e.g. "[Mentioned: @RELIANCE ... @HDFC_MF ...]") → comparison
  if (
    item.query.includes("[Mentioned:") &&
    /\b(stock|mf|etf)\b.*\b(stock|mf|etf)\b/i.test(item.query)
  )
    return "comparison";
  if (item.query.startsWith("[MUTUAL_FUND]")) return "mf";
  if (item.query.startsWith("[ETF]") || item.skill === "etf-analysis")
    return "etf";
  return "stock";
}

// ── Component ──────────────────────────────────────────────────────

export default function AnalysisPageClient({ isDemo }: { isDemo?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const ownedRoute = useOwnedRoute("/analysis");
  const { user, isLoaded } = useUser();

  // Server-side isDemo prop is authoritative; localStorage is fallback
  const isDemoMode = useIsDemoMode({ isDemo, user });
  // Deferred-read gate — without it the demo gate below fires on the
  // first paint (when the localStorage flag hasn't been read yet) and
  // blocks demo visitors on the skeleton (Fix 2 — MONEY-200). Matches
  // the canonical pattern used by /fire and /tradebook.
  const demoModeReady = useIsDemoModeReady();

  // Running sessions
  const [runningSessions, setRunningSessions] = useState<
    Array<{
      sessionId: string;
      query: string;
      status: string;
      progress: number;
      currentStep?: string;
      symbols: string[];
      createdAt: Date;
      /** Per-task streaming progress (StockSage v2 research-run card). */
      taskProgress?: TaskProgressItem[];
    }>
  >([]);
  const [isLoadingRunning, setIsLoadingRunning] = useState(true);
  // MONEY-1059: running research cards default to COLLAPSED so multiple
  // concurrent runs don't wall the page. Keyed by sessionId; absent = collapsed.
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  // MONEY-1053: ref mirror of expandedRuns for the 3s poll. loadRunning is a
  // stable useCallback (empty deps — the interval must NOT be torn down on
  // every expand/collapse), so it reads the CURRENT expansion state via ref.
  const expandedRunsRef = useRef(expandedRuns);
  useEffect(() => {
    expandedRunsRef.current = expandedRuns;
  }, [expandedRuns]);
  const runningPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevRunningCountRef = useRef(0);

  // History
  const [history, setHistory] = useState<ResearchHistoryItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  // Filters
  const [searchFilter, setSearchFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // ResearchModal state (for URL param auto-open)
  const [modalOpen, setModalOpen] = useState(false);
  const [modalEntity, setModalEntity] = useState<ResearchEntity | null>(null);
  const [modalCompare, setModalCompare] = useState<ResearchEntity[]>([]);

  // View mode - uses the screener's shared ViewToggle hook so the
  // localStorage shape + persistence semantics match (analysis.view =
  // "cards" | "table"). Default "cards" to match prior behaviour.
  const [viewMode, setViewMode] = useScreenerView("analysis.view", "cards");

  // ── Data loading ──────────────────────────────────────────────────

  const loadRunning = useCallback(async () => {
    try {
      const res = await getRunningResearchAction();
      if (res?.success && res?.data) {
        const newCount = res?.data.length;
        // If a running session disappeared (completed/failed), refresh history
        if (
          prevRunningCountRef.current > 0 &&
          newCount < prevRunningCountRef.current
        ) {
          setHistoryRefreshKey((k) => k + 1);
        }
        prevRunningCountRef.current = newCount;
        // Enrich a running session with taskProgress ONLY when its card is
        // expanded (MONEY-1053): taskProgress feeds solely the expanded
        // ResearchRunBlock (stepper + task cards); the default-collapsed row
        // renders just currentStep + progress, which getRunningResearchAction
        // already returns — so per-3s status calls for collapsed cards were
        // pure waste. Expanding a card mid-run may take one ≤3s tick before
        // tasks appear; the expanded branch renders `taskProgress ?? []`
        // meanwhile. Rarely more than 1-2 running sessions.
        const enriched = await Promise.all(
          res.data.map(async (s) => {
            if (!expandedRunsRef.current[s.sessionId]) {
              return { ...s, taskProgress: undefined };
            }
            try {
              const st = await getResearchStatusAction(s.sessionId);
              const d = st?.data as
                | {
                    taskProgress?: TaskProgressItem[];
                    progress?: number;
                    currentStep?: string;
                  }
                | undefined;
              return {
                ...s,
                progress: d?.progress ?? s.progress,
                currentStep: d?.currentStep ?? s.currentStep,
                taskProgress: d?.taskProgress ?? [],
              };
            } catch {
              return s;
            }
          })
        );
        setRunningSessions(enriched);
      }
    } catch {
      // silent
    } finally {
      setIsLoadingRunning(false);
    }
  }, []);

  const loadHistory = useCallback(async (page0: number) => {
    setIsLoadingHistory(true);
    try {
      // API expects 1-indexed pages; state is 0-indexed
      const res = await getResearchHistoryAction(page0 + 1, PAGE_SIZE);
      if (res?.success && res?.data) {
        setHistory(res?.data.items);
        setTotalItems(res?.data.total);
      }
    } catch {
      // silent
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  // Poll running sessions
  useEffect(() => {
    loadRunning();
    runningPollRef.current = setInterval(loadRunning, 3000); // 3s so the run card streams
    return () => {
      if (runningPollRef.current) clearInterval(runningPollRef.current);
    };
  }, [loadRunning]);

  // Load history on mount, page change, or when a running session completes
  useEffect(() => {
    loadHistory(currentPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, historyRefreshKey, loadHistory]);

  // URL param: if ?sessionId=X, navigate to the report page directly
  // If only ?symbol=X, open the ResearchModal for a new analysis
  //
  // MONEY-1082: both writes go through useOwnedRoute so they can't fire once
  // the user has navigated off /analysis. This effect keys on `searchParams`,
  // which the router re-issues across a transition — unguarded, the deep-link
  // forward could land after the user had already moved on and drag them back.
  useEffect(() => {
    const sessionId = searchParams.get("sessionId");
    if (sessionId) {
      ownedRoute.replaceRoute(`/analysis/${sessionId}`);
      return;
    }

    const symbol = searchParams.get("symbol");
    const type = (searchParams.get("type") || "stock") as
      | "stock"
      | "mf"
      | "etf";
    if (symbol) {
      setModalEntity({
        symbol: symbol.replace(/\.(NS|BO)$/, ""),
        name: symbol.replace(/\.(NS|BO)$/, ""),
        type,
      });
      setModalOpen(true);
      // Strip ?symbol= now the modal owns it. This stays a real navigation
      // (not syncParams) because this same effect reads the param back via
      // useSearchParams — a URL-bar-only write would leave the stale symbol
      // in React's copy and re-open the modal on the next re-run.
      ownedRoute.replaceRoute("/analysis", { scroll: false });
    }
  }, [searchParams, ownedRoute]);

  // ── Actions ──────────────────────────────────────────────────────

  const handleCancelResearch = async (sessionId: string) => {
    try {
      await cancelResearchAction(sessionId);
      setRunningSessions((prev) =>
        prev.filter((s) => s.sessionId !== sessionId)
      );
      toast.success("Research cancelled");
      loadHistory(currentPage);
    } catch {
      toast.error("Failed to cancel");
    }
  };

  const handleDeleteResearch = async (sessionId: string) => {
    try {
      await deleteResearchAction(sessionId);
      setHistory((prev) => prev.filter((h) => h.sessionId !== sessionId));
      setTotalItems((prev) => prev - 1);
      toast.success("Research deleted");
    } catch {
      toast.error("Failed to delete");
    }
  };

  // Rerun → open the mode-select modal pre-seeded with the item's symbol(s),
  // instead of auto-re-running in quick mode. The modal runs it on confirm.
  const handleRetryResearch = (item: ResearchHistoryItem) => {
    const symbols = item.symbols.map((s) => s.replace(/\.(NS|BO)$/, ""));
    if (symbols.length === 0) return;
    const t = detectEntityType(item);
    if (t === "comparison" || symbols.length > 1) {
      setModalCompare(
        symbols.map((s) => ({ symbol: s, name: s, type: "stock" as const }))
      );
      setModalEntity(null);
    } else {
      setModalCompare([]);
      setModalEntity({
        symbol: symbols[0]!,
        name: symbols[0]!,
        type: t === "etf" ? "etf" : t === "mf" ? "mf" : "stock",
      });
    }
    setModalOpen(true);
  };

  // ── Filtered history ──────────────────────────────────────────────

  const filteredHistory = useMemo(() => {
    let items = history;

    // Client-side search filter
    if (searchFilter.trim()) {
      const q = searchFilter.toLowerCase();
      items = items.filter(
        (h) =>
          h.query.toLowerCase().includes(q) ||
          h.symbols.some((s) => s.toLowerCase().includes(q))
      );
    }

    // Type filter
    if (typeFilter !== "all") {
      items = items.filter((h) => detectEntityType(h) === typeFilter);
    }
    if (tierFilter !== "all") {
      items = items.filter((h) => detectTier(h.skill) === tierFilter);
    }

    // Status filter
    if (statusFilter !== "all") {
      items = items.filter((h) => h.status === statusFilter);
    }

    return items;
  }, [history, searchFilter, typeFilter, statusFilter, tierFilter]);

  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));

  // Redirect unauthenticated, non-demo visitors to /home. Runs in an
  // effect (not during render) so the router transition fires after
  // commit. We also wait on `demoModeReady` so a legitimate demo
  // visitor isn't redirected on the first paint before the
  // localStorage flag has hydrated. Matches /fire + /tradebook.
  useEffect(() => {
    if (!isLoaded) return;
    if (!demoModeReady) return;
    if (!user && !isDemoMode) router.push("/home");
  }, [isLoaded, demoModeReady, user, isDemoMode, router]);

  // ── Guard ──────────────────────────────────────────────────────────
  // Render the skeleton while we wait for Clerk + localStorage to
  // hydrate, OR while the redirect above is in flight. Demo visitors
  // and authenticated users both fall through to the real render.

  if (!isLoaded || !demoModeReady || (!user && !isDemoMode)) {
    return (
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="p-6 pb-24">
            <AnalysisSkeleton />
          </div>
        </main>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────

  // MONEY-392: chrome (Sidebar + container + Header) lives OUTSIDE
  // PageGuard so the header stays visible across all loading stages.
  return (
    <div className="pf-app min-h-screen" style={{ color: "var(--ink)" }}>
      <Sidebar />

      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="p-6 pb-24">
          {isDemoMode && <DemoBanner />}

          {/* Page heading - playful eyebrow + serif headline */}
          <div
            className="mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              color: "var(--emerald-text)",
              marginBottom: 8,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--emerald)",
                animation: "um-pulse 1.6s infinite",
              }}
            />
            RESEARCH LIST
          </div>
          <div className="flex items-baseline gap-3.5 flex-wrap mb-1">
            <h1
              style={{
                fontSize: 32,
                lineHeight: 1.02,
                letterSpacing: "-1px",
                fontWeight: 800,
                color: "var(--ink)",
                margin: 0,
              }}
            >
              Your research, <span className="ser">on the</span>{" "}
              <span className="hl-gold">record.</span>
            </h1>
            <div className="flex-1" />
            <span
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--ink-3)",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--emerald)",
                  boxShadow: "0 0 6px var(--emerald)",
                }}
              />
              {history.length} sessions
            </span>
          </div>
          <p
            style={{
              fontSize: 13,
              color: "var(--ink-3)",
              marginBottom: 24,
              maxWidth: "48rem",
            }}
          >
            View and track your stock + mutual fund research sessions.
          </p>

          <PageGuard route="/analysis" bare fallback={<AnalysisSkeleton />}>
            {/* Running Research - pulse dot + count */}
            {(isLoadingRunning || runningSessions.length > 0) && (
              <div className="mb-6">
                <div className="flex items-center gap-2.5 mb-3">
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--pop-2)",
                      boxShadow: "0 0 8px var(--pop-2)",
                      animation: "um-pulse 1.2s infinite",
                    }}
                  />
                  <span
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      textTransform: "uppercase",
                      letterSpacing: 1.4,
                      color: "var(--pop-2-text)",
                      fontWeight: 700,
                    }}
                  >
                    Running Now · {runningSessions.length}
                  </span>
                </div>
                {isLoadingRunning ? (
                  <Skeleton className="h-16" />
                ) : (
                  <div className="space-y-3">
                    {runningSessions.map((session) => {
                      const sym =
                        session.symbols.length > 1
                          ? session.symbols
                              .map((s) => s.replace(/\.(NS|BO)$/, ""))
                              .join(" vs ")
                          : session.symbols[0]?.replace(/\.(NS|BO)$/, "") ||
                            "-";
                      const startedAt = new Date(session.createdAt);
                      const elapsedMs = Date.now() - startedAt.getTime();
                      const elapsedMin = Math.floor(elapsedMs / 60000);
                      const isStuck = elapsedMin >= 5;
                      const isExpanded = !!expandedRuns[session.sessionId];
                      const toggleExpanded = () =>
                        setExpandedRuns((prev) => ({
                          ...prev,
                          [session.sessionId]: !prev[session.sessionId],
                        }));
                      const pct = Math.round(
                        Math.max(0, Math.min(100, session.progress || 0))
                      );
                      return (
                        <div key={session.sessionId}>
                          {/* Header row: chevron + symbol + pills + elapsed + open + cancel */}
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <button
                              type="button"
                              onClick={toggleExpanded}
                              className="pf-bf sm shrink-0"
                              style={{ padding: "5px 7px" }}
                              aria-expanded={isExpanded}
                              aria-label={
                                isExpanded ? "Collapse run" : "Expand run"
                              }
                              title={isExpanded ? "Collapse" : "Expand"}
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                            </button>
                            <span
                              className="mono"
                              style={{
                                fontSize: 13.5,
                                fontWeight: 700,
                                color: "var(--ink)",
                              }}
                            >
                              {sym}
                            </span>
                            {session.symbols.length > 1 && (
                              <span
                                className="pf-pill violet"
                                style={{ fontSize: 9, padding: "1px 7px" }}
                              >
                                Comparison
                              </span>
                            )}
                            {isStuck && (
                              <span
                                className="pf-pill"
                                style={{
                                  fontSize: 9,
                                  padding: "1px 7px",
                                  background: "var(--ink)",
                                  color: "var(--pop-2)",
                                  borderColor: "var(--ink)",
                                }}
                              >
                                Stuck
                              </span>
                            )}
                            <span
                              className="mono"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                fontSize: 10,
                                color: "var(--ink-4)",
                              }}
                            >
                              <Clock className="h-2.5 w-2.5" />
                              {elapsedMin > 0
                                ? `${elapsedMin}m ago`
                                : "just now"}
                            </span>
                            <span style={{ flex: 1 }} />
                            <Link
                              href={`/analysis/${session.sessionId}`}
                              className="pf-bf sm"
                              style={{ padding: "5px 10px", fontSize: 11 }}
                            >
                              Open run →
                            </Link>
                            <button
                              onClick={() =>
                                handleCancelResearch(session.sessionId)
                              }
                              className="pf-bf sm shrink-0"
                              style={{ padding: "6px 9px" }}
                              title="Cancel research"
                            >
                              <XCircle className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          {/* StockSage v2 streaming research-run card. MONEY-1059:
                              collapsed by default so multiple concurrent runs stay
                              scannable — expand for the full stepper + per-task
                              cards. Collapsed shows a compact progress row that is
                              itself a click target to expand. */}
                          {isExpanded ? (
                            <ResearchRunBlock
                              data={{
                                status: "running",
                                progress: session.progress,
                                currentStep:
                                  session.currentStep || session.query,
                                tasks: (session.taskProgress ?? []).map(
                                  (t) => ({
                                    id: t.id,
                                    tool: t.tool,
                                    type: t.type,
                                    status: t.status,
                                    durationMs: t.durationMs,
                                    resultSummary: t.resultSummary,
                                  })
                                ),
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={toggleExpanded}
                              className="w-full text-left"
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                padding: "10px 12px",
                                border: "2px solid var(--ink)",
                                borderRadius: 12,
                                background: "var(--paper-2)",
                                boxShadow: "var(--shadow-soft)",
                                cursor: "pointer",
                              }}
                              aria-label="Expand run to see task progress"
                            >
                              <span
                                className="mono"
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  textTransform: "uppercase",
                                  letterSpacing: 1,
                                  color: "var(--pop-2-text)",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  maxWidth: 240,
                                }}
                              >
                                {session.currentStep || "Researching"}
                              </span>
                              <span
                                style={{
                                  flex: 1,
                                  height: 6,
                                  borderRadius: 999,
                                  background: "var(--rule-softer)",
                                  overflow: "hidden",
                                  position: "relative",
                                }}
                              >
                                <span
                                  style={{
                                    position: "absolute",
                                    inset: 0,
                                    width: `${pct}%`,
                                    background: "var(--pop-2)",
                                    borderRadius: 999,
                                    transition: "width .3s ease",
                                  }}
                                />
                              </span>
                              <span
                                className="mono tabular-nums"
                                style={{
                                  fontSize: 11,
                                  fontWeight: 700,
                                  color: "var(--ink)",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {pct}%
                              </span>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* History section - playful framed card */}
            <div className="pf-card" style={{ padding: 0 }}>
              <div
                style={{
                  padding: "16px 20px",
                  borderBottom: "2px solid var(--ink)",
                }}
              >
                <div
                  className="mono"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: 1.5,
                    color: "var(--ink)",
                    fontWeight: 700,
                  }}
                >
                  <History
                    className="h-3.5 w-3.5"
                    style={{ color: "var(--ink-3)" }}
                  />
                  Research History
                  {totalItems > 0 && (
                    <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>
                      · {totalItems}
                    </span>
                  )}
                </div>

                {/* Filters */}
                <div className="flex flex-wrap gap-2 mt-3">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search
                      className="absolute left-2.5 top-2.5 h-4 w-4"
                      style={{ color: "var(--ink-3)" }}
                    />
                    <input
                      className="pf-input"
                      placeholder="Search by symbol or query..."
                      value={searchFilter}
                      onChange={(e) => setSearchFilter(e.target.value)}
                      style={{ paddingLeft: 34, fontSize: 13.5 }}
                    />
                  </div>
                  <select
                    value={typeFilter}
                    onChange={(e) =>
                      setTypeFilter(e.target.value as TypeFilter)
                    }
                    className="pf-input mono"
                    style={{ width: 150, fontSize: 12.5, cursor: "pointer" }}
                    aria-label="Type filter"
                  >
                    <option value="all">All Types</option>
                    <option value="stock">Stock</option>
                    <option value="mf">Mutual Fund</option>
                    <option value="etf">ETF</option>
                    <option value="comparison">Comparison</option>
                  </select>
                  <select
                    value={statusFilter}
                    onChange={(e) =>
                      setStatusFilter(e.target.value as StatusFilter)
                    }
                    className="pf-input mono"
                    style={{ width: 150, fontSize: 12.5, cursor: "pointer" }}
                    aria-label="Status filter"
                  >
                    <option value="all">All Status</option>
                    <option value="COMPLETED">Completed</option>
                    <option value="FAILED">Failed</option>
                  </select>
                </div>

                {/* Tier filter pills + view-mode toggle row */}
                <div className="flex items-center gap-3 mt-3 flex-wrap">
                  <div
                    style={{
                      display: "flex",
                      gap: 4,
                      padding: 3,
                      borderRadius: 9,
                      border: "1.5px solid var(--ink)",
                      background: "var(--paper-2)",
                    }}
                  >
                    {(["all", "L1", "L2", "L3", "L4"] as const).map((t) => {
                      const active = tierFilter === t;
                      const meta = t === "all" ? null : TIER_META[t];
                      const accent = meta ? meta.color : "var(--emerald)";
                      return (
                        <button
                          key={t}
                          onClick={() => setTierFilter(t)}
                          className="mono"
                          style={{
                            padding: "4px 10px",
                            borderRadius: 6,
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: 0.3,
                            cursor: "pointer",
                            background: active ? "var(--ink)" : "transparent",
                            color: active ? "var(--paper)" : "var(--ink-3)",
                            border: 0,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                          }}
                        >
                          {meta && (
                            <span
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: "50%",
                                background: accent,
                              }}
                            />
                          )}
                          {t === "all" ? "All" : meta?.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex-1" />
                  {/* Shared screener ViewToggle - labels hide below sm
                      (icon-only on mobile) to match screener behaviour. */}
                  <ViewToggle value={viewMode} onChange={setViewMode} />
                </div>
              </div>

              <div style={{ padding: 20 }}>
                {isLoadingHistory ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2
                      className="h-5 w-5 animate-spin"
                      style={{ color: "var(--ink-3)" }}
                    />
                  </div>
                ) : filteredHistory.length === 0 ? (
                  <div
                    style={{
                      borderRadius: 14,
                      border: "1.5px dashed var(--rule-soft)",
                      background: "var(--paper-2)",
                      padding: 48,
                      textAlign: "center",
                    }}
                  >
                    <div
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: 14,
                        background: "var(--emerald)",
                        border: "1.5px solid var(--ink)",
                        boxShadow: "3px 3px 0 var(--ink)",
                        transform: "rotate(-3deg)",
                        margin: "0 auto 18px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Brain
                        className="h-[26px] w-[26px]"
                        style={{ color: "var(--paper)" }}
                      />
                    </div>
                    <div
                      style={{
                        fontSize: 19,
                        fontWeight: 800,
                        color: "var(--ink)",
                        letterSpacing: "-0.3px",
                        marginBottom: 6,
                      }}
                    >
                      {history.length === 0
                        ? "No analyses yet"
                        : "No sessions match"}
                    </div>
                    <div
                      style={{
                        fontFamily: "Instrument Serif, serif",
                        fontStyle: "italic",
                        fontSize: 15.5,
                        color: "var(--ink-3)",
                        maxWidth: 360,
                        margin: "0 auto 18px",
                        lineHeight: 1.4,
                      }}
                    >
                      {history.length === 0
                        ? "Ask StockSage anything about a stock, sector, or company event — every research session lands here."
                        : "Try a different tier, type, or status filter."}
                    </div>
                    {history.length === 0 && (
                      <Link href="/dashboard" className="pf-bs">
                        <Brain className="h-3.5 w-3.5" />
                        Open StockSage
                      </Link>
                    )}
                  </div>
                ) : (
                  <div
                    className={
                      viewMode === "cards"
                        ? "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3"
                        : "flex flex-col"
                    }
                  >
                    {filteredHistory.map((item) => {
                      const isFailed = item.status === "FAILED";
                      const entityType = detectEntityType(item);
                      const isComp = entityType === "comparison";

                      // Symbol display
                      const symbolDisplay = isComp
                        ? item.symbols
                            .map((s) => s.replace(/\.(NS|BO)$/, ""))
                            .join(" vs ")
                        : item.symbols[0]?.replace(/\.(NS|BO)$/, "") || "-";

                      // Exchange badge (NSE/BSE) from symbol suffix
                      const exchange = !isComp
                        ? item.symbols[0]?.endsWith(".BO")
                          ? "BSE"
                          : item.symbols[0]?.endsWith(".NS")
                            ? "NSE"
                            : null
                        : null;

                      // Tier metadata - used in header pill and footer step count
                      const tier = detectTier(item.skill);
                      const tierMeta = TIER_META[tier];

                      // Footer meta: N steps · M cr · duration
                      const stepCount =
                        (item as { stepsCount?: number }).stepsCount ||
                        tierMeta.steps;
                      const creditCost = tierMeta.credits;
                      const durationMs =
                        (item as { durationMs?: number }).durationMs || 0;
                      const durationLabel =
                        durationMs > 0
                          ? durationMs < 60_000
                            ? `${Math.round(durationMs / 1000)}s`
                            : `${Math.floor(durationMs / 60_000)}m ${Math.round(
                                (durationMs % 60_000) / 1000
                              )}s`
                          : "-";

                      const isCancelled =
                        item.errorMessage === "Cancelled by user";

                      // List view - denser horizontal row, drops body
                      // copy in favour of inline meta. Card view retains
                      // the original multi-line layout below.
                      if (viewMode === "table") {
                        const listRow = (
                          <div
                            className="group w-full flex flex-col gap-2 md:grid md:grid-cols-[180px_1fr_auto_auto] md:items-center md:gap-4"
                            style={{
                              padding: "12px 16px",
                              borderBottom: "1px dashed var(--rule-soft)",
                              transition: "background 0.12s",
                              background: isFailed
                                ? "rgba(185,28,28,0.04)"
                                : "transparent",
                            }}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className="mono truncate"
                                style={{
                                  fontSize: 13,
                                  fontWeight: 700,
                                  color: "var(--ink)",
                                }}
                              >
                                {symbolDisplay}
                              </span>
                              {entityType === "mf" && (
                                <span
                                  className="mono"
                                  style={{
                                    fontSize: 9,
                                    textTransform: "uppercase",
                                    letterSpacing: 0.8,
                                    color: "var(--emerald-text)",
                                    fontWeight: 700,
                                  }}
                                >
                                  MF
                                </span>
                              )}
                              {entityType === "etf" && (
                                <span
                                  className="mono"
                                  style={{
                                    fontSize: 9,
                                    textTransform: "uppercase",
                                    letterSpacing: 0.8,
                                    color: "var(--pop-1-text)",
                                    fontWeight: 700,
                                  }}
                                >
                                  ETF
                                </span>
                              )}
                              {isComp && (
                                <span
                                  className="mono inline-flex items-center gap-0.5"
                                  style={{
                                    fontSize: 9,
                                    textTransform: "uppercase",
                                    letterSpacing: 0.8,
                                    color: "var(--pop-5-text)",
                                    fontWeight: 700,
                                  }}
                                >
                                  <GitCompare className="h-2.5 w-2.5" />
                                  CMP
                                </span>
                              )}
                            </div>
                            <p
                              className="truncate"
                              style={{
                                fontSize: 12.5,
                                color: isFailed ? "#b91c1c" : "var(--ink-2)",
                              }}
                            >
                              {isFailed
                                ? item.errorMessage || "Analysis failed"
                                : item.query.replace(/^\[MUTUAL_FUND\]\s*/, "")}
                            </p>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span
                                className="pf-pill"
                                style={{
                                  fontSize: 9,
                                  padding: "1px 7px",
                                  background: tierMeta.color,
                                  color: "var(--paper)",
                                  borderColor: tierMeta.color,
                                }}
                              >
                                {tierMeta.label}
                              </span>
                              {isFailed ? (
                                <span
                                  className="pf-pill"
                                  style={{
                                    fontSize: 9,
                                    padding: "1px 7px",
                                    background: isCancelled
                                      ? "var(--pop-2)"
                                      : "#b91c1c",
                                    color: isCancelled ? "#1d1d1b" : "#fff",
                                    borderColor: isCancelled
                                      ? "var(--ink)"
                                      : "#b91c1c",
                                  }}
                                >
                                  {isCancelled ? "CANCELLED" : "FAILED"}
                                </span>
                              ) : (
                                <span
                                  className="pf-pill emerald"
                                  style={{ fontSize: 9, padding: "1px 7px" }}
                                >
                                  DONE
                                </span>
                              )}
                              <span
                                className="mono"
                                style={{
                                  fontSize: 10.5,
                                  color: "var(--ink-3)",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {stepCount} · {creditCost}cr · {durationLabel}
                              </span>
                              <span
                                className="mono"
                                style={{
                                  fontSize: 10.5,
                                  color: "var(--ink-4)",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {relativeTime(item.createdAt)}
                              </span>
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleRetryResearch(item);
                                }}
                                disabled={retryingId === item.sessionId}
                                className="pf-bf sm"
                                style={{ padding: "5px 7px" }}
                                title="Re-run research"
                              >
                                {retryingId === item.sessionId ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <RotateCcw className="h-3 w-3" />
                                )}
                              </button>
                              <button
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleDeleteResearch(item.sessionId);
                                }}
                                className="pf-bf danger sm"
                                style={{ padding: "5px 7px" }}
                                title="Delete research"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        );
                        return isFailed ? (
                          <div key={item.sessionId}>{listRow}</div>
                        ) : (
                          <Link
                            key={item.sessionId}
                            href={`/analysis/${item.sessionId}`}
                            className="block"
                          >
                            {listRow}
                          </Link>
                        );
                      }
                      const inner = (
                        <div
                          className="pf-card group h-full flex flex-col"
                          style={{
                            background: isFailed
                              ? "rgba(185,28,28,0.04)"
                              : "var(--paper)",
                            borderColor: isFailed ? "#b91c1c" : "var(--ink)",
                          }}
                        >
                          {/* Header row - TICKER + tier pill + status pill */}
                          <div className="flex items-start gap-2 mb-3">
                            <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                              <span
                                className="mono truncate"
                                style={{
                                  fontSize: 15,
                                  fontWeight: 700,
                                  color: "var(--ink)",
                                  letterSpacing: "-0.3px",
                                }}
                              >
                                {symbolDisplay}
                              </span>
                              {exchange && (
                                <span
                                  className="mono"
                                  style={{
                                    fontSize: 9.5,
                                    textTransform: "uppercase",
                                    letterSpacing: 1,
                                    color: "var(--ink-4)",
                                    fontWeight: 700,
                                  }}
                                >
                                  {exchange}
                                </span>
                              )}
                              {isComp && (
                                <span
                                  className="mono inline-flex items-center gap-0.5"
                                  style={{
                                    fontSize: 9.5,
                                    textTransform: "uppercase",
                                    letterSpacing: 0.8,
                                    color: "var(--pop-5-text)",
                                    fontWeight: 700,
                                  }}
                                >
                                  <GitCompare className="h-2.5 w-2.5" />
                                  COMPARE
                                </span>
                              )}
                              {entityType === "mf" && (
                                <span
                                  className="mono"
                                  style={{
                                    fontSize: 9.5,
                                    textTransform: "uppercase",
                                    letterSpacing: 0.8,
                                    color: "var(--emerald-text)",
                                    fontWeight: 700,
                                  }}
                                >
                                  MF
                                </span>
                              )}
                              {entityType === "etf" && (
                                <span
                                  className="mono"
                                  style={{
                                    fontSize: 9.5,
                                    textTransform: "uppercase",
                                    letterSpacing: 0.8,
                                    color: "var(--pop-1-text)",
                                    fontWeight: 700,
                                  }}
                                >
                                  ETF
                                </span>
                              )}
                              <span
                                className="pf-pill"
                                style={{
                                  fontSize: 9.5,
                                  padding: "1px 7px",
                                  background: tierMeta.color,
                                  color: "var(--paper)",
                                  borderColor: tierMeta.color,
                                }}
                              >
                                {tierMeta.label}
                              </span>
                            </div>
                            {/* Status pill - Done / Failed / Cancelled */}
                            {isFailed ? (
                              <span
                                className="pf-pill inline-flex items-center gap-1"
                                style={{
                                  fontSize: 9.5,
                                  padding: "2px 8px",
                                  background: isCancelled
                                    ? "var(--pop-2)"
                                    : "#b91c1c",
                                  color: isCancelled ? "#1d1d1b" : "#fff",
                                  borderColor: isCancelled
                                    ? "var(--ink)"
                                    : "#b91c1c",
                                }}
                              >
                                {isCancelled ? (
                                  <XCircle className="h-2.5 w-2.5" />
                                ) : (
                                  <AlertTriangle className="h-2.5 w-2.5" />
                                )}
                                {isCancelled ? "CANCELLED" : "FAILED"}
                              </span>
                            ) : (
                              <span
                                className="pf-pill emerald"
                                style={{ fontSize: 9.5, padding: "2px 8px" }}
                              >
                                DONE
                              </span>
                            )}
                          </div>

                          {/* Body - query / question text */}
                          <div className="flex-1 mb-3">
                            <p
                              className="line-clamp-3"
                              style={{
                                fontSize: 13,
                                lineHeight: 1.5,
                                color: isFailed ? "#b91c1c" : "var(--ink-2)",
                              }}
                            >
                              {isFailed
                                ? item.errorMessage || "Analysis failed"
                                : item.query.replace(/^\[MUTUAL_FUND\]\s*/, "")}
                            </p>
                            {/* MONEY-445: BUY/SELL/HOLD recommendation pill
                                removed from the research history list - the
                                platform is informational, not advisory. Score
                                still renders elsewhere on the row. */}
                          </div>

                          {/* Footer - N steps · M cr · duration · time + actions */}
                          <div
                            className="flex items-center gap-2"
                            style={{
                              paddingTop: 10,
                              borderTop: "1px dashed var(--rule-soft)",
                            }}
                          >
                            <span
                              className="mono"
                              style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                            >
                              {stepCount} steps · {creditCost} cr ·{" "}
                              {durationLabel}
                            </span>
                            <span style={{ color: "var(--ink-4)" }}>·</span>
                            <span
                              className="mono"
                              style={{ fontSize: 10.5, color: "var(--ink-4)" }}
                            >
                              {relativeTime(item.createdAt)}
                            </span>
                            <div className="flex-1" />
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleRetryResearch(item);
                              }}
                              disabled={retryingId === item.sessionId}
                              className="pf-bf sm"
                              style={{ padding: "5px 7px" }}
                              title="Re-run research"
                            >
                              {retryingId === item.sessionId ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3 w-3" />
                              )}
                            </button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <button
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                  }}
                                  className="pf-bf danger sm"
                                  style={{ padding: "5px 7px" }}
                                  title="Delete research"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </AlertDialogTrigger>
                              <AlertDialogContent
                                style={{
                                  background: "var(--paper)",
                                  border: "2px solid var(--ink)",
                                  borderRadius: 16,
                                  boxShadow: "var(--shadow-hard)",
                                  color: "var(--ink)",
                                }}
                              >
                                <AlertDialogHeader>
                                  <AlertDialogTitle
                                    style={{
                                      fontSize: 18,
                                      fontWeight: 800,
                                      letterSpacing: "-0.4px",
                                      color: "#b91c1c",
                                    }}
                                  >
                                    Delete Research
                                  </AlertDialogTitle>
                                  <AlertDialogDescription
                                    className="ser"
                                    style={{
                                      fontSize: 16,
                                      color: "var(--ink-2)",
                                      lineHeight: 1.4,
                                    }}
                                  >
                                    This will permanently delete this research
                                    session and its chat history. This action
                                    cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel className="pf-bf sm mt-0">
                                    Cancel
                                  </AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() =>
                                      handleDeleteResearch(item.sessionId)
                                    }
                                    className="pf-bf sm danger"
                                  >
                                    Delete
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </div>
                      );

                      return isFailed ? (
                        <div key={item.sessionId}>{inner}</div>
                      ) : (
                        <Link
                          key={item.sessionId}
                          href={`/analysis/${item.sessionId}`}
                          className="block"
                        >
                          {inner}
                        </Link>
                      );
                    })}
                  </div>
                )}

                {/* Pagination */}
                {totalItems > 0 && (
                  <div
                    style={{
                      borderTop: "1.5px solid var(--rule-soft)",
                      marginTop: 16,
                    }}
                  >
                    <PaginationControls
                      currentPage={currentPage}
                      totalPages={totalPages}
                      onPageChange={setCurrentPage}
                      pageSize={PAGE_SIZE}
                      totalItems={totalItems}
                      label="sessions"
                    />
                  </div>
                )}
              </div>
            </div>
          </PageGuard>
        </div>
      </main>

      {/* ResearchModal for URL param auto-open */}
      <ResearchModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        entity={modalEntity}
        compareEntities={modalCompare.length >= 2 ? modalCompare : undefined}
      />
    </div>
  );
}
