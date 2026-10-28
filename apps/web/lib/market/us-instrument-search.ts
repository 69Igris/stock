/**
 * US instrument search — `us_instruments`, Atlas Search with a Prisma fallback
 * (MONEY-980).
 *
 * ## Why a second module rather than a widening of `atlas-search.ts`
 *
 * US listings live in their own collection. `instrument_mappings` is
 * `@@unique([yahooSymbol])` — one row per ticker — and 2,196 US tickers repeat
 * (`DOW` is Dow Chemical 1972-2017 AND Dow Inc. 2019-, identical in exchange,
 * assetType and currency), so the India table structurally cannot hold the
 * delisted tail. The delisted tail is the point: the founder decision is that
 * a user who searches `LEH` finds Lehman Brothers, sees it is delisted, and can
 * open it — which is what makes the on-request cold-storage load reachable.
 *
 * The search index follows the collection, so the query builder does too.
 *
 * ## Three things this file must get right, each with a silent failure mode
 *
 * 1. **`exchange`, `assetType` and `listingStatus` are TOKEN fields** in
 *    `us_instrument_search` (docs/setup/atlas-search-setup.md). A token field
 *    answers `equals` / `in` and matches NOTHING under `text` — with no error
 *    (MONEY-1128, then again in MONEY-1141). Every filter below uses `in`.
 * 2. **`assetType` values are NOT upper-cased.** Token matching is exact and
 *    Tiingo writes `Stock` / `ETF` / `Mutual Fund`. `exchange` IS upper-cased,
 *    because Tiingo writes `NASDAQ` / `NYSE ARCA` in upper case already and a
 *    caller's casing should not decide whether the filter matches.
 * 3. **`name` is NULLABLE.** `supported_tickers.zip` carries no company name;
 *    a separate paced leg fills it over ~9 nights. A row the leg has not
 *    reached is searchable by SYMBOL only, and must rank last rather than be
 *    dropped or be shown as a copy of its own ticker.
 *
 * ## Fallback discipline
 *
 * Same LADDER as the India path — Atlas when the shared gate says it is
 * available, Prisma `startsWith` / `contains` otherwise — with one deliberate
 * DIFFERENCE: nothing here ever throws. India's leg rethrows an unclassified
 * `$search` fault so it surfaces as a 500, which is right for the leg that is
 * the answer; this one shares a `Promise.all` with India's legs under a single
 * route-level 500, so a throw would delete India's results for a fault confined
 * to a collection that is empty in every environment. Failures are classified,
 * logged and counted through {@link reportUsSearchFailure} instead.
 *
 * The Prisma leg is not the lesser path — QA and local have NO Atlas Search
 * index, so it is the ONLY path either of them ever runs. Its two passes are
 * built by exported pure functions ({@link buildUsSymbolPassArgs},
 * {@link buildUsNamePassArgs}) and executed through an injectable finder, so
 * an `orderBy` that starves the row the user typed is a red test rather than a
 * silent "no such ticker".
 *
 * @see docs/setup/atlas-search-setup.md — Step 2b (the index IS the deployment;
 *      it is created by hand in the Atlas UI, so the doc is the source of truth)
 */

import { prisma, Prisma } from "@usemoney/database";
import {
  isAtlasSearchEnabled,
  reportSearchFailure,
} from "@usemoney/core/search/atlas-gate";

/**
 * The Atlas Search index on `us_instruments`.
 *
 * Deliberately a local constant rather than a new member of `SEARCH_INDEX` in
 * `@usemoney/core/search/atlas-gate`: that map exists so subsystems which query
 * the SAME index share one latch key, and `apps/web` is the only caller of this
 * one. The gate keys latches by the string it is handed, so behaviour is
 * identical either way — move it into `SEARCH_INDEX` the day a second package
 * queries `us_instruments`.
 */
export const US_INSTRUMENT_SEARCH_INDEX = "us_instrument_search";

/** Gate/metric tag for this subsystem. */
const SUBSYSTEM = "web.market.us-instruments";

/** Mongo collection backing `UsInstrument`. */
const US_INSTRUMENT_COLLECTION = "us_instruments";

/** `listingStatus` values. Required on every row — there is no third state. */
export const US_LISTING_STATUS = {
  ACTIVE: "ACTIVE",
  DELISTED: "DELISTED",
} as const;

/**
 * Tiingo `assetType` values, verbatim. Exported because the caller has to map
 * a request's `types` filter onto these, and a typo here is a filter that
 * matches nothing rather than a compile error.
 */
export const US_ASSET_TYPE = {
  STOCK: "Stock",
  ETF: "ETF",
  MUTUAL_FUND: "Mutual Fund",
} as const;

export type UsAssetType = (typeof US_ASSET_TYPE)[keyof typeof US_ASSET_TYPE];

// ============== TYPES ==============

/**
 * One `us_instruments` hit, in the shape both backends produce.
 *
 * `listingEndDate` is deliberately `string | null` rather than a `Date`: this
 * row is JSON-serialised into the response and into the search cache, so a
 * `Date` would come back from Redis as a string anyway. Normalising at the
 * boundary keeps the type honest on both sides of the cache.
 */
export interface UsInstrumentSearchRow {
  /** `{symbol}:{exchange}:{listingStartDate}` — the security identity. */
  listingId: string;
  symbol: string;
  exchange: string;
  assetType: string;
  /** NULL until the paced Tiingo name leg reaches this row. */
  name: string | null;
  listingStatus: string;
  /** ISO 8601, or null for an active listing (and for a delisted row with no date). */
  listingEndDate: string | null;
  /** `$meta: "searchScore"` — absent on the Prisma fallback. */
  score?: number;
}

export interface UsInstrumentSearchOptions {
  limit?: number;
  /** Tiingo asset types to keep. Empty/omitted = all three. */
  assetTypes?: string[];
  /** Venue allow-list. Empty/omitted = every US venue. */
  exchanges?: string[];
  /**
   * `listingStatus` allow-list. Omitted = BOTH, which is the product default —
   * see the module header. Narrowing emits an `in` filter on the token field.
   */
  listingStatuses?: string[];
  fuzzy?: boolean;
}

interface RawCommandResult {
  cursor?: {
    firstBatch?: Record<string, unknown>[];
  };
  ok?: number;
}

// ============== ATLAS ==============

/**
 * Build the `$search` pipeline for US instrument search. Pure (no I/O), so the
 * operator/field pairing is unit-testable without a cluster — the only way a
 * wrong operator is ever caught, since a token field queried with `text`
 * returns zero rows and no error.
 */
export function buildUsInstrumentSearchPipeline(
  query: string,
  options: UsInstrumentSearchOptions = {}
): Record<string, unknown>[] {
  const {
    limit = 10,
    assetTypes,
    exchanges,
    listingStatuses,
    fuzzy = true,
  } = options;

  const matchLegs: Record<string, unknown>[] = [
    // Prefix on the ticker. `minGrams: 1` in the index, so this reaches the 25
    // one-character US tickers (F, T, V, …) that India's `minGrams: 2` cannot.
    // `prefixLength: 1` rather than India's 1-for-symbol/2-for-name split for
    // the same reason: a 1-char query has no second character to anchor on.
    {
      autocomplete: {
        query,
        path: "symbol",
        fuzzy: { maxEdits: 1, prefixLength: 1 },
      },
    },
    {
      autocomplete: {
        query,
        path: "name",
        fuzzy: { maxEdits: 1, prefixLength: 2 },
      },
    },
    {
      text: {
        query,
        // Both are analysed string fields in the index (symbol also carries a
        // `lucene.keyword` mapping, name a `lucene.standard` one), so `text` is
        // the right operator here — unlike the three token fields below.
        path: ["symbol", "name"],
        ...(fuzzy ? { fuzzy: { maxEdits: 1, prefixLength: 2 } } : {}),
      },
    },
  ];

  const filterClauses: Record<string, unknown>[] = [];

  // NOTE: no `isActive` filter. `us_instruments` has no such field — a retired
  // listing is `listingStatus: "DELISTED"` and is RETAINED, not deactivated.
  // Filtering on a field the index does not map (`dynamic: false`) would return
  // zero rows for every query.

  if (assetTypes && assetTypes.length > 0) {
    filterClauses.push({
      // Verbatim, NOT upper-cased: token matching is exact and Tiingo writes
      // "Stock" / "Mutual Fund". `.toUpperCase()` here matches nothing.
      in: { path: "assetType", value: [...assetTypes] },
    });
  }

  if (exchanges && exchanges.length > 0) {
    filterClauses.push({
      in: { path: "exchange", value: exchanges.map((e) => e.toUpperCase()) },
    });
  }

  // Omitted = both statuses, expressed as NO filter rather than as
  // `in: ["ACTIVE","DELISTED"]`. Cheaper, and it cannot exclude a row whose
  // status is some value we did not anticipate — which for a user-visible
  // delisted tail is the failure that would be hardest to notice.
  if (listingStatuses && listingStatuses.length > 0) {
    filterClauses.push({
      in: {
        path: "listingStatus",
        value: listingStatuses.map((s) => s.toUpperCase()),
      },
    });
  }

  return [
    {
      $search: {
        index: US_INSTRUMENT_SEARCH_INDEX,
        compound: {
          must: [{ compound: { should: matchLegs, minimumShouldMatch: 1 } }],
          ...(filterClauses.length > 0 ? { filter: filterClauses } : {}),
        },
      },
    },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        listingId: 1,
        symbol: 1,
        name: 1,
        exchange: 1,
        assetType: 1,
        listingStatus: 1,
        listingEndDate: 1,
        score: { $meta: "searchScore" },
      },
    },
  ];
}

/**
 * Coerce whatever the driver hands back for a date into an ISO string.
 *
 * `$runCommandRaw` returns a Mongo extended-JSON `{ $date: … }` wrapper, Prisma
 * returns a `Date`, and a cached row returns the string it was serialised as.
 * All three reach the same mapper, so all three are normalised here.
 */
export function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value === "object") {
    const wrapped = (value as { $date?: unknown }).$date;
    if (wrapped !== undefined && wrapped !== value) return toIsoDate(wrapped);
    const numberLong = (value as { $numberLong?: unknown }).$numberLong;
    if (typeof numberLong === "string") return toIsoDate(Number(numberLong));
  }
  return null;
}

/** Normalise one raw document (either backend) into `UsInstrumentSearchRow`. */
export function normalizeUsInstrumentRow(
  doc: Record<string, unknown>
): UsInstrumentSearchRow | null {
  const symbol = typeof doc.symbol === "string" ? doc.symbol : null;
  if (!symbol) return null;

  const listingId =
    typeof doc.listingId === "string" && doc.listingId.length > 0
      ? doc.listingId
      : // A row written before `listingId` existed would otherwise dedupe
        // against every other such row and collapse the tail to one entry.
        // Falling back to a per-document key keeps them distinct.
        `${symbol}:${String(doc.exchange ?? "")}:${String(doc.listingStartDate ?? "")}`;

  const score = doc.score;

  return {
    listingId,
    symbol,
    exchange: typeof doc.exchange === "string" ? doc.exchange : "",
    assetType: typeof doc.assetType === "string" ? doc.assetType : "",
    // Empty string is treated as "no name", not as a name: both mean the paced
    // leg has nothing to show and the row must rank last.
    name:
      typeof doc.name === "string" && doc.name.trim().length > 0
        ? doc.name
        : null,
    listingStatus:
      typeof doc.listingStatus === "string" ? doc.listingStatus : "",
    listingEndDate: toIsoDate(doc.listingEndDate),
    ...(typeof score === "number" && Number.isFinite(score) ? { score } : {}),
  };
}

/**
 * Atlas Search over `us_instruments`.
 *
 * Returns `null` when Atlas could not answer — a non-Atlas deployment, a
 * missing or building index, a transient failure, OR an unclassified one — and
 * the caller must then use {@link searchUsInstrumentsPrisma}. An EMPTY array is
 * a real answer ("no such US ticker") and is NOT a fallback signal: falling
 * back on empty would put a collection scan of ~74k rows behind every query
 * that legitimately matches nothing.
 *
 * NEVER throws. See the catch block for why this leg diverges from India's.
 */
export async function searchUsInstrumentsAtlas(
  query: string,
  options: UsInstrumentSearchOptions = {}
): Promise<UsInstrumentSearchRow[] | null> {
  if (!isAtlasSearchEnabled(US_INSTRUMENT_SEARCH_INDEX, SUBSYSTEM)) {
    return null;
  }

  const pipeline = buildUsInstrumentSearchPipeline(query, options);

  try {
    const result = (await prisma.$runCommandRaw({
      aggregate: US_INSTRUMENT_COLLECTION,
      pipeline: pipeline as unknown as Prisma.InputJsonValue,
      cursor: {},
    })) as RawCommandResult;

    const docs = result?.cursor?.firstBatch ?? [];
    return docs
      .map(normalizeUsInstrumentRow)
      .filter((row): row is UsInstrumentSearchRow => row !== null);
  } catch (error) {
    // `null`, NEVER a rethrow — and that is where this leg deliberately
    // DIVERGES from `searchInstrumentsAtlas` (MONEY-980 review).
    //
    // India's leg rethrows an unclassified fault so it surfaces as a 500,
    // which is right for the leg that IS the answer. This one is a
    // flag-gated secondary section over a collection that is empty in every
    // environment today, and it rides the same `Promise.all` as India's two
    // legs — so a throw here does not degrade US search, it takes the ENTIRE
    // Indian result set down with it. A fault confined to `us_instruments`
    // must stay confined to `us_instruments`.
    //
    // No signal is lost by not throwing: `reportSearchFailure` has ALREADY
    // emitted the `search.backend.error` metric and the `atlas_search_error`
    // warn (with this subsystem tag) by the time it answers "rethrow". Only
    // the propagation is dropped, and the caller learns the same thing from
    // `null` that it learns from every other unavailability.
    reportSearchFailure({
      index: US_INSTRUMENT_SEARCH_INDEX,
      subsystem: SUBSYSTEM,
      error,
    });
    return null;
  }
}

// ============== FAILURE REPORTING ==============

/** Which leg of the US ladder a failure came from — a metric dimension. */
export type UsSearchStage = "atlas" | "fallback";

/**
 * Record a US-search failure, and NEVER let it escape.
 *
 * MONEY-980 review — the Prisma leg used to `catch { return []; }`: no log, no
 * metric, and the route still answered `success: true, source: "atlas"`. Every
 * failure was therefore indistinguishable from "no such ticker" — a stale
 * Prisma client, a required-field error and a blown in-memory sort all
 * presented as a clean empty result. India routes its failures through the
 * shared gate; this does the same, so the same dashboards see both.
 *
 * The gate's ANSWER is deliberately ignored. `reportSearchFailure` returns
 * "rethrow" for an unclassified error, which is right for the leg that IS the
 * answer and wrong here: US is a flag-gated secondary section sharing a
 * `Promise.all` with India's legs, so a throw takes India's results down with
 * it. What we want from the gate is its classification, its metric and its log
 * — not its propagation decision.
 *
 * Wrapped in its own try/catch because a reporter that throws would resurrect
 * exactly the 500 it exists to prevent.
 */
export function reportUsSearchFailure(
  stage: UsSearchStage,
  error: unknown
): void {
  try {
    reportSearchFailure({
      index: US_INSTRUMENT_SEARCH_INDEX,
      subsystem: `${SUBSYSTEM}.${stage}`,
      error,
    });
  } catch {
    // Best-effort by construction: see above.
  }
}

// ============== PRISMA FALLBACK ==============

/** Exactly the columns {@link normalizeUsInstrumentRow} reads. */
const US_SEARCH_SELECT = {
  listingId: true,
  symbol: true,
  name: true,
  exchange: true,
  assetType: true,
  listingStatus: true,
  listingEndDate: true,
} as const;

/**
 * `findMany` arguments for one pass of the fallback. Structural, so the passes
 * are pure values a test can inspect and a fake table can execute.
 */
export interface UsInstrumentFindManyArgs {
  where: Prisma.UsInstrumentWhereInput;
  select: typeof US_SEARCH_SELECT;
  take: number;
  orderBy: Prisma.UsInstrumentOrderByWithRelationInput[];
}

/** One `us_instruments` row as the fallback selects it. */
export interface UsInstrumentRecord {
  listingId: string;
  symbol: string;
  name: string | null;
  exchange: string;
  assetType: string;
  listingStatus: string;
  listingEndDate: Date | string | null;
}

/**
 * The DB call, injectable — the seam that makes the fallback testable at all.
 *
 * `searchUsInstrumentsPrisma` had NO test of any kind, and it is the ONLY leg
 * QA and local ever run (neither has an Atlas Search index). Its defects are
 * exactly the ones no type checker sees: an `orderBy` that starves the row the
 * user typed, a `take` that truncates the wrong end, a blanket catch.
 */
export type UsInstrumentFinder = (
  args: UsInstrumentFindManyArgs
) => Promise<UsInstrumentRecord[]>;

const defaultUsInstrumentFinder: UsInstrumentFinder = (args) =>
  prisma.usInstrument.findMany(args);

/**
 * The narrowing clauses (`assetType` / `exchange` / `listingStatus`) both
 * passes share. An omitted or empty array is NO clause — never "match
 * nothing" — mirroring {@link buildUsInstrumentSearchPipeline}.
 */
export function buildUsScopeWhere(
  options: UsInstrumentSearchOptions = {}
): Prisma.UsInstrumentWhereInput {
  const { assetTypes, exchanges, listingStatuses } = options;
  return {
    ...(assetTypes && assetTypes.length > 0
      ? { assetType: { in: [...assetTypes] } }
      : {}),
    ...(exchanges && exchanges.length > 0
      ? { exchange: { in: exchanges.map((e) => e.toUpperCase()) } }
      : {}),
    ...(listingStatuses && listingStatuses.length > 0
      ? { listingStatus: { in: listingStatuses.map((s) => s.toUpperCase()) } }
      : {}),
  };
}

/**
 * Pass 1 — the INDEXED symbol-prefix pass.
 *
 * ## `orderBy` is `symbol` ALONE, and that is the whole point of this function
 *
 * It used to be `[{ listingStatus: "asc" }, { symbol: "asc" }]`, justified as
 * "ACTIVE sorts before DELISTED, which is also the order the ranking wants".
 * Both halves are true and the conclusion is still wrong, because `take` runs
 * BEFORE the ranking: status-first orders the whole matched set by liveness, so
 * a `take: 12` returns the twelve alphabetically-first ACTIVE rows and the
 * DELISTED ones are never fetched at all.
 *
 * Measured consequence, on the only path QA and local ever run: `q=GM` matches
 * GMAB, GMBL, GMDA, GME, GMED, … as ACTIVE and General Motors — an EXACT ticker
 * match, DELISTED — is not in the page. `rows.length < limit` is then false, so
 * the name pass never runs either, and the answer is "no such ticker". That
 * defeats the stated purpose of this module: a user who searches a delisted
 * ticker must FIND it.
 *
 * `symbol: "asc"` alone is correct because a prefix sorts before every string
 * that extends it — "GM" < "GMAB" — so the exact hit is the FIRST row of the
 * page, whatever its status. Demotion of the delisted tail is the RANKING's job
 * (`marketRank`), which runs after every row has been fetched.
 *
 * It is also the only sort this table can serve without a blocking in-memory
 * sort: `@@index([symbol, exchange])` exists and `(listingStatus, symbol)` does
 * not. The schema's own note puts ~74k rows at ~18 MB against Mongo's hard
 * 32 MB sort ceiling — and a blown sort THROWS rather than degrading.
 */
export function buildUsSymbolPassArgs(
  query: string,
  options: UsInstrumentSearchOptions = {}
): UsInstrumentFindManyArgs {
  const { limit = 10 } = options;
  return {
    where: {
      ...buildUsScopeWhere(options),
      // Case-SENSITIVE, and indexed because of it: a `mode: "insensitive"`
      // prefix compiles to a `/…/i` regex, which Mongo cannot turn into index
      // bounds — it would scan the whole index on every debounced keystroke.
      // The casing safety net lives in pass 2, which is already a scan.
      symbol: { startsWith: query.toUpperCase() },
    },
    select: US_SEARCH_SELECT,
    take: limit,
    orderBy: [{ symbol: "asc" }],
  };
}

/**
 * Pass 2 — run ONLY when pass 1 under-fills, and unavoidably a scan.
 *
 * TWO queries rather than one `OR`, deliberately. `UsInstrument` indexes
 * `[symbol, exchange]` but NOT `name`, and Mongo only index-serves an `$or`
 * when EVERY branch has an index — so a single `OR: [symbol, name]` would drag
 * the cheap, index-served symbol branch down into the collection scan with it
 * (the MONEY-1129 regression, on a table 3x larger).
 *
 * Because this pass is a scan ALREADY, it can afford the case-insensitive
 * symbol branch that pass 1 cannot. That is the safety net for the "US tickers
 * are stored upper-case" invariant: it is asserted in three comments in this
 * file and enforced in zero lines of the writer, so pass 1 — which depends on
 * it — must not be the only way a symbol can be reached.
 *
 * `excludeListingIds` are the rows pass 1 already returned; `listingId` is the
 * model's only unique, so it is the correct exclusion key.
 */
export function buildUsNamePassArgs(
  query: string,
  options: UsInstrumentSearchOptions = {},
  excludeListingIds: string[] = [],
  take = 10
): UsInstrumentFindManyArgs {
  return {
    where: {
      ...buildUsScopeWhere(options),
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { symbol: { startsWith: query.toUpperCase(), mode: "insensitive" } },
      ],
      listingId: { notIn: excludeListingIds },
    },
    select: US_SEARCH_SELECT,
    take,
    orderBy: [{ symbol: "asc" }],
  };
}

/**
 * Regex/prefix fallback over `us_instruments` — QA, local, and prod whenever
 * the Atlas gate has latched.
 *
 * Returns `[]` on any error rather than throwing: this is already the fallback,
 * and a US failure must not take the India results down with it. The error is
 * NOT swallowed — {@link reportUsSearchFailure} classifies, logs and counts it,
 * so "the query failed" and "no such ticker" stop looking identical.
 */
export async function searchUsInstrumentsPrisma(
  query: string,
  options: UsInstrumentSearchOptions = {},
  find: UsInstrumentFinder = defaultUsInstrumentFinder
): Promise<UsInstrumentSearchRow[]> {
  const { limit = 10 } = options;

  try {
    const bySymbol = await find(buildUsSymbolPassArgs(query, options));

    let rows = bySymbol;

    if (rows.length < limit) {
      const byName = await find(
        buildUsNamePassArgs(
          query,
          options,
          rows.map((r) => r.listingId),
          limit - rows.length
        )
      );
      rows = [...rows, ...byName];
    }

    return rows
      .map((row) =>
        normalizeUsInstrumentRow(row as unknown as Record<string, unknown>)
      )
      .filter((row): row is UsInstrumentSearchRow => row !== null);
  } catch (error) {
    reportUsSearchFailure("fallback", error);
    return [];
  }
}

// ============== ORCHESTRATOR ==============

export interface UsInstrumentSearchResult {
  rows: UsInstrumentSearchRow[];
  /** True when the rows came from `$search` (so they carry a relevance score). */
  usedAtlas: boolean;
}

/**
 * The two backends, injectable so the FALLBACK LADDER itself can be tested.
 *
 * Not ceremony: "US falls back exactly like India does" is the central claim of
 * this module — QA and local have no Atlas Search index at all, so the regex
 * path is the ONLY path either of them ever runs — and without a seam it is a
 * convention that no test can distinguish from its own absence.
 */
export interface UsInstrumentSearchBackends {
  atlas: (
    query: string,
    options: UsInstrumentSearchOptions
  ) => Promise<UsInstrumentSearchRow[] | null>;
  fallback: (
    query: string,
    options: UsInstrumentSearchOptions
  ) => Promise<UsInstrumentSearchRow[]>;
}

const DEFAULT_BACKENDS: UsInstrumentSearchBackends = {
  atlas: searchUsInstrumentsAtlas,
  fallback: searchUsInstrumentsPrisma,
};

/**
 * Atlas first, Prisma on unavailability — the one entry point the route calls.
 *
 * `null` from the Atlas leg means "Atlas could not answer" (non-Atlas
 * deployment, index missing or building, transient failure) and is the ONLY
 * fallback trigger. An EMPTY array is a real answer and is returned as-is: this
 * route's fallback is a scan of ~74k rows, and paying for it on every query
 * that legitimately matches nothing would turn a miss into a load problem.
 *
 * An empty `us_instruments` — which is every environment today, the backfill
 * has not run — therefore yields `{ rows: [], … }` rather than an error, and
 * the caller renders "no US results".
 */
export async function searchUsInstruments(
  query: string,
  options: UsInstrumentSearchOptions = {},
  backends: UsInstrumentSearchBackends = DEFAULT_BACKENDS
): Promise<UsInstrumentSearchResult> {
  // NEITHER leg may throw out of this function, and that is a CONTAINMENT
  // property rather than defensive habit (MONEY-980 review).
  //
  // The route runs this inside the same `Promise.all` as India's instrument and
  // MF legs, under one route-level try/catch that answers 500. So any escaping
  // error here does not degrade US search — it deletes India's results too, for
  // a fault confined to a flag-gated collection that is EMPTY in every
  // environment today. The two default legs are already written not to throw;
  // this is what makes it true of an injected or future one as well.
  let atlasRows: UsInstrumentSearchRow[] | null = null;
  try {
    atlasRows = await backends.atlas(query, options);
  } catch (error) {
    reportUsSearchFailure("atlas", error);
    atlasRows = null;
  }
  if (atlasRows !== null) return { rows: atlasRows, usedAtlas: true };

  try {
    return { rows: await backends.fallback(query, options), usedAtlas: false };
  } catch (error) {
    reportUsSearchFailure("fallback", error);
    return { rows: [], usedAtlas: false };
  }
}
