"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { useUser } from "@clerk/nextjs";
import { DemoBanner, DemoGate } from "@/components/DemoBanner";
import {
  TrendingUp,
  TrendingDown,
  Search,
  X,
  Target,
  Activity,
  Loader2,
  Sparkles,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { Button } from "@usemoney/ui/button";
import { Input } from "@usemoney/ui/input";
import { Textarea } from "@usemoney/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@usemoney/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@usemoney/ui/tabs";
import { toast } from "sonner";
import { Separator } from "@usemoney/ui/separator";
import { TradingViewAdvancedChart } from "@/components/charts";
import { useQuote, useMarketData } from "@/hooks";
import {
  placeOrderAction,
  getPaperDashboardStatsAction,
} from "@/lib/actions/paper";
import { generateStrategyAction } from "@/lib/actions/strategy";
import { getWatchlistsAction } from "@/lib/actions/watchlist";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import {
  getDiscoverDataAction,
  type DiscoverStock,
} from "@/lib/actions/discover";
import { getSubscriptionAction } from "@/lib/actions/subscription";
import { useSidebar } from "@/components/SidebarContext";
import Link from "next/link";

interface WatchlistInfo {
  id: string;
  name: string;
  type: string;
  items: { symbol: string; exchange: string }[];
}

// Period selection now lives in TradingView's built-in resolution toolbar.

// Manual strategy presets
const MANUAL_STRATEGIES = [
  { id: "sma_crossover", name: "SMA Crossover (9/21)" },
  { id: "ema_crossover", name: "EMA Crossover (12/26)" },
  { id: "rsi", name: "RSI Strategy" },
  { id: "bollinger", name: "Bollinger Bands" },
  { id: "macd", name: "MACD Strategy" },
  { id: "golden_cross", name: "Golden Cross (50/200)" },
];

// Stock item shape used in the terminal list
interface TerminalStock {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  yahooSymbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  dayHigh: number;
  dayLow: number;
  sector?: string;
}

const formatINR = (val: number) =>
  `₹${Math.abs(val).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

const formatPnL = (val: number) =>
  `${val >= 0 ? "+" : "-"}₹${Math.abs(val).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export default function PaperTradingClient() {
  const { collapsed, toggleSidebar } = useSidebar();
  const { user } = useUser();

  const isDemoMode = useIsDemoMode({ user });

  // Subscription plan
  const [planId, setPlanId] = useState<string>("FREE");
  const isFreeUser = !isDemoMode && planId === "FREE";

  // Stats
  const [stats, setStats] = useState<{
    cash: number;
    portfolioValue: number;
    totalPnl: number;
    winRate: number;
    openPositions: number;
  } | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  // All stocks loaded once from Discover data (same as Discover page)
  const [allStocks, setAllStocks] = useState<DiscoverStock[]>([]);
  const [topGainers, setTopGainers] = useState<DiscoverStock[]>([]);
  const [topLosers, setTopLosers] = useState<DiscoverStock[]>([]);
  const [stocksLoading, setStocksLoading] = useState(true);

  // Client-side search query (no API calls - instant filtering)
  const [query, setQuery] = useState("");

  // Watchlists + list source dropdown
  const [watchlists, setWatchlists] = useState<WatchlistInfo[]>([]);
  // "stocks" = default popular stocks, "wl:<id>" = a watchlist
  const [listSource, setListSource] = useState("stocks");

  // Selected stock for chart
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [selectedStockName, setSelectedStockName] = useState("");

  // Strategy panel - expanded by default when sidebar is collapsed (fullscreen)
  const [strategyPanelOpen, setStrategyPanelOpen] = useState(collapsed);
  const [activeStrategyName, setActiveStrategyName] = useState("");

  // AI Strategy
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Trade dialog
  const [tradeDialogOpen, setTradeDialogOpen] = useState(false);
  const [selectedStock, setSelectedStock] = useState<TerminalStock | null>(
    null
  );
  const [tradeAction, setTradeAction] = useState<"BUY" | "SELL">("BUY");
  const [quantity, setQuantity] = useState("1");
  const [orderType, setOrderType] = useState<
    "MARKET" | "LIMIT" | "SL" | "SL_M"
  >("MARKET");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [targetPrice, setTargetPrice] = useState("");
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);

  // Live quote for selected symbol
  const { quote: liveQuote } = useQuote(selectedSymbol || "");

  // Load stats + watchlists + all stocks (once on mount)
  useEffect(() => {
    async function loadStats() {
      try {
        const result = await getPaperDashboardStatsAction();
        if (result?.success && result?.data) {
          setStats({
            cash: result?.data.portfolio.cash,
            portfolioValue:
              result?.data.positions.totalCurrentValue +
              result?.data.portfolio.cash,
            totalPnl: result?.data.positions.totalPnl,
            winRate: result?.data.performance.winRate,
            openPositions: result?.data.positions.open,
          });
        }
      } catch {
        // fallback
      } finally {
        setStatsLoading(false);
      }
    }
    async function loadWatchlists() {
      try {
        const result = await getWatchlistsAction();
        if (result?.success && result?.data) {
          setWatchlists(
            result?.data
              .filter((w) => w.type === "STOCK")
              .map((w) => ({
                id: w.id,
                name: w.name,
                type: w.type,
                items: w.items.map((i) => ({
                  symbol: i.symbol,
                  exchange: i.exchange,
                })),
              }))
          );
        }
      } catch {
        // ignore
      }
    }
    async function loadStocks() {
      try {
        const result = await getDiscoverDataAction();
        if (result?.success && result?.data) {
          // Only keep equities with volume/marketCap (same filter as Discover)
          // MONEY-1093: ETFs are paper-tradeable. The nightly backfill now
          // retypes mis-typed ETFs out of EQUITY, and a bare === "EQUITY" test
          // dropped them from this picker — an instrument that trades on the
          // exchange like any share, silently unavailable to simulate.
          const stocks = result?.data.allStocks.filter(
            (s) =>
              (s.instrumentType === "EQUITY" || s.instrumentType === "ETF") &&
              (s.volume || s.marketCap)
          );
          setAllStocks(stocks);
          setTopGainers(result?.data.topGainers);
          setTopLosers(result?.data.topLosers);
        }
      } catch {
        // ignore
      } finally {
        setStocksLoading(false);
      }
    }
    async function loadSubscription() {
      try {
        const result = await getSubscriptionAction();
        if (result?.success && result?.data) {
          setPlanId(result?.data.planId);
        }
      } catch {
        // keep FREE on error
      }
    }
    loadStats();
    loadWatchlists();
    loadStocks();
    loadSubscription();
  }, []);

  const refetchStats = useCallback(async () => {
    const result = await getPaperDashboardStatsAction();
    if (result?.success && result?.data) {
      setStats({
        cash: result?.data.portfolio.cash,
        portfolioValue:
          result?.data.positions.totalCurrentValue +
          result?.data.portfolio.cash,
        totalPnl: result?.data.positions.totalPnl,
        winRate: result?.data.performance.winRate,
        openPositions: result?.data.positions.open,
      });
    }
  }, []);

  const cash = stats?.cash ?? 1000000;
  const totalPnl = stats?.totalPnl ?? 0;
  const winRate = stats?.winRate ?? 0;
  const openPositions = stats?.openPositions ?? 0;
  const portfolioValue = stats?.portfolioValue ?? 1000000;

  // Active watchlist (when a watchlist is selected)
  const activeWatchlist = useMemo(() => {
    if (!listSource.startsWith("wl:")) return null;
    const wlId = listSource.slice(3);
    return watchlists.find((w) => w.id === wlId) ?? null;
  }, [listSource, watchlists]);

  // Symbols to fetch live quotes for (only when viewing a watchlist)
  const watchlistSymbols = useMemo(() => {
    return activeWatchlist?.items.map((i) => i.symbol) ?? [];
  }, [activeWatchlist]);

  const { quotes: watchlistQuotes, isLoading: watchlistQuotesLoading } =
    useMarketData(watchlistSymbols, {
      interval: 15000,
      enablePolling: watchlistSymbols.length > 0,
    });

  // Convert DiscoverStock to TerminalStock
  const toTerminalStock = useCallback(
    (s: DiscoverStock): TerminalStock => ({
      symbol: s.symbol,
      name: s.name,
      exchange: s.exchange,
      type: s.instrumentType,
      yahooSymbol: s.yahooSymbol,
      price: s.price,
      change: s.change,
      changePercent: s.changePercent,
      volume: s.volume ?? 0,
      dayHigh: 0,
      dayLow: 0,
      sector: s.sector ?? undefined,
    }),
    []
  );

  // Stock list: client-side filtering (same approach as Discover page)
  const filteredStocks: TerminalStock[] = useMemo(() => {
    // If viewing a watchlist, show its items with live prices
    if (activeWatchlist) {
      const watchlistStockList = activeWatchlist.items.map((item) => {
        const quote = watchlistQuotes.get(item.symbol);
        // Try to find the stock in allStocks for richer data
        const match = allStocks.find((s) => s.symbol === item.symbol);
        return {
          symbol: item.symbol,
          name: match?.name || quote?.name || item.symbol,
          exchange: item.exchange,
          type: "EQUITY",
          yahooSymbol: match?.yahooSymbol || "",
          price: quote?.price ?? match?.price ?? 0,
          change: quote?.change ?? match?.change ?? 0,
          changePercent: quote?.changePercent ?? match?.changePercent ?? 0,
          volume: quote?.volume ?? match?.volume ?? 0,
          dayHigh: quote?.high ?? 0,
          dayLow: quote?.low ?? 0,
        };
      });
      if (!query.trim()) return watchlistStockList;
      // Filter watchlist items by search query
      const q = query.trim().toLowerCase();
      return watchlistStockList.filter(
        (s) =>
          s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
      );
    }

    // Top Gainers / Top Losers view
    if (listSource === "gainers" || listSource === "losers") {
      const sourceList = listSource === "gainers" ? topGainers : topLosers;
      if (!query.trim()) return sourceList.map(toTerminalStock);
      const q = query.trim().toLowerCase();
      return sourceList
        .filter(
          (s) =>
            s.symbol.toLowerCase().includes(q) ||
            s.name.toLowerCase().includes(q)
        )
        .map(toTerminalStock);
    }

    // Default stocks view with client-side search filtering
    let stocks = allStocks;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      stocks = allStocks.filter(
        (s) =>
          s.symbol.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          (s.sector && s.sector.toLowerCase().includes(q))
      );
    }
    return stocks.slice(0, 50).map(toTerminalStock);
  }, [
    query,
    activeWatchlist,
    watchlistQuotes,
    allStocks,
    topGainers,
    topLosers,
    listSource,
    toTerminalStock,
  ]);

  const selectStock = useCallback((stock: TerminalStock) => {
    setSelectedSymbol(stock.symbol);
    setSelectedStockName(stock.name);
  }, []);

  const openTrade = useCallback(
    (stock: TerminalStock, action: "BUY" | "SELL") => {
      setSelectedStock(stock);
      setTradeAction(action);
      setQuantity("1");
      setLimitPrice(stock.price.toString());
      setStopLoss("");
      setTargetPrice("");
      setPlaceError(null);
      setTradeDialogOpen(true);
    },
    []
  );

  const executeTrade = useCallback(async () => {
    if (!selectedStock) return;
    const qty = parseInt(quantity);
    if (isNaN(qty) || qty <= 0) return;

    setPlacing(true);
    setPlaceError(null);

    try {
      const result = await placeOrderAction({
        symbol: selectedStock.symbol,
        name: selectedStock.name,
        exchange: "NSE",
        instrumentType: "EQUITY",
        side: tradeAction,
        orderType,
        quantity: qty,
        price:
          orderType !== "MARKET"
            ? parseFloat(limitPrice) || undefined
            : undefined,
        stopLoss: stopLoss ? parseFloat(stopLoss) : undefined,
        target: targetPrice ? parseFloat(targetPrice) : undefined,
        strategy: activeStrategyName || undefined,
      });

      if (result?.success) {
        toast.success("Order placed successfully");
        setTradeDialogOpen(false);
        refetchStats();
      } else {
        setPlaceError(result?.error || "Failed to place order");
      }
    } catch {
      setPlaceError("Failed to place order");
    } finally {
      setPlacing(false);
    }
  }, [
    selectedStock,
    quantity,
    tradeAction,
    orderType,
    limitPrice,
    stopLoss,
    targetPrice,
    activeStrategyName,
    refetchStats,
  ]);

  const handleAiGenerate = useCallback(async () => {
    if (!aiPrompt.trim()) return;
    setAiGenerating(true);
    setAiError(null);

    try {
      const result = await generateStrategyAction(aiPrompt);
      if (result?.success && result?.data) {
        setActiveStrategyName(result?.data.name || "AI Strategy");
        setAiPrompt("");
        toast.success("Strategy generated!");
      } else {
        setAiError(result?.error || "Failed to generate strategy");
      }
    } catch {
      setAiError("Failed to generate strategy");
    } finally {
      setAiGenerating(false);
    }
  }, [aiPrompt]);

  const clearStrategy = useCallback(() => {
    setActiveStrategyName("");
  }, []);

  if (statsLoading) {
    return (
      <div className="pf-app flex items-center justify-center py-20">
        <Loader2
          className="h-6 w-6 animate-spin"
          style={{ color: "var(--ink-3)" }}
        />
      </div>
    );
  }

  return (
    <div className="pf-app flex flex-col gap-4">
      {isDemoMode && <DemoBanner />}

      {/* Stat strip (design: PaperTerminalScreen / pf-stat) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 12,
        }}
        data-walkthrough="paper-kpis"
      >
        <div
          className="pf-card pf-stat flat"
          style={{ background: "var(--rule-softer)" }}
        >
          <div className="l">AVAILABLE CASH</div>
          <div className="v" style={{ fontSize: 20 }}>
            {formatINR(cash)}
          </div>
        </div>
        <div
          className="pf-card pf-stat flat"
          style={{ background: "var(--rule-softer)" }}
        >
          <div className="l">PORTFOLIO VALUE</div>
          <div className="v" style={{ fontSize: 20 }}>
            {formatINR(portfolioValue)}
          </div>
        </div>
        <div
          className="pf-card pf-stat flat"
          style={{
            background: "var(--emerald-bg)",
            borderColor: "var(--emerald)",
          }}
        >
          <div className="l">TOTAL P&amp;L</div>
          <div
            className="v"
            style={{
              fontSize: 20,
              color: totalPnl >= 0 ? "var(--emerald-text)" : "#b91c1c",
            }}
          >
            {formatPnL(totalPnl)}
          </div>
        </div>
        <div
          className="pf-card pf-stat flat"
          style={{ background: "var(--rule-softer)" }}
        >
          <div className="l">WIN RATE</div>
          <div className="v" style={{ fontSize: 20 }}>
            {winRate.toFixed(1)}%
          </div>
        </div>
        <div
          className="pf-card pf-stat flat"
          style={{ background: "var(--rule-softer)" }}
        >
          <div className="l">OPEN POSITIONS</div>
          <div className="v" style={{ fontSize: 20 }}>
            {openPositions}
          </div>
        </div>
      </div>

      {/* Main content: Stock list + Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
        {/* Left: Stock list */}
        <div
          className="lg:col-span-1 flex flex-col gap-3 min-h-0"
          data-walkthrough="paper-stocklist"
        >
          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4"
              style={{ color: "var(--ink-3)", zIndex: 1 }}
            />
            <Input
              placeholder="Search stocks..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pf-input"
              style={{ paddingLeft: 34 }}
            />
            {query && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2"
                style={{ color: "var(--ink-3)" }}
                onClick={() => setQuery("")}
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Source dropdown: Stocks + Gainers/Losers + Watchlists */}
          <Select value={listSource} onValueChange={setListSource}>
            <SelectTrigger className="h-8 text-xs bg-muted border-border text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-muted border-border">
              <SelectItem value="stocks">All Stocks</SelectItem>
              <SelectItem value="gainers">
                <span className="flex items-center gap-1.5">
                  <TrendingUp className="h-3 w-3 text-emerald-400" />
                  Top Gainers
                </span>
              </SelectItem>
              <SelectItem value="losers">
                <span className="flex items-center gap-1.5">
                  <TrendingDown className="h-3 w-3 text-red-400" />
                  Top Losers
                </span>
              </SelectItem>
              {watchlists.length > 0 && (
                <>
                  <Separator className="my-1 bg-muted" />
                  {watchlists.map((wl) => (
                    <SelectItem key={wl.id} value={`wl:${wl.id}`}>
                      {wl.name}
                      <span className="text-muted-foreground ml-1.5">
                        ({wl.items.length})
                      </span>
                    </SelectItem>
                  ))}
                </>
              )}
            </SelectContent>
          </Select>

          {/* Stock list */}
          <div
            className="pf-card flex-1 overflow-hidden"
            style={{ padding: 0 }}
          >
            <div
              className={`h-full overflow-y-auto ${collapsed ? "max-h-[75vh]" : "max-h-[60vh]"}`}
            >
              <div>
                {filteredStocks.map((stock) => (
                  <div
                    key={stock.symbol}
                    className="cursor-pointer transition-colors"
                    onClick={() => selectStock(stock)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: 12,
                      gap: 8,
                      borderBottom: "1px dashed var(--rule-soft)",
                      borderLeft:
                        selectedSymbol === stock.symbol
                          ? "2px solid var(--emerald)"
                          : "2px solid transparent",
                      background:
                        selectedSymbol === stock.symbol
                          ? "var(--emerald-bg)"
                          : "transparent",
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="tk truncate" style={{ fontSize: 13 }}>
                        {stock.symbol}
                      </p>
                      <p
                        className="truncate"
                        style={{ fontSize: 11.5, color: "var(--ink-3)" }}
                      >
                        {stock.name}
                      </p>
                    </div>
                    <div className="text-right ml-2 shrink-0">
                      <p
                        style={{
                          fontSize: 13,
                          fontFamily: "JetBrains Mono, monospace",
                          color: "var(--ink)",
                        }}
                      >
                        {stock.price > 0 ? formatINR(stock.price) : "—"}
                      </p>
                      <p
                        style={{
                          fontSize: 11,
                          fontFamily: "JetBrains Mono, monospace",
                          color:
                            stock.change >= 0
                              ? "var(--emerald-text)"
                              : "#b91c1c",
                        }}
                      >
                        {stock.changePercent !== 0
                          ? `${stock.changePercent >= 0 ? "+" : ""}${stock.changePercent.toFixed(2)}%`
                          : "—"}
                      </p>
                    </div>
                    <DemoGate
                      isDemoMode={isDemoMode}
                      message="Sign up to trade"
                    >
                      <div className="flex flex-col gap-1 ml-2 shrink-0">
                        <button
                          className="pf-bf sm"
                          style={{
                            padding: "3px 8px",
                            fontSize: 10,
                            color: "var(--emerald-text)",
                            borderColor: "var(--emerald)",
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            openTrade(stock, "BUY");
                          }}
                        >
                          BUY
                        </button>
                        <button
                          className="pf-bf sm danger"
                          style={{ padding: "3px 8px", fontSize: 10 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            openTrade(stock, "SELL");
                          }}
                        >
                          SELL
                        </button>
                      </div>
                    </DemoGate>
                  </div>
                ))}
                {filteredStocks.length === 0 &&
                  !stocksLoading &&
                  !watchlistQuotesLoading && (
                    <div
                      style={{
                        padding: 24,
                        textAlign: "center",
                        color: "var(--ink-3)",
                        fontSize: 13,
                      }}
                    >
                      {activeWatchlist
                        ? "No items in this watchlist"
                        : "No stocks found"}
                    </div>
                  )}
                {stocksLoading &&
                  !activeWatchlist &&
                  filteredStocks.length === 0 && (
                    <div style={{ padding: 24, textAlign: "center" }}>
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto" />
                    </div>
                  )}
                {watchlistQuotesLoading &&
                  activeWatchlist &&
                  filteredStocks.length > 0 && (
                    <div style={{ padding: 8, textAlign: "center" }}>
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground mx-auto" />
                    </div>
                  )}
              </div>
            </div>
          </div>
        </div>

        {/* Right: Chart + Strategy */}
        <div
          className="lg:col-span-2 flex flex-col gap-3 min-h-0"
          data-walkthrough="paper-chart"
        >
          {selectedSymbol ? (
            <>
              {/* Chart header with price + actions */}
              <div
                className="pf-card"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "12px 16px",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div>
                    <h2
                      style={{
                        fontSize: 20,
                        fontWeight: 800,
                        color: "var(--ink)",
                        fontFamily: "JetBrains Mono, monospace",
                        letterSpacing: -0.5,
                      }}
                    >
                      {selectedSymbol}
                    </h2>
                    <p style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      {selectedStockName}
                    </p>
                  </div>
                  {liveQuote && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 20,
                          fontFamily: "JetBrains Mono, monospace",
                          fontWeight: 700,
                          color: "var(--ink)",
                        }}
                      >
                        {formatINR(liveQuote.price)}
                      </span>
                      <span
                        className={`pf-pill ${liveQuote.change >= 0 ? "emerald" : "coral"}`}
                        style={{ fontSize: 10 }}
                      >
                        {liveQuote.change >= 0 ? (
                          <TrendingUp className="h-3 w-3" />
                        ) : (
                          <TrendingDown className="h-3 w-3" />
                        )}
                        {liveQuote.change >= 0 ? "+" : ""}
                        {liveQuote.changePercent.toFixed(2)}%
                      </span>
                    </div>
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  {!isFreeUser && activeStrategyName && (
                    <span
                      className="pf-pill"
                      style={{
                        fontSize: 10,
                        background: "var(--pop-3)",
                        color: "var(--paper)",
                        borderColor: "var(--pop-3)",
                      }}
                    >
                      {activeStrategyName}
                      <button
                        onClick={clearStrategy}
                        style={{ display: "inline-flex", marginLeft: 4 }}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )}
                  {!isFreeUser && (
                    <button
                      className="pf-bf sm"
                      style={
                        strategyPanelOpen
                          ? { background: "var(--ink)", color: "var(--paper)" }
                          : undefined
                      }
                      onClick={() => setStrategyPanelOpen(!strategyPanelOpen)}
                    >
                      <Target className="h-3 w-3" />
                      Strategy
                      {strategyPanelOpen ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </button>
                  )}
                  <DemoGate isDemoMode={isDemoMode} message="Sign up to trade">
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <button
                        className="pf-bf sm"
                        style={{
                          color: "var(--emerald-text)",
                          borderColor: "var(--emerald)",
                        }}
                        onClick={() => {
                          const stock = filteredStocks.find(
                            (s) => s.symbol === selectedSymbol
                          );
                          if (stock) openTrade(stock, "BUY");
                        }}
                      >
                        BUY
                      </button>
                      <button
                        className="pf-bf sm danger"
                        onClick={() => {
                          const stock = filteredStocks.find(
                            (s) => s.symbol === selectedSymbol
                          );
                          if (stock) openTrade(stock, "SELL");
                        }}
                      >
                        SELL
                      </button>
                    </div>
                  </DemoGate>
                  <button
                    className="pf-bf sm hidden lg:flex"
                    style={{ padding: "6px 8px" }}
                    onClick={toggleSidebar}
                    title={collapsed ? "Expand sidebar" : "Fullscreen terminal"}
                  >
                    {collapsed ? (
                      <Minimize2 className="h-3.5 w-3.5" />
                    ) : (
                      <Maximize2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>

              {/* Strategy Panel (hidden for free users) */}
              {!isFreeUser && strategyPanelOpen && (
                <div className="pf-card" style={{ padding: 12 }}>
                  <div>
                    <Tabs defaultValue="manual" className="w-full">
                      <TabsList className="w-full h-8 bg-muted border-border">
                        <TabsTrigger
                          value="manual"
                          className="text-xs flex-1 gap-1.5 data-[state=active]:bg-muted"
                        >
                          <SlidersHorizontal className="h-3 w-3" />
                          Preset Strategies
                        </TabsTrigger>
                        <TabsTrigger
                          value="ai"
                          className="text-xs flex-1 gap-1.5 data-[state=active]:bg-muted"
                        >
                          <Sparkles className="h-3 w-3" />
                          AI Generate
                        </TabsTrigger>
                      </TabsList>

                      <TabsContent value="manual" className="mt-3">
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {MANUAL_STRATEGIES.map((s) => (
                            <Button
                              key={s.id}
                              size="sm"
                              variant={
                                activeStrategyName === s.name
                                  ? "default"
                                  : "outline"
                              }
                              className={`text-xs h-8 ${
                                activeStrategyName === s.name
                                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                                  : "border-border text-foreground/80 hover:bg-muted"
                              }`}
                              onClick={() => setActiveStrategyName(s.name)}
                            >
                              {s.name}
                            </Button>
                          ))}
                          {activeStrategyName && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-8 text-muted-foreground"
                              onClick={clearStrategy}
                            >
                              Clear
                            </Button>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-2">
                          Use the Indicators toolbar on the chart to add
                          technical indicators like SMA, EMA, MACD, RSI,
                          Bollinger Bands and more.
                        </p>
                      </TabsContent>

                      <TabsContent value="ai" className="mt-3">
                        <div className="flex gap-2">
                          <Textarea
                            placeholder="Describe your strategy... e.g. 'A swing trading strategy for volatile mid-cap stocks using MACD crossover with tight stop loss'"
                            value={aiPrompt}
                            onChange={(e) => setAiPrompt(e.target.value)}
                            className="min-h-[60px] text-xs resize-none flex-1 bg-muted border-border text-foreground placeholder:text-muted-foreground"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                handleAiGenerate();
                              }
                            }}
                          />
                          <Button
                            size="sm"
                            onClick={handleAiGenerate}
                            disabled={aiGenerating || !aiPrompt.trim()}
                            className="self-end gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
                          >
                            {aiGenerating ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Sparkles className="h-3.5 w-3.5" />
                            )}
                            Generate
                          </Button>
                        </div>
                        {aiError && (
                          <p className="text-xs text-red-400 mt-2">{aiError}</p>
                        )}
                      </TabsContent>
                    </Tabs>
                  </div>
                </div>
              )}

              {/* TradingViewAdvancedChart - gated for free users */}
              {isFreeUser ? (
                <div
                  className="pf-card flex-1"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    textAlign: "center",
                    padding: "64px 24px",
                  }}
                >
                  <div>
                    <Activity
                      className="h-10 w-10 mx-auto mb-3"
                      style={{ color: "var(--ink-3)" }}
                    />
                    <h3
                      style={{
                        fontSize: 18,
                        fontWeight: 800,
                        color: "var(--ink)",
                        marginBottom: 4,
                      }}
                    >
                      Charts available on Pro plan
                    </h3>
                    <p
                      style={{
                        fontSize: 13,
                        color: "var(--ink-3)",
                        marginBottom: 16,
                        maxWidth: 360,
                        marginInline: "auto",
                      }}
                    >
                      Upgrade to access real-time TradingView charts with
                      technical indicators, drawing tools, and strategy
                      overlays.
                    </p>
                    <Link
                      href="/pricing"
                      className="pf-bs sm"
                      style={{ display: "inline-flex" }}
                    >
                      View Plans →
                    </Link>
                  </div>
                </div>
              ) : (
                <div
                  className="flex-1 overflow-hidden"
                  style={{
                    borderRadius: 14,
                    border: "2px solid var(--ink)",
                    boxShadow: "var(--shadow-soft)",
                  }}
                >
                  <TradingViewAdvancedChart
                    symbol={selectedSymbol}
                    exchange="NSE"
                    height={collapsed ? 580 : 420}
                  />
                </div>
              )}
            </>
          ) : (
            <div
              className="pf-card flex-1"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                padding: "80px 24px",
              }}
            >
              <div>
                <Activity
                  className="h-12 w-12 mx-auto mb-4"
                  style={{ color: "var(--ink-3)" }}
                />
                <h3
                  style={{
                    fontSize: 18,
                    fontWeight: 800,
                    color: "var(--ink)",
                  }}
                >
                  Select a stock
                </h3>
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--ink-3)",
                    marginTop: 4,
                    maxWidth: 360,
                    marginInline: "auto",
                  }}
                >
                  {isFreeUser
                    ? "Click on any stock from the list to view details and place paper trades"
                    : "Click on any stock from the list to view its chart with indicators, drawing tools, and apply strategies"}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Trade Dialog */}
      <Dialog open={tradeDialogOpen} onOpenChange={setTradeDialogOpen}>
        <DialogContent
          className="sm:max-w-md"
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
              className="flex items-center gap-2"
              style={{
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: "-0.4px",
                color: "var(--ink)",
              }}
            >
              {tradeAction === "BUY" ? (
                <TrendingUp
                  className="h-5 w-5"
                  style={{ color: "var(--emerald)" }}
                />
              ) : (
                <TrendingDown
                  className="h-5 w-5"
                  style={{ color: "var(--pop-1)" }}
                />
              )}
              {tradeAction} {selectedStock?.symbol}
            </DialogTitle>
            <DialogDescription
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                letterSpacing: "0.5px",
              }}
            >
              {selectedStock?.name} -{" "}
              {selectedStock && selectedStock.price > 0
                ? formatINR(selectedStock.price)
                : "Market price"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* BUY / SELL toggle (design: order ticket) */}
            <div
              style={{
                display: "flex",
                border: "1.5px solid var(--ink)",
                borderRadius: 9,
                overflow: "hidden",
              }}
            >
              <button
                onClick={() => setTradeAction("BUY")}
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  fontFamily: "JetBrains Mono, monospace",
                  fontWeight: tradeAction === "BUY" ? 800 : 700,
                  fontSize: 13,
                  background:
                    tradeAction === "BUY" ? "var(--emerald)" : "var(--paper)",
                  color:
                    tradeAction === "BUY" ? "var(--paper)" : "var(--ink-3)",
                }}
              >
                BUY
              </button>
              <button
                onClick={() => setTradeAction("SELL")}
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  fontFamily: "JetBrains Mono, monospace",
                  fontWeight: tradeAction === "SELL" ? 800 : 700,
                  fontSize: 13,
                  background:
                    tradeAction === "SELL" ? "var(--pop-1)" : "var(--paper)",
                  color:
                    tradeAction === "SELL" ? "var(--paper)" : "var(--ink-3)",
                }}
              >
                SELL
              </button>
            </div>

            {/* Order type pills */}
            <div>
              <label
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "var(--ink-3)",
                  fontFamily: "JetBrains Mono, monospace",
                  letterSpacing: 0.5,
                }}
              >
                ORDER TYPE
              </label>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                {(
                  [
                    ["MKT", "MARKET"],
                    ["LMT", "LIMIT"],
                    ["SL", "SL"],
                    ["SL-M", "SL_M"],
                  ] as Array<[string, "MARKET" | "LIMIT" | "SL" | "SL_M"]>
                ).map(([label, val]) => {
                  const active = orderType === val;
                  return (
                    <button
                      key={val}
                      onClick={() => setOrderType(val)}
                      className={`pf-pill ${active ? "" : "outline"}`}
                      style={
                        active
                          ? { background: "var(--ink)", color: "var(--paper)" }
                          : { cursor: "pointer" }
                      }
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "var(--ink-3)",
                    fontFamily: "JetBrains Mono, monospace",
                    letterSpacing: 0.5,
                  }}
                >
                  QUANTITY
                </label>
                <Input
                  type="number"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  min="1"
                  className="pf-input"
                  style={{ marginTop: 5 }}
                />
              </div>
              {orderType !== "MARKET" && (
                <div>
                  <label
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: "var(--ink-3)",
                      fontFamily: "JetBrains Mono, monospace",
                      letterSpacing: 0.5,
                    }}
                  >
                    PRICE
                  </label>
                  <Input
                    type="number"
                    value={limitPrice}
                    onChange={(e) => setLimitPrice(e.target.value)}
                    className="pf-input"
                    style={{ marginTop: 5 }}
                  />
                </div>
              )}
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "var(--ink-3)",
                    fontFamily: "JetBrains Mono, monospace",
                    letterSpacing: 0.5,
                  }}
                >
                  STOP LOSS
                </label>
                <Input
                  type="number"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(e.target.value)}
                  placeholder="Optional"
                  className="pf-input"
                  style={{ marginTop: 5 }}
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "var(--ink-3)",
                    fontFamily: "JetBrains Mono, monospace",
                    letterSpacing: 0.5,
                  }}
                >
                  TARGET
                </label>
                <Input
                  type="number"
                  value={targetPrice}
                  onChange={(e) => setTargetPrice(e.target.value)}
                  placeholder="Optional"
                  className="pf-input"
                  style={{ marginTop: 5 }}
                />
              </div>
            </div>

            {activeStrategyName && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--ink-3)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Target className="h-3 w-3" />
                Strategy:{" "}
                <span style={{ fontWeight: 700, color: "var(--ink)" }}>
                  {activeStrategyName}
                </span>
              </div>
            )}

            {/* Trade value strip (design: gold pop strip) */}
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                background: "var(--pop-2)",
                border: "1.5px solid var(--ink)",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 12,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#3a3a35" }}>Estimated cost</span>
                <span style={{ fontWeight: 800, color: "#1d1d1b" }}>
                  {formatINR(
                    (selectedStock?.price || 0) * parseInt(quantity || "0")
                  )}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#3a3a35" }}>Available cash</span>
                <span style={{ fontWeight: 800, color: "#1d1d1b" }}>
                  {formatINR(cash)}
                </span>
              </div>
            </div>

            {placeError && <p className="text-sm text-red-400">{placeError}</p>}
            <DemoGate
              isDemoMode={isDemoMode}
              message="Sign up to place paper trades"
            >
              <button
                className="pf-bs"
                style={{
                  width: "100%",
                  justifyContent: "center",
                  ...(tradeAction === "SELL"
                    ? {
                        background: "var(--pop-1)",
                        borderColor: "var(--pop-1)",
                        color: "var(--paper)",
                      }
                    : {}),
                }}
                onClick={executeTrade}
                disabled={placing}
              >
                {placing ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                ) : null}
                Place paper {tradeAction} →
              </button>
            </DemoGate>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
