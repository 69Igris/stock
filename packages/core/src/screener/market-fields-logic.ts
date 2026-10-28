/**
 * Market-structure screener fields — MONEY-1204 (P14 / 14e.1).
 *
 * PURE. No Prisma, no network, no clock. Everything here turns rows a caller
 * already fetched into (a) the field REGISTRY the filter UI and the AI
 * filter-builder both read, and (b) the per-symbol VALUES a filter is matched
 * against. `market-fields.ts` is the thin Prisma reader that feeds it.
 *
 * These nineteen fields are the first screener fields that do NOT come from
 * `StockRatios` (fundamental) or from `DailyPrice` candles run through
 * `computeIndicators` (technical). They come from eight different tables, each
 * with its own absence rule, and every one of those rules is a place where the
 * obvious implementation is quietly, confidently wrong:
 *
 * 1. **Delivery nulls are not zeroes.** NSE prints `-` for delivery on
 *    trade-for-trade series, where delivery is 100% by construction. A mean
 *    that folds those in as 0 UNDERSTATES delivery on exactly the illiquid,
 *    surveilled names a delivery screen exists to find. The 20-day mean skips
 *    nulls and carries the contributing-day count, so `n/20` is readable rather
 *    than implied. This module does not re-implement that arithmetic — it
 *    delegates to `computeDeliveryTrend`, which already owns it.
 *
 *    The same rule decides the HEADLINE: `deliveryPct` is the last REPORTED
 *    figure, dated by `deliveryAsOf`, never "the newest row's value". Two
 *    producers write `DailyPrice` and only one of them carries delivery, so
 *    headlining the newest row would null the column for the entire universe
 *    every weekday until the 21:00 IST bhavcopy lands. Bounded by the reader's
 *    60-day window, not by a rule here — see `buildMarketFieldValues`.
 *
 * 2. **"Current" flag state is a reduce, not an existence check.** `StockFlag`
 *    has NO `@@unique` by design: a 40-day F&O ban is 40 rows and the run
 *    length IS the datum. `some(row => row.kind === "FO_BAN")` therefore reports
 *    a ban that ended in January as current in August. "Current" is the NEWEST
 *    row per kind, judged against a market-wide reference day.
 *
 * 3. **A missing reference day is not "not flagged".** If no flag rows exist at
 *    all — the feed has not landed for this environment — the honest answer is
 *    `null` ("cannot determine"), not `false`. A cached `false` here is a
 *    fail-open default on a surveillance surface.
 *
 * 4. **`-` in an NSE ownership table means NOT REPORTED.** `Number("")` is 0,
 *    and that coercion is precisely how an undisclosed promoter pledge becomes
 *    a fabricated all-clear. A QoQ delta needs BOTH quarters non-null; one null
 *    side yields null, never the other side's value.
 *
 * 5. **`DerivativeSummary` carries Prisma `BigInt`s.** `JSON.stringify` THROWS
 *    on a BigInt, and screener results cross a server-action boundary AND an
 *    `apps/api` JSON response. Every value produced here is a plain
 *    number/string/boolean/null — the coercion happens once, here, not at each
 *    of the several serialisation boundaries downstream.
 *
 * 6. **`MwplDaily.utilisationPct` is NULL on every row and will stay null.**
 *    The denominator (the market-wide position limit) has no feed — its
 *    registry path has zero archived objects — and the obvious substitute
 *    `oi_cli_limit` is a per-CLIENT limit, a different quantity. The field is
 *    WIRED anyway, because a wired-and-empty field is discoverable and a
 *    missing one is not; `alwaysNull: true` marks it so the empty-state can say
 *    "we do not ingest this yet" instead of "no such stocks exist". A filter on
 *    it matches NOTHING — by construction (rule 7), never by accident, and
 *    never by substituting a denominator.
 *
 * 7. **Unknown never matches.** `matchesMarketFilters` rejects a candidate
 *    whose value for a filtered field is null or non-finite, exactly as
 *    `matchesTechnicalFilters` rejects a NaN indicator. This is what makes
 *    rules 3 and 6 safe: "we cannot tell" excludes, it does not include. It is
 *    also what makes the bond fields safe while `bond_eod` / `bond_master` are
 *    still nearly empty (the history walk is founder-gated) — a bond screen
 *    degrades to zero matches, never to an error.
 *
 * Absence discipline throughout: `""` / `"-"` / blank / unparseable ⇒ `null`,
 * never `0`.
 */

import {
  buildIndexChips,
  buildStockFlagBadges,
  computeDeliveryTrend,
  isoOrNull,
  type DeliveryDayRow,
  type IndexMembershipRow,
  type StockFlagBadge,
  type StockFlagStateRow,
} from "../market-data/stock-section-logic";

// ─── Registry ────────────────────────────────────────────────────────

/** The Prisma model a field's value is read from. Provenance, for citation. */
export type MarketFieldSource =
  | "DailyPrice"
  | "StockFlag"
  | "ShareholdingPattern"
  | "IndexMembership"
  | "DerivativeSummary"
  | "MwplDaily"
  | "BondEOD"
  | "BondMaster";

/**
 * Which slice of the instrument universe a field is meaningful for. A screen
 * whose only market filters are DEBT fields must not be seeded with equities,
 * and vice versa — see `marketFieldUniverse`.
 */
export type MarketFieldUniverse = "EQUITY" | "FNO" | "DEBT";

export interface MarketFieldDef {
  /** Filter id. Also the key in `MarketFieldValues`. */
  id: string;
  /** Human label for the filter UI. */
  label: string;
  source: MarketFieldSource;
  /** `boolean` fields are matched as 1/0 so one comparator serves both. */
  kind: "number" | "boolean";
  unit: "percent" | "percentPoints" | "ratio" | "contracts" | "inr" | "none";
  universe: MarketFieldUniverse;
  /**
   * The filter needs `ScreenerFilter.operand` to mean anything (currently only
   * `indexMember`, whose operand is an index slug such as `nifty50`). Omitted
   * operand widens the predicate to "a member of ANY index" rather than
   * silently matching nothing.
   */
  acceptsOperand?: boolean;
  /**
   * NO row in this column carries a value today, and none will until a source
   * exists. Not a measurement of current coverage — a statement about the feed.
   * See rule 6 in the module header.
   */
  alwaysNull?: boolean;
  /** Why the field can be empty, surfaced verbatim in the empty-state. */
  note: string;
}

/**
 * THE registry. The filter UI, the AI filter-builder vocabulary and the engine
 * all read this one list, so a field cannot exist in the vocabulary and be
 * unknown to the engine (the failure mode `normalizeField` was added for).
 */
export const MARKET_FIELDS: readonly MarketFieldDef[] = [
  {
    id: "deliveryPct",
    label: "Delivery %",
    source: "DailyPrice",
    kind: "number",
    unit: "percent",
    universe: "EQUITY",
    note: "Latest session's delivery percentage. NULL on trade-for-trade series, where NSE prints `-` because delivery is 100% by construction.",
  },
  {
    id: "deliveryPct20dAvg",
    label: "Delivery % (20d avg)",
    source: "DailyPrice",
    kind: "number",
    unit: "percent",
    universe: "EQUITY",
    note: "Mean over the last 20 sessions, SKIPPING sessions NSE did not report. `deliveryPct20dDays` is the honest denominator.",
  },
  {
    id: "asmFlag",
    label: "Under ASM",
    source: "StockFlag",
    kind: "boolean",
    unit: "none",
    universe: "EQUITY",
    note: "Additional Surveillance Measure, from the NEWEST surveillance row. Null when no surveillance rows have been ingested at all.",
  },
  {
    id: "gsmFlag",
    label: "Under GSM",
    source: "StockFlag",
    kind: "boolean",
    unit: "none",
    universe: "EQUITY",
    note: "Graded Surveillance Measure, from the NEWEST surveillance row. Null when no surveillance rows have been ingested at all.",
  },
  {
    id: "priceBandFlag",
    label: "Price band applied",
    source: "StockFlag",
    kind: "boolean",
    unit: "none",
    universe: "EQUITY",
    note: "A numeric circuit band is published for the stock. NSE prints `No Band` for F&O names, which reads as false, not as a missing band.",
  },
  {
    id: "foBanFlag",
    label: "In F&O ban",
    source: "StockFlag",
    kind: "boolean",
    unit: "none",
    universe: "FNO",
    note: "On the ban list for the newest ingested ban day. A ban row older than that day is a PAST ban, not a current one.",
  },
  {
    id: "pledgedPct",
    label: "Promoter pledge %",
    source: "ShareholdingPattern",
    kind: "number",
    unit: "percent",
    universe: "EQUITY",
    note: "Latest filed quarter. `-` in the NSE table means NOT REPORTED and stays null — a 0 here means a filer reported zero.",
  },
  {
    id: "pledgedPctQoqDelta",
    label: "Promoter pledge % QoQ change",
    source: "ShareholdingPattern",
    kind: "number",
    unit: "percentPoints",
    universe: "EQUITY",
    note: "Latest quarter minus the one before. Null unless BOTH quarters reported — a missing side is not zero.",
  },
  {
    id: "fiiPct",
    label: "FII holding %",
    source: "ShareholdingPattern",
    kind: "number",
    unit: "percent",
    universe: "EQUITY",
    note: "Latest filed quarter; null when not reported.",
  },
  {
    id: "fiiPctQoqDelta",
    label: "FII holding % QoQ change",
    source: "ShareholdingPattern",
    kind: "number",
    unit: "percentPoints",
    universe: "EQUITY",
    note: "Latest quarter minus the one before. Null unless BOTH quarters reported.",
  },
  {
    id: "diiPct",
    label: "DII holding %",
    source: "ShareholdingPattern",
    kind: "number",
    unit: "percent",
    universe: "EQUITY",
    note: "Latest filed quarter; null when not reported.",
  },
  {
    id: "diiPctQoqDelta",
    label: "DII holding % QoQ change",
    source: "ShareholdingPattern",
    kind: "number",
    unit: "percentPoints",
    universe: "EQUITY",
    note: "Latest quarter minus the one before. Null unless BOTH quarters reported.",
  },
  {
    id: "indexMember",
    label: "Index membership",
    source: "IndexMembership",
    kind: "boolean",
    unit: "none",
    universe: "EQUITY",
    acceptsOperand: true,
    note: "Current membership from the OPEN stint (`removedOn: null`). Read symbol-first from IndexMembership, which is the only one of the two membership tables with a `symbol` index.",
  },
  {
    id: "pcrOi",
    label: "Put/call ratio (OI)",
    source: "DerivativeSummary",
    kind: "number",
    unit: "ratio",
    universe: "FNO",
    note: "F&O underlyings only. Null when the call side is zero — a PCR with no denominator is not infinity, it is unknown.",
  },
  {
    id: "futOiChange",
    label: "Futures OI change",
    source: "DerivativeSummary",
    kind: "number",
    unit: "contracts",
    universe: "FNO",
    note: "Versus the previous TRADING day, all expiries. Stored as a Prisma BigInt and coerced here, once, so nothing downstream can throw on JSON.stringify.",
  },
  {
    id: "mwplUtilisation",
    label: "MWPL utilisation %",
    source: "MwplDaily",
    kind: "number",
    unit: "percent",
    alwaysNull: true,
    universe: "FNO",
    note: "NOT INGESTED. The market-wide position limit has no published feed, and `oi_cli_limit` is a per-CLIENT limit — a different quantity, deliberately not substituted. A filter on this matches nothing until a source exists.",
  },
  {
    id: "bondYield",
    label: "Bond yield (YTM %)",
    source: "BondEOD",
    kind: "number",
    unit: "percent",
    universe: "DEBT",
    note: "Last traded YTM from the CBM/WDM end-of-day file, joined by ISIN. Nearly empty today — the history walk is founder-gated — so a bond screen degrades to zero matches.",
  },
  {
    id: "bondPrice",
    label: "Bond last price",
    source: "BondEOD",
    kind: "number",
    unit: "inr",
    universe: "DEBT",
    note: "Last traded price from the same row as `bondYield`, so price and yield always describe one segment on one day.",
  },
  {
    id: "bondCoupon",
    label: "Bond coupon %",
    source: "BondMaster",
    kind: "number",
    unit: "percent",
    universe: "DEBT",
    note: "Annual coupon in percent. Null and never 0: a zero-coupon bond and a coupon we failed to read are different facts.",
  },
] as const;

/** Field id → definition. */
export const MARKET_FIELD_BY_ID: ReadonlyMap<string, MarketFieldDef> = new Map(
  MARKET_FIELDS.map((f) => [f.id, f]),
);

/** Every market-structure field id, for the engine's filter classification. */
export const MARKET_STRUCTURE_FIELDS: ReadonlySet<string> = new Set(
  MARKET_FIELDS.map((f) => f.id),
);

export function isMarketStructure(field: string): boolean {
  return MARKET_STRUCTURE_FIELDS.has(field);
}

/** The tables a set of fields needs read. Only these are queried. */
export function marketFieldSources(
  fields: readonly string[],
): Set<MarketFieldSource> {
  const out = new Set<MarketFieldSource>();
  for (const f of fields) {
    const def = MARKET_FIELD_BY_ID.get(f);
    if (def) out.add(def.source);
  }
  // Bond price/yield are only interpretable next to the instrument's coupon and
  // maturity, and the reader needs BondMaster's ISIN set either way.
  if (out.has("BondEOD")) out.add("BondMaster");
  return out;
}

/**
 * The universe a screen made only of these fields should be seeded from.
 *
 * DEBT wins when present: a bond-yield screen seeded with equities returns
 * nothing and looks like "no bonds match" rather than "we screened the wrong
 * universe". FNO and EQUITY both live in `instrumentType: "EQUITY"`, so they
 * collapse.
 */
export function marketFieldUniverse(
  fields: readonly string[],
): MarketFieldUniverse {
  let sawDebt = false;
  let sawOther = false;
  for (const f of fields) {
    const def = MARKET_FIELD_BY_ID.get(f);
    if (!def) continue;
    if (def.universe === "DEBT") sawDebt = true;
    else sawOther = true;
  }
  if (sawDebt && !sawOther) return "DEBT";
  return "EQUITY";
}

/**
 * Of `fields`, those whose column is empty platform-wide BY DESIGN.
 *
 * The sibling `findUnavailableFields` MEASURES coverage against StockRatios;
 * this one does not measure anything, because there is nothing to measure —
 * `MwplDaily.utilisationPct` is null on every row and stays null until a feed
 * for the denominator exists. Both feed the same empty-state, so a screen that
 * returns nothing can say WHICH kind of nothing it is.
 */
export function alwaysNullMarketFields(fields: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of new Set(fields)) {
    if (MARKET_FIELD_BY_ID.get(f)?.alwaysNull === true) out.push(f);
  }
  return out;
}

// ─── Values ──────────────────────────────────────────────────────────

/**
 * Everything the eight readers resolved for ONE instrument.
 *
 * Every member is a plain JSON scalar or an array of them — no `bigint`, no
 * `Date`. See rule 5 in the module header: these values cross a Next server
 * action AND an `apps/api` JSON response, and `JSON.stringify` throws on a
 * BigInt rather than degrading.
 *
 * `null` means "we could not determine it", uniformly. It is never a stand-in
 * for zero, and `matchesMarketFilters` excludes on it.
 */
export interface MarketFieldValues {
  // DailyPrice
  deliveryPct: number | null;
  deliveryPct20dAvg: number | null;
  /** Sessions in the 20-day window that actually reported — the `n` in n/20. */
  deliveryPct20dDays: number;
  /** Sessions in the window: min(20, rows held) — the `20` in n/20. */
  deliveryPct20dWindow: number;
  deliveryAsOf: string | null;

  // StockFlag
  asmFlag: boolean | null;
  gsmFlag: boolean | null;
  priceBandFlag: boolean | null;
  foBanFlag: boolean | null;
  /** Surveillance codes on the newest surveillance day, stored VERBATIM. */
  surveillanceCodes: string[];
  /**
   * Codes present that `decodeSurveillanceCode` did not recognise. Kept
   * separate rather than dropped: a new NSE framework must be visible as an
   * unknown, not absorbed into "not under ASM".
   */
  surveillanceUndecoded: string[];
  /** The published band string, verbatim (`"20"`, `"No Band"`). */
  priceBand: string | null;
  flagsAsOf: string | null;

  // ShareholdingPattern
  pledgedPct: number | null;
  pledgedPctQoqDelta: number | null;
  fiiPct: number | null;
  fiiPctQoqDelta: number | null;
  diiPct: number | null;
  diiPctQoqDelta: number | null;
  shareholdingQuarter: string | null;
  shareholdingPrevQuarter: string | null;

  // IndexMembership — null when the table was not read (unknown), `[]` when it
  // was read and the symbol is in no index (known, and a real answer).
  indexIds: string[] | null;

  // DerivativeSummary
  pcrOi: number | null;
  futOiChange: number | null;
  derivativesAsOf: string | null;

  // MwplDaily
  mwplUtilisation: number | null;
  mwplAsOf: string | null;

  // BondEOD + BondMaster
  bondYield: number | null;
  bondPrice: number | null;
  bondCoupon: number | null;
  /** CBM | WDM — which segment's file the price/yield came from. */
  bondSegment: string | null;
  bondMaturity: string | null;
  bondAsOf: string | null;
}

/** All-unknown values. The starting point for every instrument. */
export function emptyMarketFieldValues(): MarketFieldValues {
  return {
    deliveryPct: null,
    deliveryPct20dAvg: null,
    deliveryPct20dDays: 0,
    deliveryPct20dWindow: 0,
    deliveryAsOf: null,
    asmFlag: null,
    gsmFlag: null,
    priceBandFlag: null,
    foBanFlag: null,
    surveillanceCodes: [],
    surveillanceUndecoded: [],
    priceBand: null,
    flagsAsOf: null,
    pledgedPct: null,
    pledgedPctQoqDelta: null,
    fiiPct: null,
    fiiPctQoqDelta: null,
    diiPct: null,
    diiPctQoqDelta: null,
    shareholdingQuarter: null,
    shareholdingPrevQuarter: null,
    indexIds: null,
    pcrOi: null,
    futOiChange: null,
    derivativesAsOf: null,
    mwplUtilisation: null,
    mwplAsOf: null,
    bondYield: null,
    bondPrice: null,
    bondCoupon: null,
    bondSegment: null,
    bondMaturity: null,
    bondAsOf: null,
  };
}

// ─── Primitives ──────────────────────────────────────────────────────

/**
 * Finite number, or null. Accepts `bigint` — `DerivativeSummary`'s OI columns
 * are Prisma `BigInt`s and `Number.isFinite(1n)` is `false`, so a plain
 * finite-check would silently null every one of them.
 *
 * A BigInt past `Number.MAX_SAFE_INTEGER` is still converted (the alternative
 * — dropping it — turns "very large open interest" into "no open interest",
 * which is the worse lie), but it is the reason this is one function rather
 * than an inline cast repeated at each call site.
 */
export function marketNumber(v: unknown): number | null {
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return null;
}

/**
 * `latest − previous`, or null when EITHER side is unreported.
 *
 * The null rule is the whole function. `-` in an NSE ownership table means NOT
 * REPORTED, so `latest − 0` would publish a pledge REDUCTION of exactly the
 * current pledge — a fabricated all-clear with a number attached, which is
 * strictly worse than showing nothing.
 */
export function qoqDelta(
  latest: number | null,
  previous: number | null,
): number | null {
  if (latest === null || previous === null) return null;
  const d = latest - previous;
  return Number.isFinite(d) ? Math.round(d * 10_000) / 10_000 : null;
}

/** Index slugs are lower-case (`nifty50`); compare them case-insensitively. */
function normalizeIndexId(id: string): string {
  return String(id ?? "")
    .trim()
    .toLowerCase();
}

// ─── Resolution ──────────────────────────────────────────────────────

/** The rows one instrument's fields are built from. All optional: a source not
 *  requested by any filter is simply not read, and stays `null` (unknown). */
export interface MarketFieldRowSet {
  /** `DailyPrice` rows, any order. */
  delivery?: ReadonlyArray<DeliveryDayRow>;
  /** `StockFlag` rows for this symbol, any order. */
  flags?: ReadonlyArray<StockFlagStateRow>;
  /**
   * Per KIND, the newest day that kind was published MARKET-WIDE (ISO day).
   *
   * Two things make this shape, and both are load-bearing.
   *
   * **Market-wide, not this symbol's own newest row.** The F&O ban list is a
   * DAILY publication, so "is this stock banned" means "is it on the newest
   * published list". A stock's own newest FO_BAN row is trivially its own
   * newest row, so judging against it reports a ban that ended in January as
   * current in August.
   *
   * **Per kind, not one date for all kinds.** The four families arrive in
   * different files on different schedules. With a single global maximum, a
   * surveillance file running one day behind the ban file would make EVERY
   * surveillance badge non-current, and `asmFlag` would read `false` for stocks
   * that are very much under ASM — a fail-open on the one surface whose job is
   * warning retail investors. A kind with no entry here is left UNKNOWN
   * (`null`), never assumed clear.
   */
  flagsReferenceDayByKind?: Readonly<Record<string, string | null>>;
  /** `ShareholdingPattern` rows, any order; newest two quarters are used. */
  shareholding?: ReadonlyArray<ShareholdingQuarterRow>;
  /** OPEN `IndexMembership` stints (`removedOn: null`). */
  memberships?: ReadonlyArray<IndexMembershipRow>;
  /** Newest `DerivativeSummary` row. */
  derivatives?: DerivativeSummaryFieldRow | null;
  /** Newest `MwplDaily` row. */
  mwpl?: MwplFieldRow | null;
  /** Newest `BondEOD` row for the instrument's ISIN. */
  bondEod?: BondEodFieldRow | null;
  /** `BondMaster` row for the same ISIN. */
  bondMaster?: BondMasterFieldRow | null;
}

export interface ShareholdingQuarterRow {
  /** Canonical `YYYY-MM` of the quarter end (or the verbatim label). */
  quarter: string;
  pledgedPct?: number | null;
  fiiPct?: number | null;
  diiPct?: number | null;
}

export interface DerivativeSummaryFieldRow {
  date?: Date | string | null;
  pcrOi?: number | null;
  /** Prisma `BigInt`. */
  futOiChange?: bigint | number | null;
}

export interface MwplFieldRow {
  date?: Date | string | null;
  utilisationPct?: number | null;
}

export interface BondEodFieldRow {
  date?: Date | string | null;
  segment?: string | null;
  lastPrice?: number | null;
  lastYtm?: number | null;
  wtdYtm?: number | null;
  wapPrice?: number | null;
}

export interface BondMasterFieldRow {
  coupon?: number | null;
  maturityDate?: Date | string | null;
}

/**
 * Rows → values, for ONE instrument. Never throws; a shape it does not
 * recognise resolves to null rather than to a guess.
 */
export function buildMarketFieldValues(
  rows: MarketFieldRowSet,
): MarketFieldValues {
  const out = emptyMarketFieldValues();

  if (rows.delivery) {
    const trend = computeDeliveryTrend(rows.delivery);
    // `deliveryPct` is the LAST REPORTED figure, dated by `deliveryAsOf` — not
    // "the newest row's value". `computeDeliveryTrend.latest` is the newest
    // session that actually CARRIES delivery, and the screener adopts that same
    // meaning on purpose (MONEY-1204).
    //
    // The alternative — headline `series60.at(-1)`, the newest row whatever it
    // holds — has a universe-wide failure mode. `DailyPrice` is written by TWO
    // producers: price-sync writes a Yahoo row (OHLCV, no delivery columns) on
    // every session, and bhavcopy-sync adds the NSE columns at 21:00 IST. So
    // between the open and 21:00 every weekday the newest row for EVERY symbol
    // is delivery-less, `deliveryPct` would be null for the whole universe, and
    // every delivery screen would return zero matches — rule 7 ("unknown
    // excludes") applied to an entire column at once, which is a silent empty
    // result, not a safe one. It also put this module in direct contradiction
    // with the stock page, which reads the same table and says "58.2%, as of
    // 13 Aug" for a stock this would call unknown.
    //
    // And it dated a non-answer: with the newest row as the headline, a symbol
    // that has NEVER reported delivery still got a `deliveryAsOf`. Here the
    // value and its date are null together, always.
    out.deliveryPct = trend.latest?.deliveryPct ?? null;
    // `mean20` already SKIPS null sessions and `n20` is how many contributed.
    // Re-deriving either here would be a second implementation of the one rule
    // this field exists to get right.
    out.deliveryPct20dAvg = trend.mean20;
    out.deliveryPct20dDays = trend.n20;
    out.deliveryPct20dWindow = trend.window20;
    // The staleness bound is the READER's window, not a second constant here:
    // `loadMarketFieldValues` only ever fetches
    // `MARKET_FIELD_LOOKBACK_DAYS.delivery` (60 calendar days, ~40 sessions) of
    // `DailyPrice`, so a delisted or long-suspended name has NO reporting
    // session in hand and resolves to null rather than surfacing a figure from
    // months ago. Widening that window widens this field's staleness with it.
    // Exactly the arrangement `bondAsOf` already documents one screen over: a
    // possibly-stale value that states its own date, rather than staleness
    // decided silently here.
    out.deliveryAsOf = trend.latest?.date ?? null;
  }

  if (rows.flags) {
    applyFlagValues(out, rows.flags, rows.flagsReferenceDayByKind ?? {});
  }

  if (rows.shareholding) {
    applyShareholdingValues(out, rows.shareholding);
  }

  if (rows.memberships) {
    // `[]` is a real answer here ("in no index"), which is why the field is
    // `string[] | null` rather than `string[]` — the null is "not read".
    out.indexIds = buildIndexChips(rows.memberships).map((c) =>
      normalizeIndexId(c.indexId),
    );
  }

  if (rows.derivatives) {
    out.pcrOi = marketNumber(rows.derivatives.pcrOi);
    out.futOiChange = marketNumber(rows.derivatives.futOiChange);
    out.derivativesAsOf = isoOrNull(rows.derivatives.date ?? null);
  }

  if (rows.mwpl) {
    // Read straight through. It is null on every row today and the registry
    // says so; deriving it from `notionalOi` or `oi_cli_limit` would publish a
    // number nobody measured.
    out.mwplUtilisation = marketNumber(rows.mwpl.utilisationPct);
    out.mwplAsOf = isoOrNull(rows.mwpl.date ?? null);
  }

  if (rows.bondEod) {
    out.bondPrice = marketNumber(rows.bondEod.lastPrice);
    // Last traded YTM first, weighted YTM as the fallback: both are the file's
    // own numbers, and a bond that printed once has only the former.
    out.bondYield =
      marketNumber(rows.bondEod.lastYtm) ?? marketNumber(rows.bondEod.wtdYtm);
    out.bondSegment =
      typeof rows.bondEod.segment === "string" && rows.bondEod.segment.trim()
        ? rows.bondEod.segment.trim()
        : null;
    out.bondAsOf = isoOrNull(rows.bondEod.date ?? null);
  }

  if (rows.bondMaster) {
    out.bondCoupon = marketNumber(rows.bondMaster.coupon);
    // NULL maturity is MEANINGFUL, not missing: perpetual instruments genuinely
    // have none, and inventing one would invent a redemption.
    out.bondMaturity = isoOrNull(rows.bondMaster.maturityDate ?? null);
  }

  return out;
}

/** Which flag kinds back which boolean fields. */
const FLAG_KIND_SURVEILLANCE = "SURVEILLANCE";
const FLAG_KIND_PRICE_BAND = "PRICE_BAND";
const FLAG_KIND_FO_BAN = "FO_BAN";

/** The kinds a market-structure screen reads. */
export const MARKET_FLAG_KINDS: readonly string[] = [
  FLAG_KIND_SURVEILLANCE,
  FLAG_KIND_PRICE_BAND,
  FLAG_KIND_FO_BAN,
];

/**
 * Current flag state, per kind, from the NEWEST row of that kind.
 *
 * Delegates the reduce to `buildStockFlagBadges`, which already owns the two
 * subtleties: several simultaneous values on one day are all kept (NSE
 * routinely publishes `GSM Stage I` AND `ESM Stage II` for one stock), and
 * `isCurrent` compares the kind's newest day against a reference day.
 *
 * Called ONCE PER KIND, each with that kind's own market-wide reference day —
 * `buildStockFlagBadges` takes a single reference for every kind it is handed,
 * and sharing one across families is the fail-open described on
 * `flagsReferenceDayByKind`.
 */
function applyFlagValues(
  out: MarketFieldValues,
  flags: ReadonlyArray<StockFlagStateRow>,
  referenceDayByKind: Readonly<Record<string, string | null>>,
): void {
  let newestReference: string | null = null;

  for (const kind of MARKET_FLAG_KINDS) {
    const referenceDay = referenceDayByKind[kind] ?? null;
    // No reference day means this family has not landed for this environment.
    // "Not banned" is not a conclusion available from an unlanded feed — leave
    // the kind's fields null so `matchesMarketFilters` excludes rather than
    // fabricating an all-clear (rule 3).
    if (referenceDay === null) continue;

    if (newestReference === null || referenceDay > newestReference) {
      newestReference = referenceDay;
    }

    // The kind is known to publish, so its booleans are now answerable.
    if (kind === FLAG_KIND_SURVEILLANCE) {
      out.asmFlag = false;
      out.gsmFlag = false;
    } else if (kind === FLAG_KIND_PRICE_BAND) {
      out.priceBandFlag = false;
    } else if (kind === FLAG_KIND_FO_BAN) {
      out.foBanFlag = false;
    }

    const kindRows = flags.filter((r) => r?.kind === kind);
    if (kindRows.length === 0) continue;

    for (const badge of buildStockFlagBadges(kindRows, { referenceDay })) {
      if (!badge.isCurrent) continue;
      if (kind === FLAG_KIND_FO_BAN) {
        out.foBanFlag = true;
      } else if (kind === FLAG_KIND_SURVEILLANCE) {
        applySurveillanceBadge(out, badge);
      } else if (kind === FLAG_KIND_PRICE_BAND) {
        const parsed = badge.parsed;
        const band = parsed?.type === "PRICE_BAND" ? parsed.band : null;
        if (band !== null) out.priceBand = band;
        // `No Band` is a PUBLISHED value meaning the stock has no circuit
        // limit — false, not unknown. `Number("No Band")` is NaN, which is why
        // the column is a string all the way down.
        if (band !== null && !/no\s*band/i.test(band)) out.priceBandFlag = true;
      }
    }
  }

  out.flagsAsOf = newestReference;
}

function applySurveillanceBadge(
  out: MarketFieldValues,
  badge: StockFlagBadge,
): void {
  const parsed = badge.parsed;
  const code = parsed?.type === "SURVEILLANCE" ? parsed.code : badge.raw;
  if (code && !out.surveillanceCodes.includes(code)) {
    out.surveillanceCodes.push(code);
  }

  const decode = parsed?.type === "SURVEILLANCE" ? parsed.decode : null;
  if (decode === null) {
    // Unrecognised wording is carried through as an UNKNOWN rather than
    // silently answering "not under ASM". A precise mapping without a
    // catch-all shrinks coverage the moment NSE invents a framework.
    if (code && !out.surveillanceUndecoded.includes(code)) {
      out.surveillanceUndecoded.push(code);
    }
    return;
  }
  if (decode.framework === "ASM") out.asmFlag = true;
  if (decode.framework === "GSM") out.gsmFlag = true;
}

/**
 * A quarter label the sequence can actually be read from: `YYYY-MM`.
 *
 * `normalizeQuarter` keeps an unparseable period VERBATIM and upper-cased
 * (`"Q1FY26"`), and in ASCII `"Q" > "2"` — so a plain lexicographic DESC puts
 * every undatable label ABOVE every real quarter. Same regex, same reason, as
 * `CANONICAL_QUARTER` in packages/research/src/data-sources/db-store.ts.
 */
const CANONICAL_QUARTER = /^\d{4}-\d{2}$/;

/** Newest two quarters → levels + QoQ deltas. */
function applyShareholdingValues(
  out: MarketFieldValues,
  rows: ReadonlyArray<ShareholdingQuarterRow>,
): void {
  // DATABLE labels first, then newest-first WITHIN each group. Among canonical
  // labels `YYYY-MM` sorts lexicographically = chronologically; an undatable
  // label has no position in the sequence at all, so it must sink below every
  // label that does rather than sort "arbitrarily" — arbitrarily here means
  // FIRST, and first means it becomes `pledgedPct` and manufactures a QoQ
  // collapse out of a period nobody can date.
  //
  // The reader excludes these in its query too. Both are needed: this function
  // is reachable with caller-supplied rows, and the reader's cap is applied
  // before this ranking runs.
  const sorted = rows
    .filter((r): r is ShareholdingQuarterRow => Boolean(r?.quarter))
    .slice()
    .sort((a, b) => {
      const ac = CANONICAL_QUARTER.test(a.quarter) ? 1 : 0;
      const bc = CANONICAL_QUARTER.test(b.quarter) ? 1 : 0;
      if (ac !== bc) return bc - ac;
      return a.quarter < b.quarter ? 1 : a.quarter > b.quarter ? -1 : 0;
    });

  const latest = sorted[0];
  const previous = sorted[1];
  if (!latest) return;

  out.shareholdingQuarter = latest.quarter;
  out.shareholdingPrevQuarter = previous?.quarter ?? null;

  out.pledgedPct = marketNumber(latest.pledgedPct);
  out.fiiPct = marketNumber(latest.fiiPct);
  out.diiPct = marketNumber(latest.diiPct);

  if (previous) {
    out.pledgedPctQoqDelta = qoqDelta(
      out.pledgedPct,
      marketNumber(previous.pledgedPct),
    );
    out.fiiPctQoqDelta = qoqDelta(out.fiiPct, marketNumber(previous.fiiPct));
    out.diiPctQoqDelta = qoqDelta(out.diiPct, marketNumber(previous.diiPct));
  }
}

// ─── Matching ────────────────────────────────────────────────────────

/** The subset of `ScreenerFilter` this module needs. Structural on purpose, so
 *  the pure layer does not depend on the engine module. */
export interface MarketFilterInput {
  field: string;
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
  /** Non-numeric operand — currently only `indexMember`'s index slug. */
  operand?: string;
}

/**
 * One field's comparable value: the number, 1/0 for a boolean, or null when it
 * could not be determined.
 *
 * `indexMember` is the only predicate: it is evaluated against the resolved
 * open-stint list, narrowed by `operand` when one was given. `indexIds: null`
 * (the table was not read) stays null rather than collapsing to 0, because "we
 * did not look" and "it is in no index" are different answers.
 */
export function marketFieldValue(
  values: MarketFieldValues,
  field: string,
  operand?: string,
): number | null {
  const def = MARKET_FIELD_BY_ID.get(field);
  if (!def) return null;

  if (field === "indexMember") {
    const ids = values.indexIds;
    if (ids === null) return null;
    const wanted = operand ? normalizeIndexId(operand) : "";
    if (wanted === "") return ids.length > 0 ? 1 : 0;
    return ids.includes(wanted) ? 1 : 0;
  }

  const raw = (values as unknown as Record<string, unknown>)[field];
  if (def.kind === "boolean") {
    return typeof raw === "boolean" ? (raw ? 1 : 0) : null;
  }
  return marketNumber(raw);
}

/**
 * Does this instrument satisfy every market-structure filter?
 *
 * The three rules that matter, all of them the same rule seen from different
 * sides:
 *
 *   * An UNKNOWN value (null) EXCLUDES. It never matches, and it never matches
 *     "everything" via a coalesce-to-zero. This is what makes a filter on the
 *     permanently-null `mwplUtilisation` return NO MATCHES instead of the whole
 *     universe, and what makes a bond filter against a nearly-empty `bond_eod`
 *     degrade to zero rows instead of throwing.
 *   * A NON-FINITE value excludes for the same reason — every relational
 *     comparison against NaN is `false`, so without the guard `gt`/`lt`/
 *     `between` never reach their fail branch and the row leaks through.
 *   * An UNKNOWN FIELD is skipped, not failed. A vocabulary that has run ahead
 *     of the registry must not silently return zero stocks; the engine logs the
 *     drop, exactly as it does for an unsupported fundamental field.
 */
export function matchesMarketFilters(
  values: MarketFieldValues,
  filters: readonly MarketFilterInput[],
): boolean {
  for (const filter of filters) {
    if (!MARKET_FIELD_BY_ID.has(filter.field)) continue;

    const val = marketFieldValue(values, filter.field, filter.operand);
    if (val === null || !Number.isFinite(val)) return false;

    switch (filter.operator) {
      case "gt":
        if (val <= (filter.value as number)) return false;
        break;
      case "gte":
        if (val < (filter.value as number)) return false;
        break;
      case "lt":
        if (val >= (filter.value as number)) return false;
        break;
      case "lte":
        if (val > (filter.value as number)) return false;
        break;
      case "eq":
        if (val !== (filter.value as number)) return false;
        break;
      case "between": {
        const bounds = filter.value;
        if (!Array.isArray(bounds)) return false;
        const [min, max] = bounds;
        if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
        if (val < min || val > max) return false;
        break;
      }
      // `cross_above` / `cross_below` are candle-series operators. There is no
      // series behind a market-structure field (a pledge is quarterly, a ban is
      // a daily list), so rather than invent one, the filter cannot be
      // satisfied — and says so by excluding, not by passing.
      case "cross_above":
      case "cross_below":
        return false;
      default:
        return false;
    }
  }
  return true;
}
