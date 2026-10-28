"use client";

/**
 * Screener - unified client for Stocks / MFs / ETFs (MONEY-196).
 *
 * Holds: mode state, search state, per-mode filter state, URL sync.
 * Delegates: mode-specific rendering to `stocks-mode.tsx`, `mf-mode.tsx`,
 *            `etf-mode.tsx`.
 *
 * URL state: `?mode=stocks|mf|etf&q=...&stocks.pe=10...&mf.aum=1000...`
 * - filter keys are prefixed by mode so switching modes doesn't leak state.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { Sparkles } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import { PfPageHead } from "@/components/playful/PfPageHead";
import { TakeTheTourButton } from "@/components/walkthrough";
import { SearchBar } from "@/components/screener/SearchBar";
import { ModeTabs, type ScreenerMode } from "@/components/screener/ModeTabs";
import { ScreenerInnerSkeleton } from "@/components/screener/InnerSkeleton";
import { toast } from "sonner";
import { AiFilterBuilderModal } from "@/components/screener/AiFilterBuilderModal";
import type { SavedScreenDetail } from "@/lib/actions/saved-screens";
import { SavedScreensControls } from "@/components/screener/SavedScreensControls";
import { StocksMode } from "./stocks-mode";
import { MfMode, type MfFilterOptions } from "./mf-mode";
import { EtfMode } from "./etf-mode";
import AskScreenerPanel from "./components/AskScreenerPanel";
import { ScreenerActionsProvider } from "./lib/chat/ScreenerActionsContext";
import {
  buildScreenerActions,
  buildScreenerSnapshot,
  type ScreenerLive,
} from "./lib/chat/bridge";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import { useOwnedRoute } from "@/lib/hooks/useOwnedRoute";
import type {
  ScreenFilters,
  ScreenResult,
  MfScreenFilters,
  MfScreenResult,
  EtfScreenFilters,
  EtfScreenResult,
  PagedResult,
} from "@/lib/actions/screener";
import {
  screenStocksAction,
  screenMfsAction,
  screenEtfsAction,
} from "@/lib/actions/screener";
import { getMfDiscoverDataAction } from "@/lib/actions/discover-mf";
import {
  buildInitialFetchGuard,
  consumeInitialFetchSkip,
  type InitialFetchGuard,
} from "./lib/initial-fetch-guard";
import { FundsBulkActionToolbar } from "@/components/screener/FundsBulkActionToolbar";
import { type CompareItem } from "@/lib/compare/schema";
import type { WatchlistTarget } from "@/components/watchlist/WatchlistPopover";

export interface SectorOption {
  name: string;
  count: number;
}

interface ScreenerClientProps {
  initialMode: ScreenerMode;
  initialQuery: string;
  initialStocksFilters: ScreenFilters;
  initialStocksPage: PagedResult<ScreenResult>;
  initialMfFilters: MfScreenFilters;
  initialMfPage: PagedResult<MfScreenResult>;
  initialEtfFilters: EtfScreenFilters;
  initialEtfPage: PagedResult<EtfScreenResult>;
  /**
   * True when the server SUCCESSFULLY resolved `initialMode`'s first page with
   * exactly the props above. It gates the mount-time refetch skip: a screen
   * that timed out or failed server-side must still be retried here, or the
   * user is left staring at an empty table with nothing in flight.
   */
  initialPageSeeded: boolean;
  sectorOptions: readonly SectorOption[];
  mfOptions: MfFilterOptions;
  counts: {
    stocks: number;
    mf: number;
    etf: number;
  };
}

const MODE_TABS_BASE = [
  { id: "stocks" as const, label: "Stocks" },
  { id: "mf" as const, label: "Mutual Funds" },
  { id: "etf" as const, label: "ETFs" },
];

/** Compact integer formatter: "2,100" / "14k" / "150". */
function formatCount(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString("en-IN");
}

/**
 * Surface a failed screener fetch instead of swallowing it.
 *
 * Every refetch used to be `if (result.success) setPage(...)` with no else,
 * so a server-side failure left the PREVIOUS rows on screen with no error —
 * the filter chip lit up, the count never moved, and it read as "the filter
 * does nothing". That is exactly how an outage in the fundamental-filter
 * path (P/E, ROE, market cap…) stayed invisible.
 *
 * A stable per-mode toast id means a re-firing effect REPLACES the toast
 * rather than stacking one per attempt.
 */
function notifyScreenFailure(mode: ScreenerMode, error?: string): void {
  toast.error(error || "Couldn't run this screen.", {
    id: `screener-fetch-${mode}`,
    description: "Showing the previous results — they may be out of date.",
  });
}

function placeholderForMode(mode: ScreenerMode): string {
  if (mode === "mf") return "Search SBI Bluechip, HDFC Mid-Cap Opp…";
  if (mode === "etf") return "Search NIFTYBEES, GOLDBEES, BANKBEES…";
  return "Search RELIANCE, INFY, HDFC Bank…";
}

/** Encode filters/query/mode as a URL search string for `syncSearch`. */
function buildUrlState(
  mode: ScreenerMode,
  query: string,
  stocksFilters: ScreenFilters,
  mfFilters: MfScreenFilters,
  etfFilters: EtfScreenFilters
): string {
  const params = new URLSearchParams();
  params.set("mode", mode);
  if (query) params.set("q", query);
  if (mode === "stocks") {
    if (stocksFilters.exchange)
      params.set("stocks.exchange", stocksFilters.exchange);
    if (stocksFilters.sector) params.set("stocks.sector", stocksFilters.sector);
    if (stocksFilters.marketCapBucket)
      params.set("stocks.mcap", stocksFilters.marketCapBucket);
    // Explicit ₹-crore market-cap bounds. The sidebar only offers the
    // LARGE/MID/SMALL bucket, but the screen state (and the Ask Screener
    // chat, which can set an exact band) supports min/max — without these
    // two the band silently vanished on reload or when sharing the URL.
    if (stocksFilters.minMarketCap != null)
      params.set("stocks.minMcap", String(stocksFilters.minMarketCap));
    if (stocksFilters.maxMarketCap != null)
      params.set("stocks.maxMcap", String(stocksFilters.maxMarketCap));
    if (stocksFilters.minPe != null)
      params.set("stocks.minPe", String(stocksFilters.minPe));
    if (stocksFilters.maxPe != null)
      params.set("stocks.maxPe", String(stocksFilters.maxPe));
    if (stocksFilters.minRoe != null)
      params.set("stocks.minRoe", String(stocksFilters.minRoe));
    if (stocksFilters.maxRoe != null)
      params.set("stocks.maxRoe", String(stocksFilters.maxRoe));
    if (stocksFilters.minRevenueGrowth != null)
      params.set("stocks.minRev", String(stocksFilters.minRevenueGrowth));
    if (stocksFilters.maxRevenueGrowth != null)
      params.set("stocks.maxRev", String(stocksFilters.maxRevenueGrowth));
    if (stocksFilters.minDebtToEquity != null)
      params.set("stocks.minDE", String(stocksFilters.minDebtToEquity));
    if (stocksFilters.maxDebtToEquity != null)
      params.set("stocks.maxDE", String(stocksFilters.maxDebtToEquity));
    // MONEY-779: persist the dividend-yield band so a shared/bookmarked URL
    // restores it (it was the one fundamental filter missing from the URL).
    if (stocksFilters.minDividendYield != null)
      params.set("stocks.minDiv", String(stocksFilters.minDividendYield));
    if (stocksFilters.maxDividendYield != null)
      params.set("stocks.maxDiv", String(stocksFilters.maxDividendYield));
    if (stocksFilters.index) params.set("stocks.index", stocksFilters.index);
  }
  const writeMfParams = mode === "mf";
  const writeEtfParams = mode === "etf";

  if (writeMfParams) {
    if (mfFilters.category) params.set("mf.category", mfFilters.category);
    if (mfFilters.amcName) params.set("mf.amc", mfFilters.amcName);
    if (mfFilters.amcAny && mfFilters.amcAny.length > 0)
      params.set("mf.amcAny", mfFilters.amcAny.join(","));
    if (mfFilters.plan) params.set("mf.plan", mfFilters.plan);
    if (mfFilters.riskLevel) params.set("mf.risk", mfFilters.riskLevel);
    if (mfFilters.fundType) params.set("mf.fundType", mfFilters.fundType);
    if (mfFilters.minAum != null)
      params.set("mf.minAum", String(mfFilters.minAum));
    if (mfFilters.maxAum != null)
      params.set("mf.maxAum", String(mfFilters.maxAum));
    if (mfFilters.minReturns1Y != null)
      params.set("mf.minR1", String(mfFilters.minReturns1Y));
    if (mfFilters.maxReturns1Y != null)
      params.set("mf.maxR1", String(mfFilters.maxReturns1Y));
    if (mfFilters.minReturns3Y != null)
      params.set("mf.minR3", String(mfFilters.minReturns3Y));
    if (mfFilters.maxReturns3Y != null)
      params.set("mf.maxR3", String(mfFilters.maxReturns3Y));
    if (mfFilters.minReturns5Y != null)
      params.set("mf.minR5", String(mfFilters.minReturns5Y));
    if (mfFilters.maxReturns5Y != null)
      params.set("mf.maxR5", String(mfFilters.maxReturns5Y));
    if (mfFilters.minExpenseRatio != null)
      params.set("mf.minExp", String(mfFilters.minExpenseRatio));
    if (mfFilters.maxExpenseRatio != null)
      params.set("mf.maxExp", String(mfFilters.maxExpenseRatio));
  }
  if (writeEtfParams) {
    if (etfFilters.exchange) params.set("etf.exchange", etfFilters.exchange);
    if (etfFilters.assetClass)
      params.set("etf.assetClass", etfFilters.assetClass);
    if (etfFilters.theme && etfFilters.theme.trim().length > 0)
      params.set("etf.theme", etfFilters.theme);
    if (etfFilters.amcName) params.set("etf.amc", etfFilters.amcName);
    if (etfFilters.category) params.set("etf.category", etfFilters.category);
    if (etfFilters.minAum != null)
      params.set("etf.minAum", String(etfFilters.minAum));
    if (etfFilters.maxAum != null)
      params.set("etf.maxAum", String(etfFilters.maxAum));
    if (etfFilters.minReturns1Y != null)
      params.set("etf.minR1", String(etfFilters.minReturns1Y));
    if (etfFilters.maxReturns1Y != null)
      params.set("etf.maxR1", String(etfFilters.maxReturns1Y));
    if (etfFilters.minExpenseRatio != null)
      params.set("etf.minExp", String(etfFilters.minExpenseRatio));
    if (etfFilters.maxExpenseRatio != null)
      params.set("etf.maxExp", String(etfFilters.maxExpenseRatio));
  }
  const str = params.toString();
  return str ? `?${str}` : "";
}

export default function ScreenerClient({
  initialMode,
  initialQuery,
  initialStocksFilters,
  initialStocksPage,
  initialMfFilters,
  initialMfPage,
  initialEtfFilters,
  initialEtfPage,
  initialPageSeeded,
  sectorOptions,
  mfOptions,
  counts,
}: ScreenerClientProps) {
  const router = useRouter();
  const ownedRoute = useOwnedRoute("/discover/screener");

  const [mode, setMode] = useState<ScreenerMode>(initialMode);
  const [query, setQuery] = useState(initialQuery);

  // Filters per mode
  const [stocksFilters, setStocksFilters] =
    useState<ScreenFilters>(initialStocksFilters);
  const [mfFilters, setMfFilters] = useState<MfScreenFilters>(initialMfFilters);
  const [etfFilters, setEtfFilters] =
    useState<EtfScreenFilters>(initialEtfFilters);

  // Paged results per mode - kept in lockstep with the server.
  const [stocksPage, setStocksPage] =
    useState<PagedResult<ScreenResult>>(initialStocksPage);
  const [mfPage, setMfPage] =
    useState<PagedResult<MfScreenResult>>(initialMfPage);
  const [etfPage, setEtfPage] =
    useState<PagedResult<EtfScreenResult>>(initialEtfPage);

  // Page index per mode - owned here so refetch on filter/query/sort change
  // can reset to page 0, while pagination clicks bump it.
  const [stocksPageIdx, setStocksPageIdx] = useState(initialStocksPage.page);
  const [mfPageIdx, setMfPageIdx] = useState(initialMfPage.page);
  const [etfPageIdx, setEtfPageIdx] = useState(initialEtfPage.page);

  // Funds selection - lifted out of MfMode + EtfMode so the user can mix
  // MFs and ETFs into a single Compare batch (they used to live as local
  // state per mode, which dropped when the user switched tabs). Two
  // separate Sets - one per mode - make rendering checked-state per row
  // cheap, while the FundsBulkActionToolbar renders once at this level
  // with the merged payload.
  const [selectedMf, setSelectedMf] = useState<Set<string>>(new Set());
  const [selectedEtf, setSelectedEtf] = useState<Set<string>>(new Set());
  // MONEY-553 — stock selection lifted to this level too, so a user can mix
  // stocks + funds into ONE cross-asset Compare batch that survives tab
  // switches (keyed by symbol, same as the stocks-mode rows).
  const [selectedStock, setSelectedStock] = useState<Set<string>>(new Set());

  // Sort key per mode - drives the server-side sort. Stays in sync with
  // the SortDropdown's localStorage hook via controlled mode.
  const [stocksSort, setStocksSort] = useState<string>("match");
  const [mfSort, setMfSort] = useState<string>("match");
  const [etfSort, setEtfSort] = useState<string>("match");

  // In-flight indicator per mode - drives the toolbar "loading" pulse.
  const [stocksLoading, setStocksLoading] = useState(false);
  const [mfLoading, setMfLoading] = useState(false);
  const [etfLoading, setEtfLoading] = useState(false);

  // Last refetch failure per mode, or null when the displayed rows are in
  // sync with the active filters. This is NOT just for the toast: it also
  // rides into the chat snapshot. Without it the assistant sees fresh
  // `filters` next to a stale `resultTotal`/`topResults` and confidently
  // quotes the PRE-filter count — the user gets a red "results may be out of
  // date" toast beside a chat message asserting the opposite.
  const [stocksError, setStocksError] = useState<string | null>(null);
  const [mfError, setMfError] = useState<string | null>(null);
  const [etfError, setEtfError] = useState<string | null>(null);

  // Monotonic counter bumped when a refetch SETTLES (success or failure).
  // `isFetching` alone cannot tell "the effect hasn't started yet" from
  // "already finished" — both read false — so the chat's waitForResults
  // relied on a fixed sleep and could snapshot pre-filter results. Waiting
  // for this number to CHANGE is deterministic.
  const [fetchGeneration, setFetchGeneration] = useState(0);
  const bumpGeneration = useCallback(
    () => setFetchGeneration((n) => n + 1),
    []
  );

  const [, startTransition] = useTransition();

  // Tab-badge counts derive from the LIVE paged `total` (same source as the
  // big "N stocks" / "N matches" badge each mode renders), falling back to the
  // SSR `counts` prop only until the first client fetch resolves. Reading the
  // static `counts` prop alone was the regression: it is computed by a
  // separate (heavier) server fetch — `getDiscoverDataAction`'s full
  // `latestQuote` scan + the MF/ETF discover calls — which times out on
  // client-side navigation (force-dynamic re-render under load), leaving the
  // prop at 0 while the live `total` was correct. Using the live total keeps
  // the tab badge in lockstep with the visible match count and self-heals on
  // navigation.
  //
  // `total` is 0 only before a fetch completes or when a query/filter genuinely
  // matches nothing; in the pre-fetch window we fall back to the SSR seed so
  // the badge never flashes 0 on first paint.
  const stocksTabCount =
    stocksPage.total > 0 ? stocksPage.total : counts.stocks;
  const mfTabCount = mfPage.total > 0 ? mfPage.total : counts.mf;
  const etfTabCount = etfPage.total > 0 ? etfPage.total : counts.etf;

  const tabs = useMemo(
    () => [
      { ...MODE_TABS_BASE[0]!, count: formatCount(stocksTabCount) },
      { ...MODE_TABS_BASE[1]!, count: formatCount(mfTabCount) },
      { ...MODE_TABS_BASE[2]!, count: formatCount(etfTabCount) },
    ],
    [stocksTabCount, mfTabCount, etfTabCount]
  );

  // ── Refetch effects - one per mode, all driven by the same triggers ──

  // Skip-first-render guard (MONEY-1131) — the effects below would otherwise
  // re-run, on mount, the exact screen the server just resolved into props.
  // Rules + rationale live with the helper.
  const skipInitialFetch = useRef<InitialFetchGuard>(
    buildInitialFetchGuard(initialMode, initialPageSeeded)
  );

  // Reset page to 0 whenever filters/query/sort change in a given mode
  // (the previous page index doesn't make sense in a new matched set).
  useEffect(() => {
    setStocksPageIdx(0);
  }, [stocksFilters, query, stocksSort]);
  useEffect(() => {
    setMfPageIdx(0);
  }, [mfFilters, query, mfSort]);
  useEffect(() => {
    setEtfPageIdx(0);
  }, [etfFilters, query, etfSort]);

  // Stocks: refetch on any state that affects the result set.
  useEffect(() => {
    if (mode !== "stocks") return;
    if (consumeInitialFetchSkip(skipInitialFetch.current, "stocks")) return;
    let cancelled = false;
    setStocksLoading(true);
    startTransition(async () => {
      const result = await screenStocksAction(stocksFilters, query, {
        page: stocksPageIdx,
        sort: stocksSort as never,
      });
      if (cancelled) return;
      if (result.success) {
        setStocksPage(result.data);
        setStocksError(null);
      } else {
        // Do NOT fail silently. Swallowing this is what let a total
        // screener outage look like "nothing happened": the previous rows
        // stayed on screen, the filter chip lit up, and the count never
        // moved. Tell the user the results are stale — AND record it so the
        // chat snapshot can tell the assistant the same thing.
        notifyScreenFailure("stocks", result.error);
        setStocksError(result.error || "The screen failed to refresh.");
      }
      setStocksLoading(false);
      bumpGeneration();
    });
    return () => {
      cancelled = true;
    };
  }, [mode, stocksFilters, query, stocksPageIdx, stocksSort]);

  // MFs - fetched on the `mf` tab.
  useEffect(() => {
    if (mode !== "mf") return;
    if (consumeInitialFetchSkip(skipInitialFetch.current, "mf")) return;
    let cancelled = false;
    setMfLoading(true);
    startTransition(async () => {
      const result = await screenMfsAction(mfFilters, query, {
        page: mfPageIdx,
        sort: mfSort as never,
      });
      if (cancelled) return;
      if (result.success) {
        setMfPage(result.data);
        setMfError(null);
      } else {
        notifyScreenFailure("mf", result.error);
        setMfError(result.error || "The screen failed to refresh.");
      }
      setMfLoading(false);
      bumpGeneration();
    });
    return () => {
      cancelled = true;
    };
  }, [mode, mfFilters, query, mfPageIdx, mfSort]);

  // ETFs - fetched on the `etf` tab.
  useEffect(() => {
    if (mode !== "etf") return;
    if (consumeInitialFetchSkip(skipInitialFetch.current, "etf")) return;
    let cancelled = false;
    setEtfLoading(true);
    startTransition(async () => {
      const result = await screenEtfsAction(etfFilters, query, {
        page: etfPageIdx,
        sort: etfSort as never,
      });
      if (cancelled) return;
      if (result.success) {
        setEtfPage(result.data);
        setEtfError(null);
      } else {
        notifyScreenFailure("etf", result.error);
        setEtfError(result.error || "The screen failed to refresh.");
      }
      setEtfLoading(false);
      bumpGeneration();
    });
    return () => {
      cancelled = true;
    };
  }, [mode, etfFilters, query, etfPageIdx, etfSort]);

  /**
   * MF filter options (Category / AMC), fetched on first entry to the MF tab
   * (MONEY-1131).
   *
   * The server only sends these when `?mode=mf` was the requested tab — they
   * feed dropdowns that do not exist on the other two tabs, and fetching them
   * for a tab nobody opened was one of the six SSR calls this ticket removed.
   * When they arrive empty (i.e. the user landed elsewhere and then clicked
   * Mutual Funds) we pull them once, here.
   *
   * A ref rather than a state dependency: keying the effect on the options
   * themselves would re-run it on its own result.
   */
  const [mfFilterOptions, setMfFilterOptions] =
    useState<MfFilterOptions>(mfOptions);
  const mfOptionsRequested = useRef(
    mfOptions.categories.length > 0 || mfOptions.amcList.length > 0
  );
  useEffect(() => {
    if (mode !== "mf" || mfOptionsRequested.current) return;
    mfOptionsRequested.current = true;
    let cancelled = false;
    void (async () => {
      const result = await getMfDiscoverDataAction();
      if (cancelled) return;
      if (result.success && result.data) {
        setMfFilterOptions({
          categories: result.data.categories ?? [],
          amcList: result.data.amcList ?? [],
        });
      } else {
        // Let a later tab visit try again rather than pinning empty dropdowns
        // for the rest of the session.
        mfOptionsRequested.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode]);

  // Sync URL whenever mode/query/filters change.
  //
  // CRITICAL: does NOT use `router.replace`. router.replace() goes through
  // Next's transition system and races with the router.push() from a row
  // click — the navigation to /stock/{symbol} gets yanked back to
  // /discover/screener when this effect fires during the transition
  // (MONEY-1082).
  //
  // Two things keep this safe, and both are load-bearing:
  //   1. The route-ownership guard inside useOwnedRoute — the write is
  //      dropped once the live pathname is no longer /discover/screener.
  //   2. Forwarding `window.history.state`, which carries Next's `__NA`
  //      marker. Next patches replaceState and only skips its router
  //      dispatch when that marker is present; called with `{}` or `null`
  //      it dispatches ACTION_RESTORE and IS a navigation. (The previous
  //      comment here claimed plain replaceState "never affects Next's
  //      routing state" — that is only true because of the marker.)
  // useOwnedRoute does both; see lib/navigation/url-sync-logic.ts.
  useEffect(() => {
    ownedRoute.syncSearch(
      buildUrlState(mode, query, stocksFilters, mfFilters, etfFilters)
    );
  }, [ownedRoute, mode, query, stocksFilters, mfFilters, etfFilters]);

  const handleModeChange = useCallback((next: ScreenerMode) => {
    // Clear query when switching modes to avoid nonsense cross-mode searches
    setMode(next);
    setQuery("");
    if (typeof window !== "undefined") {
      if (next === "mf") {
        window.dispatchEvent(new CustomEvent("walkthrough:screener-mode-mf"));
      } else if (next === "etf") {
        window.dispatchEvent(new CustomEvent("walkthrough:screener-mode-etf"));
      }
    }
  }, []);

  // Apply a loaded saved screen - flip to its mode + slot the filters
  // and query into the right state buckets. Type-cast is safe because
  // the SavedScreen.mode column is constrained to "stocks" | "mf" | "etf".
  const handleLoadSavedScreen = useCallback((screen: SavedScreenDetail) => {
    setMode(screen.mode);
    setQuery(screen.query ?? "");
    if (screen.mode === "stocks") {
      setStocksFilters(screen.filters as ScreenFilters);
    } else if (screen.mode === "mf") {
      setMfFilters(screen.filters as MfScreenFilters);
    } else if (screen.mode === "etf") {
      setEtfFilters(screen.filters as EtfScreenFilters);
    }
  }, []);

  const activeFilters: Record<string, unknown> =
    mode === "stocks"
      ? (stocksFilters as unknown as Record<string, unknown>)
      : mode === "mf"
        ? (mfFilters as unknown as Record<string, unknown>)
        : (etfFilters as unknown as Record<string, unknown>);

  // MONEY-1137: `user` gates the demo signal. Signed-out demo visitors still
  // get demo state (`user` is null for them); a signed-in user with a stale
  // `tradebook_demo_mode` flag no longer does.
  const { user } = useUser();
  const isDemoMode = useIsDemoMode({ user });

  const [aiBuilderOpen, setAiBuilderOpen] = useState(false);

  // Merge AI-generated filters into the active mode's existing filter
  // state. We *merge* (not replace) so users can iterate - start with
  // a manual filter set, ask AI to add a thesis, then tweak.
  const handleApplyAiFilters = useCallback(
    (incoming: Record<string, unknown>) => {
      if (mode === "stocks") {
        setStocksFilters((prev) => ({ ...prev, ...incoming }) as ScreenFilters);
      } else if (mode === "mf") {
        setMfFilters((prev) => ({ ...prev, ...incoming }) as MfScreenFilters);
      } else if (mode === "etf") {
        setEtfFilters((prev) => ({ ...prev, ...incoming }) as EtfScreenFilters);
      }
    },
    [mode]
  );

  const matchCount =
    mode === "stocks"
      ? stocksPage.total
      : mode === "mf"
        ? mfPage.total
        : etfPage.total;

  /* ── Ask Screener chat bridge (MONEY-1078) ──────────────────────────
     Expose the screener state + mutators to the chat's tool executor.
     `liveRef` is refreshed on EVERY render so the bridge (built once via
     useMemo) never reads a stale closure — same pattern as the FIRE page.

     Note the chat's `setMode` is the raw setter, NOT `handleModeChange`:
     a tab click clears the search query, but the chat may set a query and
     switch mode in one batched turn, where that would silently eat it. */
  const liveRef = useRef<ScreenerLive | null>(null);
  liveRef.current = {
    mode,
    query,
    stocksFilters,
    mfFilters,
    etfFilters,
    stocksSort,
    mfSort,
    etfSort,
    stocksRows: stocksPage.rows,
    mfRows: mfPage.rows,
    etfRows: etfPage.rows,
    stocksTotal: stocksPage.total,
    mfTotal: mfPage.total,
    etfTotal: etfPage.total,
    sectorOptions,
    mfCategories: mfFilterOptions.categories,
    mfAmcs: mfFilterOptions.amcList,
    setMode,
    setQuery,
    setStocksFilters,
    setMfFilters,
    setEtfFilters,
    setStocksSort,
    setMfSort,
    setEtfSort,
    isFetching:
      mode === "stocks"
        ? stocksLoading
        : mode === "mf"
          ? mfLoading
          : etfLoading,
    fetchError:
      mode === "stocks" ? stocksError : mode === "mf" ? mfError : etfError,
    fetchGeneration,
  };

  // Mode mirror updated SYNCHRONOUSLY by the chat's switchMode, so a
  // batched turn (setEtfFilters + setSort in one response) resolves the
  // second call against the new mode instead of the pre-render one.
  const chatModeRef = useRef<ScreenerMode>(mode);
  chatModeRef.current = mode;

  const screenerChat = useMemo(() => {
    const live = () => liveRef.current as ScreenerLive;
    const actions = buildScreenerActions(live);
    return {
      actions: {
        ...actions,
        switchMode: (next: ScreenerMode) => {
          chatModeRef.current = next;
          actions.switchMode(next);
        },
      },
      getSnapshot: () => buildScreenerSnapshot(live()),
      getActiveMode: () => chatModeRef.current,
      isFetching: () => live().isFetching,
      fetchGeneration: () => live().fetchGeneration,
    };
  }, []);

  // MONEY-392: chrome (Sidebar + max-w + Header) stays OUTSIDE PageGuard
  // so the header is visible across all 3 stages. PageGuard `bare` wraps
  // only the inner content (mode tabs + filters + results).
  // Header eyebrow mirrors the design's mono caps line; the universe
  // count comes from the live mode tab total so it is never faked.
  const headerEyebrow =
    mode === "stocks"
      ? `${formatCount(counts.stocks)} STOCKS · FUNDAMENTAL + SEARCH · LIVE NSE/BSE`
      : mode === "mf"
        ? `${formatCount(counts.mf)} MUTUAL FUNDS · CATEGORY · AMC · RETURNS`
        : `${formatCount(counts.etf)} ETFs · NSE/BSE · ASSET CLASS · AUM`;

  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-6 max-w-[1600px] mx-auto">
          {/* Playful page header (design: ScreenerScreen pf-ph) */}
          <PfPageHead
            eyebrow={headerEyebrow}
            title={
              <>
                Find the next <span className="ser">idea,</span>{" "}
                <span className="hl-gold">fast.</span>
              </>
            }
            sub="Stack fundamentals, search, and filters. Build the screen with AI, then save or export it."
            right={
              <>
                <span data-walkthrough="screener-take-tour">
                  <TakeTheTourButton version="v1-screener" />
                </span>
                {/* MONEY-611: saved-screens (full backend, was unmounted). */}
                <SavedScreensControls
                  mode={mode}
                  filters={activeFilters}
                  query={query}
                  isDemoMode={isDemoMode}
                  onLoad={handleLoadSavedScreen}
                />
                <button
                  type="button"
                  className="pf-bs"
                  onClick={() => setAiBuilderOpen(true)}
                  data-walkthrough="screener-ai-builder"
                >
                  <Sparkles size={13} /> Build with AI
                </button>
              </>
            }
          />

          <PageGuard
            route="/discover"
            bare
            fallback={<ScreenerInnerSkeleton />}
          >
            <div data-walkthrough="screener-modes">
              <ModeTabs tabs={tabs} active={mode} onChange={handleModeChange} />
            </div>

            {/* Search bar - full-width per design Image #58. */}
            <div
              className="mt-4 mb-5 w-full"
              data-walkthrough="screener-filters"
            >
              <SearchBar
                value={query}
                onChange={setQuery}
                placeholder={placeholderForMode(mode)}
              />
            </div>

            {/* v3.2 removed the legacy "MATCHES 200 stocks" badge row; the
                matches count + status line live inside each mode component
                now. MONEY-611: Save / Saved screens are mounted in the page
                header's action cluster (right of "Build with AI"). */}

            {/* Mode body */}
            <div data-walkthrough="screener-results">
              {mode === "stocks" && (
                <StocksMode
                  filters={stocksFilters}
                  onFiltersChange={setStocksFilters}
                  results={stocksPage.rows}
                  total={stocksPage.total}
                  page={stocksPageIdx}
                  onPageChange={setStocksPageIdx}
                  sort={stocksSort}
                  onSortChange={setStocksSort}
                  loading={stocksLoading}
                  sectorOptions={sectorOptions}
                  selected={selectedStock}
                  setSelected={setSelectedStock}
                  otherSelectedCount={selectedMf.size + selectedEtf.size}
                />
              )}
              {mode === "mf" && (
                <MfMode
                  filters={mfFilters}
                  onFiltersChange={setMfFilters}
                  results={mfPage.rows}
                  total={mfPage.total}
                  page={mfPageIdx}
                  onPageChange={setMfPageIdx}
                  sort={mfSort}
                  onSortChange={setMfSort}
                  loading={mfLoading}
                  options={mfFilterOptions}
                  onModeChange={handleModeChange}
                  selected={selectedMf}
                  setSelected={setSelectedMf}
                  otherSelectedCount={selectedEtf.size + selectedStock.size}
                />
              )}
              {mode === "etf" && (
                <EtfMode
                  filters={etfFilters}
                  onFiltersChange={setEtfFilters}
                  results={etfPage.rows}
                  total={etfPage.total}
                  page={etfPageIdx}
                  onPageChange={setEtfPageIdx}
                  sort={etfSort}
                  onSortChange={setEtfSort}
                  loading={etfLoading}
                  onModeChange={handleModeChange}
                  selected={selectedEtf}
                  setSelected={setSelectedEtf}
                  otherSelectedCount={selectedMf.size + selectedStock.size}
                />
              )}
            </div>
            {/* MONEY-553 — unified cross-asset Compare bar. Pulls from stock +
              MF + ETF selection so a user can flip between tabs, accumulate
              items of ANY type, and Compare them on /compare in one batch.
              Rendered on every mode so a cross-asset selection stays actionable
              from whichever tab the user is on. */}
            <ScreenerCompareBar
              selectedStock={selectedStock}
              selectedMf={selectedMf}
              selectedEtf={selectedEtf}
              stockRows={stocksPage.rows}
              mfRows={mfPage.rows}
              etfRows={etfPage.rows}
              onClearStock={() => setSelectedStock(new Set())}
              onClearMf={() => setSelectedMf(new Set())}
              onClearEtf={() => setSelectedEtf(new Set())}
            />
          </PageGuard>
        </div>
      </main>

      {/* Ask Screener — slide-in chat sidebar (MONEY-1077 UI, MONEY-1078
          wiring). The provider hands the panel the live screener state so
          the chat's tools can drive filters, query, sort, and mode. */}
      <ScreenerActionsProvider value={screenerChat}>
        <AskScreenerPanel mode={mode} />
      </ScreenerActionsProvider>

      {aiBuilderOpen && (
        <AiFilterBuilderModal
          mode={mode}
          onClose={() => setAiBuilderOpen(false)}
          onApply={handleApplyAiFilters}
        />
      )}
    </div>
  );
}

/**
 * Unified cross-asset Compare bar (MONEY-553). Lives at the screener-client
 * level so a user can flip between the Stocks and Funds&ETFs tabs, accumulate
 * a selection of ANY mix of stocks / MFs / ETFs, and Compare them together on
 * /compare in a single batch.
 *
 * Stock + ETF rows are tracked by `symbol` (looked back up here to recover the
 * `exchange` for the `{ symbol, exchange, kind: "STOCK" }` watchlist target —
 * ETFs share the STOCK watchlist kind backend-side). MF rows are tracked by
 * `schemeCode`. The watchlist popover heading (`displayKind`) is asset-specific
 * only for a homogeneous selection; any cross-asset mix shows the generic label.
 */
function ScreenerCompareBar({
  selectedStock,
  selectedMf,
  selectedEtf,
  stockRows,
  mfRows,
  etfRows,
  onClearStock,
  onClearMf,
  onClearEtf,
}: {
  selectedStock: ReadonlySet<string>;
  selectedMf: ReadonlySet<string>;
  selectedEtf: ReadonlySet<string>;
  stockRows: readonly ScreenResult[];
  mfRows: readonly MfScreenResult[];
  etfRows: readonly EtfScreenResult[];
  onClearStock: () => void;
  onClearMf: () => void;
  onClearEtf: () => void;
}) {
  const compareItems: CompareItem[] = [
    ...Array.from(selectedStock).map((symbol) => ({
      fundType: "STOCK" as const,
      fundId: symbol,
    })),
    ...Array.from(selectedMf).map((schemeCode) => ({
      fundType: "MF" as const,
      fundId: schemeCode,
    })),
    ...Array.from(selectedEtf).map((symbol) => ({
      fundType: "ETF" as const,
      fundId: symbol,
    })),
  ];

  const watchlistTargets: WatchlistTarget[] = [
    ...Array.from(selectedStock).flatMap<WatchlistTarget>((symbol) => {
      const row = stockRows.find((r) => r.symbol === symbol);
      if (!row) return [];
      return [{ symbol: row.symbol, exchange: row.exchange, kind: "STOCK" }];
    }),
    ...Array.from(selectedMf).map<WatchlistTarget>((schemeCode) => ({
      symbol: schemeCode,
      exchange: "MF",
      kind: "MF" as const,
    })),
    ...Array.from(selectedEtf).flatMap<WatchlistTarget>((symbol) => {
      const row = etfRows.find((r) => r.symbol === symbol);
      if (!row) return [];
      return [{ symbol: row.symbol, exchange: row.exchange, kind: "STOCK" }];
    }),
  ];

  // Asset-specific watchlist heading only for a homogeneous selection; any
  // cross-asset mix (the MONEY-553 case) shows the generic label.
  const onlyMf =
    selectedMf.size > 0 && selectedEtf.size === 0 && selectedStock.size === 0;
  const onlyEtf =
    selectedEtf.size > 0 && selectedMf.size === 0 && selectedStock.size === 0;
  const displayKind: "MF" | "ETF" | undefined = onlyMf
    ? "MF"
    : onlyEtf
      ? "ETF"
      : undefined;

  function downloadCsv() {
    const pickedStock = stockRows.filter((r) => selectedStock.has(r.symbol));
    const pickedMf = mfRows.filter((r) => selectedMf.has(r.schemeCode));
    const pickedEtf = etfRows.filter((r) => selectedEtf.has(r.symbol));
    const lines: string[] = [];
    if (pickedStock.length > 0) {
      lines.push(
        [
          "kind",
          "symbol",
          "exchange",
          "name",
          "sector",
          "ltp",
          "pe",
          "marketCap",
        ].join(",")
      );
      for (const r of pickedStock) {
        lines.push(
          [
            "STOCK",
            r.symbol,
            r.exchange,
            `"${(r.name ?? "").replace(/"/g, '""')}"`,
            `"${(r.sector ?? "").replace(/"/g, '""')}"`,
            r.ltp ?? "",
            r.pe ?? "",
            r.marketCap ?? "",
          ].join(",")
        );
      }
    }
    if (pickedMf.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(
        ["kind", "schemeCode", "schemeName", "amcName", "category", "nav"].join(
          ","
        )
      );
      for (const r of pickedMf) {
        lines.push(
          [
            "MF",
            r.schemeCode,
            `"${(r.schemeName ?? "").replace(/"/g, '""')}"`,
            `"${(r.amcName ?? "").replace(/"/g, '""')}"`,
            `"${(r.category ?? "").replace(/"/g, '""')}"`,
            r.nav ?? "",
          ].join(",")
        );
      }
    }
    if (pickedEtf.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(["kind", "symbol", "exchange", "name", "ltp"].join(","));
      for (const r of pickedEtf) {
        lines.push(
          [
            "ETF",
            r.symbol,
            r.exchange,
            `"${(r.name ?? "").replace(/"/g, '""')}"`,
            r.ltp ?? "",
          ].join(",")
        );
      }
    }
    if (lines.length === 0) return;
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "");
    a.href = url;
    a.download = `screener-compare-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <FundsBulkActionToolbar
      compareItems={compareItems}
      watchlistTargets={watchlistTargets}
      displayKind={displayKind}
      onDownloadCsv={downloadCsv}
      onClear={() => {
        onClearStock();
        onClearMf();
        onClearEtf();
      }}
    />
  );
}
