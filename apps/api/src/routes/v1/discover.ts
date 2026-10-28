/**
 * Discovery Routes (Phase C P3 — MONEY-730)
 *
 * Thin Hono handlers over @usemoney/services discover.service: the discover
 * home (indices + movers + sector heatmap), instrument search, MF discovery,
 * and per-sector stock lists.
 *
 * SCOPING: discovery data is global market data — these endpoints require a
 * Bearer token (the /v1 auth middleware) but pass NO userId to the services;
 * the data is not per-user.
 *
 * BOUNDING: search `q`, result `limit`, and category/sector strings are all
 * zod-capped so a mobile client can't trigger an unbounded DB/Atlas fan-out.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app";
import { success, error, ErrorCodes, zodParse } from "../../lib/response";
import {
  getDiscoverData,
  getMfDiscoverData,
  getMfsByCategory,
  getMfsBySchemeCodes,
  getStocksBySector,
  richSearchInstruments,
  getComparisonData,
  getSectorPerformance,
  getSectorHeatmap,
  getDiscoverHeatmap,
  getSectorDeepDive,
  getETFs,
  getInstrumentsBySymbols,
  // MONEY-1204 / P14 — data-engine discover sections. Mirrors of the eight
  // `apps/web/lib/actions/discover-sections.ts` actions plus the MF-portfolio
  // one, so the mobile client reaches the SAME service (and therefore the same
  // cache key, TTL and clamps) the web action reaches.
  getInstitutionalFlows,
  getMarketPositioning,
  getMacroStrip,
  getIpoSections,
  getIpoDashboardCard,
  getCircularFeed,
  getIndexDetail,
  getMfPortfolioSection,
} from "@usemoney/services";

const discoverRoutes = new Hono<AppContext>();

const MAX_QUERY_LEN = 64;
const MAX_CATEGORY_LEN = 48;
const MAX_SECTOR_LEN = 48;
const MAX_SEARCH_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_SCHEME_CODES = 50;
const MAX_SCHEME_CODE_LEN = 12;
const MAX_COMPARE_ID_LEN = 64;
const MIN_COMPARE_FUNDS = 2;
const MAX_COMPARE_FUNDS = 5;

/** `type` → richSearchInstruments `kind`. */
const KIND_BY_TYPE = {
  stock: "stocks",
  mf: "mfs",
  etf: "etfs",
} as const;

const SearchQuerySchema = z.object({
  q: z.string().min(1).max(MAX_QUERY_LEN),
  type: z.enum(["stock", "mf", "etf"]).default("stock"),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(12),
});

const MfsQuerySchema = z.object({
  category: z.string().min(1).max(MAX_CATEGORY_LEN).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(50),
});

const SectorStocksQuerySchema = z.object({
  sector: z.string().min(1).max(MAX_SECTOR_LEN),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(20),
  sortBy: z.enum(["name", "changePercent", "marketCap"]).default("name"),
});

// AMFI scheme codes are numeric strings; the list is capped at 50 (the same
// bound getMfsBySchemeCodes itself slices to and the web action enforces).
const SchemeCodesSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(MAX_SCHEME_CODE_LEN)
      .regex(/^\d+$/, "scheme codes must be numeric"),
  )
  .min(1)
  .max(MAX_SCHEME_CODES);

// A compare entry parsed from a `TYPE:id` pair, e.g. `MF:120503`,
// `ETF:NIFTYBEES`. STOCK is included — getComparisonData supports the
// cross-asset overlay (MONEY-553).
const CompareFundSchema = z.object({
  type: z.enum(["MF", "ETF", "INDEX", "STOCK"]),
  id: z.string().min(1).max(MAX_COMPARE_ID_LEN),
});

const CompareFundsSchema = z
  .array(CompareFundSchema)
  .min(MIN_COMPARE_FUNDS, "Select at least 2 items to compare")
  .max(MAX_COMPARE_FUNDS, "At most 5 items can be compared");

/**
 * GET /v1/discover/markets
 * Discover home: top gainers/losers + all stocks + sector counts. Global.
 */
discoverRoutes.get("/markets", async (c) => {
  try {
    const result = await getDiscoverData();
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover markets error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load discover data"),
      500,
    );
  }
});

/**
 * GET /v1/discover/search?q=&type=&limit=
 * Instrument search (Atlas/regex, package-safe). `type` = stock|mf|etf. Global.
 */
discoverRoutes.get("/search", async (c) => {
  try {
    const parsed = zodParse(SearchQuerySchema, {
      q: c.req.query("q"),
      type: c.req.query("type") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid search query",
          parsed.issues,
        ),
        400,
      );
    }

    const { q, type, limit } = parsed.data;
    const result = await richSearchInstruments({
      query: q,
      kind: KIND_BY_TYPE[type],
      limit,
    });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover search error:", err);
    return c.json(error(ErrorCodes.INTERNAL_ERROR, "Search failed"), 500);
  }
});

/**
 * GET /v1/discover/mfs?category=&limit=
 * MF discovery: filtered list when `?category` is present, else the discover
 * home (categories + AMC list + sample funds). Global.
 */
discoverRoutes.get("/mfs", async (c) => {
  try {
    const parsed = zodParse(MfsQuerySchema, {
      category: c.req.query("category") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid MF query", parsed.issues),
        400,
      );
    }

    const { category, limit } = parsed.data;
    const result = category
      ? await getMfsByCategory(category, { limit })
      : await getMfDiscoverData();
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover MFs error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load mutual funds"),
      500,
    );
  }
});

/**
 * GET /v1/discover/mfs/by-scheme-codes?codes=120503,119551
 * Batch MF-master lookup by AMFI scheme code (enriches search results /
 * watchlist rows). Mirrors getMfsBySchemeCodesAction (apps/web
 * lib/actions/discover-mf.ts:63) — getMfsBySchemeCodes(codes), capped at 50.
 * Global. Registered on a literal sub-path of /mfs (no param capture).
 */
discoverRoutes.get("/mfs/by-scheme-codes", async (c) => {
  try {
    const codes = (c.req.query("codes") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const parsed = zodParse(SchemeCodesSchema, codes);
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid scheme codes",
          parsed.issues,
        ),
        400,
      );
    }

    const result = await getMfsBySchemeCodes(parsed.data);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover MFs by scheme codes error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch mutual funds"),
      500,
    );
  }
});

/**
 * GET /v1/discover/mf-compare?funds=MF:120503,ETF:NIFTYBEES
 * Side-by-side fund/stock comparison (NAV history + compositions + the
 * base-100 normalized overlay series). Mirrors getComparisonDataAction
 * (apps/web lib/actions/fund-comparison.ts:20) — each `TYPE:id` pair maps to
 * the service's { type, id }; getComparisonData caches by the sorted key.
 * 2-5 entries (the service's own bound, enforced here as a 400). Global.
 */
discoverRoutes.get("/mf-compare", async (c) => {
  try {
    const funds = (c.req.query("funds") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        // Split on the FIRST colon: `MF:120503` → { type: "MF", id: "120503" }.
        const idx = pair.indexOf(":");
        return idx === -1
          ? { type: pair, id: "" }
          : { type: pair.slice(0, idx), id: pair.slice(idx + 1) };
      });
    const parsed = zodParse(CompareFundsSchema, funds);
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid compare query — pass 2-5 comma-separated TYPE:id pairs (TYPE = MF|ETF|INDEX|STOCK)",
          parsed.issues,
        ),
        400,
      );
    }

    const result = await getComparisonData(parsed.data);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover MF compare error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch comparison data"),
      500,
    );
  }
});

// ── P4d additions (MONEY-1062 — apps/api mobile parity) ─────────────────────

const HeatmapQuerySchema = z.object({
  view: z.enum(["sectors", "stocks"]).default("sectors"),
  timeframe: z.enum(["1D", "1W", "1M", "YTD"]).default("1D"),
  scope: z.enum(["all", "nifty50", "nifty500"]).default("all"),
  top: z.coerce.number().int().min(1).max(20).default(6),
});

const EtfsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(30),
  sortBy: z.enum(["symbol", "changePercent", "volume"]).default("symbol"),
});

const MAX_INSTRUMENT_SYMBOLS = 50;
const MAX_INSTRUMENT_SYMBOL_LEN = 64;
// Bounded CSV lists (route-layer cap so a mobile client can't trigger an
// unbounded Prisma `in` fan-out; the web action instead silently returns []
// past 50 symbols — the SERVICE preserves that exact semantic).
const InstrumentsQuerySchema = z.object({
  symbols: z
    .array(z.string().min(1).max(MAX_INSTRUMENT_SYMBOL_LEN))
    .max(MAX_INSTRUMENT_SYMBOLS),
  yahooSymbols: z
    .array(z.string().min(1).max(MAX_INSTRUMENT_SYMBOL_LEN))
    .max(MAX_INSTRUMENT_SYMBOLS),
  type: z.enum(["ETF", "INDEX"]),
});

const SectorParamSchema = z.object({
  sector: z.string().min(1).max(MAX_SECTOR_LEN),
});

/** Split a CSV query param into a trimmed, empty-filtered list. */
function csvList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * GET /v1/discover/sectors
 * Sector performance bars: per-sector mean + volume-weighted change% + barWidth
 * + display config. Mirrors getSectorPerformanceAction (apps/web
 * lib/actions/discover-sectors.ts:40) via the extracted getSectorPerformance
 * service. Global. (Registered before /sectors/:sector so the literal path is
 * never captured as a :sector.)
 */
discoverRoutes.get("/sectors", async (c) => {
  try {
    const result = await getSectorPerformance();
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover sectors error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load sector performance"),
      500,
    );
  }
});

/**
 * GET /v1/discover/heatmap?view=&timeframe=&scope=&top=
 * Market heatmap. BOTH web heatmap actions are UI-live, so both shapes are
 * served behind `?view=`:
 *   - view=sectors (default): sector-aggregated buckets — mirrors
 *     getSectorHeatmapAction (apps/web/lib/actions/sector-heatmap.ts), the
 *     /discover/sectors page's fetch. `timeframe` + `top` (topConstituents).
 *   - view=stocks: the flat treemap stock list — mirrors getHeatmapDataAction
 *     (apps/web/lib/actions/discover-heatmap.ts), the /discover/markets
 *     page's fetch. `scope` + `timeframe`.
 * Global.
 */
discoverRoutes.get("/heatmap", async (c) => {
  try {
    const parsed = zodParse(HeatmapQuerySchema, {
      view: c.req.query("view") ?? undefined,
      timeframe: c.req.query("timeframe") ?? undefined,
      scope: c.req.query("scope") ?? undefined,
      top: c.req.query("top") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid heatmap query",
          parsed.issues,
        ),
        400,
      );
    }

    const { view, timeframe, scope, top } = parsed.data;
    const result =
      view === "stocks"
        ? await getDiscoverHeatmap({ scope, timeframe })
        : await getSectorHeatmap({ timeframe, topConstituents: top });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover heatmap error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load market heatmap"),
      500,
    );
  }
});

/**
 * GET /v1/discover/etfs?limit=&sortBy=
 * ETF list with quotes + MF-master return/AUM enrichment. Mirrors getETFsAction
 * (apps/web lib/actions/discover-indices.ts:142) via the extracted getETFs
 * service. Global.
 */
discoverRoutes.get("/etfs", async (c) => {
  try {
    const parsed = zodParse(EtfsQuerySchema, {
      limit: c.req.query("limit") ?? undefined,
      sortBy: c.req.query("sortBy") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid ETF query", parsed.issues),
        400,
      );
    }

    const result = await getETFs(parsed.data);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover ETFs error:", err);
    return c.json(error(ErrorCodes.INTERNAL_ERROR, "Failed to load ETFs"), 500);
  }
});

/**
 * GET /v1/discover/instruments?symbols=A,B&type=ETF&yahooSymbols=
 * ETF/INDEX instrument enrichment by symbol (or Yahoo symbol). Mirrors
 * getInstrumentsBySymbolsAction (apps/web lib/actions/discover-indices.ts:49)
 * via the extracted getInstrumentsBySymbols service — both lists empty → an
 * empty result (web semantic), lists are zod-capped at 50. Global.
 */
discoverRoutes.get("/instruments", async (c) => {
  try {
    const parsed = zodParse(InstrumentsQuerySchema, {
      symbols: csvList(c.req.query("symbols")),
      yahooSymbols: csvList(c.req.query("yahooSymbols")),
      type: c.req.query("type"),
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid instruments query",
          parsed.issues,
        ),
        400,
      );
    }

    const { symbols, yahooSymbols, type } = parsed.data;
    const result = await getInstrumentsBySymbols(
      symbols,
      type,
      yahooSymbols.length > 0 ? yahooSymbols : undefined,
    );
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover instruments error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load instrument data"),
      500,
    );
  }
});

/**
 * GET /v1/discover/sectors/:sector/stocks?limit=&sortBy=
 * Stocks in a sector, sorted. Global.
 */
discoverRoutes.get("/sectors/:sector/stocks", async (c) => {
  try {
    const parsed = zodParse(SectorStocksQuerySchema, {
      sector: c.req.param("sector"),
      limit: c.req.query("limit") ?? undefined,
      sortBy: c.req.query("sortBy") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid sector query",
          parsed.issues,
        ),
        400,
      );
    }

    const { sector, limit, sortBy } = parsed.data;
    const result = await getStocksBySector(sector, { limit, sortBy });
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover sector stocks error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load sector stocks"),
      500,
    );
  }
});

/**
 * GET /v1/discover/sectors/:sector
 * Sector deep-dive: identity + mcap-weighted aggregate + full constituent list
 * + benchmark spread. `:sector` is a slug OR display name (case-insensitive,
 * hyphen-tolerant — e.g. `information-technology`). Mirrors
 * getSectorDeepDive (this service; the web-side lib/actions/sectors.ts was
 * deleted in MONEY-1092 when its only consumer, the orphaned /discover/sectors/
 * [sector] route, became a redirect. The action the
 * /discover/sectors/[sector] route page uses; the richer Prisma-direct variant
 * in sector-deep-dive.ts backs a different in-page panel and is NOT this
 * endpoint) via the extracted getSectorDeepDive service. Unknown/empty sector →
 * 404. Global.
 */
discoverRoutes.get("/sectors/:sector", async (c) => {
  try {
    const parsed = zodParse(SectorParamSchema, {
      sector: c.req.param("sector"),
    });
    if (!parsed.ok) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid sector", parsed.issues),
        400,
      );
    }

    const result = await getSectorDeepDive(parsed.data.sector);
    if (!result.success) {
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover sector deep-dive error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load sector deep-dive"),
      500,
    );
  }
});

// ── MONEY-1204 / P14 data-engine sections ───────────────────────────────────
//
// Mirrors of `apps/web/lib/actions/discover-sections.ts` (eight actions) and
// `apps/web/lib/actions/mf-portfolio-section.ts` (one). Both web files say in
// their headers that they are deliberately thin so that THIS mirror can call
// the same service instead of re-deriving the reads; the wrapper shipped
// without the mirror, and this closes that.
//
// Every one of these services returns `ServiceResult<WithProvenance<T>>`, so the
// 200 body is `{ success: true, data: { data, source, asOf, empty, … } }` — the
// provenance envelope reaches the mobile client intact rather than being
// unwrapped here. A client that cannot see `source`/`asOf` cannot tell a stale
// panel from a live one, which is the whole reason the envelope exists.
//
// EMPTY IS NOT AN ERROR: a section with nothing published yet returns
// `success: true` with `empty: true`. These routes never 404 on empty (the one
// 404 below is a slug that names no index at all, which is a different thing).
//
// ORDERING: none of these shadows or is shadowed. There is no top-level
// `/:param` route in this file — the only param route is `/sectors/:sector`,
// which is pinned behind the literal `sectors` segment — and
// `/mfs/:schemeCode/portfolio` is three segments deep so it cannot capture the
// two-segment `/mfs/by-scheme-codes` registered above it.

const MAX_PARTICIPANT_LEN = 24;
const MAX_DEPARTMENT_LEN = 64;
const MAX_TOPIC_LEN = 64;
const MAX_SLUG_LEN = 64;
// The web action's own bound (mf-portfolio-section.ts:30). Enforced here too
// because the SERVICE does not bound it and the value lands in a cache key.
const MAX_MF_SCHEME_CODE_LEN = 24;
// `skip` feeds both a Prisma offset and the circular cache key, and the service
// only floors it at 0 — there is no ceiling on that side. A route-layer cap
// keeps a mobile client from requesting a deep-offset scan or minting unbounded
// cache keys, the same reasoning as InstrumentsQuerySchema's list caps.
const MAX_CIRCULAR_SKIP = 10_000;
const MAX_SYMBOL_DEPARTMENTS = 12;

// Integer-only, NOT range-checked: every one of these lands in a service that
// clamps it (`Math.min(120, Math.max(1, …))` etc.) BEFORE it reaches a query or
// a cache key, so re-clamping here would be a second bound to keep in sync. We
// reject only what the clamp cannot fix — a non-integer. Same rule, and the
// same reason, as stocks.ts#NewsLimitSchema.
const ServiceClampedInt = z.coerce.number().int().optional();

const FlowsQuerySchema = z.object({
  windowSessions: ServiceClampedInt,
  // `FlowSegment` is a closed union in @usemoney/core/market-data
  // (institutional-flows.ts:54). The service upper-cases whatever it is given
  // and puts it straight into a `where` and a cache key, so an open string here
  // would be a cache-key sink for values that can never match a row.
  segment: z.enum(["CASH", "FNO"]).optional(),
});

const PositioningQuerySchema = z.object({
  // Bounded string rather than an enum on purpose. The participant list is
  // DATA (`data.participants`, whatever NSE published) and the web widget feeds
  // it straight back; enumerating today's four here would 400 a participant the
  // web UI happily renders the moment NSE adds one. The charset + length cap is
  // what keeps it out of trouble — it reaches a cache key.
  participant: z
    .string()
    .trim()
    .min(1)
    .max(MAX_PARTICIPANT_LEN)
    .regex(/^[A-Za-z][A-Za-z0-9 _-]*$/, "invalid participant")
    .optional(),
  // Enum, unlike `participant`, because the service SILENTLY falls back to "OI"
  // for anything it does not recognise (discover-sections.service.ts:278). A
  // typo'd `?metric=VOL` would return open-interest data labelled as the caller
  // asked for — rejecting it is the only way the caller finds out.
  metric: z.enum(["OI", "VOLUME"]).optional(),
});

const IpoSectionsQuerySchema = z.object({ recentDays: ServiceClampedInt });
const IpoDashboardQuerySchema = z.object({ limit: ServiceClampedInt });

const CircularFeedQuerySchema = z.object({
  department: z.string().trim().min(1).max(MAX_DEPARTMENT_LEN).optional(),
  topic: z.string().trim().min(1).max(MAX_TOPIC_LEN).optional(),
  limit: ServiceClampedInt,
  skip: z.coerce.number().int().min(0).max(MAX_CIRCULAR_SKIP).optional(),
});

const IndexDetailSchema = z.object({
  slug: z.string().trim().min(1).max(MAX_SLUG_LEN),
  sessions: ServiceClampedInt,
});

const MfPortfolioParamSchema = z.object({
  schemeCode: z.string().trim().min(1).max(MAX_MF_SCHEME_CODE_LEN),
});

/**
 * Drop `undefined` values so a service is called with EXACTLY the object the web
 * action passes it.
 *
 * zod keeps an optional key PRESENT-but-undefined when the input carries it, so
 * `zodParse(Schema, { limit: undefined })` yields `{ limit: undefined }`, not
 * `{}`. Every service in this lane reads its fields with `??`, so the two behave
 * identically today — but "identical today" is not the contract. The contract is
 * that the mirror and the action hand the service the same args, and a service
 * that ever asks `"limit" in args` (or spreads the object into a cache key)
 * would diverge silently. `/v1/mutualfunds` already builds its filter object
 * this way for the same reason.
 */
function definedOnly<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/**
 * GET /v1/discover/flows?windowSessions=&segment=
 * FII/DII daily net + trailing cumulative + sparkline, ₹ crore. Mirrors
 * getInstitutionalFlowsAction (apps/web lib/actions/discover-sections.ts:74).
 * Global.
 */
discoverRoutes.get("/flows", async (c) => {
  try {
    const parsed = zodParse(FlowsQuerySchema, {
      windowSessions: c.req.query("windowSessions") ?? undefined,
      segment: c.req.query("segment") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid flows query",
          parsed.issues,
        ),
        400,
      );
    }
    const result = await getInstitutionalFlows(definedOnly(parsed.data));
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover institutional flows error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load institutional flows"),
      500,
    );
  }
});

/**
 * GET /v1/discover/positioning?participant=&metric=
 * ONE participant's F&O legs at ONE metric, plus the participants the toggle
 * may offer. Mirrors getMarketPositioningAction (discover-sections.ts:89).
 * Global.
 */
discoverRoutes.get("/positioning", async (c) => {
  try {
    const parsed = zodParse(PositioningQuerySchema, {
      participant: c.req.query("participant") ?? undefined,
      metric: c.req.query("metric") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid positioning query",
          parsed.issues,
        ),
        400,
      );
    }
    const result = await getMarketPositioning(definedOnly(parsed.data));
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover positioning error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load market positioning"),
      500,
    );
  }
});

/**
 * GET /v1/discover/macro
 * Repo rate, CPI YoY, WPI YoY, forex reserves — each tile with its OWN as-on
 * date. Mirrors getMacroStripAction (discover-sections.ts:97).
 *
 * Parameterless, exactly like the action. The service accepts a `seriesIds`
 * override, but the action does not expose it and neither does this: it selects
 * which series a caller can pull and lands in the cache key, so opening it here
 * would be a wider surface than the mirror is supposed to have. Global.
 */
discoverRoutes.get("/macro", async (c) => {
  try {
    const result = await getMacroStrip({});
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover macro strip error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load macro indicators"),
      500,
    );
  }
});

/**
 * GET /v1/discover/ipos/dashboard?limit=
 * The dashboard card: open windows, what closes today, and the next one up.
 * Mirrors getIpoDashboardCardAction (discover-sections.ts:118).
 *
 * `data.empty === true` means nothing is open AND nothing is forthcoming — the
 * client should render nothing at all, not a permanent "no IPOs" tile.
 *
 * Registered BEFORE `/ipos` below purely for readability; the two cannot
 * collide (different segment counts, and `/ipos` has no `:param` child).
 * Global.
 */
discoverRoutes.get("/ipos/dashboard", async (c) => {
  try {
    const parsed = zodParse(IpoDashboardQuerySchema, {
      limit: c.req.query("limit") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid IPO dashboard query",
          parsed.issues,
        ),
        400,
      );
    }
    const result = await getIpoDashboardCard(definedOnly(parsed.data));
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover IPO dashboard error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load IPO dashboard card"),
      500,
    );
  }
});

/**
 * GET /v1/discover/ipos?recentDays=
 * Upcoming / currently bidding / recently listed, bucketed on the IST day.
 * Mirrors getIpoSectionsAction (discover-sections.ts:106). Global.
 */
discoverRoutes.get("/ipos", async (c) => {
  try {
    const parsed = zodParse(IpoSectionsQuerySchema, {
      recentDays: c.req.query("recentDays") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "Invalid IPO query", parsed.issues),
        400,
      );
    }
    const result = await getIpoSections(definedOnly(parsed.data));
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover IPO sections error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load IPO calendar"),
      500,
    );
  }
});

/**
 * GET /v1/discover/circulars?department=&topic=&limit=&skip=
 * Exchange circular feed + the department chips + a `hasMore` probe. Mirrors
 * getCircularFeedAction (discover-sections.ts:127). Global.
 */
discoverRoutes.get("/circulars", async (c) => {
  try {
    const parsed = zodParse(CircularFeedQuerySchema, {
      department: c.req.query("department") ?? undefined,
      topic: c.req.query("topic") ?? undefined,
      limit: c.req.query("limit") ?? undefined,
      skip: c.req.query("skip") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid circulars query",
          parsed.issues,
        ),
        400,
      );
    }
    const result = await getCircularFeed(definedOnly(parsed.data));
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover circulars error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load exchange circulars"),
      500,
    );
  }
});

/**
 * GET /v1/discover/indices/:slug?sessions=
 * Everything `/discover/indices/[slug]` renders: resolved route keys, price +
 * valuation detail, constituents and membership. Mirrors getIndexDetailAction
 * (discover-sections.ts:161).
 *
 * An index with NO constituent list is a 200 with an empty constituents block,
 * not a 404 — ~90 of the indices NSE publishes closes for have no list, and
 * 404ing a perfectly good index would be wrong.
 *
 * The one 404 is `success: false` + "Unknown index", which the service returns
 * only when the slug NORMALISES to the empty string (`resolveIndexRoute`,
 * discover-section-logic.ts:1459 — e.g. `/indices/---`). That names no index at
 * all, so it is a missing resource rather than an internal failure. Matched on
 * the message because the service carries no `code` on that leg — the same
 * accommodation `/v1/mutualfunds/:id` already makes for its not-found string.
 * Global.
 */
discoverRoutes.get("/indices/:slug", async (c) => {
  try {
    const parsed = zodParse(IndexDetailSchema, {
      slug: c.req.param("slug"),
      sessions: c.req.query("sessions") ?? undefined,
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid index query",
          parsed.issues,
        ),
        400,
      );
    }
    const result = await getIndexDetail(definedOnly(parsed.data));
    if (!result.success) {
      if (result.code === "NOT_FOUND" || result.error === "Unknown index") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover index detail error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load index detail"),
      500,
    );
  }
});

/**
 * GET /v1/discover/mfs/:schemeCode/portfolio
 * One scheme's disclosed holdings + the month-on-month entered/exited diff.
 * Mirrors getMfPortfolioSectionAction (apps/web
 * lib/actions/mf-portfolio-section.ts:24).
 *
 * PLACED HERE, NOT ON `/v1/mutualfunds`, deliberately. `/v1/mutualfunds` is the
 * USER's holdings — every handler in that file reads `c.get("userId")` and its
 * whole contract is ownership scoping. A fund's SEBI-disclosed portfolio is
 * global reference data with no user in it, and every other global MF read
 * (`/mfs`, `/mfs/by-scheme-codes`, `/mf-compare`) already lives here. Putting an
 * unscoped read next to a file of scoped ones is how the next handler gets
 * copied from the wrong neighbour.
 *
 * The `length > 24` bound is the web action's, restated: an AMFI scheme code is
 * numeric in practice and the service does not bound it before the cache key.
 * Global.
 */
discoverRoutes.get("/mfs/:schemeCode/portfolio", async (c) => {
  try {
    const parsed = zodParse(MfPortfolioParamSchema, {
      schemeCode: c.req.param("schemeCode"),
    });
    if (!parsed.ok) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          "Invalid scheme code",
          parsed.issues,
        ),
        400,
      );
    }
    const result = await getMfPortfolioSection(parsed.data);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Discover MF portfolio error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to load fund portfolio"),
      500,
    );
  }
});

export default discoverRoutes;
