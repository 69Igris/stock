/**
 * Market Symbol Search API
 *
 * GET /api/market/search?q=reliance
 * GET /api/market/search?q=reliance&limit=20
 *
 * Searches for symbols matching the query.
 * Primary: Atlas Search (fuzzy, relevance-scored) - production on MongoDB Atlas
 * Fallback: Prisma contains (regex) - local/QA on DigitalOcean
 * Last resort: Yahoo Finance + hardcoded mappings
 *
 * MONEY-980 — US securities are a FOURTH leg, over the separate
 * `us_instruments` collection, with the same Atlas-then-Prisma fallback
 * discipline (see `@/lib/market/us-instrument-search`). DELISTED listings are
 * returned rather than hidden: they rank last and carry `listingStatus` +
 * `listingEndDate`. That visibility is the product decision the on-request
 * cold-storage load depends on — a security nobody can find is a security
 * nobody can ask us to load.
 *
 * ## US rows are DOUBLE-gated: the PostHog flag AND an explicit `includeUs=true`
 *
 * This comment used to say those extra fields were there "so a UI can badge
 * `DELISTED · 2017`". No UI does. `CommandPalette` maps the payload down to
 * `{symbol, name, exchange, type}` and drops all three, then routes the pick to
 * `/stock/{symbol}?exchange=NYSE`, which resolves against
 * `prisma.instrumentMapping` only and synthesises `DOW.NS` when it misses.
 * `InstrumentSearch` — the component behind `AddTradeDialog`,
 * `AddMutualFundDialog` and the watchlist — writes the pick into records only
 * India machinery resolves. So a US row reaching either of them is not a
 * missing badge; it is a US security persisted as an Indian one.
 *
 * `includeUs` (see `parseIncludeUs`) is therefore an OPT-IN, default OFF, and
 * no shipped surface opts in yet. The flag says whether the feature exists for
 * a user; the parameter says whether the calling surface can represent a US
 * row. `filterUsResults` remains the backstop for a leg that forgets both.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiLogger as logger } from "@usemoney/logger";
import { isDemoSession } from "@/lib/demo/session";
import { searchSymbols } from "@/lib/market/yahoo-client";
import {
  searchInstruments,
  getAvailableIndices,
  POPULAR_STOCKS,
} from "@/lib/market/symbol-mapper";
import {
  searchInstrumentsAtlas,
  searchMutualFundsAtlas,
} from "@/lib/market/atlas-search";
import { searchUsInstruments } from "@/lib/market/us-instrument-search";
import { INDIA_DISCOVER_EXCHANGES } from "@usemoney/core/market-data/instruments/types";
import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core";
import { getUsFeatureFlags } from "@/lib/actions/feature-flags";
import {
  type SearchResultItem,
  parseSearchLimit,
  parseIncludeIndices,
  parseIncludeUs,
  parseTypes,
  isQueryValid,
  getWantedTypes,
  mapAtlasInstrument,
  mapPrismaInstrument,
  mapAtlasMf,
  mapPrismaMf,
  mapPopularStocks,
  mapPopularIndices,
  mapUsInstrument,
  usAssetTypesForTypes,
  US_RESULT_LIMIT,
  filterIndianYahooResults,
  matchLocalIndices,
  filterUsResults,
  presortNseFirst,
  dedupeResults,
  rankSearchResults,
  capIndexRows,
  resolveSearchSource,
} from "./search-logic";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    // Authenticate user or demo session
    const { userId } = await auth();
    const isDemo = !userId && (await isDemoSession());
    if (!userId && !isDemo) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get("q") || searchParams.get("query");
    const limit = parseSearchLimit(searchParams.get("limit"));
    const includeIndices = parseIncludeIndices(
      searchParams.get("includeIndices")
    );
    const types = parseTypes(searchParams.get("types"));
    const includeUs = parseIncludeUs(searchParams.get("includeUs"));

    // If no query, return popular stocks, MFs, and indices from DB (with fallback)
    // (India-only by construction — no US leg runs on this path.)
    if (!isQueryValid(query)) {
      return handlePopularResults(limit, types, includeIndices);
    }

    // US rows need BOTH gates. The PostHog flag is per-user and says whether
    // the feature exists for them; `includeUs` is per-surface and says whether
    // the caller can represent a US row without persisting it as an Indian one
    // (see the header). Resolving them into ONE value here means every
    // downstream use — the fetch gate, the result filter and the cache key —
    // reads the same decision and cannot drift.
    //
    // The flag is only consulted when the caller opted in, so the India-only
    // surfaces do not pay a PostHog round trip for an answer they ignore.
    const usAllowed = includeUs
      ? (await getUsFeatureFlags()).flags["us-stocks-search"]
      : false;

    // Search with query
    return handleSearch(query, limit, types, includeIndices, usAllowed);
  } catch (error) {
    logger.error({ error }, "Search API error");
    return NextResponse.json(
      { error: "Failed to search symbols" },
      { status: 500 }
    );
  }
}

// ============== POPULAR RESULTS (no query) ==============

async function handlePopularResults(
  limit: number,
  types: string[],
  includeIndices: boolean
) {
  // MONEY-980 review — `indices` is IN the key, and it has to be. This is a
  // `_global` scope: one entry serves EVERY user. `includeIndices` changes the
  // body (it decides the `unshift` below), and callers actively disagree —
  // `InstrumentAutocomplete` sends "false", `InstrumentSearch` sends true,
  // `CommandPalette` sends nothing (→ true). Without it, one caller's
  // index-bearing response was replayed for 300s to a caller that explicitly
  // excluded indices. `generateVersionHash` sorts the keys and uses them as the
  // `JSON.stringify` allow-list, so a field that is not here is not in the hash.
  const popularFilters = {
    limit,
    types: types.join(","),
    indices: includeIndices ? "1" : "0",
  };
  const cachedPopular = await getCached<{
    results: unknown[];
    count: number;
    source: string;
  }>("market", "_global", "popular", popularFilters);
  if (cachedPopular) {
    return NextResponse.json({
      success: true,
      query: "",
      ...cachedPopular,
      timestamp: new Date().toISOString(),
    });
  }

  let popularResults: SearchResultItem[] = [];

  const { wantEquity, wantMF, wantIndex, wantETF, wantDebt } =
    getWantedTypes(types);

  try {
    const instrumentTypes: string[] = [];
    if (wantEquity) instrumentTypes.push("EQUITY");
    if (wantETF) instrumentTypes.push("ETF");
    // Same reason as `atlasTypes` below: with no explicit filter this is a
    // "search everything" request, and a bond is a tradable instrument a user
    // can hold. `wantDebt` is only true when nothing was explicitly requested.
    if (wantDebt) instrumentTypes.push("DEBT");

    const [dbPopular, popularMFs] = await Promise.all([
      instrumentTypes.length > 0
        ? prisma.instrumentMapping.findMany({
            where: {
              isActive: true,
              instrumentType: { in: instrumentTypes },
              exchange: { in: ["NSE", "BSE"] },
            },
            select: {
              id: true,
              symbol: true,
              name: true,
              exchange: true,
              yahooSymbol: true,
              sector: true,
              instrumentType: true,
            },
            take: limit,
            orderBy: { symbol: "asc" },
          })
        : Promise.resolve([]),
      wantMF
        ? prisma.mutualFundMaster.findMany({
            where: { isActive: true, plan: "DIRECT" },
            select: {
              schemeCode: true,
              schemeName: true,
              amcName: true,
              category: true,
              nav: true,
            },
            take: 5,
            orderBy: { nav: "desc" },
          })
        : Promise.resolve([]),
    ]);

    if (dbPopular.length > 0) {
      popularResults = dbPopular.map((inst) => ({
        symbol: inst.symbol,
        name: inst.name,
        exchange: inst.exchange,
        type: inst.instrumentType,
        yahooSymbol: inst.yahooSymbol,
        instrumentId: inst.id,
        sector: inst.sector,
        instrumentType: inst.instrumentType,
      }));
    }

    if (popularMFs.length > 0) {
      popularResults.push(
        ...popularMFs.map((mf) => ({
          symbol: mf.schemeCode,
          name: mf.schemeName,
          exchange: mf.amcName,
          type: "MF",
          yahooSymbol: "",
          instrumentId: undefined,
          sector: mf.category,
          instrumentType: "MF",
        }))
      );
    }
  } catch {
    // DB unavailable - fall through to hardcoded
  }

  if (popularResults.length === 0 && wantEquity) {
    popularResults = mapPopularStocks(POPULAR_STOCKS, limit);
  }

  if (includeIndices && wantIndex) {
    const indices = mapPopularIndices(getAvailableIndices().slice(0, 5));
    popularResults.unshift(...indices);
  }

  const slicedPopular = popularResults.slice(0, limit);

  await setCached(
    "market",
    "_global",
    "popular",
    { results: slicedPopular, count: popularResults.length, source: "popular" },
    popularFilters
  );

  return NextResponse.json({
    success: true,
    query: "",
    results: slicedPopular,
    count: popularResults.length,
    source: "popular",
    timestamp: new Date().toISOString(),
  });
}

// ============== QUERY SEARCH ==============

async function handleSearch(
  query: string,
  limit: number,
  types: string[],
  includeIndices: boolean,
  /** Flag AND `includeUs=true`, already resolved by the caller. */
  usAllowed = false
) {
  const upperQuery = query.toUpperCase();

  // Check cache first.
  //
  // Everything that changes the BODY is in the key, and nothing that changes
  // the body may be left out — this is a `_global` scope, so one entry is
  // shared by EVERY user for 300s.
  //
  // `us`: `us-stocks-search` is a per-user PostHog flag and `includeUs` is a
  // per-caller parameter, so `usAllowed` differs between two simultaneous
  // requests for the same query. Without it the first US-bearing response is
  // replayed to every other caller, and the reverse starves the opted-in one.
  //
  // `indices`: MONEY-980 review. `includeIndices` decides whether
  // `matchLocalIndices` runs at all, and the callers disagree —
  // `useStockSearch` false, `InstrumentAutocomplete` "false",
  // `InstrumentSearch` true, `CommandPalette` unset (→ true). It was missing,
  // so a user who explicitly excluded indices was served another user's
  // index-bearing page.
  //
  // `generateVersionHash` sorts the keys and passes them to `JSON.stringify` as
  // the allow-list, so a field absent from this object is absent from the hash:
  // omissions are silent, never a collision the cache layer could notice.
  const searchFilters = {
    query: upperQuery,
    limit,
    types: types.join(","),
    us: usAllowed ? "1" : "0",
    indices: includeIndices ? "1" : "0",
  };
  const cachedSearch = await getCached<{
    results: unknown[];
    count: number;
    source: string;
  }>("market", "_global", "search", searchFilters);
  if (cachedSearch) {
    return NextResponse.json({
      success: true,
      query,
      ...cachedSearch,
      timestamp: new Date().toISOString(),
    });
  }

  const {
    wantEquity: searchWantEquity,
    wantMF: searchWantMF,
    wantIndex: searchWantIndex,
  } = getWantedTypes(types);

  // Build type filters for Atlas Search - pass exact requested types
  const atlasTypes: string[] = [];
  if (types.length > 0) {
    // Pass through the exact types requested
    if (types.includes("EQUITY")) atlasTypes.push("EQUITY");
    if (types.includes("ETF")) atlasTypes.push("ETF");
    if (types.includes("DEBT")) atlasTypes.push("DEBT");
  } else if (searchWantEquity) {
    // No explicit filter → search everything tradable, INCLUDING debt.
    //
    // MONEY-1093: "DEBT" was structurally unreachable here — nothing ever
    // pushed it — and this array becomes an Atlas `filter: [{ in: { path:
    // "instrumentType" } }]`. The `contains` fallback applies NO type filter at
    // all, so the two paths disagreed, and the Atlas-vs-fallback choice is a
    // substring test on the connection string (`includes("mongodb.net")`) with
    // no env override. Prod is Atlas. So once this branch started typing bonds
    // DEBT, a G-Sec became findable in QA and INVISIBLE in prod — and no
    // non-Atlas test could see it.
    atlasTypes.push("EQUITY", "ETF", "DEBT");
  }

  // MONEY-980 — the US leg. Gated on `usAllowed` HERE (the query is never
  // issued when either gate is closed) and gated again on the combined list by
  // `filterUsResults`; the second gate is the backstop for the next US leg
  // someone adds, not a duplicate of this one.
  //
  // Tiingo asset types this request is asking for. `[]` means "no filter" —
  // which is right ONLY for an unfiltered request. `types=DEBT` and
  // `types=INDEX` also map to `[]`, and treating that as "no filter" would
  // answer a bond search with US equities, so the emptiness of the MAPPING is
  // checked against the emptiness of the REQUEST rather than on its own.
  const usAssetTypes = usAssetTypesForTypes(types);
  const usWanted = usAllowed && (types.length === 0 || usAssetTypes.length > 0);

  // 1. Try Atlas Search first (returns null if unavailable)
  //
  // MONEY-1205 — `upperQuery`, NOT the raw `query`. `symbol` is stored
  // upper-cased and mapped with a case-SENSITIVE analyzer in the
  // `instrument_search` index, so a lower-cased query cannot match the two
  // symbol legs at all — it reaches a stock only through its NAME. Measured
  // against prod (limit=24, types=[EQUITY,ETF,DEBT]):
  //
  //     "tcs"  → TCS  ABSENT from 24 rows     "TCS"  → TCS  #1  (9.2)
  //     "sbin" → SBIN ABSENT from 24 rows     "SBIN" → SBIN #1  (9.2)
  //     "infy" → INFY #16 (2.0)               "INFY" → INFY #1 (10.2)
  //
  // i.e. typing a ticker in lower case — what everyone does in a command
  // palette — could not find the company. RELIANCE / HDFCBANK hid the bug
  // because their ticker is a word of their NAME; TCS, INFY and SBIN have no
  // such luck. Names are analyzed case-insensitively ("tata consultancy" and
  // "TATA CONSULTANCY" both score TCS 14.5), and the MF index is fully
  // case-insensitive (identical scores AND order on five real fund queries),
  // so upper-casing costs nothing on either path and only ever adds the symbol
  // leg back.
  //
  // It also repairs a cache collision: `searchFilters` above already keys on
  // `upperQuery`, so "tcs" and "TCS" shared ONE entry while producing
  // different results — whichever ran first won for both.
  //
  // MONEY-980 — the US leg rides the SAME fan-out, with `upperQuery` for the
  // same reason: `us_instrument_search` maps `symbol` with `lucene.keyword`,
  // which emits the whole field as ONE token, and Tiingo tickers are stored
  // upper-case.
  const [atlasInstruments, atlasMfs, usSearch] = await Promise.all([
    searchWantEquity
      ? searchInstrumentsAtlas(upperQuery, {
          types: atlasTypes,
          // MONEY-1263 — Indian venues only, and still load-bearing after
          // MONEY-980 moved US listings out to `us_instruments`.
          //
          // The original reason (US rows in the shared table) is gone. The
          // remaining one is that `instrument_mappings` also holds NFO / BFO /
          // MCX rows — `SUPPORTED_EXCHANGES` is what `RELEVANT_EXCHANGES` keeps
          // from Kite's dump — so an unscoped Atlas search puts F&O and
          // commodity contracts on a cash-equity search surface. The Prisma
          // popular path already pins `exchange: { in: ["NSE","BSE"] }`; this
          // keeps the two paths agreeing.
          exchanges: [...INDIA_DISCOVER_EXCHANGES],
          limit: limit * 2,
        })
      : Promise.resolve(null),
    searchWantMF
      ? searchMutualFundsAtlas(upperQuery, { limit: 8 })
      : Promise.resolve(null),
    usWanted
      ? searchUsInstruments(upperQuery, {
          assetTypes: usAssetTypes,
          // No `listingStatuses` — both ACTIVE and DELISTED, which is the
          // product decision this feature exists for: searching `LEH` must
          // find Lehman Brothers, see that it is delisted, and be openable.
          // The ranking puts delisted rows last; it does not hide them.
          limit: US_RESULT_LIMIT,
        })
      : Promise.resolve(null),
  ]);

  // Each type independently falls back to Prisma when Atlas returns null.
  // This prevents partial Atlas availability from dropping entire result groups
  // (e.g., Atlas MF search succeeds but Atlas instrument search fails → stocks were lost).
  const useAtlasForInstruments = atlasInstruments !== null;
  const useAtlasForMf = atlasMfs !== null;

  let dbMapped: SearchResultItem[];
  if (useAtlasForInstruments) {
    dbMapped = atlasInstruments.map(mapAtlasInstrument);
  } else if (searchWantEquity) {
    const containsResults = await searchInstruments(query, {
      limit: limit * 2,
    });
    dbMapped = containsResults.map((r) => mapPrismaInstrument(r, query));
  } else {
    dbMapped = [];
  }

  let mfMapped: SearchResultItem[];
  if (useAtlasForMf) {
    mfMapped = atlasMfs.map(mapAtlasMf);
  } else if (searchWantMF) {
    const containsMfs = await prisma.mutualFundMaster.findMany({
      where: {
        isActive: true,
        OR: [
          { schemeName: { contains: query, mode: "insensitive" } },
          { amcName: { contains: query, mode: "insensitive" } },
          { schemeCode: { contains: query } },
        ],
      },
      select: {
        schemeCode: true,
        schemeName: true,
        amcName: true,
        category: true,
        nav: true,
      },
      take: 8,
    });
    mfMapped = containsMfs.map(mapPrismaMf);
  } else {
    mfMapped = [];
  }

  const useAtlas = useAtlasForInstruments || useAtlasForMf;

  // 2. Local index mappings (always fast, hardcoded)
  const localIndices =
    includeIndices && searchWantIndex ? matchLocalIndices(upperQuery) : [];

  // 3. Yahoo Finance fallback - only when we don't have enough results
  let yahooResults: SearchResultItem[] = [];
  if (searchWantEquity && dbMapped.length < limit && !useAtlasForInstruments) {
    // Only call Yahoo when Atlas is unavailable AND DB results are sparse
    const rawYahoo = await searchSymbols(query, {
      region: "IN",
      quotesCount: limit * 2,
    });
    yahooResults = filterIndianYahooResults(rawYahoo);
  }

  // US rows. `searchUsInstruments` already did Atlas-then-Prisma internally, so
  // an empty `us_instruments` (which is every environment today — the backfill
  // has not run) reaches here as an empty list, never as an error.
  const usMapped: SearchResultItem[] = (usSearch?.rows ?? []).map(
    mapUsInstrument
  );

  // Combine results - pre-sort NSE before BSE so dedup keeps NSE entries
  // Filter out US rows when the feature flag is off
  const combined = filterUsResults(
    [...localIndices, ...dbMapped, ...mfMapped, ...yahooResults, ...usMapped],
    usAllowed
  );
  const presorted = presortNseFirst(combined);

  // Deduplicate - equity/ETF by base symbol (NSE preferred), others by yahooSymbol
  const ranked = rankSearchResults(
    dedupeResults(presorted, types),
    upperQuery,
    useAtlas
  );

  // MONEY-1205 — INDEX is ranking criterion 2 (it outranks everything but an
  // exact symbol hit), so without a per-group cap a handful of index matches
  // eats the whole page before `slice` ever sees a stock or a fund. Demotes,
  // never drops, so `count` stays the real pre-slice total.
  const uniqueResults = capIndexRows(ranked);

  const slicedResults = uniqueResults.slice(0, limit);
  const source = resolveSearchSource(useAtlas, dbMapped.length);

  // Cache results
  await setCached(
    "market",
    "_global",
    "search",
    { results: slicedResults, count: uniqueResults.length, source },
    searchFilters
  );

  return NextResponse.json({
    success: true,
    query,
    results: slicedResults,
    count: uniqueResults.length,
    source,
    timestamp: new Date().toISOString(),
  });
}
