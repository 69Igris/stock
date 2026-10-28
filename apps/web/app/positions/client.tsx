"use client";

import {
  useState,
  useEffect,
  useTransition,
  useCallback,
  useMemo,
} from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useIDBCache } from "@/hooks/useIDBCache";
import { clearIDBPositionCache } from "@/lib/idb-cache";
import Sidebar from "@/components/Sidebar";
import { DemoBanner } from "@/components/DemoBanner";

import { PaginationControls } from "@/components/PaginationControls";
import AddTradeDialog, { TradeFormData } from "@/components/AddTradeDialog";
import TradeFilters, { FilterState } from "@/components/TradeFilters";
import { Input } from "@usemoney/ui/input";
import { Label } from "@usemoney/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@usemoney/ui/dialog";
import { toast } from "sonner";
import {
  RefreshCw,
  Target,
  Plus,
  X,
  Save,
  ArrowUp,
  ArrowDown,
  Brain,
} from "lucide-react";
import { formatCurrency, formatPnL } from "@usemoney/utils";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { createTradeAction, closePositionAction } from "@/lib/actions/trades";
import {
  getPositionsAction,
  getClosedTodayPositionsAction,
} from "@/lib/actions/positions";
import type { ClosedTodayPosition } from "@/lib/actions/positions";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import {
  getBrokerConnectionsAction,
  syncAllBrokersAction,
} from "@/lib/actions/broker-connection";
import { PageGuard } from "@/components/PageGuard";
import { PositionsSkeleton } from "@/components/skeletons";
import BrokerReauthBanner from "@/components/BrokerReauthBanner";
import { useBrokerStatus } from "@/hooks/useBrokerStatus";
import {
  BrokerLogo,
  toBrokerSlug,
} from "@/components/terminal-luxe/primitives";
import {
  getSegmentLabel,
  getProductTypeLabel,
} from "@usemoney/core/brokers/clients/broker-mappings";
import ResearchModal, {
  type ResearchEntity,
  type PositionPreData,
} from "@/components/analysis/ResearchModal";

// Segments that support analysis (equity & MF, not F&O/currency/commodity)
// All segments except F&O (FO, NFO, BFO, NRML), Currency (CD, CDS), and Commodity (COM, MCX)
const NON_ANALYZABLE_SEGMENTS = new Set([
  "FO",
  "NFO",
  "BFO",
  "NRML",
  "CD",
  "CDS",
  "COM",
  "MCX",
]);

function isAnalyzable(segment: string): boolean {
  return !NON_ANALYZABLE_SEGMENTS.has(segment);
}

// Manual entry icon component
function ManualEntryIcon({ size = 14 }: { size?: number }) {
  return (
    <span style={{ fontSize: size }} className="leading-none">
      📝
    </span>
  );
}

// Broker dot colours for the playful br-chip (mirrors the design + dashboard).
const BROKER_DOT_COLORS: Record<string, string> = {
  zerodha: "#387ed1",
  groww: "#5eb66e",
  upstox: "#7b2ff7",
  angel: "#e85454",
  "angel one": "#e85454",
  angelone: "#e85454",
  dhan: "#f59e42",
  fyers: "#2196f3",
  hdfc: "#004c8f",
  "hdfc sky": "#004c8f",
};

function brokerDotColor(broker?: string | null): string {
  return BROKER_DOT_COLORS[(broker ?? "").toLowerCase()] ?? "var(--ink-3)";
}

interface BrokerConnection {
  id: string;
  broker: string;
  brokerUserId: string | null;
  accountName: string | null;
}

interface Position {
  id: string;
  symbol: string;
  exchange: string;
  segment: string;
  segmentLabel?: string;
  productType?: string;
  productTypeLabel?: string;
  positionType: string;
  positionTypeLabel?: string;
  tradeType: string;
  quantity: number;
  price: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  broker: string | null;
  brokerUserId: string | null;
  brokerName: string | null;
  tradeDate: string | Date;
  sourceType?: string;
  isEditable?: boolean;
}

interface PositionSummary {
  totalPositions: number;
  totalInvested: number;
  unrealizedPnL: number;
  longPositions: number;
  shortPositions: number;
}

const initialFilters: FilterState = {
  symbol: "",
  broker: "all",
  segment: "all",
  tradeType: "all",
  status: "all",
  dateRange: "",
  fromDate: "",
  toDate: "",
};

interface PositionsPageProps {
  initialPositions?: {
    positions: Position[];
    summary: PositionSummary;
  } | null;
  isDemo?: boolean;
}

export default function PositionsPage({
  initialPositions,
  isDemo,
}: PositionsPageProps = {}) {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const [mounted, setMounted] = useState(false);
  const [isPending, startTransition] = useTransition();

  const isDemoMode = useIsDemoMode({ isDemo, user });

  // Filters
  const [filters, setFilters] = useState<FilterState>(initialFilters);

  // ResearchModal state
  const [researchModalOpen, setResearchModalOpen] = useState(false);
  const [researchModalEntity, setResearchModalEntity] =
    useState<ResearchEntity | null>(null);
  const [researchPositionData, setResearchPositionData] =
    useState<PositionPreData | null>(null);

  // Close position dialog
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(
    null
  );
  const [closePrice, setClosePrice] = useState("");
  const [isClosing, setIsClosing] = useState(false);

  // Add position dialog
  const [showAddDialog, setShowAddDialog] = useState(false);

  // Pagination
  const POS_PER_PAGE = 25;
  const [posPage, setPosPage] = useState(0);

  // Broker connections
  const [brokerConnections, setBrokerConnections] = useState<
    BrokerConnection[]
  >([]);

  const { brokerStatus } = useBrokerStatus();

  // Sorting
  const [sortBy, setSortBy] = useState<"date" | "pnl">("date");
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");

  // Prevent hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  const {
    data: positionsData,
    isLoading,
    refresh: refreshPositions,
  } = useIDBCache<{ positions: Position[]; summary: PositionSummary }>({
    module: "positions",
    identifier: "main",
    fetcher: async () => {
      const result = await getPositionsAction({});
      if (result?.success && result?.data) {
        return {
          positions: result?.data.positions as Position[],
          summary: result?.data.summary,
        };
      }
      throw new Error(result?.error || "Failed to load positions");
    },
    initialData: initialPositions
      ? {
          positions: initialPositions.positions as Position[],
          summary: initialPositions.summary,
        }
      : undefined,
    skip: !mounted || !isLoaded || (!user && !isDemoMode),
  });

  const allPositions = useMemo(
    () => positionsData?.positions ?? [],
    [positionsData]
  );

  // Closed-today positions (intraday squared-off)
  const [closedTodayPositions, setClosedTodayPositions] = useState<
    ClosedTodayPosition[]
  >([]);

  const loadClosedToday = useCallback(async () => {
    try {
      const result = await getClosedTodayPositionsAction();
      if (result?.success && result?.data) {
        setClosedTodayPositions(result?.data);
      }
    } catch {
      // Silently fail - closed-today is supplementary
    }
  }, []);

  // Client-side filtering (avoids server calls on every keystroke)
  const positions = useMemo(() => {
    return allPositions.filter((p) => {
      const matchesSymbol =
        !filters.symbol ||
        p.symbol.toLowerCase().includes(filters.symbol.toLowerCase());
      const matchesBroker =
        filters.broker === "all" || p.brokerName === filters.broker;
      const matchesSegment =
        filters.segment === "all" || p.segment === filters.segment;
      return matchesSymbol && matchesBroker && matchesSegment;
    });
  }, [allPositions, filters.symbol, filters.broker, filters.segment]);

  // Recompute summary based on filtered positions
  const summary = useMemo<PositionSummary | null>(() => {
    if (!positionsData) return null;
    if (
      !filters.symbol &&
      filters.broker === "all" &&
      filters.segment === "all"
    ) {
      return positionsData.summary;
    }
    const totalInvested = positions.reduce(
      (sum, p) => sum + p.quantity * (p.entryPrice || p.price || 0),
      0
    );
    const unrealizedPnL = positions.reduce(
      (sum, p) => sum + (p.unrealizedPnL || 0),
      0
    );
    return {
      totalPositions: positions.length,
      totalInvested,
      unrealizedPnL,
      longPositions: positions.filter((p) => p.positionType === "LONG").length,
      shortPositions: positions.filter((p) => p.positionType === "SHORT")
        .length,
    };
  }, [
    positionsData,
    positions,
    filters.symbol,
    filters.broker,
    filters.segment,
  ]);

  const [isSyncing, setIsSyncing] = useState(false);

  const fetchPositions = useCallback(async () => {
    setIsSyncing(true);
    try {
      // Sync all connected brokers first, then refresh display
      const syncResult = await syncAllBrokersAction();
      if (!syncResult?.success && syncResult?.error) {
        toast.error(syncResult?.error);
      }
    } catch {
      // Sync failed, still refresh from cache/DB
    } finally {
      setIsSyncing(false);
    }
    if (user?.id) await clearIDBPositionCache(user.id);
    await Promise.all([refreshPositions(), loadClosedToday()]);
  }, [user?.id, refreshPositions, loadClosedToday]);

  const loadBrokerConnections = useCallback(async () => {
    if (!user) return;
    try {
      const result = await getBrokerConnectionsAction();
      if (result?.success && result?.data) {
        setBrokerConnections(
          result?.data.map((conn) => ({
            id: conn.id,
            broker: conn.broker,
            brokerUserId: conn.brokerUserId || null,
            accountName: conn.accountName || null,
          }))
        );
      }
    } catch (e) {
      console.error("Failed to load broker connections");
    }
  }, [user]);

  // Helper to get display name for a position based on broker connection
  const getBrokerDisplayName = useCallback(
    (broker?: string | null, brokerUserId?: string | null) => {
      if (!broker || broker === "MANUAL") return "Manual";

      // Find matching broker connection
      const connection = brokerConnections.find(
        (conn) => conn.broker === broker && conn.brokerUserId === brokerUserId
      );

      if (connection?.accountName) {
        return connection.accountName;
      }

      // Fallback to broker name
      return broker.charAt(0) + broker.slice(1).toLowerCase();
    },
    [brokerConnections]
  );

  // Initial load effect
  useEffect(() => {
    if (!mounted) return;
    const demoMode = localStorage.getItem("tradebook_demo_mode");
    if (!isLoaded) return;

    // Clear demo mode if user is authenticated
    if (user && demoMode) {
      localStorage.removeItem("tradebook_demo_mode");
      localStorage.removeItem("tradebook_user_id");
    }

    if (!user && !demoMode) {
      router.push("/home");
      return;
    }
    // Data fetching is now handled by useIDBCache (filter changes trigger new cache key)
    loadBrokerConnections();
    loadClosedToday();
  }, [isLoaded, user, router, mounted, loadBrokerConnections, loadClosedToday]);

  const handleClosePosition = async () => {
    if (!selectedPosition || !closePrice) {
      toast.error("Please enter exit price");
      return;
    }

    setIsClosing(true);
    try {
      const result = await closePositionAction(
        selectedPosition.id,
        parseFloat(closePrice)
      );

      if (result?.success) {
        toast.success(
          result.message ||
            `Position closed! P&L: ${formatPnL(result?.data?.pnl || 0)}`
        );
        setShowCloseDialog(false);
        setSelectedPosition(null);
        setClosePrice("");
        fetchPositions();
      } else {
        toast.error(result?.error || "Failed to close position");
      }
    } catch (error) {
      toast.error("Failed to close position");
    } finally {
      setIsClosing(false);
    }
  };

  const handleAddPosition = async (formData: TradeFormData) => {
    startTransition(async () => {
      try {
        const result = await createTradeAction({
          ...formData,
          symbol: formData.symbol.toUpperCase(),
          quantity: formData.quantity,
          price: formData.price,
          broker: formData.broker || "manual",
        });

        if (result?.success) {
          toast.success("Position opened!");
          setShowAddDialog(false);
          fetchPositions();
        } else {
          toast.error(result?.error || "Failed to open position");
        }
      } catch (error) {
        toast.error("Failed to open position");
      }
    });
  };

  // Client-side sorting for positions
  const sortedPositions = [...positions].sort((a, b) => {
    if (sortBy === "date") {
      const dateA = new Date(a.tradeDate).getTime();
      const dateB = new Date(b.tradeDate).getTime();
      return sortOrder === "desc" ? dateB - dateA : dateA - dateB;
    } else {
      // Sort by P&L
      const pnlA =
        a.unrealizedPnL ||
        (a.positionType === "LONG"
          ? ((a.currentPrice || a.entryPrice * 1.02) - a.entryPrice) *
            a.quantity
          : (a.entryPrice - (a.currentPrice || a.entryPrice * 1.02)) *
            a.quantity);
      const pnlB =
        b.unrealizedPnL ||
        (b.positionType === "LONG"
          ? ((b.currentPrice || b.entryPrice * 1.02) - b.entryPrice) *
            b.quantity
          : (b.entryPrice - (b.currentPrice || b.entryPrice * 1.02)) *
            b.quantity);
      return sortOrder === "desc" ? pnlB - pnlA : pnlA - pnlB;
    }
  });
  const filteredPositions = sortedPositions;

  // Reset page on filter/sort change
  useEffect(() => {
    setPosPage(0);
  }, [filters.symbol, filters.broker, filters.segment, sortBy, sortOrder]);

  const paginatedPositions = filteredPositions.slice(
    posPage * POS_PER_PAGE,
    (posPage + 1) * POS_PER_PAGE
  );
  const totalPosPages = Math.ceil(filteredPositions.length / POS_PER_PAGE);

  const clearFilters = () => {
    setFilters(initialFilters);
  };

  return (
    <PageGuard
      route="/positions"
      fallback={<PositionsSkeleton />}
      containerClassName="p-4 sm:p-6 pb-48 sm:pb-44"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />

        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="pf-page">
            {isDemoMode && <DemoBanner />}

            {/* Header */}
            <PfPageHead
              eyebrow={
                summary
                  ? `${summary.totalPositions} OPEN · ${summary.longPositions} LONG · ${summary.shortPositions} SHORT · LIVE P&L`
                  : "OPEN POSITIONS · F&O & INTRADAY"
              }
              title={
                <>
                  Live positions, <span className="ser">live P&amp;L.</span>
                </>
              }
              sub="Active trades awaiting exit — squared off, you'll see realised P&L in the tradebook."
              right={
                <>
                  <button
                    type="button"
                    className="pf-bf"
                    onClick={fetchPositions}
                    disabled={isLoading || isSyncing}
                  >
                    <RefreshCw
                      className={
                        isLoading || isSyncing ? "animate-spin" : undefined
                      }
                      size={13}
                    />
                    {isSyncing ? "Syncing…" : "Refresh"}
                  </button>
                  <button
                    type="button"
                    className="pf-bs"
                    onClick={() => setShowAddDialog(true)}
                  >
                    <Plus size={13} /> Open position
                  </button>
                </>
              }
            />

            {brokerStatus.status === "needs_reauth" &&
              brokerStatus.reauthUrl &&
              brokerStatus.brokerDisplayName && (
                <BrokerReauthBanner
                  brokerName={brokerStatus.brokerDisplayName}
                  reauthUrl={brokerStatus.reauthUrl}
                  className="mb-6"
                />
              )}

            {isLoading ? (
              <>
                {/* Summary strip skeleton */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(5, 1fr)",
                    gap: 12,
                    marginBottom: 18,
                  }}
                >
                  {[
                    "OPEN POSITIONS",
                    "TOTAL INVESTED",
                    "UNREALISED P&L",
                    "LONG",
                    "SHORT",
                  ].map((label) => (
                    <div
                      key={label}
                      className="pf-card pf-stat flat"
                      style={{ background: "var(--rule-softer)" }}
                    >
                      <div className="l">{label}</div>
                      <div
                        className="v"
                        style={{ color: "var(--ink-4)", fontSize: 22 }}
                      >
                        ····
                      </div>
                    </div>
                  ))}
                </div>

                {/* Table skeleton */}
                <div
                  className="pf-card"
                  style={{ padding: 0, overflow: "hidden" }}
                >
                  <table className="pf-tbl">
                    <thead>
                      <tr>
                        <th style={{ paddingLeft: 18 }}>SYM</th>
                        <th>SIDE</th>
                        <th>PRODUCT</th>
                        <th>BROKER</th>
                        <th style={{ textAlign: "right" }}>QTY</th>
                        <th style={{ textAlign: "right" }}>AVG</th>
                        <th style={{ textAlign: "right" }}>LTP</th>
                        <th style={{ textAlign: "right" }}>P&amp;L</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {[1, 2, 3, 4, 5, 6].map((i) => (
                        <tr key={i}>
                          <td
                            style={{ paddingLeft: 18, color: "var(--ink-4)" }}
                          >
                            ········
                          </td>
                          <td style={{ color: "var(--ink-4)" }}>···</td>
                          <td style={{ color: "var(--ink-4)" }}>···</td>
                          <td style={{ color: "var(--ink-4)" }}>······</td>
                          <td
                            className="num"
                            style={{
                              textAlign: "right",
                              color: "var(--ink-4)",
                            }}
                          >
                            ··
                          </td>
                          <td
                            className="num"
                            style={{
                              textAlign: "right",
                              color: "var(--ink-4)",
                            }}
                          >
                            ····
                          </td>
                          <td
                            className="num"
                            style={{
                              textAlign: "right",
                              color: "var(--ink-4)",
                            }}
                          >
                            ····
                          </td>
                          <td
                            className="num"
                            style={{
                              textAlign: "right",
                              color: "var(--ink-4)",
                            }}
                          >
                            ·····
                          </td>
                          <td />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <>
                {/* Summary strip */}
                {summary && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(5, 1fr)",
                      gap: 12,
                      marginBottom: 18,
                    }}
                    className="pos-strip"
                  >
                    <div
                      className="pf-card pf-stat flat"
                      style={{ background: "var(--rule-softer)" }}
                    >
                      <div className="l">OPEN POSITIONS</div>
                      <div className="v" style={{ fontSize: 22 }}>
                        {summary.totalPositions}
                      </div>
                    </div>
                    <div
                      className="pf-card pf-stat flat"
                      style={{ background: "var(--rule-softer)" }}
                    >
                      <div className="l">TOTAL INVESTED</div>
                      <div className="v" style={{ fontSize: 22 }}>
                        {formatCurrency(summary.totalInvested)}
                      </div>
                    </div>
                    <div
                      className="pf-card pf-stat flat"
                      style={{ background: "var(--rule-softer)" }}
                    >
                      <div className="l">UNREALISED P&amp;L</div>
                      <div
                        className="v"
                        style={{
                          fontSize: 22,
                          color:
                            summary.unrealizedPnL >= 0
                              ? "var(--emerald)"
                              : "var(--pop-1)",
                        }}
                      >
                        {formatPnL(summary.unrealizedPnL)}
                      </div>
                    </div>
                    <div
                      className="pf-card pf-stat flat"
                      style={{ background: "var(--rule-softer)" }}
                    >
                      <div className="l">LONG</div>
                      <div
                        className="v"
                        style={{ fontSize: 22, color: "var(--emerald)" }}
                      >
                        {summary.longPositions}
                      </div>
                    </div>
                    <div
                      className="pf-card pf-stat flat"
                      style={{ background: "var(--rule-softer)" }}
                    >
                      <div className="l">SHORT</div>
                      <div
                        className="v"
                        style={{ fontSize: 22, color: "var(--pop-1)" }}
                      >
                        {summary.shortPositions}
                      </div>
                    </div>
                  </div>
                )}

                {/* Filters */}
                <div
                  className="pf-card"
                  style={{ padding: 14, marginBottom: 14 }}
                >
                  <TradeFilters
                    filters={filters}
                    onChange={setFilters}
                    onClear={clearFilters}
                    showType={false}
                    showDateRange={false}
                    brokerConnections={brokerConnections}
                  />
                </div>

                {/* Positions Table */}
                <div
                  className="pf-card"
                  style={{ padding: 0, overflow: "hidden" }}
                >
                  {filteredPositions.length === 0 ? (
                    <div
                      style={{
                        textAlign: "center",
                        padding: "48px 24px",
                      }}
                    >
                      <Target
                        size={40}
                        style={{
                          margin: "0 auto 14px",
                          color: "var(--ink-4)",
                        }}
                      />
                      <h3
                        style={{
                          fontSize: 18,
                          fontWeight: 800,
                          letterSpacing: -0.4,
                          color: "var(--ink)",
                          marginBottom: 6,
                        }}
                      >
                        No open positions
                      </h3>
                      <p
                        style={{
                          fontFamily: "Instrument Serif, serif",
                          fontStyle: "italic",
                          fontSize: 15,
                          color: "var(--ink-3)",
                          marginBottom: 16,
                        }}
                      >
                        Open a position to get started.
                      </p>
                      <button
                        type="button"
                        className="pf-bs"
                        onClick={() => setShowAddDialog(true)}
                        style={{ margin: "0 auto" }}
                      >
                        <Plus size={14} /> Open position
                      </button>
                    </div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table className="pf-tbl">
                        <thead>
                          <tr>
                            {/* Date - sortable */}
                            <th style={{ paddingLeft: 18 }}>
                              <button
                                type="button"
                                onClick={() => {
                                  if (sortBy === "date") {
                                    setSortOrder((s) =>
                                      s === "desc" ? "asc" : "desc"
                                    );
                                  } else {
                                    setSortBy("date");
                                    setSortOrder("desc");
                                  }
                                }}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 4,
                                  font: "inherit",
                                  letterSpacing: "inherit",
                                  textTransform: "inherit",
                                  color:
                                    sortBy === "date"
                                      ? "var(--emerald)"
                                      : "inherit",
                                  background: "transparent",
                                  border: 0,
                                  cursor: "pointer",
                                }}
                              >
                                DATE
                                {sortBy === "date" &&
                                  (sortOrder === "desc" ? (
                                    <ArrowDown size={11} />
                                  ) : (
                                    <ArrowUp size={11} />
                                  ))}
                              </button>
                            </th>
                            <th>SYM</th>
                            <th>SIDE</th>
                            <th>PRODUCT</th>
                            <th>BROKER</th>
                            <th style={{ textAlign: "right" }}>QTY</th>
                            <th style={{ textAlign: "right" }}>AVG</th>
                            <th style={{ textAlign: "right" }}>LTP</th>
                            {/* P&L - sortable */}
                            <th style={{ textAlign: "right" }}>
                              <button
                                type="button"
                                onClick={() => {
                                  if (sortBy === "pnl") {
                                    setSortOrder((s) =>
                                      s === "desc" ? "asc" : "desc"
                                    );
                                  } else {
                                    setSortBy("pnl");
                                    setSortOrder("desc");
                                  }
                                }}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 4,
                                  font: "inherit",
                                  letterSpacing: "inherit",
                                  textTransform: "inherit",
                                  marginLeft: "auto",
                                  color:
                                    sortBy === "pnl"
                                      ? "var(--emerald)"
                                      : "inherit",
                                  background: "transparent",
                                  border: 0,
                                  cursor: "pointer",
                                }}
                              >
                                P&amp;L
                                {sortBy === "pnl" &&
                                  (sortOrder === "desc" ? (
                                    <ArrowDown size={11} />
                                  ) : (
                                    <ArrowUp size={11} />
                                  ))}
                              </button>
                            </th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {paginatedPositions.map((pos) => {
                            const entryPrice = pos.entryPrice || pos.price || 0;
                            const currentPrice =
                              pos.currentPrice || entryPrice * 1.02;
                            const pnl =
                              pos.unrealizedPnL ||
                              (pos.positionType === "LONG"
                                ? (currentPrice - entryPrice) * pos.quantity
                                : (entryPrice - currentPrice) * pos.quantity);
                            const pnlPercent =
                              entryPrice > 0
                                ? (pnl / (entryPrice * pos.quantity)) * 100
                                : 0;

                            const isLong = pos.tradeType === "BUY";
                            const productCode =
                              pos.productType ||
                              pos.segmentLabel ||
                              getSegmentLabel(pos.segment);
                            const productTitle = pos.productType
                              ? getProductTypeLabel(pos.productType)
                              : pos.segmentLabel ||
                                getSegmentLabel(pos.segment);
                            const isManual =
                              !pos.broker || pos.broker === "MANUAL";

                            return (
                              <tr key={pos.id}>
                                {/* Date */}
                                <td
                                  className="num"
                                  style={{
                                    paddingLeft: 18,
                                    color: "var(--ink-3)",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {new Date(pos.tradeDate).toLocaleDateString(
                                    "en-IN",
                                    {
                                      day: "2-digit",
                                      month: "short",
                                      year: "2-digit",
                                    }
                                  )}
                                </td>
                                {/* Symbol */}
                                <td style={{ maxWidth: 240 }}>
                                  <div
                                    className="tk"
                                    title={pos.symbol}
                                    style={{
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {pos.symbol}
                                  </div>
                                  <div className="nm">{pos.exchange}</div>
                                </td>
                                {/* Side */}
                                <td>
                                  <span
                                    className={`pf-pill ${isLong ? "emerald" : "coral"}`}
                                    style={{ fontSize: 9.5 }}
                                  >
                                    {isLong ? "LONG" : "SHORT"}
                                  </span>
                                </td>
                                {/* Product */}
                                <td>
                                  <span
                                    className="pf-pill outline"
                                    style={{ fontSize: 9.5 }}
                                    title={productTitle}
                                  >
                                    {productCode}
                                  </span>
                                </td>
                                {/* Broker */}
                                <td>
                                  <span
                                    className="br-chip"
                                    style={{
                                      padding: "3px 8px",
                                      fontSize: 11,
                                    }}
                                  >
                                    <BrokerLogo
                                      slug={
                                        isManual
                                          ? "manual"
                                          : toBrokerSlug(pos.broker)
                                      }
                                      size={11}
                                    />
                                    {getBrokerDisplayName(
                                      pos.broker,
                                      pos.brokerUserId
                                    )}
                                  </span>
                                </td>
                                {/* Qty */}
                                <td
                                  className="num"
                                  style={{ textAlign: "right" }}
                                >
                                  {pos.quantity}
                                </td>
                                {/* Avg / Entry */}
                                <td
                                  className="num"
                                  style={{
                                    textAlign: "right",
                                    color: "var(--ink-3)",
                                  }}
                                >
                                  ₹{entryPrice.toFixed(2)}
                                </td>
                                {/* LTP */}
                                <td
                                  className="num"
                                  style={{ textAlign: "right" }}
                                >
                                  ₹{currentPrice.toFixed(2)}
                                </td>
                                {/* P&L */}
                                <td
                                  className={`num ${pnl >= 0 ? "pos" : "neg"}`}
                                  style={{
                                    textAlign: "right",
                                    fontWeight: 700,
                                  }}
                                >
                                  {formatPnL(pnl)}
                                  <div
                                    style={{
                                      fontSize: 11,
                                      fontWeight: 500,
                                      color: "var(--ink-3)",
                                    }}
                                  >
                                    {pnl >= 0 ? "+" : ""}
                                    {pnlPercent.toFixed(1)}%
                                  </div>
                                </td>
                                {/* Actions */}
                                <td style={{ textAlign: "right" }}>
                                  <div
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      justifyContent: "flex-end",
                                      gap: 6,
                                    }}
                                  >
                                    {isAnalyzable(pos.segment) && (
                                      <button
                                        type="button"
                                        className="pf-bf sm"
                                        title="Analyse with StockSage"
                                        style={{ padding: "4px 7px" }}
                                        onClick={() => {
                                          const isMfSegment =
                                            pos.segment === "MF";
                                          setResearchModalEntity({
                                            symbol: pos.symbol,
                                            name: pos.symbol,
                                            type: isMfSegment ? "mf" : "stock",
                                            exchange: pos.exchange || "NSE",
                                          });
                                          // Determine if position is open or closed
                                          const isOpen = pos.quantity !== 0;
                                          const tradeDate = new Date(
                                            pos.tradeDate
                                          ).toLocaleDateString("en-IN", {
                                            day: "2-digit",
                                            month: "short",
                                            year: "numeric",
                                          });
                                          setResearchPositionData(
                                            isOpen
                                              ? {
                                                  status: "open",
                                                  quantity: Math.abs(
                                                    pos.quantity
                                                  ),
                                                  purchasePrice: entryPrice,
                                                  purchaseDate: tradeDate,
                                                  currentPrice,
                                                  unrealizedPnL: pnl,
                                                }
                                              : {
                                                  status: "closed",
                                                  quantity: Math.abs(
                                                    pos.quantity
                                                  ),
                                                  purchasePrice: entryPrice,
                                                  purchaseDate: tradeDate,
                                                  sellPrice: currentPrice,
                                                  sellDate: tradeDate,
                                                  realizedPnL: pnl,
                                                }
                                          );
                                          setResearchModalOpen(true);
                                        }}
                                      >
                                        <Brain size={13} />
                                      </button>
                                    )}
                                    {isManual ? (
                                      <button
                                        type="button"
                                        className="pf-bf sm"
                                        style={{
                                          padding: "4px 8px",
                                          fontSize: 11,
                                        }}
                                        onClick={() => {
                                          setSelectedPosition({
                                            ...pos,
                                            entryPrice,
                                            currentPrice,
                                          });
                                          setClosePrice(
                                            currentPrice.toString()
                                          );
                                          setShowCloseDialog(true);
                                        }}
                                      >
                                        Close
                                      </button>
                                    ) : (
                                      <span
                                        className="pf-pill outline"
                                        style={{ fontSize: 9.5 }}
                                      >
                                        SYNCED
                                      </span>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {filteredPositions.length > 0 && (
                    <div
                      style={{
                        borderTop: "1.5px solid var(--rule-soft)",
                      }}
                    >
                      <PaginationControls
                        currentPage={posPage}
                        totalPages={totalPosPages}
                        onPageChange={setPosPage}
                        pageSize={POS_PER_PAGE}
                        totalItems={filteredPositions.length}
                        label="positions"
                      />
                    </div>
                  )}
                </div>

                {/* Closed Today Section */}
                {closedTodayPositions.length > 0 &&
                  (() => {
                    const closedPnL = closedTodayPositions.reduce(
                      (s, p) => s + p.realizedPnL,
                      0
                    );
                    return (
                      <div
                        className="pf-card"
                        style={{
                          padding: 0,
                          overflow: "hidden",
                          marginTop: 22,
                        }}
                      >
                        <div
                          className="pf-sec-h"
                          style={{ margin: "16px 18px 4px" }}
                        >
                          <span className="n">CLOSED TODAY</span>
                          <h3>
                            Squared off, <span className="ser">realised.</span>
                          </h3>
                          <span className="rule" />
                          <span className="meta">
                            {closedTodayPositions.length} · realised{" "}
                            <span
                              style={{
                                color:
                                  closedPnL >= 0
                                    ? "var(--emerald)"
                                    : "var(--pop-1)",
                                fontWeight: 700,
                              }}
                            >
                              {formatPnL(closedPnL)}
                            </span>
                          </span>
                        </div>
                        <div style={{ overflowX: "auto" }}>
                          <table className="pf-tbl">
                            <thead>
                              <tr>
                                <th style={{ paddingLeft: 18 }}>SYM</th>
                                <th>SEGMENT</th>
                                <th>BROKER</th>
                                <th style={{ textAlign: "right" }}>QTY</th>
                                <th style={{ textAlign: "right" }}>BUY</th>
                                <th style={{ textAlign: "right" }}>SELL</th>
                                <th style={{ textAlign: "right" }}>P&amp;L</th>
                              </tr>
                            </thead>
                            <tbody>
                              {closedTodayPositions.map((cp) => {
                                const cpManual = !cp.broker;
                                return (
                                  <tr key={cp.id}>
                                    <td
                                      style={{
                                        paddingLeft: 18,
                                        maxWidth: 240,
                                      }}
                                    >
                                      <div
                                        className="tk"
                                        title={cp.symbol}
                                        style={{
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {cp.symbol}
                                      </div>
                                      <div className="nm">{cp.exchange}</div>
                                    </td>
                                    <td>
                                      <span
                                        className="pf-pill outline"
                                        style={{ fontSize: 9.5 }}
                                      >
                                        {cp.segmentLabel || cp.segment}
                                      </span>
                                    </td>
                                    <td>
                                      <span
                                        className="br-chip"
                                        style={{
                                          padding: "3px 8px",
                                          fontSize: 11,
                                        }}
                                      >
                                        <BrokerLogo
                                          slug={
                                            cpManual
                                              ? "manual"
                                              : toBrokerSlug(cp.broker)
                                          }
                                          size={11}
                                        />
                                        {getBrokerDisplayName(
                                          cp.broker,
                                          cp.brokerUserId
                                        )}
                                      </span>
                                    </td>
                                    <td
                                      className="num"
                                      style={{ textAlign: "right" }}
                                    >
                                      {cp.quantity}
                                    </td>
                                    <td
                                      className="num"
                                      style={{
                                        textAlign: "right",
                                        color: "var(--ink-3)",
                                      }}
                                    >
                                      {formatCurrency(cp.buyPrice)}
                                    </td>
                                    <td
                                      className="num"
                                      style={{
                                        textAlign: "right",
                                        color: "var(--ink-3)",
                                      }}
                                    >
                                      {formatCurrency(cp.sellPrice)}
                                    </td>
                                    <td
                                      className={`num ${cp.realizedPnL >= 0 ? "pos" : "neg"}`}
                                      style={{
                                        textAlign: "right",
                                        fontWeight: 700,
                                      }}
                                    >
                                      {formatPnL(cp.realizedPnL)}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })()}
              </>
            )}
          </div>

          {/* Add Position Dialog */}
          <AddTradeDialog
            open={showAddDialog}
            onOpenChange={setShowAddDialog}
            onSave={handleAddPosition}
            title="Open New Position"
            isPosition={true}
          />

          {/* Close Position Dialog */}
          <Dialog open={showCloseDialog} onOpenChange={setShowCloseDialog}>
            <DialogContent
              style={{
                background: "var(--paper)",
                border: "2px solid var(--ink)",
                borderRadius: 16,
                boxShadow: "var(--shadow-hard)",
                color: "var(--ink)",
              }}
            >
              <DialogHeader className="text-left">
                <DialogTitle
                  style={{
                    fontSize: 18,
                    fontWeight: 800,
                    letterSpacing: "-0.4px",
                    color: "var(--ink)",
                  }}
                >
                  Close Position - {selectedPosition?.symbol}
                </DialogTitle>
                <DialogDescription
                  className="ser"
                  style={{
                    fontSize: 16,
                    color: "var(--ink-2)",
                    lineHeight: 1.4,
                  }}
                >
                  Enter exit price to close this{" "}
                  {selectedPosition?.positionType?.toLowerCase()} position
                </DialogDescription>
              </DialogHeader>
              {selectedPosition && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label
                        className="mono"
                        style={{
                          fontSize: 11,
                          color: "var(--ink-3)",
                          letterSpacing: "1px",
                          textTransform: "uppercase",
                        }}
                      >
                        Entry Price
                      </Label>
                      <p
                        className="mono"
                        style={{
                          fontSize: 18,
                          fontWeight: 700,
                          color: "var(--ink)",
                        }}
                      >
                        ₹{selectedPosition.entryPrice?.toFixed(2)}
                      </p>
                    </div>
                    <div>
                      <Label
                        className="mono"
                        style={{
                          fontSize: 11,
                          color: "var(--ink-3)",
                          letterSpacing: "1px",
                          textTransform: "uppercase",
                        }}
                      >
                        Quantity
                      </Label>
                      <p
                        className="mono"
                        style={{
                          fontSize: 18,
                          fontWeight: 700,
                          color: "var(--ink)",
                        }}
                      >
                        {selectedPosition.quantity}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label
                      className="mono"
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "var(--ink-2)",
                        letterSpacing: "0.3px",
                      }}
                    >
                      Exit Price
                    </Label>
                    <Input
                      type="number"
                      step="0.01"
                      className="pf-input"
                      placeholder="Exit price"
                      value={closePrice}
                      onChange={(e) => setClosePrice(e.target.value)}
                    />
                  </div>
                  {closePrice && (
                    <div
                      style={{
                        padding: 14,
                        background: "var(--pop-2)",
                        border: "2px solid var(--ink)",
                        borderRadius: 10,
                        boxShadow: "var(--shadow-soft)",
                      }}
                    >
                      <div className="flex justify-between items-center">
                        <span
                          className="mono"
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: "1px",
                            color: "#3a3a35",
                          }}
                        >
                          ESTIMATED P&L
                        </span>
                        {(() => {
                          const pnl =
                            selectedPosition.positionType === "LONG"
                              ? (parseFloat(closePrice) -
                                  selectedPosition.entryPrice) *
                                selectedPosition.quantity
                              : (selectedPosition.entryPrice -
                                  parseFloat(closePrice)) *
                                selectedPosition.quantity;
                          return (
                            <span
                              className="mono"
                              style={{
                                fontWeight: 800,
                                fontSize: 18,
                                color: pnl >= 0 ? "#15803d" : "#b91c1c",
                              }}
                            >
                              {formatPnL(pnl)}
                            </span>
                          );
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <DialogFooter className="sm:justify-end">
                <button
                  type="button"
                  className="pf-bf sm"
                  onClick={() => setShowCloseDialog(false)}
                >
                  <X className="h-3.5 w-3.5" /> Cancel
                </button>
                <button
                  type="button"
                  className="pf-bs sm disabled:opacity-50"
                  onClick={handleClosePosition}
                  disabled={isClosing}
                >
                  <Save className="h-3.5 w-3.5" />{" "}
                  {isClosing ? "Closing..." : "Close Position"}
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </main>

        <ResearchModal
          open={researchModalOpen}
          onOpenChange={setResearchModalOpen}
          entity={researchModalEntity}
          positionData={researchPositionData}
        />
      </div>
    </PageGuard>
  );
}
