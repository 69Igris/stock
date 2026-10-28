"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import { RoastSkeleton } from "@/components/skeletons";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { PaginationControls } from "@/components/PaginationControls";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import {
  Flame,
  Loader2,
  AlertTriangle,
  ExternalLink,
  Activity,
  Sparkles,
  Info,
  History,
  Trash2,
  RotateCcw,
  XCircle,
  Eye,
} from "lucide-react";
import RoastScopePicker from "./RoastScopePicker";
import {
  startRoastAction,
  canUseRoastAction,
  getRunningRoastsAction,
  cancelRoastAction,
  type RoastParams,
  type RoastErrorType,
} from "@/lib/actions/roast";
import {
  getRoastHistoryAction,
  deleteRoastAction,
} from "@/lib/actions/roast-history";
import { getBrokerConnectionsAction } from "@/lib/actions/broker-connection";
import type { BrokerConnectionInfo } from "@/lib/actions/broker-connection";
import { getHoldingsAction } from "@/lib/actions/holdings";
import type { BrokerType } from "@usemoney/types/broker";
import { DemoBanner, DemoGate } from "@/components/DemoBanner";
import { getSubscriptionAction } from "@/lib/actions/subscription";
import Link from "next/link";

// Broker display labels for the roast source dropdown. Sourced from the
// canonical BROKER_CONFIGS in @usemoney/core/brokers, which is a server-only
// barrel (it transitively imports node:crypto) and so cannot be pulled into
// this "use client" bundle — the presentational labels are inlined here.
// ZERODHA_CONNECT is filtered out before this lookup and intentionally omitted.
const BROKER_DISPLAY_NAMES: Partial<Record<BrokerType, string>> = {
  ZERODHA: "Zerodha (Kite)",
  UPSTOX: "Upstox",
  DHAN: "Dhan",
  FYERS: "Fyers",
  ANGEL_ONE: "Angel One",
  GROWW: "Groww",
  ICICI: "ICICI Direct",
  HDFC: "HDFC Securities",
  INTERACTIVE_BROKERS: "Interactive Brokers",
};

// ---------- Types ----------

interface BrokerOption {
  value: string;
  label: string;
}

interface RoastHistoryEntry {
  id: string;
  sessionId: string;
  mode: string;
  broker: string | null;
  assetType: string;
  status: string;
  score: number | null;
  errorMessage: string | null;
  createdAt: Date;
}

// ---------- Helpers ----------

const STUCK_THRESHOLD_MS = 300_000; // 5 minutes

function isStuck(createdAt: Date): boolean {
  return Date.now() - new Date(createdAt).getTime() > STUCK_THRESHOLD_MS;
}

function statusBadge(status: string, errorMessage?: string | null) {
  if (status === "COMPLETED") return null;
  if (status === "FAILED") {
    const isCancelled = errorMessage === "Cancelled by user";
    return (
      <span
        className="pf-pill outline"
        style={{
          fontSize: 9.5,
          padding: "2px 7px",
          color: isCancelled ? "var(--pop-2)" : "var(--pop-1)",
          borderColor: isCancelled ? "var(--pop-2)" : "var(--pop-1)",
        }}
      >
        {isCancelled ? "Cancelled" : "Failed"}
      </span>
    );
  }
  return null;
}

function formatAssetType(assetType: string): string {
  switch (assetType.toLowerCase()) {
    case "all":
      return "All Assets";
    case "stocks":
      return "Stocks";
    case "mf":
      return "Mutual Funds";
    default:
      return assetType;
  }
}

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

// ---------- Main Client ----------

export default function RoastClient({ isDemo }: { isDemo?: boolean }) {
  const router = useRouter();
  const { user, isLoaded } = useUser();

  const [mode, setMode] = useState<"overall" | "broker">("overall");
  const [selectedBroker, setSelectedBroker] = useState<string>("");
  const [assetType, setAssetType] = useState<"stocks" | "mf" | "all">("all");
  // MONEY-145 design - scope picker. 4 source options + 5 time ranges.
  const [scopeSource, setScopeSource] = useState<
    "all-synced" | "broker" | "tradebook" | "watchlist"
  >("all-synced");
  const [timeRange, setTimeRange] = useState<
    "all-time" | "last-30d" | "fy-2026" | "fy-2025" | "custom"
  >("all-time");
  const [selectedWatchlistId, setSelectedWatchlistId] = useState<string>("");
  // MONEY-837: tradebook-subset inputs (the "specific trade" scope).
  const [tradeSymbols, setTradeSymbols] = useState<string>("");
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorType, setErrorType] = useState<RoastErrorType | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [brokerOptions, setBrokerOptions] = useState<BrokerOption[]>([]);
  const [pageLoading, setPageLoading] = useState(true);
  const [holdingsCount, setHoldingsCount] = useState(0);
  const [portfolioValueINR, setPortfolioValueINR] = useState(0);

  // Credit state
  const [creditInfo, setCreditInfo] = useState<{
    allowed: boolean;
    isFreeRoast: boolean;
    message?: string;
    remainingCredits?: number;
  } | null>(null);

  // Running roasts
  const [runningRoasts, setRunningRoasts] = useState<
    Array<{
      sessionId: string;
      mode: string;
      broker: string | null;
      assetType: string;
      status: string;
      progress: number;
      currentStep: string | null;
      createdAt: Date;
    }>
  >([]);
  const [isLoadingRunning, setIsLoadingRunning] = useState(true);
  const runningPollRef = useRef<NodeJS.Timeout | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  // History state
  const [history, setHistory] = useState<RoastHistoryEntry[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [currentPage, setCurrentPage] = useState(0); // 0-indexed
  const [statusFilter, setStatusFilter] = useState<
    "ALL" | "COMPLETED" | "FAILED"
  >("ALL");
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const PAGE_SIZE = 20;

  const isDemoMode = isDemo ?? false;
  const [userPlanId, setUserPlanId] = useState<string>("FREE");
  const isFreeUser = userPlanId === "FREE";

  // Bust the stale Router Cache once on mount. Navigating back to /roast from a
  // roast detail page (especially while a roast is still running) could serve a
  // prefetched snapshot that bounced to the previous roast instead of the live
  // list. A one-shot refresh forces a fresh server render of the list.
  const didRefreshRef = useRef(false);
  useEffect(() => {
    if (didRefreshRef.current) return;
    didRefreshRef.current = true;
    router.refresh();
  }, [router]);

  // Load broker connections, credit info & subscription
  useEffect(() => {
    if (!isLoaded) return;
    if (!user) {
      if (!isDemoMode) {
        router.push("/home");
        return;
      }
      setPageLoading(false);
      return;
    }

    Promise.all([
      getBrokerConnectionsAction(),
      canUseRoastAction(),
      getSubscriptionAction(),
      getHoldingsAction(),
    ]).then(([brokerRes, creditRes, subRes, holdingsRes]) => {
      if (brokerRes.success && brokerRes.data) {
        const seen = new Set<string>();
        const options: BrokerOption[] = [];
        for (const c of brokerRes.data as BrokerConnectionInfo[]) {
          // MONEY-837: the founder-only Connect app is never a roast source.
          if (c.broker === "ZERODHA_CONNECT") continue;
          // Key by broker + account so MULTIPLE accounts on the same broker
          // (e.g. two Zerodha logins) each appear — not collapsed to one. Every
          // other selector (holdings/tradebook/positions) keys this way too.
          const value = `${c.broker}:${c.brokerUserId || ""}`;
          if (seen.has(value)) continue;
          seen.add(value);
          const base = BROKER_DISPLAY_NAMES[c.broker as BrokerType] || c.broker;
          const label =
            c.accountName ||
            (c.brokerUserId ? `${base} · ${c.brokerUserId}` : base);
          options.push({ value, label });
        }
        setBrokerOptions(options);
        if (options.length > 0) {
          setSelectedBroker(options[0].value);
        }
      }
      if (holdingsRes?.success && holdingsRes.data) {
        setHoldingsCount(holdingsRes.data.holdings.length);
        setPortfolioValueINR(holdingsRes.data.summary.totalCurrent || 0);
      }
      setCreditInfo(creditRes);
      if (subRes.success && subRes.data) {
        setUserPlanId(subRes.data.planId);
      }
      // Force overall mode for free users (no broker/asset selection)
      if (!subRes.success || !subRes.data || subRes.data.planId === "FREE") {
        setMode("overall");
        setAssetType("all");
      }
      setPageLoading(false);
    });
  }, [isLoaded, user, router, isDemoMode]);

  // Poll running roasts
  const loadRunning = useCallback(async () => {
    const res = await getRunningRoastsAction();
    if (res?.success && res?.data) {
      setRunningRoasts(res?.data);
    }
    setIsLoadingRunning(false);
  }, []);

  useEffect(() => {
    loadRunning();
    runningPollRef.current = setInterval(loadRunning, 5000);
    return () => {
      if (runningPollRef.current) clearInterval(runningPollRef.current);
    };
  }, [loadRunning]);

  // Load history
  const loadHistory = useCallback(
    async (page0: number) => {
      setIsLoadingHistory(true);
      const res = await getRoastHistoryAction(page0 + 1, PAGE_SIZE);
      if (res?.success && res?.data) {
        setHistory(res?.data.items as RoastHistoryEntry[]);
        setTotalItems(res?.data.total);
      }
      setIsLoadingHistory(false);
    },
    [PAGE_SIZE]
  );

  useEffect(() => {
    loadHistory(currentPage);
  }, [currentPage, loadHistory]);

  const handleRoast = async () => {
    setIsLoading(true);
    setError(null);
    setErrorType(null);
    setWarnings([]);

    const isBrokerScope = scopeSource === "broker";
    const scope: "PORTFOLIO" | "TRADEBOOK" =
      scopeSource === "tradebook" ? "TRADEBOOK" : "PORTFOLIO";

    // selectedBroker is "BROKER:brokerUserId" (account-scoped). Split it so the
    // validation + scope target the specific account, not just the broker enum.
    const [scopeBroker, scopeBrokerUserId] = selectedBroker.split(":");
    const useBrokerScope =
      (isBrokerScope || mode === "broker") && Boolean(scopeBroker);

    // Resolve the time-range chip → ISO date bounds (Indian FY = Apr 1–Mar 31).
    const now = new Date();
    let dateFrom: string | undefined;
    let dateTo: string | undefined;
    if (timeRange === "last-30d") {
      const from = new Date(now);
      from.setDate(from.getDate() - 30);
      dateFrom = from.toISOString();
      dateTo = now.toISOString();
    } else if (timeRange === "fy-2026") {
      dateFrom = "2025-04-01T00:00:00.000Z";
      dateTo = "2026-03-31T23:59:59.999Z";
    } else if (timeRange === "fy-2025") {
      dateFrom = "2024-04-01T00:00:00.000Z";
      dateTo = "2025-03-31T23:59:59.999Z";
    } else if (timeRange === "custom") {
      if (customFrom) dateFrom = `${customFrom}T00:00:00.000Z`;
      if (customTo) dateTo = `${customTo}T23:59:59.999Z`;
    }

    const symbolList = tradeSymbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    const params: RoastParams = {
      mode: isBrokerScope ? "broker" : mode,
      assetType,
      scope,
      ...(useBrokerScope
        ? {
            broker: scopeBroker,
            ...(scopeBrokerUserId ? { brokerUserId: scopeBrokerUserId } : {}),
          }
        : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
      ...(scope === "TRADEBOOK" && symbolList.length
        ? { symbols: symbolList }
        : {}),
    };

    const result = await startRoastAction(params);

    if (result?.success && result.sessionId) {
      if (result.warnings) setWarnings(result.warnings);
      router.push(`/roast/${result.sessionId}`);
      return;
    } else {
      setError(result?.error || "Something went wrong");
      setErrorType(result?.errorType || null);
    }

    setIsLoading(false);
  };

  const handleCancel = async (sessionId: string) => {
    setCancellingId(sessionId);
    await cancelRoastAction(sessionId);
    setRunningRoasts((prev) => prev.filter((r) => r.sessionId !== sessionId));
    loadHistory(currentPage);
    setCancellingId(null);
  };

  const handleRetry = async (entry: RoastHistoryEntry) => {
    setRetryingId(entry.id);
    const result = await startRoastAction({
      mode: entry.mode as "overall" | "broker",
      assetType: entry.assetType as "stocks" | "mf" | "all",
      ...(entry.broker ? { broker: entry.broker } : {}),
    });
    if (result?.success && result.sessionId) {
      router.push(`/roast/${result.sessionId}`);
    }
    setRetryingId(null);
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDeletingId(id);
    const res = await deleteRoastAction(id);
    if (res?.success) {
      setHistory((prev) => prev.filter((h) => h.id !== id));
      setTotalItems((prev) => prev - 1);
    }
    setDeletingId(null);
  };

  // Client-side filter
  const filteredHistory =
    statusFilter === "ALL"
      ? history
      : history.filter((h) => h.status === statusFilter);

  const totalPages = Math.ceil(totalItems / PAGE_SIZE);
  const hasBrokers = brokerOptions.length > 0;
  // When user picks "Specific broker" they must select one in the dropdown.
  const brokerScopeValid =
    scopeSource !== "broker" || selectedBroker.length > 0;
  const canRoast =
    (creditInfo?.allowed ?? false) && hasBrokers && brokerScopeValid;

  return (
    <PageGuard
      route="/roast"
      fallback={<RoastSkeleton />}
      containerClassName="p-6 pb-24 max-w-5xl mx-auto"
      title=""
    >
      <div className="pf-app min-h-screen">
        <Sidebar />

        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="p-6 pb-24 max-w-5xl mx-auto">
            {/* Hero - playful pf-ph header with coral roast identity */}
            <PfPageHead
              className="pf-ph-roast"
              eyebrow="BRUTALLY HONEST · AI CRITIQUE"
              title={
                <>
                  Portfolio <span className="hl-roast">Roast.</span>
                </>
              }
              sub="Brutally honest AI critique. Sugar-free. Skim-safe. Run anytime."
              right={
                <div
                  className="pf-av-sq"
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background: "var(--pop-1)",
                    color: "#fff",
                  }}
                  aria-hidden
                >
                  <Flame className="h-[22px] w-[22px]" />
                </div>
              }
            />
            <style>{`
              .hl-roast {
                background: var(--pop-1);
                color: #fff;
                padding: 0 6px;
                border-radius: 4px;
              }
              .pf-ph-roast .eyebrow { color: var(--pop-1); }
              .pf-ph-roast .eyebrow .d { background: var(--pop-1); }
            `}</style>

            {isDemoMode && <DemoBanner />}

            {pageLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-3)]" />
              </div>
            ) : (
              <div>
                {/* MONEY-145 - Roast Scope picker per design.
                    Section 1: WHAT TO ROAST (4 options)
                    Section 2: TIME RANGE (5 options) */}
                <RoastScopePicker
                  scopeSource={scopeSource}
                  setScopeSource={setScopeSource}
                  timeRange={timeRange}
                  setTimeRange={setTimeRange}
                  selectedBroker={selectedBroker}
                  setSelectedBroker={(next) => {
                    setSelectedBroker(next);
                    if (next.length > 0 && mode === "overall")
                      setMode("broker");
                  }}
                  brokerOptions={brokerOptions}
                  assetType={assetType}
                  setAssetType={setAssetType}
                  isFreeUser={isFreeUser}
                  totalHoldings={holdingsCount}
                  totalValue={portfolioValueINR}
                  tradeSymbols={tradeSymbols}
                  setTradeSymbols={setTradeSymbols}
                  customFrom={customFrom}
                  setCustomFrom={setCustomFrom}
                  customTo={customTo}
                  setCustomTo={setCustomTo}
                />

                {/* Big "Roast me on this scope" CTA - coral playful solid */}
                <button
                  onClick={() => {
                    if (canRoast) handleRoast();
                  }}
                  disabled={!canRoast || isLoading}
                  className="pf-roast-cta w-full mb-7 px-4 py-4 rounded-xl text-white font-extrabold text-[15px] tracking-[-0.2px] flex items-center justify-center gap-2.5 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed border-2"
                  style={{
                    background: "var(--pop-1)",
                    borderColor: "var(--ink)",
                    boxShadow: "var(--shadow-soft)",
                  }}
                >
                  {isLoading ? (
                    <Loader2 className="h-[18px] w-[18px] animate-spin" />
                  ) : (
                    <Flame className="h-[18px] w-[18px]" />
                  )}
                  Roast me on this scope
                  <span
                    className="ml-2 px-2 py-0.5 rounded-full font-mono text-[11px] font-semibold"
                    style={{ background: "rgba(0,0,0,.22)" }}
                  >
                    {creditInfo?.isFreeRoast
                      ? `${creditInfo.remainingCredits ?? 0} free left`
                      : "1 credit"}
                  </span>
                </button>
                <style>{`
                  .pf-roast-cta { transition: transform .12s, box-shadow .12s; }
                  .pf-roast-cta:not(:disabled):hover {
                    transform: translate(-1px, -1px);
                    box-shadow: 4px 4px 0 var(--ink);
                  }
                `}</style>

                {/* Advanced configurator - kept available for power users
                    but collapsed by default since the scope picker above
                    covers the primary flow per the design. */}
                <details className="group mb-4 rounded-[12px] border-2 border-[var(--ink)] bg-[var(--rule-softer)] overflow-hidden">
                  <summary className="flex items-center gap-2.5 px-[22px] py-3 cursor-pointer list-none select-none">
                    <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-[var(--ink-3)] font-bold">
                      Advanced (asset class · broker)
                    </span>
                    <span className="font-mono text-[11px] text-[var(--ink-3)]">
                      {isFreeUser
                        ? "free roast · whole portfolio"
                        : `mode: ${mode} · ${assetType}${selectedBroker ? ` · ${selectedBroker}` : ""}`}
                    </span>
                    <div className="flex-1" />
                    <span
                      className="font-mono text-[11px] group-open:hidden"
                      style={{ color: "var(--emerald)" }}
                    >
                      tap to expand
                    </span>
                    <span className="font-mono text-[11px] text-[var(--ink-3)] hidden group-open:inline">
                      tap to collapse
                    </span>
                  </summary>
                  <div className="border-t-2 border-[var(--ink)] p-[22px]">
                    <div className="flex flex-wrap items-end gap-4">
                      {/* Mode - hidden for free users (forced to overall) */}
                      {!isFreeUser && (
                        <div className="space-y-1.5">
                          <label className="text-xs text-[var(--ink-3)] font-medium">
                            Mode
                          </label>
                          <Select
                            value={mode}
                            onValueChange={(v) =>
                              setMode(v as "overall" | "broker")
                            }
                          >
                            <SelectTrigger className="w-40">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="overall">
                                Overall Portfolio
                              </SelectItem>
                              <SelectItem value="broker">By Broker</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {/* Broker (conditional) - hidden for free users */}
                      {!isFreeUser &&
                        mode === "broker" &&
                        brokerOptions.length > 0 && (
                          <div className="space-y-1.5">
                            <label className="text-xs text-[var(--ink-3)] font-medium">
                              Broker
                            </label>
                            <Select
                              value={selectedBroker}
                              onValueChange={setSelectedBroker}
                            >
                              <SelectTrigger className="w-48">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {brokerOptions.map((b) => (
                                  <SelectItem key={b.value} value={b.value}>
                                    {b.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}

                      {/* Asset Type - hidden for free users (forced to all) */}
                      {!isFreeUser && (
                        <div className="space-y-1.5">
                          <label className="text-xs text-[var(--ink-3)] font-medium">
                            Asset Type
                          </label>
                          <Select
                            value={assetType}
                            onValueChange={(v) =>
                              setAssetType(v as "stocks" | "mf" | "all")
                            }
                          >
                            <SelectTrigger className="w-40">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all">All Assets</SelectItem>
                              <SelectItem value="stocks">
                                Stocks Only
                              </SelectItem>
                              <SelectItem value="mf">
                                Mutual Funds Only
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {/* Roast button */}
                      <DemoGate
                        isDemoMode={isDemoMode}
                        message="Sign up to roast your portfolio"
                      >
                        <button
                          type="button"
                          onClick={handleRoast}
                          disabled={isLoading || !canRoast}
                          className="pf-bs"
                          style={{
                            background: "var(--pop-1)",
                            color: "#fff",
                            opacity: isLoading || !canRoast ? 0.6 : 1,
                            cursor:
                              isLoading || !canRoast
                                ? "not-allowed"
                                : "pointer",
                          }}
                        >
                          {isLoading ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Starting...
                            </>
                          ) : (
                            <>
                              <Flame className="h-4 w-4" />
                              Roast It!
                            </>
                          )}
                        </button>
                      </DemoGate>
                    </div>

                    {/* No broker connected */}
                    {!hasBrokers && !pageLoading && (
                      <div className="mt-3 flex items-center gap-2 text-xs">
                        <AlertTriangle
                          className="h-3.5 w-3.5"
                          style={{ color: "var(--pop-2)" }}
                        />
                        <span style={{ color: "var(--pop-2)" }}>
                          Connect a broker first to roast your portfolio.
                        </span>
                        <button
                          type="button"
                          className="underline underline-offset-2 text-xs font-semibold"
                          style={{ color: "var(--pop-3)" }}
                          onClick={() => router.push("/brokers")}
                        >
                          Connect Broker
                        </button>
                      </div>
                    )}

                    {/* Credit info */}
                    {creditInfo && hasBrokers && (
                      <div className="mt-3 flex items-center gap-2 text-xs">
                        {creditInfo.allowed ? (
                          creditInfo.isFreeRoast ? (
                            <>
                              <Sparkles
                                className="h-3.5 w-3.5"
                                style={{ color: "var(--pop-1)" }}
                              />
                              <span style={{ color: "var(--pop-1)" }}>
                                Free roast available (1 per month)
                              </span>
                            </>
                          ) : (
                            <>
                              <Info
                                className="h-3.5 w-3.5"
                                style={{ color: "var(--pop-3)" }}
                              />
                              <span style={{ color: "var(--pop-3)" }}>
                                Uses 1 advanced credit
                                {creditInfo.remainingCredits !== undefined &&
                                  ` (${creditInfo.remainingCredits} remaining)`}
                              </span>
                            </>
                          )
                        ) : (
                          <>
                            <AlertTriangle
                              className="h-3.5 w-3.5"
                              style={{ color: "var(--pop-2)" }}
                            />
                            <span style={{ color: "var(--pop-2)" }}>
                              {creditInfo.message}
                            </span>
                            <button
                              type="button"
                              className="underline underline-offset-2 text-xs font-semibold"
                              style={{ color: "var(--pop-1)" }}
                              onClick={() => router.push("/pricing")}
                            >
                              Upgrade
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </details>

                {/* Warnings */}
                {warnings.length > 0 && (
                  <div className="mb-4 space-y-2">
                    {warnings.map((w, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-2 p-3 rounded-lg border-[1.5px]"
                        style={{
                          background:
                            "color-mix(in srgb, var(--pop-2) 10%, transparent)",
                          borderColor:
                            "color-mix(in srgb, var(--pop-2) 30%, transparent)",
                        }}
                      >
                        <AlertTriangle
                          className="h-4 w-4 flex-shrink-0 mt-0.5"
                          style={{ color: "var(--pop-2)" }}
                        />
                        <p
                          className="text-sm"
                          style={{ color: "var(--pop-2)" }}
                        >
                          {w}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Error with CTA */}
                {error && (
                  <div
                    className="pf-card mb-6"
                    style={{
                      borderColor: "var(--pop-1)",
                      background:
                        "color-mix(in srgb, var(--pop-1) 6%, var(--paper))",
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <AlertTriangle
                        className="h-5 w-5 flex-shrink-0 mt-0.5"
                        style={{ color: "var(--pop-1)" }}
                      />
                      <div className="flex-1">
                        <p
                          className="font-bold text-sm"
                          style={{ color: "var(--pop-1)" }}
                        >
                          {errorType === "NOT_CONNECTED"
                            ? "Broker Not Connected"
                            : errorType === "NEEDS_REAUTH"
                              ? "Broker Session Expired"
                              : errorType === "NEVER_SYNCED"
                                ? "Broker Not Synced"
                                : errorType === "NO_DATA"
                                  ? "No Portfolio Data"
                                  : errorType === "NO_CREDITS"
                                    ? "No Credits"
                                    : "Error"}
                        </p>
                        <p className="text-sm text-[var(--ink-2)] mt-1">
                          {error}
                        </p>
                        {(errorType === "NOT_CONNECTED" ||
                          errorType === "NEEDS_REAUTH" ||
                          errorType === "NEVER_SYNCED") && (
                          <button
                            type="button"
                            onClick={() => router.push("/brokers")}
                            className="pf-bf mt-3"
                            style={{
                              color: "var(--pop-1)",
                              borderColor: "var(--pop-1)",
                            }}
                          >
                            <ExternalLink className="h-3 w-3" />
                            Go to Brokers Page
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Running Roasts */}
                {(isLoadingRunning || runningRoasts.length > 0) && (
                  <div className="pf-card mb-6">
                    <div className="flex items-center gap-2 mb-3">
                      <Activity
                        className="h-4 w-4"
                        style={{ color: "var(--emerald)" }}
                      />
                      <span className="text-sm font-bold text-[var(--ink)]">
                        Running Roasts
                      </span>
                    </div>
                    {isLoadingRunning ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-3)]" />
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {runningRoasts.map((roast) => {
                          const stuck = isStuck(roast.createdAt);
                          return (
                            <div
                              key={roast.sessionId}
                              className="flex items-center gap-3 p-3 rounded-lg border-[1.5px] border-[var(--rule-soft)] transition-colors hover:border-[var(--emerald)]"
                            >
                              <Link
                                href={`/roast/${roast.sessionId}`}
                                className="flex items-center gap-3 flex-1 min-w-0"
                              >
                                <div className="flex-shrink-0">
                                  {stuck ? (
                                    <AlertTriangle
                                      className="h-5 w-5"
                                      style={{ color: "var(--pop-2)" }}
                                    />
                                  ) : (
                                    <Loader2
                                      className="h-5 w-5 animate-spin"
                                      style={{ color: "var(--emerald)" }}
                                    />
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1.5">
                                    <span className="font-bold text-sm capitalize text-[var(--ink)]">
                                      {roast.mode}
                                    </span>
                                    {roast.broker && (
                                      <span
                                        className="pf-pill outline"
                                        style={{
                                          fontSize: 9.5,
                                          padding: "2px 7px",
                                        }}
                                      >
                                        {roast.broker}
                                      </span>
                                    )}
                                    <span
                                      className="pf-pill outline"
                                      style={{
                                        fontSize: 9.5,
                                        padding: "2px 7px",
                                        color: "var(--emerald)",
                                        borderColor: "var(--emerald)",
                                      }}
                                    >
                                      {roast.status}
                                    </span>
                                    {stuck && (
                                      <span
                                        className="pf-pill outline"
                                        style={{
                                          fontSize: 9.5,
                                          padding: "2px 7px",
                                          color: "var(--pop-2)",
                                          borderColor: "var(--pop-2)",
                                        }}
                                      >
                                        Stuck
                                      </span>
                                    )}
                                  </div>
                                  <div
                                    className="h-1.5 mb-1 rounded-full overflow-hidden border-[1.5px] border-[var(--ink)]"
                                    style={{ background: "var(--rule-softer)" }}
                                  >
                                    <div
                                      className="h-full rounded-full"
                                      style={{
                                        width: `${roast.progress}%`,
                                        background: "var(--emerald)",
                                      }}
                                    />
                                  </div>
                                  <p className="text-xs text-[var(--ink-3)] truncate">
                                    {roast.currentStep || "Queued..."}
                                  </p>
                                </div>
                              </Link>
                              <button
                                onClick={() => handleCancel(roast.sessionId)}
                                disabled={cancellingId === roast.sessionId}
                                className="flex-shrink-0 p-1.5 rounded-md text-[var(--ink-3)] transition-colors hover:text-[var(--pop-1)]"
                                title="Cancel roast"
                              >
                                {cancellingId === roast.sessionId ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <XCircle className="h-4 w-4" />
                                )}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* Empty state (only when no running roasts and no history) */}
                {!error &&
                  !isLoading &&
                  runningRoasts.length === 0 &&
                  !isLoadingHistory &&
                  history.length === 0 && (
                    <div className="pf-card mb-6 py-16 text-center">
                      <Flame
                        className="h-12 w-12 mx-auto mb-4"
                        style={{ color: "var(--pop-1)", opacity: 0.4 }}
                      />
                      <p className="text-[var(--ink-2)] mb-1 font-semibold">
                        Ready to get roasted?
                      </p>
                      <p className="text-sm text-[var(--ink-3)]">
                        Select your options and hit &quot;Roast It!&quot; to get
                        a savage AI analysis of your portfolio
                      </p>
                    </div>
                  )}

                {/* Past Roasts (inline history) */}
                <div className="mt-6">
                  <div className="pf-sec-h">
                    <span className="n">HISTORY</span>
                    <span className="rule" />
                    <span className="meta">
                      {totalItems} {totalItems === 1 ? "roast" : "roasts"}
                    </span>
                  </div>
                  <div className="pf-card">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-bold flex items-center gap-2 text-[var(--ink)]">
                        <History
                          className="h-4 w-4"
                          style={{ color: "var(--ink-3)" }}
                        />
                        Past Roasts
                      </span>
                      {/* Status filter tabs */}
                      <div className="flex items-center gap-1.5">
                        {(["ALL", "COMPLETED", "FAILED"] as const).map(
                          (filter) => {
                            const active = statusFilter === filter;
                            return (
                              <button
                                type="button"
                                key={filter}
                                onClick={() => setStatusFilter(filter)}
                                className="pf-pill"
                                style={{
                                  fontSize: 10,
                                  cursor: "pointer",
                                  background: active
                                    ? "var(--ink)"
                                    : "transparent",
                                  color: active ? "var(--paper)" : "var(--ink)",
                                }}
                              >
                                {filter === "ALL"
                                  ? "All"
                                  : filter === "COMPLETED"
                                    ? "Completed"
                                    : "Failed"}
                              </button>
                            );
                          }
                        )}
                      </div>
                    </div>
                    <div>
                      {isLoadingHistory ? (
                        <div className="flex items-center justify-center py-6">
                          <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-3)]" />
                        </div>
                      ) : filteredHistory.length === 0 ? (
                        <div
                          className="rounded-[14px] border-[1.5px] border-dashed p-12 text-center"
                          style={{
                            borderColor: "var(--rule-soft)",
                            background: "var(--rule-softer)",
                          }}
                        >
                          <Flame className="h-7 w-7 text-[var(--ink-3)] mx-auto mb-3" />
                          <div className="text-base font-extrabold text-[var(--ink)] mb-1.5">
                            {statusFilter !== "ALL"
                              ? `No ${statusFilter.toLowerCase()} roasts`
                              : "No roasts yet"}
                          </div>
                          <div className="text-[13px] text-[var(--ink-3)] mb-4">
                            {statusFilter !== "ALL"
                              ? "Try a different filter or run a fresh roast."
                              : "Connect a broker, then run your first roast."}
                          </div>
                          {statusFilter === "ALL" && (
                            <button
                              onClick={() => {
                                if (canRoast) handleRoast();
                              }}
                              disabled={!canRoast || isLoading}
                              className="pf-bs inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                              style={{
                                background: "var(--pop-1)",
                                color: "#fff",
                              }}
                            >
                              {isLoading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Flame className="h-3.5 w-3.5" />
                              )}
                              Run first roast
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="space-y-2.5">
                          {filteredHistory.map((entry, idx) => {
                            const isFailed = entry.status === "FAILED";
                            const isCancelled =
                              isFailed &&
                              entry.errorMessage === "Cancelled by user";
                            const isLatest = idx === 0 && !isFailed;
                            const score = entry.score ?? null;
                            const scoreColor =
                              score === null
                                ? "var(--ink-3)"
                                : score >= 75
                                  ? "var(--emerald)"
                                  : score >= 60
                                    ? "var(--pop-2)"
                                    : "var(--pop-1)";
                            const baseBorder = isLatest
                              ? "color-mix(in srgb, var(--pop-1) 30%, transparent)"
                              : isFailed
                                ? isCancelled
                                  ? "color-mix(in srgb, var(--pop-2) 30%, transparent)"
                                  : "color-mix(in srgb, var(--pop-1) 30%, transparent)"
                                : "var(--rule-soft)";

                            return (
                              <div
                                key={entry.id}
                                className="flex items-center gap-4 px-5 py-4 rounded-xl border-[1.5px] transition-colors cursor-pointer"
                                style={{
                                  background: isLatest
                                    ? "color-mix(in srgb, var(--pop-1) 6%, transparent)"
                                    : isFailed
                                      ? isCancelled
                                        ? "color-mix(in srgb, var(--pop-2) 6%, transparent)"
                                        : "color-mix(in srgb, var(--pop-1) 6%, transparent)"
                                      : "var(--rule-softer)",
                                  borderColor: baseBorder,
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.borderColor =
                                    "var(--ink)";
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.borderColor =
                                    baseBorder;
                                }}
                                onClick={() =>
                                  router.push(
                                    entry.status === "COMPLETED"
                                      ? `/roast/${entry.id}`
                                      : `/roast/${entry.sessionId}`
                                  )
                                }
                              >
                                {/* Flame tile (44px) - coral for latest, mute for older */}
                                <div
                                  className="w-11 h-11 rounded-[10px] flex items-center justify-center flex-shrink-0 border-[1.5px]"
                                  style={{
                                    background: isLatest
                                      ? "var(--pop-1)"
                                      : isFailed
                                        ? isCancelled
                                          ? "color-mix(in srgb, var(--pop-2) 12%, transparent)"
                                          : "color-mix(in srgb, var(--pop-1) 12%, transparent)"
                                        : "var(--rule-softer)",
                                    borderColor: isLatest
                                      ? "var(--ink)"
                                      : "var(--rule-soft)",
                                  }}
                                >
                                  {isCancelled ? (
                                    <XCircle
                                      className="h-5 w-5"
                                      style={{ color: "var(--pop-2)" }}
                                    />
                                  ) : isFailed ? (
                                    <AlertTriangle
                                      className="h-5 w-5"
                                      style={{ color: "var(--pop-1)" }}
                                    />
                                  ) : (
                                    <Flame
                                      className="h-5 w-5"
                                      style={{
                                        color: isLatest
                                          ? "#fff"
                                          : "var(--ink-3)",
                                      }}
                                    />
                                  )}
                                </div>

                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap mb-1">
                                    <span className="text-sm font-extrabold text-[var(--ink)] capitalize">
                                      {entry.mode}
                                    </span>
                                    <span className="font-mono text-[11px] text-[var(--ink-3)]">
                                      ·{" "}
                                      {new Date(
                                        entry.createdAt
                                      ).toLocaleDateString("en-IN", {
                                        day: "numeric",
                                        month: "short",
                                        year: "numeric",
                                      })}
                                    </span>
                                    {isLatest && (
                                      <span
                                        className="pf-pill gold"
                                        style={{
                                          fontSize: 9.5,
                                          padding: "2px 7px",
                                        }}
                                      >
                                        Latest
                                      </span>
                                    )}
                                    {entry.broker && (
                                      <span
                                        className="pf-pill outline uppercase"
                                        style={{
                                          fontSize: 9.5,
                                          padding: "2px 7px",
                                        }}
                                      >
                                        {entry.broker}
                                      </span>
                                    )}
                                    {statusBadge(
                                      entry.status,
                                      entry.errorMessage
                                    )}
                                  </div>
                                  <p className="text-[12.5px] text-[var(--ink-3)] truncate leading-[1.45]">
                                    {isCancelled
                                      ? "Cancelled by user"
                                      : isFailed
                                        ? entry.errorMessage || "Roast failed"
                                        : `${formatAssetType(entry.assetType)}`}
                                  </p>
                                </div>

                                {/* Score (mono 22px) + arrow */}
                                <div className="text-right flex-shrink-0">
                                  {score !== null && !isFailed ? (
                                    <>
                                      <div
                                        className="font-mono text-[22px] font-bold tabular-nums leading-none"
                                        style={{
                                          color: scoreColor,
                                          letterSpacing: "-0.5px",
                                        }}
                                      >
                                        {score}
                                      </div>
                                      <div className="font-mono text-[9.5px] text-[var(--ink-3)] tracking-[1px] font-bold mt-0.5">
                                        / 100
                                      </div>
                                    </>
                                  ) : (
                                    <div
                                      className="font-mono text-[11px] font-bold tracking-[0.3px]"
                                      style={{
                                        color: isCancelled
                                          ? "var(--pop-2)"
                                          : "var(--pop-1)",
                                      }}
                                    >
                                      {isCancelled ? "CANCELLED" : "FAILED"}
                                    </div>
                                  )}
                                </div>

                                <div className="flex items-center gap-2 flex-shrink-0">
                                  <span className="text-xs text-[var(--ink-3)] hidden sm:block">
                                    {relativeTime(entry.createdAt)}
                                  </span>
                                  {/* View button (for completed) */}
                                  {!isFailed && (
                                    <Link
                                      href={`/roast/${entry.id}`}
                                      onClick={(e) => e.stopPropagation()}
                                      className="p-1.5 rounded text-[var(--ink-3)] transition-colors hover:text-[var(--ink)] hover:bg-[var(--rule-softer)]"
                                      title="View roast"
                                    >
                                      <Eye className="h-3.5 w-3.5" />
                                    </Link>
                                  )}
                                  {/* Retry button (for actual failures, not cancelled) */}
                                  {isFailed && !isCancelled && (
                                    <button
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleRetry(entry);
                                      }}
                                      disabled={retryingId === entry.id}
                                      className="p-1 rounded text-[var(--ink-3)] transition-colors hover:text-[var(--pop-1)] disabled:opacity-50"
                                      title="Retry roast"
                                    >
                                      {retryingId === entry.id ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        <RotateCcw className="h-3.5 w-3.5" />
                                      )}
                                    </button>
                                  )}
                                  {/* Delete button */}
                                  <button
                                    onClick={(e) => handleDelete(e, entry.id)}
                                    disabled={deletingId === entry.id}
                                    className="p-1 rounded text-[var(--ink-3)] transition-colors hover:text-[var(--pop-1)] disabled:opacity-50"
                                    title="Delete roast"
                                  >
                                    {deletingId === entry.id ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Trash2 className="h-3.5 w-3.5" />
                                    )}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Pagination */}
                      {totalPages > 1 && (
                        <div className="mt-4">
                          <PaginationControls
                            currentPage={currentPage}
                            totalPages={totalPages}
                            onPageChange={setCurrentPage}
                            pageSize={PAGE_SIZE}
                            totalItems={totalItems}
                            label="roasts"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </PageGuard>
  );
}
