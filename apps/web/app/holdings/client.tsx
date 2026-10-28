"use client";

import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useTransition,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { toast } from "sonner";
import {
  holdingToPositionPrefill,
  prefillToPositionData,
} from "./holdings-research-prefill";
import {
  TrendingUp,
  PieChart as PieChartIcon,
  Activity,
  Plus,
  RefreshCw,
  Upload,
  SearchX,
  LineChart as LineChartIcon,
  Sparkles,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { instrumentDetailHref } from "@/lib/fund/instrument-href";
import ResearchModal from "@/components/analysis/ResearchModal";
import { useAppFeatureFlags } from "@/lib/hooks/useAppFeatureFlags";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import { useOwnedRoute } from "@/lib/hooks/useOwnedRoute";

import { TerminalLuxeShell } from "@/components/terminal-luxe/Shell";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { TakeTheTourButton } from "@/components/walkthrough";
import {
  Pill,
  BrokerLogo,
  BrokerChip,
  SplitDonut,
  Dropdown,
  fmtINR,
  fmtINRSigned,
  fmtLakhs,
  toBrokerSlug,
  type DonutSlice,
} from "@/components/terminal-luxe/primitives";
import {
  ManualEntryModal,
  type ManualEntrySubmission,
} from "@/components/terminal-luxe/ManualEntryModal";

import {
  getHoldingsAction,
  addManualHoldingAction,
  clearHoldingsCacheAction,
} from "@/lib/actions/holdings";
import {
  getMutualFundsAction,
  createMutualFundAction,
  addManualMutualFundAction,
} from "@/lib/actions/mutualfunds";
import {
  getPositionsAction,
  addManualPositionAction,
} from "@/lib/actions/positions";
import {
  getPortfolioReturnsAction,
  type PortfolioReturns,
} from "@/lib/actions/dashboard";
import {
  getBrokerConnectionsAction,
  syncAllBrokersAction,
} from "@/lib/actions/broker-connection";
import { useIDBCache } from "@/hooks/useIDBCache";
import { clearIDBHoldingsCache } from "@/lib/idb-cache";
import { PageGuard } from "@/components/PageGuard";
import { HoldingsSkeleton } from "@/components/skeletons";
import { DemoBanner } from "@/components/DemoBanner";
import { EmptyState } from "@/components/empty/EmptyState";
import {
  Briefcase,
  ListOrdered,
  PieChart as PieChartEmpty,
} from "lucide-react";
import BrokerReauthBanner from "@/components/BrokerReauthBanner";
import { useBrokerStatus, type BrokerStatus } from "@/hooks/useBrokerStatus";

/* =====================================================================
   Color palettes - chosen to read clearly against the dark Terminal Luxe
   bg. Sectors use a modulated palette; market caps + sides use semantics.
   ===================================================================== */
const SECTOR_PALETTE = [
  "#34d399",
  "#3b82f6",
  "#fbbf24",
  "#a78bfa",
  "#f472b6",
  "#06b6d4",
  "#22c55e",
  "#f97316",
  "#94a3b8",
];
const SIDE_COLORS = { Long: "#34d399", Short: "#f87171" };
const SEG_COLORS = {
  "Equity Intraday": "#34d399",
  "Futures & Options": "#a78bfa",
  Other: "#94a3b8",
};

/* =====================================================================
   Type definitions matching action return shapes
   ===================================================================== */
interface BrokerConnection {
  id: string;
  broker: string;
  brokerUserId: string | null;
  accountName: string | null;
}

interface Holding {
  id: string;
  symbol: string;
  name: string | null;
  sector: string | null;
  exchange: string;
  quantity: number;
  t1Quantity: number;
  averagePrice: number;
  currentPrice: number;
  investedValue: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
  broker: string | null;
  brokerUserId: string | null;
  brokerName: string | null;
}

interface MutualFund {
  id: string;
  schemeName: string;
  schemeCode: string | null;
  folioNumber: string | null;
  category: string | null;
  units: number;
  averageNav: number;
  currentNav: number;
  investedAmount: number;
  currentValue: number;
  unrealizedGain: number;
  sipActive: boolean;
  sipAmount: number | null;
  brokerName: string | null;
  broker: string | null;
  brokerUserId?: string | null;
}

interface Position {
  id: string;
  symbol: string;
  exchange: string;
  segment: string;
  segmentLabel?: string;
  tradeType: string;
  positionType: string;
  productType: string;
  productTypeLabel?: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  broker: string | null;
  brokerUserId: string | null;
  brokerName: string | null;
}

interface Summary {
  totalInvested: number;
  totalCurrent: number;
  totalPnL: number;
  pnlPercentage: number | string;
}

interface HoldingsPageProps {
  initialHoldings?: { holdings: Holding[]; summary: Summary } | null;
  initialFunds?: { funds: MutualFund[]; summary: Summary } | null;
  initialPositions?: {
    positions: Position[];
    summary: { totalPositions: number; unrealizedPnL: number };
  } | null;
  isDemo?: boolean;
}

/* =====================================================================
   Utility: derive AMC from scheme name when API doesn't expose it.
   "Parag Parikh Flexi Cap …" → "Parag Parikh"
   "Axis Bluechip …" → "Axis"
   ===================================================================== */
function deriveAMC(schemeName: string): string {
  const first = schemeName.split(/\s+/).slice(0, 2).join(" ").trim();
  return first || "Other";
}

/* =====================================================================
   Market-cap classification.
   We don't ship the SEBI-defined market-cap list with every Holdings
   payload, so we fall back to a static set of well-known NIFTY-50 / -100
   large caps. Anything not in the list buckets as "Mid Cap" by default;
   the dropdown filter lets the user override per-row when needed.
   When the holdings service starts surfacing Instrument.marketCap, this
   table can be replaced by that field.
   ===================================================================== */
const LARGE_CAP_SYMBOLS: ReadonlySet<string> = new Set([
  // NIFTY 50 (top liquid large caps) - symbol-only matching
  "RELIANCE",
  "TCS",
  "HDFCBANK",
  "ICICIBANK",
  "INFY",
  "ITC",
  "LT",
  "HINDUNILVR",
  "SBIN",
  "BHARTIARTL",
  "KOTAKBANK",
  "BAJFINANCE",
  "ASIANPAINT",
  "AXISBANK",
  "MARUTI",
  "TITAN",
  "SUNPHARMA",
  "ULTRACEMCO",
  "WIPRO",
  "HCLTECH",
  "ONGC",
  "NTPC",
  "POWERGRID",
  "M&M",
  "TATAMOTORS",
  "TATASTEEL",
  "TATACONSUM",
  "BAJAJFINSV",
  "BAJAJ-AUTO",
  "NESTLEIND",
  "GRASIM",
  "BRITANNIA",
  "JSWSTEEL",
  "INDUSINDBK",
  "DRREDDY",
  "DIVISLAB",
  "CIPLA",
  "HEROMOTOCO",
  "EICHERMOT",
  "ADANIENT",
  "ADANIPORTS",
  "TECHM",
  "HINDALCO",
  "COALINDIA",
  "BPCL",
  "IOC",
  "UPL",
  "SHREECEM",
  "APOLLOHOSP",
  "SBILIFE",
  "HDFCLIFE",
  "LTIM",
  "ICICIPRULI",
  // NIFTY Next-50 names commonly held
  "DMART",
  "PIDILITIND",
  "GODREJCP",
  "SIEMENS",
  "HAVELLS",
  "DLF",
  "AMBUJACEM",
  "VEDL",
  "GAIL",
  "BANKBARODA",
  "PNB",
  "CANBK",
  "INDIGO",
  "BERGEPAINT",
  "MARICO",
  "MOTHERSON",
  "LICI",
  "ZOMATO",
  "PAYTM",
]);
const MID_CAP_SYMBOLS: ReadonlySet<string> = new Set([
  "HDFCAMC",
  "MFSL",
  "MUTHOOTFIN",
  "PIIND",
  "TVSMOTOR",
  "JUBLFOOD",
  "PEL",
  "ASHOKLEY",
  "BALKRISIND",
  "OFSS",
  "LICHSGFIN",
  "PAGEIND",
  "SUNDARMFIN",
]);

type MarketCap = "large" | "mid" | "small";

function classifyMarketCap(symbol: string): MarketCap {
  const s = symbol.toUpperCase();
  if (LARGE_CAP_SYMBOLS.has(s)) return "large";
  if (MID_CAP_SYMBOLS.has(s)) return "mid";
  return "mid"; // default - most retail portfolios are mid-or-better
}

const CAP_LABEL: Record<MarketCap, string> = {
  large: "Large Cap",
  mid: "Mid Cap",
  small: "Small Cap",
};
const CAP_COLOR: Record<MarketCap, string> = {
  large: "#34d399",
  mid: "#a78bfa",
  small: "#fbbf24",
};

/* =====================================================================
   Refresh chip - small reusable button shared across tabs
   ===================================================================== */
function RefreshChip({
  label,
  syncedAt,
  isLoading,
  onClick,
}: {
  label?: string;
  syncedAt: string;
  isLoading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isLoading}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        borderRadius: 9999,
        background: isLoading
          ? "rgba(52,211,153,.1)"
          : "rgba(255,255,255,.025)",
        border: "1px solid",
        borderColor: isLoading
          ? "rgba(52,211,153,.3)"
          : "var(--border-default)",
        color: isLoading ? "#34d399" : "var(--text-secondary)",
        fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
        fontSize: 11,
        fontWeight: 600,
        cursor: isLoading ? "default" : "pointer",
        transition: "all .15s",
      }}
    >
      <RefreshCw
        style={{
          width: 11,
          height: 11,
          animation: isLoading ? "um-spin .9s linear infinite" : "none",
        }}
      />
      {isLoading ? (
        "Syncing…"
      ) : (
        <>
          {label ? `${label} · ` : "Sync · "}
          <span style={{ color: "var(--text-muted)", marginLeft: 2 }}>
            {syncedAt}
          </span>
        </>
      )}
    </button>
  );
}

/* =====================================================================
   Holdings page client
   ===================================================================== */
export default function HoldingsPageClient({
  initialHoldings,
  initialFunds,
  initialPositions,
  isDemo,
}: HoldingsPageProps = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoaded } = useUser();
  const [, startTransition] = useTransition();

  const isDemoMode = useIsDemoMode({ isDemo, user });

  /* Broker session status - drives the amber re-auth banner above the
     content when the user's broker token has expired. Falls back gracefully
     to Yahoo prices, but the banner gives them a one-click reconnect path. */
  const { brokerStatus } = useBrokerStatus();

  /* ── Tab state - synced to ?tab= in URL so /positions can deep-link ── */
  const tabParam = searchParams.get("tab");
  const initialTab =
    tabParam === "mf" || tabParam === "funds"
      ? "funds"
      : tabParam === "positions"
        ? "positions"
        : "stocks";
  const [tab, setTab] = useState<"stocks" | "funds" | "positions">(initialTab);

  /* MONEY-1082: the ?tab= write happens in the click handler, not an effect.
     As an effect it re-fired while the user was mid-navigation away from
     /holdings and `router.replace("/holdings…")` cancelled the outgoing
     navigation, dropping them back here. A handler write runs synchronously
     on click, before any competing navigation exists, and useOwnedRoute
     additionally no-ops it if we're no longer on /holdings. */
  const ownedRoute = useOwnedRoute("/holdings");

  const changeTab = useCallback(
    (next: "stocks" | "funds" | "positions") => {
      setTab(next);
      ownedRoute.syncParams({
        tab: next === "stocks" ? null : next === "funds" ? "mf" : "positions",
      });
    },
    [ownedRoute]
  );

  /* ── IDB-cached data (existing pattern) ── */
  const {
    data: holdingsData,
    isLoading: holdingsLoading,
    refresh: refreshHoldings,
  } = useIDBCache<{ holdings: Holding[]; summary: Summary }>({
    module: "holdings",
    identifier: "stocks",
    fetcher: async () => {
      const result = await getHoldingsAction({});
      if (result?.success && result?.data) {
        return {
          holdings: result.data.holdings as Holding[],
          summary: result.data.summary as Summary,
        };
      }
      throw new Error("Failed to load holdings");
    },
    initialData: initialHoldings
      ? {
          holdings: initialHoldings.holdings as Holding[],
          summary: initialHoldings.summary as Summary,
        }
      : undefined,
    skip: !isLoaded || (!user && !isDemoMode),
  });

  const {
    data: fundsData,
    isLoading: fundsLoading,
    refresh: refreshFunds,
  } = useIDBCache<{ funds: MutualFund[]; summary: Summary }>({
    module: "mutual-funds",
    identifier: "main",
    fetcher: async () => {
      const result = await getMutualFundsAction({});
      if (result?.success && result?.data) {
        return {
          funds: result.data.funds as MutualFund[],
          summary: result.data.summary as Summary,
        };
      }
      throw new Error("Failed to load mutual funds");
    },
    initialData: initialFunds
      ? {
          funds: initialFunds.funds as MutualFund[],
          summary: initialFunds.summary as Summary,
        }
      : undefined,
    skip: !isLoaded || (!user && !isDemoMode),
  });

  /* Positions: fetch on mount; refresh on demand. No IDB cache (live MTM). */
  const [positions, setPositions] = useState<Position[]>(
    initialPositions?.positions ?? []
  );
  const [positionsLoading, setPositionsLoading] = useState(false);
  // Track whether a positions load has been ATTEMPTED — using
  // `positions.length === 0` as the "not loaded" sentinel caused an infinite
  // refetch loop for accounts that genuinely have zero positions (length
  // stays 0 after the fetch, so the effect re-fired every render).
  const positionsLoadedRef = useRef(Boolean(initialPositions?.positions));

  const loadPositions = useCallback(async () => {
    positionsLoadedRef.current = true;
    setPositionsLoading(true);
    try {
      const result = await getPositionsAction({});
      if (result?.success && result?.data) {
        setPositions(result.data.positions as Position[]);
      }
    } finally {
      setPositionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    if (!user && !isDemoMode) {
      router.push("/home");
      return;
    }
    if (
      tab === "positions" &&
      !positionsLoadedRef.current &&
      !positionsLoading
    ) {
      void loadPositions();
    }
  }, [
    isLoaded,
    user,
    isDemoMode,
    router,
    tab,
    positionsLoading,
    loadPositions,
  ]);

  /* ── Broker connections (for filter pills + display names) ── */
  const [brokerConnections, setBrokerConnections] = useState<
    BrokerConnection[]
  >([]);

  useEffect(() => {
    if (!user) return;
    void getBrokerConnectionsAction().then((result) => {
      if (result?.success && result?.data) {
        setBrokerConnections(
          // MONEY-837: the founder-only Connect app is never a data source — keep
          // it out of every broker selector/filter (it only appears on /brokers).
          result.data
            .filter((conn) => conn.broker !== "ZERODHA_CONNECT")
            .map((conn) => ({
              id: conn.id,
              broker: conn.broker,
              brokerUserId: conn.brokerUserId || null,
              accountName: conn.accountName || null,
            }))
        );
      }
    });
  }, [user]);

  /* ── Portfolio returns (XIRR / CAGR) — MONEY-485 ──
     Computed server-side from dated trade cashflows. Each metric is null
     when it can't be computed correctly (no trades / no holding period);
     the tiles then keep the honest "—" placeholder. Never faked. */
  const [returns, setReturns] = useState<PortfolioReturns | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (!user && !isDemoMode) return;
    let alive = true;
    void getPortfolioReturnsAction()
      .then((result) => {
        if (alive && result?.success && result.data) setReturns(result.data);
      })
      .catch(() => {
        /* non-blocking — tiles fall back to "—" */
      });
    return () => {
      alive = false;
    };
  }, [isLoaded, user, isDemoMode]);

  const getBrokerDisplayName = useCallback(
    (broker?: string | null, brokerUserId?: string | null): string => {
      if (!broker || broker === "MANUAL") return "Manual";
      const conn = brokerConnections.find(
        (c) => c.broker === broker && c.brokerUserId === brokerUserId
      );
      if (conn?.accountName) return conn.accountName;
      return broker.charAt(0) + broker.slice(1).toLowerCase();
    },
    [brokerConnections]
  );

  /* ── Refresh: clears caches and re-syncs all brokers ── */
  const [syncedAt, setSyncedAt] = useState<{
    stocks: string;
    funds: string;
    positions: string;
  }>({ stocks: "-", funds: "-", positions: "-" });
  const [refreshing, setRefreshing] = useState<
    "stocks" | "funds" | "positions" | null
  >(null);

  const handleRefresh = useCallback(
    async (which: "stocks" | "funds" | "positions") => {
      if (refreshing) return;
      setRefreshing(which);
      try {
        await clearHoldingsCacheAction();
        const syncResult = await syncAllBrokersAction();
        // Suppress the toast when the broker session is expired - the
        // amber re-auth banner already tells the user. We only nag for
        // genuinely unexpected failures (network, validation, etc.).
        if (!syncResult?.success && syncResult?.error) {
          const msg = String(syncResult.error).toLowerCase();
          const isAuthError =
            msg.includes("token") ||
            msg.includes("auth") ||
            msg.includes("expired") ||
            msg.includes("unauthorized") ||
            msg.includes("403") ||
            msg.includes("incorrect");
          if (!isAuthError) toast.error(syncResult.error);
        }
        if (user?.id) await clearIDBHoldingsCache(user.id);
        await Promise.all([
          which === "stocks" ? refreshHoldings() : Promise.resolve(),
          which === "funds" ? refreshFunds() : Promise.resolve(),
          which === "positions" ? loadPositions() : Promise.resolve(),
        ]);
        setSyncedAt((s) => ({ ...s, [which]: "Just now" }));
      } finally {
        setRefreshing(null);
      }
    },
    [refreshing, user?.id, refreshHoldings, refreshFunds, loadPositions]
  );

  /* ── Filter state per tab ── */
  const [stockBroker, setStockBroker] = useState("all");
  const [stockSector, setStockSector] = useState("all");
  const [stockCap, setStockCap] = useState<"all" | MarketCap>("all");
  const [stockSort, setStockSort] = useState<"pl" | "pct" | "value" | "name">(
    "pl"
  );
  const [fundCategory, setFundCategory] = useState("all");
  const [fundAMC, setFundAMC] = useState("all");
  const [fundBroker, setFundBroker] = useState("all");
  const [posFilter, setPosFilter] = useState<"all" | "intraday" | "fo">("all");
  const [posBroker, setPosBroker] = useState("all");

  /* ── Derived data ──
     Wrap the `?? []` fallback in useMemo so the array identity is stable
     across renders. Without this, every render creates a fresh `[]` and
     each downstream useMemo's dep array sees a new reference, defeating
     memoization. */
  const holdings = useMemo<Holding[]>(
    () => holdingsData?.holdings ?? [],
    [holdingsData]
  );
  const holdingsSummary = holdingsData?.summary ?? null;
  const funds = useMemo<MutualFund[]>(
    () => fundsData?.funds ?? [],
    [fundsData]
  );
  const fundsSummary = fundsData?.summary ?? null;

  const allSectors = useMemo(
    () =>
      Array.from(
        new Set(holdings.map((h) => h.sector).filter(Boolean))
      ).sort() as string[],
    [holdings]
  );
  const allCategories = useMemo(
    () =>
      Array.from(
        new Set(funds.map((f) => f.category).filter(Boolean))
      ).sort() as string[],
    [funds]
  );
  const allAMCs = useMemo(
    () => Array.from(new Set(funds.map((f) => deriveAMC(f.schemeName)))).sort(),
    [funds]
  );

  const filteredStocks = useMemo(() => {
    let arr = holdings;
    if (stockBroker !== "all") {
      if (stockBroker === "manual") {
        arr = arr.filter((h) => !h.broker || h.broker === "MANUAL");
      } else {
        const [b, bUserId] = stockBroker.split(":");
        arr = arr.filter(
          (h) => h.broker === b && (h.brokerUserId || "") === bUserId
        );
      }
    }
    if (stockSector !== "all")
      arr = arr.filter((h) => h.sector === stockSector);
    if (stockCap !== "all")
      arr = arr.filter((h) => classifyMarketCap(h.symbol) === stockCap);
    return [...arr].sort((a, b) => {
      const apl = a.unrealizedPnL,
        bpl = b.unrealizedPnL;
      if (stockSort === "pl") return bpl - apl;
      if (stockSort === "pct")
        return (
          b.unrealizedPnL / Math.max(1, b.investedValue) -
          a.unrealizedPnL / Math.max(1, a.investedValue)
        );
      if (stockSort === "value") return b.currentValue - a.currentValue;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [holdings, stockBroker, stockSector, stockCap, stockSort]);

  const filteredFunds = useMemo(() => {
    let arr = funds;
    if (fundCategory !== "all")
      arr = arr.filter((f) => f.category === fundCategory);
    if (fundAMC !== "all")
      arr = arr.filter((f) => deriveAMC(f.schemeName) === fundAMC);
    if (fundBroker !== "all") {
      if (fundBroker === "manual") {
        arr = arr.filter((f) => !f.broker || f.broker === "MANUAL");
      } else {
        const [b, bUserId] = fundBroker.split(":");
        arr = arr.filter(
          (f) => f.broker === b && (f.brokerUserId || "") === (bUserId ?? "")
        );
      }
    }
    return arr;
  }, [funds, fundCategory, fundAMC, fundBroker]);

  const filteredPositions = useMemo(() => {
    let arr = positions;
    if (posBroker !== "all") {
      if (posBroker === "manual") {
        arr = arr.filter((p) => !p.broker || p.broker === "MANUAL");
      } else {
        const [b, bUserId] = posBroker.split(":");
        arr = arr.filter(
          (p) => p.broker === b && (p.brokerUserId || "") === (bUserId ?? "")
        );
      }
    }
    if (posFilter === "intraday")
      arr = arr.filter((p) => p.productType === "MIS");
    if (posFilter === "fo")
      arr = arr.filter((p) => p.segment === "NSE-FO" || p.segment === "FO");
    return arr;
  }, [positions, posFilter, posBroker]);

  /* Donut data - sector mix + concentration / categories / segment & side */
  const stockSectorSlices: DonutSlice[] = useMemo(() => {
    const m = new Map<string, number>();
    filteredStocks.forEach((h) =>
      m.set(
        h.sector || "Other",
        (m.get(h.sector || "Other") ?? 0) + h.currentValue
      )
    );
    return Array.from(m.entries()).map(([k, value], i) => ({
      k,
      value,
      color: SECTOR_PALETTE[i % SECTOR_PALETTE.length],
    }));
  }, [filteredStocks]);

  /* Market-cap mix - bucket holdings by Large/Mid/Small using the static
     classifier above, weighted by current value. */
  const stockCapSlices: DonutSlice[] = useMemo(() => {
    const m = new Map<MarketCap, number>();
    filteredStocks.forEach((h) => {
      const cap = classifyMarketCap(h.symbol);
      m.set(cap, (m.get(cap) ?? 0) + h.currentValue);
    });
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([cap, value]) => ({
        k: CAP_LABEL[cap],
        value,
        color: CAP_COLOR[cap],
      }));
  }, [filteredStocks]);

  const fundAMCSlices: DonutSlice[] = useMemo(() => {
    const m = new Map<string, number>();
    funds.forEach((f) => {
      const amc = deriveAMC(f.schemeName);
      m.set(amc, (m.get(amc) ?? 0) + f.currentValue);
    });
    return Array.from(m.entries()).map(([k, value], i) => ({
      k,
      value,
      color: SECTOR_PALETTE[i % SECTOR_PALETTE.length],
    }));
  }, [funds]);

  const fundCatSlices: DonutSlice[] = useMemo(() => {
    const m = new Map<string, number>();
    funds.forEach((f) => {
      const cat = f.category || "Other";
      m.set(cat, (m.get(cat) ?? 0) + f.currentValue);
    });
    return Array.from(m.entries()).map(([k, value], i) => ({
      k,
      value,
      color: SECTOR_PALETTE[i % SECTOR_PALETTE.length],
    }));
  }, [funds]);

  const posSegSlices: DonutSlice[] = useMemo(() => {
    const m = new Map<string, number>();
    positions.forEach((p) => {
      const k =
        p.segment === "NSE-FO" || p.segment === "FO"
          ? "Futures & Options"
          : p.segment === "NSE-EQ" ||
              p.segment === "EQ" ||
              p.segment === "EQUITY"
            ? "Equity Intraday"
            : "Other";
      const v = Math.abs(p.quantity) * p.currentPrice;
      m.set(k, (m.get(k) ?? 0) + v);
    });
    return Array.from(m.entries()).map(([k, value]) => ({
      k,
      value,
      color: SEG_COLORS[k as keyof typeof SEG_COLORS] || SEG_COLORS.Other,
    }));
  }, [positions]);

  const posSideSlices: DonutSlice[] = useMemo(() => {
    let long = 0,
      short = 0;
    positions.forEach((p) => {
      const v = Math.abs(p.quantity) * p.currentPrice;
      if (p.positionType === "SHORT") short += v;
      else long += v;
    });
    return [
      { k: "Long", value: long, color: SIDE_COLORS.Long },
      { k: "Short", value: short, color: SIDE_COLORS.Short },
    ].filter((s) => s.value > 0);
  }, [positions]);

  /* ── Portfolio totals (Stocks + MF) ── */
  const portfolioCur =
    (holdingsSummary?.totalCurrent ?? 0) + (fundsSummary?.totalCurrent ?? 0);
  const portfolioInv =
    (holdingsSummary?.totalInvested ?? 0) + (fundsSummary?.totalInvested ?? 0);
  const portfolioPL = portfolioCur - portfolioInv;
  const portfolioPct =
    portfolioInv > 0 ? (portfolioPL / portfolioInv) * 100 : 0;

  /* Position totals */
  const posTotalPL = filteredPositions.reduce((s, p) => s + p.unrealizedPnL, 0);
  const posExposure = filteredPositions.reduce(
    (s, p) => s + Math.abs(p.quantity) * p.currentPrice,
    0
  );
  const allPosCount = positions.length;
  const intradayCount = positions.filter((p) => p.productType === "MIS").length;
  const foCount = positions.filter(
    (p) => p.segment === "NSE-FO" || p.segment === "FO"
  ).length;

  /* ── Manual entry dialog ── */
  const [modalOpen, setModalOpen] = useState(false);

  const handleManualSave = async (data: ManualEntrySubmission) => {
    if (data.kind === "fund") {
      const result = await addManualMutualFundAction({
        schemeName: data.scheme || data.ticker,
        schemeCode: data.schemeCode || null,
        folioNumber: data.folio || null,
        category: "Equity",
        units: parseFloat(data.qty) || 0,
        averageNav: parseFloat(data.price) || 0,
        sipActive: false,
        sipAmount: null,
      });
      if (result?.success) {
        toast.success("Mutual fund added");
        setModalOpen(false);
        await refreshFunds();
      } else {
        toast.error(result?.error || "Failed to add fund");
      }
      return;
    }
    if (data.kind === "position") {
      const result = await addManualPositionAction({
        symbol: data.ticker.toUpperCase(),
        exchange: data.segment.startsWith("BSE") ? "BSE" : "NSE",
        segment: data.segment.includes("FO") ? "NSE-FO" : "NSE-EQ",
        productType: data.product || "CNC",
        positionType: data.side === "SELL" ? "SHORT" : "LONG",
        quantity: Number(data.qty),
        entryPrice: Number(data.price),
      });
      if (result?.success) {
        toast.success("Position added");
        setModalOpen(false);
        await loadPositions();
      } else {
        toast.error(result?.error || "Failed to add position");
      }
      return;
    }
    const result = await addManualHoldingAction({
      symbol: data.ticker.toUpperCase(),
      exchange: data.segment.startsWith("BSE") ? "BSE" : "NSE",
      quantity: Number(data.qty),
      averagePrice: Number(data.price),
    });
    if (result?.success) {
      toast.success("Stock added");
      setModalOpen(false);
      startTransition(() => {
        void refreshHoldings();
      });
    } else {
      toast.error(result?.error || "Failed to add stock");
    }
  };

  /* Map broker connections → manual-entry dropdown options */
  const manualBrokerOptions = useMemo(() => {
    const opts: { value: string; label: string; desc?: string }[] =
      brokerConnections.map((c) => ({
        value: c.broker,
        label: c.accountName || c.broker,
        desc: c.brokerUserId || undefined,
      }));
    opts.push({
      value: "manual",
      label: "Manual / Off-market",
      desc: "No broker linked",
    });
    return opts;
  }, [brokerConnections]);

  const isLoading = holdingsLoading || fundsLoading;
  if (isLoading && !holdingsData && !fundsData) {
    // MONEY-877: wrap the skeleton in the shell — same stretched-first-load bug as
    // tradebook (PageGuard returns children verbatim when the subscription is cached,
    // so a bare skeleton has no sidenav until the data resolves).
    return (
      <PageGuard route="/holdings" fallback={<HoldingsSkeleton />}>
        <TerminalLuxeShell
          active="holdings"
          title="Holdings"
          breadcrumb="Portfolio"
          showAskSage
        >
          <HoldingsSkeleton />
        </TerminalLuxeShell>
      </PageGuard>
    );
  }

  return (
    <PageGuard route="/holdings" fallback={<HoldingsSkeleton />}>
      <TerminalLuxeShell
        active="holdings"
        title="Holdings"
        breadcrumb="Portfolio"
        showAskSage
        topbarRight={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <TakeTheTourButton version="v1-holdings" />
            {/*
             * #119: FAB (below) uses lg:hidden so it is mobile-only.
             * This button is the sole desktop add affordance — keep it but
             * re-theme from off-theme um-btn-acc (green text) to playful pf-bf.
             */}
            <button
              type="button"
              className="pf-bf um-hide-mobile"
              onClick={() => setModalOpen(true)}
            >
              <Plus style={{ width: 13, height: 13 }} /> Add manually
            </button>
          </div>
        }
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

        {/* ── Playful hero header (design: HoldingsScreen pf-ph) ── */}
        <PfPageHead
          eyebrow={`${holdings.length + funds.length} INSTRUMENTS · ${brokerConnections.length} ${brokerConnections.length === 1 ? "BROKER" : "BROKERS"}`}
          title={
            <>
              Holdings, <span className="ser">all in</span>{" "}
              <span className="hl-gold">one place.</span>
            </>
          }
          sub="Reconciled across your brokers — XIRR computed daily."
        />

        {/* ── 5-stat strip (design: HoldingsScreen) ── */}
        <div
          className="um-stats-grid"
          data-walkthrough="holdings-kpis"
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
            <div className="l">CURRENT</div>
            <div className="v" style={{ fontSize: 22 }}>
              {fmtLakhs(portfolioCur)}
            </div>
          </div>
          <div
            className="pf-card pf-stat flat"
            style={{ background: "var(--rule-softer)" }}
          >
            <div className="l">INVESTED</div>
            <div className="v" style={{ fontSize: 22 }}>
              {fmtLakhs(portfolioInv)}
            </div>
          </div>
          <div
            className="pf-card pf-stat flat"
            style={{
              background: "var(--emerald-bg)",
              borderColor: "var(--emerald)",
            }}
          >
            <div className="l">UNREALISED</div>
            <div
              className="v"
              style={{
                fontSize: 22,
                color: portfolioPL >= 0 ? "var(--emerald)" : "var(--pop-1)",
              }}
            >
              {fmtINRSigned(Math.round(portfolioPL))}
            </div>
            <div className={`d ${portfolioPct >= 0 ? "pos" : "neg"}`}>
              {(portfolioPct >= 0 ? "+" : "") + portfolioPct.toFixed(2)}%
            </div>
          </div>
          {/* XIRR / CAGR — real values from dated trade cashflows
              (MONEY-485). null → honest "—", never faked. */}
          {(() => {
            const fmtPct = (v: number | null | undefined) =>
              v == null ? null : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
            const xirr = fmtPct(returns?.xirrPct);
            const cagr = fmtPct(returns?.cagrPct);
            const periodHint = returns?.holdingPeriodYears
              ? `Over ${returns.holdingPeriodYears.toFixed(1)} yrs`
              : "Needs trade history";
            return (
              <>
                <div
                  className="pf-card pf-stat flat"
                  style={{ background: "var(--rule-softer)" }}
                >
                  <div className="l">XIRR</div>
                  <div
                    className="v"
                    style={{
                      fontSize: 22,
                      color: xirr
                        ? (returns!.xirrPct ?? 0) >= 0
                          ? "var(--emerald)"
                          : "var(--pop-1)"
                        : "var(--ink-3)",
                    }}
                    title={
                      xirr
                        ? "Money-weighted annualised return"
                        : "Add trade history to compute XIRR"
                    }
                  >
                    {xirr ?? "—"}
                  </div>
                </div>
                <div
                  className="pf-card pf-stat flat"
                  style={{ background: "var(--rule-softer)" }}
                >
                  <div className="l">CAGR</div>
                  <div
                    className="v"
                    style={{
                      fontSize: 22,
                      color: cagr
                        ? (returns!.cagrPct ?? 0) >= 0
                          ? "var(--emerald)"
                          : "var(--pop-1)"
                        : "var(--ink-3)",
                    }}
                    title={
                      cagr
                        ? "Compound annual growth rate"
                        : "Add trade history to compute CAGR"
                    }
                  >
                    {cagr ?? "—"}
                  </div>
                  {cagr && (
                    <div className="d" style={{ color: "var(--ink-3)" }}>
                      {periodHint}
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </div>

        {/* ── Tab bar — playful ink-filled pill for active tab ── */}
        <div
          data-walkthrough="holdings-tabs"
          style={{
            display: "flex",
            gap: 3,
            padding: 3,
            background: "var(--rule-softer)",
            borderRadius: 9,
            border: "1.5px solid var(--ink)",
            maxWidth: "100%",
            marginBottom: 16,
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
            scrollbarWidth: "none",
          }}
        >
          {[
            {
              id: "stocks" as const,
              lbl: `STOCKS · ${holdings.length}`,
              Icon: TrendingUp,
            },
            {
              id: "funds" as const,
              lbl: `MUTUAL FUNDS · ${funds.length}`,
              Icon: PieChartIcon,
            },
            {
              id: "positions" as const,
              lbl: `POSITIONS · ${allPosCount}`,
              Icon: Activity,
            },
          ].map((t) => {
            const a = tab === t.id;
            return (
              <button
                type="button"
                key={t.id}
                onClick={() => {
                  changeTab(t.id);
                  if (typeof window !== "undefined") {
                    if (t.id === "funds") {
                      window.dispatchEvent(
                        new CustomEvent("walkthrough:holdings-funds-opened")
                      );
                    } else if (t.id === "positions") {
                      window.dispatchEvent(
                        new CustomEvent("walkthrough:holdings-positions-opened")
                      );
                    }
                  }
                }}
                style={{
                  padding: "7px 14px",
                  borderRadius: 6,
                  border: 0,
                  cursor: "pointer",
                  background: a ? "var(--ink)" : "transparent",
                  color: a ? "var(--paper)" : "var(--ink-3)",
                  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  whiteSpace: "nowrap",
                  transition: "background .12s, color .12s",
                }}
              >
                <t.Icon style={{ width: 12, height: 12 }} /> {t.lbl}
              </button>
            );
          })}
        </div>

        {/* ───────────────── STOCKS TAB ───────────────── */}
        {tab === "stocks" && (
          <StocksTab
            stocks={filteredStocks}
            allCount={holdings.length}
            sectorSlices={stockSectorSlices}
            capSlices={stockCapSlices}
            brokerConnections={brokerConnections}
            stockBroker={stockBroker}
            setStockBroker={setStockBroker}
            stockSector={stockSector}
            setStockSector={setStockSector}
            stockCap={stockCap}
            setStockCap={setStockCap}
            stockSort={stockSort}
            setStockSort={setStockSort}
            allSectors={allSectors}
            getBrokerDisplayName={getBrokerDisplayName}
            syncedAt={syncedAt.stocks}
            refreshing={refreshing === "stocks"}
            onRefresh={() => handleRefresh("stocks")}
            onAddManual={() => setModalOpen(true)}
          />
        )}

        {/* ───────────────── MUTUAL FUNDS TAB ───────────────── */}
        {tab === "funds" && (
          <FundsTab
            funds={filteredFunds}
            allFundsCount={funds.length}
            amcSlices={fundAMCSlices}
            catSlices={fundCatSlices}
            allCategories={allCategories}
            allAMCs={allAMCs}
            fundCategory={fundCategory}
            setFundCategory={setFundCategory}
            fundAMC={fundAMC}
            setFundAMC={setFundAMC}
            fundBroker={fundBroker}
            setFundBroker={setFundBroker}
            brokerConnections={brokerConnections}
            syncedAt={syncedAt.funds}
            refreshing={refreshing === "funds"}
            onRefresh={() => handleRefresh("funds")}
            onAddManual={() => setModalOpen(true)}
          />
        )}

        {/* ───────────────── POSITIONS TAB ───────────────── */}
        {tab === "positions" && (
          <PositionsTab
            positions={filteredPositions}
            allPosCount={allPosCount}
            intradayCount={intradayCount}
            foCount={foCount}
            posTotalPL={posTotalPL}
            posExposure={posExposure}
            posFilter={posFilter}
            setPosFilter={setPosFilter}
            posBroker={posBroker}
            setPosBroker={setPosBroker}
            brokerConnections={brokerConnections}
            segSlices={posSegSlices}
            sideSlices={posSideSlices}
            getBrokerDisplayName={getBrokerDisplayName}
            brokerStatus={brokerStatus}
            syncedAt={syncedAt.positions}
            refreshing={refreshing === "positions"}
            onRefresh={() => handleRefresh("positions")}
            onAddManual={() => setModalOpen(true)}
          />
        )}

        {/* Mobile floating + button */}
        <button
          type="button"
          className="pf-bs lg:hidden"
          onClick={() => setModalOpen(true)}
          style={{
            position: "fixed",
            bottom: 76,
            right: 16,
            zIndex: 30,
            padding: "12px 20px",
            borderRadius: 9999,
          }}
        >
          <Plus style={{ width: 16, height: 16 }} /> Add
        </button>

        <ManualEntryModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onSave={handleManualSave}
          kind={
            tab === "funds"
              ? "fund"
              : tab === "positions"
                ? "position"
                : "holding"
          }
          brokerOptions={manualBrokerOptions}
        />
      </TerminalLuxeShell>
    </PageGuard>
  );
}

/* =====================================================================
   STOCKS TAB - broker pills + filters + visual breakdown + table
   ===================================================================== */
function StocksTab({
  stocks,
  allCount,
  sectorSlices,
  capSlices,
  brokerConnections,
  stockBroker,
  setStockBroker,
  stockSector,
  setStockSector,
  stockCap,
  setStockCap,
  stockSort,
  setStockSort,
  allSectors,
  getBrokerDisplayName,
  syncedAt,
  refreshing,
  onRefresh,
  onAddManual,
}: {
  stocks: Holding[];
  allCount: number;
  sectorSlices: DonutSlice[];
  capSlices: DonutSlice[];
  brokerConnections: BrokerConnection[];
  stockBroker: string;
  setStockBroker: (v: string) => void;
  stockSector: string;
  setStockSector: (v: string) => void;
  stockCap: "all" | MarketCap;
  setStockCap: (v: "all" | MarketCap) => void;
  stockSort: "pl" | "pct" | "value" | "name";
  setStockSort: (v: "pl" | "pct" | "value" | "name") => void;
  allSectors: string[];
  getBrokerDisplayName: (b?: string | null, u?: string | null) => string;
  syncedAt: string;
  refreshing: boolean;
  onRefresh: () => void;
  onAddManual: () => void;
}) {
  const totals = stocks.reduce(
    (s, r) => ({
      inv: s.inv + r.investedValue,
      cur: s.cur + r.currentValue,
      pl: s.pl + r.unrealizedPnL,
    }),
    { inv: 0, cur: 0, pl: 0 }
  );
  const totalPct = totals.inv > 0 ? (totals.pl / totals.inv) * 100 : 0;

  /* Zero-holdings empty state — shown before any filters are applied */
  if (allCount === 0) {
    return (
      <EmptyState
        icon={Briefcase}
        title="No holdings yet."
        description="Connect a broker to see your stocks, MFs and ETFs all in one place."
        color="var(--emerald)"
        action={{ label: "Connect broker →", href: "/brokers" }}
        secondaryAction={{ label: "Add manually", onClick: onAddManual }}
      />
    );
  }

  return (
    <>
      {/* Visual breakdown row */}
      <div
        className="um-holdings-viz"
        data-walkthrough="holdings-viz"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          marginBottom: 14,
        }}
      >
        <div className="pf-card flat" style={{ padding: 14 }}>
          <div
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              color: "var(--ink-3)",
              marginBottom: 10,
              textTransform: "uppercase",
            }}
          >
            Sector mix
          </div>
          {sectorSlices.length > 0 ? (
            <SplitDonut slices={sectorSlices} label="SECTORS" />
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
              No data — connect a broker to sync.
            </div>
          )}
        </div>
        <div className="pf-card flat" style={{ padding: 14 }}>
          <div
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              color: "var(--ink-3)",
              marginBottom: 10,
              textTransform: "uppercase",
            }}
          >
            Market cap
          </div>
          {capSlices.length > 0 ? (
            <SplitDonut slices={capSlices} label="CAPS" />
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>—</div>
          )}
        </div>
      </div>

      {/* Filter row */}
      <div
        data-walkthrough="holdings-filters"
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 14,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {/* #114 — Broker filter as playful Dropdown (replaces pill row) */}
        <Dropdown
          compact
          width={170}
          value={stockBroker}
          onChange={setStockBroker}
          options={[
            { value: "all", label: `All brokers · ${allCount}` },
            ...brokerConnections.map((c) => ({
              value: `${c.broker}:${c.brokerUserId || ""}`,
              label: c.accountName || c.broker,
            })),
            { value: "manual", label: "Manual" },
          ]}
        />

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <Dropdown
            compact
            width={150}
            value={stockSector}
            onChange={setStockSector}
            options={[
              { value: "all", label: "All sectors" },
              ...allSectors.map((s) => ({ value: s, label: s })),
            ]}
          />
          <Dropdown
            compact
            width={150}
            value={stockCap}
            onChange={(v) => setStockCap(v as "all" | MarketCap)}
            options={[
              { value: "all", label: "All market cap" },
              { value: "large", label: "Large Cap" },
              { value: "mid", label: "Mid Cap" },
              { value: "small", label: "Small Cap" },
            ]}
          />
          <Dropdown
            compact
            width={170}
            value={stockSort}
            onChange={(v) => setStockSort(v as "pl" | "pct" | "value" | "name")}
            options={[
              { value: "pl", label: "Sort · P/L (₹)" },
              { value: "pct", label: "Sort · P/L (%)" },
              { value: "value", label: "Sort · Value" },
              { value: "name", label: "Sort · Name" },
            ]}
          />
          <RefreshChip
            syncedAt={syncedAt}
            isLoading={refreshing}
            onClick={onRefresh}
          />
        </div>
      </div>

      {/* Desktop table — playful pf-tbl */}
      <div
        // um-hide-lt-1100, NOT um-hide-mobile: the mobile cards show at
        // <=1100px (um-mobile-only's boundary — the app's chrome breakpoint),
        // but um-hide-mobile only hides at <=720px, so between 721 and 1100px
        // BOTH the table and the cards rendered (MONEY-1171). One breakpoint,
        // two complementary halves.
        className="pf-card um-hide-lt-1100"
        style={{ padding: 0, overflow: "hidden" }}
      >
        <div style={{ overflowX: "auto" }}>
          <table className="pf-tbl" data-walkthrough="holdings-table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>STOCK</th>
                <th>BROKER</th>
                <th style={{ textAlign: "right" }}>QTY</th>
                <th style={{ textAlign: "right" }}>AVG</th>
                <th style={{ textAlign: "right" }}>LTP</th>
                <th style={{ textAlign: "right" }}>INVESTED</th>
                <th style={{ textAlign: "right" }}>CURRENT</th>
                <th style={{ textAlign: "right" }}>P/L</th>
                <th style={{ textAlign: "right" }}>%</th>
                <th style={{ width: 1 }}></th>
              </tr>
            </thead>
            <tbody>
              {stocks.length === 0 && (
                <tr>
                  <td colSpan={10} style={emptyCellStyle}>
                    <SearchX
                      style={{
                        width: 22,
                        height: 22,
                        color: "var(--ink-3)",
                        marginBottom: 6,
                      }}
                    />
                    <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
                      No stocks match these filters.
                    </div>
                  </td>
                </tr>
              )}
              {stocks.map((r) => (
                <HoldingRow
                  key={r.id}
                  r={r}
                  brokerDisplay={getBrokerDisplayName(r.broker, r.brokerUserId)}
                />
              ))}
            </tbody>
            {stocks.length > 0 && (
              <tfoot>
                <tr style={{ background: "var(--emerald-bg)" }}>
                  <td
                    colSpan={5}
                    style={{
                      ...pfTfootLabel,
                      paddingLeft: 18,
                    }}
                  >
                    TOTAL · {stocks.length} STOCKS
                  </td>
                  <td className="num" style={pfTfootCell}>
                    {fmtINR(Math.round(totals.inv))}
                  </td>
                  <td className="num" style={pfTfootCell}>
                    {fmtINR(Math.round(totals.cur))}
                  </td>
                  <td
                    className="num"
                    style={{
                      ...pfTfootCell,
                      color: totals.pl >= 0 ? "var(--emerald)" : "var(--pop-1)",
                    }}
                  >
                    {fmtINRSigned(Math.round(totals.pl))}
                  </td>
                  <td
                    className="num"
                    style={{
                      ...pfTfootCell,
                      color: totals.pl >= 0 ? "var(--emerald)" : "var(--pop-1)",
                    }}
                  >
                    {(totalPct >= 0 ? "+" : "") + totalPct.toFixed(2)}%
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Mobile cards — playful pf-card treatment */}
      <div
        className="um-mobile-only pf-card"
        // flexDirection matters: `.um-mobile-only` forces `display: flex
        // !important` (it was written for the bottom tab bar, where ROW is
        // right). Without an explicit column direction every holding card
        // becomes a flex-row item — cards flow sideways, crush to
        // min-content and their values overlap the next card's symbol
        // (MONEY-1171). The inline display:"none" is the desktop state; the
        // !important flips it on mobile.
        style={{
          padding: 0,
          overflow: "hidden",
          display: "none",
          flexDirection: "column",
        }}
      >
        {stocks.length === 0 && (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--ink-3)",
            }}
          >
            <SearchX style={{ width: 22, height: 22, marginBottom: 6 }} />
            <div style={{ fontSize: 13 }}>No stocks match these filters.</div>
          </div>
        )}
        {stocks.map((r) => (
          <HoldingCard
            key={r.id}
            r={r}
            brokerDisplay={getBrokerDisplayName(r.broker, r.brokerUserId)}
          />
        ))}
      </div>
    </>
  );
}

function HoldingRow({
  r,
  brokerDisplay,
}: {
  r: Holding;
  brokerDisplay: string;
}) {
  const isManual = !r.broker || r.broker === "MANUAL";
  const pos = r.unrealizedPnL >= 0;
  const exchange = r.exchange || "NSE";
  // MONEY-1205 — a `Holding` row carries no instrument type (see the model), so
  // this resolves to `/stock/…` for an ETF holding and the canonical redirect
  // in `app/stock/[symbol]/page.tsx` catches it. The helper is still the right
  // call site: it is where the type will arrive when the row carries one.
  const detailHref = instrumentDetailHref({ symbol: r.symbol, exchange });
  return (
    <tr>
      <td>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Link href={detailHref} className="tk hover:underline">
              {r.symbol}
            </Link>
            {isManual && (
              <span
                style={{
                  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                  fontSize: 8.5,
                  padding: "1px 5px",
                  background: "rgba(167,139,250,.15)",
                  color: "var(--pop-5)",
                  borderRadius: 3,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                }}
              >
                MANUAL
              </span>
            )}
          </div>
          {r.sector && (
            <span className="nm" style={{ fontSize: 11.5 }}>
              {r.sector}
            </span>
          )}
        </div>
      </td>
      <td>
        {isManual ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 9px",
              borderRadius: 9999,
              background: "rgba(167,139,250,.08)",
              border: "1px solid rgba(167,139,250,.2)",
              fontSize: 11,
              color: "#a78bfa",
              fontWeight: 600,
            }}
          >
            <BrokerLogo slug="manual" size={11} /> Off-market
          </span>
        ) : (
          <BrokerChip
            slug={toBrokerSlug(r.broker)}
            name={brokerDisplay}
            compact
          />
        )}
      </td>
      <td className="num" style={{ color: "var(--ink-2)", textAlign: "right" }}>
        {r.quantity + (r.t1Quantity ?? 0)}
      </td>
      <td className="num" style={{ color: "var(--ink-3)", textAlign: "right" }}>
        ₹{r.averagePrice.toFixed(2)}
      </td>
      <td
        className="num"
        style={{ color: "var(--ink)", fontWeight: 700, textAlign: "right" }}
      >
        ₹{r.currentPrice.toFixed(2)}
      </td>
      <td className="num" style={{ color: "var(--ink-3)", textAlign: "right" }}>
        {fmtINR(r.investedValue)}
      </td>
      <td className="num" style={{ color: "var(--ink-2)", textAlign: "right" }}>
        {fmtINR(Math.round(r.currentValue))}
      </td>
      <td
        className={`num ${pos ? "pos" : "neg"}`}
        style={{ fontWeight: 700, textAlign: "right" }}
      >
        {fmtINRSigned(Math.round(r.unrealizedPnL))}
      </td>
      <td
        className={`num ${pos ? "pos" : "neg"}`}
        style={{ fontWeight: 700, textAlign: "right" }}
      >
        {pos ? "▲" : "▼"} {Math.abs(r.pnlPercentage).toFixed(2)}%
      </td>
      <td style={{ width: 1, whiteSpace: "nowrap" }}>
        <HoldingRowActions
          symbol={r.symbol}
          exchange={exchange}
          kind="STOCK"
          positionPrefill={holdingToPositionPrefill(r)}
        />
      </td>
    </tr>
  );
}

/**
 * Per-row action buttons on Holdings - chart icon and research icon.
 * Chart routes to /stock detail (or /mf detail) chart anchor; research
 * opens ResearchModal so the user can pick style / model / skills before
 * the run lands at /analysis/[sessionId].
 */
function HoldingRowActions({
  symbol,
  exchange,
  kind,
  positionPrefill,
}: {
  symbol: string;
  exchange: string;
  kind: "STOCK" | "MF";
  /**
   * MONEY-400 - Holdings-triggered research pre-fill. When the
   * `holdings-research-trigger` FF is on, this is forwarded to
   * ResearchModal as `positionData` so the run starts with qty +
   * avg + LTP + unrealized P&L already in the agent's context.
   */
  positionPrefill?: {
    quantity: number;
    purchasePrice: number;
    purchaseDate: string;
    currentPrice: number;
    unrealizedPnL: number;
  };
}) {
  const [researchOpen, setResearchOpen] = useState(false);
  const { flags } = useAppFeatureFlags();
  const triggerOn = flags["holdings-research-trigger"] && !!positionPrefill;
  const positionData =
    triggerOn && positionPrefill
      ? prefillToPositionData(positionPrefill)
      : null;
  const detailHref = instrumentDetailHref({
    symbol,
    exchange,
    instrumentType: kind === "MF" ? "MF" : undefined,
    hash: "chart",
  });
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <Link
        href={detailHref}
        aria-label={`Open chart for ${symbol}`}
        title="Open chart"
        style={{
          color: "var(--text-muted)",
          display: "inline-flex",
          padding: 4,
          borderRadius: 6,
        }}
        className="hover:text-emerald-400 hover:bg-[var(--bg-card-hover)]"
      >
        <LineChartIcon style={{ width: 14, height: 14 }} />
      </Link>
      {/* MONEY-457: Research / Analysis trigger hidden for MF rows in
          Portfolio → Funds. MF research flow is being reworked separately
          and the current ResearchModal path is stock-shaped. Stock rows
          keep the Sparkles trigger. Uncomment the `kind !== "MF"` guard
          when MF research lands. */}
      {kind !== "MF" && (
        <button
          type="button"
          aria-label={`Research ${symbol}`}
          title="Run research"
          onClick={() => setResearchOpen(true)}
          style={{
            color: "var(--text-muted)",
            display: "inline-flex",
            padding: 4,
            borderRadius: 6,
            background: "transparent",
            border: "none",
            cursor: "pointer",
          }}
          className="hover:text-emerald-400 hover:bg-[var(--bg-card-hover)]"
        >
          <Sparkles style={{ width: 14, height: 14 }} />
        </button>
      )}
      {researchOpen && (
        <ResearchModal
          open={researchOpen}
          onOpenChange={setResearchOpen}
          entity={{
            symbol,
            name: symbol,
            type: kind === "MF" ? "mf" : "stock",
            exchange,
          }}
          positionData={positionData}
        />
      )}
    </div>
  );
}

function HoldingCard({
  r,
  brokerDisplay,
}: {
  r: Holding;
  brokerDisplay: string;
}) {
  const pos = r.unrealizedPnL >= 0;
  const isManual = !r.broker || r.broker === "MANUAL";
  const exchange = r.exchange || "NSE";
  const detailHref = instrumentDetailHref({ symbol: r.symbol, exchange });
  return (
    <div
      style={{
        padding: "14px 16px",
        borderBottom: "1.5px solid var(--rule)",
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 12,
        alignItems: "start",
      }}
    >
      {/* Left column */}
      <div style={{ minWidth: 0 }}>
        {/* Symbol row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <Link
            href={detailHref}
            style={{
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              fontWeight: 800,
              color: "var(--ink)",
              fontSize: 14,
              textDecoration: "none",
              letterSpacing: 0.2,
            }}
            className="hover:underline"
          >
            {r.symbol}
          </Link>
          {r.sector && (
            <span
              style={{
                fontSize: 10,
                color: "var(--ink-3)",
                fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                fontWeight: 600,
                background: "var(--rule-softer)",
                border: "1px solid var(--rule)",
                borderRadius: 4,
                padding: "1px 5px",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 90,
              }}
            >
              {r.sector}
            </span>
          )}
          <span style={{ marginLeft: "auto" }}>
            <HoldingRowActions
              symbol={r.symbol}
              exchange={exchange}
              kind="STOCK"
              positionPrefill={holdingToPositionPrefill(r)}
            />
          </span>
        </div>

        {/* Broker chip */}
        <div style={{ marginBottom: 8 }}>
          {isManual ? (
            <span
              className="br-chip"
              style={{
                padding: "3px 8px",
                fontSize: 10.5,
                fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                fontWeight: 700,
                letterSpacing: 0.3,
                color: "var(--ink)",
                gap: 5,
              }}
            >
              <span
                className="pf-av-sq"
                style={{
                  width: 18,
                  height: 18,
                  background: "#a78bfa",
                  color: "#fff",
                  fontSize: 7,
                  borderRadius: 4,
                  transform: "rotate(-2deg)",
                  flexShrink: 0,
                }}
              >
                MN
              </span>
              MANUAL
            </span>
          ) : (
            <BrokerChip
              slug={toBrokerSlug(r.broker)}
              name={brokerDisplay}
              compact
            />
          )}
        </div>

        {/* Qty / avg / LTP row */}
        <div
          style={{
            display: "flex",
            gap: 10,
            fontFamily: '"JetBrains Mono", ui-monospace, monospace',
            fontSize: 10.5,
            color: "var(--ink-3)",
            fontVariantNumeric: "tabular-nums",
            flexWrap: "wrap",
          }}
        >
          <span>
            <span style={{ color: "var(--ink-4)", fontSize: 9.5 }}>QTY </span>
            <span style={{ color: "var(--ink-2)", fontWeight: 700 }}>
              {r.quantity + (r.t1Quantity ?? 0)}
            </span>
          </span>
          <span>
            <span style={{ color: "var(--ink-4)", fontSize: 9.5 }}>AVG </span>
            <span style={{ color: "var(--ink-2)" }}>
              ₹{r.averagePrice.toFixed(2)}
            </span>
          </span>
          <span>
            <span style={{ color: "var(--ink-4)", fontSize: 9.5 }}>LTP </span>
            <span style={{ color: "var(--ink)", fontWeight: 700 }}>
              ₹{r.currentPrice.toFixed(2)}
            </span>
          </span>
        </div>
      </div>

      {/* Right column — P/L + value */}
      <div
        style={{
          textAlign: "right",
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
          fontVariantNumeric: "tabular-nums",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            color: pos ? "var(--emerald)" : "var(--pop-1)",
            fontWeight: 800,
            fontSize: 14,
          }}
        >
          {fmtINRSigned(Math.round(r.unrealizedPnL))}
        </div>
        <div
          style={{
            color: pos ? "var(--emerald)" : "var(--pop-1)",
            fontSize: 11,
            fontWeight: 700,
            marginTop: 2,
          }}
        >
          {pos ? "▲" : "▼"} {Math.abs(r.pnlPercentage).toFixed(2)}%
        </div>
        <div
          style={{
            color: "var(--ink-3)",
            fontSize: 10,
            marginTop: 6,
          }}
        >
          <span style={{ fontSize: 9, color: "var(--ink-4)" }}>INVESTED </span>
          {fmtINR(Math.round(r.investedValue))}
        </div>
        <div
          style={{
            color: "var(--ink-2)",
            fontSize: 10.5,
            marginTop: 2,
            fontWeight: 600,
          }}
        >
          <span style={{ fontSize: 9, color: "var(--ink-4)" }}>CURRENT </span>
          {fmtINR(Math.round(r.currentValue))}
        </div>
      </div>
    </div>
  );
}

/* =====================================================================
   FUNDS TAB
   ===================================================================== */
function FundsTab({
  funds,
  allFundsCount,
  amcSlices,
  catSlices,
  allCategories,
  allAMCs,
  fundCategory,
  setFundCategory,
  fundAMC,
  setFundAMC,
  fundBroker,
  setFundBroker,
  brokerConnections,
  syncedAt,
  refreshing,
  onRefresh,
  onAddManual,
}: {
  funds: MutualFund[];
  allFundsCount: number;
  amcSlices: DonutSlice[];
  catSlices: DonutSlice[];
  allCategories: string[];
  allAMCs: string[];
  fundCategory: string;
  setFundCategory: (v: string) => void;
  fundAMC: string;
  setFundAMC: (v: string) => void;
  /** #115 — broker filter; MutualFund rows carry a broker field so this is valid. */
  fundBroker: string;
  setFundBroker: (v: string) => void;
  brokerConnections: BrokerConnection[];
  syncedAt: string;
  refreshing: boolean;
  onRefresh: () => void;
  onAddManual: () => void;
}) {
  const totals = funds.reduce(
    (s, r) => ({
      inv: s.inv + r.investedAmount,
      cur: s.cur + r.currentValue,
      pl: s.pl + (r.unrealizedGain || r.currentValue - r.investedAmount),
    }),
    { inv: 0, cur: 0, pl: 0 }
  );
  const totalPct = totals.inv > 0 ? (totals.pl / totals.inv) * 100 : 0;

  if (allFundsCount === 0) {
    return (
      <EmptyState
        icon={PieChartEmpty}
        title="No mutual funds yet."
        description="Connect a broker to sync your MF holdings, or add a scheme manually."
        color="var(--pop-3)"
        action={{ label: "Connect broker →", href: "/brokers" }}
        secondaryAction={{ label: "Add manually", onClick: onAddManual }}
      />
    );
  }

  return (
    <>
      <div
        className="um-holdings-viz"
        data-walkthrough="holdings-funds-viz"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          marginBottom: 14,
        }}
      >
        <div className="pf-card flat" style={{ padding: 14 }}>
          <div
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              color: "var(--ink-3)",
              marginBottom: 10,
              textTransform: "uppercase",
            }}
          >
            By AMC
          </div>
          {amcSlices.length > 0 ? (
            <SplitDonut slices={amcSlices} label="AMCs" />
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
              No funds yet.
            </div>
          )}
        </div>
        <div className="pf-card flat" style={{ padding: 14 }}>
          <div
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              color: "var(--ink-3)",
              marginBottom: 10,
              textTransform: "uppercase",
            }}
          >
            By category
          </div>
          {catSlices.length > 0 ? (
            <SplitDonut slices={catSlices} label="CATEGORY" />
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>—</div>
          )}
        </div>
      </div>

      <div
        data-walkthrough="holdings-funds-filters"
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 14,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span
          className="um-section-label"
          style={{ color: "var(--text-secondary)" }}
        >
          Mutual fund holdings
        </span>
        <span
          style={{
            fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          · {funds.length}/{allFundsCount} schemes
        </span>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {/* #115 — Broker filter for MF tab. MutualFund rows carry a
              broker/brokerUserId field (synced from broker APIs) so the
              filter is meaningful. AMC-only brokers (Zerodha) will show
              holdings; others show nothing until their API supports MFs. */}
          <Dropdown
            compact
            width={160}
            value={fundBroker}
            onChange={setFundBroker}
            options={[
              { value: "all", label: "All brokers" },
              ...brokerConnections.map((c) => ({
                value: `${c.broker}:${c.brokerUserId || ""}`,
                label: c.accountName || c.broker,
              })),
              { value: "manual", label: "Manual" },
            ]}
          />
          <Dropdown
            compact
            width={150}
            value={fundCategory}
            onChange={setFundCategory}
            options={[
              { value: "all", label: "All categories" },
              ...allCategories.map((c) => ({ value: c, label: c })),
            ]}
          />
          <Dropdown
            compact
            width={130}
            value={fundAMC}
            onChange={setFundAMC}
            options={[
              { value: "all", label: "All AMCs" },
              ...allAMCs.map((a) => ({ value: a, label: a })),
            ]}
          />
          <RefreshChip
            syncedAt={syncedAt}
            isLoading={refreshing}
            onClick={onRefresh}
          />
        </div>
      </div>

      <div
        // um-hide-lt-1100, NOT um-hide-mobile: the mobile cards show at
        // <=1100px (um-mobile-only's boundary — the app's chrome breakpoint),
        // but um-hide-mobile only hides at <=720px, so between 721 and 1100px
        // BOTH the table and the cards rendered (MONEY-1171). One breakpoint,
        // two complementary halves.
        className="pf-card um-hide-lt-1100"
        style={{ padding: 0, overflow: "hidden" }}
      >
        <div style={{ overflowX: "auto" }}>
          <table className="pf-tbl" data-walkthrough="holdings-funds-table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>SCHEME</th>
                <th style={{ textAlign: "right" }}>UNITS</th>
                <th style={{ textAlign: "right" }}>AVG NAV</th>
                <th style={{ textAlign: "right" }}>NAV</th>
                <th style={{ textAlign: "right" }}>INVESTED</th>
                <th style={{ textAlign: "right" }}>CURRENT</th>
                <th style={{ textAlign: "right" }}>P/L</th>
                <th style={{ textAlign: "right" }}>%</th>
                <th style={{ width: 1 }}></th>
              </tr>
            </thead>
            <tbody>
              {funds.length === 0 && (
                <tr>
                  <td colSpan={9} style={emptyCellStyle}>
                    No schemes match these filters.
                  </td>
                </tr>
              )}
              {funds.map((r) => {
                const pl =
                  r.unrealizedGain || r.currentValue - r.investedAmount;
                const pct =
                  r.investedAmount > 0 ? (pl / r.investedAmount) * 100 : 0;
                const pos = pl >= 0;
                const detailHref = r.schemeCode
                  ? instrumentDetailHref({
                      symbol: r.schemeCode,
                      instrumentType: "MF",
                    })
                  : null;
                return (
                  <tr key={r.id}>
                    <td>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          marginBottom: 2,
                        }}
                      >
                        {detailHref ? (
                          <Link
                            href={detailHref}
                            className="tk hover:underline"
                            style={{ fontFamily: "Inter, sans-serif" }}
                          >
                            {r.schemeName}
                          </Link>
                        ) : (
                          <span
                            className="tk"
                            style={{ fontFamily: "Inter, sans-serif" }}
                          >
                            {r.schemeName}
                          </span>
                        )}
                        {r.sipActive && (
                          <span
                            className="pf-pill emerald"
                            style={{ fontSize: 9.5 }}
                          >
                            SIP
                          </span>
                        )}
                      </div>
                      <div className="nm">
                        {deriveAMC(r.schemeName)} · {r.category || "-"}
                        {r.folioNumber ? ` · folio ${r.folioNumber}` : ""}
                      </div>
                    </td>
                    <td
                      className="num"
                      style={{ color: "var(--ink-2)", textAlign: "right" }}
                    >
                      {r.units.toFixed(3)}
                    </td>
                    <td
                      className="num"
                      style={{ color: "var(--ink-3)", textAlign: "right" }}
                    >
                      ₹{r.averageNav.toFixed(2)}
                    </td>
                    <td
                      className="num"
                      style={{
                        color: "var(--ink)",
                        fontWeight: 700,
                        textAlign: "right",
                      }}
                    >
                      ₹{r.currentNav.toFixed(2)}
                    </td>
                    <td
                      className="num"
                      style={{ color: "var(--ink-3)", textAlign: "right" }}
                    >
                      {fmtINR(Math.round(r.investedAmount))}
                    </td>
                    <td
                      className="num"
                      style={{ color: "var(--ink-2)", textAlign: "right" }}
                    >
                      {fmtINR(Math.round(r.currentValue))}
                    </td>
                    <td
                      className={`num ${pos ? "pos" : "neg"}`}
                      style={{ fontWeight: 700, textAlign: "right" }}
                    >
                      {fmtINRSigned(Math.round(pl))}
                    </td>
                    <td
                      className={`num ${pos ? "pos" : "neg"}`}
                      style={{ fontWeight: 700, textAlign: "right" }}
                    >
                      {pos ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
                    </td>
                    <td style={{ width: 1, whiteSpace: "nowrap" }}>
                      {r.schemeCode && (
                        <HoldingRowActions
                          symbol={r.schemeCode}
                          exchange=""
                          kind="MF"
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {funds.length > 0 && (
              <tfoot>
                <tr style={{ background: "var(--emerald-bg)" }}>
                  <td colSpan={4} style={{ ...pfTfootLabel, paddingLeft: 18 }}>
                    TOTAL · {funds.length} SCHEMES
                  </td>
                  <td className="num" style={pfTfootCell}>
                    {fmtINR(Math.round(totals.inv))}
                  </td>
                  <td className="num" style={pfTfootCell}>
                    {fmtINR(Math.round(totals.cur))}
                  </td>
                  <td
                    className="num"
                    style={{
                      ...pfTfootCell,
                      color: totals.pl >= 0 ? "var(--emerald)" : "var(--pop-1)",
                    }}
                  >
                    {fmtINRSigned(Math.round(totals.pl))}
                  </td>
                  <td
                    className="num"
                    style={{
                      ...pfTfootCell,
                      color: totals.pl >= 0 ? "var(--emerald)" : "var(--pop-1)",
                    }}
                  >
                    {(totalPct >= 0 ? "+" : "") + totalPct.toFixed(2)}%
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Mobile cards — playful pf-card treatment */}
      <div
        className="um-mobile-only pf-card"
        // flexDirection matters: `.um-mobile-only` forces `display: flex
        // !important` (it was written for the bottom tab bar, where ROW is
        // right). Without an explicit column direction every holding card
        // becomes a flex-row item — cards flow sideways, crush to
        // min-content and their values overlap the next card's symbol
        // (MONEY-1171). The inline display:"none" is the desktop state; the
        // !important flips it on mobile.
        style={{
          padding: 0,
          overflow: "hidden",
          display: "none",
          flexDirection: "column",
        }}
      >
        {funds.length === 0 && (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--ink-3)",
              fontSize: 13,
            }}
          >
            No mutual funds match these filters.
          </div>
        )}
        {funds.map((r) => {
          const pl = r.unrealizedGain || r.currentValue - r.investedAmount;
          const pct = r.investedAmount > 0 ? (pl / r.investedAmount) * 100 : 0;
          const pos = pl >= 0;
          const detailHref = r.schemeCode
            ? instrumentDetailHref({
                symbol: r.schemeCode,
                instrumentType: "MF",
              })
            : null;
          const brokerSlug = toBrokerSlug(r.broker);
          return (
            <div
              key={r.id}
              style={{
                padding: "14px 16px",
                borderBottom: "1.5px solid var(--rule)",
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 12,
                alignItems: "start",
              }}
            >
              {/* Left */}
              <div style={{ minWidth: 0 }}>
                {/* Scheme name */}
                <div style={{ marginBottom: 6 }}>
                  {detailHref ? (
                    <Link
                      href={detailHref}
                      style={{
                        fontWeight: 700,
                        fontSize: 13,
                        color: "var(--ink)",
                        textDecoration: "none",
                        lineHeight: 1.3,
                        display: "block",
                      }}
                      className="hover:underline"
                    >
                      {r.schemeName}
                    </Link>
                  ) : (
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: 13,
                        color: "var(--ink)",
                        lineHeight: 1.3,
                        display: "block",
                      }}
                    >
                      {r.schemeName}
                    </span>
                  )}
                </div>

                {/* Broker chip */}
                {r.broker && r.broker !== "MANUAL" ? (
                  <div style={{ marginBottom: 8 }}>
                    <BrokerChip
                      slug={brokerSlug}
                      name={r.brokerName ?? r.broker}
                      compact
                    />
                  </div>
                ) : null}

                {/* AMC · category · units */}
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                    fontSize: 10.5,
                    color: "var(--ink-3)",
                    fontVariantNumeric: "tabular-nums",
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <span>{deriveAMC(r.schemeName)}</span>
                  <span style={{ color: "var(--rule)" }}>·</span>
                  <span>{r.category || "-"}</span>
                  <span style={{ color: "var(--rule)" }}>·</span>
                  <span>
                    <span style={{ color: "var(--ink-4)", fontSize: 9.5 }}>
                      UNITS{" "}
                    </span>
                    <span style={{ color: "var(--ink-2)", fontWeight: 700 }}>
                      {r.units.toFixed(3)}
                    </span>
                  </span>
                  {r.sipActive && (
                    <span
                      className="pf-pill emerald"
                      style={{ fontSize: 9, padding: "1px 5px" }}
                    >
                      SIP
                    </span>
                  )}
                </div>
              </div>

              {/* Right — P/L + amounts */}
              <div
                style={{
                  textAlign: "right",
                  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                  fontVariantNumeric: "tabular-nums",
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    color: pos ? "var(--emerald)" : "var(--pop-1)",
                    fontWeight: 800,
                    fontSize: 14,
                  }}
                >
                  {fmtINRSigned(Math.round(pl))}
                </div>
                <div
                  style={{
                    color: pos ? "var(--emerald)" : "var(--pop-1)",
                    fontSize: 11,
                    fontWeight: 700,
                    marginTop: 2,
                  }}
                >
                  {pos ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
                </div>
                <div
                  style={{
                    color: "var(--ink-3)",
                    fontSize: 10,
                    marginTop: 6,
                  }}
                >
                  <span style={{ fontSize: 9, color: "var(--ink-4)" }}>
                    INV{" "}
                  </span>
                  {fmtINR(Math.round(r.investedAmount))}
                </div>
                <div
                  style={{
                    color: "var(--ink-2)",
                    fontSize: 10.5,
                    marginTop: 2,
                    fontWeight: 600,
                  }}
                >
                  <span style={{ fontSize: 9, color: "var(--ink-4)" }}>
                    CUR{" "}
                  </span>
                  {fmtINR(Math.round(r.currentValue))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* =====================================================================
   POSITIONS TAB
   ===================================================================== */
function PositionsTab({
  positions,
  allPosCount,
  intradayCount,
  foCount,
  posTotalPL,
  posExposure,
  posFilter,
  setPosFilter,
  posBroker,
  setPosBroker,
  brokerConnections,
  segSlices,
  sideSlices,
  getBrokerDisplayName,
  brokerStatus,
  syncedAt,
  refreshing,
  onRefresh,
  onAddManual,
}: {
  positions: Position[];
  allPosCount: number;
  intradayCount: number;
  foCount: number;
  posTotalPL: number;
  posExposure: number;
  posFilter: "all" | "intraday" | "fo";
  setPosFilter: (v: "all" | "intraday" | "fo") => void;
  posBroker: string;
  setPosBroker: (v: string) => void;
  brokerConnections: BrokerConnection[];
  segSlices: DonutSlice[];
  sideSlices: DonutSlice[];
  getBrokerDisplayName: (b?: string | null, u?: string | null) => string;
  /** #116a — broker session status to drive the correct empty-state CTA. */
  brokerStatus: BrokerStatus;
  syncedAt: string;
  refreshing: boolean;
  onRefresh: () => void;
  onAddManual: () => void;
}) {
  if (allPosCount === 0) {
    /*
     * #116a — Context-aware empty-state CTA:
     *   • needs_reauth → broker IS connected but token expired → offer re-auth
     *   • active        → broker synced & genuinely no positions → drop the
     *                     connect CTA (a broker is already connected)
     *   • none          → no broker at all → show "Connect broker →"
     */
    const emptyAction =
      brokerStatus.status === "needs_reauth" && brokerStatus.reauthUrl
        ? {
            label: `Re-authorise ${brokerStatus.brokerDisplayName ?? "broker"} →`,
            href: brokerStatus.reauthUrl,
          }
        : brokerStatus.status === "active"
          ? undefined // no connect CTA — broker is already live
          : { label: "Connect broker →", href: "/brokers" };

    return (
      <EmptyState
        icon={Activity}
        title="No open positions."
        description={
          brokerStatus.status === "needs_reauth" ? (
            <>
              Re-authorise your broker so open positions can sync. This tab
              shows only <strong>open intraday (MIS)</strong> &amp;{" "}
              <strong>F&amp;O</strong> positions while they&apos;re live — your
              delivery stocks live under the <strong>Stocks</strong> tab.
            </>
          ) : brokerStatus.status === "active" ? (
            <>
              You hold no <strong>open intraday (MIS)</strong> or{" "}
              <strong>F&amp;O</strong> positions right now — a clean slate, not
              a sync error. These show up only while a position is open and
              disappear once it&apos;s squared off or settles to delivery. Your
              delivery stocks live under the <strong>Stocks</strong> tab.
            </>
          ) : (
            <>
              Your <strong>open intraday (MIS)</strong> &amp;{" "}
              <strong>F&amp;O</strong> positions appear here once your broker
              syncs — and only while they&apos;re open. Delivery stocks live
              under the <strong>Stocks</strong> tab.
            </>
          )
        }
        color="var(--pop-5)"
        action={emptyAction}
        secondaryAction={{ label: "Add manually", onClick: onAddManual }}
      />
    );
  }

  return (
    <>
      <div
        className="um-holdings-viz"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 12,
          marginBottom: 14,
        }}
      >
        <div className="pf-card flat" style={{ padding: 14 }}>
          <div
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              color: "var(--ink-3)",
              marginBottom: 10,
              textTransform: "uppercase",
            }}
          >
            Segment exposure
          </div>
          {segSlices.length > 0 ? (
            <SplitDonut slices={segSlices} label="SEGMENT" />
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
              No open positions.
            </div>
          )}
        </div>
        <div className="pf-card flat" style={{ padding: 14 }}>
          <div
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              color: "var(--ink-3)",
              marginBottom: 10,
              textTransform: "uppercase",
            }}
          >
            Long vs short
          </div>
          {sideSlices.length > 0 ? (
            <SplitDonut slices={sideSlices} label="SIDE" />
          ) : (
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>—</div>
          )}
        </div>
      </div>

      {/* Live MTM banner */}
      <div
        style={{
          padding: "10px 14px",
          borderRadius: 10,
          background: "rgba(74,222,128,.06)",
          border: "1px solid rgba(74,222,128,.18)",
          marginBottom: 14,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1,
            color: "var(--semantic-positive-text)",
          }}
        >
          <span className="um-pulse-dot" /> LIVE MTM
        </span>
        <span
          style={{
            fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
            fontSize: 12,
            color: "var(--text-secondary)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          Today&apos;s MTM{" "}
          <span
            style={{
              color:
                posTotalPL >= 0
                  ? "var(--semantic-positive-text)"
                  : "var(--semantic-negative-text)",
              fontWeight: 700,
              marginLeft: 4,
            }}
          >
            {fmtINRSigned(Math.round(posTotalPL))}
          </span>
          <span style={{ color: "var(--text-muted)" }}>
            {" "}
            · exposure {fmtLakhs(posExposure)}
          </span>
        </span>
        {/* MONEY-837: removed "Square off all" — read-only OAuth, never places
            orders. MONEY-839: the Sync chip moved to the filter row below so it
            sits in the SAME place as the Stocks & Funds tabs. */}
      </div>

      {/* Filters */}
      <div
        data-walkthrough="holdings-positions-filter"
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 14,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {(
          [
            { id: "all", lbl: `All · ${allPosCount}` },
            { id: "intraday", lbl: `Intraday · ${intradayCount}` },
            { id: "fo", lbl: `F&O · ${foCount}` },
          ] as const
        ).map((t) => {
          const a = posFilter === t.id;
          return (
            <button
              type="button"
              key={t.id}
              onClick={() => setPosFilter(t.id)}
              style={{
                padding: "6px 12px",
                borderRadius: 9999,
                background: a
                  ? "rgba(52,211,153,.14)"
                  : "rgba(255,255,255,.025)",
                border: "1px solid",
                borderColor: a
                  ? "rgba(52,211,153,.3)"
                  : "var(--border-default)",
                color: a ? "#34d399" : "var(--text-secondary)",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t.lbl}
            </button>
          );
        })}
        {/* MONEY-837: broker filter (the positions tab was missing it).
            brokerConnections is pre-filtered upstream, so ZERODHA_CONNECT
            never appears here. */}
        <Dropdown
          compact
          width={170}
          value={posBroker}
          onChange={setPosBroker}
          options={[
            { value: "all", label: "All brokers" },
            ...brokerConnections.map((c) => ({
              value: `${c.broker}:${c.brokerUserId || ""}`,
              label: c.accountName || c.broker,
            })),
            { value: "manual", label: "Manual" },
          ]}
        />
        {/* MONEY-839: Sync chip lives in the filter row — same placement as the
            Stocks & Funds tabs (previously it was only inside the MTM banner,
            so a tab with no live MTM appeared to have no Sync button). */}
        <RefreshChip
          syncedAt={syncedAt}
          isLoading={refreshing}
          onClick={onRefresh}
        />
      </div>

      <div
        // um-hide-lt-1100, NOT um-hide-mobile: the mobile cards show at
        // <=1100px (um-mobile-only's boundary — the app's chrome breakpoint),
        // but um-hide-mobile only hides at <=720px, so between 721 and 1100px
        // BOTH the table and the cards rendered (MONEY-1171). One breakpoint,
        // two complementary halves.
        className="pf-card um-hide-lt-1100"
        style={{ padding: 0, overflow: "hidden" }}
      >
        <div style={{ overflowX: "auto" }}>
          <table className="pf-tbl" data-walkthrough="holdings-positions-table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 18 }}>SYMBOL</th>
                <th>SIDE</th>
                <th>BROKER</th>
                <th>PROD</th>
                <th style={{ textAlign: "right" }}>QTY</th>
                <th style={{ textAlign: "right" }}>AVG</th>
                <th style={{ textAlign: "right" }}>LTP</th>
                <th style={{ textAlign: "right" }}>MTM</th>
                <th style={{ textAlign: "right" }}>%</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 && (
                <tr>
                  <td colSpan={10} style={emptyCellStyle}>
                    No open positions match filters.
                  </td>
                </tr>
              )}
              {positions.map((p) => {
                const cost = p.entryPrice * Math.abs(p.quantity);
                const pct = cost > 0 ? (p.unrealizedPnL / cost) * 100 : 0;
                const pos = p.unrealizedPnL >= 0;
                const isShort = p.positionType === "SHORT";
                const isFO = p.segment === "NSE-FO" || p.segment === "FO";
                return (
                  <tr key={p.id}>
                    <td>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            fontFamily:
                              "var(--font-jetbrains), ui-monospace, monospace",
                            fontWeight: 700,
                            color: "var(--ink)",
                            fontSize: 13,
                          }}
                        >
                          {p.symbol}
                        </span>
                        <Pill tone={isFO ? "vio" : "mute"} size="sm">
                          {p.segmentLabel || p.segment}
                        </Pill>
                      </div>
                    </td>
                    <td>
                      <Pill tone={isShort ? "neg" : "pos"} size="sm">
                        {isShort ? "SHORT" : "LONG"}
                      </Pill>
                    </td>
                    <td>
                      {p.broker ? (
                        <BrokerChip
                          slug={toBrokerSlug(p.broker)}
                          name={getBrokerDisplayName(p.broker, p.brokerUserId)}
                          compact
                        />
                      ) : (
                        <span
                          style={{ color: "var(--text-muted)", fontSize: 11 }}
                        >
                          Manual
                        </span>
                      )}
                    </td>
                    <td>
                      <span
                        style={{
                          fontFamily:
                            "var(--font-jetbrains), ui-monospace, monospace",
                          fontSize: 10.5,
                          fontWeight: 700,
                          color:
                            p.productType === "MIS"
                              ? "#fbbf24"
                              : "var(--text-secondary)",
                          padding: "1px 6px",
                          background: "rgba(255,255,255,.04)",
                          borderRadius: 4,
                        }}
                      >
                        {p.productType}
                      </span>
                    </td>
                    <td
                      className="num"
                      style={{ color: "var(--ink-2)", textAlign: "right" }}
                    >
                      {p.quantity}
                    </td>
                    <td
                      className="num"
                      style={{ color: "var(--ink-3)", textAlign: "right" }}
                    >
                      ₹{p.entryPrice.toFixed(2)}
                    </td>
                    <td
                      className="num"
                      style={{
                        color: "var(--ink)",
                        fontWeight: 700,
                        textAlign: "right",
                      }}
                    >
                      ₹{p.currentPrice.toFixed(2)}
                    </td>
                    <td
                      className={`num ${pos ? "pos" : "neg"}`}
                      style={{ fontWeight: 700, textAlign: "right" }}
                    >
                      {fmtINRSigned(Math.round(p.unrealizedPnL))}
                    </td>
                    <td
                      className={`num ${pos ? "pos" : "neg"}`}
                      style={{ fontWeight: 700, textAlign: "right" }}
                    >
                      {pos ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
                    </td>
                    <td style={{ textAlign: "right", paddingRight: 12 }}>
                      {/* MONEY-837: read-only — no EXIT/square-off. Analyse links
                          to the equity research page; disabled for F&O contracts. */}
                      {isFO ? (
                        <button
                          type="button"
                          disabled
                          className="pf-bf sm"
                          style={{ opacity: 0.45, cursor: "not-allowed" }}
                          title="Analysis isn't available for F&O contracts"
                        >
                          Analyse
                        </button>
                      ) : (
                        <Link
                          href={instrumentDetailHref({ symbol: p.symbol })}
                          className="pf-bf sm"
                        >
                          Analyse
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile cards — playful pf-card treatment */}
      <div
        className="um-mobile-only pf-card"
        // flexDirection matters: `.um-mobile-only` forces `display: flex
        // !important` (it was written for the bottom tab bar, where ROW is
        // right). Without an explicit column direction every holding card
        // becomes a flex-row item — cards flow sideways, crush to
        // min-content and their values overlap the next card's symbol
        // (MONEY-1171). The inline display:"none" is the desktop state; the
        // !important flips it on mobile.
        style={{
          padding: 0,
          overflow: "hidden",
          display: "none",
          flexDirection: "column",
        }}
      >
        {positions.length === 0 && (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--ink-3)",
              fontSize: 13,
            }}
          >
            No open positions match filters.
          </div>
        )}
        {positions.map((p) => {
          const cost = p.entryPrice * Math.abs(p.quantity);
          const pct = cost > 0 ? (p.unrealizedPnL / cost) * 100 : 0;
          const pos = p.unrealizedPnL >= 0;
          const isShort = p.positionType === "SHORT";
          const isFO = p.segment === "NSE-FO" || p.segment === "FO";
          const brokerSlug = p.broker ? toBrokerSlug(p.broker) : null;
          return (
            <div
              key={p.id}
              style={{
                padding: "14px 16px",
                borderBottom: "1.5px solid var(--rule)",
              }}
            >
              {/* Top row: symbol + pills + product type badge */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 8,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                    fontWeight: 800,
                    color: "var(--ink)",
                    fontSize: 14,
                    letterSpacing: 0.2,
                  }}
                >
                  {p.symbol}
                </span>
                <Pill tone={isFO ? "vio" : "mute"} size="sm">
                  {p.segmentLabel || p.segment}
                </Pill>
                <Pill tone={isShort ? "neg" : "pos"} size="sm">
                  {isShort ? "SHORT" : "LONG"}
                </Pill>
                <span
                  style={{
                    marginLeft: "auto",
                    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                    fontSize: 9.5,
                    fontWeight: 800,
                    color:
                      p.productType === "MIS" ? "var(--pop-3)" : "var(--ink-3)",
                    padding: "2px 6px",
                    background: "var(--rule-softer)",
                    border: "1px solid var(--rule)",
                    borderRadius: 4,
                    letterSpacing: 0.5,
                  }}
                >
                  {p.productType}
                </span>
              </div>

              {/* Broker chip */}
              {brokerSlug && (
                <div style={{ marginBottom: 8 }}>
                  <BrokerChip
                    slug={brokerSlug}
                    name={getBrokerDisplayName(p.broker, p.brokerUserId)}
                    compact
                  />
                </div>
              )}

              {/* Qty / avg / LTP + P/L row */}
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "space-between",
                  gap: 10,
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                    fontSize: 10.5,
                    color: "var(--ink-3)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <div>
                    <span style={{ color: "var(--ink-4)", fontSize: 9.5 }}>
                      QTY{" "}
                    </span>
                    <span style={{ color: "var(--ink-2)", fontWeight: 700 }}>
                      {p.quantity}
                    </span>
                    <span
                      style={{
                        color: "var(--ink-4)",
                        marginLeft: 8,
                        fontSize: 9.5,
                      }}
                    >
                      AVG{" "}
                    </span>
                    <span style={{ color: "var(--ink-2)" }}>
                      ₹{p.entryPrice.toFixed(2)}
                    </span>
                  </div>
                  <div style={{ marginTop: 3 }}>
                    <span style={{ color: "var(--ink-4)", fontSize: 9.5 }}>
                      LTP{" "}
                    </span>
                    <span style={{ color: "var(--ink)", fontWeight: 700 }}>
                      ₹{p.currentPrice.toFixed(2)}
                    </span>
                  </div>
                </div>
                <div
                  style={{
                    textAlign: "right",
                    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <div
                    style={{
                      color: pos ? "var(--emerald)" : "var(--pop-1)",
                      fontWeight: 800,
                      fontSize: 14,
                    }}
                  >
                    {fmtINRSigned(Math.round(p.unrealizedPnL))}
                  </div>
                  <div
                    style={{
                      color: pos ? "var(--emerald)" : "var(--pop-1)",
                      fontSize: 11,
                      fontWeight: 700,
                      marginTop: 2,
                    }}
                  >
                    {pos ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
                  </div>
                </div>
              </div>

              {/* MONEY-837: read-only — Analyse instead of EXIT (disabled for F&O). */}
              {isFO ? (
                <button
                  type="button"
                  disabled
                  className="pf-bf sm"
                  style={{
                    width: "100%",
                    opacity: 0.45,
                    cursor: "not-allowed",
                  }}
                  title="Analysis isn't available for F&O contracts"
                >
                  Analyse
                </button>
              ) : (
                <Link
                  href={instrumentDetailHref({ symbol: p.symbol })}
                  className="pf-bf sm"
                  style={{
                    width: "100%",
                    display: "block",
                    textAlign: "center",
                  }}
                >
                  Analyse
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* =====================================================================
   Local style helpers - kept inline because they're used only by this page
   ===================================================================== */

const emptyCellStyle = {
  padding: 32,
  textAlign: "center",
  color: "var(--ink-3)",
  fontSize: 13,
} satisfies React.CSSProperties;

/* pf-tbl tfoot styles */
const pfTfootLabel = {
  padding: "11px 14px",
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
  fontSize: 10.5,
  letterSpacing: 1.4,
  color: "var(--ink-3)",
  fontWeight: 700,
  textTransform: "uppercase",
} satisfies React.CSSProperties;

const pfTfootCell = {
  padding: "11px 14px",
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
  fontVariantNumeric: "tabular-nums",
  fontWeight: 700,
  color: "var(--ink-2)",
  textAlign: "right",
} satisfies React.CSSProperties;
