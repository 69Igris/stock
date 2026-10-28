/**
 * Market Symbol Search — pure transforms (no server-only deps).
 *
 * Extracted from `app/api/market/search/route.ts` so the row mappers
 * (Atlas / Prisma instrument + MF + US listing → SearchResultItem), the
 * Indian-only Yahoo filter, the local-index query match, the US-market
 * gate, the dedup, and the multi-criteria relevance ranking can be
 * unit-tested against the REAL exported symbols instead of inline copies.
 *
 * The route handler owns auth + HTTP + the Atlas/Prisma/Yahoo fetch fan-out
 * and the cache read/write; it imports everything here. This module imports
 * nothing server-only (no Clerk / Prisma / network clients / next), so the
 * tests stay pure and exit cleanly.
 *
 * @see apps/web/__tests__/api/market-search.test.ts
 */

import { INDEX_MAPPINGS } from "@/lib/market/symbol-mapper";
import { withFormerlyHint } from "@usemoney/core/market-data";

/** Shared result row used throughout the search route + this module. */
export interface SearchResultItem {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  yahooSymbol: string;
  instrumentId?: string;
  sector?: string | null;
  instrumentType?: string;
  /**
   * MONEY-1205 — Atlas Search relevance (`$meta: "searchScore"`), carried from
   * the hit onto the row so the ranking can actually USE it.
   *
   * The `$project` in `buildInstrumentSearchPipeline` / `buildMfSearchPipeline`
   * has always asked for this field, and the mappers have always thrown it
   * away, so the one signal that knew "SBIETFQLTY scores 30.7 against 23.4 for
   * every other SBI ETF" died at the mapper and the final tiebreak fell through
   * to `name.localeCompare` — i.e. alphabetical. Undefined on non-Atlas rows
   * (Prisma / Yahoo / local indices), which is why the comparator reads it only
   * when `useAtlas` is true — or when both rows are US, whose leg latches
   * independently of India's.
   */
  score?: number;

  /**
   * MONEY-980 — which market this row belongs to.
   *
   * ABSENT means India. That is a deliberate asymmetry, and it is safe HERE for
   * the one reason it is unsafe in Mongo (MONEY-1050/1205/1234/1236): these are
   * in-process objects built by the mappers below, not documents whose fields
   * may predate a schema. Only {@link mapUsInstrument} ever writes `"US"`, and
   * every consumer asks {@link isUsResult} — one predicate, never a truthiness
   * test — so a row that lost the field to a JSON round trip through the cache
   * degrades to "India", which is what an absent field meant before US existed.
   */
  market?: "IN" | "US";
  /**
   * `{symbol}:{exchange}:{listingStartDate}` — US only.
   *
   * LOAD-BEARING FOR DEDUP, not decoration. `dedupeResults` collapses
   * equity/ETF rows by base symbol, and Tiingo's master holds two `DOW` rows on
   * NYSE (Dow Chemical 1972-2017, Dow Inc. 2019-) plus 2,196 other repeated
   * tickers. Keyed by symbol, the delisted half of every recycled ticker — the
   * entire reason `us_instruments` exists as its own collection — would be
   * silently discarded before ranking ever saw it.
   */
  listingId?: string;
  /** `ACTIVE` | `DELISTED`. US only; India rows are all active by query. */
  listingStatus?: string;
  /** ISO 8601 delisting date, so a UI can render `DELISTED · 2017`. */
  listingEndDate?: string | null;
  /** Tiingo's raw `Stock` / `ETF` / `Mutual Fund`, kept alongside `type`. */
  assetType?: string;
  /**
   * False when the US name leg has not reached this row yet — the row is
   * searchable by ticker alone and must rank last among its peers.
   *
   * A separate flag rather than `name === ""` because `name` is also what the
   * alphabetical tiebreak and the UI read, and conflating "no name yet" with
   * "empty name" is how a null would end up displayed as the symbol.
   */
  hasName?: boolean;
}

// ── Row shapes the upstream sources hand us (only the fields we read) ──

export interface AtlasInstrumentRow {
  _id?: { $oid: string };
  symbol: string;
  name: string;
  exchange: string;
  yahooSymbol: string;
  instrumentType: string;
  sector?: string | null;
  /** `$meta: "searchScore"` — optional so non-Atlas fixtures still typecheck. */
  score?: number;
}

export interface PrismaInstrumentRow {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  yahooSymbol: string;
  instrumentType: string;
  sector:
    | string
    | null; /** MONEY-1177 — former tickers, for the rename hint. */
  previousSymbols?: string[];
}

export interface AtlasMfRow {
  schemeCode: string;
  schemeName: string;
  amcName: string;
  category: string;
  /** `$meta: "searchScore"` — optional so non-Atlas fixtures still typecheck. */
  score?: number;
}

export interface PrismaMfRow {
  schemeCode: string;
  schemeName: string;
  amcName: string;
  category: string | null;
}

export interface YahooSearchRow {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  yahooSymbol: string;
}

// ── Query-string parsing (route input shaping) ──

/** Parse the `limit` query param: default 10, clamp to a hard ceiling of 50. */
export function parseSearchLimit(limitStr: string | null): number {
  // A non-numeric param (e.g. ?limit=abc) yields NaN from parseInt; clamp it
  // back to the default 10 so NaN never flows into `prisma … take:` or
  // `Array.slice(0, NaN)` (which would silently drop ALL results).
  const parsed = parseInt(limitStr || "10", 10);
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(parsed, 50);
}

/** `includeIndices` is on unless explicitly the literal string "false". */
export function parseIncludeIndices(value: string | null): boolean {
  return value !== "false";
}

/**
 * `includeUs` is OFF unless the caller explicitly asks for the literal string
 * "true" — the opposite default to {@link parseIncludeIndices}, deliberately.
 *
 * ## Why this parameter exists at all (MONEY-980 review)
 *
 * `/api/market/search` is a WRITE-SIDE picker feed, not only a navigation one.
 * `InstrumentSearch` calls it and is rendered by `AddTradeDialog`,
 * `AddMutualFundDialog` and `app/watchlist/client.tsx`; `CommandPalette` calls
 * it and routes the pick to `/stock/{symbol}?exchange={exchange}`, which
 * resolves against `prisma.instrumentMapping` ONLY. Every one of those
 * consumers takes the chosen `{symbol, exchange}` and puts it somewhere that
 * exclusively India machinery can resolve — a manual Trade row, a watchlist
 * item, a stock page that synthesises `DOW.NS` for a NYSE ticker it cannot
 * find. None of them carry `market`, `listingStatus` or `listingEndDate`;
 * `CommandPalette` maps the payload down to four fields and drops them.
 *
 * That is exactly the reasoning already written on `/api/market/autocomplete`
 * for keeping IT India-only — and it was applied to the wrong route: the
 * pickers use THIS one.
 *
 * So US rows became opt-in rather than flag-only. The flag decides whether the
 * feature EXISTS for a user; this decides whether the calling SURFACE can do
 * anything sensible with a US row. Both must be true, and a new consumer
 * inherits India-only by default instead of inheriting a leak.
 *
 * Fails closed on every unexpected value ("1", "yes", "TRUE", null, "") for the
 * same reason `Boolean("false")` is banned on `XBRL_PROJECTION_APPLY`: the one
 * state that must never be reachable by accident is "on".
 */
export function parseIncludeUs(value: string | null): boolean {
  return value === "true";
}

/** Parse a comma-list `types` param, dropping empties; null/undefined → []. */
export function parseTypes(typesStr: string | null | undefined): string[] {
  return typesStr?.split(",").filter(Boolean) ?? [];
}

/** A query is searchable only when present and at least 1 char long. */
export function isQueryValid(
  query: string | null | undefined
): query is string {
  return query != null && query.length >= 1;
}

export interface WantedTypes {
  wantEquity: boolean;
  wantMF: boolean;
  wantIndex: boolean;
  wantETF: boolean;
  wantDebt: boolean;
}

/**
 * Resolve which instrument families a request wants from its `types` filter.
 * An empty filter wants everything. EQUITY OR ETF both turn on `wantEquity`
 * (they share the instrument-search path).
 */
export function getWantedTypes(types: string[]): WantedTypes {
  const all = types.length === 0;
  return {
    wantEquity: all || types.includes("EQUITY") || types.includes("ETF"),
    wantMF: all || types.includes("MF"),
    wantIndex: all || types.includes("INDEX"),
    wantETF: all || types.includes("ETF"),
    // Only on an UNFILTERED search. An explicit `types=EQUITY` is a request for
    // equities and must not quietly return bonds; but "search everything" has to
    // mean everything, or an instrument a user actually holds is unfindable.
    wantDebt: all || types.includes("DEBT"),
  };
}

// ── Row mappers ──

/** Map an Atlas Search instrument hit → SearchResultItem. */
export function mapAtlasInstrument(inst: AtlasInstrumentRow): SearchResultItem {
  return {
    symbol: inst.symbol,
    name: inst.name,
    exchange: inst.exchange,
    type: inst.instrumentType,
    yahooSymbol: inst.yahooSymbol,
    instrumentId: inst._id?.$oid,
    sector: inst.sector ?? null,
    instrumentType: inst.instrumentType,
    // MONEY-1205 — keep Atlas's relevance; the comparator needs it.
    score: inst.score,
  };
}

/** Map a Prisma instrumentMapping row → SearchResultItem. */
export function mapPrismaInstrument(
  inst: PrismaInstrumentRow,
  query = ""
): SearchResultItem {
  return {
    symbol: inst.symbol,
    // MONEY-1177 — explain a rename rather than returning a stranger's name.
    name: withFormerlyHint(inst.name, inst.previousSymbols, query),
    exchange: inst.exchange,
    type: inst.instrumentType,
    yahooSymbol: inst.yahooSymbol,
    instrumentId: inst.id,
    sector: inst.sector ?? null,
    instrumentType: inst.instrumentType,
  };
}

/** Map an Atlas Search MF hit → SearchResultItem. (`exchange` holds the AMC.) */
export function mapAtlasMf(mf: AtlasMfRow): SearchResultItem {
  return {
    symbol: mf.schemeCode,
    name: mf.schemeName,
    exchange: mf.amcName,
    type: "MF",
    yahooSymbol: "",
    instrumentId: undefined,
    sector: mf.category,
    instrumentType: "MF",
    // MONEY-1205 — keep Atlas's relevance; the comparator needs it.
    score: mf.score,
  };
}

/** Map a Prisma mutualFundMaster row → SearchResultItem. */
export function mapPrismaMf(mf: PrismaMfRow): SearchResultItem {
  return {
    symbol: mf.schemeCode,
    name: mf.schemeName,
    exchange: mf.amcName,
    type: "MF",
    yahooSymbol: "",
    instrumentId: undefined,
    sector: mf.category,
    instrumentType: "MF",
  };
}

/**
 * One `us_instruments` hit, in the shape both US backends produce
 * (`@/lib/market/us-instrument-search`). Restated structurally rather than
 * imported so this module keeps its "no server-only deps" property — the US
 * module imports Prisma.
 */
export interface UsInstrumentResultRow {
  listingId: string;
  symbol: string;
  exchange: string;
  assetType: string;
  name: string | null;
  listingStatus: string;
  listingEndDate: string | null;
  score?: number;
}

/**
 * Tiingo `assetType` → the canonical `instrumentType` the rest of the search
 * response speaks (the type filter, the dedup gate and the command palette's
 * grouping all read it).
 *
 * A venue-agnostic vocabulary is the point: an unrecognised assetType maps to
 * EQUITY rather than to itself, because an unknown `type` string silently
 * fails `dedupeResults`' `types.includes(...)` gate and the row vanishes from
 * a filtered search with no error.
 */
export const US_ASSET_TYPE_TO_INSTRUMENT_TYPE: Readonly<
  Record<string, string>
> = {
  Stock: "EQUITY",
  ETF: "ETF",
  "Mutual Fund": "MF",
};

/** Canonical instrument type for a Tiingo asset type. Unknown → EQUITY. */
export function usInstrumentType(assetType: string): string {
  return US_ASSET_TYPE_TO_INSTRUMENT_TYPE[assetType] ?? "EQUITY";
}

/**
 * How many `us_instruments` rows the US leg fetches per query — MONEY-980.
 *
 * A fixed budget rather than India's `limit * 2`, because the two populations
 * are not comparable: 49,414 of the 72,685 US listings are mutual funds and
 * 32,754 are delisted, so a wide fuzzy query can match thousands of near-
 * identical fund share classes. US rows rank BELOW every India match anyway, so
 * a bigger fetch only lengthens the tail that gets sliced off, while costing an
 * Atlas `$limit` (or, on the fallback, a `take`) proportional to the number.
 *
 * Lives here rather than in `route.ts` because a Next.js route module may only
 * export the handler surface — an extra `export const` there is a build error,
 * not a lint warning.
 */
export const US_RESULT_LIMIT = 12;

/**
 * Tiingo asset types a request's `types` filter is asking for.
 *
 * Returns `[]` for "everything", which both backends read as "no filter" —
 * NOT as "match nothing". Mirrors how `atlasTypes` is built for India.
 */
export function usAssetTypesForTypes(types: string[]): string[] {
  if (types.length === 0) return [];
  const out: string[] = [];
  if (types.includes("EQUITY")) out.push("Stock");
  if (types.includes("ETF")) out.push("ETF");
  if (types.includes("MF")) out.push("Mutual Fund");
  return out;
}

/**
 * Map a `us_instruments` hit → SearchResultItem.
 *
 * `yahooSymbol` is the BARE ticker: US Yahoo symbols carry no suffix (`AAPL`,
 * not `AAPL.NS`). Do not derive it from a suffix map — an absent key there
 * reads as India and would emit `AAPL.NS`.
 *
 * A null `name` becomes the empty string plus `hasName: false`, never the
 * symbol. Showing `LEH` twice would look like a company called LEH; the empty
 * name plus the DELISTED badge is honest about what we know, and `hasName`
 * carries the fact the ranking needs.
 */
export function mapUsInstrument(row: UsInstrumentResultRow): SearchResultItem {
  const type = usInstrumentType(row.assetType);
  // TRIMMED, and the trim is the rule rather than tidiness: a whitespace-only
  // name is "the paced leg has nothing yet", not a name. The DB-side
  // normaliser (`normalizeUsInstrumentRow`) already applies the same test, and
  // one rule stated in two places that disagree is its own defect class — so
  // this mapper re-applies it and does not assume its caller did.
  const name = (row.name ?? "").trim();
  return {
    symbol: row.symbol,
    name,
    exchange: row.exchange,
    type,
    yahooSymbol: row.symbol,
    instrumentId: undefined,
    sector: null,
    instrumentType: type,
    score: row.score,
    market: "US",
    listingId: row.listingId,
    listingStatus: row.listingStatus,
    listingEndDate: row.listingEndDate,
    assetType: row.assetType,
    hasName: name.length > 0,
  };
}

// ── Popular (no-query) mappers ──

export interface PopularStockRow {
  symbol: string;
  name: string;
  exchange: "NSE" | "BSE";
}

/**
 * Hardcoded popular-stocks fallback → result rows (used when the DB returns no
 * popular instruments). Slices to `limit` and derives the Yahoo suffix.
 */
export function mapPopularStocks(
  stocks: PopularStockRow[],
  limit: number
): SearchResultItem[] {
  return stocks.slice(0, limit).map((stock) => ({
    symbol: stock.symbol,
    name: stock.name,
    exchange: stock.exchange,
    type: "EQUITY",
    yahooSymbol: `${stock.symbol}${stock.exchange === "BSE" ? ".BO" : ".NS"}`,
  }));
}

/**
 * Map the (display) available-indices list → result rows, deriving the exchange
 * from whether the Yahoo symbol carries "BSE".
 */
export function mapPopularIndices(
  indices: Array<{ name: string; yahooSymbol: string }>
): SearchResultItem[] {
  return indices.map((idx) => ({
    symbol: idx.name,
    name: idx.name,
    exchange: idx.yahooSymbol.includes("BSE") ? "BSE" : ("NSE" as const),
    type: "INDEX",
    yahooSymbol: idx.yahooSymbol,
  }));
}

// ── Filters ──

/**
 * Keep only Indian (NSE/BSE) Yahoo Finance search hits. Yahoo's global search
 * returns US / LSE / etc. tickers; we surface India-listed results only here.
 * A hit qualifies via a `.NS`/`.BO` Yahoo suffix OR an NSE/BSE/NSI/BOM exchange.
 */
export function filterIndianYahooResults(
  rows: YahooSearchRow[]
): YahooSearchRow[] {
  return rows.filter((r) => {
    const sym = r.yahooSymbol || r.symbol;
    const exch = r.exchange?.toUpperCase() || "";
    return (
      sym.endsWith(".NS") ||
      sym.endsWith(".BO") ||
      exch === "NSE" ||
      exch === "BSE" ||
      exch === "NSI" ||
      exch === "BOM"
    );
  });
}

/** Split an upper-cased string into its non-empty whitespace-delimited words. */
function tokenize(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

/**
 * Is `upperQuery` a plausible reference to the index called `indexName`?
 *
 * MONEY-1205 — the predicate this replaces was
 * `name.includes(q) || q.includes(name.split(" ")[0])`. The second half was
 * written for the type-ahead case ("NIFTY" → "NIFTY 50") but it is a
 * containment test on the query, so it fired for ANY query that merely
 * CONTAINED the word NIFTY / BSE / SENSEX / INDIA anywhere. Searching
 * "SBI NIFTY 200 QUALITY 30 ETF" matched 17 indices — more than the whole
 * `limit=12` budget — and buried the ETF the user typed the exact name of at
 * rank 31 of 40. It is a hardcoded 29-entry map, so the injection is
 * unconditional and free of any relevance signal: nothing downstream could
 * out-rank it (INDEX is ranking criterion 2).
 *
 * A query is a plausible index reference only when:
 *   1. it is a full or PREFIX match of the index name — "NIFTY" → "NIFTY 50",
 *      "NIFTY BA" → "NIFTY BANK", "NIFTY 50" → itself; or
 *   2. its token set is a SUBSET of the index name's tokens — "BANK NIFTY" →
 *      "NIFTY BANK", "SENSEX" → "BSE SENSEX", "VIX" → "INDIA VIX".
 *
 * With the guard that a query carrying MORE words than the index name cannot
 * be that index: "SBI NIFTY 200 QUALITY 30 ETF" is 6 tokens and no index name
 * has more than 3, so every entry is rejected before the subset test runs.
 *
 * Case-normalises internally (callers pass an already-upper-cased query, but a
 * lower-cased one used to match NOTHING at all rather than fail loudly).
 */
export function isPlausibleIndexReference(
  indexName: string,
  upperQuery: string
): boolean {
  const query = upperQuery.trim().toUpperCase();
  if (query.length === 0) return false;

  const name = indexName.toUpperCase();

  // 1. Full or prefix match on the index name itself.
  if (name.startsWith(query)) return true;

  const nameTokens = tokenize(name);
  const queryTokens = tokenize(query);

  // GUARD: more words than the index has cannot be a reference to that index.
  if (queryTokens.length > nameTokens.length) return false;

  // 2. Query token set ⊆ index name token set.
  const nameTokenSet = new Set(nameTokens);
  return queryTokens.every((token) => nameTokenSet.has(token));
}

/**
 * Match the hardcoded index mappings against a query, using
 * {@link isPlausibleIndexReference}. Rows carry `type: "INDEX"` and derive the
 * exchange from whether the Yahoo symbol mentions "BSE".
 */
export function matchLocalIndices(upperQuery: string): SearchResultItem[] {
  return Object.entries(INDEX_MAPPINGS)
    .filter(([name]) => isPlausibleIndexReference(name, upperQuery))
    .map(([name, yahooSymbol]) => ({
      symbol: name,
      name,
      exchange: yahooSymbol.includes("BSE") ? "BSE" : ("NSE" as const),
      type: "INDEX",
      yahooSymbol,
    }));
}

/**
 * Is this a US row? The ONE definition — never inline `market === "US"`, and
 * never a truthiness test on `market` (`"IN"` is truthy).
 */
export function isUsResult(row: SearchResultItem): boolean {
  return row.market === "US";
}

/**
 * Is this a DELISTED US row? Case-normalised, because `listingStatus` reaches
 * here from three places (Atlas projection, Prisma row, cache round trip).
 *
 * Only a US row can be delisted: India rows are selected `isActive: true` on
 * every leg and carry no `listingStatus` at all, so a stray value on one must
 * not demote it.
 */
export function isDelistedUsResult(row: SearchResultItem): boolean {
  return (
    isUsResult(row) && (row.listingStatus ?? "").toUpperCase() === "DELISTED"
  );
}

/**
 * Drop US rows unless the `us-stocks-search` flag is on.
 *
 * ## This replaced a negative filter over a stale venue list (MONEY-980)
 *
 * `filterUsExchanges` tested `exchange` against a hand-typed set of SEVEN Yahoo
 * venue codes — NASDAQ, NYSE, AMEX, NMS, NGM, NYQ, ASE. Two things were wrong
 * with it by the time US listings became real:
 *
 *   1. It was DEAD. Every leg feeding the combine is India-only: the DB and
 *      Atlas legs read `instrument_mappings` (US moved out to
 *      `us_instruments`), the MF leg reads `mutual_fund_masters`, the index leg
 *      is a hardcoded India map, and the Yahoo leg is already narrowed by
 *      `filterIndianYahooResults`. Nothing could produce a row it removed.
 *   2. It was WRONG for the data it claimed to guard. Of the eight real US
 *      venues in `US_EXCHANGES` (packages/core market-data/instruments/types)
 *      it named three: `NYSE ARCA`, `NYSE MKT`, `NYSE NAT`, `BATS` and `NMFQS`
 *      were all missing — and `NMFQS` alone carries 49,414 of the 72,685 US
 *      listings. A US row on any of those five would have sailed straight
 *      through the "gate".
 *
 * So the gate is now keyed on a POSITIVE discriminator we set ourselves —
 * `market: "US"`, written by exactly one mapper — rather than on a deny-list of
 * venue strings that has to be kept in sync with an upstream we do not control.
 * The Yahoo leg keeps its own ALLOW-list (`filterIndianYahooResults`), which is
 * the same principle applied to rows we did not build.
 *
 * Kept (rather than deleted in favour of the fetch-site flag check) because it
 * is the backstop for the next US leg someone adds: a merge that forgets the
 * flag still cannot leak a US row past this.
 */
export function filterUsResults(
  rows: SearchResultItem[],
  showUsStocks: boolean
): SearchResultItem[] {
  return rows.filter((r) => showUsStocks || !isUsResult(r));
}

// ── NSE-before-BSE pre-sort (so dedup keeps the NSE listing) ──

/**
 * Stable-ish pre-sort that floats NSE rows ahead of non-NSE rows, leaving the
 * rest of the order intact. Runs BEFORE dedup so the NSE listing of a dual-
 * listed equity wins the base-symbol key.
 */
export function presortNseFirst(rows: SearchResultItem[]): SearchResultItem[] {
  const out = [...rows];
  out.sort((a, b) => {
    if (a.exchange === "NSE" && b.exchange !== "NSE") return -1;
    if (a.exchange !== "NSE" && b.exchange === "NSE") return 1;
    return 0;
  });
  return out;
}

/**
 * Deduplicate search rows. Equity/ETF rows collapse by base symbol (so the
 * NSE & BSE listings of one stock become one row — relies on a prior NSE-first
 * sort to keep NSE); every other row collapses by `yahooSymbol || symbol`.
 *
 * When `types` is non-empty the row must also match one of the requested types
 * (by `instrumentType ?? type`) to survive — mirroring the route's combined
 * dedup+type gate.
 */
export function dedupeResults(
  rows: SearchResultItem[],
  types: string[] = []
): SearchResultItem[] {
  const seen = new Set<string>();
  return rows.filter((result) => {
    const isEquity = result.type === "EQUITY" || result.type === "ETF";
    // MONEY-980 — a US row is keyed by its LISTING, never by its symbol.
    //
    // Both of the other keys are wrong for `us_instruments`, and both fail
    // silently by deleting rows:
    //   - by base symbol: Tiingo's master holds two `DOW` rows on NYSE (Dow
    //     Chemical 1972-2017 and Dow Inc. 2019-) and 2,196 repeated tickers in
    //     all. The `presortNseFirst` pass floats NSE first, so the survivor of
    //     a symbol collision is whichever row the sort happened to leave first
    //     — i.e. the delisted tail this collection exists to hold disappears.
    //   - by `yahooSymbol || symbol`: identical, because a US Yahoo symbol IS
    //     the bare ticker.
    // It also stops a US ADR colliding with its Indian listing: `INFY` is an
    // NSE symbol AND a NYSE ADR ticker, and symbol-keying would have dropped
    // one of them.
    const key = isUsResult(result)
      ? `us:${result.listingId ?? `${result.symbol}:${result.exchange}`}`
      : isEquity
        ? result.symbol.toUpperCase()
        : result.yahooSymbol || result.symbol;
    if (seen.has(key)) return false;
    seen.add(key);
    if (types.length > 0) {
      const resultType = result.instrumentType || result.type;
      return types.includes(resultType);
    }
    return true;
  });
}

// ── Relevance ranking ──

/**
 * Leading-quote-tolerant name, upper-cased, for prefix comparison.
 *
 * MONEY-1205 — 13,287 instrument names in prod begin with a literal `"`
 * character (an unstripped CSV quote from the exchange master), so the raw
 * `name.toUpperCase().startsWith(query)` in criterion 5 can NEVER be true for
 * any of them: `"SBI NIFTY 200 QUALITY 30 ETF"` does not start with
 * `SBI NIFTY 200 QUALITY 30 ETF`. The data fix lives elsewhere (the instrument
 * parser); this is belt-and-braces so the comparator is right either way, and
 * it is deliberately NOT applied to the alphabetical tiebreak or to any display
 * field — only to the prefix TEST.
 */
function comparableName(name: string): string {
  return name.replace(/^[\s"'`]+/, "").toUpperCase();
}

/**
 * Which ranking BAND a row belongs to: 0 = India, 1 = US active, 2 = US
 * delisted. The first and coarsest criterion — MONEY-980.
 *
 * An unknown/blank `listingStatus` on a US row scores 2, not 1. `listingStatus`
 * is a required column so this should be unreachable; if it ever is reached,
 * "not positively known to be live" belongs with the delisted tail rather than
 * ahead of it, because the alternative promotes an unclassifiable row above
 * every real active listing.
 */
export function marketRank(row: SearchResultItem): 0 | 1 | 2 {
  if (!isUsResult(row)) return 0;
  return (row.listingStatus ?? "").toUpperCase() === "ACTIVE" ? 1 : 2;
}

/**
 * Does this row have a company name to show?
 *
 * `hasName` when the mapper set it (US rows always do), otherwise a non-empty
 * `name`. Written this way so India rows — which never carry the flag — keep
 * their existing behaviour exactly: their names are non-empty, so every India
 * row answers true and the criterion is a no-op between two of them.
 */
export function hasDisplayName(row: SearchResultItem): boolean {
  return row.hasName ?? row.name.trim().length > 0;
}

/** Atlas relevance as a finite number; anything else (absent / NaN) is 0. */
function atlasScore(row: SearchResultItem): number {
  const { score } = row;
  return typeof score === "number" && Number.isFinite(score) ? score : 0;
}

/**
 * Comparator for the final search ranking, in priority order:
 *   0. market band: India, then US active, then US delisted
 *   1. exact symbol match
 *   2. INDEX type
 *   3. symbol prefix match
 *   4. NSE before BSE
 *   5. name prefix match (leading quotes ignored — see {@link comparableName})
 *   6. rows with a company name before rows still awaiting one
 *   7. DB rows (have an instrumentId) before Yahoo rows — only when NOT on Atlas
 *   8. Atlas relevance, high → low — on Atlas, or between two US rows
 *   9. alphabetical by name
 *
 * `upperQuery` MUST already be upper-cased. `useAtlas` toggles criteria 6 & 7:
 * Atlas returns relevance-ordered rows, so the DB-vs-Yahoo tiebreak is skipped
 * to avoid fighting Atlas's scoring, and Atlas's own score decides instead.
 *
 * MONEY-1205 — criterion 7 is new. `score` was projected by both `$search`
 * pipelines, dropped by the mappers and never read, so once criteria 1-6 tied
 * the ranking fell straight through to `localeCompare`: with the local indices
 * removed, the ETF whose name the user typed EXACTLY ranked 15th of 16 —
 * behind ADITYA BIRLA / DSP / HDFC / ICICI — while Atlas had it first at 30.7
 * against 23.4. Alphabetical stays the FINAL tie so ordering is still total and
 * deterministic (equal or absent scores → same output as before).
 */
export function compareSearchResults(
  a: SearchResultItem,
  b: SearchResultItem,
  upperQuery: string,
  useAtlas: boolean
): number {
  // 0. MARKET BAND — India first, then US active, then US delisted (MONEY-980).
  //
  // Coarsest and therefore FIRST: US securities are a secondary section of an
  // India-first product, so an Indian match outranks a US one even when the US
  // row scores higher — the two scores come from different Atlas indexes and
  // are not commensurable anyway.
  //
  // It sits ABOVE the exact-symbol criterion on purpose. `INFY` is both an NSE
  // symbol and a NYSE ADR ticker, and both are exact matches; the Indian
  // listing is the one an Indian user means. The cost is real and is accepted:
  // when India already fills the page, US rows are sliced off entirely.
  //
  // The response carries NO signal for that, and this comment used to claim it
  // did — "`count` is the PRE-slice total, so a caller can compare it against
  // the rows it received". `count` is `uniqueResults.length`, the pre-slice
  // total across BOTH markets, so `count > results.length` means only "more
  // rows matched than fit". `q=GOLD&limit=10` overflows on Indian rows alone
  // and returns exactly the same `count > results.length` whether Barrick Gold
  // matched or not. The claim is removed rather than replaced: no shipped
  // surface opts into US rows yet (see `parseIncludeUs`), so a "US matched"
  // field would be a signal with no reader.
  const aBand = marketRank(a);
  const bBand = marketRank(b);
  if (aBand !== bBand) return aBand - bBand;

  // 1. Exact symbol match first
  const aExact = a.symbol.toUpperCase() === upperQuery;
  const bExact = b.symbol.toUpperCase() === upperQuery;
  if (aExact && !bExact) return -1;
  if (!aExact && bExact) return 1;

  // 2. Index type first
  const aIsIndex = a.type === "INDEX";
  const bIsIndex = b.type === "INDEX";
  if (aIsIndex && !bIsIndex) return -1;
  if (!aIsIndex && bIsIndex) return 1;

  // 3. Symbol prefix match before name-only match
  const aSymPrefix = a.symbol.toUpperCase().startsWith(upperQuery);
  const bSymPrefix = b.symbol.toUpperCase().startsWith(upperQuery);
  if (aSymPrefix && !bSymPrefix) return -1;
  if (!aSymPrefix && bSymPrefix) return 1;

  // 4. NSE before BSE
  const aIsNSE = a.exchange === "NSE";
  const bIsNSE = b.exchange === "NSE";
  if (aIsNSE && !bIsNSE) return -1;
  if (!aIsNSE && bIsNSE) return 1;

  // 5. Name prefix match
  const aNamePrefix = comparableName(a.name).startsWith(upperQuery);
  const bNamePrefix = comparableName(b.name).startsWith(upperQuery);
  if (aNamePrefix && !bNamePrefix) return -1;
  if (!aNamePrefix && bNamePrefix) return 1;

  // 6. A row with a company name outranks one still waiting for it.
  //
  // `UsInstrument.name` is NULL until a separate paced Tiingo leg reaches the
  // row — roughly nine nights for the full 74k — so this is the steady state
  // for a large slice of the collection, not an edge case. A result reading
  // `LEH` with no name is unfindable by anyone who does not already know the
  // answer, so it ranks last among its peers.
  //
  // Positioned HERE, below the symbol criteria, deliberately: someone typing
  // `LEH` exactly must still get `LEH` first even while it is nameless (that is
  // the whole delisted-lookup use case). It only breaks ties between rows the
  // query matched fuzzily. India rows all have names, so this is inert for
  // India-vs-India comparisons.
  const aNamed = hasDisplayName(a);
  const bNamed = hasDisplayName(b);
  if (aNamed !== bNamed) return aNamed ? -1 : 1;

  // 7. DB results before Yahoo (when not using Atlas)
  if (!useAtlas) {
    const aHasId = !!a.instrumentId;
    const bHasId = !!b.instrumentId;
    if (aHasId && !bHasId) return -1;
    if (!aHasId && bHasId) return 1;
  }

  // 8. Atlas relevance, high → low (only on the Atlas path). A row with no
  //    score (a local index, a Yahoo row) sorts as 0 rather than NaN, so it
  //    loses to any scored row instead of poisoning the comparison — an
  //    undefined/NaN-vs-number comparison is false BOTH ways, which would make
  //    the sort non-transitive and the output order engine-dependent.
  //
  //    Caveat kept deliberately: instrument scores come from `instrument_search`
  //    and MF scores from `mf_search`, so the two scales are not commensurable.
  //    Type-scoping the comparison would break transitivity (and with it the
  //    total order `Array.sort` requires), and criterion 4 already floats every
  //    NSE instrument above every MF (an MF's `exchange` holds the AMC name),
  //    so the only rows that meet across scales are non-NSE ones.
  //
  //    MONEY-980 — `useAtlas` describes the INDIA legs, so it says nothing
  //    about whether the US leg reached `us_instrument_search`. The gate latches
  //    per index, so `instrument_search` can be latched while the US index is
  //    healthy. `bothUs` restores the score tiebreak for that case without
  //    touching either pre-existing path: when `useAtlas` is false and both rows
  //    are Indian, nothing changes (and QA's regex path stays pinned by test).
  //    Still a total order — a US-vs-US comparison only happens inside one
  //    market band, and `atlasScore` maps a missing score to 0 rather than NaN.
  const bothUs = isUsResult(a) && isUsResult(b);
  if (useAtlas || bothUs) {
    const aScore = atlasScore(a);
    const bScore = atlasScore(b);
    if (aScore !== bScore) return bScore - aScore;
  }

  // 9. Alphabetical name
  return a.name.localeCompare(b.name);
}

/**
 * Rank a copy of `rows` by {@link compareSearchResults}. Does NOT mutate the
 * input. `upperQuery` MUST already be upper-cased.
 */
export function rankSearchResults(
  rows: SearchResultItem[],
  upperQuery: string,
  useAtlas: boolean
): SearchResultItem[] {
  const out = [...rows];
  out.sort((a, b) => compareSearchResults(a, b, upperQuery, useAtlas));
  return out;
}

/**
 * How many INDEX rows may occupy the head of a ranked result page.
 *
 * Three is enough for every real index query in the hardcoded map — "NIFTY"
 * wants NIFTY / NIFTY 50 / NIFTY BANK, not all 20 — and small enough that a
 * `limit=12` page (the command palette's) always has room for stocks and funds.
 */
export const MAX_INDEX_ROWS = 3;

/**
 * Keep at most {@link MAX_INDEX_ROWS} INDEX rows at the head of a ranked list,
 * DEMOTING the rest to the tail rather than dropping them.
 *
 * MONEY-1205 — ranking criterion 2 hoists INDEX above everything
 * unconditionally and there was no per-group cap before the global
 * `slice(0, limit)`, so any query that matched several indices consumed the
 * entire page: `q="nifty"` returned 12 index rows and ZERO stocks (NIFTYBEES
 * and every NIFTY ETF were invisible), and `q="SBI NIFTY 200 QUALITY 30 ETF"`
 * returned 12 index rows and zero of the 24 instruments + 8 funds that matched.
 * Tightening `matchLocalIndices` fixes today's query; this is what stops the
 * next one, because ONE correct index match plus a limit of 3 is still a
 * monopoly at `limit=3`.
 *
 * Demote, don't drop:
 *   - nothing is lost — a query that matches only indices still fills its page
 *     with the leftovers, so "NIFTY BANK" is not answered with 3 rows;
 *   - `count` (the pre-slice total) stays honest, because length is preserved;
 *   - the command palette re-groups client-side into Stocks / Mutual Funds /
 *     Indices, so the demoted rows land back in the Indices group and the
 *     grouping the user sees is untouched.
 *
 * ## The demotion stops at the market band (MONEY-980 review)
 *
 * The surplus goes to the end of the INDIA band, not to the end of the list.
 * `others` holds US rows too, and appending the surplus after all of them put
 * an Indian index BELOW a US listing — inverting ranking criterion 0, the
 * coarsest and most deliberate criterion in {@link compareSearchResults}, from
 * a function whose entire job is a within-page reshuffle. Every INDEX row is
 * Indian by construction (`matchLocalIndices` reads a hardcoded India map, and
 * {@link usInstrumentType} can only produce EQUITY / ETF / MF), so the surplus
 * always belongs above the US section.
 *
 * Runs AFTER {@link rankSearchResults} so the three that survive are the three
 * best-ranked, and BEFORE the route's slice so the demotion actually frees
 * budget. Does NOT mutate the input.
 */
export function capIndexRows(
  rows: SearchResultItem[],
  maxIndexRows: number = MAX_INDEX_ROWS
): SearchResultItem[] {
  const indices: SearchResultItem[] = [];
  const indiaOthers: SearchResultItem[] = [];
  const usOthers: SearchResultItem[] = [];
  for (const row of rows) {
    if (row.type === "INDEX") indices.push(row);
    else if (isUsResult(row)) usOthers.push(row);
    else indiaOthers.push(row);
  }
  const otherCount = indiaOthers.length + usOthers.length;
  // Nothing to demote (and, when there is nothing else to make room FOR, the
  // reordering would be pure churn).
  if (indices.length <= maxIndexRows || otherCount === 0) return [...rows];

  const kept = Math.max(0, maxIndexRows);
  return [
    ...indices.slice(0, kept),
    ...indiaOthers,
    ...indices.slice(kept),
    ...usOthers,
  ];
}

/**
 * Report the `source` label for a query search, matching the route's logic:
 * Atlas if either instrument or MF search used Atlas; else "db+yahoo" when the
 * DB returned instruments; else "yahoo".
 */
export function resolveSearchSource(
  useAtlas: boolean,
  dbInstrumentCount: number
): "atlas" | "db+yahoo" | "yahoo" {
  if (useAtlas) return "atlas";
  return dbInstrumentCount > 0 ? "db+yahoo" : "yahoo";
}
