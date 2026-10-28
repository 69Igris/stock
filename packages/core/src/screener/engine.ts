/**
 * Hybrid Screener Engine
 *
 * 3-layer approach:
 * 1. Fundamental-only filters → run on in-house StockRatios (+ Tickertape validation)
 * 2. Technical-only filters → run ONLY in-house from DailyPrice data
 * 3. Combined fundamental + technical → the killer feature neither Tickertape nor Screener.in can do
 */

import prisma from "@usemoney/database";
import {
  computeIndicators,
  type OHLCV,
  type TechnicalIndicators,
} from "../market-data/technical-indicators";
import { toWritableNseSector } from "../market-data/instruments/sector-taxonomy";
import { sectorWritableWhere } from "../market-data/instruments/sector-write-guard";
import {
  alwaysNullMarketFields,
  isMarketStructure,
  marketFieldUniverse,
  marketFieldValue,
  matchesMarketFilters,
  type MarketFieldValues,
} from "./market-fields-logic";
import {
  loadMarketFieldValues,
  marketFieldKey,
  type MarketFieldsDeps,
} from "./market-fields";

// MONEY-1204 (14e.1) — the market-structure registry is re-exported through the
// engine on purpose. `@usemoney/core/screener/engine` is the subpath the filter
// UI, the scan translator and the research package already import, so a single
// import point is what keeps the vocabulary and the engine from drifting apart
// (the failure `normalizeField` exists to paper over).
export {
  MARKET_FIELDS,
  MARKET_FIELD_BY_ID,
  MARKET_STRUCTURE_FIELDS,
  MARKET_FLAG_KINDS,
  isMarketStructure,
  marketFieldSources,
  marketFieldUniverse,
  marketFieldValue,
  matchesMarketFilters,
  alwaysNullMarketFields,
  buildMarketFieldValues,
  emptyMarketFieldValues,
  qoqDelta,
  marketNumber,
  type MarketFieldDef,
  type MarketFieldSource,
  type MarketFieldUniverse,
  type MarketFieldValues,
  type MarketFieldRowSet,
} from "./market-fields-logic";
export {
  loadMarketFieldValues,
  marketFieldKey,
  MARKET_FIELD_CHUNK_SIZE,
  MARKET_FIELD_LOOKBACK_DAYS,
  type MarketFieldsDeps,
  type MarketFieldCandidate,
} from "./market-fields";

// ── Types ────────────────────────────────────────────────────────────

export interface ScreenerFilter {
  field: string; // "pe", "roe", "rsi_14", "sma_200_cross", etc.
  operator:
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "eq"
    | "between"
    | "cross_above"
    | "cross_below";
  value: number | [number, number];
  /**
   * Non-numeric operand for the one market-structure field that needs one:
   * `indexMember`'s index slug (`"nifty50"`). Optional and additive — every
   * existing filter, strategy and scan keeps type-checking unchanged, and a
   * field that ignores it is unaffected. Widening `value` to
   * `number | string` instead would have touched every consumer that narrows
   * it (MONEY-1204 / 14e.1).
   */
  operand?: string;
}

export interface ScreenerStrategy {
  id: string;
  name: string;
  description: string;
  category: string; // "value", "momentum", "dividend", "technical", etc.
  filters: ScreenerFilter[];
  source: "chartink" | "custom" | "builtin";
}

export interface ScreenerResult {
  symbol: string;
  exchange: string;
  name: string;
  sector?: string | null;
  // Matched fundamental data
  pe?: number | null;
  pb?: number | null;
  roe?: number | null;
  roce?: number | null;
  marketCap?: number | null;
  dividendYield?: number | null;
  debtToEquity?: number | null;
  // Matched technical data
  rsi14?: number;
  macd?: number;
  sma50?: number;
  sma200?: number;
  price?: number;
  volumeRatio?: number;
  // 52-week context
  distanceFrom52WeekLow?: number;
  distanceFrom52WeekHigh?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  /**
   * MONEY-1204 (14e.1) — delivery, surveillance flags, ownership, index
   * membership, F&O positioning and bond quotes, resolved from the eight
   * market-structure tables. Present only when a market-structure filter ran,
   * so an ordinary fundamental screen pays nothing for it.
   *
   * Nested rather than flattened so a field id can never collide with a
   * `StockRatios` column, and so the block travels as one citable unit with its
   * own per-source `asOf` stamps. Every member is a plain JSON scalar — the
   * `DerivativeSummary` BigInts are coerced in `buildMarketFieldValues`, before
   * this ever reaches `JSON.stringify`.
   */
  market?: MarketFieldValues;
}

interface ScreenerOptions {
  exchange?: string;
  limit?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  /** Filter results to only stocks in this index (e.g., "NIFTY 50") */
  indexFilter?: string;
}

/**
 * Injectable IO seam (MONEY-1125). Defaults to the shared prisma client; the
 * screener tests inject a fake so the batched query shapes, the grouping and
 * the round-trip COUNT are asserted hermetically (no DB, no network).
 */
export interface ScreenerDeps {
  prisma?: typeof prisma;
  /**
   * The clock the market-structure reads are bounded against, defaulting to
   * `Date.now()`. It belongs on the SEAM rather than in `ScreenerOptions`
   * because it is injected IO, not a screen the caller asked for.
   *
   * MONEY-1402 is why it is reachable from here at all. Every market-structure
   * read is `date >= now - MARKET_FIELD_LOOKBACK_DAYS`, so a test with a dated
   * fixture and no injected clock asserts how long ago the fixture was written
   * rather than any behaviour. Four assertions in
   * `market-fields-reader.test.ts` reached this path through `runScreener`,
   * which had no way to pass one down — and a fifth, which could, went red on
   * 2026-09-13 with nothing changed but the calendar and turned main red for
   * every branch.
   */
  now?: number;
}

// ── Filter Classification ────────────────────────────────────────────

export const FUNDAMENTAL_FIELDS = new Set([
  "pe",
  "pb",
  "evToEbitda",
  "pegRatio",
  "roe",
  "roa",
  "roce",
  "grossMargin",
  "operatingMargin",
  "netMargin",
  "revenueGrowth",
  "earningsGrowth",
  "revenueGrowth3Y",
  "earningsGrowth3Y",
  "revenueGrowth5Y",
  "earningsGrowth5Y",
  "debtToEquity",
  "currentRatio",
  "interestCoverage",
  "beta",
  "dividendYield",
  "marketCap",
  "enterpriseValue",
  "targetPrice",
]);

export const TECHNICAL_FIELDS = new Set([
  "rsi_14",
  "macd",
  "macd_signal",
  "macd_histogram",
  "sma_20",
  "sma_50",
  "sma_200",
  "ema_12",
  "ema_26",
  "bollinger_upper",
  "bollinger_lower",
  "bollinger_bandwidth",
  "atr_14",
  "stoch_k",
  "stoch_d",
  "williams_r",
  "obv",
  "volume_ratio",
  "distance_52w_high",
  "distance_52w_low",
  "golden_cross",
  "death_cross",
  "price_above_sma200",
]);

export function isFundamental(field: string): boolean {
  return FUNDAMENTAL_FIELDS.has(field);
}

// The NL parser (query-to-filters) and some strategy libraries emit field names
// that differ from the canonical StockRatios columns (e.g. "peg" vs "pegRatio",
// "revenueGrowth1Y" vs "revenueGrowth"). Normalize them so the filters actually
// run instead of being silently dropped (MONEY-612 skills-health).
const FIELD_ALIASES: Record<string, string> = {
  peg: "pegRatio",
  revenueGrowth1Y: "revenueGrowth",
  earningsGrowth1Y: "earningsGrowth",
  ev_to_ebitda: "evToEbitda",
  debt_to_equity: "debtToEquity",
};

export function normalizeField(field: string): string {
  return FIELD_ALIASES[field] ?? field;
}

export function isTechnical(field: string): boolean {
  return TECHNICAL_FIELDS.has(field);
}

// ── Field coverage (MONEY-1095 item 6) ───────────────────────────────
//
// A filter on a column that is NULL for every row matches nothing, so the
// screen returns 0 and the UI says "No stocks matched your criteria" — which
// reads as "no such stocks exist" when the truth is "we never ingested that
// number". The Tickertape ratios feed supplies 7 of the 23 columns
// `financial-data-sync` declares, so 16 are null across every row and 32 of
// the 94 registered strategies can only ever return nothing.
//
// Coverage is MEASURED, never hard-coded: a static "unavailable fields" list
// would keep warning about columns long after a feed started populating them,
// and this repo has been bitten repeatedly by copies that drift from reality.
// Measuring means the warning disappears on its own the moment data lands.

const COVERAGE_TTL_MS = 5 * 60_000;
const coverageCache = new Map<string, { hasData: boolean; at: number }>();

/**
 * Of `fields`, those with NO non-null value in StockRatios — i.e. filters that
 * cannot match anything no matter what the user asked for.
 *
 * Only called on the empty-result path, so a successful screen pays nothing.
 * Results are cached briefly because coverage changes at sync cadence, not
 * per request. Never throws: if the probe fails we report "nothing unavailable"
 * and the caller falls back to the ordinary empty-state.
 */
export async function findUnavailableFields(
  fields: readonly string[],
): Promise<string[]> {
  const normalized = Array.from(new Set(fields.map(normalizeField)));
  const unique = normalized.filter(isFundamental);
  // MONEY-1204 (14e.1) — market-structure fields whose column is empty
  // platform-wide BY DESIGN rather than by current coverage. `mwplUtilisation`
  // is the only one: its denominator has no feed, so a filter on it returns
  // zero rows forever. That is NOT measured against the table, because there is
  // nothing to measure — measuring would report "unavailable" today and keep
  // reporting it after a hypothetical feed landed only because the probe found
  // no rows yet. The registry states the fact; a feed landing is a code change.
  const unavailable: string[] = alwaysNullMarketFields(normalized);
  const now = Date.now();

  for (const field of unique) {
    const cached = coverageCache.get(field);
    if (cached && now - cached.at < COVERAGE_TTL_MS) {
      if (!cached.hasData) unavailable.push(field);
      continue;
    }
    try {
      // findFirst, not count: the question is "does ANY row have this?", so
      // stopping at the first hit is both cheaper and the exact semantic.
      const populated = await prisma.stockRatios.findFirst({
        where: { [field]: { not: null } } as never,
        select: { id: true },
      });
      const hasData = populated !== null;
      coverageCache.set(field, { hasData, at: now });
      if (!hasData) unavailable.push(field);
    } catch {
      // An unknown column (or a transient DB error) must not turn a normal
      // empty result into an error — treat it as "can't tell".
      coverageCache.set(field, { hasData: true, at: now });
    }
  }

  return unavailable;
}

/** Test seam — coverage is cached for 5 minutes, which unit tests must reset. */
export function __resetFieldCoverageCache(): void {
  coverageCache.clear();
}

// ── Main Engine ──────────────────────────────────────────────────────

/**
 * Run a screener with the given filters.
 * Automatically routes to fundamental, technical, or combined pipeline.
 */
export async function runScreener(
  filters: ScreenerFilter[],
  options?: ScreenerOptions,
  deps: ScreenerDeps = {},
): Promise<ScreenerResult[]> {
  const limit = options?.limit || 50;
  const exchange = options?.exchange;

  const fundamentalFilters = filters.filter((f) => isFundamental(f.field));
  const technicalFilters = filters.filter((f) => isTechnical(f.field));
  // MONEY-1204 (14e.1) — the third filter class. Neither a `StockRatios`
  // column nor a `computeIndicators` output; eight other tables.
  const marketFilters = filters.filter((f) => isMarketStructure(f.field));

  let candidates: ScreenerResult[];

  if (fundamentalFilters.length > 0 && technicalFilters.length === 0) {
    // Pure fundamental screen
    candidates = await runFundamentalScreen(fundamentalFilters, exchange);
  } else if (fundamentalFilters.length === 0 && technicalFilters.length > 0) {
    // Fast-path: 52-week distance screens use Yahoo quotes (no DailyPrice
    // dependency). It RETURNS EARLY, so it is only eligible when there is no
    // market-structure filter still waiting to be applied — taking it with one
    // pending would silently drop that filter and return a wider set than the
    // user asked for.
    if (marketFilters.length === 0) {
      const fastResult = await run52WeekDistanceScreen(
        technicalFilters,
        exchange,
        limit,
        options?.indexFilter,
      );
      if (fastResult !== null) {
        // Fast-path handled it - skip index filter (already applied inside)
        return fastResult.slice(0, limit);
      }
    }
    // Standard technical screen (requires DailyPrice data). When a
    // market-structure filter follows, the technical pass is a PRE-filter, so
    // its cap is widened — capping at `limit` first would hand the market pass
    // exactly `limit` candidates and return a handful of stocks for a request
    // that asked for fifty.
    candidates = await runTechnicalScreen(
      technicalFilters,
      exchange,
      marketFilters.length > 0
        ? Math.min(limit * 5, SCREENER_PREFILTER_LIMIT)
        : limit,
      deps,
    );
  } else if (
    fundamentalFilters.length === 0 &&
    technicalFilters.length === 0 &&
    marketFilters.length > 0
  ) {
    // Market-structure-only screen ("stocks in the F&O ban", "bonds yielding
    // over 8%"). Nothing narrowed the universe yet, so seed it from
    // InstrumentMapping — and from the right HALF of it: a bond-yield screen
    // seeded with equities returns nothing and reads as "no bonds match".
    candidates = await seedMarketUniverse(marketFilters, exchange, deps);
  } else {
    // Combined: fundamentals first (narrower set), then technical filter
    candidates = await runFundamentalScreen(fundamentalFilters, exchange);
    candidates = await applyTechnicalFilters(
      candidates,
      technicalFilters,
      deps,
    );
  }

  // Market-structure filters run LAST over whatever narrowed the field, because
  // they are the only class that needs a per-candidate multi-table read.
  if (marketFilters.length > 0) {
    candidates = await applyMarketStructureFilters(
      candidates,
      marketFilters,
      deps,
      deps.now ?? Date.now(),
    );
  }

  // Index filter - restrict to constituents of a specific index
  if (options?.indexFilter) {
    const { getIndexConstituents } = await import("./index-constituents");
    const constituents = await getIndexConstituents(options.indexFilter);
    if (constituents && constituents.length > 0) {
      const symbolSet = new Set(
        constituents.map((s: string) => s.toUpperCase()),
      );
      candidates = candidates.filter((c) =>
        symbolSet.has((c.symbol || "").toUpperCase()),
      );
    }
  }

  // Sort
  if (options?.sortBy) {
    const dir = options.sortDir === "asc" ? 1 : -1;
    const sortBy = options.sortBy;
    // A market-structure field lives one level down, on `result.market`. Read
    // it from there rather than off the top level, where it would resolve to
    // `undefined` and sort every row as 0 — an invisible no-op sort.
    const readSort = isMarketStructure(sortBy)
      ? (r: ScreenerResult): number =>
          r.market ? (marketFieldValue(r.market, sortBy) ?? 0) : 0
      : (r: ScreenerResult): number =>
          ((r as unknown as Record<string, unknown>)[sortBy] as number) || 0;
    candidates.sort((a, b) => (readSort(a) - readSort(b)) * dir);
  }

  return candidates.slice(0, limit);
}

// ── Market-Structure Screen (MONEY-1204 / 14e.1) ─────────────────────

/**
 * Cap on the candidate set handed to the market-structure pass.
 *
 * Every candidate costs a row in up to eight batched reads, chunked 100 at a
 * time — so this number, not the price chunker's, is what bounds a
 * market-structure screen. 500 is a deliberate bound, not a measurement: it
 * keeps a flags-only screen to five chunks per source.
 *
 * The right long-term shape for the flag fields is the INVERSE read — start
 * from `StockFlag` on the newest published day and take those symbols, which is
 * exact and reads one table — rather than scanning a universe slice. Left as a
 * follow-up because it only helps the boolean fields; the numeric ones
 * (delivery, pledge, PCR) genuinely need a universe.
 */
export const SCREENER_MARKET_UNIVERSE_LIMIT = 500;

/** Cap on a technical PRE-filter feeding a market-structure pass. */
export const SCREENER_PREFILTER_LIMIT = 500;

/**
 * Seed a market-structure-only screen from `InstrumentMapping`.
 *
 * The universe half is chosen by the requested FIELDS: DEBT when every market
 * filter is a bond field, equities otherwise. Bonds carry no `StockRatios` row,
 * so the fundamental path cannot seed them at all.
 */
async function seedMarketUniverse(
  filters: ScreenerFilter[],
  exchange: string | undefined,
  deps: ScreenerDeps = {},
): Promise<ScreenerResult[]> {
  const db = deps.prisma ?? prisma;
  const universe = marketFieldUniverse(filters.map((f) => f.field));

  const instruments = await db.instrumentMapping.findMany({
    where: {
      isActive: true,
      instrumentType: universe === "DEBT" ? "DEBT" : "EQUITY",
      ...(exchange ? { exchange } : {}),
    },
    select: {
      symbol: true,
      exchange: true,
      name: true,
      sector: true,
    },
    take: SCREENER_MARKET_UNIVERSE_LIMIT,
  });

  return instruments.map((i) => ({
    symbol: i.symbol,
    exchange: i.exchange,
    name: i.name,
    sector: i.sector,
  }));
}

/**
 * Keep only the candidates satisfying every market-structure filter, and attach
 * the resolved values to the survivors so the result can be cited.
 *
 * Exported for the same reason `applyTechnicalFilters` is: it is the whole of
 * the new behaviour, and it is testable against an injected Prisma double with
 * no database.
 *
 * The two properties worth stating outright, because they are what the tests
 * pin:
 *
 *   * A candidate whose value for a filtered field is UNKNOWN is DROPPED. That
 *     is why a filter on the permanently-null `mwplUtilisation` returns nothing
 *     rather than everything, and why the nearly-empty bond tables degrade to
 *     zero matches instead of an error.
 *   * `values.market` is attached only to SURVIVORS. Attaching it to everything
 *     would ship a per-candidate multi-table read to callers that filtered it
 *     out anyway.
 *
 * `now` IS INJECTABLE FOR THE SAME REASON `loadMarketFieldValues`'s is, and
 * MONEY-1402 is what happens without it. Every read underneath this is bounded
 * by `MARKET_FIELD_LOOKBACK_DAYS` measured back from `now`, so a test with a
 * dated fixture and no injected clock does not assert a behaviour — it asserts
 * how long ago the fixture was written. One did, and it passed for thirty days
 * and then failed on 2026-09-13 with nothing changed but the calendar, turning
 * main red for every branch. The seam existed one layer down; this function
 * simply could not reach it.
 */
export async function applyMarketStructureFilters(
  candidates: ScreenerResult[],
  filters: ScreenerFilter[],
  deps: MarketFieldsDeps = {},
  now: number = Date.now(),
): Promise<ScreenerResult[]> {
  if (candidates.length === 0 || filters.length === 0) return candidates;

  const capped = candidates.slice(0, SCREENER_MARKET_UNIVERSE_LIMIT);
  const values = await loadMarketFieldValues(
    capped.map((c) => ({ symbol: c.symbol, exchange: c.exchange })),
    filters.map((f) => f.field),
    deps,
    now,
  );

  const out: ScreenerResult[] = [];
  for (const candidate of capped) {
    const resolved = values.get(
      marketFieldKey(candidate.symbol, candidate.exchange),
    );
    // No entry at all should be impossible (`loadMarketFieldValues` seeds one
    // per candidate), but if it ever happened the honest reading is "unknown",
    // and unknown excludes — never "matches everything".
    if (!resolved) continue;
    if (!matchesMarketFilters(resolved, filters)) continue;
    out.push({ ...candidate, market: resolved });
  }
  return out;
}

// ── Fundamental Screen ───────────────────────────────────────────────

async function runFundamentalScreen(
  filters: ScreenerFilter[],
  exchange?: string,
): Promise<ScreenerResult[]> {
  // Build Prisma where clause from filters
  const where: Record<string, unknown> = {};

  for (const filter of filters) {
    const field = normalizeField(filter.field);
    if (!isFundamental(field)) {
      // No StockRatios column for this field (e.g. promoter/FII/DII holding, or
      // an unknown alias). Skip it VISIBLY rather than dropping it silently, so
      // missing-data filters are observable (MONEY-612 skills-health).
      console.warn(
        `[screener] dropping unsupported fundamental filter field "${filter.field}"`,
      );
      continue;
    }

    switch (filter.operator) {
      case "gt":
        where[field] = { gt: filter.value as number };
        break;
      case "gte":
        where[field] = { gte: filter.value as number };
        break;
      case "lt":
        where[field] = { lt: filter.value as number };
        break;
      case "lte":
        where[field] = { lte: filter.value as number };
        break;
      case "eq":
        where[field] = filter.value;
        break;
      case "between": {
        const [min, max] = filter.value as [number, number];
        where[field] = { gte: min, lte: max };
        break;
      }
    }
  }

  if (exchange) {
    where.exchange = exchange;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ratios = await prisma.stockRatios.findMany({
    where: where as any,
    include: {
      instrument: { select: { name: true, sector: true } },
    },
    take: 200,
  });

  return ratios.map((r) => ({
    symbol: r.symbol,
    exchange: r.exchange,
    name: r.instrument?.name || r.symbol,
    sector: r.instrument?.sector,
    pe: r.pe,
    pb: r.pb,
    roe: r.roe,
    roce: r.roce,
    marketCap: r.marketCap,
    dividendYield: r.dividendYield,
    debtToEquity: r.debtToEquity,
  }));
}

// ── 52-Week Distance Fast-Path (Yahoo Quotes) ───────────────────────

/**
 * For distance_52w_low/high filters, use Yahoo batch quotes instead of
 * iterating DailyPrice candles. Yahoo returns fiftyTwoWeekHigh/Low directly.
 * This is 100x faster and doesn't depend on price-sync having populated DailyPrice.
 */
async function run52WeekDistanceScreen(
  filters: ScreenerFilter[],
  exchange?: string,
  limit = 50,
  indexFilter?: string,
): Promise<ScreenerResult[] | null> {
  // Only handle pure distance_52w filters
  const distanceFilters = filters.filter(
    (f) => f.field === "distance_52w_low" || f.field === "distance_52w_high",
  );
  if (
    distanceFilters.length !== filters.length ||
    distanceFilters.length === 0
  ) {
    return null; // Mixed filters - fall through to standard path
  }

  // Get candidate symbols (from index or broad universe)
  let symbols: Array<{
    symbol: string;
    yahooSymbol: string;
    name: string;
    sector?: string | null;
    exchange: string;
  }>;

  if (indexFilter) {
    const { getIndexConstituents } = await import("./index-constituents");
    const constituents = await getIndexConstituents(indexFilter);
    if (!constituents || constituents.length === 0) return null;

    const symbolSet = new Set(constituents.map((s: string) => s.toUpperCase()));
    symbols = await prisma.instrumentMapping.findMany({
      where: {
        isActive: true,
        instrumentType: "EQUITY",
        symbol: { in: Array.from(symbolSet) },
        ...(exchange ? { exchange } : {}),
      },
      select: {
        symbol: true,
        yahooSymbol: true,
        name: true,
        sector: true,
        exchange: true,
      },
    });
  } else {
    // Without index, take top stocks by market cap (from StockRatios)
    const topRatios = await prisma.stockRatios.findMany({
      where: { marketCap: { gt: 0 } },
      orderBy: { marketCap: "desc" },
      take: 500,
      select: { symbol: true, exchange: true },
    });
    const topSymbols = topRatios.map((r) => r.symbol);
    symbols = await prisma.instrumentMapping.findMany({
      where: {
        isActive: true,
        instrumentType: "EQUITY",
        symbol: { in: topSymbols },
        ...(exchange ? { exchange } : {}),
      },
      select: {
        symbol: true,
        yahooSymbol: true,
        name: true,
        sector: true,
        exchange: true,
      },
    });
  }

  if (symbols.length === 0) return null;

  // Batch-fetch Yahoo quotes
  const { fetchQuotes } = await import("../market-data/yahoo-api");
  const yahooSymbols = symbols.map((s) => s.yahooSymbol).filter(Boolean);
  const quotes = await fetchQuotes(yahooSymbols);

  // Filter by 52-week distance criteria
  const results: ScreenerResult[] = [];
  const symbolMap = new Map(symbols.map((s) => [s.yahooSymbol, s]));

  for (const [yahooSym, quote] of Array.from(quotes.entries())) {
    const inst = symbolMap.get(yahooSym);
    if (!inst) continue;

    const price = quote.regularMarketPrice;
    const high52 = quote.fiftyTwoWeekHigh;
    const low52 = quote.fiftyTwoWeekLow;
    if (!price || price <= 0) continue;

    const distFromLow =
      low52 && low52 > 0 ? ((price - low52) / low52) * 100 : undefined;
    const distFromHigh =
      high52 && high52 > 0 ? ((high52 - price) / high52) * 100 : undefined;

    let matches = true;
    for (const f of distanceFilters) {
      const val = f.field === "distance_52w_low" ? distFromLow : distFromHigh;
      if (val === undefined) {
        matches = false;
        break;
      }

      if (
        (f.operator === "lt" && val >= (f.value as number)) ||
        (f.operator === "lte" && val > (f.value as number)) ||
        (f.operator === "gt" && val <= (f.value as number)) ||
        (f.operator === "gte" && val < (f.value as number))
      ) {
        matches = false;
        break;
      }
    }

    if (matches) {
      results.push({
        symbol: inst.symbol,
        exchange: inst.exchange,
        name: inst.name,
        sector: inst.sector,
        price,
        distanceFrom52WeekLow: distFromLow,
        distanceFrom52WeekHigh: distFromHigh,
        fiftyTwoWeekHigh: high52,
        fiftyTwoWeekLow: low52,
      });
    }

    if (results.length >= limit) break;
  }

  // Sort by distance (closest to target first)
  const useLow = distanceFilters[0]?.field === "distance_52w_low";
  results.sort((a, b) => {
    const aVal =
      (useLow ? a.distanceFrom52WeekLow : a.distanceFrom52WeekHigh) ?? 999;
    const bVal =
      (useLow ? b.distanceFrom52WeekLow : b.distanceFrom52WeekHigh) ?? 999;
    return aVal - bVal;
  });

  // Fire-and-forget: backfill missing sectors from Yahoo quoteSummary
  const missingSectors = results.filter((r) => !r.sector);
  if (missingSectors.length > 0) {
    backfillMissingSectors(
      missingSectors.map((r) => ({ symbol: r.symbol, exchange: r.exchange })),
    ).catch(() => {});
  }

  return results.slice(0, limit);
}

/**
 * Backfill missing sectors for instruments using Yahoo quoteSummary.
 * Updates InstrumentMapping so next screener run has the data.
 */
async function backfillMissingSectors(
  stocks: Array<{ symbol: string; exchange: string }>,
): Promise<void> {
  const { fetchQuoteSummary } = await import("../market-data/yahoo-api");

  for (const stock of stocks.slice(0, 10)) {
    try {
      const yahooSymbol = `${stock.symbol}.${stock.exchange === "BSE" ? "BO" : "NS"}`;
      const data = await fetchQuoteSummary(yahooSymbol, ["assetProfile"]);
      const profile = (data as Record<string, unknown>)?.assetProfile as
        | Record<string, unknown>
        | undefined;
      const rawSector = profile?.sector as string | undefined;

      if (rawSector) {
        // MONEY-1093 - two independent defects, on two axes.
        //
        // NORMALISE: this wrote Yahoo's raw GICS string ("Technology",
        // "Consumer Cyclical", "Basic Materials", "Consumer Defensive",
        // "Communication Services", "Real Estate"), none of which is in
        // NSE_SECTORS. It runs on EVERY fundamental screener request, so it was
        // a live, continuous source of non-canonical sector values — which is
        // why repairing the data without fixing this writer would have been
        // undone by the next screener run.
        //
        // TYPE: fixing only the normalisation left the worse half open. The
        // filter was `{ symbol, exchange }` — no instrumentType, no isActive —
        // so this happily wrote a (now canonical) sector back onto a bond that
        // the nightly job had just cleared. Because that clear only ever
        // revisits rows still typed EQUITY, the sector stayed. A bond reaches
        // here whenever it has a StockRatios row: `buildFinancialTierWhere`
        // gates ratio SYNC on instrumentType EQUITY, but rows synced before the
        // retype keep their ratios, and `runFundamentalScreen` joins them with
        // no type filter — so the bond comes back with a null sector, lands in
        // `missingSectors`, and gets enriched.
        //
        // MONEY-1302 — a THIRD axis, and the one the normalise fix above only
        // half-closed. `normalizeToNseSector` ends in `return rawSector`: it
        // maps the six GICS strings named above and passes ANYTHING ELSE
        // through verbatim. So a label with no alias — a GICS rename, a new
        // Yahoo sector, "Media & Entertainment" — was still written raw, by
        // this writer, on every fundamental screener request. That is
        // continuous, silent and unrecoverable: the screener's sector facet
        // cannot reach an off-taxonomy value, and `sector-enrichment.ts` only
        // re-selects rows whose sector is null/empty, so the row never heals.
        // Repairing the 101 prod rows without closing this would have let the
        // next screener run start refilling them.
        //
        // `toWritableNseSector` returns null for anything off-taxonomy, and a
        // null here means WRITE NOTHING. Skipping is the recoverable direction:
        // the row keeps its missing sector and is retried on the next request,
        // whereas an off-taxonomy value written once is permanent.
        const writableSector = toWritableNseSector(rawSector);
        if (writableSector !== null) {
          await prisma.instrumentMapping.updateMany({
            where: {
              symbol: stock.symbol,
              exchange: stock.exchange,
              isActive: true,
              ...sectorWritableWhere(),
            },
            data: { sector: writableSector },
          });
        }
      }

      // Small delay to avoid rate limiting
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // Non-critical - skip silently
    }
  }
}

// ── Batched Candle Loading (MONEY-1125) ──────────────────────────────
//
// Both technical paths used to issue ONE `dailyPrice.findMany` per instrument
// from inside a sequential `for` loop: up to 2000 serial round trips in
// `runTechnicalScreen`, and 2 per candidate (mapping + prices) in
// `applyTechnicalFilters`. At this platform's server→Atlas latency that is tens
// of seconds, so every technical screen timed out before returning anything.
// The reads are now batched with `instrumentId: { in: [...] }` and grouped in
// memory, which is what the rest of this section exists to do CORRECTLY —
// a screener that quietly changes which rows it feeds the indicators returns
// different stocks to users, which is worse than being slow.
//
// Semantics preserved verbatim:
//
//   * The old per-instrument query was `orderBy: { date: "asc" }, take: 300`.
//     A `take` under an ASC sort reads from the START of the range, so that was
//     the OLDEST 300 candles, not the most recent 300 (its `~1 year of trading
//     days` comment notwithstanding, and unlike the sibling readers in
//     packages/services, which take `desc` and reverse). MONEY-1125 preserved
//     that verbatim while batching, on the correct grounds that a latency
//     ticket must not change which stocks a screen returns — and flagged the
//     window itself as a separate question.
//
//     MONEY-1133 answered it: the window was a BUG. Indicators computed on a
//     year-old window describe the past. `fetchCandleChunk` now sorts
//     `[instrumentId asc, date DESC]`, caps to the most recent
//     `SCREENER_CANDLE_LIMIT`, and reverses each series back to oldest-first
//     for `computeIndicators`. This DOES change which stocks a technical screen
//     returns — deliberately, and that is the point of the ticket.
//
//   * Sorting on `instrumentId` FIRST is load-bearing, not cosmetic: with `$in`
//     bounds on the leading field, `{ instrumentId: 1, date: 1 }` is served
//     directly by the `@@unique([instrumentId, date])` index as a sorted merge.
//     A bare `{ date: "asc" }` would group correctly too but asks MongoDB for a
//     blocking in-memory sort of the entire multi-instrument result set.
//
//   * An instrument with no price rows resolves to an EMPTY array, never
//     `undefined`, so it fails the `< 30 candles` gate exactly as the old
//     empty `findMany` did.

/** Per-instrument candle cap — the old per-instrument query's `take: 300`. */
export const SCREENER_CANDLE_LIMIT = 300;

/**
 * Instruments per batched `dailyPrice.findMany`.
 *
 * Sizing: the universe query caps at 2000 instruments, so 50 gives at most 40
 * price queries where there used to be up to 2000 — a ~50× cut in round trips,
 * which is the entire cost of these screens. It is deliberately not larger:
 * Prisma/Mongo has no per-group LIMIT, so a chunk transfers EVERY candle each
 * instrument has and the 300-cap is applied while grouping. `daily_prices` has
 * no retention job and grows ~250 rows/instrument/year, so a 50-instrument
 * chunk is ~12.5k rows at one year of history and ~62k at five, and 250 or 500
 * instruments would be 5–10× that in a single response.
 *
 * ## HARD CEILING: 200, and it is not about memory
 *
 * The memory argument above is a judgement call — raise it with a measurement
 * and you are fine. This one is not, and it binds first.
 *
 * `fetchCandleChunk` sorts `[{instrumentId:"asc"},{date:"desc"}]` under an `$in`
 * on the leading field. Mongo serves that from `@@unique([instrumentId, date])`
 * by EXPLODING the `$in` into one point-interval scan per value and merge
 * -sorting them — which is what makes the sort free. That explosion is capped by
 * the `internalQueryMaxScansToExplode` server parameter, default 200. Past it
 * the planner stops exploding and falls back to a BLOCKING sort: the index no
 * longer satisfies the order, so it buffers and sorts in memory under a 32MB
 * limit (100MB with allowDiskUse), on a result set that is already the largest
 * thing this function materialises.
 *
 * The failure is a cliff, not a slope, and it lands on the biggest screens — so
 * it would present as "the screener is slow/erroring for some users" long after
 * whoever raised the number had moved on. Keep this comfortably under 200
 * whatever the memory numbers say; `screener-chunk-explode-ceiling.test.ts`
 * enforces it.
 */
export const SCREENER_PRICE_CHUNK_SIZE = 50;

/**
 * Chunks fetched in parallel. Bounded on purpose: firing all chunks at once
 * would put many large concurrent reads on Atlas and hold every response in
 * memory, while running them serially would re-introduce (a smaller) N+1.
 *
 * Size x concurrency is what actually matters, because every chunk in a wave is
 * resident at once: 100x4 held 400 instruments' FULL history at peak — roughly
 * 40MB at one year and 200MB at five, against a 1GiB container, since there is
 * no server-side row cap (see above) and no retention job on `daily_prices`.
 * 50x2 holds 100 instruments' worth instead, a 4x reduction, for at most a
 * handful of extra round trips on a path that already went from up to 2000
 * queries down to tens. Raise these together only with a memory measurement
 * against real history depth.
 */
export const SCREENER_PRICE_CHUNK_CONCURRENCY = 2;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * ONE `dailyPrice.findMany` for a chunk of instruments → candles grouped by
 * instrumentId, oldest-first, capped at `SCREENER_CANDLE_LIMIT` each.
 */
async function fetchCandleChunk(
  db: typeof prisma,
  instrumentIds: string[],
): Promise<Map<string, OHLCV[]>> {
  const byInstrument = new Map<string, OHLCV[]>();
  if (instrumentIds.length === 0) return byInstrument;

  // MONEY-1133 — date DESCENDING, and that is the whole fix.
  //
  // This was `date: "asc"`, and a cap applied to an ASC stream keeps the
  // OLDEST 300 candles. So every technical signal on this platform — RSI, MA
  // crossovers, breakouts — was computed on a window ending roughly a year
  // ago. Not slow, not empty: confidently WRONG, describing the past as though
  // it were the present, with no symptom a user or a test could see.
  //
  // MONEY-1125 spotted the ASC/take interaction while batching these reads and
  // deliberately preserved it, on the correct grounds that a latency ticket
  // must not silently change which stocks a screen returns. This is the
  // separate ticket it called for.
  //
  // `instrumentId` still leads the sort, which is load-bearing rather than
  // cosmetic: with `$in` bounds on the leading field, `{instrumentId, date}` is
  // served straight from the `@@unique([instrumentId, date])` index as a sorted
  // merge. Flipping only the second key keeps that property — MongoDB walks the
  // same index backwards within each instrument's range.
  const rows = await db.dailyPrice.findMany({
    where: { instrumentId: { in: instrumentIds } },
    orderBy: [{ instrumentId: "asc" }, { date: "desc" }],
    select: {
      instrumentId: true,
      date: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
  });

  for (const row of rows) {
    let candles = byInstrument.get(row.instrumentId);
    if (!candles) {
      candles = [];
      byInstrument.set(row.instrumentId, candles);
    }
    // Cap while streaming, so we RETAIN at most 300 rows per instrument however
    // deep history gets. Against a DESC stream this keeps the most recent 300.
    if (candles.length >= SCREENER_CANDLE_LIMIT) continue;
    candles.push({
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    });
  }

  // `computeIndicators` requires OLDEST-FIRST input — every moving average and
  // lookback in it walks the array forwards. We collected newest-first to make
  // the cap select the recent window, so each series is reversed back.
  //
  // Reversing AFTER the cap is what makes this correct: reversing the full
  // stream first, then capping, would land back on the oldest 300.
  for (const candles of byInstrument.values()) candles.reverse();

  return byInstrument;
}

/**
 * Candles for an arbitrary id list: chunked, with bounded concurrency, merged
 * into one map. Used where every instrument is needed up front (no early exit).
 */
async function fetchCandlesForInstruments(
  db: typeof prisma,
  instrumentIds: string[],
): Promise<Map<string, OHLCV[]>> {
  const merged = new Map<string, OHLCV[]>();
  const unique = Array.from(new Set(instrumentIds));
  const chunks = chunkArray(unique, SCREENER_PRICE_CHUNK_SIZE);

  for (let i = 0; i < chunks.length; i += SCREENER_PRICE_CHUNK_CONCURRENCY) {
    const wave = chunks.slice(i, i + SCREENER_PRICE_CHUNK_CONCURRENCY);
    const maps = await Promise.all(
      wave.map((ids) => fetchCandleChunk(db, ids)),
    );
    for (const map of maps) {
      for (const [instrumentId, candles] of map) {
        merged.set(instrumentId, candles);
      }
    }
  }

  return merged;
}

/** Exact `(symbol, exchange)` key — never symbol alone: the same symbol trades
 *  on both NSE and BSE and they are different instruments. The NUL separator
 *  cannot occur in either field, so two distinct pairs can never collide. */
function pairKey(symbol: string, exchange: string): string {
  return `${symbol}\u0000${exchange}`;
}

// ── Technical Screen ─────────────────────────────────────────────────

export async function runTechnicalScreen(
  filters: ScreenerFilter[],
  exchange?: string,
  limit = 50,
  deps: ScreenerDeps = {},
): Promise<ScreenerResult[]> {
  const db = deps.prisma ?? prisma;

  // Get all active equity instruments with daily price data
  const instruments = await db.instrumentMapping.findMany({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      ...(exchange ? { exchange } : {}),
    },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      name: true,
      sector: true,
    },
    take: 2000, // Process up to 2000 at a time
  });

  const results: ScreenerResult[] = [];

  // Prices are fetched a WAVE of chunks ahead of the scan rather than all
  // 2000 up front, so the `results.length >= limit` exit below still stops the
  // work early — it now saves a wave of batched reads instead of one read per
  // instrument. Instruments are visited in exactly the DB's order (chunks are
  // contiguous slices, walked in order), so the output array is unchanged.
  const instrumentChunks = chunkArray(instruments, SCREENER_PRICE_CHUNK_SIZE);

  for (
    let i = 0;
    i < instrumentChunks.length;
    i += SCREENER_PRICE_CHUNK_CONCURRENCY
  ) {
    const wave = instrumentChunks.slice(
      i,
      i + SCREENER_PRICE_CHUNK_CONCURRENCY,
    );
    const candleMaps = await Promise.all(
      wave.map((group) =>
        fetchCandleChunk(
          db,
          group.map((inst) => inst.id),
        ),
      ),
    );

    for (let w = 0; w < wave.length; w++) {
      const candlesById = candleMaps[w]!;

      for (const inst of wave[w]!) {
        const ohlcv = candlesById.get(inst.id) ?? [];

        if (ohlcv.length < 30) continue; // Not enough data

        const indicators = computeIndicators(ohlcv);

        if (matchesTechnicalFilters(indicators, filters)) {
          results.push({
            symbol: inst.symbol,
            exchange: inst.exchange,
            name: inst.name,
            sector: inst.sector,
            rsi14: indicators.rsi14,
            macd: indicators.macd,
            sma50: indicators.sma50,
            sma200: indicators.sma200,
            price: ohlcv[ohlcv.length - 1]?.close,
            volumeRatio: indicators.volumeRatio,
          });
        }

        // The old loop's `if (results.length >= limit) break;` — same position
        // (after the <30 `continue`, after the push), and the old `break` fell
        // straight into `return results`. Kept as a return so it exits the
        // chunk/wave nesting at the identical point.
        if (results.length >= limit) return results;
      }
    }
  }

  return results;
}

// ── Apply Technical Filters to Candidates ────────────────────────────

export async function applyTechnicalFilters(
  candidates: ScreenerResult[],
  filters: ScreenerFilter[],
  deps: ScreenerDeps = {},
): Promise<ScreenerResult[]> {
  const db = deps.prisma ?? prisma;
  const results: ScreenerResult[] = [];

  // No candidates → no queries at all, exactly as the old empty loop.
  if (candidates.length === 0) return results;

  // ONE mapping query for every candidate (was `findFirst` per candidate).
  // `symbol IN … AND exchange IN …` can return pairs no candidate asked for
  // (RELIANCE.BSE when only RELIANCE.NSE and TCS.BSE were requested); those are
  // simply never looked up, because the map is keyed on the exact PAIR.
  // `@@unique([symbol, exchange])` on InstrumentMapping means at most one row
  // per key, so there is no findFirst tie to reproduce — the `!has` guard keeps
  // first-seen anyway, which is what findFirst would have returned.
  const mappings = await db.instrumentMapping.findMany({
    where: {
      symbol: { in: Array.from(new Set(candidates.map((c) => c.symbol))) },
      exchange: { in: Array.from(new Set(candidates.map((c) => c.exchange))) },
      isActive: true,
    },
    select: { id: true, symbol: true, exchange: true },
  });

  const instrumentIdByPair = new Map<string, string>();
  for (const row of mappings) {
    const key = pairKey(row.symbol, row.exchange);
    if (!instrumentIdByPair.has(key)) instrumentIdByPair.set(key, row.id);
  }

  // Only the candidates that actually resolved get their prices fetched — an
  // unresolved candidate was `continue`d before its price query in the old loop.
  const resolvedIds: string[] = [];
  for (const candidate of candidates) {
    const id = instrumentIdByPair.get(
      pairKey(candidate.symbol, candidate.exchange),
    );
    if (id) resolvedIds.push(id);
  }
  const candlesById = await fetchCandlesForInstruments(db, resolvedIds);

  for (const candidate of candidates) {
    const instrumentId = instrumentIdByPair.get(
      pairKey(candidate.symbol, candidate.exchange),
    );

    if (!instrumentId) continue;

    const ohlcv = candlesById.get(instrumentId) ?? [];

    if (ohlcv.length < 30) continue;

    const indicators = computeIndicators(ohlcv);

    if (matchesTechnicalFilters(indicators, filters)) {
      results.push({
        ...candidate,
        rsi14: indicators.rsi14,
        macd: indicators.macd,
        sma50: indicators.sma50,
        sma200: indicators.sma200,
        price: ohlcv[ohlcv.length - 1]?.close,
        volumeRatio: indicators.volumeRatio,
      });
    }
  }

  return results;
}

// ── Filter Matching ──────────────────────────────────────────────────

export const TECHNICAL_FIELD_MAP: Record<string, keyof TechnicalIndicators> = {
  rsi_14: "rsi14",
  macd: "macd",
  macd_signal: "macdSignal",
  macd_histogram: "macdHistogram",
  sma_20: "sma20",
  sma_50: "sma50",
  sma_200: "sma200",
  ema_12: "ema12",
  ema_26: "ema26",
  bollinger_upper: "bollingerUpper",
  bollinger_lower: "bollingerLower",
  bollinger_bandwidth: "bollingerBandwidth",
  atr_14: "atr14",
  stoch_k: "stochK",
  stoch_d: "stochD",
  williams_r: "williamsR",
  obv: "obv",
  volume_ratio: "volumeRatio",
  distance_52w_high: "distanceFrom52WeekHigh",
  distance_52w_low: "distanceFrom52WeekLow",
  golden_cross: "goldenCross",
  death_cross: "deathCross",
  price_above_sma200: "priceAboveSma200",
};

export function matchesTechnicalFilters(
  indicators: TechnicalIndicators,
  filters: ScreenerFilter[],
): boolean {
  for (const filter of filters) {
    const key = TECHNICAL_FIELD_MAP[filter.field];
    // SKIPPED, deliberately — and the guard that makes it safe is in the tests.
    //
    // An unevaluable filter is dropped rather than failing the stock. That is
    // the dangerous direction in the abstract: the user asked to narrow the
    // universe, the filter vanished, and the screen returns MORE than it should
    // while appearing to have applied. I tried changing it to `return false`
    // and reverted — a SAVED screen referencing a field removed in a later
    // release would then return zero results instead of degrading gracefully,
    // which is a product decision, not a bug fix.
    //
    // What made the skip risky was that nothing stopped the two lists from
    // diverging. `TECHNICAL_FIELDS` gates `isTechnical` upstream in
    // `runScreener`; this map decides evaluability. Add a name to the SET and
    // forget the MAP and every screen using it silently returns the whole
    // market. The suite checked only map-subset-of-set — the half where a
    // mismatch is inert. It now asserts BOTH directions (MONEY-1238), so this
    // branch is unreachable rather than merely survivable, and the graceful
    // degrade is kept for the case it was actually written for.
    if (!key) continue;

    const val = indicators[key];
    if (val === undefined || val === null) return false;

    const numVal = typeof val === "boolean" ? (val ? 1 : 0) : (val as number);

    // A non-finite indicator (NaN/Infinity — e.g. an RSI/MACD that couldn't be
    // computed from insufficient or degenerate price data) must EXCLUDE the
    // stock, not silently pass. Every relational comparison against NaN is
    // `false`, so without this guard `gt`/`lt`/`between` never hit their "fail"
    // branch and a NaN-metric stock leaks into screen results. Treat it like a
    // missing value → reject.
    if (!Number.isFinite(numVal)) return false;

    switch (filter.operator) {
      case "gt":
        if (numVal <= (filter.value as number)) return false;
        break;
      case "gte":
        if (numVal < (filter.value as number)) return false;
        break;
      case "lt":
        if (numVal >= (filter.value as number)) return false;
        break;
      case "lte":
        if (numVal > (filter.value as number)) return false;
        break;
      case "eq":
        if (numVal !== (filter.value as number)) return false;
        break;
      case "between": {
        const [min, max] = filter.value as [number, number];
        if (numVal < min || numVal > max) return false;
        break;
      }
    }
  }
  return true;
}

// ── Run Strategy ─────────────────────────────────────────────────────

/**
 * Run a pre-built strategy by loading its filters and executing the screener
 */
export async function runStrategy(
  strategy: ScreenerStrategy,
  options?: ScreenerOptions,
): Promise<ScreenerResult[]> {
  const results = await runScreener(strategy.filters, options);

  // Store snapshot for future backtesting
  try {
    await prisma.screenerSnapshot.create({
      data: {
        strategyId: strategy.id,
        resultCount: results.length,
        symbols: results.map((r) => r.symbol as string),
        filters: JSON.parse(JSON.stringify(strategy.filters)),
      },
    });
  } catch {
    // Non-critical
  }

  return results;
}
