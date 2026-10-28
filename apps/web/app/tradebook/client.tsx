"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { toast } from "sonner";
import {
  Plus,
  Table2,
  Upload,
  History,
  Download,
  RefreshCw,
  FileText,
  FileSpreadsheet,
  Braces,
  X,
  SearchX,
  AlertTriangle,
  Loader2,
  ChevronDown,
  Receipt,
  Search,
} from "lucide-react";

import { TerminalLuxeShell } from "@/components/terminal-luxe/Shell";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { TakeTheTourButton } from "@/components/walkthrough";
import {
  BrokerLogo,
  toBrokerSlug,
  Dropdown,
  fmtINR,
  fmtINRSigned,
  fmtLakhs,
} from "@/components/terminal-luxe/primitives";
import {
  ManualEntryModal,
  type ManualEntrySubmission,
} from "@/components/terminal-luxe/ManualEntryModal";
import { rangeToDates, type RangeId } from "./lib/range-filter";

import {
  getTradesAction,
  createTradeAction,
  getAvailableFYsAction,
  type FinancialYearOption,
} from "@/lib/actions/trades";
import {
  getBrokerConnectionsAction,
  syncAllBrokersAction,
  getActiveBrokerJobsAction,
} from "@/lib/actions/broker-connection";
import { useIDBCache } from "@/hooks/useIDBCache";
import { PageGuard } from "@/components/PageGuard";
import { PaginationControls } from "@/components/PaginationControls";
import { TradebookSkeleton } from "@/components/skeletons";
import { DemoBanner } from "@/components/DemoBanner";
import BrokerReauthBanner from "@/components/BrokerReauthBanner";
import { useBrokerStatus } from "@/hooks/useBrokerStatus";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

/* =====================================================================
   Types matching getTradesAction return shapes
   ===================================================================== */

interface BrokerConnection {
  id: string;
  broker: string;
  brokerUserId: string | null;
  accountName: string | null;
}

interface Trade {
  id: string;
  symbol: string;
  exchange: string;
  segment: string;
  segmentLabel?: string;
  tradeType: string;
  productType?: string;
  productTypeLabel?: string;
  quantity: number;
  price: number;
  status: string;
  /**
   * MONEY-840: realised P&L for the row, sourced from the persisted
   * PairedTradeView (attributed to the closing SELL of a CLOSED/PARTIAL lot).
   * `null` for rows with no realised component (open buys, un-paired rows).
   */
  realizedPnL: number | null;
  tradeDate: string | Date;
  broker: string | null;
  brokerUserId?: string | null;
  brokerName: string | null;
  sourceType?: string;
}

/* The shape we actually rely on from `getTradesAction` - kept loose
   because the action computes a richer `stats` server-side but only the
   fields below are surfaced in the redesigned UI. */
interface TradeStats {
  totalPnL: number;
  winRate: number;
  winners: number;
  losers: number;
  closedCount: number;
  /**
   * MONEY-1257 — BUY/SELL across the whole filtered set, from the server.
   * Optional because a cached payload written before this shipped has neither
   * field; the tile falls back to the page-derived split in that case, which
   * is what it always showed.
   */
  buyCount?: number;
  sellCount?: number;
}

interface TradebookPageProps {
  initialTrades?: {
    trades: Trade[];
    stats: TradeStats & {
      // Page server pads in the extra fields the cache shape ignores -
      // we accept them but don't use them.
      totalUnrealizedPnL?: number;
      openCount?: number;
      segmentBreakdown?: unknown[];
    };
    total: number;
  } | null;
  isDemo?: boolean;
}

type SidePill = "All" | "Buy" | "Sell" | "Intraday" | "Delivery";

const RANGE_LABEL: Record<RangeId, string> = {
  "7d": "7d",
  "30d": "30d",
  "3m": "3M",
  fy: "FY",
  pfy: "Prev FY",
  all: "All",
};

/* MONEY-847: the quick rolling pills. The fy/pfy windows moved into a dynamic
   FY dropdown (built from the user's real trade span), so they're no longer
   hard-coded pills here. */
const QUICK_RANGES: RangeId[] = ["7d", "30d", "3m", "all"];

/* Segment dropdown choices → display label, for the active-filter chip. Keys
   match the <Dropdown> option values below. */
const SEG_LABEL: Record<string, string> = {
  equity: "Equity",
  options: "F&O",
  commodity: "Commodity",
  currency: "Currency",
};

/* The default filter values used as the initial state below. Kept here so the
   `filterKey` template and the SSR-`initialData` guard share ONE definition and
   can't drift (order: side-range-fyId-seg-broker-symbolQuery). */
const DEFAULT_FILTER = {
  side: "All" as SidePill,
  /**
   * "all", NOT "30d".
   *
   * Two reasons, and the first is a straight defect. `app/tradebook/page.tsx`
   * SSR-fetches `getTradesAction({ limit: 20, skip: 0 })` — NO date bounds, so
   * the payload is every trade. The client then handed that unfiltered payload
   * to `initialData` as if it were the 30-day view, so first paint showed
   * trades that the first real fetch immediately removed. The default has to
   * describe the payload it is actually given.
   *
   * Second, a 30-day default silently hides accounts whose data is older than
   * a month — an imported tradebook, a dormant account, anyone returning after
   * a break. They open the page, see "No trades match these filters", and
   * reasonably conclude the filters are broken. Measured on a real account:
   * 157 trades, every one of them from 2023, so the landing view was empty and
   * every rolling window (7d/30d/3M) correctly returned zero. Nothing was
   * wrong with the filters; the default was choosing a window the data could
   * not satisfy.
   *
   * "All" is also the only default that cannot be empty while trades exist,
   * which is the property that matters for a page whose whole job is showing
   * them.
   */
  range: "all" as RangeId,
  fyId: "",
  seg: "all",
  broker: "all",
  symbol: "",
} as const;
const DEFAULT_FILTER_KEY = `${DEFAULT_FILTER.side}-${DEFAULT_FILTER.range}-${DEFAULT_FILTER.fyId}-${DEFAULT_FILTER.seg}-${DEFAULT_FILTER.broker}-${DEFAULT_FILTER.symbol}`;

/**
 * Shown when the trades fetch FAILED, in place of the empty state.
 *
 * These two outcomes render into the same slot and used to be the same thing:
 * a thrown fetcher left `data` undefined, `trades` fell back to `[]`, and the
 * user was told "No trades match these filters. Try widening the period or
 * clearing filters." That sentence is a diagnosis, and when the request 500s
 * or times out it is the WRONG one — it sends the user to adjust filters that
 * were never the problem, and it makes a real outage look like an ordinary
 * empty result to anyone reading a screenshot.
 *
 * Deliberately does NOT print the raw error: `useIDBCache` surfaces whatever
 * the action threw, and this repo sanitizes user-facing errors. "Retry" is
 * offered because the common causes here (a transient network blip, an
 * expired session) are ones a retry actually resolves.
 */
function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <>
      <AlertTriangle
        style={{ width: 22, height: 22, marginBottom: 6 }}
        aria-hidden
      />
      <div style={{ fontSize: 13 }}>Couldn&apos;t load your trades.</div>
      <div style={{ fontSize: 11.5, marginTop: 2 }}>
        This is a loading problem, not your filters.
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="pf-bf sm"
        style={{ marginTop: 10 }}
      >
        <RefreshCw style={{ width: 12, height: 12 }} aria-hidden />
        Retry
      </button>
    </>
  );
}

/**
 * Empty result. Distinguishes "your PERIOD excluded everything" from "your
 * other filters excluded everything", because the fix differs and the user
 * cannot see which one applies.
 *
 * The old copy — "No trades match these filters. Try widening the period or
 * clearing filters." — named both possibilities and committed to neither, so
 * on an account whose trades are older than the selected window it read as a
 * malfunction rather than an out-of-range query. Offering the widened view as
 * a BUTTON (rather than advice) means the answer is one click away instead of
 * a hunt through the pills.
 */
function NoResults({
  periodActive,
  onShowAll,
}: {
  periodActive: boolean;
  onShowAll: () => void;
}) {
  return (
    <>
      <SearchX style={{ width: 22, height: 22, marginBottom: 6 }} aria-hidden />
      <div style={{ fontSize: 13 }}>
        {periodActive
          ? "No trades in the selected period."
          : "No trades match these filters."}
      </div>
      <div style={{ fontSize: 11.5, marginTop: 2 }}>
        {periodActive
          ? "Your trades may be older than this window."
          : "Try clearing a filter."}
      </div>
      {periodActive && (
        <button
          type="button"
          onClick={onShowAll}
          className="pf-bf sm"
          style={{ marginTop: 10 }}
        >
          Show all trades
        </button>
      )}
    </>
  );
}

/* Broker accent dots for the playful broker chips (design palette). */
const BROKER_DOT: Record<string, string> = {
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
function brokerDot(b?: string | null): string {
  return BROKER_DOT[(b ?? "").toLowerCase()] ?? "var(--ink-3)";
}

/* =====================================================================
   Import / Export dropdown — matches screens-tradebook-v2 design. A
   `.pf-bf` / `.pf-bs` trigger reveals a playful card menu of routes /
   actions. Each item navigates to an existing flow (import wizard, broker
   resync, manual add, import history) or export route — nothing stubbed.
   ===================================================================== */
interface MenuAction {
  key: string;
  label: string;
  desc?: string;
  icon: typeof Upload;
  onClick: () => void;
  featured?: boolean;
}
function ActionMenu({
  trigger,
  items,
  align = "left",
}: {
  trigger: React.ReactNode;
  items: MenuAction[];
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <span onClick={() => setOpen((o) => !o)}>{trigger}</span>
      {open && (
        <div
          className="pf-card"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            [align]: 0,
            zIndex: 50,
            minWidth: 244,
            padding: 6,
            boxShadow: "var(--shadow-soft)",
          }}
        >
          {items.map((it) => {
            const I = it.icon;
            return (
              <button
                key={it.key}
                type="button"
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "9px 10px",
                  borderRadius: 8,
                  border: 0,
                  background: it.featured ? "var(--emerald-bg)" : "transparent",
                  color: "var(--ink)",
                  cursor: "pointer",
                  textAlign: "left",
                  font: "inherit",
                }}
                onMouseEnter={(e) => {
                  if (!it.featured)
                    e.currentTarget.style.background = "var(--rule-softer)";
                }}
                onMouseLeave={(e) => {
                  if (!it.featured)
                    e.currentTarget.style.background = "transparent";
                }}
              >
                <I
                  size={15}
                  style={{
                    flexShrink: 0,
                    marginTop: 1,
                    color: it.featured ? "var(--emerald-text)" : "var(--ink-3)",
                  }}
                />
                <span style={{ minWidth: 0 }}>
                  <span
                    style={{ display: "block", fontSize: 13, fontWeight: 700 }}
                  >
                    {it.label}
                  </span>
                  {it.desc && (
                    <span
                      style={{
                        display: "block",
                        fontSize: 11.5,
                        color: "var(--ink-3)",
                        marginTop: 1,
                      }}
                    >
                      {it.desc}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* =====================================================================
   Sub-nav - links to existing /tradebook/* routes; "Trades" is the
   current page so it's just an indicator.
   ===================================================================== */
function TradebookSubNav({
  active,
  tradesCount,
  right,
}: {
  active: "list" | "import" | "history" | "export";
  tradesCount: number;
  right?: React.ReactNode;
}) {
  const tabs = [
    {
      id: "list" as const,
      icon: Table2,
      label: "Trades",
      href: "/tradebook",
      count: tradesCount,
    },
    {
      id: "import" as const,
      icon: Upload,
      label: "Import",
      href: "/tradebook/import",
    },
    {
      id: "history" as const,
      icon: History,
      label: "History",
      href: "/tradebook/import/history",
    },
    {
      id: "export" as const,
      icon: Download,
      label: "Export",
      href: "/tradebook/export",
    },
  ];

  return (
    <div
      data-walkthrough="tradebook-tabs"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginBottom: 18,
        paddingBottom: 14,
        borderBottom: "1px solid var(--border-default)",
        flexWrap: "wrap",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: 4,
          background: "var(--bg-segmented)",
          border: "1px solid var(--border-default)",
          borderRadius: 10,
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          maxWidth: "100%",
        }}
      >
        {tabs.map((t) => {
          const a = active === t.id;
          const Icon = t.icon;
          return (
            <a
              key={t.id}
              href={t.href}
              style={{
                padding: "7px 12px",
                background: a ? "rgba(52,211,153,.14)" : "transparent",
                color: a ? "#34d399" : "var(--text-dim)",
                border: 0,
                borderRadius: 7,
                cursor: "pointer",
                fontSize: 12.5,
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                whiteSpace: "nowrap",
                textDecoration: "none",
                transition: "background .15s, color .15s",
              }}
            >
              <Icon style={{ width: 14, height: 14 }} />
              <span>{t.label}</span>
              {t.count != null && (
                <span
                  style={{
                    fontFamily:
                      "var(--font-jetbrains), ui-monospace, monospace",
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: "1px 7px",
                    borderRadius: 9999,
                    background: a
                      ? "rgba(52,211,153,.2)"
                      : "var(--rule-softer)",
                    color: a ? "#34d399" : "var(--text-muted)",
                    letterSpacing: 0.3,
                  }}
                >
                  {t.count}
                </span>
              )}
            </a>
          );
        })}
      </div>
      {right && (
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {right}
        </div>
      )}
    </div>
  );
}

/* =====================================================================
   Tradebook list page
   ===================================================================== */
export default function TradebookPageClient({
  initialTrades,
  isDemo,
}: TradebookPageProps = {}) {
  const router = useRouter();
  const { user, isLoaded } = useUser();

  // Hydration-safe demo-mode detection — `useIsDemoMode` defers the
  // localStorage read to an effect so the first client render matches SSR.
  const isDemoMode = useIsDemoMode({ isDemo, user });

  /* Broker session status - surfaces the same amber re-auth banner as
     Holdings when a broker token has expired. Trade fetches still work
     against synced data; the banner just nudges the user to reconnect. */
  const { brokerStatus } = useBrokerStatus();

  /* ── Filter state ── */
  const [side, setSide] = useState<SidePill>(DEFAULT_FILTER.side);
  const [range, setRange] = useState<RangeId>(DEFAULT_FILTER.range);
  // Typed as string (not the `as const` literal) so the Dropdown onChange and
  // seg.toUpperCase() stay valid.
  const [seg, setSeg] = useState<string>(DEFAULT_FILTER.seg);
  const [broker, setBroker] = useState<string>(DEFAULT_FILTER.broker);
  /* MONEY-847: optional symbol search (server-side `symbol` contains filter).
     Debounced into `symbolQuery` so we don't refetch on every keystroke. */
  const [symbolInput, setSymbolInput] = useState("");
  const [symbolQuery, setSymbolQuery] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setSymbolQuery(symbolInput.trim()), 300);
    return () => clearTimeout(id);
  }, [symbolInput]);

  /* ── FY dropdown options (MONEY-847) ──
     The two hard-coded fy/pfy pills are replaced by a dropdown built from the
     financial years the user's trades actually span (newest first), fetched
     once. Quick rolling pills (7d/30d/3M/All) stay. */
  const [fyOptions, setFyOptions] = useState<FinancialYearOption[]>([]);
  /* Which FY is selected (its `id`, e.g. "fy-2025"); "" = no FY selected. */
  const [fyId, setFyId] = useState("");

  /* ── Data + pagination (MONEY-839 + MONEY-845/847) ──
     Every filter is pushed SERVER-SIDE (period → fromDate/toDate, side →
     tradeType / productType, segment, broker) so it applies across ALL the
     user's trades, not just the loaded page. Paging is PAGE-BASED (page-replace,
     app-standard <PaginationControls>): we fetch exactly one page per request
     (skip = page*PAGE_SIZE, limit caps at 100) and `total` is the true filtered
     count. */
  const PAGE_SIZE = 100;
  /* When an FY is selected it overrides the rolling-range period; otherwise the
     7d/30d/3M/All pill drives the window. */
  const selectedFY = useMemo(
    () => fyOptions.find((f) => f.id === fyId) ?? null,
    [fyOptions, fyId]
  );
  const filterKey = `${side}-${range}-${fyId}-${seg}-${broker}-${symbolQuery}`;

  /* Is a DATE window currently narrowing the result set — a rolling pill or an
     FY selection? Empty-with-a-period and empty-without-one need different
     copy: the first is usually "your trades are older than this window", which
     the user cannot deduce from the table, and the second is an ordinary
     no-match. `showAllPeriods` clears BOTH, since an FY selection overrides
     the pill and resetting only one would appear to do nothing. */
  const periodActive = Boolean(selectedFY) || range !== "all";
  const showAllPeriods = useCallback(() => {
    setFyId("");
    setRange("all");
  }, []);

  const buildTradeFilters = useCallback(
    (skip: number): Record<string, unknown> => {
      const f: Record<string, unknown> = { skip, limit: PAGE_SIZE };
      if (selectedFY) {
        // FY selection wins over the rolling pill.
        f.fromDate = selectedFY.from;
        f.toDate = selectedFY.to;
      } else {
        const { fromDate, toDate } = rangeToDates(range);
        if (fromDate) f.fromDate = fromDate;
        if (toDate) f.toDate = toDate;
      }
      if (side === "Buy") f.tradeType = "BUY";
      else if (side === "Sell") f.tradeType = "SELL";
      else if (side === "Intraday") f.productType = "MIS";
      else if (side === "Delivery") f.productType = "CNC";
      if (broker !== "all") f.broker = broker;
      // seg dropdown emits coarse UI keys (equity/options/commodity/currency);
      // getSegmentFilterValues maps them to stored values (MONEY-847 fix).
      if (seg !== "all") f.segment = seg.toUpperCase();
      if (symbolQuery) f.symbol = symbolQuery;
      return f;
    },
    [range, selectedFY, side, broker, seg, symbolQuery]
  );

  /* 0-indexed page; reset to the first page whenever the filter changes so we
     never show a stale page that no longer exists for the new result set. */
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [filterKey]);

  const {
    data: tradesData,
    isLoading,
    refresh: refreshTrades,
    // A failed fetch used to be DROPPED here. `data` stayed undefined, so
    // `trades` fell back to [] and the table rendered "No trades match these
    // filters. Try widening the period or clearing filters." — a server error
    // presented as a successful empty result, blaming the user's filters for
    // it. Indistinguishable from a genuinely empty set, which is exactly what
    // made "the filters don't work" impossible to diagnose from a screenshot.
    error: loadError,
  } = useIDBCache<{ trades: Trade[]; total: number; stats: TradeStats }>({
    module: "trades",
    // Page is part of the cache key → each page caches independently and
    // changing page re-fetches (page-REPLACE, not append).
    //
    // MONEY-1257 added the `v2` segment. `stats` gained server-side
    // buyCount/sellCount, and a payload cached before that has neither — the
    // tile then falls back to the page-derived split and renders the exact
    // wrong numbers the ticket fixes. The fallback is right (a stale payload
    // must not crash the tile) but it also HIDES the fix until the cache turns
    // over on its own. Bump this whenever the cached SHAPE changes.
    identifier: `v2-${filterKey}-p${page}`,
    fetcher: async () => {
      const r = await getTradesAction(
        buildTradeFilters(page * PAGE_SIZE) as never
      );
      if (r?.success && r?.data) {
        return r.data as unknown as {
          trades: Trade[];
          total: number;
          stats: TradeStats;
        };
      }
      throw new Error("Failed to load trades");
    },
    // The SSR-padded initial payload is page 0 of the DEFAULT filter only
    // (side=All, range=all, no FY, all segments/brokers, no symbol search) —
    // matches the empty initial filter state, so it must equal the filterKey
    // those defaults produce. Any other page/filter fetches fresh.
    //
    // This comment used to say `range=30d`, and it was wrong: page.tsx passes
    // `{ limit: 20, skip: 0 }` with NO date bounds, so the payload has always
    // been unfiltered. The mismatch meant first paint rendered every trade as
    // though it were the 30-day view, and the first real fetch then emptied
    // the table. Keep this in step with DEFAULT_FILTER and with page.tsx.
    initialData:
      page === 0 && filterKey === DEFAULT_FILTER_KEY && initialTrades
        ? (initialTrades as unknown as {
            trades: Trade[];
            total: number;
            stats: TradeStats;
          })
        : undefined,
    skip: !isLoaded || (!user && !isDemoMode),
  });

  const trades = useMemo<Trade[]>(() => tradesData?.trades ?? [], [tradesData]);
  const stats = tradesData?.stats;
  const total = tradesData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /* The loaded page IS the result set for the current view. */
  const filtered = trades;

  /* Turnover over the CURRENT page's rows.

     buys/sells are ALSO computed here, but only as a fallback: MONEY-1257
     moved the real split server-side. Rendering these next to the server
     `total` is what produced "125" above "20 buys · 0 sells" — the headline
     counted every trade while the split counted one page of 100. */
  const visibleStats = useMemo(() => {
    const vol = filtered.reduce((s, r) => s + r.quantity * r.price, 0);
    const buys = filtered.filter((r) => r.tradeType === "BUY").length;
    const sells = filtered.filter((r) => r.tradeType === "SELL").length;
    return { vol, buys, sells, count: filtered.length };
  }, [filtered]);

  /* ── Brokers (for filter dropdown) ── */
  const [brokerConnections, setBrokerConnections] = useState<
    BrokerConnection[]
  >([]);

  useEffect(() => {
    if (!user) return;
    void getBrokerConnectionsAction().then((r) => {
      if (r?.success && r?.data) {
        setBrokerConnections(
          // MONEY-837: exclude the founder-only Connect app from data selectors.
          r.data
            .filter((c) => c.broker !== "ZERODHA_CONNECT")
            .map((c) => ({
              id: c.id,
              broker: c.broker,
              brokerUserId: c.brokerUserId || null,
              accountName: c.accountName || null,
            }))
        );
      }
    });
  }, [user]);

  /* ── Available financial years (MONEY-847) ──
     One fetch (re-run after a sync repopulates the tradebook) builds the FY
     dropdown from the user's real trade span. Demo mode resolves via the action
     too (derives from the static demo trades). */
  useEffect(() => {
    if (!user && !isDemoMode) return;
    void getAvailableFYsAction().then((r) => {
      if (r?.success && r?.data) setFyOptions(r.data.fys);
    });
  }, [user, isDemoMode, tradesData]);

  const getBrokerDisplayName = useCallback(
    (b?: string | null, u?: string | null) => {
      if (!b || b === "MANUAL") return "Manual";
      const c = brokerConnections.find(
        (x) => x.broker === b && x.brokerUserId === u
      );
      if (c?.accountName) return c.accountName;
      return b.charAt(0) + b.slice(1).toLowerCase();
    },
    [brokerConnections]
  );

  useEffect(() => {
    if (!isLoaded) return;
    if (!user && !isDemoMode) router.push("/home");
  }, [isLoaded, user, isDemoMode, router]);

  const activeFilters = useMemo(() => {
    return [
      side !== "All" && { k: "side", lbl: side, onClear: () => setSide("All") },
      seg !== "all" && {
        k: "seg",
        // MONEY-847: label matches the dropdown choices (was a broken
        // eq?Equity:F&O binary that mislabelled Commodity/Currency).
        lbl: SEG_LABEL[seg] ?? seg,
        onClear: () => setSeg("all"),
      },
      broker !== "all" && {
        k: "broker",
        lbl:
          brokerConnections.find(
            (c) => `${c.broker}:${c.brokerUserId || ""}` === broker
          )?.accountName || broker,
        onClear: () => setBroker("all"),
      },
      symbolQuery.trim() !== "" && {
        k: "symbol",
        lbl: `“${symbolQuery.trim()}”`,
        onClear: () => setSymbolQuery(""),
      },
    ].filter(Boolean) as { k: string; lbl: string; onClear: () => void }[];
  }, [side, seg, broker, symbolQuery, brokerConnections]);

  /* ── Manual entry modal ── */
  const [modalOpen, setModalOpen] = useState(false);

  /* ── Sync progress (MONEY-839) ──
     `syncBusy` drives an animated banner while a broker SYNC job is in flight on
     the worker (sync is worker-only now). Instead of a fixed timer we POLL
     getActiveBrokerJobsAction so the banner mirrors the REAL async progress (a
     historical backfill can take a bit) and clears the moment the worker
     finishes — refreshing to surface the synced trades. Pairing moved to the
     MONEY-840 redesign. */
  const [resyncing, setResyncing] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const pollingRef = useRef(false);
  const pollStopRef = useRef(false);
  const didMountJobCheck = useRef(false);
  useEffect(() => {
    return () => {
      pollStopRef.current = true;
    };
  }, []);

  const startSyncPoll = useCallback(async () => {
    if (pollingRef.current) return; // a poll loop is already running
    pollingRef.current = true;
    pollStopRef.current = false;
    setSyncBusy(true);
    const STEP = 4000;
    const MAX_MS = 10 * 60 * 1000; // big year-by-year backfills can run a while
    let waited = 0;
    try {
      // Keep the banner up while the worker sync job runs; DON'T refresh mid-way
      // — the tradebook populates ONCE, when ALL ingestion is done (job done).
      while (waited < MAX_MS && !pollStopRef.current) {
        await new Promise((r) => setTimeout(r, STEP));
        waited += STEP;
        let res: { active: boolean } | null;
        try {
          res = await getActiveBrokerJobsAction();
        } catch {
          res = null;
        }
        if (!res?.active) break; // worker finished → exit + populate below
      }
    } finally {
      await refreshTrades(); // single populate once ingestion completes
      setSyncBusy(false);
      pollingRef.current = false;
    }
  }, [refreshTrades]);

  const handleResync = useCallback(async () => {
    if (resyncing) return;
    setResyncing(true);
    try {
      const r = await syncAllBrokersAction();
      if (r?.success) {
        toast.success("Sync started — your tradebook will refresh shortly…");
      } else if (r?.error) {
        toast.error(r.error);
      }
    } catch {
      toast.error("Couldn't start sync");
    } finally {
      setResyncing(false);
      void startSyncPoll();
    }
  }, [resyncing, startSyncPoll]);

  /* On load, reflect any broker SYNC / PAIRING already running in the background
     (e.g. the historical backfill kicked off right after a fresh connect, so the
     user lands here mid-import). Runs once after the user resolves. */
  useEffect(() => {
    if (!user || didMountJobCheck.current) return;
    didMountJobCheck.current = true;
    void getActiveBrokerJobsAction().then((res) => {
      if (res?.active) void startSyncPoll();
    });
  }, [user, startSyncPoll]);
  const handleManualSave = async (data: ManualEntrySubmission) => {
    const result = await createTradeAction({
      tradeDate: data.date,
      symbol: data.ticker,
      broker: data.broker,
      exchange: data.segment.startsWith("BSE") ? "BSE" : "NSE",
      segment:
        data.segment.includes("FO") || data.segment === "MCX"
          ? data.segment === "MCX"
            ? "COMMODITY"
            : "OPTIONS"
          : "EQUITY",
      positionType: "LONG",
      tradeType: data.side,
      orderType: "MARKET",
      quantity: data.qty,
      price: data.price,
      productType: data.product,
      tags: data.notes,
      notes: data.notes || null,
    });
    if (result?.success) {
      toast.success("Trade added");
      setModalOpen(false);
      await refreshTrades();
    } else {
      toast.error(result?.error || "Failed to add trade");
    }
  };

  const manualBrokerOptions = useMemo(() => {
    return [
      ...brokerConnections.map((c) => ({
        value: c.broker,
        label: c.accountName || c.broker,
        desc: c.brokerUserId || undefined,
      })),
      {
        value: "manual",
        label: "Manual / Off-market",
        desc: "No broker linked",
      },
    ];
  }, [brokerConnections]);

  if (isLoading && !tradesData) {
    // MONEY-877: wrap the skeleton in the shell. PageGuard returns children verbatim
    // when the subscription is already cached (PageGuard itself not loading), so a
    // BARE skeleton here rendered FULL-WIDTH with no sidenav until tradesData resolved
    // (the stretched first-load bug). Mirror the real render's TerminalLuxeShell.
    return (
      <PageGuard route="/tradebook" fallback={<TradebookSkeleton />}>
        <TerminalLuxeShell
          active="tradebook"
          title="Tradebook"
          breadcrumb="Portfolio"
          showAskSage
        >
          <TradebookSkeleton />
        </TerminalLuxeShell>
      </PageGuard>
    );
  }

  return (
    <PageGuard route="/tradebook" fallback={<TradebookSkeleton />}>
      <TerminalLuxeShell
        active="tradebook"
        title="Tradebook"
        breadcrumb="Portfolio"
        showAskSage
      >
        {isDemoMode && <DemoBanner />}

        {brokerStatus.status === "needs_reauth" &&
          brokerStatus.reauthUrl &&
          brokerStatus.brokerDisplayName && (
            <BrokerReauthBanner
              brokerName={brokerStatus.brokerDisplayName}
              reauthUrl={brokerStatus.reauthUrl}
              className="mb-4"
            />
          )}

        {/* MONEY-847: pairing/realised-P&L is deferred (MONEY-840), so the
            headline reflects what this page actually shows today — every raw
            synced/imported/manual trade in one ledger. */}
        <PfPageHead
          eyebrow="TRADE · TRADEBOOK"
          title={
            <>
              Every trade, <span className="ser">in one</span>{" "}
              <span className="hl-gold">ledger.</span>
            </>
          }
          sub="Synced, imported and manual trades across all your brokers — one tidy book."
        />

        {syncBusy && (
          <div
            role="status"
            aria-live="polite"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              margin: "12px 0",
              padding: "10px 14px",
              borderRadius: 8,
              border: "1px solid rgba(122,200,160,0.28)",
              background: "rgba(122,200,160,0.08)",
              fontSize: 13,
            }}
          >
            <RefreshCw size={14} className="animate-spin" />
            <span>
              Syncing your brokers and importing trade history… this runs in the
              background and can take a moment for large histories — your
              tradebook refreshes automatically.
            </span>
          </div>
        )}

        <TradebookSubNav
          active="list"
          tradesCount={total}
          right={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <TakeTheTourButton version="v1-tradebook" />
              {/* MONEY-839: a VISIBLE manual Sync. Publishes a WORKER sync job
                  (sync is worker-only now); the loader polls until the worker
                  finishes, then the tradebook populates. */}
              <button
                type="button"
                className="pf-bf"
                onClick={() => void handleResync()}
                disabled={resyncing}
                title="Sync your connected brokers"
              >
                <RefreshCw
                  size={13}
                  className={resyncing ? "animate-spin" : undefined}
                />{" "}
                {resyncing ? "Syncing…" : "Sync"}
              </button>
              {/* MONEY-847: redesigned Import ▾ — a true quick-action dropdown
                  (no "Resync brokers": that's the Sync button above). Upload →
                  the import wizard, Add manual → the same ManualEntryModal, and
                  Import history → the history tab. Minimal & non-duplicative. */}
              <ActionMenu
                align="right"
                trigger={
                  <button type="button" className="pf-bf">
                    <Upload size={13} /> Import <ChevronDown size={12} />
                  </button>
                }
                items={[
                  {
                    key: "upload",
                    label: "Upload CSV/Excel",
                    desc: "Import a broker statement",
                    icon: Upload,
                    featured: true,
                    onClick: () => router.push("/tradebook/import"),
                  },
                  {
                    key: "manual",
                    label: "Add manual trade",
                    desc: "Off-market or one-off entry",
                    icon: Plus,
                    onClick: () => setModalOpen(true),
                  },
                  {
                    key: "history",
                    label: "Import history",
                    desc: "Past uploads & status",
                    icon: History,
                    onClick: () => router.push("/tradebook/import/history"),
                  },
                ]}
              />
              {/* MONEY-847: Export ▾ now lists ALL 4 formats (ITR-2 · XLSX ·
                  CSV · JSON), each deep-linking the export workspace with the
                  preselected format. */}
              <ActionMenu
                align="right"
                trigger={
                  <button type="button" className="pf-bs">
                    <Download size={13} /> Export <ChevronDown size={12} />
                  </button>
                }
                items={[
                  {
                    key: "itr2",
                    label: "ITR-2 · Schedule CG",
                    desc: "Maps to capital-gains schedule",
                    icon: Receipt,
                    featured: true,
                    onClick: () => router.push("/tradebook/export?format=itr2"),
                  },
                  {
                    key: "xlsx",
                    label: "Excel · XLSX",
                    desc: "Multi-sheet workbook",
                    icon: FileSpreadsheet,
                    onClick: () => router.push("/tradebook/export?format=xlsx"),
                  },
                  {
                    key: "csv",
                    label: "Trades · CSV",
                    desc: "Spreadsheet-friendly",
                    icon: FileText,
                    onClick: () => router.push("/tradebook/export?format=csv"),
                  },
                  {
                    key: "json",
                    label: "Trades · JSON",
                    desc: "For scripts and APIs",
                    icon: Braces,
                    onClick: () => router.push("/tradebook/export?format=json"),
                  },
                ]}
              />
            </div>
          }
        />

        {/* 5-stat summary strip (design: screens-tradebook-v2). Realised /
            turnover / count are real; charges + net aren't computed by
            getTradesAction yet, so they render "—" rather than faked. */}
        <div
          className="um-stats-grid"
          data-walkthrough="tradebook-kpis"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div
            className="pf-card pf-stat flat"
            style={{ background: "var(--rule-softer)" }}
          >
            <div className="l">TRADES</div>
            <div className="v" style={{ fontSize: 22 }}>
              {total.toLocaleString("en-IN")}
            </div>
            <div className="d">
              {/* MONEY-1257: server split when present, so it sums to the
                  headline above. A pre-MONEY-1257 cached payload has neither
                  field, and falls back to the page-scoped counts. */}
              {stats?.buyCount != null && stats?.sellCount != null
                ? `${stats.buyCount} buys · ${stats.sellCount} sells`
                : `${visibleStats.buys} buys · ${visibleStats.sells} sells`}
            </div>
          </div>
          <div
            className="pf-card pf-stat flat"
            style={{ background: "var(--rule-softer)" }}
          >
            <div className="l">REALISED P&amp;L</div>
            <div
              className="v"
              style={{
                fontSize: 22,
                color: stats
                  ? stats.totalPnL >= 0
                    ? "var(--emerald-text)"
                    : "var(--pop-1-text)"
                  : "var(--ink-3)",
              }}
            >
              {stats ? fmtINRSigned(Math.round(stats.totalPnL)) : "—"}
            </div>
            {stats && stats.closedCount > 0 && (
              <div className={`d ${stats.totalPnL >= 0 ? "pos" : "neg"}`}>
                {stats.winRate.toFixed(0)}% win · {stats.winners}/
                {stats.closedCount}
              </div>
            )}
          </div>
          <div
            className="pf-card pf-stat flat"
            style={{ background: "var(--rule-softer)" }}
          >
            <div className="l">TURNOVER · {RANGE_LABEL[range]}</div>
            <div className="v" style={{ fontSize: 22 }}>
              {fmtLakhs(visibleStats.vol)}
            </div>
            <div className="d">Across all brokers</div>
          </div>
          {/* Charges — not surfaced by getTradesAction; placeholdered. */}
          <div
            className="pf-card pf-stat flat"
            style={{ background: "var(--rule-softer)" }}
          >
            <div className="l">CHARGES</div>
            <div
              className="v"
              style={{ fontSize: 22, color: "var(--ink-3)" }}
              title="Brokerage & taxes — coming soon"
            >
              —
            </div>
          </div>
          {/* Net = realised − charges; needs the charges figure first. */}
          <div
            className="pf-card pf-stat flat"
            style={{
              background: "var(--emerald-bg)",
              borderColor: "var(--emerald)",
            }}
          >
            <div className="l">NET</div>
            <div
              className="v"
              style={{ fontSize: 22, color: "var(--ink-3)" }}
              title="Net of charges — coming soon"
            >
              —
            </div>
          </div>
        </div>

        {/* Time-range pill group (playful chips) + dynamic FY dropdown.
            MONEY-847: 7d/30d/3M/All stay as quick rolling pills; the financial
            years come from a dropdown populated with the FYs the user's trades
            actually span (newest first). Picking an FY overrides the rolling
            pill; picking a rolling pill clears the FY. */}
        <div
          data-walkthrough="tradebook-range"
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 12,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {QUICK_RANGES.map((id) => {
            const a = range === id && fyId === "";
            return (
              <button
                type="button"
                key={id}
                onClick={() => {
                  setRange(id);
                  setFyId("");
                }}
                className={`pf-pill${a ? "" : " outline"}`}
                style={{
                  cursor: "pointer",
                  ...(a
                    ? { background: "var(--ink)", color: "var(--paper)" }
                    : null),
                }}
              >
                {RANGE_LABEL[id]}
              </button>
            );
          })}
          {fyOptions.length > 0 && (
            <Dropdown
              compact
              width={140}
              value={fyId}
              onChange={setFyId}
              options={[
                { value: "", label: "Financial year" },
                ...fyOptions.map((f) => ({ value: f.id, label: f.label })),
              ]}
            />
          )}
          {activeFilters.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setSide("All");
                setSeg("all");
                setBroker("all");
                setSymbolInput("");
                setSymbolQuery("");
              }}
              className="pf-bf sm"
              style={{ marginLeft: "auto" }}
            >
              <X size={11} /> Clear ({activeFilters.length})
            </button>
          )}
        </div>

        {/* Filter row */}
        <div
          data-walkthrough="tradebook-side"
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 14,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(["All", "Buy", "Sell", "Intraday", "Delivery"] as SidePill[]).map(
              (f) => {
                const a = side === f;
                const variant =
                  a && f === "Buy"
                    ? " emerald"
                    : a && f === "Sell"
                      ? " coral"
                      : a
                        ? ""
                        : " outline";
                return (
                  <button
                    type="button"
                    key={f}
                    onClick={() => setSide(f)}
                    className={`pf-pill${variant}`}
                    style={{
                      cursor: "pointer",
                      ...(a && f !== "Buy" && f !== "Sell"
                        ? { background: "var(--ink)", color: "var(--paper)" }
                        : null),
                    }}
                  >
                    {f.toUpperCase()}
                  </button>
                );
              }
            )}
          </div>
          <div
            className="um-hide-mobile"
            style={{
              display: "flex",
              gap: 8,
              marginLeft: "auto",
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {/* MONEY-847: symbol search (server-side `symbol` contains filter). */}
            <div style={{ position: "relative" }}>
              <Search
                size={13}
                style={{
                  position: "absolute",
                  left: 9,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--ink-3)",
                  pointerEvents: "none",
                }}
              />
              <input
                className="pf-input"
                type="text"
                inputMode="search"
                aria-label="Search symbol"
                placeholder="Search symbol…"
                value={symbolInput}
                onChange={(e) => setSymbolInput(e.target.value)}
                style={{ width: 150, paddingLeft: 28, height: 32 }}
              />
            </div>
            <Dropdown
              compact
              width={130}
              value={seg}
              onChange={setSeg}
              options={[
                { value: "all", label: "All segments" },
                { value: "equity", label: "Equity" },
                { value: "options", label: "F&O" },
                { value: "commodity", label: "Commodity" },
                { value: "currency", label: "Currency" },
              ]}
            />
            <Dropdown
              compact
              width={180}
              value={broker}
              onChange={setBroker}
              options={[
                { value: "all", label: "All brokers" },
                ...brokerConnections.map((c) => ({
                  value: `${c.broker}:${c.brokerUserId || ""}`,
                  label: c.accountName || c.broker,
                })),
                { value: "manual", label: "Manual" },
              ]}
            />
          </div>
        </div>

        {/* MONEY-847: processing gate — while a broker SYNC job runs we hide the
            (stale) table/cards entirely and show a skeleton so no out-of-date
            rows are shown "while processing"; pagination is suppressed too. */}
        {syncBusy && (
          <div
            className="pf-card"
            role="status"
            aria-live="polite"
            style={{ padding: 0, overflow: "hidden" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "14px 18px",
                borderBottom: "1px solid var(--rule-soft)",
                fontSize: 13,
                color: "var(--ink-2)",
              }}
            >
              <Loader2 size={15} className="animate-spin" />
              <span>Importing your trades… the table populates once done.</span>
            </div>
            <div style={{ padding: 16 }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="um-skel"
                  style={{
                    height: 18,
                    borderRadius: 6,
                    marginBottom: 12,
                    background: "var(--rule-softer)",
                    opacity: 1 - i * 0.12,
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Desktop table — playful paired-trade table (design: pf-tbl) */}
        {!syncBusy && (
          <div
            className="pf-card um-hide-lt-1100"
            style={{ padding: 0, overflow: "hidden" }}
          >
            <div style={{ overflowX: "auto" }}>
              <table className="pf-tbl" data-walkthrough="tradebook-table">
                <thead>
                  <tr>
                    <th style={{ paddingLeft: 18 }}>DATE</th>
                    <th>SYMBOL</th>
                    <th>TYPE</th>
                    <th>SIDE</th>
                    <th>BROKER</th>
                    <th style={{ textAlign: "right" }}>QTY</th>
                    <th style={{ textAlign: "right" }}>PRICE</th>
                    <th style={{ textAlign: "right" }}>VALUE</th>
                    <th style={{ textAlign: "right" }}>P&amp;L</th>
                    <th>STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td
                        colSpan={10}
                        style={{
                          padding: 36,
                          textAlign: "center",
                          color: "var(--ink-3)",
                        }}
                      >
                        {loadError ? (
                          <LoadFailed onRetry={() => void refreshTrades()} />
                        ) : (
                          <NoResults
                            periodActive={periodActive}
                            onShowAll={showAllPeriods}
                          />
                        )}
                      </td>
                    </tr>
                  )}
                  {filtered.map((r) => {
                    const ts = new Date(r.tradeDate)
                      .toISOString()
                      .replace("T", " ")
                      .slice(0, 16);
                    const isManual = !r.broker || r.broker === "MANUAL";
                    const isBuy = r.tradeType === "BUY";
                    const isComplete =
                      r.status === "COMPLETE" || r.status === "CLOSED";
                    const isImported = r.sourceType === "IMPORTED";
                    return (
                      <tr key={r.id}>
                        <td className="num" style={{ paddingLeft: 18 }}>
                          {ts}
                        </td>
                        <td>
                          <span className="tk">{r.symbol}</span>
                        </td>
                        {/* MONEY-847: dedicated TYPE column (segment pill moved
                          out of the SYMBOL cell). */}
                        <td>
                          <span
                            className="pf-pill outline"
                            style={{ fontSize: 9 }}
                          >
                            {r.segmentLabel || r.segment}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`pf-pill ${isBuy ? "emerald" : "coral"}`}
                            style={{ fontSize: 9.5 }}
                          >
                            {r.tradeType}
                          </span>
                        </td>
                        <td>
                          {isManual ? (
                            <span
                              className="br-chip"
                              style={{ padding: "3px 8px", fontSize: 11 }}
                            >
                              <BrokerLogo slug="manual" size={11} /> Manual
                            </span>
                          ) : (
                            <span
                              className="br-chip"
                              style={{ padding: "3px 8px", fontSize: 11 }}
                            >
                              <BrokerLogo
                                slug={toBrokerSlug(r.broker)}
                                size={11}
                              />
                              {getBrokerDisplayName(r.broker, r.brokerUserId)}
                            </span>
                          )}
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {r.quantity}
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          ₹
                          {r.price.toLocaleString("en-IN", {
                            minimumFractionDigits: 2,
                          })}
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {fmtINR(Math.round(r.quantity * r.price))}
                        </td>
                        {/* MONEY-840: per-row realised P&L from the persisted
                          PairedTradeView (the closing SELL of a CLOSED/PARTIAL
                          lot carries it). "—" when the row has no realised
                          component (open buys, un-paired rows). */}
                        <td
                          className="num"
                          style={{
                            textAlign: "right",
                            color:
                              r.realizedPnL == null
                                ? "var(--ink-3)"
                                : r.realizedPnL >= 0
                                  ? "var(--emerald-text)"
                                  : "var(--pop-1-text)",
                          }}
                        >
                          {r.realizedPnL == null
                            ? "—"
                            : fmtINRSigned(Math.round(r.realizedPnL))}
                        </td>
                        <td>
                          <span
                            className="pf-pill"
                            style={{
                              fontSize: 9.5,
                              ...(isComplete
                                ? {
                                    background: "var(--emerald-bg)",
                                    color: "var(--emerald-text)",
                                    borderColor: "var(--emerald)",
                                  }
                                : isImported
                                  ? {
                                      background: "var(--pop-3)",
                                      color: "var(--paper)",
                                      borderColor: "var(--pop-3)",
                                    }
                                  : isManual
                                    ? {
                                        background: "var(--pop-2)",
                                        color: "#1d1d1b",
                                        borderColor: "var(--pop-2)",
                                      }
                                    : null),
                            }}
                          >
                            {isManual && !isComplete
                              ? "MANUAL"
                              : isImported
                                ? "IMPORT"
                                : r.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Mobile cards */}
        {!syncBusy && (
          <div
            className="um-mobile-only pf-card"
            style={{ flexDirection: "column", padding: 0, display: "none" }}
          >
            {filtered.length === 0 && (
              <div
                style={{
                  padding: 32,
                  textAlign: "center",
                  color: "var(--text-muted)",
                }}
              >
                {loadError ? (
                  <LoadFailed onRetry={() => void refreshTrades()} />
                ) : (
                  <NoResults
                    periodActive={periodActive}
                    onShowAll={showAllPeriods}
                  />
                )}
              </div>
            )}
            {filtered.map((r) => {
              const ts = new Date(r.tradeDate)
                .toISOString()
                .replace("T", " ")
                .slice(0, 16);
              const isBuy = r.tradeType === "BUY";
              return (
                <div
                  key={r.id}
                  style={{
                    padding: "14px 14px",
                    borderBottom: "1px dashed var(--rule-soft)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 6,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span className="mono" style={{ fontWeight: 700 }}>
                        {r.symbol}
                      </span>
                      <span
                        className={`pf-pill ${isBuy ? "emerald" : "coral"}`}
                        style={{ fontSize: 9.5 }}
                      >
                        {r.tradeType}
                      </span>
                    </div>
                    <span
                      className="mono"
                      style={{ fontSize: 11, fontWeight: 600 }}
                    >
                      {fmtINR(Math.round(r.quantity * r.price))}
                    </span>
                  </div>
                  <div
                    className="mono"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      color: "var(--ink-3)",
                    }}
                  >
                    <span>{ts}</span>
                    <span>
                      {r.quantity} × ₹
                      {r.price.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginTop: 6,
                    }}
                  >
                    {r.broker && r.broker !== "MANUAL" ? (
                      <span
                        className="br-chip"
                        style={{ padding: "3px 8px", fontSize: 11 }}
                      >
                        <BrokerLogo slug={toBrokerSlug(r.broker)} size={11} />
                        {getBrokerDisplayName(r.broker, r.brokerUserId)}
                      </span>
                    ) : (
                      <span
                        className="br-chip"
                        style={{ padding: "3px 8px", fontSize: 11 }}
                      >
                        <BrokerLogo slug="manual" size={11} /> Manual
                      </span>
                    )}
                    <span className="pf-pill outline" style={{ fontSize: 9 }}>
                      {r.segmentLabel || r.segment} ·{" "}
                      {r.productTypeLabel || r.productType}
                    </span>
                  </div>
                  {/* MONEY-840: realised P&L line — only for rows that realised a
                      lot (the closing SELL of a CLOSED/PARTIAL pairing). */}
                  {r.realizedPnL != null && (
                    <div
                      className="mono"
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: 11,
                        marginTop: 6,
                      }}
                    >
                      <span style={{ color: "var(--ink-3)" }}>
                        Realised P&amp;L
                      </span>
                      <span
                        style={{
                          fontWeight: 700,
                          color:
                            r.realizedPnL >= 0
                              ? "var(--emerald-text)"
                              : "var(--pop-1-text)",
                        }}
                      >
                        {fmtINRSigned(Math.round(r.realizedPnL))}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* MONEY-845: app-standard page-based pagination (replaces the custom
            "Load more"). Page-REPLACE — each page is a fresh server fetch
            (skip = page*PAGE_SIZE). Suppressed while a sync is processing. */}
        {!syncBusy && total > 0 && (
          <div style={{ marginTop: 4 }}>
            <PaginationControls
              currentPage={page}
              totalPages={totalPages}
              pageSize={PAGE_SIZE}
              totalItems={total}
              onPageChange={setPage}
              label="trades"
            />
          </div>
        )}

        <ManualEntryModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onSave={handleManualSave}
          kind="trade"
          brokerOptions={manualBrokerOptions}
        />
      </TerminalLuxeShell>
    </PageGuard>
  );
}
