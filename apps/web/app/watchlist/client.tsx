"use client";

/**
 * Watchlist Page — Playful redesign (MONEY-485)
 *
 * Shows user's watchlists with real-time price updates.
 * Features:
 * - Multiple named watchlists (stocks or mutual funds)
 * - Add instruments via InstrumentSearch (filtered by watchlist type)
 * - Real-time price updates via useMarketData (stocks)
 * - MF NAV/returns data via getWatchlistMfDataAction (MFs)
 * - Remove items
 * - Create/delete watchlists with type selection
 *
 * Chrome: keeps the existing <Sidebar /> + <main> shell. Inside it the
 * content is re-skinned with the playful design system (pf-app / pf-page /
 * PfPageHead / pf-card / pf-tbl / pf-pill), mirroring DashboardOverview.
 */

import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react";
import { useRouter } from "next/navigation";
import { instrumentDetailHref } from "@/lib/fund/instrument-href";
import { useUser } from "@clerk/nextjs";
import { useIDBCache } from "@/hooks/useIDBCache";
import { clearIDBWatchlistCache } from "@/lib/idb-cache/invalidation";
import Sidebar from "@/components/Sidebar";

import { PageGuard } from "@/components/PageGuard";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { WatchlistSkeleton } from "@/components/skeletons";
import { DemoBanner, DemoGate } from "@/components/DemoBanner";
import InstrumentSearch from "@/components/InstrumentSearch";
import type { InstrumentSearchItem } from "@/components/InstrumentSearch";
import { useMarketData } from "@/hooks/useMarketData";
import { useSparklines } from "@/hooks/useSparklines";
import { useBrokerStatus } from "@/hooks/useBrokerStatus";
import BrokerReauthBanner from "@/components/BrokerReauthBanner";
import { Sparkline, autoTone } from "@/components/charts";
import ResearchModal, {
  type ResearchEntity,
} from "@/components/analysis/ResearchModal";
import { SymbolPickerDialog } from "@/components/watchlist/SymbolPickerDialog";
import {
  Plus,
  Trash2,
  Loader2,
  BarChart2,
  Landmark,
  X,
  Pencil,
  Check,
  Sparkles,
  Play,
} from "lucide-react";
import { formatCurrency } from "@usemoney/utils";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";
import {
  getWatchlistsAction,
  createWatchlistAction,
  deleteWatchlistAction,
  removeWatchlistItemAction,
  updateWatchlistAction,
  batchAddWatchlistItemsAction,
  getWatchlistMfDataAction,
  type WatchlistData,
  type MfWatchlistData,
} from "@/lib/actions/watchlist";

// ============== DEMO DATA ==============

const DEMO_WATCHLISTS: WatchlistData[] = [
  {
    id: "demo-watchlist-1",
    name: "My Watchlist",
    description: null,
    color: null,
    icon: null,
    type: "STOCK",
    isDefault: true,
    order: 0,
    itemCount: 5,
    updatedAt: new Date(),
    items: [
      {
        id: "dw-1",
        symbol: "RELIANCE",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 0,
        addedAt: new Date(),
      },
      {
        id: "dw-2",
        symbol: "TCS",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 1,
        addedAt: new Date(),
      },
      {
        id: "dw-3",
        symbol: "HDFCBANK",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 2,
        addedAt: new Date(),
      },
      {
        id: "dw-4",
        symbol: "INFY",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 3,
        addedAt: new Date(),
      },
      {
        id: "dw-5",
        symbol: "ICICIBANK",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 4,
        addedAt: new Date(),
      },
    ],
  },
  {
    id: "demo-watchlist-2",
    name: "IT Stocks",
    description: null,
    color: null,
    icon: null,
    type: "STOCK",
    isDefault: false,
    order: 1,
    itemCount: 3,
    updatedAt: new Date(),
    items: [
      {
        id: "dw-6",
        symbol: "TCS",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 0,
        addedAt: new Date(),
      },
      {
        id: "dw-7",
        symbol: "INFY",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 1,
        addedAt: new Date(),
      },
      {
        id: "dw-8",
        symbol: "WIPRO",
        exchange: "NSE",
        instrumentId: null,
        sortOrder: 2,
        addedAt: new Date(),
      },
    ],
  },
  {
    id: "demo-watchlist-3",
    name: "Top MFs",
    description: null,
    color: null,
    icon: null,
    type: "MF",
    isDefault: false,
    order: 2,
    itemCount: 3,
    updatedAt: new Date(),
    items: [
      {
        id: "dw-mf-1",
        symbol: "119551",
        exchange: "SBI Mutual Fund",
        instrumentId: null,
        sortOrder: 0,
        addedAt: new Date(),
      },
      {
        id: "dw-mf-2",
        symbol: "120505",
        exchange: "HDFC Mutual Fund",
        instrumentId: null,
        sortOrder: 1,
        addedAt: new Date(),
      },
      {
        id: "dw-mf-3",
        symbol: "118989",
        exchange: "ICICI Prudential Mutual Fund",
        instrumentId: null,
        sortOrder: 2,
        addedAt: new Date(),
      },
    ],
  },
];

// Demo MF data for when the user is in demo mode
const DEMO_MF_DATA = new Map<string, MfWatchlistData>([
  [
    "119551",
    {
      schemeCode: "119551",
      schemeName: "SBI Bluechip Fund - Direct Plan - Growth",
      amcName: "SBI Mutual Fund",
      category: "Equity",
      plan: "DIRECT",
      nav: 82.45,
      returns1Y: 18.5,
      returns3Y: 15.2,
      returns5Y: 14.8,
      riskLevel: "Moderately High",
      aum: 45000,
    },
  ],
  [
    "120505",
    {
      schemeCode: "120505",
      schemeName: "HDFC Mid-Cap Opportunities Fund - Direct Plan - Growth",
      amcName: "HDFC Mutual Fund",
      category: "Equity",
      plan: "DIRECT",
      nav: 145.3,
      returns1Y: 22.3,
      returns3Y: 18.7,
      returns5Y: 16.4,
      riskLevel: "High",
      aum: 38000,
    },
  ],
  [
    "118989",
    {
      schemeCode: "118989",
      schemeName: "ICICI Prudential Liquid Fund - Direct Plan - Growth",
      amcName: "ICICI Prudential Mutual Fund",
      category: "Debt",
      plan: "DIRECT",
      nav: 345.8,
      returns1Y: 7.2,
      returns3Y: 6.5,
      returns5Y: 6.8,
      riskLevel: "Low",
      aum: 52000,
    },
  ],
]);

// ============== HELPERS ==============

/** Format a volume number as "4.2M" / "680K" / "1.2B" for compact display. */
function formatVolume(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
}

// ============== WATCHLIST SELECTOR (memoized — re-renders only when lists, selection, or deltas change) ==============

const WatchlistSidebar = memo(function WatchlistSidebar({
  watchlists,
  activeWatchlistId,
  onSelect,
  showCreateForm,
  onShowCreateForm,
  newWatchlistName,
  onNewWatchlistNameChange,
  newWatchlistType,
  onNewWatchlistTypeChange,
  onCreateWatchlist,
  onCloseCreateForm,
  isDemoMode = false,
  deltas,
}: {
  watchlists: WatchlistData[];
  activeWatchlistId: string | null;
  onSelect: (id: string) => void;
  showCreateForm: boolean;
  onShowCreateForm: () => void;
  newWatchlistName: string;
  onNewWatchlistNameChange: (v: string) => void;
  newWatchlistType: "STOCK" | "MF";
  onNewWatchlistTypeChange: (v: "STOCK" | "MF") => void;
  onCreateWatchlist: () => void;
  onCloseCreateForm: () => void;
  isDemoMode?: boolean;
  /** Map of watchlistId → weighted change% (stocks) or average 1Y return (MFs). Null when not computable. */
  deltas: Map<string, number | null>;
}) {
  return (
    <div className="pf-wl-rail" style={{ width: "100%", flexShrink: 0 }}>
      <div
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: "var(--ink-3)",
          padding: "2px 2px 12px",
        }}
      >
        Your lists · {watchlists.length}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {watchlists.map((wl) => {
          const isActive = activeWatchlistId === wl.id;
          const delta = deltas.get(wl.id);
          const hasDelta = delta != null && Number.isFinite(delta);
          const isPos = hasDelta && delta! >= 0;
          return (
            <button
              key={wl.id}
              type="button"
              onClick={() => onSelect(wl.id)}
              className={`pf-card flat${isActive ? " pf-wl-active" : ""}`}
              style={{
                width: "100%",
                textAlign: "left",
                cursor: "pointer",
                padding: "12px 14px",
                background: isActive ? "var(--ink)" : "var(--paper)",
                color: isActive ? "var(--paper)" : "var(--ink)",
                border: isActive
                  ? "2px solid var(--ink)"
                  : "1.5px solid var(--rule-soft)",
                transition: "background .12s, color .12s, transform .12s",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13.5,
                    fontWeight: 700,
                  }}
                >
                  {wl.type === "MF" ? (
                    <Landmark
                      style={{
                        width: 14,
                        height: 14,
                        flexShrink: 0,
                        opacity: 0.7,
                      }}
                    />
                  ) : (
                    <BarChart2
                      style={{
                        width: 14,
                        height: 14,
                        flexShrink: 0,
                        opacity: 0.7,
                      }}
                    />
                  )}
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {wl.name}
                  </span>
                </div>
                {hasDelta ? (
                  <span
                    style={{
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 11,
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                      // The selected row is painted `background: var(--ink)`,
                      // i.e. INVERTED relative to the page — so it needs the
                      // on-ink pair, which flips the opposite way to the
                      // normal one. These were hardcoded bright values, right
                      // on light-mode ink (9.69:1) and unreadable on dark-mode
                      // ink, which is cream (1.50:1).
                      color: isActive
                        ? isPos
                          ? "var(--on-ink-positive)"
                          : "var(--on-ink-negative)"
                        : isPos
                          ? "var(--emerald)"
                          : "#b91c1c",
                    }}
                  >
                    {isPos ? "▲" : "▼"} {Math.abs(delta!).toFixed(2)}%
                  </span>
                ) : (
                  <span
                    style={{
                      fontFamily: "JetBrains Mono, monospace",
                      fontSize: 11,
                      color: isActive ? "var(--on-ink-muted)" : "var(--ink-3)",
                    }}
                  >
                    —
                  </span>
                )}
              </div>
              <div
                style={{
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 11,
                  color: isActive ? "var(--on-ink-muted)" : "var(--ink-3)",
                  marginTop: 4,
                }}
              >
                {wl.itemCount} {wl.type === "MF" ? "funds" : "stocks"}
              </div>
              {wl.description && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: isActive ? "var(--on-ink-muted)" : "var(--ink-3)",
                    marginTop: 5,
                    lineHeight: 1.35,
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {wl.description}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Create Watchlist */}
      <div style={{ marginTop: 12 }}>
        <DemoGate
          isDemoMode={isDemoMode}
          message="Sign up to create watchlists"
        >
          {showCreateForm ? (
            <div
              className="pf-card flat"
              style={{
                padding: 12,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <input
                value={newWatchlistName}
                onChange={(e) => onNewWatchlistNameChange(e.target.value)}
                placeholder="Watchlist name"
                className="pf-input"
                style={{ fontSize: 13, padding: "8px 10px" }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCreateWatchlist();
                  if (e.key === "Escape") onCloseCreateForm();
                }}
                autoFocus
              />
              {/* Type toggle */}
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => onNewWatchlistTypeChange("STOCK")}
                  className={`pf-pill${newWatchlistType === "STOCK" ? " emerald" : " outline"}`}
                  style={{
                    flex: 1,
                    justifyContent: "center",
                    padding: "7px 8px",
                    cursor: "pointer",
                  }}
                >
                  <BarChart2 style={{ width: 12, height: 12 }} />
                  Stocks
                </button>
                <button
                  type="button"
                  onClick={() => onNewWatchlistTypeChange("MF")}
                  className={`pf-pill${newWatchlistType === "MF" ? " emerald" : " outline"}`}
                  style={{
                    flex: 1,
                    justifyContent: "center",
                    padding: "7px 8px",
                    cursor: "pointer",
                  }}
                >
                  <Landmark style={{ width: 12, height: 12 }} />
                  Mutual Funds
                </button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="pf-bs sm"
                  style={{ flex: 1, justifyContent: "center" }}
                  onClick={onCreateWatchlist}
                >
                  Create
                </button>
                <button
                  type="button"
                  className="pf-bf sm"
                  onClick={onCloseCreateForm}
                >
                  <X style={{ width: 12, height: 12 }} />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={onShowCreateForm}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
                padding: "11px 14px",
                borderRadius: 9,
                border: "1.5px dashed var(--rule-soft)",
                background: "transparent",
                color: "var(--ink-3)",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
                transition: "border-color .12s, color .12s",
              }}
              className="pf-wl-newbtn"
            >
              <Plus style={{ width: 14, height: 14 }} />
              New watchlist
            </button>
          )}
        </DemoGate>
      </div>
    </div>
  );
});

// ============== COMPONENT ==============

interface WatchlistClientProps {
  initialWatchlists?: WatchlistData[] | null;
}

export default function WatchlistClient({
  initialWatchlists,
}: WatchlistClientProps = {}) {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const isSignedIn = !!user;
  const { flags } = useFeatureFlags();
  const paperTradingEnabled = flags["/paper-trading"];

  const [watchlists, setWatchlists] = useState<WatchlistData[]>(
    initialWatchlists ?? []
  );
  const [activeWatchlistId, setActiveWatchlistId] = useState<string | null>(
    initialWatchlists?.[0]?.id ?? null
  );
  const [isLoading, setIsLoading] = useState(!initialWatchlists?.length);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newWatchlistName, setNewWatchlistName] = useState("");
  const [newWatchlistType, setNewWatchlistType] = useState<"STOCK" | "MF">(
    "STOCK"
  );
  const [showAddSearch, setShowAddSearch] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [pendingItems, setPendingItems] = useState<
    Map<string, InstrumentSearchItem>
  >(new Map());
  const [mfData, setMfData] = useState<Map<string, MfWatchlistData>>(new Map());
  const [isMfDataLoading, setIsMfDataLoading] = useState(false);
  const [isDemoMode, setIsDemoMode] = useState(false);

  const searchCardRef = useRef<HTMLDivElement>(null);

  // Research modal - opened by the "Analyze" button
  const [researchModalOpen, setResearchModalOpen] = useState(false);
  const [researchEntity, setResearchEntity] = useState<ResearchEntity | null>(
    null
  );

  // Get active watchlist
  const activeWatchlist = watchlists.find((w) => w.id === activeWatchlistId);
  const isMfWatchlist = activeWatchlist?.type === "MF";

  // Union of all stock-watchlist symbols - one polling call covers every
  // sidebar card's delta computation as well as the active table's rows.
  // Keeps bandwidth flat regardless of which watchlist is active.
  const allStockSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const wl of watchlists) {
      if (wl.type !== "MF") {
        for (const item of wl.items ?? []) {
          set.add(item.symbol);
        }
      }
    }
    return Array.from(set);
  }, [watchlists]);

  // Live price updates (stocks, union across all watchlists)
  const { quotes, isLoading: isQuotesLoading } = useMarketData(
    allStockSymbols,
    {
      interval: 15_000,
      enablePolling: allStockSymbols.length > 0,
    }
  );

  // Sparkline trend data for the active stock watchlist (1-week close prices).
  // MF watchlists skip this - NAV history is a different data shape.
  const sparklineRequests = useMemo(() => {
    if (!activeWatchlist || isMfWatchlist) return [];
    return (activeWatchlist.items ?? []).map((item) => ({
      symbol: item.symbol,
      exchange: (item.exchange === "BSE" ? "BSE" : "NSE") as "NSE" | "BSE",
    }));
  }, [activeWatchlist, isMfWatchlist]);

  const { sparklines } = useSparklines(sparklineRequests, { window: "1W" });

  // Per-watchlist delta - unweighted mean of constituent changePercent.
  // MF watchlists return null (daily delta isn't comparable to NAV returns).
  const watchlistDeltas = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const wl of watchlists) {
      if (wl.type === "MF") {
        map.set(wl.id, null);
        continue;
      }
      const items = wl.items ?? [];
      if (items.length === 0) {
        map.set(wl.id, null);
        continue;
      }
      let sum = 0;
      let count = 0;
      for (const item of items) {
        const q = quotes.get(item.symbol);
        if (q && Number.isFinite(q.changePercent)) {
          sum += q.changePercent;
          count++;
        }
      }
      map.set(wl.id, count > 0 ? sum / count : null);
    }
    return map;
  }, [watchlists, quotes]);

  const activeDelta = activeWatchlistId
    ? (watchlistDeltas.get(activeWatchlistId) ?? null)
    : null;
  const hasActiveDelta = activeDelta != null && Number.isFinite(activeDelta);
  const isActiveDeltaPos = hasActiveDelta && activeDelta! >= 0;

  // Broker status for reauth banner
  const { brokerStatus: brokerInfo } = useBrokerStatus();

  // Fetch MF data when active MF watchlist changes
  useEffect(() => {
    if (!activeWatchlist || !isMfWatchlist) {
      setIsMfDataLoading(false);
      return;
    }
    if (!activeWatchlist.items?.length) {
      setIsMfDataLoading(false);
      return;
    }

    const isDemo =
      typeof window !== "undefined" &&
      localStorage.getItem("tradebook_demo_mode") === "true";

    if (isDemo) {
      setMfData(DEMO_MF_DATA);
      setIsMfDataLoading(false);
      return;
    }

    setIsMfDataLoading(true);
    const schemeCodes = (activeWatchlist.items ?? []).map(
      (item) => item.symbol
    );
    getWatchlistMfDataAction(schemeCodes)
      .then((result) => {
        if (result?.success && result?.data) {
          // Server actions serialize Maps as plain objects - reconstruct
          const reconstructed =
            result?.data instanceof Map
              ? result?.data
              : new Map(
                  Object.entries(result?.data) as [string, MfWatchlistData][]
                );
          setMfData(reconstructed);
        }
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        setIsMfDataLoading(false);
      });
  }, [activeWatchlist, isMfWatchlist]);

  // Detect demo mode early so the IDB hook can skip
  useEffect(() => {
    const demoMode = localStorage.getItem("tradebook_demo_mode");
    if (!isLoaded) return;
    if (!isSignedIn && !demoMode) {
      router.push("/home");
      return;
    }
    if (!isSignedIn && demoMode) {
      setIsDemoMode(true);
      setWatchlists(DEMO_WATCHLISTS);
      setActiveWatchlistId(DEMO_WATCHLISTS[0].id);
      setIsLoading(false);
    }
  }, [isLoaded, isSignedIn, router]);

  // IDB-cached watchlist fetch
  const {
    data: cachedWatchlists,
    isLoading: idbLoading,
    refresh: refreshWatchlists,
  } = useIDBCache<WatchlistData[]>({
    module: "watchlist",
    identifier: "all",
    fetcher: async () => {
      const result = await getWatchlistsAction();
      if (result?.success && result?.data) {
        return result?.data;
      }
      throw new Error("Failed to load watchlists");
    },
    initialData: initialWatchlists ?? undefined,
    skip: !isLoaded || (!isSignedIn && !isDemoMode) || isDemoMode,
  });

  // Sync IDB-cached data into local state (local state allows optimistic updates)
  useEffect(() => {
    if (cachedWatchlists) {
      setWatchlists(cachedWatchlists);
      setActiveWatchlistId((prev) =>
        !prev && cachedWatchlists.length > 0 ? cachedWatchlists[0].id : prev
      );
      setIsLoading(false);
    }
  }, [cachedWatchlists]);

  // Sync loading state from hook (only when not in demo mode)
  useEffect(() => {
    if (!isDemoMode && isLoaded && isSignedIn) {
      setIsLoading(idbLoading);
    }
  }, [idbLoading, isDemoMode, isLoaded, isSignedIn]);

  /** Invalidate IDB cache and refresh - call after mutations */
  const invalidateAndRefresh = useCallback(async () => {
    if (user?.id) await clearIDBWatchlistCache(user.id);
    await refreshWatchlists();
  }, [user?.id, refreshWatchlists]);

  const handleShowCreateForm = useCallback(() => setShowCreateForm(true), []);
  const handleCloseCreateForm = useCallback(() => {
    setShowCreateForm(false);
    setNewWatchlistType("STOCK");
  }, []);

  // Pick-mode: "analyze" opens ResearchModal, "paper" navigates to
  // /paper-trading/terminal pre-filled with the symbol. Single-symbol
  // watchlists fast-path; multi-symbol opens SymbolPickerDialog.
  const [symbolPickerMode, setSymbolPickerMode] = useState<
    "analyze" | "paper" | null
  >(null);

  const runAnalyze = useCallback(
    (symbol: string, exchange: string) => {
      if (isMfWatchlist) {
        const fund = mfData.get(symbol);
        setResearchEntity({
          symbol,
          name: fund?.schemeName ?? symbol,
          type: "mf",
        });
      } else {
        const quote = quotes.get(symbol);
        setResearchEntity({
          symbol,
          name: quote?.name ?? symbol,
          type: "stock",
          exchange,
        });
      }
      setResearchModalOpen(true);
    },
    [isMfWatchlist, mfData, quotes]
  );

  const runPaperTrade = useCallback(
    (symbol: string, exchange: string) => {
      const params = new URLSearchParams({ symbol, exchange });
      router.push(`/paper-trading/terminal?${params.toString()}`);
    },
    [router]
  );

  // Analyze button - open picker if multi-symbol, else fast-path.
  const handleAnalyze = useCallback(() => {
    if (!activeWatchlist) return;
    const items = activeWatchlist.items ?? [];
    if (items.length === 0) return;
    if (items.length === 1) {
      const item = items[0]!;
      runAnalyze(item.symbol, item.exchange);
      return;
    }
    setSymbolPickerMode("analyze");
  }, [activeWatchlist, runAnalyze]);

  // Paper-trade button - same picker pattern.
  const handlePaperTrade = useCallback(() => {
    if (!activeWatchlist) return;
    const items = activeWatchlist.items ?? [];
    if (items.length === 0) return;
    if (items.length === 1) {
      const item = items[0]!;
      runPaperTrade(item.symbol, item.exchange);
      return;
    }
    setSymbolPickerMode("paper");
  }, [activeWatchlist, runPaperTrade]);

  // Create watchlist - stable callback
  const handleCreateWatchlist = useCallback(async () => {
    if (!newWatchlistName.trim()) return;
    const result = await createWatchlistAction({
      name: newWatchlistName.trim(),
      type: newWatchlistType,
    });
    if (result?.success && result?.data) {
      setWatchlists((prev) => [...prev, result?.data!]);
      setActiveWatchlistId(result?.data.id);
      setNewWatchlistName("");
      setNewWatchlistType("STOCK");
      setShowCreateForm(false);
      invalidateAndRefresh();
    }
  }, [newWatchlistName, newWatchlistType, invalidateAndRefresh]);

  // Delete watchlist - stable callback
  const handleDeleteWatchlist = useCallback(
    async (id: string) => {
      const result = await deleteWatchlistAction(id);
      if (result?.success) {
        setWatchlists((prev) => {
          const remaining = prev.filter((w) => w.id !== id);
          setActiveWatchlistId((currentId) =>
            currentId === id ? (remaining[0]?.id ?? null) : currentId
          );
          return remaining;
        });
        invalidateAndRefresh();
      }
    },
    [invalidateAndRefresh]
  );

  // Compute selected keys for multi-select (existing items + pending adds)
  const selectedKeys = useMemo(() => {
    const keys = new Set<string>();
    if (activeWatchlist) {
      for (const item of activeWatchlist.items) {
        keys.add(`${item.symbol}:${item.exchange}`);
      }
    }
    pendingItems.forEach((_, key) => {
      keys.add(key);
    });
    return keys;
  }, [activeWatchlist, pendingItems]);

  // Toggle item selection for batch add
  const handleToggleItem = useCallback(
    (item: InstrumentSearchItem) => {
      const key = `${item.symbol}:${item.exchange}`;

      if (
        activeWatchlist?.items.some(
          (i) => i.symbol === item.symbol && i.exchange === item.exchange
        )
      ) {
        return;
      }

      setPendingItems((prev) => {
        const next = new Map(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.set(key, item);
        }
        return next;
      });
    },
    [activeWatchlist]
  );

  // Close search and batch-add pending items (no spinner - background refresh)
  const handleCloseSearch = useCallback(async () => {
    if (pendingItems.size > 0 && activeWatchlistId) {
      await batchAddWatchlistItemsAction({
        watchlistId: activeWatchlistId,
        items: Array.from(pendingItems.values()).map((item) => ({
          symbol: item.symbol,
          exchange: item.exchange,
          instrumentId: item.instrumentId,
        })),
      });
      setPendingItems(new Map());
      invalidateAndRefresh(); // no spinner - data updates silently via cache refresh
    }
    setShowAddSearch(false);
  }, [pendingItems, activeWatchlistId, invalidateAndRefresh]);

  // Stable handler for sidebar selection
  const handleSelectWatchlist = useCallback(
    (id: string) => {
      if (id !== activeWatchlistId) {
        if (showAddSearch) handleCloseSearch();
        setIsRenaming(false);
        setActiveWatchlistId(id);
      }
    },
    [activeWatchlistId, showAddSearch, handleCloseSearch]
  );

  // Click outside search card to close
  useEffect(() => {
    if (!showAddSearch) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        searchCardRef.current &&
        !searchCardRef.current.contains(e.target as Node)
      ) {
        handleCloseSearch();
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showAddSearch, handleCloseSearch]);

  // Build user context for AI chat
  const watchlistUserContext = useMemo(() => {
    const parts: string[] = [`Watchlist page.`];

    if (watchlists.length > 0) {
      parts.push(
        `User has ${watchlists.length} watchlist${watchlists.length !== 1 ? "s" : ""}: ${watchlists.map((wl) => `${wl.name} (${wl.type}, ${wl.itemCount} items)`).join(", ")}.`
      );
    } else {
      parts.push("User has no watchlists yet.");
    }

    if (activeWatchlist && (activeWatchlist.items ?? []).length > 0) {
      if (isMfWatchlist) {
        const itemSummaries = (activeWatchlist.items ?? []).map((item) => {
          const fund = mfData.get(item.symbol);
          if (fund) {
            return `${fund.schemeName} (NAV: ${formatCurrency(fund.nav)}, 1Y: ${fund.returns1Y != null ? `${fund.returns1Y.toFixed(1)}%` : "N/A"})`;
          }
          return `SchemeCode ${item.symbol} (${item.exchange})`;
        });
        parts.push(
          `Active MF watchlist "${activeWatchlist.name}" contains: ${itemSummaries.join(", ")}.`
        );
        parts.push(
          "Focus on the user's mutual fund watchlist and fund analysis."
        );
      } else {
        const itemSummaries = (activeWatchlist.items ?? []).map((item) => {
          const quote = quotes.get(item.symbol);
          if (quote) {
            return `${item.symbol} (${item.exchange}, ${formatCurrency(quote?.price ?? 0)}, ${(quote?.change ?? 0) >= 0 ? "+" : ""}${(quote?.changePercent ?? 0).toFixed(2)}%)`;
          }
          return `${item.symbol} (${item.exchange})`;
        });
        parts.push(
          `Active watchlist "${activeWatchlist.name}" contains: ${itemSummaries.join(", ")}.`
        );
        parts.push("Focus on the user's watchlist stocks and market analysis.");
      }
    }

    return parts.filter(Boolean).join(" ");
  }, [watchlists, activeWatchlist, quotes, mfData, isMfWatchlist]);

  // Rename handlers
  const handleStartRename = useCallback(() => {
    if (activeWatchlist) {
      setRenameValue(activeWatchlist.name);
      setIsRenaming(true);
    }
  }, [activeWatchlist]);

  const handleRename = useCallback(async () => {
    if (!activeWatchlistId || !renameValue.trim()) {
      setIsRenaming(false);
      return;
    }

    const trimmed = renameValue.trim();
    if (trimmed === activeWatchlist?.name) {
      setIsRenaming(false);
      return;
    }

    // Optimistic: close input and update UI immediately, persist in background
    setIsRenaming(false);
    setWatchlists((prev) =>
      prev.map((wl) =>
        wl.id === activeWatchlistId ? { ...wl, name: trimmed } : wl
      )
    );
    updateWatchlistAction(activeWatchlistId, { name: trimmed })
      .then(() => {
        invalidateAndRefresh();
      })
      .catch(() => {
        // Revert on failure
        setWatchlists((prev) =>
          prev.map((wl) =>
            wl.id === activeWatchlistId
              ? { ...wl, name: activeWatchlist?.name ?? trimmed }
              : wl
          )
        );
      });
  }, [activeWatchlistId, renameValue, activeWatchlist, invalidateAndRefresh]);

  // Remove item from watchlist
  const handleRemoveItem = async (itemId: string) => {
    const result = await removeWatchlistItemAction(itemId);
    if (result?.success) {
      setWatchlists((prev) =>
        prev.map((wl) =>
          wl.id === activeWatchlistId
            ? {
                ...wl,
                items: (wl.items ?? []).filter((i) => i.id !== itemId),
                itemCount: wl.itemCount - 1,
              }
            : wl
        )
      );
      invalidateAndRefresh();
    }
  };

  // Determine search filterTypes based on active watchlist type
  const searchFilterTypes = useMemo(() => {
    if (!activeWatchlist) return undefined;
    // MONEY-1093: a STOCK watchlist accepts ETFs too.
    //
    // The nightly bhavcopy backfill now types mis-typed ETFs (NIFTYBEES and
    // friends were stored EQUITY, because Kite's abbreviated name does not trip
    // the ETF name match while the bhavcopy's full name does). With a bare
    // ["EQUITY"] filter, the retype silently removed those symbols from this
    // search — a symbol addable yesterday returned NO results today — and the
    // schema has no ETF watchlist type (`type` is "STOCK" | "MF"), so the user
    // had no way to get it back.
    //
    // ETFs trade on the exchange exactly like equities, so a stock watchlist is
    // where a user expects to find one.
    return activeWatchlist.type === "MF" ? ["MF"] : ["EQUITY", "ETF"];
  }, [activeWatchlist]);

  // MONEY-392 / MONEY-485: chrome (Sidebar + <main>) lives OUTSIDE PageGuard
  // so the playful hero stays visible across stages 1 → 2 → 3. PageGuard
  // `bare` wraps just the inner content with the skeleton as fallback.
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />

      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="pf-page" style={{ paddingBottom: 176 }}>
          {/* Playful hero header */}
          <PfPageHead
            eyebrow="WORKSPACE · WATCHLISTS"
            title={
              <>
                The list you <span className="ser">actually</span>{" "}
                <span className="hl">check.</span>
              </>
            }
            sub="Track the tickers and funds you care about — live, in one place."
          />

          <PageGuard route="/watchlist" bare fallback={<WatchlistSkeleton />}>
            {/* Demo Banner */}
            {isDemoMode && <DemoBanner />}

            {/* Broker Reauth Banner */}
            {brokerInfo.status === "needs_reauth" &&
              brokerInfo.reauthUrl &&
              brokerInfo.brokerDisplayName && (
                <BrokerReauthBanner
                  brokerName={brokerInfo.brokerDisplayName}
                  reauthUrl={brokerInfo.reauthUrl}
                  className="mb-6"
                />
              )}

            {isLoading ? (
              <div className="pf-wl-layout">
                {/* Watchlist rail skeleton */}
                <div
                  className="pf-wl-rail"
                  style={{
                    width: "100%",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  {[1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      className="pf-card flat"
                      style={{
                        padding: "12px 14px",
                        border: "1.5px solid var(--rule-soft)",
                        opacity: 0.55,
                      }}
                    >
                      <div
                        style={{
                          height: 13,
                          width: "60%",
                          borderRadius: 4,
                          background: "var(--rule-soft)",
                        }}
                      />
                      <div
                        style={{
                          height: 11,
                          width: "35%",
                          borderRadius: 4,
                          background: "var(--rule-softer)",
                          marginTop: 8,
                        }}
                      />
                    </div>
                  ))}
                </div>

                {/* Content skeleton */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="pf-card"
                    style={{ padding: 0, overflow: "hidden" }}
                  >
                    <table className="pf-tbl">
                      <thead>
                        <tr>
                          <th style={{ paddingLeft: 18 }}>TICKER</th>
                          <th>NAME</th>
                          <th style={{ textAlign: "right" }}>LTP</th>
                          <th style={{ textAlign: "right" }}>CHG</th>
                          <th style={{ width: 1 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {[1, 2, 3, 4, 5, 6].map((i) => (
                          <tr key={i}>
                            <td style={{ paddingLeft: 18 }}>
                              <div
                                style={{
                                  height: 13,
                                  width: 70,
                                  borderRadius: 4,
                                  background: "var(--rule-soft)",
                                }}
                              />
                            </td>
                            <td>
                              <div
                                style={{
                                  height: 13,
                                  width: 130,
                                  borderRadius: 4,
                                  background: "var(--rule-softer)",
                                }}
                              />
                            </td>
                            <td style={{ textAlign: "right" }}>
                              <div
                                style={{
                                  height: 13,
                                  width: 60,
                                  borderRadius: 4,
                                  background: "var(--rule-softer)",
                                  marginLeft: "auto",
                                }}
                              />
                            </td>
                            <td style={{ textAlign: "right" }}>
                              <div
                                style={{
                                  height: 13,
                                  width: 50,
                                  borderRadius: 4,
                                  background: "var(--rule-softer)",
                                  marginLeft: "auto",
                                }}
                              />
                            </td>
                            <td />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : (
              <div className="pf-wl-layout">
                {/* Watchlist selector rail (memoized) */}
                <WatchlistSidebar
                  watchlists={watchlists}
                  activeWatchlistId={activeWatchlistId}
                  onSelect={handleSelectWatchlist}
                  showCreateForm={showCreateForm}
                  onShowCreateForm={handleShowCreateForm}
                  newWatchlistName={newWatchlistName}
                  onNewWatchlistNameChange={setNewWatchlistName}
                  newWatchlistType={newWatchlistType}
                  onNewWatchlistTypeChange={setNewWatchlistType}
                  onCreateWatchlist={handleCreateWatchlist}
                  onCloseCreateForm={handleCloseCreateForm}
                  isDemoMode={isDemoMode}
                  deltas={watchlistDeltas}
                />

                {/* Watchlist Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {activeWatchlist ? (
                    <>
                      {/* Section header — name + delta + type + actions */}
                      <div
                        className="pf-sec-h"
                        style={{
                          marginTop: 0,
                          marginBottom: 14,
                          flexWrap: "wrap",
                        }}
                      >
                        {isRenaming ? (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            <input
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleRename();
                                if (e.key === "Escape") setIsRenaming(false);
                              }}
                              className="pf-input"
                              style={{
                                width: 260,
                                fontSize: 18,
                                fontWeight: 700,
                                padding: "7px 10px",
                              }}
                              autoFocus
                            />
                            <button
                              type="button"
                              className="pf-bs sm"
                              onClick={handleRename}
                              aria-label="Save name"
                            >
                              <Check style={{ width: 14, height: 14 }} />
                            </button>
                            <button
                              type="button"
                              className="pf-bf sm"
                              onClick={() => setIsRenaming(false)}
                              aria-label="Cancel rename"
                            >
                              <X style={{ width: 14, height: 14 }} />
                            </button>
                          </div>
                        ) : (
                          <>
                            <span className="n">
                              {isMfWatchlist ? "FUNDS" : "STOCKS"}
                            </span>
                            <h3 style={{ marginRight: 2 }}>
                              {activeWatchlist.name}
                            </h3>
                            {hasActiveDelta && (
                              <span
                                style={{
                                  fontFamily: "JetBrains Mono, monospace",
                                  fontSize: 13,
                                  fontWeight: 700,
                                  fontVariantNumeric: "tabular-nums",
                                  color: isActiveDeltaPos
                                    ? "var(--emerald)"
                                    : "#b91c1c",
                                }}
                              >
                                {isActiveDeltaPos ? "▲" : "▼"}{" "}
                                {Math.abs(activeDelta!).toFixed(2)}%
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={handleStartRename}
                              title="Rename watchlist"
                              style={{
                                display: "inline-grid",
                                placeItems: "center",
                                width: 26,
                                height: 26,
                                borderRadius: 6,
                                border: 0,
                                background: "transparent",
                                color: "var(--ink-3)",
                                cursor: "pointer",
                              }}
                              className="pf-wl-iconbtn"
                            >
                              <Pencil style={{ width: 13, height: 13 }} />
                            </button>
                            <span className="rule" />
                          </>
                        )}

                        <DemoGate
                          isDemoMode={isDemoMode}
                          message="Sign up to manage watchlists"
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              flexWrap: "wrap",
                            }}
                          >
                            {(activeWatchlist.items ?? []).length > 0 && (
                              <>
                                <button
                                  type="button"
                                  onClick={handleAnalyze}
                                  className="pf-pill emerald"
                                  style={{
                                    cursor: "pointer",
                                    padding: "6px 11px",
                                    fontSize: 11,
                                  }}
                                >
                                  <Sparkles style={{ width: 12, height: 12 }} />
                                  Analyze
                                </button>
                                {!isMfWatchlist && paperTradingEnabled && (
                                  <button
                                    type="button"
                                    onClick={handlePaperTrade}
                                    className="pf-pill outline"
                                    style={{
                                      cursor: "pointer",
                                      padding: "6px 11px",
                                      fontSize: 11,
                                    }}
                                  >
                                    <Play style={{ width: 12, height: 12 }} />
                                    Paper-trade
                                  </button>
                                )}
                              </>
                            )}
                            <button
                              type="button"
                              className="pf-bf sm"
                              onClick={() => {
                                if (showAddSearch) {
                                  handleCloseSearch();
                                } else {
                                  setShowAddSearch(true);
                                }
                              }}
                            >
                              <Plus style={{ width: 13, height: 13 }} />
                              Add
                            </button>
                            {!activeWatchlist.isDefault && (
                              <button
                                type="button"
                                className="pf-bf sm danger"
                                onClick={() =>
                                  handleDeleteWatchlist(activeWatchlist.id)
                                }
                                aria-label="Delete watchlist"
                              >
                                <Trash2 style={{ width: 13, height: 13 }} />
                              </button>
                            )}
                          </div>
                        </DemoGate>
                      </div>
                      <p
                        style={{
                          fontFamily: "JetBrains Mono, monospace",
                          fontSize: 12,
                          color: "var(--ink-3)",
                          marginTop: -6,
                          marginBottom: 16,
                        }}
                      >
                        {activeWatchlist.itemCount}{" "}
                        {isMfWatchlist ? "funds" : "instruments"}
                      </p>

                      {/* Add Search - Multi-select, filtered by type */}
                      {showAddSearch && (
                        <div ref={searchCardRef}>
                          <div
                            className="pf-card"
                            style={{ marginBottom: 16, padding: 16 }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                marginBottom: 10,
                                gap: 8,
                                flexWrap: "wrap",
                              }}
                            >
                              <p
                                style={{
                                  fontSize: 13,
                                  color: "var(--ink-3)",
                                }}
                              >
                                Select{" "}
                                {isMfWatchlist ? "mutual funds" : "instruments"}{" "}
                                to add
                                {pendingItems.size > 0 && (
                                  <span
                                    style={{
                                      marginLeft: 6,
                                      color: "var(--emerald)",
                                      fontWeight: 700,
                                    }}
                                  >
                                    ({pendingItems.size} selected)
                                  </span>
                                )}
                              </p>
                              <button
                                type="button"
                                className="pf-bs sm"
                                onClick={handleCloseSearch}
                              >
                                <Check style={{ width: 12, height: 12 }} />
                                Done
                              </button>
                            </div>
                            <InstrumentSearch
                              onSelect={handleToggleItem}
                              placeholder={
                                isMfWatchlist
                                  ? "Search mutual funds to add..."
                                  : "Search instruments to add..."
                              }
                              autoFocus
                              multiSelect
                              selectedKeys={selectedKeys}
                              filterTypes={searchFilterTypes}
                            />
                          </div>
                        </div>
                      )}

                      {/* Items Table */}
                      {!activeWatchlist.items?.length ? (
                        <div
                          className="pf-card"
                          style={{
                            padding: "44px 20px",
                            textAlign: "center",
                          }}
                        >
                          <p
                            style={{
                              color: "var(--ink-3)",
                              fontFamily: "Instrument Serif, serif",
                              fontStyle: "italic",
                              fontSize: 17,
                              marginBottom: 16,
                            }}
                          >
                            This watchlist is empty.
                          </p>
                          <button
                            type="button"
                            className="pf-bs"
                            onClick={() => setShowAddSearch(true)}
                            style={{ margin: "0 auto" }}
                          >
                            <Plus style={{ width: 14, height: 14 }} />
                            Add {isMfWatchlist ? "Mutual Funds" : "Instruments"}
                          </button>
                        </div>
                      ) : isMfWatchlist ? (
                        /* MF Table - rows render immediately, data fills in async */
                        <div
                          className="pf-card"
                          style={{ padding: 0, overflow: "hidden" }}
                        >
                          <div style={{ overflowX: "auto" }}>
                            <table className="pf-tbl">
                              <thead>
                                <tr>
                                  <th style={{ paddingLeft: 18 }}>Scheme</th>
                                  <th className="pf-wl-hide-sm">Category</th>
                                  <th style={{ textAlign: "right" }}>NAV</th>
                                  <th
                                    className="pf-wl-hide-md"
                                    style={{ textAlign: "right" }}
                                  >
                                    1Y Return
                                  </th>
                                  <th style={{ width: 1 }} />
                                </tr>
                              </thead>
                              <tbody>
                                {(activeWatchlist.items ?? []).map((item) => {
                                  const fund = mfData.get(item.symbol);

                                  return (
                                    <tr
                                      key={item.id}
                                      onClick={() =>
                                        router.push(
                                          instrumentDetailHref({
                                            symbol: item.symbol,
                                            instrumentType: "MF",
                                          })
                                        )
                                      }
                                      style={{ cursor: "pointer" }}
                                    >
                                      <td
                                        style={{
                                          paddingLeft: 18,
                                          maxWidth: 280,
                                        }}
                                      >
                                        <div className="tk">
                                          {fund ? fund.schemeName : item.symbol}
                                        </div>
                                        <div className="nm">
                                          {fund ? fund.amcName : item.exchange}
                                        </div>
                                      </td>
                                      <td className="pf-wl-hide-sm">
                                        {fund ? (
                                          <span className="pf-pill outline">
                                            {fund.category}
                                          </span>
                                        ) : isMfDataLoading ? (
                                          <Loader2
                                            style={{
                                              width: 14,
                                              height: 14,
                                              color: "var(--ink-3)",
                                              animation:
                                                "um-spin .9s linear infinite",
                                            }}
                                          />
                                        ) : (
                                          <span
                                            style={{ color: "var(--ink-3)" }}
                                          >
                                            —
                                          </span>
                                        )}
                                      </td>
                                      <td
                                        className="num"
                                        style={{ textAlign: "right" }}
                                      >
                                        {fund ? (
                                          formatCurrency(fund.nav)
                                        ) : isMfDataLoading ? (
                                          <Loader2
                                            style={{
                                              width: 14,
                                              height: 14,
                                              color: "var(--ink-3)",
                                              marginLeft: "auto",
                                              animation:
                                                "um-spin .9s linear infinite",
                                            }}
                                          />
                                        ) : (
                                          <span
                                            style={{ color: "var(--ink-3)" }}
                                          >
                                            —
                                          </span>
                                        )}
                                      </td>
                                      <td
                                        className={`num pf-wl-hide-md ${
                                          fund && fund.returns1Y != null
                                            ? fund.returns1Y >= 0
                                              ? "pos"
                                              : "neg"
                                            : ""
                                        }`}
                                        style={{ textAlign: "right" }}
                                      >
                                        {fund && fund.returns1Y != null ? (
                                          <>
                                            {fund.returns1Y >= 0 ? "▲" : "▼"}{" "}
                                            {fund.returns1Y.toFixed(1)}%
                                          </>
                                        ) : isMfDataLoading ? (
                                          <Loader2
                                            style={{
                                              width: 14,
                                              height: 14,
                                              color: "var(--ink-3)",
                                              marginLeft: "auto",
                                              animation:
                                                "um-spin .9s linear infinite",
                                            }}
                                          />
                                        ) : (
                                          <span
                                            style={{ color: "var(--ink-3)" }}
                                          >
                                            —
                                          </span>
                                        )}
                                      </td>
                                      <td
                                        style={{
                                          width: 1,
                                          textAlign: "right",
                                          paddingRight: 14,
                                        }}
                                      >
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            if (!isDemoMode)
                                              handleRemoveItem(item.id);
                                          }}
                                          title={
                                            isDemoMode
                                              ? "Sign up to manage watchlists"
                                              : "Remove"
                                          }
                                          style={{
                                            display: "inline-grid",
                                            placeItems: "center",
                                            width: 26,
                                            height: 26,
                                            borderRadius: 6,
                                            border: 0,
                                            background: "transparent",
                                            color: isDemoMode
                                              ? "var(--ink-4)"
                                              : "var(--ink-3)",
                                            cursor: isDemoMode
                                              ? "not-allowed"
                                              : "pointer",
                                          }}
                                          className={
                                            isDemoMode
                                              ? undefined
                                              : "pf-wl-removebtn"
                                          }
                                        >
                                          <X
                                            style={{ width: 14, height: 14 }}
                                          />
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ) : (
                        /* Stock Table */
                        <div
                          className="pf-card"
                          style={{ padding: 0, overflow: "hidden" }}
                        >
                          <div style={{ overflowX: "auto" }}>
                            <table className="pf-tbl">
                              <thead>
                                <tr>
                                  <th style={{ paddingLeft: 18 }}>Ticker</th>
                                  <th className="pf-wl-hide-md">Name</th>
                                  <th style={{ textAlign: "right" }}>LTP</th>
                                  <th style={{ textAlign: "right" }}>Chg</th>
                                  <th
                                    className="pf-wl-hide-sm"
                                    style={{ textAlign: "right" }}
                                  >
                                    Vol
                                  </th>
                                  <th className="pf-wl-hide-lg">Trend</th>
                                  <th style={{ width: 1 }} />
                                </tr>
                              </thead>
                              <tbody>
                                {(activeWatchlist.items ?? []).map((item) => {
                                  const quote = quotes.get(item.symbol);
                                  const key = `${item.symbol}|${item.exchange === "BSE" ? "BSE" : "NSE"}`;
                                  const spark = sparklines.get(key);
                                  const isPos =
                                    quote != null && quote.change >= 0;
                                  return (
                                    <tr
                                      key={item.id}
                                      onClick={() =>
                                        // MONEY-1205 — `WatchlistItem` stores
                                        // only symbol + exchange, so an ETF
                                        // lands on /stock/ and is redirected
                                        // from there. The helper also encodes
                                        // the symbol, which matters for real
                                        // tickers like `M&M`.
                                        router.push(
                                          instrumentDetailHref({
                                            symbol: item.symbol,
                                            exchange: item.exchange,
                                          })
                                        )
                                      }
                                      style={{ cursor: "pointer" }}
                                    >
                                      <td style={{ paddingLeft: 18 }}>
                                        <span
                                          className="tk"
                                          style={{ color: "var(--emerald)" }}
                                        >
                                          {item.symbol}
                                        </span>
                                      </td>
                                      <td
                                        className="pf-wl-hide-md nm"
                                        style={{ maxWidth: 240 }}
                                      >
                                        {quote?.name ? (
                                          <span
                                            style={{
                                              display: "block",
                                              overflow: "hidden",
                                              textOverflow: "ellipsis",
                                              whiteSpace: "nowrap",
                                            }}
                                          >
                                            {quote.name}
                                          </span>
                                        ) : isQuotesLoading ? (
                                          <Loader2
                                            style={{
                                              width: 13,
                                              height: 13,
                                              color: "var(--ink-3)",
                                              animation:
                                                "um-spin .9s linear infinite",
                                            }}
                                          />
                                        ) : (
                                          <span
                                            style={{ color: "var(--ink-3)" }}
                                          >
                                            —
                                          </span>
                                        )}
                                      </td>
                                      <td
                                        className="num"
                                        style={{
                                          textAlign: "right",
                                          color: "var(--ink)",
                                        }}
                                      >
                                        {quote ? (
                                          formatCurrency(quote.price)
                                        ) : isQuotesLoading ? (
                                          <Loader2
                                            style={{
                                              width: 14,
                                              height: 14,
                                              color: "var(--ink-3)",
                                              marginLeft: "auto",
                                              animation:
                                                "um-spin .9s linear infinite",
                                            }}
                                          />
                                        ) : (
                                          <span
                                            style={{ color: "var(--ink-3)" }}
                                          >
                                            —
                                          </span>
                                        )}
                                      </td>
                                      <td
                                        className={`num ${
                                          quote ? (isPos ? "pos" : "neg") : ""
                                        }`}
                                        style={{ textAlign: "right" }}
                                      >
                                        {quote ? (
                                          <>
                                            {isPos ? "▲" : "▼"}{" "}
                                            {quote.changePercent.toFixed(2)}%
                                          </>
                                        ) : isQuotesLoading ? (
                                          <Loader2
                                            style={{
                                              width: 14,
                                              height: 14,
                                              color: "var(--ink-3)",
                                              marginLeft: "auto",
                                              animation:
                                                "um-spin .9s linear infinite",
                                            }}
                                          />
                                        ) : (
                                          "—"
                                        )}
                                      </td>
                                      <td
                                        className="num pf-wl-hide-sm"
                                        style={{
                                          textAlign: "right",
                                          color: "var(--ink-3)",
                                        }}
                                      >
                                        {formatVolume(quote?.volume)}
                                      </td>
                                      <td className="pf-wl-hide-lg">
                                        {spark && spark.closes.length > 1 ? (
                                          <Sparkline
                                            data={spark.closes}
                                            tone={
                                              quote
                                                ? isPos
                                                  ? "pos"
                                                  : "neg"
                                                : autoTone(spark.closes)
                                            }
                                            width={72}
                                            height={22}
                                            ariaLabel={`${item.symbol} 1-week trend`}
                                          />
                                        ) : (
                                          <div
                                            style={{
                                              width: 72,
                                              height: 22,
                                              display: "flex",
                                              alignItems: "center",
                                            }}
                                          >
                                            <div
                                              style={{
                                                width: "100%",
                                                height: 1,
                                                background: "var(--rule-soft)",
                                              }}
                                            />
                                          </div>
                                        )}
                                      </td>
                                      <td
                                        style={{
                                          width: 1,
                                          textAlign: "right",
                                          paddingRight: 14,
                                        }}
                                      >
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            if (!isDemoMode)
                                              handleRemoveItem(item.id);
                                          }}
                                          title={
                                            isDemoMode
                                              ? "Sign up to manage watchlists"
                                              : "Remove"
                                          }
                                          style={{
                                            display: "inline-grid",
                                            placeItems: "center",
                                            width: 26,
                                            height: 26,
                                            borderRadius: 6,
                                            border: 0,
                                            background: "transparent",
                                            color: isDemoMode
                                              ? "var(--ink-4)"
                                              : "var(--ink-3)",
                                            cursor: isDemoMode
                                              ? "not-allowed"
                                              : "pointer",
                                          }}
                                          className={
                                            isDemoMode
                                              ? undefined
                                              : "pf-wl-removebtn"
                                          }
                                        >
                                          <X
                                            style={{ width: 14, height: 14 }}
                                          />
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div
                      className="pf-card"
                      style={{ padding: "44px 20px", textAlign: "center" }}
                    >
                      <p
                        style={{
                          color: "var(--ink-3)",
                          fontFamily: "Instrument Serif, serif",
                          fontStyle: "italic",
                          fontSize: 17,
                          marginBottom: 16,
                        }}
                      >
                        Create a watchlist to start tracking instruments.
                      </p>
                      <button
                        type="button"
                        className="pf-bs"
                        onClick={() => setShowCreateForm(true)}
                        style={{ margin: "0 auto" }}
                      >
                        <Plus style={{ width: 14, height: 14 }} />
                        Create Watchlist
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </PageGuard>
        </div>
      </main>

      {/* Layout + interaction styles scoped to this page. */}
      <style>{`
        .pf-wl-layout {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }
        @media (min-width: 1024px) {
          .pf-wl-layout {
            flex-direction: row;
          }
          .pf-wl-rail {
            width: 300px !important;
          }
        }
        .pf-wl-newbtn:hover {
          border-color: var(--emerald) !important;
          color: var(--emerald) !important;
        }
        .pf-wl-iconbtn:hover {
          background: var(--rule-softer);
          color: var(--ink);
        }
        .pf-wl-removebtn:hover {
          background: var(--rule-softer);
          color: #b91c1c;
        }
        html.dark .pf-wl-removebtn:hover {
          color: var(--pop-1);
        }
        @media (max-width: 639px) {
          .pf-wl-hide-sm { display: none; }
        }
        @media (max-width: 767px) {
          .pf-wl-hide-md { display: none; }
        }
        @media (max-width: 1023px) {
          .pf-wl-hide-lg { display: none; }
        }
        @keyframes um-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      {/* Research modal - opened by the Analyze button on the watchlist header */}
      <ResearchModal
        open={researchModalOpen}
        onOpenChange={setResearchModalOpen}
        entity={researchEntity}
      />

      {/* Symbol picker - multi-symbol Analyze / Paper-trade (MONEY-207) */}
      {symbolPickerMode && activeWatchlist && (
        <SymbolPickerDialog
          title={
            symbolPickerMode === "analyze"
              ? "Pick a symbol to analyze"
              : "Pick a symbol to paper trade"
          }
          items={(activeWatchlist.items ?? []).map((it) => ({
            symbol: it.symbol,
            exchange: it.exchange,
            name: isMfWatchlist
              ? mfData.get(it.symbol)?.schemeName
              : quotes.get(it.symbol)?.name,
          }))}
          onPick={(item) => {
            if (symbolPickerMode === "analyze") {
              runAnalyze(item.symbol, item.exchange);
            } else {
              runPaperTrade(item.symbol, item.exchange);
            }
            setSymbolPickerMode(null);
          }}
          onClose={() => setSymbolPickerMode(null)}
        />
      )}
    </div>
  );
}
