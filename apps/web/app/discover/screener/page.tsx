/**
 * Screener - server component (MONEY-196).
 *
 * - Parses URL query string for initial mode + filters + search
 * - Fetches the ACTIVE tab's results + its filter options
 * - Fetches sector list for the Sector filter dropdown
 *
 * ## Only the active tab is screened (MONEY-1131)
 *
 * This page used to `Promise.all` SIX heavy calls on EVERY load — all three
 * screens (stocks + ~14k MFs + ETFs), the full ~7,400-row Discover universe,
 * the MF filter-option payload and a 200-row ETF list — regardless of which tab
 * the user asked for. Two of those three screens were rendered by nobody: the
 * client's per-mode effect re-runs the screen when you switch tabs anyway, so
 * their only output was a tab badge.
 *
 * What survives, per load:
 *   - `getDiscoverSummary()` — sector counts + universe SIZE, the row-free
 *     companion of the Discover universe entry (never the rows).
 *   - the ACTIVE tab's screen, and for the MF tab its option lists.
 *   - `getScreenerUniverseCountsAction()` — two cached `count()`s for the two
 *     badges we are no longer screening for.
 *
 * The deferred pieces are picked up client-side the moment their tab is
 * selected (see client.tsx: the per-mode refetch effects, and the lazy MF
 * option load).
 */

import {
  screenStocksAction,
  screenMfsAction,
  screenEtfsAction,
  getScreenerUniverseCountsAction,
  type ScreenFilters,
  type MfScreenFilters,
  type EtfScreenFilters,
  type ScreenResult,
  type MfScreenResult,
  type EtfScreenResult,
  type PagedResult,
} from "@/lib/actions/screener";
import { getAllSectorNames } from "@usemoney/core";
import { getDiscoverSummary } from "@usemoney/services";
import { getMfDiscoverDataAction } from "@/lib/actions/discover-mf";
import ScreenerClient from "./client";
import type { ScreenerMode } from "@/components/screener/ModeTabs";
import { withTimeout } from "@/lib/utils/with-timeout";

// Keep dynamic so filter+query combos don't get incorrectly cached at the
// route level. Individual action calls still use their own Redis cache.
export const dynamic = "force-dynamic";

export const metadata = {
  // MONEY-394 N - bare title; root layout's metadata.title.template
  // (`%s | UseMoney`) adds the suffix.
  title: "Screener",
  description:
    "Find stocks, mutual funds, and ETFs by fundamental filters + search.",
};

function parseMode(raw: string | undefined): ScreenerMode {
  if (raw === "mf" || raw === "etf") return raw;
  return "stocks";
}

function parseNumberParam(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseMfFilters(
  params: Record<string, string | string[] | undefined>
): MfScreenFilters {
  const plan = params["mf.plan"];
  const amcAnyRaw = params["mf.amcAny"];
  const amcAny =
    typeof amcAnyRaw === "string" && amcAnyRaw.length > 0
      ? amcAnyRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  return {
    category:
      typeof params["mf.category"] === "string"
        ? (params["mf.category"] as string)
        : undefined,
    amcName:
      typeof params["mf.amc"] === "string"
        ? (params["mf.amc"] as string)
        : undefined,
    amcAny,
    plan: plan === "DIRECT" || plan === "REGULAR" ? plan : undefined,
    riskLevel:
      typeof params["mf.risk"] === "string"
        ? (params["mf.risk"] as string)
        : undefined,
    fundType:
      typeof params["mf.fundType"] === "string"
        ? (params["mf.fundType"] as string)
        : undefined,
    minAum: parseNumberParam(params["mf.minAum"] as string | undefined),
    maxAum: parseNumberParam(params["mf.maxAum"] as string | undefined),
    minReturns1Y: parseNumberParam(params["mf.minR1"] as string | undefined),
    maxReturns1Y: parseNumberParam(params["mf.maxR1"] as string | undefined),
    minReturns3Y: parseNumberParam(params["mf.minR3"] as string | undefined),
    maxReturns3Y: parseNumberParam(params["mf.maxR3"] as string | undefined),
    minReturns5Y: parseNumberParam(params["mf.minR5"] as string | undefined),
    maxReturns5Y: parseNumberParam(params["mf.maxR5"] as string | undefined),
    minExpenseRatio: parseNumberParam(
      params["mf.minExp"] as string | undefined
    ),
    maxExpenseRatio: parseNumberParam(
      params["mf.maxExp"] as string | undefined
    ),
  };
}

function parseEtfFilters(
  params: Record<string, string | string[] | undefined>
): EtfScreenFilters {
  const exchange = params["etf.exchange"];
  return {
    exchange: exchange === "NSE" || exchange === "BSE" ? exchange : undefined,
    assetClass:
      typeof params["etf.assetClass"] === "string"
        ? (params["etf.assetClass"] as string)
        : undefined,
    theme:
      typeof params["etf.theme"] === "string"
        ? (params["etf.theme"] as string)
        : undefined,
    // ETF AMC + Category are name-derived (no DB column today). The
    // server applies them post-fetch using etf-derive.ts; URL state
    // round-trips so deep-links + back/forward survive.
    amcName:
      typeof params["etf.amc"] === "string"
        ? (params["etf.amc"] as string)
        : undefined,
    category:
      typeof params["etf.category"] === "string"
        ? (params["etf.category"] as string)
        : undefined,
    minAum: parseNumberParam(params["etf.minAum"] as string | undefined),
    maxAum: parseNumberParam(params["etf.maxAum"] as string | undefined),
    minReturns1Y: parseNumberParam(params["etf.minR1"] as string | undefined),
    maxReturns1Y: parseNumberParam(params["etf.maxR1"] as string | undefined),
    minExpenseRatio: parseNumberParam(
      params["etf.minExp"] as string | undefined
    ),
    maxExpenseRatio: parseNumberParam(
      params["etf.maxExp"] as string | undefined
    ),
  };
}

function parseStocksFilters(
  params: Record<string, string | string[] | undefined>
): ScreenFilters {
  const exchange = params["stocks.exchange"];
  const mcapBucket = params["stocks.mcap"];
  return {
    // Default to NSE - the most-used Indian exchange. Users can flip to
    // BSE or "Both" via the UNIVERSE block in the filter sidebar.
    exchange:
      exchange === "BSE" || exchange === "BOTH"
        ? exchange === "BOTH"
          ? undefined
          : exchange
        : "NSE",
    sector:
      typeof params["stocks.sector"] === "string"
        ? (params["stocks.sector"] as string)
        : undefined,
    marketCapBucket:
      mcapBucket === "LARGE" || mcapBucket === "MID" || mcapBucket === "SMALL"
        ? mcapBucket
        : undefined,
    // Explicit ₹-crore bounds — the counterpart to buildUrlState's
    // stocks.minMcap / stocks.maxMcap. Without these the chat-set band was
    // written to the URL but dropped on the way back in.
    minMarketCap: parseNumberParam(
      params["stocks.minMcap"] as string | undefined
    ),
    maxMarketCap: parseNumberParam(
      params["stocks.maxMcap"] as string | undefined
    ),
    minPe: parseNumberParam(params["stocks.minPe"] as string | undefined),
    maxPe: parseNumberParam(params["stocks.maxPe"] as string | undefined),
    minRoe: parseNumberParam(params["stocks.minRoe"] as string | undefined),
    maxRoe: parseNumberParam(params["stocks.maxRoe"] as string | undefined),
    minRevenueGrowth: parseNumberParam(
      params["stocks.minRev"] as string | undefined
    ),
    maxRevenueGrowth: parseNumberParam(
      params["stocks.maxRev"] as string | undefined
    ),
    minDebtToEquity: parseNumberParam(
      params["stocks.minDE"] as string | undefined
    ),
    maxDebtToEquity: parseNumberParam(
      params["stocks.maxDE"] as string | undefined
    ),
    // MONEY-779: dividend yield (percentage) — mirror of buildUrlState's
    // stocks.minDiv / stocks.maxDiv keys.
    minDividendYield: parseNumberParam(
      params["stocks.minDiv"] as string | undefined
    ),
    maxDividendYield: parseNumberParam(
      params["stocks.maxDiv"] as string | undefined
    ),
    // Index membership (UniverseSection) - resolved server-side via
    // resolveIndexSymbols(). DB-backed once index-constituent-sync runs;
    // falls back to static + mcap-rank lists in the meantime.
    index:
      typeof params["stocks.index"] === "string" &&
      (params["stocks.index"] as string).length > 0
        ? (params["stocks.index"] as string)
        : undefined,
  };
}

export default async function ScreenerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const mode = parseMode(params.mode as string | undefined);
  const query = typeof params.q === "string" ? params.q : "";
  const stocksFilters = parseStocksFilters(params);
  const mfFilters = parseMfFilters(params);
  const etfFilters = parseEtfFilters(params);

  // Only the active tab is screened; the other two are the client's job.
  const wantsStocks = mode === "stocks";
  const wantsMf = mode === "mf";
  const wantsEtf = mode === "etf";

  const [
    stocksResult,
    mfScreenResult,
    etfScreenResult,
    summaryResult,
    mfDiscoverResult,
    universeCounts,
  ] = await Promise.all([
    wantsStocks
      ? withTimeout(screenStocksAction(stocksFilters, query, { page: 0 }), 6000)
      : Promise.resolve(null),
    wantsMf
      ? withTimeout(screenMfsAction(mfFilters, query, { page: 0 }), 6000)
      : Promise.resolve(null),
    wantsEtf
      ? withTimeout(screenEtfsAction(etfFilters, query, { page: 0 }), 6000)
      : Promise.resolve(null),
    // Sector counts + universe size only. The full `allStocks` payload this
    // used to arrive inside is never read here — see getDiscoverSummary.
    withTimeout(getDiscoverSummary(), 6000),
    // NAV-fresh, bounded query (see getAllDirectFundsData) — give it the same
    // 6s headroom as the other discover fetches so a cold-cache run never
    // times out and empties the Category / AMC filter dropdowns.
    wantsMf
      ? withTimeout(getMfDiscoverDataAction(), 6000)
      : Promise.resolve(null),
    // Two cached counts for the badges of the tabs we did NOT screen. The
    // stocks badge keeps its own source: the displayable universe size
    // (instruments WITH a LatestQuote and a non-MF name), which matches the
    // Discover page's "All Stocks 7395" badge. Counting InstrumentMapping
    // directly would overstate it — dev has 14k+ quote-less rows the screener
    // silently filters out.
    withTimeout(getScreenerUniverseCountsAction(), 4000),
  ]);

  const emptyStocksPage: PagedResult<ScreenResult> = {
    rows: [],
    total: 0,
    page: 0,
    pageSize: 25,
  };
  const emptyMfPage: PagedResult<MfScreenResult> = {
    rows: [],
    total: 0,
    page: 0,
    pageSize: 25,
  };
  const emptyEtfPage: PagedResult<EtfScreenResult> = {
    rows: [],
    total: 0,
    page: 0,
    pageSize: 25,
  };
  const initialStocksPage: PagedResult<ScreenResult> = stocksResult?.success
    ? stocksResult.data
    : emptyStocksPage;
  const initialMfPage: PagedResult<MfScreenResult> = mfScreenResult?.success
    ? mfScreenResult.data
    : emptyMfPage;
  const initialEtfPage: PagedResult<EtfScreenResult> = etfScreenResult?.success
    ? etfScreenResult.data
    : emptyEtfPage;

  // Sector options with counts, from the Discover summary entry; fall back to
  // the canonical taxonomy with count=0 when it is unavailable (cold cache,
  // DB outage).
  //
  // MONEY-1157 — the guard is COUNT-aware, not LENGTH-aware. `getUniverseData`
  // returns a NON-EMPTY, all-zero facet array on BOTH its success path and its
  // catch path, so `length > 0` (14 > 0) accepted a caught DB error as an
  // authoritative "every sector has 0 stocks" — and `SectorChips` then filtered
  // all 14 away for having `count === 0`, leaving no chip strip and no clue why.
  const summaryData = summaryResult?.success ? summaryResult.data : null;
  const sectorsFromDiscover = summaryData?.sectors ?? [];
  const sectorCountsResolved = sectorsFromDiscover.some((s) => s.count > 0);

  // The other half: a caught error must be DISTINGUISHABLE from genuinely thin
  // data. `degraded` is a sentinel the service sets only on its catch path —
  // never inferred from the counts, because a cold environment legitimately has
  // all-zero counts and would otherwise be reported as an outage.
  if (summaryData?.degraded) {
    console.warn(
      "/discover/screener: sector facets are the DEGRADED fallback - the " +
        "discover universe scan failed (see 'stock discover data fetch " +
        "failed' in the service logs). Rendering the canonical sector list " +
        "with no counts."
    );
  }

  const sectorOptions: Array<{ name: string; count: number }> =
    sectorCountsResolved
      ? sectorsFromDiscover
      : getAllSectorNames().map((name) => ({ name, count: 0 }));

  // MF filter options - categories with counts and AMC list, both already
  // sorted by getMfDiscoverData (categories by count desc, AMCs by frequency).
  const mfOptions = {
    categories: mfDiscoverResult?.success
      ? (mfDiscoverResult.data?.categories ?? [])
      : [],
    amcList: mfDiscoverResult?.success
      ? (mfDiscoverResult.data?.amcList ?? [])
      : [],
  };

  // Stocks count = displayable universe (`allStocks.length`, carried by the
  // summary as `stockCount`). This is what users actually see in the screener
  // and matches the Discover page's "All Stocks 7395" badge in prod. Falls
  // back to the action's `total` when the summary is unavailable.
  const stocksTotalCandidate = summaryResult?.success
    ? (summaryResult.data?.stockCount ?? 0)
    : (initialStocksPage.total ?? 0);

  // MF / ETF badges are UNIVERSE sizes, the same semantics the stocks badge
  // has always had. They used to be read off a full screen of a tab nobody had
  // opened; now they are two cached counts over the same predicates those
  // screens use with no filters. The instant a user opens either tab the
  // client swaps in the live matched total (see `mfTabCount` / `etfTabCount`),
  // so this is a first-paint hint, never the displayed match count.
  const counts = {
    stocks: stocksTotalCandidate,
    mf: universeCounts?.mf ?? initialMfPage.total,
    etf: universeCounts?.etf ?? initialEtfPage.total,
  };

  // Did the server actually resolve the active tab's first page? Only then may
  // the client skip its mount-time refetch — a timed-out or failed screen must
  // still be retried client-side rather than leaving an empty table.
  const activeResult = wantsStocks
    ? stocksResult
    : wantsMf
      ? mfScreenResult
      : etfScreenResult;
  const initialPageSeeded = activeResult?.success === true;

  return (
    <ScreenerClient
      initialMode={mode}
      initialQuery={query}
      initialStocksFilters={stocksFilters}
      initialStocksPage={initialStocksPage}
      initialMfFilters={mfFilters}
      initialMfPage={initialMfPage}
      initialEtfFilters={etfFilters}
      initialEtfPage={initialEtfPage}
      initialPageSeeded={initialPageSeeded}
      sectorOptions={sectorOptions}
      mfOptions={mfOptions}
      counts={counts}
    />
  );
}
