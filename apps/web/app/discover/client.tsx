"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { useIDBCache } from "@/hooks/useIDBCache";
import Sidebar from "@/components/Sidebar";
import { DemoBanner } from "@/components/DemoBanner";

import { PaginationControls } from "@/components/PaginationControls";
import { Input } from "@usemoney/ui/input";
import { Button } from "@usemoney/ui/button";
import { Card, CardContent, CardFooter } from "@usemoney/ui/card";
import { Skeleton } from "@usemoney/ui/skeleton";
import { Badge } from "@usemoney/ui/badge";
import { Tabs, TabsContent } from "@usemoney/ui/tabs";
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
import {
  Search,
  ArrowUpRight,
  ArrowDownRight,
  Brain,
  Briefcase,
  BarChart2,
  Loader2,
  RefreshCw,
  Eye,
  Check,
  Plus,
  LineChart,
  Activity,
  X,
  ChevronDown,
} from "lucide-react";
import { formatCurrency } from "@usemoney/utils";
import Link from "next/link";
import { instrumentDetailHref } from "@/lib/fund/instrument-href";
import { PageGuard } from "@/components/PageGuard";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import ResearchModal, {
  type ResearchEntity,
} from "@/components/analysis/ResearchModal";
import { startResearchAction } from "@/lib/actions/research";
import { buildCompareUrl } from "@/lib/compare/schema";

import { DiscoverSkeleton } from "@/components/skeletons";
import {
  getDiscoverDataAction,
  type DiscoverStock,
  type DiscoverData,
} from "@/lib/actions/discover";
import {
  getWatchlistsAction,
  addWatchlistItemAction,
  removeWatchlistItemAction,
  createWatchlistAction,
  type WatchlistData,
} from "@/lib/actions/watchlist";
import {
  getMfDiscoverDataAction,
  type DiscoverMutualFund,
  type MfDiscoverData,
} from "@/lib/actions/discover-mf";
import {
  getIndicesAction,
  getETFsAction,
  type IndexData,
  type ETFData,
} from "@/lib/actions/discover-indices";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import { Checkbox } from "@usemoney/ui/checkbox";
import { Popover, PopoverTrigger, PopoverContent } from "@usemoney/ui/popover";
import { withTimeout } from "@/lib/utils/with-timeout";
import { formatMarketCap, formatVolume } from "./discover-format";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@usemoney/ui/command";

// ============== MOCK DATA (Fallback when DB is empty) ==============

const MOCK_GAINERS: DiscoverStock[] = [
  {
    symbol: "ADANIENT",
    name: "Adani Enterprises",
    exchange: "NSE",
    sector: "Conglomerate",
    instrumentType: "EQUITY",
    instrumentId: "",
    yahooSymbol: "ADANIENT.NS",
    // Demo rows carry no ISIN — they dedupe by symbol, which is correct for
    // mock data (MONEY-1198).
    isin: null,
    price: 2456.75,
    change: 89.5,
    changePercent: 3.78,
    volume: 12500000,
    marketCap: 2800000000000,
  },
  {
    symbol: "TATAPOWER",
    name: "Tata Power",
    exchange: "NSE",
    sector: "Power",
    instrumentType: "EQUITY",
    instrumentId: "",
    yahooSymbol: "TATAPOWER.NS",
    isin: null,
    price: 389.2,
    change: 12.4,
    changePercent: 3.29,
    volume: 8200000,
    marketCap: 1200000000000,
  },
  {
    symbol: "ITC",
    name: "ITC Limited",
    exchange: "NSE",
    sector: "FMCG",
    instrumentType: "EQUITY",
    instrumentId: "",
    yahooSymbol: "ITC.NS",
    isin: null,
    price: 456.8,
    change: 11.2,
    changePercent: 2.51,
    volume: 6800000,
    marketCap: 5700000000000,
  },
];

const MOCK_LOSERS: DiscoverStock[] = [
  {
    symbol: "WIPRO",
    name: "Wipro Ltd",
    exchange: "NSE",
    sector: "IT",
    instrumentType: "EQUITY",
    instrumentId: "",
    yahooSymbol: "WIPRO.NS",
    isin: null,
    price: 412.3,
    change: -18.7,
    changePercent: -4.34,
    volume: 5200000,
    marketCap: 2100000000000,
  },
  {
    symbol: "HCLTECH",
    name: "HCL Technologies",
    exchange: "NSE",
    sector: "IT",
    instrumentType: "EQUITY",
    instrumentId: "",
    yahooSymbol: "HCLTECH.NS",
    isin: null,
    price: 1245.6,
    change: -42.3,
    changePercent: -3.29,
    volume: 3800000,
    marketCap: 3400000000000,
  },
];

const MOCK_POPULAR: DiscoverStock[] = [
  {
    symbol: "RELIANCE",
    name: "Reliance Industries",
    exchange: "NSE",
    sector: "Energy",
    instrumentType: "EQUITY",
    instrumentId: "",
    yahooSymbol: "RELIANCE.NS",
    isin: null,
    price: 2890.45,
    change: 45.2,
    changePercent: 1.59,
    volume: 15200000,
    marketCap: 19500000000000,
  },
  {
    symbol: "TCS",
    name: "Tata Consultancy",
    exchange: "NSE",
    sector: "IT",
    instrumentType: "EQUITY",
    instrumentId: "",
    yahooSymbol: "TCS.NS",
    isin: null,
    price: 3567.8,
    change: -23.4,
    changePercent: -0.65,
    volume: 4500000,
    marketCap: 12900000000000,
  },
  {
    symbol: "HDFCBANK",
    name: "HDFC Bank",
    exchange: "NSE",
    sector: "Banking",
    instrumentType: "EQUITY",
    instrumentId: "",
    yahooSymbol: "HDFCBANK.NS",
    isin: null,
    price: 1678.9,
    change: 12.3,
    changePercent: 0.74,
    volume: 8900000,
    marketCap: 12700000000000,
  },
  {
    symbol: "INFY",
    name: "Infosys",
    exchange: "NSE",
    sector: "IT",
    instrumentType: "EQUITY",
    instrumentId: "",
    yahooSymbol: "INFY.NS",
    isin: null,
    price: 1456.25,
    change: -8.75,
    changePercent: -0.6,
    volume: 6100000,
    marketCap: 6000000000000,
  },
  {
    symbol: "ICICIBANK",
    name: "ICICI Bank",
    exchange: "NSE",
    sector: "Banking",
    instrumentType: "EQUITY",
    instrumentId: "",
    yahooSymbol: "ICICIBANK.NS",
    isin: null,
    price: 1023.45,
    change: 15.8,
    changePercent: 1.57,
    volume: 7200000,
    marketCap: 7200000000000,
  },
];

const MOCK_MF_DISCOVER_DATA: MfDiscoverData = {
  allFunds: [
    {
      schemeCode: "119551",
      schemeName: "SBI Bluechip Fund - Direct Plan - Growth",
      amcName: "SBI Mutual Fund",
      category: "Equity",
      plan: "DIRECT",
      nav: 82.45,
      aum: 45000,
      returns1Y: 18.5,
      returns3Y: 15.2,
      returns5Y: 14.8,
      riskLevel: "Moderately High",
    },
    {
      schemeCode: "120505",
      schemeName: "HDFC Mid-Cap Opportunities Fund - Direct Plan - Growth",
      amcName: "HDFC Mutual Fund",
      category: "Equity",
      plan: "DIRECT",
      nav: 145.3,
      aum: 38000,
      returns1Y: 22.3,
      returns3Y: 18.7,
      returns5Y: 16.4,
      riskLevel: "High",
    },
    {
      schemeCode: "118989",
      schemeName: "ICICI Prudential Liquid Fund - Direct Plan - Growth",
      amcName: "ICICI Prudential Mutual Fund",
      category: "Debt",
      plan: "DIRECT",
      nav: 345.8,
      aum: 52000,
      returns1Y: 7.2,
      returns3Y: 6.5,
      returns5Y: 6.8,
      riskLevel: "Low",
    },
  ],
  categories: [
    { name: "Equity", count: 2 },
    { name: "Debt", count: 1 },
  ],
  amcList: [
    "SBI Mutual Fund",
    "HDFC Mutual Fund",
    "ICICI Prudential Mutual Fund",
  ],
};

const MOCK_INDICES: IndexData[] = [
  {
    symbol: "NIFTY50",
    name: "Nifty 50",
    exchange: "NSE",
    yahooSymbol: "^NSEI",
    price: 22456.8,
    change: 156.35,
    changePercent: 0.7,
  },
  {
    symbol: "SENSEX",
    name: "BSE Sensex",
    exchange: "BSE",
    yahooSymbol: "^BSESN",
    price: 73890.45,
    change: 512.3,
    changePercent: 0.7,
  },
  {
    symbol: "NIFTYBANK",
    name: "Nifty Bank",
    exchange: "NSE",
    yahooSymbol: "^NSEBANK",
    price: 48234.15,
    change: -123.45,
    changePercent: -0.26,
  },
  {
    symbol: "NIFTYIT",
    name: "Nifty IT",
    exchange: "NSE",
    yahooSymbol: "^CNXIT",
    price: 35890.25,
    change: 245.8,
    changePercent: 0.69,
  },
  {
    symbol: "NIFTYFMCG",
    name: "Nifty FMCG",
    exchange: "NSE",
    yahooSymbol: "^CNXFMCG",
    price: 56420.1,
    change: -89.35,
    changePercent: -0.16,
  },
  {
    symbol: "NIFTYPHARMA",
    name: "Nifty Pharma",
    exchange: "NSE",
    yahooSymbol: "^CNXPHARMA",
    price: 19875.6,
    change: 178.9,
    changePercent: 0.91,
  },
  {
    symbol: "NIFTY500",
    name: "Nifty 500",
    exchange: "NSE",
    yahooSymbol: "^CRSLDX",
    price: 20245.35,
    change: 98.45,
    changePercent: 0.49,
  },
  {
    symbol: "NIFTYMIDCAP",
    name: "Nifty Midcap 100",
    exchange: "NSE",
    yahooSymbol: "NIFTY_MIDCAP_100.NS",
    price: 52340.8,
    change: -234.5,
    changePercent: -0.45,
  },
];

const MOCK_ETFS: ETFData[] = [
  {
    symbol: "NIFTYBEES",
    name: "Nippon India ETF Nifty BeES",
    exchange: "NSE",
    yahooSymbol: "NIFTYBEES.NS",
    price: 225.4,
    change: 1.55,
    changePercent: 0.69,
    volume: 15200000,
    returns1Y: 12.5,
    returns3Y: 14.2,
    returns5Y: 16.8,
    aum: 25000,
  },
  {
    symbol: "BANKBEES",
    name: "Nippon India ETF Bank BeES",
    exchange: "NSE",
    yahooSymbol: "BANKBEES.NS",
    price: 482.3,
    change: -1.2,
    changePercent: -0.25,
    volume: 8500000,
    returns1Y: 8.3,
    returns3Y: 11.5,
    returns5Y: 13.1,
    aum: 12000,
  },
  {
    symbol: "GOLDBEES",
    name: "Nippon India ETF Gold BeES",
    exchange: "NSE",
    yahooSymbol: "GOLDBEES.NS",
    price: 58.9,
    change: 0.45,
    changePercent: 0.77,
    volume: 4200000,
    returns1Y: 18.2,
    returns3Y: 15.0,
    returns5Y: 12.5,
    aum: 18000,
  },
  {
    symbol: "ITBEES",
    name: "Nippon India ETF Nifty IT",
    exchange: "NSE",
    yahooSymbol: "ITBEES.NS",
    price: 358.9,
    change: 2.45,
    changePercent: 0.69,
    volume: 3200000,
    returns1Y: -2.1,
    returns3Y: 9.8,
    returns5Y: 18.3,
    aum: 5500,
  },
  {
    symbol: "JUNIORBEES",
    name: "Nippon India ETF Junior BeES",
    exchange: "NSE",
    yahooSymbol: "JUNIORBEES.NS",
    price: 682.5,
    change: -3.8,
    changePercent: -0.55,
    volume: 2100000,
    returns1Y: 15.7,
    returns3Y: 18.2,
    returns5Y: 20.1,
    aum: 8000,
  },
  {
    symbol: "SILVERBEES",
    name: "Nippon India Silver ETF",
    exchange: "NSE",
    yahooSymbol: "SILVERBEES.NS",
    price: 78.25,
    change: 1.1,
    changePercent: 1.43,
    volume: 5600000,
    returns1Y: 22.5,
    returns3Y: 10.3,
    returns5Y: null,
    aum: 3500,
  },
];

// ============== HELPERS ==============

/** Client-side fetcher timeout (seconds). Longer than SSR (6s) to allow for
 *  dev-mode compilation lag, but short enough to avoid 105s hangs. */
const CLIENT_FETCH_TIMEOUT = 15_000;

/** Extract fund house name from ETF instrument name */
function extractEtfFundHouse(name: string): string {
  // Strip leading/trailing quotes and whitespace
  const cleaned = name.replace(/^["']+|["']+$/g, "").trim();
  const n = cleaned.toUpperCase();
  const houses = [
    "NIPPON INDIA",
    "SBI",
    "HDFC",
    "ICICI PRUDENTIAL",
    "KOTAK",
    "MOTILAL OSWAL",
    "EDELWEISS",
    "ADITYA BIRLA",
    "UTI",
    "AXIS",
    "MIRAE ASSET",
    "DSP",
    "TATA",
    "INVESCO",
    "BANDHAN",
    "PGIM",
    "QUANTUM",
    "LIC",
    "CPSE",
    "BHARAT",
    "GROWW",
  ];
  for (const h of houses) {
    if (n.startsWith(h))
      return h
        .split(" ")
        .map((w) => w[0]! + w.slice(1).toLowerCase())
        .join(" ");
  }
  const idx = n.indexOf(" ETF");
  if (idx > 0) {
    const raw = cleaned.substring(0, idx).trim();
    return raw
      .split(" ")
      .map((w) => w[0]! + w.slice(1).toLowerCase())
      .join(" ");
  }
  return "Other";
}

/** Derive a basic category from ETF name keywords */
function deriveEtfCategory(name: string): string {
  const n = name.toUpperCase();
  if (n.includes("GOLD") || n.includes("SILVER")) return "Commodity";
  if (n.includes("LIQUID") || n.includes("OVERNIGHT")) return "Liquid";
  if (
    n.includes("GILT") ||
    n.includes("BOND") ||
    n.includes("DEBT") ||
    n.includes("SDL")
  )
    return "Debt";
  if (
    n.includes("NIFTY 50") ||
    n.includes("SENSEX") ||
    n.includes("NIFTY NEXT 50")
  )
    return "Large Cap";
  if (
    n.includes("MIDCAP") ||
    n.includes("MID CAP") ||
    n.includes("NIFTY MIDSMALL")
  )
    return "Mid Cap";
  if (n.includes("SMALLCAP") || n.includes("SMALL CAP")) return "Small Cap";
  if (
    n.includes("BANK") ||
    n.includes("FINANCIAL") ||
    n.includes("PRIVATE BANK") ||
    n.includes("PSU BANK")
  )
    return "Banking";
  if (n.includes("IT") && !n.includes("NIFTY")) return "Technology";
  if (n.includes("PHARMA") || n.includes("HEALTHCARE")) return "Healthcare";
  if (n.includes("INFRA")) return "Infrastructure";
  if (n.includes("CONSUMPTION") || n.includes("FMCG")) return "Consumption";
  if (n.includes("ENERGY") || n.includes("OIL") || n.includes("GAS"))
    return "Energy";
  if (n.includes("AUTO")) return "Auto";
  if (n.includes("METAL")) return "Metal";
  if (n.includes("REALTY") || n.includes("REAL ESTATE")) return "Real Estate";
  if (n.includes("NASDAQ") || n.includes("HANG SENG") || n.includes("S&P 500"))
    return "International";
  return "Other";
}

// ============== COMPONENT ==============

// ============== WATCHLIST PICKER (top-level, stable identity) ==============

function WatchlistPicker({
  symbolKey,
  symbol,
  exchange,
  instrumentId,
  filteredWatchlists,
  watchlistType,
  membership,
  isAdding,
  onAdd,
  onRemove,
  onCreate,
}: {
  symbolKey: string;
  symbol: string;
  exchange: string;
  instrumentId?: string;
  filteredWatchlists: WatchlistData[];
  watchlistType: "STOCK" | "MF";
  membership: Set<string>;
  isAdding: boolean;
  onAdd: (
    watchlistId: string,
    symbolKey: string,
    symbol: string,
    exchange: string,
    instrumentId?: string
  ) => void;
  onRemove: (
    watchlistId: string,
    symbolKey: string,
    symbol: string,
    exchange: string
  ) => void;
  onCreate: (
    name: string,
    watchlistType: "STOCK" | "MF",
    symbolKey: string,
    symbol: string,
    exchange: string,
    instrumentId?: string
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState("");
  const inCount = filteredWatchlists.filter((wl) =>
    membership.has(wl.id)
  ).length;

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    onCreate(name, watchlistType, symbolKey, symbol, exchange, instrumentId);
    setNewName("");
    setShowNewForm(false);
    // Keep popover open so user can continue editing watchlists
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setShowNewForm(false);
          setNewName("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant={inCount > 0 ? "default" : "outline"}
          size="sm"
          disabled={isAdding}
          onClick={(e) => {
            // stopPropagation prevents parent <Link> from navigating.
            // Do NOT call e.preventDefault() - Radix checks defaultPrevented
            // and skips the popover toggle if it's true.
            e.stopPropagation();
          }}
        >
          {isAdding ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : inCount > 0 ? (
            <Eye className="h-3 w-3 mr-1" />
          ) : (
            <Plus className="h-3 w-3 mr-1" />
          )}
          {inCount > 0 ? `In ${inCount}` : "Watch"}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 p-2"
        align="end"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {filteredWatchlists.length > 0 && (
          <>
            <p className="text-xs font-medium text-[var(--ink-3)] px-2 py-1 mb-1">
              {watchlistType === "MF" ? "MF" : "Stock"} watchlists
            </p>
            <div className="space-y-0.5">
              {filteredWatchlists.map((wl) => {
                const isIn = membership.has(wl.id);
                return (
                  <label
                    key={wl.id}
                    className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded text-sm transition-colors ${
                      isAdding
                        ? "opacity-50 pointer-events-none"
                        : "hover:bg-[var(--rule-softer)] cursor-pointer"
                    }`}
                  >
                    <Checkbox
                      checked={isIn}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          onAdd(
                            wl.id,
                            symbolKey,
                            symbol,
                            exchange,
                            instrumentId
                          );
                        } else {
                          onRemove(wl.id, symbolKey, symbol, exchange);
                        }
                      }}
                      className="h-4 w-4 shrink-0"
                    />
                    <span className="truncate flex-1">{wl.name}</span>
                    <span className="text-[10px] text-[var(--ink-3)] tabular-nums shrink-0">
                      {wl.itemCount}
                    </span>
                  </label>
                );
              })}
            </div>
          </>
        )}
        <div
          className={
            filteredWatchlists.length > 0 ? "border-t mt-1.5 pt-1.5" : ""
          }
        >
          {showNewForm ? (
            <div className="px-1 space-y-1.5">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={
                  watchlistType === "MF"
                    ? "MF watchlist name"
                    : "Watchlist name"
                }
                className="h-7 text-xs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                  if (e.key === "Escape") {
                    setShowNewForm(false);
                    setNewName("");
                  }
                }}
              />
              <div className="flex gap-1">
                <Button
                  size="sm"
                  className="flex-1 h-6 text-xs"
                  disabled={!newName.trim() || isAdding}
                  onClick={handleCreate}
                >
                  {isAdding ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Create & Add"
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs px-2"
                  onClick={() => {
                    setShowNewForm(false);
                    setNewName("");
                  }}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowNewForm(true)}
              disabled={isAdding}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-[var(--rule-softer)] transition-colors text-[var(--ink)] font-medium"
            >
              <Plus className="h-3.5 w-3.5" />
              New {watchlistType === "MF" ? "MF " : ""}Watchlist
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface DiscoverPageProps {
  initialDiscoverData: DiscoverData | null;
  initialMfData: MfDiscoverData | null;
  initialIndices: IndexData[];
  initialEtfs: ETFData[];
  initialWatchlists: WatchlistData[];
  sectorParam: string | null;
  tabParam: string | null;
}

export default function DiscoverPageClient({
  initialDiscoverData,
  initialMfData,
  initialIndices,
  initialEtfs,
  initialWatchlists,
  sectorParam,
  tabParam,
}: DiscoverPageProps) {
  const router = useRouter();
  const { isSignedIn, isLoaded, userId } = useAuth();
  // MONEY-1137: previously called bare, on the reasoning that "this page uses
  // useAuth not useUser, and the effect below handles post-sign-in cleanup".
  // Both halves were wrong: `useAuth` also exposes `userId`, which is the same
  // identity signal the gate needs, and the effect below only *redirects*
  // signed-out non-demo visitors — it never clears the localStorage flag. So a
  // signed-in user carrying a stale flag got `initialData: MOCK_*_DISCOVER_DATA`
  // AND `skip: true` on every real fetch below: a fully fabricated Discover
  // page. `userId` is null for signed-out demo visitors, so demo is unchanged.
  const isDemoMode = useIsDemoMode({ user: userId });
  const [activeTab, setActiveTab] = useState(
    tabParam === "mutualfunds" || tabParam === "indices" ? tabParam : "stocks"
  );

  // --- IDB-cached data fetches ---
  const {
    data: discoverData,
    isLoading,
    refresh: refreshDiscover,
  } = useIDBCache<DiscoverData>({
    module: "discover",
    identifier: "main",
    fetcher: async () => {
      try {
        const result = await withTimeout(
          getDiscoverDataAction(),
          CLIENT_FETCH_TIMEOUT
        );
        if (result?.success && result?.data) {
          const hasData =
            result?.data.topGainers.length > 0 ||
            result?.data.topLosers.length > 0 ||
            result?.data.allStocks.length > 0;
          if (hasData) return result?.data;
        }
      } catch {
        // DB error - fall through to mock data
      }
      return {
        topGainers: MOCK_GAINERS,
        topLosers: MOCK_LOSERS,
        allStocks: MOCK_POPULAR,
        sectors: [],
      };
    },
    initialData: isDemoMode
      ? {
          topGainers: MOCK_GAINERS,
          topLosers: MOCK_LOSERS,
          allStocks: MOCK_POPULAR,
          sectors: [],
        }
      : initialDiscoverData,
    skip: isDemoMode || !isSignedIn,
  });

  const { data: mfData, isLoading: isMfLoading } = useIDBCache<MfDiscoverData>({
    module: "discover-mf",
    identifier: "main",
    fetcher: async () => {
      try {
        const result = await withTimeout(
          getMfDiscoverDataAction(),
          CLIENT_FETCH_TIMEOUT
        );
        if (result?.success && result?.data) return result?.data;
      } catch {
        // DB error - fall through to mock data
      }
      return MOCK_MF_DISCOVER_DATA;
    },
    initialData: isDemoMode ? MOCK_MF_DISCOVER_DATA : initialMfData,
    skip: isDemoMode || !isSignedIn,
  });

  const { data: indices, isLoading: isIndicesLoading } = useIDBCache<
    IndexData[]
  >({
    module: "discover-indices",
    identifier: "main",
    fetcher: async () => {
      try {
        const result = await withTimeout(
          getIndicesAction(),
          CLIENT_FETCH_TIMEOUT
        );
        if (result?.success && result?.data) return result?.data;
      } catch {
        // DB error - fall through to mock data
      }
      return MOCK_INDICES;
    },
    initialData: isDemoMode
      ? MOCK_INDICES
      : initialIndices.length > 0
        ? initialIndices
        : null,
    skip: isDemoMode || !isSignedIn,
  });

  const { data: etfs } = useIDBCache<ETFData[]>({
    module: "discover-etfs",
    identifier: "main",
    fetcher: async () => {
      try {
        const result = await withTimeout(
          getETFsAction({ limit: 20 }),
          CLIENT_FETCH_TIMEOUT
        );
        if (result?.success && result?.data) return result?.data;
      } catch {
        // DB error - fall through to mock data
      }
      return MOCK_ETFS;
    },
    initialData: isDemoMode
      ? MOCK_ETFS
      : initialEtfs.length > 0
        ? initialEtfs
        : null,
    skip: isDemoMode || !isSignedIn,
  });

  const [activeSector, setActiveSector] = useState<string | null>(sectorParam);
  const [watchlists, setWatchlists] =
    useState<WatchlistData[]>(initialWatchlists);
  const [addingToWatchlist, setAddingToWatchlist] = useState<Set<string>>(
    new Set()
  );

  // MF UI filters (client-side, no cache involvement)
  const [mfCategory, setMfCategory] = useState<string | null>(null);
  const [mfSortBy, setMfSortBy] = useState<
    "returns1Y" | "returns3Y" | "returns5Y" | "nav" | "aum"
  >("nav");
  const [mfAmcFilter, setMfAmcFilter] = useState<string>("all");
  const [amcPopoverOpen, setAmcPopoverOpen] = useState(false);
  const [mfCategoryPopoverOpen, setMfCategoryPopoverOpen] = useState(false);
  const [etfFundHousePopoverOpen, setEtfFundHousePopoverOpen] = useState(false);

  // MF plan filter
  const [mfPlan, setMfPlan] = useState<"ALL" | "DIRECT" | "REGULAR">("ALL");

  // Exchange filter for Stocks tab
  const [activeExchange, setActiveExchange] = useState<string | null>(null);

  // Exchange filter for Indices & ETFs tab
  const [activeExchangeIndices, setActiveExchangeIndices] = useState<
    string | null
  >(null);

  // ETF filters
  const [etfSortBy, setEtfSortBy] = useState<
    | "nav"
    | "changePercent"
    | "volume"
    | "returns1Y"
    | "returns3Y"
    | "returns5Y"
    | "aum"
  >("nav");
  const [etfFundHouse, setEtfFundHouse] = useState<string>("all");
  const [etfCategory, setEtfCategory] = useState<string>("all");

  // Stock list mode: all stocks, top gainers, or top losers
  const [stockListMode, setStockListMode] = useState<
    "all" | "gainers" | "losers"
  >("all");

  // Unified search across all tabs (client-side filtering)
  const [discoverSearch, setDiscoverSearch] = useState("");

  // ResearchModal state
  const [researchModalOpen, setResearchModalOpen] = useState(false);
  const [researchModalEntity, setResearchModalEntity] =
    useState<ResearchEntity | null>(null);

  // Client-side MF filtering from pre-loaded allFunds
  const filteredMfs = useMemo(() => {
    let funds = mfData?.allFunds ?? [];

    if (discoverSearch.trim()) {
      const q = discoverSearch.trim().toLowerCase();
      funds = funds.filter(
        (f) =>
          f.schemeName.toLowerCase().includes(q) ||
          f.amcName?.toLowerCase().includes(q) ||
          f.schemeCode.includes(q) ||
          f.category?.toLowerCase().includes(q)
      );
    }

    if (mfPlan !== "ALL") {
      funds = funds.filter((f) => f.plan === mfPlan);
    }

    if (mfCategory) {
      funds = funds.filter((f) => f.category === mfCategory);
    }

    if (mfAmcFilter !== "all") {
      funds = funds.filter((f) => f.amcName === mfAmcFilter);
    }

    // Sort
    funds = [...funds].sort((a, b) => {
      switch (mfSortBy) {
        case "returns1Y":
          return (b.returns1Y ?? -Infinity) - (a.returns1Y ?? -Infinity);
        case "returns3Y":
          return (b.returns3Y ?? -Infinity) - (a.returns3Y ?? -Infinity);
        case "returns5Y":
          return (b.returns5Y ?? -Infinity) - (a.returns5Y ?? -Infinity);
        case "nav":
          return b.nav - a.nav;
        case "aum":
          return (b.aum ?? 0) - (a.aum ?? 0);
        default:
          return 0;
      }
    });

    return funds;
  }, [mfData, discoverSearch, mfPlan, mfCategory, mfSortBy, mfAmcFilter]);

  // Derive MF fund house list with counts (sorted alphabetically)
  const mfAmcListWithCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of mfData?.allFunds ?? []) {
      if (f.amcName) {
        counts.set(f.amcName, (counts.get(f.amcName) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }, [mfData]);

  // Comparison selection state (MF/ETF/INDEX)
  const MAX_COMPARE = 5;
  const [selectedForCompare, setSelectedForCompare] = useState<
    Map<string, { id: string; fundType: "MF" | "ETF" | "INDEX"; name: string }>
  >(new Map());

  const toggleCompare = (
    id: string,
    fundType: "MF" | "ETF" | "INDEX",
    name: string
  ) => {
    setSelectedForCompare((prev) => {
      const next = new Map(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_COMPARE) {
        next.set(id, { id, fundType, name });
      }
      return next;
    });
  };

  // Stock comparison selection state (separate from MF)
  const MAX_STOCK_COMPARE = 5;
  const [selectedStocks, setSelectedStocks] = useState<
    Map<string, { symbol: string; name: string; exchange: string }>
  >(new Map());
  const [isComparingStocks, setIsComparingStocks] = useState(false);

  const toggleStockCompare = (
    symbol: string,
    name: string,
    exchange: string
  ) => {
    const key = `${symbol}:${exchange}`;
    setSelectedStocks((prev) => {
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else if (next.size < MAX_STOCK_COMPARE) {
        next.set(key, { symbol, name, exchange });
      }
      return next;
    });
  };

  // Pagination state
  const DISCOVER_PAGE_SIZE = 12;
  const [stocksPage, setStocksPage] = useState(0);
  const [mfPage, setMfPage] = useState(0);
  const [indicesPage, setIndicesPage] = useState(0);
  const [etfsPage, setEtfsPage] = useState(0);

  // refreshDiscover is provided by useIDBCache above

  // Fetch user's watchlists for "add to watchlist" button
  const fetchWatchlists = useCallback(async () => {
    try {
      const result = await getWatchlistsAction();
      if (result?.success && result?.data) {
        setWatchlists(result?.data);
      }
    } catch {
      // ignore - watchlist button will just not show
    }
  }, []);

  // MF filtering is now done client-side via the filteredMfs useMemo above
  // Indices/ETFs data now handled by useIDBCache hooks above

  // Track which watchlists contain each symbol (for multi-watchlist picker)
  const watchlistMembership = useMemo(() => {
    const map = new Map<string, Set<string>>(); // symbolKey -> set of watchlistIds
    for (const wl of watchlists) {
      for (const item of wl.items) {
        const key = `${item.symbol}:${item.exchange}`;
        if (!map.has(key)) map.set(key, new Set());
        map.get(key)!.add(wl.id);
      }
    }
    return map;
  }, [watchlists]);

  // Watchlists filtered by type
  const stockWatchlists = useMemo(
    () => watchlists.filter((wl) => wl.type === "STOCK" || !wl.type),
    [watchlists]
  );
  const mfWatchlists = useMemo(
    () => watchlists.filter((wl) => wl.type === "MF"),
    [watchlists]
  );

  // Add item to a specific watchlist
  const handleAddToWatchlistById = async (
    watchlistId: string,
    symbolKey: string,
    symbol: string,
    exchange: string,
    instrumentId?: string
  ) => {
    setAddingToWatchlist((prev) => new Set(prev).add(symbolKey));
    try {
      const result = await addWatchlistItemAction({
        watchlistId,
        symbol,
        exchange,
        instrumentId,
      });
      if (result?.success) {
        await fetchWatchlists();
      }
    } catch {
      // ignore
    } finally {
      setAddingToWatchlist((prev) => {
        const next = new Set(prev);
        next.delete(symbolKey);
        return next;
      });
    }
  };

  // Create a new watchlist of the given type and add an item to it
  const handleCreateAndAdd = async (
    name: string,
    watchlistType: "STOCK" | "MF",
    symbolKey: string,
    symbol: string,
    exchange: string,
    instrumentId?: string
  ) => {
    setAddingToWatchlist((prev) => new Set(prev).add(symbolKey));
    try {
      const createResult = await createWatchlistAction({
        name,
        type: watchlistType,
      });
      if (createResult?.success && createResult?.data) {
        await handleAddToWatchlistById(
          createResult?.data.id,
          symbolKey,
          symbol,
          exchange,
          instrumentId
        );
      }
    } catch {
      // ignore
    } finally {
      setAddingToWatchlist((prev) => {
        const next = new Set(prev);
        next.delete(symbolKey);
        return next;
      });
    }
  };

  // Remove item from a specific watchlist
  const handleRemoveFromWatchlistById = async (
    watchlistId: string,
    symbolKey: string,
    symbol: string,
    exchange: string
  ) => {
    // Find the item ID from local state
    const wl = watchlists.find((w) => w.id === watchlistId);
    const item = wl?.items.find(
      (i) => i.symbol === symbol && i.exchange === exchange
    );
    if (!item) return;

    setAddingToWatchlist((prev) => new Set(prev).add(symbolKey));
    try {
      const result = await removeWatchlistItemAction(item.id);
      if (result?.success) {
        await fetchWatchlists();
      }
    } catch {
      // ignore
    } finally {
      setAddingToWatchlist((prev) => {
        const next = new Set(prev);
        next.delete(symbolKey);
        return next;
      });
    }
  };

  useEffect(() => {
    const demoMode = localStorage.getItem("tradebook_demo_mode");
    if (!isLoaded) return;
    if (!isSignedIn && !demoMode) {
      router.push("/home");
      return;
    }
    // Refresh watchlists in background (initial data came from server)
    if (isSignedIn) {
      fetchWatchlists();
    }
  }, [isLoaded, isSignedIn, router, fetchWatchlists]);

  // Filter all stocks by sector, exchange, and search query (all pre-loaded, instant filtering)
  const filteredStocks = useMemo(() => {
    let stocks = discoverData?.allStocks ?? [];
    // Exclude non-stocks (indices, bonds, etc.) that lack both volume and market cap
    stocks = stocks.filter((s) => s.volume || s.marketCap);
    if (activeExchange) {
      stocks = stocks.filter((s) => s.exchange === activeExchange);
    }
    if (activeSector) {
      if (activeSector === "Not Categorised") {
        stocks = stocks.filter((s) => !s.sector || s.sector === "N/A");
      } else {
        stocks = stocks.filter((s) => s.sector === activeSector);
      }
    }
    if (discoverSearch.trim()) {
      const q = discoverSearch.trim().toLowerCase();
      stocks = stocks.filter(
        (s) =>
          s.symbol.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          (s.sector && s.sector.toLowerCase().includes(q))
      );
    }
    return stocks;
  }, [discoverData, activeSector, activeExchange, discoverSearch]);

  // Filter top gainers/losers by exchange (max 20)
  const displayedGainers = useMemo(() => {
    const gainers = (discoverData?.topGainers ?? []).filter(
      (s) => s.volume || s.marketCap
    );
    const filtered = activeExchange
      ? gainers.filter((s) => s.exchange === activeExchange)
      : gainers;
    return filtered.slice(0, 20);
  }, [discoverData, activeExchange]);

  const displayedLosers = useMemo(() => {
    const losers = (discoverData?.topLosers ?? []).filter(
      (s) => s.volume || s.marketCap
    );
    const filtered = activeExchange
      ? losers.filter((s) => s.exchange === activeExchange)
      : losers;
    return filtered.slice(0, 20);
  }, [discoverData, activeExchange]);

  // Filter indices and ETFs by exchange and search
  const filteredIndices = useMemo(() => {
    let data = indices ?? [];
    if (activeExchangeIndices) {
      data = data.filter((i) => i.exchange === activeExchangeIndices);
    }
    if (discoverSearch.trim()) {
      const q = discoverSearch.trim().toLowerCase();
      data = data.filter(
        (i) =>
          i.symbol.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)
      );
    }
    return data;
  }, [indices, activeExchangeIndices, discoverSearch]);

  const filteredEtfs = useMemo(() => {
    let data = etfs ?? [];
    if (activeExchangeIndices) {
      data = data.filter((e) => e.exchange === activeExchangeIndices);
    }
    if (etfFundHouse !== "all") {
      data = data.filter((e) => extractEtfFundHouse(e.name) === etfFundHouse);
    }
    if (etfCategory !== "all") {
      data = data.filter((e) => deriveEtfCategory(e.name) === etfCategory);
    }
    if (discoverSearch.trim()) {
      const q = discoverSearch.trim().toLowerCase();
      data = data.filter(
        (e) =>
          e.symbol.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)
      );
    }
    // Sort
    data = [...data].sort((a, b) => {
      switch (etfSortBy) {
        case "nav":
          return b.price - a.price;
        case "changePercent":
          return Math.abs(b.changePercent) - Math.abs(a.changePercent);
        case "volume":
          return (b.volume ?? 0) - (a.volume ?? 0);
        case "returns1Y":
          return (b.returns1Y ?? -Infinity) - (a.returns1Y ?? -Infinity);
        case "returns3Y":
          return (b.returns3Y ?? -Infinity) - (a.returns3Y ?? -Infinity);
        case "returns5Y":
          return (b.returns5Y ?? -Infinity) - (a.returns5Y ?? -Infinity);
        case "aum":
          return (b.aum ?? 0) - (a.aum ?? 0);
        default:
          return 0;
      }
    });
    return data;
  }, [
    etfs,
    activeExchangeIndices,
    etfFundHouse,
    etfCategory,
    etfSortBy,
    discoverSearch,
  ]);

  // Derived ETF fund houses and categories for dropdown options
  const etfFundHouses = useMemo(() => {
    const houses = new Map<string, number>();
    for (const e of etfs ?? []) {
      const h = extractEtfFundHouse(e.name);
      houses.set(h, (houses.get(h) ?? 0) + 1);
    }
    return Array.from(houses.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }, [etfs]);

  const etfCategories = useMemo(() => {
    const cats = new Map<string, number>();
    for (const e of etfs ?? []) {
      const c = deriveEtfCategory(e.name);
      cats.set(c, (cats.get(c) ?? 0) + 1);
    }
    return Array.from(cats.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [etfs]);

  // Active stocks list based on mode (all / gainers / losers)
  const activeStocksList = useMemo(() => {
    if (stockListMode === "gainers") return displayedGainers;
    if (stockListMode === "losers") return displayedLosers;
    return filteredStocks;
  }, [stockListMode, filteredStocks, displayedGainers, displayedLosers]);

  // Pagination slices
  const totalStockPages = Math.ceil(
    activeStocksList.length / DISCOVER_PAGE_SIZE
  );
  const paginatedStocks = useMemo(
    () =>
      activeStocksList.slice(
        stocksPage * DISCOVER_PAGE_SIZE,
        (stocksPage + 1) * DISCOVER_PAGE_SIZE
      ),
    [activeStocksList, stocksPage]
  );

  const totalMfPages = Math.ceil(filteredMfs.length / DISCOVER_PAGE_SIZE);
  const paginatedMfs = useMemo(
    () =>
      filteredMfs.slice(
        mfPage * DISCOVER_PAGE_SIZE,
        (mfPage + 1) * DISCOVER_PAGE_SIZE
      ),
    [filteredMfs, mfPage]
  );

  const totalIndicesPages = Math.ceil(
    filteredIndices.length / DISCOVER_PAGE_SIZE
  );
  const paginatedIndices = useMemo(
    () =>
      filteredIndices.slice(
        indicesPage * DISCOVER_PAGE_SIZE,
        (indicesPage + 1) * DISCOVER_PAGE_SIZE
      ),
    [filteredIndices, indicesPage]
  );

  const totalEtfPages = Math.ceil(filteredEtfs.length / DISCOVER_PAGE_SIZE);
  const paginatedEtfs = useMemo(
    () =>
      filteredEtfs.slice(
        etfsPage * DISCOVER_PAGE_SIZE,
        (etfsPage + 1) * DISCOVER_PAGE_SIZE
      ),
    [filteredEtfs, etfsPage]
  );

  // Reset pages when filters change
  useEffect(() => {
    setStocksPage(0);
  }, [activeSector, activeExchange, discoverSearch, stockListMode]);
  useEffect(() => {
    setMfPage(0);
  }, [mfPlan, mfCategory, mfSortBy, mfAmcFilter, discoverSearch]);
  useEffect(() => {
    setIndicesPage(0);
    setEtfsPage(0);
  }, [
    activeExchangeIndices,
    discoverSearch,
    etfSortBy,
    etfFundHouse,
    etfCategory,
  ]);

  // Render function (NOT a component) so React doesn't create a new component
  // boundary on each parent re-render. This preserves WatchlistPicker's open state.
  const renderStockCard = (stock: DiscoverStock, showChange = true) => {
    const isStockSelected = selectedStocks.has(
      `${stock.symbol}:${stock.exchange}`
    );
    const pos = stock.change >= 0;
    return (
      <div className="relative h-full">
        <div
          className="absolute top-3 right-3 z-10"
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={isStockSelected}
            disabled={
              !isStockSelected && selectedStocks.size >= MAX_STOCK_COMPARE
            }
            onCheckedChange={() =>
              toggleStockCompare(stock.symbol, stock.name, stock.exchange)
            }
          />
        </div>
        <div
          className="pf-card"
          style={{
            padding: 0,
            height: "100%",
            display: "flex",
            flexDirection: "column",
            ...(isStockSelected
              ? { outline: "2px solid var(--emerald)", outlineOffset: 2 }
              : {}),
          }}
        >
          <Link
            href={instrumentDetailHref({
              symbol: stock.symbol,
              exchange: stock.exchange,
              instrumentType: stock.instrumentType,
            })}
            className="block cursor-pointer"
            style={{ textDecoration: "none", color: "var(--ink)", padding: 16 }}
          >
            <div className="flex items-center justify-between mb-2">
              <div style={{ minWidth: 0 }}>
                <div className="flex items-center gap-1.5">
                  <h4
                    className="mono"
                    style={{
                      fontWeight: 700,
                      color: "var(--ink)",
                      fontSize: 14,
                    }}
                  >
                    {stock.symbol}
                  </h4>
                  <span className="pf-pill outline" style={{ fontSize: 9 }}>
                    {stock.exchange}
                  </span>
                </div>
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--ink-3)",
                    maxWidth: 150,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {stock.name}
                </p>
              </div>
              {stock.sector && (
                <span
                  className="pf-pill outline"
                  style={{ fontSize: 9, marginRight: 24 }}
                >
                  {stock.sector}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span
                className="mono"
                style={{ fontSize: 17, fontWeight: 700, color: "var(--ink)" }}
              >
                {formatCurrency(stock.price)}
              </span>
              {showChange && (
                <span
                  className="mono"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    fontSize: 13,
                    fontWeight: 700,
                    color: pos ? "var(--emerald-text)" : "#b91c1c",
                  }}
                >
                  {pos ? (
                    <ArrowUpRight className="h-4 w-4" />
                  ) : (
                    <ArrowDownRight className="h-4 w-4" />
                  )}
                  {stock.changePercent.toFixed(2)}%
                </span>
              )}
            </div>
            <div
              className="mono flex items-center justify-between"
              style={{
                marginTop: 12,
                paddingTop: 12,
                borderTop: "1px dashed var(--rule-soft)",
                fontSize: 11.5,
                color: "var(--ink-3)",
              }}
            >
              <span>Vol: {formatVolume(stock.volume)}</span>
              <span>MCap: {formatMarketCap(stock.marketCap)}</span>
            </div>
          </Link>
          <div
            className="flex gap-2"
            style={{ padding: "0 16px 16px", marginTop: "auto" }}
          >
            <button
              type="button"
              className="pf-bf sm"
              style={{ flex: 1, justifyContent: "center" }}
              onClick={() => {
                setResearchModalEntity({
                  symbol: stock.symbol,
                  name: stock.name,
                  type: "stock",
                  exchange: stock.exchange,
                });
                setResearchModalOpen(true);
              }}
            >
              <Brain className="h-3 w-3" /> Analysis
            </button>
            <WatchlistPicker
              symbolKey={`${stock.symbol}:${stock.exchange}`}
              symbol={stock.symbol}
              exchange={stock.exchange}
              instrumentId={stock.instrumentId || undefined}
              filteredWatchlists={stockWatchlists}
              watchlistType="STOCK"
              membership={
                watchlistMembership.get(`${stock.symbol}:${stock.exchange}`) ??
                new Set<string>()
              }
              isAdding={addingToWatchlist.has(
                `${stock.symbol}:${stock.exchange}`
              )}
              onAdd={handleAddToWatchlistById}
              onRemove={handleRemoveFromWatchlistById}
              onCreate={handleCreateAndAdd}
            />
          </div>
        </div>
      </div>
    );
  };

  // Tab switch: clears search + cross-tab compare selections and syncs the
  // ?tab= query param. Shared by the playful segmented control and the
  // controlled <Tabs onValueChange>.
  const handleTabChange = (tab: string) => {
    const prev = activeTab;
    setActiveTab(tab);
    setDiscoverSearch("");
    if (prev === "stocks" && tab !== "stocks") {
      setSelectedStocks(new Map());
    }
    if (prev !== "stocks" && tab === "stocks") {
      setSelectedForCompare(new Map());
    }
    const params = new URLSearchParams();
    if (activeSector) params.set("sector", activeSector);
    if (tab === "stocks") {
      params.delete("tab");
    } else {
      params.set("tab", tab);
    }
    const qs = params.toString();
    router.replace(`/discover${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  return (
    <PageGuard
      route="/discover"
      fallback={<DiscoverSkeleton />}
      containerClassName="p-6 pb-48 sm:pb-44"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />

        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="p-6 pb-48 sm:pb-44">
            {isDemoMode && <DemoBanner />}
            {/* Header — playful pf-ph (MONEY-485) */}
            <div className="pf-ph">
              <div className="l">
                <div className="eyebrow">
                  <span className="d" aria-hidden />
                  STOCKS · MUTUAL FUNDS · INDICES · ETFS
                </div>
                <h1>
                  Find your next <span className="ser">conviction</span>{" "}
                  <span className="hl">buy.</span>
                </h1>
                <div className="sub">
                  Explore stocks, mutual funds, and market movers.
                </div>
              </div>
              <div className="r">
                <button
                  type="button"
                  className="pf-bf"
                  onClick={refreshDiscover}
                  disabled={isLoading}
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`}
                  />
                  Refresh
                </button>
              </div>
            </div>

            <Tabs
              value={activeTab}
              onValueChange={handleTabChange}
              className="space-y-6"
            >
              {/* Playful segmented tab control (MONEY-485). Drives the
                  controlled <Tabs value> via handleTabChange so <TabsContent>
                  switching + URL sync + selection-clear all stay intact. */}
              <div
                style={{
                  display: "inline-flex",
                  border: "1.5px solid var(--ink)",
                  borderRadius: 9,
                  padding: 3,
                  background: "var(--paper)",
                  gap: 2,
                  flexWrap: "wrap",
                }}
              >
                {(
                  [
                    { id: "stocks", label: "Stocks", Icon: Briefcase },
                    {
                      id: "mutualfunds",
                      label: "Mutual Funds",
                      Icon: BarChart2,
                    },
                    { id: "indices", label: "Indices & ETFs", Icon: Activity },
                  ] as const
                ).map(({ id, label, Icon }) => {
                  const active = activeTab === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => handleTabChange(id)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "7px 14px",
                        borderRadius: 6,
                        border: 0,
                        cursor: "pointer",
                        fontSize: 13,
                        fontWeight: active ? 700 : 600,
                        background: active ? "var(--ink)" : "transparent",
                        color: active ? "var(--paper)" : "var(--ink-3)",
                        transition: "background .12s, color .12s",
                      }}
                    >
                      <Icon className="h-4 w-4" /> {label}
                    </button>
                  );
                })}
              </div>

              {/* Central Search Input - visible on all tabs (playful pf-input) */}
              <div className="relative">
                <Search
                  className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4"
                  style={{ color: "var(--ink-3)" }}
                />
                <input
                  type="text"
                  className="pf-input"
                  style={{ paddingLeft: 36, paddingRight: 36 }}
                  placeholder={
                    activeTab === "stocks"
                      ? "Search stocks by name, symbol, or sector..."
                      : activeTab === "mutualfunds"
                        ? "Search mutual funds by name or AMC..."
                        : "Search indices and ETFs..."
                  }
                  value={discoverSearch}
                  onChange={(e) => setDiscoverSearch(e.target.value)}
                />
                {discoverSearch && (
                  <button
                    onClick={() => setDiscoverSearch("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2"
                    style={{ color: "var(--ink-3)" }}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              {/* Exchange Filter - only on Stocks tab (playful pf-pill) */}
              {activeTab === "stocks" && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {([null, "NSE", "BSE"] as const).map((ex) => (
                    <button
                      key={ex ?? "all"}
                      type="button"
                      className={`pf-pill${activeExchange === ex ? "" : " outline"}`}
                      style={
                        activeExchange === ex
                          ? { background: "var(--ink)", color: "var(--paper)" }
                          : undefined
                      }
                      onClick={() => setActiveExchange(ex)}
                    >
                      {ex ?? "All Exchanges"}
                    </button>
                  ))}
                </div>
              )}

              {/* Stock List Mode Filter - only on Stocks tab (playful pf-pill) */}
              {activeTab === "stocks" && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {[
                    { key: "all" as const, label: "All Stocks" },
                    { key: "gainers" as const, label: "Top Gainers" },
                    { key: "losers" as const, label: "Top Losers" },
                  ].map(({ key, label }) => (
                    <button
                      key={key}
                      type="button"
                      className={`pf-pill${stockListMode === key ? "" : " outline"}`}
                      style={
                        stockListMode === key
                          ? { background: "var(--ink)", color: "var(--paper)" }
                          : undefined
                      }
                      onClick={() => {
                        setStockListMode(key);
                        setStocksPage(0);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {/* Sector Filter - only on Stocks tab */}
              {activeTab === "stocks" && (
                <div className="flex flex-wrap gap-3 mb-6">
                  <Select
                    value={activeSector ?? "all"}
                    onValueChange={(v) =>
                      setActiveSector(v === "all" ? null : v)
                    }
                  >
                    <SelectTrigger className="w-[220px]">
                      <SelectValue placeholder="All Sectors" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px] overflow-y-auto">
                      <SelectItem value="all">All Sectors</SelectItem>
                      {(discoverData?.sectors ?? []).map((s) => (
                        <SelectItem key={s.name} value={s.name}>
                          {s.name}
                          {s.count > 0 ? ` (${s.count})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Link href="/discover/sectors" className="pf-bf">
                    Browse All Sectors
                  </Link>
                </div>
              )}

              <TabsContent value="stocks" className="space-y-6">
                {isLoading ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {[1, 2, 3, 4, 5, 6].map((i) => (
                      <Card key={i} className="h-full">
                        <CardContent className="pt-4">
                          <div className="flex items-center justify-between mb-2">
                            <div>
                              <div className="flex items-center gap-1.5">
                                <Skeleton className="h-5 w-16" />
                                <Skeleton className="h-4 w-10 rounded-full" />
                              </div>
                              <Skeleton className="h-3 w-28 mt-1" />
                            </div>
                            <Skeleton className="h-5 w-16 rounded-full" />
                          </div>
                          <div className="flex items-center justify-between">
                            <Skeleton className="h-6 w-20" />
                            <Skeleton className="h-4 w-14" />
                          </div>
                          <div className="flex items-center justify-between mt-3 pt-3 border-t">
                            <Skeleton className="h-3 w-20" />
                            <Skeleton className="h-3 w-24" />
                          </div>
                        </CardContent>
                        <CardFooter className="pt-0 gap-2">
                          <Skeleton className="h-8 flex-1 rounded-md" />
                          <Skeleton className="h-8 w-8 rounded-md" />
                        </CardFooter>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <div>
                    <div className="pf-sec-h" style={{ marginTop: 0 }}>
                      <span className="n">
                        {stockListMode === "gainers"
                          ? "GAINERS"
                          : stockListMode === "losers"
                            ? "LOSERS"
                            : "STOCKS"}
                      </span>
                      <h3>
                        {stockListMode === "gainers" ? (
                          <>
                            Top <span className="ser">gainers.</span>
                          </>
                        ) : stockListMode === "losers" ? (
                          <>
                            Top <span className="ser">losers.</span>
                          </>
                        ) : activeSector ? (
                          <>
                            {activeSector} <span className="ser">stocks.</span>
                          </>
                        ) : (
                          <>
                            All <span className="ser">stocks.</span>
                          </>
                        )}
                      </h3>
                      <span className="rule" />
                      <span className="meta">
                        {activeStocksList.length} matched
                      </span>
                    </div>
                    {paginatedStocks.length > 0 ? (
                      <>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                          {paginatedStocks.map((stock) => (
                            <div key={`${stock.symbol}-${stock.exchange}`}>
                              {renderStockCard(stock)}
                            </div>
                          ))}
                        </div>
                        <PaginationControls
                          currentPage={stocksPage}
                          totalPages={totalStockPages}
                          onPageChange={setStocksPage}
                          pageSize={DISCOVER_PAGE_SIZE}
                          totalItems={activeStocksList.length}
                          label="stocks"
                        />
                      </>
                    ) : (
                      <p
                        className="ser text-center py-8"
                        style={{ color: "var(--ink-3)", fontSize: 16 }}
                      >
                        No stocks found
                        {activeSector ? ` in ${activeSector} sector` : ""}
                      </p>
                    )}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="mutualfunds" className="space-y-6">
                {/* Plan filter badges (playful pf-pill) */}
                <div className="flex flex-wrap gap-2">
                  {(["ALL", "DIRECT", "REGULAR"] as const).map((plan) => (
                    <button
                      key={plan}
                      type="button"
                      className={`pf-pill${mfPlan === plan ? "" : " outline"}`}
                      style={
                        mfPlan === plan
                          ? { background: "var(--ink)", color: "var(--paper)" }
                          : undefined
                      }
                      onClick={() => setMfPlan(plan)}
                    >
                      {plan === "ALL" ? "All Plans" : plan}
                    </button>
                  ))}
                </div>

                {/* Category filter chips removed - searchable dropdown below */}

                {/* Sort & AMC filter */}
                <div className="flex flex-wrap gap-3">
                  <Select
                    value={mfSortBy}
                    onValueChange={(v) =>
                      setMfSortBy(
                        v as
                          | "returns1Y"
                          | "returns3Y"
                          | "returns5Y"
                          | "nav"
                          | "aum"
                      )
                    }
                  >
                    <SelectTrigger className="w-[160px]">
                      <SelectValue placeholder="Sort by" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="returns1Y">1Y Returns</SelectItem>
                      <SelectItem value="returns3Y">3Y Returns</SelectItem>
                      <SelectItem value="returns5Y">5Y Returns</SelectItem>
                      <SelectItem value="nav">NAV</SelectItem>
                      <SelectItem value="aum">AUM</SelectItem>
                    </SelectContent>
                  </Select>
                  <Popover
                    open={mfCategoryPopoverOpen}
                    onOpenChange={setMfCategoryPopoverOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={mfCategoryPopoverOpen}
                        className="w-[220px] justify-between font-normal"
                      >
                        <span className="truncate">
                          {mfCategory ?? "All Categories"}
                        </span>
                        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[280px] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Search categories..." />
                        <CommandList className="max-h-[300px]">
                          <CommandEmpty>No category found.</CommandEmpty>
                          <CommandGroup>
                            <CommandItem
                              value="all"
                              onSelect={() => {
                                setMfCategory(null);
                                setMfCategoryPopoverOpen(false);
                              }}
                            >
                              <Check
                                className={`mr-2 h-4 w-4 ${mfCategory === null ? "opacity-100" : "opacity-0"}`}
                              />
                              All Categories
                            </CommandItem>
                            {(mfData?.categories ?? []).map((c) => (
                              <CommandItem
                                key={c.name}
                                value={c.name}
                                onSelect={() => {
                                  setMfCategory(c.name);
                                  setMfCategoryPopoverOpen(false);
                                }}
                              >
                                <Check
                                  className={`mr-2 h-4 w-4 ${mfCategory === c.name ? "opacity-100" : "opacity-0"}`}
                                />
                                {c.name} ({c.count})
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <Popover
                    open={amcPopoverOpen}
                    onOpenChange={setAmcPopoverOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={amcPopoverOpen}
                        className="w-[220px] justify-between font-normal"
                      >
                        <span className="truncate">
                          {mfAmcFilter === "all"
                            ? "All Fund Houses"
                            : mfAmcFilter}
                        </span>
                        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[280px] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Search fund houses..." />
                        <CommandList className="max-h-[300px]">
                          <CommandEmpty>No fund house found.</CommandEmpty>
                          <CommandGroup>
                            <CommandItem
                              value="all"
                              onSelect={() => {
                                setMfAmcFilter("all");
                                setAmcPopoverOpen(false);
                              }}
                            >
                              <Check
                                className={`mr-2 h-4 w-4 ${mfAmcFilter === "all" ? "opacity-100" : "opacity-0"}`}
                              />
                              All Fund Houses
                            </CommandItem>
                            {mfAmcListWithCounts.map((amc) => (
                              <CommandItem
                                key={amc.name}
                                value={amc.name}
                                onSelect={() => {
                                  setMfAmcFilter(amc.name);
                                  setAmcPopoverOpen(false);
                                }}
                              >
                                <Check
                                  className={`mr-2 h-4 w-4 ${mfAmcFilter === amc.name ? "opacity-100" : "opacity-0"}`}
                                />
                                {amc.name} ({amc.count})
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>

                {/* MF Cards */}
                {isMfLoading ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {[1, 2, 3, 4, 5, 6].map((i) => (
                      <Card key={i} className="h-full">
                        <CardContent className="pt-4">
                          <div className="mb-2 pr-6">
                            <Skeleton className="h-4 w-full mb-1" />
                            <Skeleton className="h-4 w-3/4" />
                            <Skeleton className="h-3 w-28 mt-1" />
                          </div>
                          <div className="flex items-center gap-2 mb-3">
                            <Skeleton className="h-4 w-16 rounded-full" />
                            <Skeleton className="h-4 w-14 rounded-full" />
                            <Skeleton className="h-4 w-14 rounded-full" />
                          </div>
                          <div className="flex items-center justify-between mb-2">
                            <Skeleton className="h-6 w-20" />
                            <Skeleton className="h-3 w-24" />
                          </div>
                          <div className="flex items-center justify-between pt-2 border-t text-xs">
                            <Skeleton className="h-3 w-16" />
                            <Skeleton className="h-3 w-16" />
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ) : filteredMfs.length === 0 ? (
                  <p
                    className="ser text-center py-12"
                    style={{ color: "var(--ink-3)", fontSize: 16 }}
                  >
                    No mutual funds found. Use the search bar above to find
                    specific funds.
                  </p>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {paginatedMfs.map((fund) => {
                        const isSelected = selectedForCompare.has(
                          fund.schemeCode
                        );
                        return (
                          <div key={fund.schemeCode} className="relative">
                            <div
                              className="absolute top-3 right-3 z-10"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Checkbox
                                checked={isSelected}
                                disabled={
                                  !isSelected &&
                                  selectedForCompare.size >= MAX_COMPARE
                                }
                                onCheckedChange={() =>
                                  toggleCompare(
                                    fund.schemeCode,
                                    "MF",
                                    fund.schemeName
                                  )
                                }
                              />
                            </div>
                            <div
                              className="pf-card"
                              style={{
                                padding: 0,
                                height: "100%",
                                display: "flex",
                                flexDirection: "column",
                                ...(isSelected
                                  ? {
                                      outline: "2px solid var(--emerald)",
                                      outlineOffset: 2,
                                    }
                                  : {}),
                              }}
                            >
                              <Link
                                href={instrumentDetailHref({
                                  symbol: fund.schemeCode,
                                  instrumentType: "MF",
                                  from: "/discover?tab=mutualfunds",
                                })}
                                className="block cursor-pointer"
                                style={{
                                  textDecoration: "none",
                                  color: "var(--ink)",
                                  padding: 16,
                                }}
                              >
                                <div className="mb-2 pr-6">
                                  <h4
                                    className="line-clamp-2"
                                    style={{
                                      fontWeight: 700,
                                      fontSize: 13,
                                      lineHeight: 1.25,
                                      color: "var(--ink)",
                                    }}
                                  >
                                    {fund.schemeName}
                                  </h4>
                                  <p
                                    style={{
                                      fontSize: 12,
                                      color: "var(--ink-3)",
                                      marginTop: 4,
                                    }}
                                  >
                                    {fund.amcName}
                                  </p>
                                </div>
                                <div className="flex items-center gap-2 mb-3 flex-wrap">
                                  <span
                                    className="pf-pill outline"
                                    style={{ fontSize: 9 }}
                                  >
                                    {fund.category}
                                  </span>
                                  {fund.riskLevel && (
                                    <span
                                      className="pf-pill outline"
                                      style={{
                                        fontSize: 9,
                                        color:
                                          fund.riskLevel === "High" ||
                                          fund.riskLevel === "Very High"
                                            ? "#b91c1c"
                                            : fund.riskLevel === "Moderate"
                                              ? "var(--pop-2-text)"
                                              : "var(--emerald-text)",
                                        borderColor:
                                          fund.riskLevel === "High" ||
                                          fund.riskLevel === "Very High"
                                            ? "#b91c1c"
                                            : fund.riskLevel === "Moderate"
                                              ? "var(--pop-2)"
                                              : "var(--emerald)",
                                      }}
                                    >
                                      {fund.riskLevel}
                                    </span>
                                  )}
                                  {fund.plan && (
                                    <span
                                      className="pf-pill outline"
                                      style={{ fontSize: 9 }}
                                    >
                                      {fund.plan}
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center justify-between mb-2">
                                  <span
                                    className="mono"
                                    style={{
                                      fontSize: 17,
                                      fontWeight: 700,
                                      color: "var(--ink)",
                                    }}
                                  >
                                    {formatCurrency(fund.nav)}
                                  </span>
                                  {fund.aum != null && fund.aum > 0 && (
                                    <span
                                      className="mono"
                                      style={{
                                        fontSize: 11,
                                        color: "var(--ink-3)",
                                      }}
                                    >
                                      AUM:{" "}
                                      {formatMarketCap(fund.aum * 10_000_000)}
                                    </span>
                                  )}
                                </div>
                                <div
                                  className="flex items-center justify-between"
                                  style={{
                                    paddingTop: 8,
                                    borderTop: "1px dashed var(--rule-soft)",
                                  }}
                                >
                                  {fund.returns1Y != null && (
                                    <div className="text-center">
                                      <p
                                        className="mono"
                                        style={{
                                          fontSize: 10,
                                          color: "var(--ink-3)",
                                        }}
                                      >
                                        1Y
                                      </p>
                                      <p
                                        className="mono"
                                        style={{
                                          fontWeight: 700,
                                          fontSize: 12,
                                          color:
                                            fund.returns1Y >= 0
                                              ? "var(--emerald-text)"
                                              : "#b91c1c",
                                        }}
                                      >
                                        {fund.returns1Y >= 0 ? "+" : ""}
                                        {fund.returns1Y.toFixed(1)}%
                                      </p>
                                    </div>
                                  )}
                                  {fund.returns3Y != null && (
                                    <div className="text-center">
                                      <p
                                        className="mono"
                                        style={{
                                          fontSize: 10,
                                          color: "var(--ink-3)",
                                        }}
                                      >
                                        3Y
                                      </p>
                                      <p
                                        className="mono"
                                        style={{
                                          fontWeight: 700,
                                          fontSize: 12,
                                          color:
                                            fund.returns3Y >= 0
                                              ? "var(--emerald-text)"
                                              : "#b91c1c",
                                        }}
                                      >
                                        {fund.returns3Y >= 0 ? "+" : ""}
                                        {fund.returns3Y.toFixed(1)}%
                                      </p>
                                    </div>
                                  )}
                                  {fund.returns5Y != null && (
                                    <div className="text-center">
                                      <p
                                        className="mono"
                                        style={{
                                          fontSize: 10,
                                          color: "var(--ink-3)",
                                        }}
                                      >
                                        5Y
                                      </p>
                                      <p
                                        className="mono"
                                        style={{
                                          fontWeight: 700,
                                          fontSize: 12,
                                          color:
                                            fund.returns5Y >= 0
                                              ? "var(--emerald-text)"
                                              : "#b91c1c",
                                        }}
                                      >
                                        {fund.returns5Y >= 0 ? "+" : ""}
                                        {fund.returns5Y.toFixed(1)}%
                                      </p>
                                    </div>
                                  )}
                                </div>
                              </Link>
                              <div
                                className="flex gap-2"
                                style={{
                                  padding: "0 16px 16px",
                                  marginTop: "auto",
                                }}
                              >
                                <button
                                  type="button"
                                  className="pf-bf sm"
                                  style={{
                                    flex: 1,
                                    justifyContent: "center",
                                  }}
                                  onClick={() => {
                                    setResearchModalEntity({
                                      symbol: fund.schemeCode,
                                      name: fund.schemeName,
                                      type: "mf",
                                    });
                                    setResearchModalOpen(true);
                                  }}
                                >
                                  <Brain className="h-3 w-3" /> Analysis
                                </button>
                                <WatchlistPicker
                                  symbolKey={`${fund.schemeCode}:${fund.amcName}`}
                                  symbol={fund.schemeCode}
                                  exchange={fund.amcName || ""}
                                  filteredWatchlists={mfWatchlists}
                                  watchlistType="MF"
                                  membership={
                                    watchlistMembership.get(
                                      `${fund.schemeCode}:${fund.amcName}`
                                    ) ?? new Set<string>()
                                  }
                                  isAdding={addingToWatchlist.has(
                                    `${fund.schemeCode}:${fund.amcName}`
                                  )}
                                  onAdd={handleAddToWatchlistById}
                                  onRemove={handleRemoveFromWatchlistById}
                                  onCreate={handleCreateAndAdd}
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <PaginationControls
                      currentPage={mfPage}
                      totalPages={totalMfPages}
                      onPageChange={setMfPage}
                      pageSize={DISCOVER_PAGE_SIZE}
                      totalItems={filteredMfs.length}
                      label="funds"
                    />
                  </>
                )}
              </TabsContent>

              {/* Indices & ETFs Tab */}
              <TabsContent value="indices" className="space-y-8">
                {/* Exchange Filter for Indices & ETFs (playful pf-pill) */}
                <div className="flex flex-wrap gap-2">
                  {([null, "NSE", "BSE"] as const).map((ex) => (
                    <button
                      key={ex ?? "all"}
                      type="button"
                      className={`pf-pill${activeExchangeIndices === ex ? "" : " outline"}`}
                      style={
                        activeExchangeIndices === ex
                          ? { background: "var(--ink)", color: "var(--paper)" }
                          : undefined
                      }
                      onClick={() => setActiveExchangeIndices(ex)}
                    >
                      {ex ?? "All Exchanges"}
                    </button>
                  ))}
                </div>

                {/* ETF Sort & Filter Dropdowns */}
                <div className="flex flex-wrap gap-3">
                  <Select
                    value={etfSortBy}
                    onValueChange={(v) => setEtfSortBy(v as typeof etfSortBy)}
                  >
                    <SelectTrigger className="w-[160px]">
                      <SelectValue placeholder="Sort by" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="nav">NAV</SelectItem>
                      <SelectItem value="returns1Y">1Y Returns</SelectItem>
                      <SelectItem value="returns3Y">3Y Returns</SelectItem>
                      <SelectItem value="returns5Y">5Y Returns</SelectItem>
                      <SelectItem value="aum">AUM</SelectItem>
                      <SelectItem value="changePercent">% Change</SelectItem>
                      <SelectItem value="volume">Volume</SelectItem>
                    </SelectContent>
                  </Select>
                  <Popover
                    open={etfFundHousePopoverOpen}
                    onOpenChange={setEtfFundHousePopoverOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={etfFundHousePopoverOpen}
                        className="w-[220px] justify-between font-normal"
                      >
                        <span className="truncate">
                          {etfFundHouse === "all"
                            ? "All Fund Houses"
                            : etfFundHouse}
                        </span>
                        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[280px] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Search fund houses..." />
                        <CommandList className="max-h-[300px]">
                          <CommandEmpty>No fund house found.</CommandEmpty>
                          <CommandGroup>
                            <CommandItem
                              value="all"
                              onSelect={() => {
                                setEtfFundHouse("all");
                                setEtfFundHousePopoverOpen(false);
                              }}
                            >
                              <Check
                                className={`mr-2 h-4 w-4 ${etfFundHouse === "all" ? "opacity-100" : "opacity-0"}`}
                              />
                              All Fund Houses
                            </CommandItem>
                            {etfFundHouses.map((h) => (
                              <CommandItem
                                key={h.name}
                                value={h.name}
                                onSelect={() => {
                                  setEtfFundHouse(h.name);
                                  setEtfFundHousePopoverOpen(false);
                                }}
                              >
                                <Check
                                  className={`mr-2 h-4 w-4 ${etfFundHouse === h.name ? "opacity-100" : "opacity-0"}`}
                                />
                                {h.name} ({h.count})
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <Select value={etfCategory} onValueChange={setEtfCategory}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue placeholder="All Categories" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px] overflow-y-auto">
                      <SelectItem value="all">All Categories</SelectItem>
                      {etfCategories.map((c) => (
                        <SelectItem key={c.name} value={c.name}>
                          {c.name} ({c.count})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {isIndicesLoading ? (
                  <div className="space-y-8">
                    {/* Major Indices skeleton */}
                    <div>
                      <div className="flex items-center gap-2 mb-4">
                        <Activity className="h-5 w-5 text-primary" />
                        <h2 className="text-xl font-semibold">Major Indices</h2>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                        {[1, 2, 3, 4].map((i) => (
                          <Card key={i} className="h-full">
                            <CardContent className="pt-4">
                              <div className="flex items-center justify-between mb-1 pr-6">
                                <div className="flex items-center gap-1.5">
                                  <Skeleton className="h-4 w-20" />
                                  <Skeleton className="h-4 w-10 rounded-full" />
                                </div>
                                <Skeleton className="h-4 w-12 rounded-full" />
                              </div>
                              <Skeleton className="h-3 w-32 mb-3" />
                              <div className="flex items-center justify-between">
                                <Skeleton className="h-6 w-24" />
                                <Skeleton className="h-4 w-14" />
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                    {/* ETFs skeleton */}
                    <div>
                      <div className="flex items-center gap-2 mb-4">
                        <LineChart className="h-5 w-5 text-primary" />
                        <h2 className="text-xl font-semibold">
                          Exchange Traded Funds
                        </h2>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                          <Card key={i} className="h-full">
                            <CardContent className="pt-4">
                              <div className="flex items-center justify-between mb-1 pr-6">
                                <div className="flex items-center gap-1.5">
                                  <Skeleton className="h-4 w-20" />
                                  <Skeleton className="h-4 w-10 rounded-full" />
                                </div>
                              </div>
                              <Skeleton className="h-3 w-32 mb-3" />
                              <div className="flex items-center justify-between">
                                <Skeleton className="h-6 w-24" />
                                <Skeleton className="h-4 w-14" />
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Indices */}
                    {filteredIndices.length > 0 && (
                      <div>
                        <div className="pf-sec-h" style={{ marginTop: 0 }}>
                          <span className="n">INDICES</span>
                          <h3>
                            Major <span className="ser">indices.</span>
                          </h3>
                          <span className="rule" />
                          <span className="meta">{filteredIndices.length}</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                          {paginatedIndices.map((idx) => {
                            const isIdxSelected = selectedForCompare.has(
                              idx.symbol
                            );
                            const pos = idx.change >= 0;
                            return (
                              <div key={idx.symbol} className="relative">
                                <div
                                  className="absolute top-3 right-3 z-10"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <Checkbox
                                    checked={isIdxSelected}
                                    disabled={
                                      !isIdxSelected &&
                                      selectedForCompare.size >= MAX_COMPARE
                                    }
                                    onCheckedChange={() =>
                                      toggleCompare(
                                        idx.symbol,
                                        "INDEX",
                                        idx.name
                                      )
                                    }
                                  />
                                </div>
                                <Link
                                  href={instrumentDetailHref({
                                    symbol: idx.symbol,
                                    exchange: idx.exchange,
                                    instrumentType: "INDEX",
                                  })}
                                  className="block cursor-pointer"
                                  style={{ textDecoration: "none" }}
                                >
                                  <div
                                    className="pf-card"
                                    style={{
                                      padding: 16,
                                      height: "100%",
                                      ...(isIdxSelected
                                        ? {
                                            outline: "2px solid var(--emerald)",
                                            outlineOffset: 2,
                                          }
                                        : {}),
                                    }}
                                  >
                                    <div className="flex items-center justify-between mb-1 pr-6">
                                      <div className="flex items-center gap-1.5">
                                        <h4
                                          className="mono"
                                          style={{
                                            fontWeight: 700,
                                            fontSize: 13,
                                            color: "var(--ink)",
                                          }}
                                        >
                                          {idx.symbol}
                                        </h4>
                                        <span
                                          className="pf-pill outline"
                                          style={{ fontSize: 9 }}
                                        >
                                          {idx.exchange}
                                        </span>
                                      </div>
                                      <span
                                        className="pf-pill outline"
                                        style={{ fontSize: 9 }}
                                      >
                                        INDEX
                                      </span>
                                    </div>
                                    <p
                                      style={{
                                        fontSize: 12,
                                        color: "var(--ink-3)",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                        marginBottom: 12,
                                      }}
                                    >
                                      {idx.name}
                                    </p>
                                    <div className="flex items-center justify-between">
                                      <span
                                        className="mono"
                                        style={{
                                          fontSize: 17,
                                          fontWeight: 700,
                                          color: "var(--ink)",
                                        }}
                                      >
                                        {formatCurrency(idx.price)}
                                      </span>
                                      <span
                                        className="mono"
                                        style={{
                                          display: "inline-flex",
                                          alignItems: "center",
                                          fontSize: 13,
                                          fontWeight: 700,
                                          color: pos
                                            ? "var(--emerald-text)"
                                            : "#b91c1c",
                                        }}
                                      >
                                        {pos ? (
                                          <ArrowUpRight className="h-3 w-3" />
                                        ) : (
                                          <ArrowDownRight className="h-3 w-3" />
                                        )}
                                        {idx.changePercent.toFixed(2)}%
                                      </span>
                                    </div>
                                  </div>
                                </Link>
                              </div>
                            );
                          })}
                        </div>
                        <PaginationControls
                          currentPage={indicesPage}
                          totalPages={totalIndicesPages}
                          onPageChange={setIndicesPage}
                          pageSize={DISCOVER_PAGE_SIZE}
                          totalItems={filteredIndices.length}
                          label="indices"
                        />
                      </div>
                    )}

                    {/* ETFs */}
                    {filteredEtfs.length > 0 && (
                      <div>
                        <div className="pf-sec-h" style={{ marginTop: 0 }}>
                          <span className="n">ETFS</span>
                          <h3>
                            Exchange traded <span className="ser">funds.</span>
                          </h3>
                          <span className="rule" />
                          <span className="meta">{filteredEtfs.length}</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                          {paginatedEtfs.map((etf) => {
                            const isSelected = selectedForCompare.has(
                              etf.symbol
                            );
                            const pos = etf.change >= 0;
                            return (
                              <div key={etf.symbol} className="relative h-full">
                                <div
                                  className="absolute top-3 right-3 z-10"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <Checkbox
                                    checked={isSelected}
                                    disabled={
                                      !isSelected &&
                                      selectedForCompare.size >= MAX_COMPARE
                                    }
                                    onCheckedChange={() =>
                                      toggleCompare(etf.symbol, "ETF", etf.name)
                                    }
                                  />
                                </div>
                                <div
                                  className="pf-card"
                                  style={{
                                    padding: 0,
                                    height: "100%",
                                    display: "flex",
                                    flexDirection: "column",
                                    ...(isSelected
                                      ? {
                                          outline: "2px solid var(--emerald)",
                                          outlineOffset: 2,
                                        }
                                      : {}),
                                  }}
                                >
                                  <Link
                                    // MONEY-1205: ETFs are funds. This tile sent
                                    // them to the OHLC/PE page while the screener
                                    // tile next to it sent them to /etf/.
                                    href={instrumentDetailHref({
                                      symbol: etf.symbol,
                                      exchange: etf.exchange,
                                      instrumentType: "ETF",
                                    })}
                                    className="block cursor-pointer"
                                    style={{
                                      textDecoration: "none",
                                      color: "var(--ink)",
                                      padding: 16,
                                    }}
                                  >
                                    <div className="flex items-center justify-between mb-1 pr-6">
                                      <div className="flex items-center gap-1.5">
                                        <h4
                                          className="mono"
                                          style={{
                                            fontWeight: 700,
                                            fontSize: 13,
                                            color: "var(--ink)",
                                          }}
                                        >
                                          {etf.symbol}
                                        </h4>
                                        <span
                                          className="pf-pill outline"
                                          style={{ fontSize: 9 }}
                                        >
                                          {etf.exchange}
                                        </span>
                                      </div>
                                      <span
                                        className="pf-pill outline"
                                        style={{ fontSize: 9 }}
                                      >
                                        ETF
                                      </span>
                                    </div>
                                    <p
                                      style={{
                                        fontSize: 12,
                                        color: "var(--ink-3)",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                        marginBottom: 12,
                                      }}
                                    >
                                      {etf.name}
                                    </p>
                                    <div className="flex items-center justify-between">
                                      <span
                                        className="mono"
                                        style={{
                                          fontSize: 17,
                                          fontWeight: 700,
                                          color: "var(--ink)",
                                        }}
                                      >
                                        {formatCurrency(etf.price)}
                                      </span>
                                      <span
                                        className="mono"
                                        style={{
                                          display: "inline-flex",
                                          alignItems: "center",
                                          fontSize: 13,
                                          fontWeight: 700,
                                          color: pos
                                            ? "var(--emerald-text)"
                                            : "#b91c1c",
                                        }}
                                      >
                                        {pos ? (
                                          <ArrowUpRight className="h-3 w-3" />
                                        ) : (
                                          <ArrowDownRight className="h-3 w-3" />
                                        )}
                                        {etf.changePercent.toFixed(2)}%
                                      </span>
                                    </div>
                                    {(etf.returns1Y != null ||
                                      etf.returns3Y != null ||
                                      etf.returns5Y != null) && (
                                      <div
                                        className="grid grid-cols-3 gap-2"
                                        style={{
                                          marginTop: 12,
                                          paddingTop: 12,
                                          borderTop:
                                            "1px dashed var(--rule-soft)",
                                        }}
                                      >
                                        <div>
                                          <span
                                            className="mono"
                                            style={{
                                              fontSize: 10,
                                              color: "var(--ink-3)",
                                            }}
                                          >
                                            1Y
                                          </span>
                                          <p
                                            className="mono"
                                            style={{
                                              fontWeight: 700,
                                              fontSize: 12,
                                              color:
                                                etf.returns1Y != null &&
                                                etf.returns1Y >= 0
                                                  ? "var(--emerald-text)"
                                                  : "#b91c1c",
                                            }}
                                          >
                                            {etf.returns1Y != null
                                              ? `${etf.returns1Y.toFixed(1)}%`
                                              : "-"}
                                          </p>
                                        </div>
                                        <div>
                                          <span
                                            className="mono"
                                            style={{
                                              fontSize: 10,
                                              color: "var(--ink-3)",
                                            }}
                                          >
                                            3Y
                                          </span>
                                          <p
                                            className="mono"
                                            style={{
                                              fontWeight: 700,
                                              fontSize: 12,
                                              color:
                                                etf.returns3Y != null &&
                                                etf.returns3Y >= 0
                                                  ? "var(--emerald-text)"
                                                  : "#b91c1c",
                                            }}
                                          >
                                            {etf.returns3Y != null
                                              ? `${etf.returns3Y.toFixed(1)}%`
                                              : "-"}
                                          </p>
                                        </div>
                                        <div>
                                          <span
                                            className="mono"
                                            style={{
                                              fontSize: 10,
                                              color: "var(--ink-3)",
                                            }}
                                          >
                                            5Y
                                          </span>
                                          <p
                                            className="mono"
                                            style={{
                                              fontWeight: 700,
                                              fontSize: 12,
                                              color:
                                                etf.returns5Y != null &&
                                                etf.returns5Y >= 0
                                                  ? "var(--emerald-text)"
                                                  : "#b91c1c",
                                            }}
                                          >
                                            {etf.returns5Y != null
                                              ? `${etf.returns5Y.toFixed(1)}%`
                                              : "-"}
                                          </p>
                                        </div>
                                      </div>
                                    )}
                                    <div
                                      className="mono flex items-center justify-between"
                                      style={{
                                        marginTop: 8,
                                        paddingTop: 8,
                                        borderTop:
                                          "1px dashed var(--rule-soft)",
                                        fontSize: 11.5,
                                        color: "var(--ink-3)",
                                      }}
                                    >
                                      <span>
                                        Vol: {formatVolume(etf.volume)}
                                      </span>
                                      {etf.aum != null && (
                                        <span>
                                          AUM:{" "}
                                          {etf.aum >= 1000
                                            ? `${(etf.aum / 1000).toFixed(1)}K Cr`
                                            : `${etf.aum.toFixed(0)} Cr`}
                                        </span>
                                      )}
                                    </div>
                                  </Link>
                                  <div
                                    style={{
                                      padding: "0 16px 16px",
                                      marginTop: "auto",
                                    }}
                                  >
                                    <WatchlistPicker
                                      symbolKey={`${etf.symbol}:${etf.exchange}`}
                                      symbol={etf.symbol}
                                      exchange={etf.exchange}
                                      filteredWatchlists={mfWatchlists}
                                      watchlistType="MF"
                                      membership={
                                        watchlistMembership.get(
                                          `${etf.symbol}:${etf.exchange}`
                                        ) ?? new Set<string>()
                                      }
                                      isAdding={addingToWatchlist.has(
                                        `${etf.symbol}:${etf.exchange}`
                                      )}
                                      onAdd={handleAddToWatchlistById}
                                      onRemove={handleRemoveFromWatchlistById}
                                      onCreate={handleCreateAndAdd}
                                    />
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <PaginationControls
                          currentPage={etfsPage}
                          totalPages={totalEtfPages}
                          onPageChange={setEtfsPage}
                          pageSize={DISCOVER_PAGE_SIZE}
                          totalItems={filteredEtfs.length}
                          label="ETFs"
                        />
                      </div>
                    )}

                    {filteredIndices.length === 0 &&
                      filteredEtfs.length === 0 && (
                        <p
                          className="ser text-center py-12"
                          style={{ color: "var(--ink-3)", fontSize: 16 }}
                        >
                          {activeExchangeIndices
                            ? `No index or ETF data found for ${activeExchangeIndices}.`
                            : "No index or ETF data available. Run the instrument sync worker to populate this data."}
                        </p>
                      )}
                  </>
                )}
              </TabsContent>
            </Tabs>
          </div>
        </main>

        {/* Floating Compare Bar - MF/ETF/INDEX (playful surface) */}
        {selectedForCompare.size >= 1 && (
          <div
            className="fixed bottom-6 left-1/2 -translate-x-1/2 lg:ml-32 z-50 backdrop-blur flex items-center gap-3 max-w-[90vw] pf-card"
            style={{ padding: "10px 14px" }}
          >
            <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
              {Array.from(selectedForCompare.entries()).map(([id, d]) => (
                <Badge
                  key={id}
                  variant="secondary"
                  className="flex items-center gap-1.5 pl-2.5 pr-1 py-1 shrink-0 max-w-[180px]"
                >
                  <span className="truncate text-xs">{d.name}</span>
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1 py-0 h-4 shrink-0"
                  >
                    {d.fundType}
                  </Badge>
                  <button
                    onClick={() => toggleCompare(id, d.fundType, d.name)}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-[var(--rule-softer)] transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                size="sm"
                disabled={selectedForCompare.size < 2}
                onClick={() => {
                  const items = Array.from(selectedForCompare.entries()).map(
                    ([id, d]) => ({
                      fundType: d.fundType as "MF" | "ETF" | "INDEX",
                      fundId: id,
                    })
                  );
                  router.push(buildCompareUrl(items));
                }}
              >
                <LineChart className="h-3.5 w-3.5 mr-1.5" />
                Compare ({selectedForCompare.size})
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedForCompare(new Map())}
              >
                Clear
              </Button>
            </div>
          </div>
        )}

        {/* Floating Compare Bar - Stocks (playful surface) */}
        {selectedStocks.size >= 1 && selectedForCompare.size === 0 && (
          <div
            className="fixed bottom-6 left-1/2 -translate-x-1/2 lg:ml-32 z-50 backdrop-blur flex items-center gap-3 max-w-[90vw] pf-card"
            style={{ padding: "10px 14px" }}
          >
            <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
              {Array.from(selectedStocks.entries()).map(([sym, d]) => (
                <Badge
                  key={sym}
                  variant="secondary"
                  className="flex items-center gap-1.5 pl-2.5 pr-1 py-1 shrink-0 max-w-[180px]"
                >
                  <span className="truncate text-xs font-semibold">
                    {d.symbol}
                  </span>
                  <Badge
                    variant="outline"
                    className="text-[9px] px-1 py-0 h-4 shrink-0"
                  >
                    {d.exchange}
                  </Badge>
                  <button
                    onClick={() =>
                      toggleStockCompare(d.symbol, d.name, d.exchange)
                    }
                    className="ml-0.5 rounded-full p-0.5 hover:bg-[var(--rule-softer)] transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    disabled={selectedStocks.size < 2 || isComparingStocks}
                  >
                    {isComparingStocks ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <BarChart2 className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    Compare ({selectedStocks.size})
                  </Button>
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
                        color: "var(--ink)",
                      }}
                    >
                      Start Comparison Analysis
                    </AlertDialogTitle>
                    <AlertDialogDescription
                      className="ser"
                      style={{
                        fontSize: 16,
                        color: "var(--ink-2)",
                        lineHeight: 1.4,
                      }}
                    >
                      Compare{" "}
                      <span className="hl-gold">
                        {Array.from(selectedStocks.values())
                          .map((s) => s.symbol)
                          .join(" vs ")}
                      </span>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="pf-bf sm mt-0">
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      className="pf-bs sm"
                      onClick={async () => {
                        setIsComparingStocks(true);
                        const symbols = Array.from(selectedStocks.values()).map(
                          (s) => s.symbol
                        );
                        const query = `Compare ${symbols.join(" vs ")}`;
                        const result = await startResearchAction(
                          query,
                          "peer-comparison",
                          symbols,
                          "advanced"
                        );
                        if (result?.success && result.sessionId) {
                          router.push(`/analysis/${result.sessionId}`);
                        }
                        setIsComparingStocks(false);
                      }}
                    >
                      <Brain className="h-3.5 w-3.5 mr-1.5" />
                      Start Analysis
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedStocks(new Map())}
              >
                Clear
              </Button>
            </div>
          </div>
        )}

        <ResearchModal
          open={researchModalOpen}
          onOpenChange={setResearchModalOpen}
          entity={researchModalEntity}
        />
      </div>
    </PageGuard>
  );
}
