/**
 * Pure decisions for the India exchange-archive replay — MONEY-1497 (B2-IN).
 *
 * No GCS, no BigQuery, no Mongo, no clock, no `@usemoney/core`. Everything is a
 * function of its arguments, so every trap below is assertable without
 * provisioning anything.
 *
 * `scripts/jobs/lake-replay-in.ts` is the I/O shell. It owns the adapters that
 * turn a core parser's row into one of the narrow inputs declared here — and it
 * is TYPE-CHECKED against both sides, which is what makes a renamed parser
 * field a build failure rather than a column of nulls.
 *
 * ## WHY THIS PACKAGE CANNOT IMPORT THE PARSERS
 *
 * `packages/core/src/market-data/databento/databento-repo.ts:911` states the
 * rule from the other side: **`packages/core` must NOT depend on
 * `@usemoney/lake`.** The mirror of that is worth keeping too — a lake package
 * that pulls in core drags the whole market-data tree into every test that
 * wants a partition key, and this repo has measured what a root-barrel import
 * costs a test budget (3,817 ms for one `require`). So the input interfaces
 * below are declared structurally and the shell supplies them.
 *
 * ## WHAT THE B2-IN BRIEF ASKS FOR THAT THIS REPO CANNOT SUPPLY
 *
 * Two of the five tables the brief names have no source in this codebase, and
 * both were verified by grep rather than assumed:
 *
 *   - **MTO delivery.** `nse-mto-delivery` is registered and archived, and it
 *     is NOT in `feed-parse`'s `PARSERS` table. No MTO parser exists anywhere
 *     in the repo. `delivery_daily` is therefore fed from
 *     `nse-sec-bhavdata-full` alone, which floors delivery history at
 *     2019-10-01 rather than 2002. The TABLE is built for MTO's shape anyway —
 *     `series` is nullable because an MTO row carries no SERIES column — so
 *     adding the parser later is a writer, not a migration.
 *   - **Corporate actions.** There is no CF-CA family. India corporate actions
 *     never pass through the feed archive at all: they come from live NSE/BSE
 *     APIs through `scripts/jobs/corp-actions-backfill.ts`. A ledgered
 *     `corporate_action` sink has to hang off THAT job, and belongs to it.
 *
 * Neither is a gap this module papers over. A writer that cannot fill a column
 * should not claim it.
 */

import { createHash } from "node:crypto";
import {
  numeric,
  toPriceBarRow,
  volumeToInt64String,
  type PriceBarRow,
  type RowProvenance,
} from "./price-bar-logic";

/**
 * Re-exported so the I/O shell imports ONE subpath rather than two that must
 * stay in agreement. The type is B2's; the provenance rule is shared.
 */
export type { RowProvenance };

/** The one market this replay writes. */
export const IN_MARKET = "IN" as const;

/** The composite separator — a NUL, for `ledger-logic.ts`'s reason. */
const NUL = "\u0000";

/**
 * `delivery_daily.delivery_pct` is `NUMERIC(9, 4)` — the ONE column in the lake
 * that is not scale 6 (`ddl/006_silver_derivatives_in.sql`), so it has LESS
 * headroom than everything around it, not more. Spelled here rather than
 * passed as a bare `4` so the number and its reason travel together.
 *
 * CORRECTED (MONEY-1512 review): an earlier version of this comment called the
 * value a quotient "`delivery.ts` divides deliverable by traded". It does not
 * — `delivery.ts` performs no division at all. Both producers PARSE the
 * exchange's own pre-formatted percent column (`num(rec.DELIV_PER)` at :174
 * for NSE, `Number(delPer)` at :263 for BSE), which prints two decimals today.
 *
 * So this is a guard on the COLUMN'S CONTRACT, not on an observed float tail:
 * the scale has to be stated at the mapping, or the next producer to reach
 * this row — a BSE variant, a computed fallback — silently exceeds four places
 * and fails the whole load at `maxBadRecords: 0`. Keeping the wrong reason
 * would have been worse than keeping no reason: it would have sent the next
 * reader looking for a division that was never there.
 */
const DELIVERY_PCT_SCALE = 4;

/* ─────────────────────────────────────────────────────────────────────────
   Tables and parser versions
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The silver tables this replay writes.
 *
 * `price_bar_d1` is shared with B2's US loader (`market` is a column, never a
 * second dataset); the other three are created by
 * `packages/lake/ddl/006_silver_derivatives_in.sql`.
 */
export const INDIA_TABLES = [
  "price_bar_d1",
  "derivatives_eod_in",
  "delivery_daily",
  "index_eod",
] as const;
export type IndiaTable = (typeof INDIA_TABLES)[number];

/**
 * ONE PARSER VERSION PER TABLE, not one for the whole job.
 *
 * `parser_version` is part of the ledger's five-part identity, so bumping it
 * makes every partition of that table re-loadable without deleting anything —
 * the new tuple simply has no ACCEPTED row yet. A single job-wide version would
 * mean a fix to the F&O mapper forces a re-load of thirty years of cash bars,
 * which is the cost that makes people not bump it.
 *
 * They are also DISTINCT FROM `PRICE_BAR_PARSER_VERSION`, which B2 stamps on
 * US rows. India bars come out of the bhavcopy parsers and US bars out of the
 * Tiingo shards; one string across both would make a US parser fix look like it
 * had covered India, in the one column that exists to say otherwise.
 *
 * ## v2 — MONEY-1522, AND WHY ONLY TWO OF THE FOUR MOVED
 *
 * `price_bar_d1` and `delivery_daily` are the two tables whose rows carry a
 * `listing_id`, and its spelling changed from `{symbol}:{exchange}` to
 * `{symbol}:{exchange}:unknown` (see `ListingIdBuilder`). The bump makes every
 * month of both re-loadable over unchanged bytes, and the reload REPLACES the v1
 * rows rather than landing beside them, because `replaceMonth` deletes by
 * `(market, month, source)` and never by version (`monthDeleteBounds`).
 *
 * `derivatives_eod_in` and `index_eod` carry no `listing_id`, so their rows are
 * identical under this change and their versions stay put. Bumping them would
 * buy a reload of 69,983,709 F&O rows (prod, 2026-09-23) that rewrites every
 * one to itself.
 */
export const INDIA_PARSER_VERSIONS: Readonly<Record<IndiaTable, string>> = {
  price_bar_d1: "in-bhavcopy-v2",
  derivatives_eod_in: "in-fo-v1",
  delivery_daily: "in-delivery-v2",
  index_eod: "in-index-v1",
};

export function isIndiaTable(v: unknown): v is IndiaTable {
  return (
    typeof v === "string" && (INDIA_TABLES as readonly string[]).includes(v)
  );
}

/** The parser version for a table. Throws rather than defaulting. */
export function indiaParserVersion(table: IndiaTable): string {
  const v = INDIA_PARSER_VERSIONS[table];
  if (!v) {
    // A default here would stamp a version nobody chose onto rows nobody can
    // later identify, in the column whose whole job is identifying them.
    throw new Error(`no parser version declared for table "${String(table)}"`);
  }
  return v;
}

/* ─────────────────────────────────────────────────────────────────────────
   Which archived families feed which table
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Registry family ids per table, VERBATIM as `report-registry.ts` spells them.
 *
 * Spelling matters more than it looks: the brief calls one of these
 * `sec-bhavdata-full`, which is the `feed` SLUG. The registry id is
 * `nse-sec-bhavdata-full`, and `familyById` returns `undefined` for the other —
 * so a replay driven by the brief's spelling selects nothing and reports a
 * clean run over zero files.
 *
 * `nse-index-snapshot` rides beside `nse-indices-close` deliberately: same
 * layout, two prefixes (nsearchives vs niftyindices), and the `(index_slug,
 * session_date)` grain makes the overlap a duplicate rather than a conflict —
 * which `dedupeIndiaRows` removes before the load.
 */
export const INDIA_FAMILIES: Readonly<Record<IndiaTable, readonly string[]>> = {
  price_bar_d1: [
    "nse-cm-legacy",
    "nse-cm-udiff-bhavcopy",
    "bse-cm-legacy",
    "bse-cm-isin-legacy",
    "bse-cm-udiff-bhavcopy",
  ],
  derivatives_eod_in: [
    "nse-fo-legacy",
    "nse-fo-udiff-bhavcopy",
    "bse-fo-udiff-bhavcopy",
  ],
  delivery_daily: ["nse-sec-bhavdata-full"],
  index_eod: ["nse-indices-close", "nse-index-snapshot"],
};

/**
 * The `source` value each table's rows carry.
 *
 * NOT one constant for the whole job. `source` is an AUTHORITY RANK
 * (`price-source-authority.ts`) and a provenance label, and `ind_close_all` is
 * not a bhavcopy — stamping `BHAVCOPY_HIST` on an index close would assert a
 * rank for a file that never carried one. `NSE_INDICES` is the spelling Mongo's
 * own `IndexClose` writer already uses, so the two stores agree.
 *
 * It is also the DELETE SCOPE: `replaceMonth` removes
 * `(market, month, source)` before it loads, so this value has to be the same
 * one the rows are written with. A second spelling anywhere and the reload
 * deletes nothing and doubles the month.
 */
export const INDIA_SOURCES: Readonly<Record<IndiaTable, string>> = {
  // `BHAVCOPY_HIST`, not `BHAVCOPY`: it is what `feed-parse` writes into
  // `DailyPrice` from these same archived bytes, and both rank 100. Keeping the
  // spelling identical is what lets `lake-parity-in` join the two sides without
  // a translation table.
  price_bar_d1: "BHAVCOPY_HIST",
  derivatives_eod_in: "BHAVCOPY_HIST",
  delivery_daily: "BHAVCOPY_HIST",
  index_eod: "NSE_INDICES",
};

/** The source for a table. Throws rather than defaulting to a rank. */
export function sourceFor(table: IndiaTable): string {
  const v = INDIA_SOURCES[table];
  if (!v) {
    throw new Error(`no source declared for table "${String(table)}"`);
  }
  return v;
}

/** Every family this replay reads, across all four tables. */
export function allIndiaFamilies(): string[] {
  return INDIA_TABLES.flatMap((t) => [...INDIA_FAMILIES[t]]);
}

/** Which table a family feeds, or null if this replay does not read it. */
export function tableForFamily(familyId: string): IndiaTable | null {
  for (const table of INDIA_TABLES) {
    if (INDIA_FAMILIES[table].includes(familyId)) return table;
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────
   The partition key and the source hash
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The partition key: `IN/YYYY-MM`.
 *
 * ## THE UNIT IS THE MONTH, AND THE BRIEF'S OWN KEY CANNOT WORK
 *
 * B2-IN says to claim `(table, month, source_hash = object generation,
 * parser_version)`. Those two halves contradict each other and the
 * contradiction is not cosmetic: a month holds ~21 day-files with ~21 DIFFERENT
 * generations, so that key claims the same month 21 times under 21 hashes.
 * `acceptPartition` then supersedes the other 20 (`supersedeOlderAccepted`
 * matches on partition_key and a DIFFERENT hash), and `decideClaim` re-LOADS a
 * SUPERSEDED row — so the twenty-first day-file of every month would silently
 * queue the previous twenty for a duplicate load.
 *
 * The month is the unit because the TABLE is month-partitioned, so the hash has
 * to describe the whole month: `indiaSourceHash` takes every contributing
 * day-file. That is B2's `priceBarSourceHash` shape, for B2's reason.
 *
 * MARKET IS IN THE KEY even for the three IN-only tables. `price_bar_d1` is
 * genuinely shared, and one spelling across all four is what stops a reader
 * from having to know which tables are shared this week.
 */
export function indiaPartitionKey(sessionDate: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(sessionDate);
  if (!m) {
    throw new Error(
      `session_date must be YYYY-MM-DD, got ${JSON.stringify(sessionDate)} — ` +
        `a malformed date produces a partition key that never matches the one ` +
        `the next run computes, so every run reloads it`,
    );
  }
  return `${IN_MARKET}/${m[1]}-${m[2]}`;
}

/** One archived day-file that contributed rows to a partition. */
export interface ContributingFile {
  /** `YYYY-MM-DD`, the day the archive key encodes. */
  date: string;
  /** The GCS object key. */
  key: string;
  /**
   * The GCS generation, as a string.
   *
   * NOT the object's name, and not its size. A repaired object keeps its name
   * and changes its generation — MONEY-1169 rewrote thousands of envelope-
   * corrupted feed objects IN PLACE, and a hash over names would have left
   * every one of those partitions un-reloadable for ever.
   */
  generation: string;
}

/**
 * The source hash for one month: sha256 over every contributing day-file.
 *
 * SORTED before hashing. The walk order is incidental (a family loop inside a
 * date loop, or the reverse), and an unsorted hash would differ run-to-run over
 * identical bytes — turning every claim into a reload of a month that was
 * already correct.
 *
 * AN EMPTY SET THROWS rather than hashing to the well-known sha256 of the empty
 * string. That value is a real, stable, wrong hash: a month where every fetch
 * 404'd would claim it, load nothing, and — if a caller ever accepted it —
 * freeze the gap permanently under a hash that a later, successful run would
 * never reproduce. The caller must decide what an empty month means.
 */
export function indiaSourceHash(files: readonly ContributingFile[]): string {
  if (files.length === 0) {
    throw new Error(
      "indiaSourceHash: refusing to hash zero files — the empty digest is a " +
        "stable value that would claim a month nothing was read for. Decide " +
        "what an empty month means before calling this.",
    );
  }
  const parts = files
    .map((f) => `${f.date}${NUL}${f.key}${NUL}${f.generation}`)
    .sort();
  const h = createHash("sha256");
  for (const p of parts) h.update(p).update(NUL);
  return h.digest("hex");
}

/* ─────────────────────────────────────────────────────────────────────────
   Identity: how `listing_id` was arrived at
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The ONE listing-id builder — `buildListingId` in
 * `packages/core/src/market-data/tiingo/tiingo-logic.ts` — as this package
 * receives it: an ARGUMENT, passed by the shell.
 *
 * ## WHY AN ARGUMENT, AND NOT AN IMPORT OR A COPY
 *
 * Not an import: `packages/core` must not depend on `@usemoney/lake` (see the
 * header), and this package's tsconfig refuses the reverse with TS6059. Not a
 * copy, because a copy is what MONEY-1522 deleted. `indiaListingId` built
 * `{symbol}:{exchange}` here while `silver.listing` was built by
 * `buildListingId` as `{symbol}:{exchange}:unknown`, and measured on prod
 * 2026-09-22 the two id sets — 16,898 in `price_bar_d1`, 23,907 in `listing` —
 * intersected in NOTHING. Every identity-to-bars join returned zero while every
 * writer reported success.
 *
 * So the SPELLING lives in core and the INDIA RULE lives here: we hold no
 * inception date for an Indian listing, so every India writer passes `null`,
 * which the builder renders as `unknown`. The two meet on REAL prod ids in
 * `packages/core/__tests__/market-data/listing-id.test.ts` — core's test
 * tsconfig is the only side of the boundary that can see both.
 *
 * The empty-half guard `indiaListingId` carried moved INTO the builder, where it
 * covers every writer. Its throw still lands where it always did: inside
 * `mapRows`, which counts the file unreadable, so the month cannot be ACCEPTED
 * over it.
 */
export type ListingIdBuilder = (
  symbol: string,
  exchange: string,
  listingStartDate: string | null,
) => string;

/**
 * How we knew which security a row names.
 *
 * Values are drawn from `identity-logic.ts`'s `MAP_METHODS`, so the two tables
 * speak one vocabulary and a join can compare them.
 *
 *   EXACT_ISIN           the row itself carried an ISIN. Durable: a later
 *                        rename, or a reused ticker, is still resolvable.
 *   SYMBOL_VENUE_DATED   the file stated a symbol and a session date and no
 *                        ISIN. Correct on the day, and the ONLY thing standing
 *                        between a retired ticker and its successor later.
 *
 * The distinction is the whole reason `resolution_method` exists here. Legacy
 * NSE CM files are short-width far later than folklore says — `cm14NOV2006bhav`
 * still ends at `TIMESTAMP,` — so this is a large slice of history, not an
 * edge case (per-file-derivable-map.md correction 1).
 */
export function indiaResolutionMethod(isin: string | null | undefined): string {
  return isin && isin.trim() !== "" ? "EXACT_ISIN" : "SYMBOL_VENUE_DATED";
}

/* ─────────────────────────────────────────────────────────────────────────
   Row inputs — the narrow shapes the shell adapts core's parsers onto
   ──────────────────────────────────────────────────────────────────────── */

/** An `ISO YYYY-MM-DD` date. The shell converts a `Date` once, at the edge. */
type IsoDate = string;

export interface IndiaCashBar {
  symbol: string;
  exchange: string;
  isin: string | null;
  sessionDate: IsoDate;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | bigint | null;
  series: string | null;
}

export interface IndiaDerivative {
  underlying: string;
  exchange: string;
  instrumentType: string;
  expiryDate: IsoDate;
  strike: number | null;
  optionType: string | null;
  sessionDate: IsoDate;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  settle: number | null;
  openInterest: number | bigint | null;
  changeInOi: number | bigint | null;
  contractsTraded: number | bigint | null;
  valueLakh: number | null;
}

export interface IndiaDelivery {
  symbol: string;
  exchange: string;
  isin: string | null;
  /** NULL means THE FILE DID NOT SAY — see `delivery_daily`'s DDL. */
  series: string | null;
  sessionDate: IsoDate;
  tradedQty: number | bigint | null;
  deliverableQty: number | bigint | null;
  deliveryPct: number | null;
}

export interface IndiaIndexClose {
  indexSlug: string;
  indexName: string | null;
  exchange: string;
  sessionDate: IsoDate;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  prevClose: number | null;
  volume: number | bigint | null;
  turnoverCr: number | null;
  pe: number | null;
  pb: number | null;
  divYield: number | null;
}

/* ─────────────────────────────────────────────────────────────────────────
   Row outputs — BigQuery-facing, snake_case
   ──────────────────────────────────────────────────────────────────────── */

/** The six mandatory silver columns, spelled once. */
function provenanceColumns(
  prov: RowProvenance,
  table: IndiaTable,
): {
  source_object_uri: string;
  source_record_key: string;
  parser_version: string;
  pipeline_run_id: string;
  observed_at: string;
  ingested_at: string;
} {
  return {
    source_object_uri: prov.sourceObjectUri,
    source_record_key: prov.sourceRecordKey,
    parser_version: indiaParserVersion(table),
    pipeline_run_id: prov.pipelineRunId,
    observed_at: new Date(prov.observedAtMs).toISOString(),
    ingested_at: new Date(prov.ingestedAtMs).toISOString(),
  };
}

export interface DerivativeEodRow {
  market: string;
  underlying: string;
  exchange: string;
  instrument_type: string;
  expiry_date: string;
  strike_price: number | null;
  option_type: string | null;
  session_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  settle_price: number | null;
  open_interest: string | null;
  change_in_oi: string | null;
  contracts_traded: string | null;
  value_lakh: number | null;
  source: string;
  source_object_uri: string;
  source_record_key: string;
  parser_version: string;
  pipeline_run_id: string;
  observed_at: string;
  ingested_at: string;
}

export interface DeliveryDailyRow {
  market: string;
  listing_id: string;
  symbol: string;
  exchange: string;
  isin: string | null;
  series: string | null;
  session_date: string;
  traded_qty: string | null;
  deliverable_qty: string | null;
  delivery_pct: number | null;
  source: string;
  resolution_method: string;
  source_object_uri: string;
  source_record_key: string;
  parser_version: string;
  pipeline_run_id: string;
  observed_at: string;
  ingested_at: string;
}

export interface IndexEodRow {
  market: string;
  index_slug: string;
  index_name: string | null;
  exchange: string;
  session_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  prev_close: number | null;
  volume: string | null;
  turnover_cr: number | null;
  pe_ratio: number | null;
  pb_ratio: number | null;
  div_yield: number | null;
  source: string;
  source_object_uri: string;
  source_record_key: string;
  parser_version: string;
  pipeline_run_id: string;
  observed_at: string;
  ingested_at: string;
}

/** A cash bar plus the ISIN the silver table gained for B2-IN. */
export type IndiaPriceBarRow = PriceBarRow & { isin: string | null };

/**
 * Map one cash bar onto its `price_bar_d1` row.
 *
 * Delegates to B2's `toPriceBarRow` rather than restating it: the non-finite →
 * NULL rule, the INT64-as-decimal-string rule and the six provenance columns
 * are one implementation for both markets, so a fix to either reaches both.
 * Only `parser_version` and `isin` are India's own.
 */
export function toIndiaPriceBarRow(
  bar: IndiaCashBar,
  prov: RowProvenance,
  source: string,
  listingIdOf: ListingIdBuilder,
): IndiaPriceBarRow {
  const isin = bar.isin && bar.isin.trim() !== "" ? bar.isin.trim() : null;
  const row = toPriceBarRow(
    {
      market: IN_MARKET,
      listingId: listingIdOf(bar.symbol, bar.exchange, null),
      symbol: bar.symbol,
      exchange: bar.exchange,
      sessionDate: bar.sessionDate,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      source,
      resolutionMethod: indiaResolutionMethod(isin),
    },
    { ...prov, parserVersion: indiaParserVersion("price_bar_d1") },
  );
  return { ...row, isin };
}

/**
 * Instrument types with no strike and no option type.
 *
 * Closed, and matched on the INSTRUMENT TYPE rather than on Mongo's sentinels
 * (`strike: 0`, `optionType: "XX"`). Testing for the sentinel would null a
 * genuine zero — and, worse, would leave a future sentinel spelling ("NA", "")
 * silently stored as a real option type on every futures row.
 */
export const FUTURE_INSTRUMENT_TYPES = ["FUTIDX", "FUTSTK", "FUTCUR", "FUTIRC"];

export function isFutureInstrument(instrumentType: string): boolean {
  return FUTURE_INSTRUMENT_TYPES.includes(instrumentType.trim().toUpperCase());
}

/**
 * Map one contract-session onto its `derivatives_eod_in` row.
 *
 * A FUTURE STORES NULL STRIKE AND NULL OPTION TYPE. Mongo carries `0` and
 * `"XX"` because its unique index compares nulls as EQUAL and needed a
 * distinguishable value; BigQuery enforces no key at all, so the sentinels
 * would be pure noise — and a `0` strike sorts, aggregates and charts as a
 * price, which is the shape of an error nobody sees.
 */
export function toDerivativeEodRow(
  d: IndiaDerivative,
  prov: RowProvenance,
  source: string,
): DerivativeEodRow {
  const future = isFutureInstrument(d.instrumentType);
  return {
    market: IN_MARKET,
    underlying: d.underlying,
    exchange: d.exchange,
    instrument_type: d.instrumentType,
    expiry_date: d.expiryDate,
    strike_price: future ? null : numeric(d.strike),
    option_type: future ? null : (d.optionType ?? null),
    session_date: d.sessionDate,
    open: numeric(d.open),
    high: numeric(d.high),
    low: numeric(d.low),
    close: numeric(d.close),
    settle_price: numeric(d.settle),
    open_interest: volumeToInt64String(d.openInterest),
    change_in_oi: volumeToInt64String(d.changeInOi),
    contracts_traded: volumeToInt64String(d.contractsTraded),
    value_lakh: numeric(d.valueLakh),
    source,
    ...provenanceColumns(prov, "derivatives_eod_in"),
  };
}

/**
 * Map one delivery row.
 *
 * `series` PASSES THROUGH, null included. `sec_bhavdata_full` states it; an MTO
 * row has no SERIES column at all, and coercing that absence to `"EQ"` would
 * fabricate exactly the value a delivery screen must be able to exclude — BE/BZ
 * trade-for-trade rows are 100% delivery by construction.
 *
 * `delivery_pct` keeps its NULL too. The file prints `-` where delivery was not
 * reported, and zero delivery is a different fact; a mean over the two differs
 * by the whole column.
 */
export function toDeliveryDailyRow(
  d: IndiaDelivery,
  prov: RowProvenance,
  source: string,
  listingIdOf: ListingIdBuilder,
): DeliveryDailyRow {
  const isin = d.isin && d.isin.trim() !== "" ? d.isin.trim() : null;
  return {
    market: IN_MARKET,
    // The SAME id the bar for this (symbol, exchange) carries — MONEY-1522.
    // A third spelling here would split delivery from price on one listing.
    listing_id: listingIdOf(d.symbol, d.exchange, null),
    symbol: d.symbol,
    exchange: d.exchange,
    isin,
    series: d.series && d.series.trim() !== "" ? d.series.trim() : null,
    session_date: d.sessionDate,
    traded_qty: volumeToInt64String(d.tradedQty),
    deliverable_qty: volumeToInt64String(d.deliverableQty),
    delivery_pct: numeric(d.deliveryPct, DELIVERY_PCT_SCALE),
    source,
    resolution_method: indiaResolutionMethod(isin),
    ...provenanceColumns(prov, "delivery_daily"),
  };
}

/** Map one index close. All thirteen columns, not the four Mongo keeps. */
export function toIndexEodRow(
  i: IndiaIndexClose,
  prov: RowProvenance,
  source: string,
): IndexEodRow {
  return {
    market: IN_MARKET,
    index_slug: i.indexSlug,
    index_name: i.indexName,
    exchange: i.exchange,
    session_date: i.sessionDate,
    open: numeric(i.open),
    high: numeric(i.high),
    low: numeric(i.low),
    close: numeric(i.close),
    prev_close: numeric(i.prevClose),
    volume: volumeToInt64String(i.volume),
    turnover_cr: numeric(i.turnoverCr),
    pe_ratio: numeric(i.pe),
    pb_ratio: numeric(i.pb),
    div_yield: numeric(i.divYield),
    source,
    ...provenanceColumns(prov, "index_eod"),
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   The date walk — computed, never listed
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Candidate session dates in `[from, to]`, weekends removed.
 *
 * ## WHY THIS EXISTS AT ALL: `listFiles` FAILS OPEN
 *
 * `feed-parse` drives its walk from `listFiles(prefix)`, which returns `[]` for
 * an empty prefix AND for a storage failure — indistinguishable. A replay
 * driven by one would load nothing and report a clean run. Every key here is
 * COMPUTED from the registry's own `buildUrl` + `buildFeedArchiveKey` and then
 * fetched; a 404 is a real absence.
 *
 * ## WEEKENDS ARE DROPPED; HOLIDAYS ARE NOT
 *
 * Indian exchanges do not trade Saturday or Sunday, so a weekend candidate can
 * only ever 404 — dropping them removes ~28% of the GETs and can exclude
 * nothing real. HOLIDAYS are deliberately left in: `NSE_HOLIDAYS_BY_FY` covers
 * recent financial years only, and this walk starts in 1994. A holiday
 * candidate costs one 404, which is the correct price for not owning a
 * thirty-year calendar.
 *
 * ## EXCEPT THE SPECIAL-SESSION CALENDAR — MONEY-1613
 *
 * Muhurat, Budget Saturdays and DR Saturdays DO trade on a weekend.
 * `calendarDates` (core's `specialSessionCandidateDates()`, passed in because
 * this package does not import core) adds the ones inside `[from, to]`. A
 * calendar date is a date to TRY: with no archived file it is never read, so
 * it is never expected — exactly like a weekday that 404s.
 *
 * Dates are ISO strings compared lexicographically, never `Date` objects — the
 * same rule `identity-logic.ts` states, for the same reason.
 */
export function enumerateSessionCandidates(
  from: string,
  to: string,
  calendarDates: readonly string[] = [],
): string[] {
  assertIso(from, "from");
  assertIso(to, "to");
  if (from > to) return [];

  const out = new Set<string>();
  const cur = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cur.getTime() <= end.getTime()) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) out.add(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  for (const d of calendarDates) {
    if (d >= from && d <= to) out.add(d);
  }
  return [...out].sort();
}

function assertIso(v: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`${field} must be YYYY-MM-DD, got ${JSON.stringify(v)}`);
  }
  // A regex alone accepts 2017-02-30, which parses to 2017-03-02 and then sorts
  // nowhere near where the caller meant.
  if (new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) !== v) {
    throw new Error(`${field} is not a real date: ${v}`);
  }
}

/** `2024-03-17` -> `2024-03`. The month a candidate belongs to. */
export function monthOf(isoDate: string): string {
  assertIso(isoDate, "date");
  return isoDate.slice(0, 7);
}

/** Group candidate dates into months, preserving order within each. */
export function groupDatesByMonth(
  dates: readonly string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of dates) {
    const m = monthOf(d);
    const list = out.get(m);
    if (list) list.push(d);
    else out.set(m, [d]);
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────
   De-duplication
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Remove rows two families produced for the same logical fact.
 *
 * `nse-indices-close` and `nse-index-snapshot` publish the SAME layout under
 * two prefixes, and the NSE and BSE cash families overlap in symbol for
 * dual-listed names — but those are different `listing_id`s, so only the index
 * pair actually collides. Without this the month gets two rows per index-session
 * and every downstream aggregate double-counts while looking entirely normal.
 *
 * FIRST WINS, and the caller controls the order. The replay reads families in
 * `INDIA_FAMILIES` order, so `nse-indices-close` — the nsearchives copy the
 * nightly engine already parses — takes precedence over the niftyindices
 * backfill snapshot.
 */
export function dedupeIndiaRows<T extends object>(
  rows: readonly T[],
  keyFields: readonly string[],
): T[] {
  if (keyFields.length === 0) {
    throw new Error(
      "dedupeIndiaRows: refusing an empty key — every row would collapse onto " +
        "one, silently discarding the whole partition but the first row",
    );
  }
  // A MISSPELLED FIELD IS REFUSED, and this guard is the reason the key is a
  // plain `string[]`. Every row would read `undefined` for it, so a typo does
  // not error — it silently WEAKENS the key, and one wholly-wrong key collapses
  // the entire partition to a single row while reporting a clean de-dupe.
  // Checked against the first row: these arrays are uniform by construction
  // (one mapper builds them all), so one row is enough to catch a typo and
  // scanning every row would cost a pass over millions.
  const first = rows[0] as Record<string, unknown> | undefined;
  if (first) {
    const missing = keyFields.filter((f) => !(f in first));
    if (missing.length > 0) {
      throw new Error(
        `dedupeIndiaRows: key field(s) ${missing.join(", ")} are not on the row — ` +
          `they would read undefined for every row, weakening the key silently`,
      );
    }
  }
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const rec = row as Record<string, unknown>;
    const k = keyFields.map((f) => String(rec[f])).join(NUL);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

/** The natural key of each table, for `dedupeIndiaRows`. */
export const INDIA_DEDUPE_KEYS: Readonly<
  Record<IndiaTable, readonly string[]>
> = {
  price_bar_d1: ["market", "listing_id", "session_date"],
  derivatives_eod_in: [
    "underlying",
    "exchange",
    "instrument_type",
    "expiry_date",
    "strike_price",
    "option_type",
    "session_date",
  ],
  delivery_daily: ["market", "listing_id", "session_date"],
  index_eod: ["market", "index_slug", "session_date"],
};

/* ─────────────────────────────────────────────────────────────────────────
   Quarantine
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Why a row was refused. NAMED, never a boolean.
 *
 * "could not parse" and "failed the gate" need different fixes, and a count
 * without a reason sends the next operator to read thirty years of CSV.
 */
export const INDIA_QUARANTINE_REASONS = [
  /** The row named no symbol, or no exchange — `listing_id` is unbuildable. */
  "UNRESOLVABLE_LISTING",
  /** Every price on the row was non-finite. A bar with no prices is not a bar. */
  "NO_FINITE_PRICE",
  /** `session_date` or `expiry_date` was not a real calendar date. */
  "BAD_DATE",
  /** A derivative row whose instrument type is not one the registry knows. */
  "UNKNOWN_INSTRUMENT_TYPE",
  /**
   * The row's OWN session date falls outside the partition being loaded.
   *
   * The archive key says which day a file is; the PARSER reads the day off the
   * file's own column, and the two can disagree @@ `parseSecBhavdataFull`
   * counts exactly that as `dateMismatch`, and `dateFromArchiveKey` recovers a
   * date from five different filename grammars including a two-digit year.
   *
   * A stray row is not merely misfiled. `replaceMonth` deletes ONE month before
   * it loads, so a row that lands in an adjacent month is outside every
   * subsequent reload's predicate: it can never be corrected, only accumulated.
   */
  "WRONG_MONTH",
] as const;
export type IndiaQuarantineReason = (typeof INDIA_QUARANTINE_REASONS)[number];

export interface QuarantinedRow {
  reason: IndiaQuarantineReason;
  /** A small, JSON-safe sample of the offending input. Never the whole file. */
  sample: Record<string, unknown>;
}

export interface SiftResult<T> {
  rows: T[];
  quarantined: QuarantinedRow[];
  /** Per-reason counts, so a day's refusals are one log line rather than N. */
  counts: Record<string, number>;
}

/**
 * Split mapped rows into keepers and quarantine.
 *
 * Runs AFTER mapping, on the BigQuery-facing row, because that is the shape
 * that will actually be stored — a check against the parser's shape can pass
 * while the mapper turns the value into something else.
 *
 * A CASH OR INDEX ROW WITH NO FINITE PRICE IS REFUSED. `toPriceBarRow` turns a
 * NaN close into NULL rather than 0, which is right — but an all-NULL bar still
 * occupies a session, and a coverage query counting sessions would then report
 * the month complete. Refusing it keeps "we have this session" and "we have a
 * price for this session" the same answer.
 *
 * The cap is on the SAMPLE, not on the count: `counts` stays exact however many
 * rows are refused, because an under-reported refusal count is the number an
 * operator would act on.
 */
export function siftRows<T extends object>(
  rows: readonly T[],
  classify: (row: T) => IndiaQuarantineReason | null,
  sampleCap = 5,
): SiftResult<T> {
  const kept: T[] = [];
  const quarantined: QuarantinedRow[] = [];
  const counts: Record<string, number> = {};

  for (const row of rows) {
    const reason = classify(row);
    if (!reason) {
      kept.push(row);
      continue;
    }
    counts[reason] = (counts[reason] ?? 0) + 1;
    if (quarantined.filter((q) => q.reason === reason).length < sampleCap) {
      quarantined.push({
        reason,
        sample: { ...row } as Record<string, unknown>,
      });
    }
  }
  return { rows: kept, quarantined, counts };
}

/**
 * Does this row's own session date belong to the partition being loaded?
 *
 * Compared as STRING PREFIXES — `IN/2024-03` against `2024-03-17` — rather
 * than by parsing either side into a `Date`. Both are already ISO and already
 * validated; converting them would add a timezone to a comparison that has
 * none, which is how a 1st-of-the-month row lands in the previous partition.
 */
export function isSessionInPartition(
  partitionKey: string,
  sessionDate: string,
): boolean {
  const m = /^[A-Z]+\/(\d{4}-\d{2})$/.exec(partitionKey);
  if (!m) {
    throw new Error(
      `isSessionInPartition: unrecognised partition key ` +
        `${JSON.stringify(partitionKey)} — expected {MARKET}/{YYYY-MM}`,
    );
  }
  return sessionDate.startsWith(`${m[1]}-`);
}

/** The classifier for a priced row (cash bars and index closes). */
export function classifyPricedRow(row: {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
}): IndiaQuarantineReason | null {
  const anyPrice =
    row.open !== null ||
    row.high !== null ||
    row.low !== null ||
    row.close !== null;
  return anyPrice ? null : "NO_FINITE_PRICE";
}

/* ─────────────────────────────────────────────────────────────────────────
   Coverage — what makes an ACCEPT honest here
   ──────────────────────────────────────────────────────────────────────── */

export type MonthVerdict =
  | { action: "load"; expectedSessions: number; actualSessions: number }
  | { action: "skip"; reason: string };

/**
 * A STALE COPY: a zero-row file that is a byte-for-byte DUPLICATE of the file
 * archived under the key of the session it holds — MONEY-1612.
 *
 * Measured on prod 2026-09-23: on NSE holidays the archive holds a full
 * `sec_bhavdata_full` for the date, and it is the PREVIOUS session's file
 * (2019-10-02 is 213,174 B, byte-for-byte the size of 2019-10-01's). The parser
 * drops every row as a date mismatch, so the file yields nothing — correctly.
 *
 * ## "EVERY ROW HAS ANOTHER DATE" IS NOT ENOUGH — TWICE OVER
 *
 * The first cut asked only that, and it was wrong on prod. Of the 85 delivery
 * files whose key date has no bhavcopy archived, FOUR are the ONLY copy of a
 * real WEEKEND session filed under the next weekday's key — 28102019 holds
 * Sunday 2019-10-27 (Muhurat), 16112020 holds Saturday 2020-11-14 (Muhurat),
 * 22012024 holds Saturday 2024-01-20, 20052024 holds Saturday 2024-05-18.
 * The weekday walk never read those sessions. MONEY-1613 walks them from the
 * special-session calendar, so once the weekend's OWN key is archived the
 * weekday file is a duplicate like any other — hence `calendarDates` below.
 *
 * The second cut added "every held date is an earlier WEEKDAY", and that was
 * wrong too: 05112021 holds 2,013 rows dated 2021-11-04 — the weekday Diwali
 * Muhurat session — while 04112021 is byte-identical to 03112021. The held
 * date is an earlier weekday, and still this file is its ONLY copy.
 *
 * So the date rule is only a PRECONDITION ({@link isStaleCopyCandidate}); the
 * proof is the bytes. The shell HEADs the held date's own archive key and
 * compares hashes ({@link compareArchivedObjects}), and only `equal` makes the
 * file stale. Calling the only copy of a session "stale" would ACCEPT its month
 * without it, and the unchanged source hash would freeze the gap.
 */
export function isStaleCopyCandidate(parse: {
  rows: number;
  /** The file's archive-key date, `YYYY-MM-DD`. */
  keyDate: string;
  /** Distinct DATE1 values of the rows that did not match `keyDate`. */
  mismatchedDates: readonly string[];
  /**
   * The special-session calendar the walk also reads under their own keys
   * (MONEY-1613). A held date must be one the walk reads — a weekday, or one
   * of these — or there is no own key to compare against. Absent means none,
   * which is the safe side: the file stays foreign and the month refuses.
   */
  calendarDates?: readonly string[];
}): boolean {
  if (parse.rows !== 0 || parse.mismatchedDates.length === 0) return false;
  return parse.mismatchedDates.every(
    (d) =>
      d < parse.keyDate &&
      enumerateSessionCandidates(d, d, parse.calendarDates).length === 1,
  );
}

/**
 * Is a file byte-identical to the file under the held session's own key?
 *
 *   equal       the hashes match — a real duplicate
 *   different   the hashes differ, OR the own key holds no object: this file
 *               is the only copy of that session
 *   unreadable  no hash the two objects share — treated like `different`
 *               (fail-safe: an uncompared file can never make a holiday)
 */
export type OwnKeyMatch = "equal" | "different" | "unreadable";

const hashField = (
  meta: Readonly<Record<string, unknown>>,
  field: "md5Hash" | "crc32c",
): string | null => {
  const v = meta[field];
  return typeof v === "string" && v.length > 0 ? v : null;
};

/**
 * Compare two archived objects' GCS metadata. `md5Hash` first; `crc32c` when
 * either side lacks an md5 (composite objects carry none). `own` is null when
 * the held session's own key holds no object.
 */
export function compareArchivedObjects(
  file: Readonly<Record<string, unknown>>,
  own: Readonly<Record<string, unknown>> | null,
): OwnKeyMatch {
  if (own === null) return "different";
  for (const field of ["md5Hash", "crc32c"] as const) {
    const a = hashField(file, field);
    const b = hashField(own, field);
    if (a !== null && b !== null) return a === b ? "equal" : "different";
  }
  return "unreadable";
}

/**
 * A file that holds several dates is a duplicate only if it matches EVERY one
 * of their own keys. Any `different` wins, then any `unreadable`; nothing to
 * compare proves nothing.
 */
export function combineOwnKeyMatches(
  matches: readonly OwnKeyMatch[],
): OwnKeyMatch {
  if (matches.length === 0) return "unreadable";
  if (matches.includes("different")) return "different";
  if (matches.includes("unreadable")) return "unreadable";
  return "equal";
}

/**
 * What one READ file is, before its date is judged.
 *
 *   fresh    rows for its key date, or nothing at all (an empty file is a
 *            family going dark and stays a missing session)
 *   stale    a candidate ({@link isStaleCopyCandidate}) whose bytes EQUAL the
 *            file under the held session's own key
 *   foreign  zero rows, all dated a session this file is NOT a proven duplicate
 *            of — a weekend session, a date on or after its key, or an earlier
 *            weekday whose own key differs, is missing, or could not be
 *            compared. Never a holiday.
 */
export type ReadFileKind = "fresh" | "stale" | "foreign";

export function classifyReadFile(file: {
  rows: number;
  keyDate: string;
  mismatchedDates: readonly string[];
  calendarDates?: readonly string[];
  /** The own-key comparison, or null when none was made. */
  ownKeyMatch: OwnKeyMatch | null;
}): ReadFileKind {
  if (isStaleCopyCandidate(file) && file.ownKeyMatch === "equal") {
    return "stale";
  }
  if (file.rows === 0 && file.mismatchedDates.length > 0) return "foreign";
  return "fresh";
}

/**
 * What one READ date is to the coverage gate.
 *
 *   session    a file parsed and gave rows or nothing at all — expected, as
 *              always
 *   holiday    every readable file was a stale copy AND the same exchange's
 *              price bhavcopy is ABSENT from the archive — not expected
 *   stale-gap  expected, so a missing session refuses the month:
 *              - every readable file was a stale copy but the bhavcopy EXISTS,
 *                or no bhavcopy family covers the date; or
 *              - a zero-row file held a session it is NOT a proven duplicate
 *                of (`foreign`) — e.g. a weekend session the walk never reads,
 *                or the only copy of a weekday session
 */
export type ReadDateVerdict = "session" | "holiday" | "stale-gap";

/**
 * Classify a read date. The rule needs a SECOND, independent signal, because a
 * stale copy alone cannot tell a holiday from a day the exchange failed to
 * publish: the price bhavcopy archive 404s on holidays (price_bar_d1 logs
 * `missing=N` for exactly those dates), and a stale delivery file on a day
 * that DID have a bhavcopy is a real gap.
 *
 * Only a proven `false` makes a holiday. `null` — no bhavcopy family is
 * walkable that day, so absence proves nothing — stays expected. The polarity
 * matters: getting it wrong in the other direction ACCEPTS a partial month,
 * and ACCEPTED is what makes every future run skip it.
 */
export function classifyReadDate(args: {
  /** Files that parsed and were neither stale nor foreign (rows, or none). */
  freshFiles: number;
  /**
   * Zero-row files whose rows all carried another date they are NOT a proven
   * duplicate of — `classifyReadFile` "foreign". Never a holiday.
   */
  foreignFiles: number;
  staleFiles: number;
  /** Is the same exchange's price bhavcopy archived for this date? */
  bhavcopyPresent: boolean | null;
}): ReadDateVerdict | null {
  if (args.freshFiles > 0) return "session";
  if (args.foreignFiles > 0) return "stale-gap";
  if (args.staleFiles <= 0) return null;
  return args.bhavcopyPresent === false ? "holiday" : "stale-gap";
}

/**
 * One date's bhavcopy verdict from its per-exchange probes. Any exchange with
 * a bhavcopy that day means it traded (`true`); any exchange that could not be
 * probed leaves it unknown (`null`); only EVERY probe proving absence is
 * `false`. No probes at all proves nothing, so it is `null`, never `false`.
 */
export function combineBhavcopyProbes(
  probes: readonly (boolean | null)[],
): boolean | null {
  if (probes.length === 0) return null;
  if (probes.includes(true)) return true;
  if (probes.includes(null)) return null;
  return false;
}

/** A human line for a `foreign` file: which session it held, and why that is not a duplicate. */
export function describeForeignSessions(
  keyDate: string,
  held: readonly string[],
  ownKeyMatch: OwnKeyMatch | null,
  calendarDates: readonly string[] = [],
): string {
  return held
    .map((d) =>
      enumerateSessionCandidates(d, d, calendarDates).length === 0
        ? `weekend session ${d} — not walked`
        : d >= keyDate
          ? `session ${d} — on or after its key`
          : ownKeyMatch === "unreadable"
            ? `session ${d} — its own key could not be compared`
            : `session ${d} — not held under its own key`,
    )
    .join("; ");
}

/**
 * Should this month be loaded, and what does coverage mean for it?
 *
 * ## `expectedSessions` IS DATES READ — not trading days, and NOT files
 *
 * `decideCoverage` refuses unless `actualSessions >= expectedSessions > 0`, and
 * the obvious reading of "expected" is the trading calendar. **This repo does
 * not have one that reaches 1994** — `NSE_HOLIDAYS_BY_FY` covers recent
 * financial years only. Counting weekdays instead would make every month
 * containing a holiday read as partial, i.e. every month; the gate would be
 * useless, and the natural next move would be to weaken it to `>= 1`, which is
 * the not-measured-is-not-passed defect this repo has shipped four times.
 *
 * So the gate answers the question it CAN answer honestly: **did every session
 * whose file we read and parsed actually produce rows?** `expected` is the
 * number of distinct DATES for which at least one archived file was read and
 * parsed; `actual` is the number of distinct session dates present in the
 * mapped rows. A parser that silently returns `[]` — the MONEY-1169 shape,
 * thousands of envelope-corrupted files parsing to nothing while the run
 * reported success — fails it.
 *
 * ## IT COUNTS DATES BECAUSE FAMILIES OVERLAP, and counting FILES refused
 * ## every healthy month
 *
 * This is a correction, not a preference. `expected` was the FILE count, and
 * from 2024 onward TWO families publish every single session of three of the
 * four tables — NSE and BSE cash UDiFF, NSE and BSE F&O UDiFF, and both
 * `ind_close_all` prefixes. A healthy 21-session month therefore reads 42 files
 * and yields 21 session dates, so `21 >= 42` is false and `acceptPartition`
 * would have THROWN on every month this replay was built to load. A gate that
 * refuses health is worse than no gate, because the only obvious fix is to
 * loosen it.
 *
 * The cost of counting dates is that ONE family going dark is MASKED while its
 * sibling covers the same dates. That is reported rather than gated —
 * `zeroRows` in the run log — because a dark family must not block loading the
 * data the other family DID produce, and because it is a per-family question a
 * per-partition gate cannot express.
 *
 * The CALENDAR question is a third question and it belongs to the coverage
 * REPORT, which names gaps rather than blocking a load. Conflating any two of
 * the three is how a missing holiday becomes a refused month.
 *
 * ## A STALE COPY ON A PROVEN HOLIDAY IS NOT EXPECTED — MONEY-1612
 *
 * Which is exactly what happened anyway, through the archive rather than the
 * calendar: NSE served the previous session's `sec_bhavdata_full` on holidays,
 * the archive kept it, and a date whose file was READ counted as expected even
 * though it could never produce a session. Every `delivery_daily` month with a
 * holiday was refused (2019-11 at 20/21 — 2019-11-12 held 2019-11-11).
 * `holidays` removes those dates, and only those `classifyReadDate` proved:
 * a byte-for-byte duplicate of an earlier weekday's own file (`classifyReadFile`
 * "stale") AND no bhavcopy.
 *
 * Not every such date is a holiday. 2019-10 still refuses at 19/20: its
 * 2019-10-28 file is the only copy of the Sunday 2019-10-27 Muhurat session,
 * and no file is archived under 27102019. That month is right to refuse until
 * the special-session walk (MONEY-1613) archives it; then the 28th is a
 * byte-identical duplicate, a holiday, and the month is 20/20. 2021-11
 * refuses too: 05112021 is the only copy of the weekday 2021-11-04 Muhurat
 * session (04112021 is byte-identical to 03112021).
 *
 * ## A MONTH WITH NO READABLE FILES IS A SKIP, NOT A REJECT
 *
 * Before a family's `startDate`, or across a month the archive genuinely does
 * not hold, zero files is the correct and expected outcome. `rejectPartition`
 * would record a failure that reruns for ever; a named skip records the truth.
 */
export function decideMonth(args: {
  /**
   * The DATES a file was read AND parsed for. A SET, never a count.
   *
   * The count is what the caller got wrong: the shell held a file counter and a
   * date set side by side and handed over the file counter, which reads as a
   * larger `expectedSessions` on every month two families cover. Taking the set
   * makes that unrepresentable — a file counter is not a `Set<string>`, so the
   * type checker refuses it rather than a reviewer having to notice.
   */
  datesRead: ReadonlySet<string>;
  /**
   * Read dates `classifyReadDate` proved to be HOLIDAYS — a stale copy with no
   * price bhavcopy. Not expected. Absent means none.
   */
  holidays?: ReadonlySet<string>;
  /** The session dates actually PRESENT in the mapped rows. Also a set. */
  sessionDates: ReadonlySet<string>;
  rowCount: number;
}): MonthVerdict {
  const { rowCount } = args;
  const datesRead = args.datesRead.size;
  const holidays = args.holidays;
  const expected = holidays
    ? [...args.datesRead].filter((d) => !holidays.has(d)).length
    : datesRead;
  const distinctSessionDates = args.sessionDates.size;

  if (datesRead <= 0) {
    return {
      action: "skip",
      reason:
        "no day-file in this month returned bytes — before the family's floor, " +
        "or a month the archive does not hold. Not a failure; nothing to load.",
    };
  }
  if (!Number.isFinite(rowCount) || rowCount <= 0) {
    return {
      action: "skip",
      reason: `${datesRead} session(s) read and zero rows mapped — quarantine explains why`,
    };
  }
  return {
    action: "load",
    expectedSessions: expected,
    actualSessions: distinctSessionDates,
  };
}

/**
 * The `DELETE` predicate that makes a month's load idempotent.
 *
 * ## WHY A DELETE IS NEEDED AT ALL
 *
 * `bq load` APPENDS. Two things make a second append of the same month real
 * rather than theoretical:
 *
 *   - a crash between `bq load` and `acceptPartition`. The rows are in; the
 *     ledger says LOADING; the lease expires; the next run reloads them.
 *   - a REPAIRED archive object. MONEY-1169 rewrote thousands of feed objects
 *     in place, which changes the month's `source_hash` — so the ledger
 *     correctly says "load this again", and without a delete the month ends up
 *     holding both parses.
 *
 * Scoped to `(market, month, source)` and nothing else. `session_date` carries
 * the partition, so the statement is partition-pruned rather than a full-table
 * scan; `market` keeps an India reload from touching B2's US rows in the shared
 * `price_bar_d1`; and `source` keeps it from touching rows some future writer
 * at a different authority rank legitimately owns for the same sessions.
 *
 * NOT scoped to `parser_version`, and that WAS the first cut — a real defect,
 * found by re-reading rather than by a test. `parser_version` is in the LEDGER
 * key precisely so a parser FIX re-runs over bytes that have not changed, which
 * means the rows a reload must remove are BY DEFINITION the ones carrying the
 * PREVIOUS version. Deleting by the NEW version removes nothing, so the month
 * ends up holding both parses of every session with nothing on either row to
 * say which is current — the exact duplicate this delete exists to prevent,
 * reachable only on the path the delete was written for.
 *
 * NOT scoped to `source_object_uri` either. A month is loaded as one unit from
 * several files, and a per-file predicate would leave behind exactly the rows
 * of a file the new run could not read — the stale half of a partial month,
 * invisible beside the fresh half.
 */
export function monthDeleteBounds(partitionKey: string): {
  market: string;
  fromInclusive: string;
  toExclusive: string;
} {
  const m = /^([A-Z]+)\/(\d{4})-(\d{2})$/.exec(partitionKey);
  if (!m) {
    throw new Error(
      `monthDeleteBounds: unrecognised partition key ${JSON.stringify(partitionKey)} — ` +
        `expected {MARKET}/{YYYY-MM}. A wrong bound here deletes rows that ` +
        `are not being replaced.`,
    );
  }
  const year = Number(m[2]);
  const month = Number(m[3]);
  if (month < 1 || month > 12) {
    throw new Error(`monthDeleteBounds: month ${m[3]} is not 01-12`);
  }
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    market: m[1]!,
    fromInclusive: `${m[2]}-${m[3]}-01`,
    toExclusive: `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`,
  };
}
