/**
 * Mongo `corporate_actions` -> `lake_silver.corporate_action`. MONEY-1516 (a).
 *
 * PURE — no BigQuery, no Prisma, no clock. The shell is
 * `scripts/jobs/corp-action-lake-sink.ts`.
 *
 * ## WHY THIS TABLE HAS TO BE FILLED AT ALL
 *
 * `dataform/includes/adjustment.js` computes the split and dividend factors
 * from the BAR's own `div_cash` / `split_factor` columns. Measured on prod
 * 2026-09-22, all 13,185,397 India bars carry NULL in both — bhavcopy publishes
 * no corporate-action data — and `NULL > 0` is NULL rather than true, so every
 * `CASE` takes its `ELSE`: `split_factor_cum = 1` and `adj_close = close`, for
 * every row, reported as a success. Part (b) joins this table instead.
 *
 * ## ONE `listing_id` SPELLING NOW, AND THE GUARD THAT PROVES IT — MONEY-1522
 *
 * `listing_id` is `buildListingId(symbol, exchange, null)` from core, passed in
 * by the shell (this package cannot import core — see `ListingIdBuilder`):
 * `{symbol}:{exchange}:unknown`. That is the id `silver.listing` carries, and
 * from `in-bhavcopy-v2` on it is the id `price_bar_d1` carries too.
 *
 * It was not always one spelling. Until MONEY-1522 India bars keyed on
 * `{symbol}:{exchange}` and `listing` on the three-part form; measured on prod
 * 2026-09-22 the two sets (16,898 and 23,907 ids) intersected in NOTHING, and
 * this loader deliberately emitted the BAR spelling so the adjustment's join
 * could match. Founder decision 2026-09-23: three segments everywhere, and the
 * bars are the side rewritten. So the spelling this loader protected INVERTED —
 * it now emits the identity spelling, which is also the bar spelling.
 *
 * THE OVERLAP GUARD STAYS, and what it proves is the same thing from the other
 * side. The shell still measures these rows against the REAL `price_bar_d1` ids
 * and REFUSES a run that overlaps in nothing, because a wrong spelling is
 * invisible to every other counter: the rows map, the load succeeds and the
 * adjustment joins zero. Until the India bars are replayed under
 * `in-bhavcopy-v2` it is SUPPOSED to refuse — a three-part loader overlaps
 * nothing in a two-part bar table, and that refusal is the guard working.
 * RUN ORDER: the India v2 bar replay, THEN this sink with `--reload`.
 *
 * ## WHAT IS REFUSED, AND WHAT IS ONLY COUNTED
 *
 * Refused (named, counted, never written): a row whose `listing_id` cannot be
 * BUILT (a blank half), whose venue is not one the bars carry, or whose
 * required dates are not real dates. Those can never join and can never be
 * corrected in an append-only table.
 *
 * NOT refused: a row naming a security we hold no bars for. India's `listing`
 * is CURRENT-ONLY — it is built from `InstrumentMapping` where `isActive` — so
 * a company delisted in 2010 has thirty years of bhavcopy bars and no identity
 * row at all. Refusing on identity membership would drop precisely the splits
 * whose charts have a cliff. Measured on prod: 6,658 of 59,087 actions (11.3%,
 * over 2,508 symbol/venue pairs) match neither table, and they are dominated by
 * G-Secs (`815GS2026`) and BSE's `#`-suffixed rows — real actions for
 * instruments nothing charts. They cost nothing to store and would cost a
 * re-run to recover.
 */

import type { ListingIdBuilder } from "./india-sink-logic";
import { numeric } from "./price-bar-logic";

/**
 * Bumped when the MEANING of a produced column changes.
 *
 * v3: `listing_id` gained its third segment (MONEY-1522) and `observed_ratio`
 * arrived (MONEY-1528 B). Both change what an existing row says, and the table
 * is insert-only, so v3 is loaded with `--reload`, which deletes every row this
 * version did not write.
 */
export const CORP_ACTION_PARSER_VERSION = "corp-action-lake-sink-v3";

/**
 * The venues whose actions can reach a bar, and the market they sit in.
 *
 * A MAP rather than a list because `market` is NOT NULL in the DDL and must be
 * derived from something the row states, never defaulted to "IN" — the day a US
 * corporate-action producer writes here, a defaulted market would file its rows
 * under India and they would join nothing while looking entirely normal.
 *
 * Measured on prod: `exchange` is BSE (30,476) or NSE (28,611) and nothing else.
 */
export const CORP_ACTION_VENUE_MARKET: Readonly<Record<string, string>> = {
  NSE: "IN",
  BSE: "IN",
};

/**
 * Why a row was refused. NAMED, never a boolean — `india-sink-logic`'s reasoning:
 * "could not parse" and "failed the gate" need different fixes.
 */
export const CORP_ACTION_REFUSALS = [
  /** No symbol, or no exchange — `listing_id` is unbuildable. */
  "UNRESOLVABLE_LISTING",
  /** A venue no bar carries, so the id could never join. */
  "UNKNOWN_VENUE",
  /** `exDate`, `createdAt` or `updatedAt` was not a real calendar date. */
  "BAD_DATE",
] as const;
export type CorpActionRefusal = (typeof CORP_ACTION_REFUSALS)[number];

/** The Mongo `corporate_actions` fields this mapper reads. */
export interface MongoCorporateActionRow {
  id: string;
  symbol: string;
  exchange: string;
  type: string;
  exDate: Date | null;
  recordDate: Date | null;
  ratio: number | null;
  dividendPerShare: number | null;
  source: string | null;
  /**
   * Mongo `Json?`, and its SHAPE depends on the producer — see
   * `observedRatioOf`. `unknown` because nothing about it is guaranteed.
   */
  details: unknown;
  /** When the corporate-actions sync FIRST recorded it. */
  createdAt: Date;
  /** When it last asserted it. */
  updatedAt: Date;
}

/**
 * One row of `lake_silver.corporate_action`, keyed exactly as the DDL spells it.
 *
 * snake_case because the SQL reads each struct field BY NAME through
 * `INSERT ... SELECT FROM UNNEST(@rows)`. A camelCase key does not fail; it
 * supplies NULL for its column and the statement reports success.
 *
 * `pipeline_run_id`, `parser_version` and `ingested_at` are supplied by the
 * statement itself — they are per-RUN, not per-row, and putting them in the
 * struct would send the same three strings 59,087 times.
 */
export interface CorpActionSilverRow {
  market: string;
  listing_id: string;
  action_type: string;
  ex_date: string | null;
  record_date: string | null;
  ratio: number | null;
  /** MONEY-1528 (B) — see `observedRatioOf`. */
  observed_ratio: number | null;
  cash: number | null;
  source: string;
  published_at: string;
  source_object_uri: string;
  source_record_key: string;
  observed_at: string;
}

export type CorpActionMapping =
  | { ok: true; row: CorpActionSilverRow }
  | { ok: false; reason: CorpActionRefusal };

/**
 * `source` is NOT NULL in silver and OPTIONAL in Mongo, so an absent one needs
 * a NAMED value rather than an empty string. Measured on prod every row carries
 * one (BSE / NSE / DERIVED / SCREENER / NSE+SCREENER), which is exactly why the
 * fallback must exist: nothing today would reveal it if the column started
 * arriving blank.
 */
export const CORP_ACTION_UNKNOWN_SOURCE = "UNKNOWN";

/**
 * There is no archived OBJECT behind most of these rows — 96 of 59,087 carry a
 * `gcsPath`, and it is a bucket-RELATIVE key with no bucket in it, so
 * `gs://${gcsPath}` would name a bucket that does not exist. The column names
 * the COLLECTION instead, the shape `identity-sync` uses (`mongo://identity-sync`),
 * and `source_record_key` carries the Mongo `_id` so one row is reachable with
 * one `findOne`.
 */
export const CORP_ACTION_SOURCE_OBJECT_URI = "mongo://corporate_actions";

function iso(d: Date | null | undefined): string | null {
  if (!d) return null;
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * `Date` -> `YYYY-MM-DD` in **IST**, not UTC — MONEY-1516 part (b) review.
 *
 * THIS WAS `toISOString().slice(0, 10)` AND IT SHIFTED MOST OF THE CORPUS A DAY
 * EARLY. Measured on prod across all 59,087 rows, `exDate` is stored in TWO
 * conventions:
 *
 *     18:30 UTC   48,224 rows   = IST midnight
 *     00:00 UTC   10,863 rows   = UTC midnight
 *
 * A UTC slice is right for the second and one day early for the first, and the
 * day-of-week census says so outright: **6,857 SUNDAY ex-dates against 4,048
 * Friday**. An Indian ex-date is never a Sunday; those are Mondays rendered
 * backwards.
 *
 * Rendering in IST is correct for BOTH: 18:30 UTC is IST midnight of the same
 * day, and 00:00 UTC is 05:30 IST of the same day. No branch on the convention,
 * which matters because nothing on the row says which producer wrote it.
 *
 * What it cost downstream: the adjustment factor landed on the bar AFTER the
 * ex-date for 1,266 of 1,345 locatable splits (94.1%), and the shift
 * manufactured same-event duplicates — 91 ratio pairs and 667 dividend pairs —
 * which, uncollapsed, SQUARE the adjustment on 413 listings (worst 11x).
 *
 * This loader is India-only by construction (`UNKNOWN_VENUE` refuses anything
 * but NSE/BSE), so one calendar is right. A future US corporate-action loader
 * needs ET and must NOT reuse this.
 *
 * Deliberately a mirror of `toIstDateKey` (`packages/core/.../nse-holidays.ts`)
 * rather than an import: `packages/core` and `packages/lake` have no dependency
 * edge in either direction, and `packages/lake`'s own tsconfig enforces that —
 * a relative import reaching into core fails type-check with TS6059, which is
 * the boundary doing its job rather than an obstacle to route around.
 *
 * EXPORTED ONLY SO THE OTHER SIDE CAN PIN IT. The agreement test lives in
 * `packages/core/__tests__/nse-holidays.test.ts`, next to the function it
 * mirrors, because core's test tsconfig sets `rootDir: "../.."` and can
 * therefore see both. That asymmetry is why the pin cannot sit in this
 * package's own test, and it is the same arrangement `numeric()` has.
 */
export function istDateKey(d: Date | null | undefined): string | null {
  if (d === null || d === undefined || !Number.isFinite(d.getTime())) {
    return null;
  }
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * `details.observedRatio`, or NULL — MONEY-1528 (B).
 *
 * WHY THE COLUMN EXISTS. `actionFactor` (`price-adjust.ts`) prefers the
 * OBSERVED ratio over `ratio` for every type but SPLIT and BONUS, because a
 * capital adjustment has no clean rational and the only honest factor is the
 * one the price series shows. A DERIVED row's `ratio` is that value SNAPPED to
 * the nearest plausible rational, within 3%. Silver carried only the snapped
 * one, so gold divided a cliff by 10 where the chart divided by 9.93.
 *
 * `details` is Mongo `Json?` and its shape is the PRODUCER's. Measured on prod
 * 2026-09-23 over 59,224 rows: NSE, BSE and SCREENER rows hold the announcement
 * as a STRING ("Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re
 * 1/- Per Share", "Bonus 1:1"), and only the 156 DERIVED CAPITAL_ADJUSTMENT rows
 * hold an object — every one with a NUMERIC `observedRatio` (155 double, 1 int,
 * 0.5005 to 10.288, 154 of them unequal to the snapped `ratio`).
 *
 * NUMBERS ONLY, where `actionFactor` coerces with `Number(c)`. Mirroring that
 * would store `Number("") === 0` for a blank string — a value `actionFactor`
 * itself skips (it wants `n > 0`) and a SQL `COALESCE` would take as a factor.
 * No string ratio exists on prod to lose.
 *
 * Through `numeric()`, like `ratio`: it is a quotient of two closes and carries
 * fifteen decimals, which `NUMERIC(18, 6)` refuses on a `maxBadRecords: 0`
 * path (MONEY-1512).
 */
export function observedRatioOf(details: unknown): number | null {
  if (typeof details !== "object" || details === null) return null;
  const v = (details as { observedRatio?: unknown }).observedRatio;
  return typeof v === "number" ? numeric(v) : null;
}

/**
 * Map one Mongo row, or say why it cannot be mapped.
 *
 * A RESULT rather than a throw. `events-logic`'s mappers throw on a bad date,
 * which is right for a producer whose rows are all written by one function; this
 * drains a 59,087-row table fed by four scrapers, and one bad `exDate` killing
 * the whole run would leave the other 59,086 unloaded with no counter to say
 * how many were fine.
 *
 * `ratio` and `cash` route through `numeric()` and that is load-bearing, not
 * tidiness: `ratio` is a post:pre QUOTIENT and prod holds
 * `1.333333333333333` — fifteen decimals into a `NUMERIC(18, 6)` column, on a
 * load path that runs `maxBadRecords: 0`, so that ONE row would fail the whole
 * job (MONEY-1512).
 *
 * `cash` is NOT gated on `action_type === "DIVIDEND"`. The DDL calls the column
 * "cash per share" and prod carries `dividendPerShare` on INTEREST_PAYMENT and
 * INCOME_DISTRIBUTION rows too; a type gate would drop a real per-share cash
 * amount for no reason the column's own description supports.
 *
 * A zero or negative `ratio` is passed through rather than refused. The
 * adjustment already guards it (`CASE WHEN split_factor > 0 … ELSE 1`), and a
 * second copy of that rule here is a rule that can disagree with itself.
 *
 * `listingIdOf` is core's `buildListingId`, passed by the shell. A blank half is
 * refused HERE, by name, before it is called — the builder would THROW on it,
 * and one bad row must not stop the other 59,000 (see above).
 */
export function toCorpActionSilverRow(
  action: MongoCorporateActionRow,
  listingIdOf: ListingIdBuilder,
): CorpActionMapping {
  const symbol = (action.symbol ?? "").trim();
  const exchange = (action.exchange ?? "").trim();
  if (!symbol || !exchange)
    return { ok: false, reason: "UNRESOLVABLE_LISTING" };

  const market = CORP_ACTION_VENUE_MARKET[exchange];
  if (!market) return { ok: false, reason: "UNKNOWN_VENUE" };

  // `published_at` and `observed_at` are both NOT NULL. `ex_date` is nullable in
  // the DDL but an action with no ex-date can never adjust a price, and this
  // table is append-only, so it is refused rather than stored as noise.
  const exDate = istDateKey(action.exDate);
  const publishedAt = iso(action.createdAt);
  const observedAt = iso(action.updatedAt);
  if (!exDate || !publishedAt || !observedAt)
    return { ok: false, reason: "BAD_DATE" };

  return {
    ok: true,
    row: {
      market,
      // The one spelling, from the one builder. India holds no listing start
      // date, hence `null` — `unknown` in the id. See the header.
      listing_id: listingIdOf(symbol, exchange, null),
      action_type: action.type,
      ex_date: exDate,
      // Informational, so an unparseable one is NULL rather than a refusal:
      // "the source never stated one" is an ordinary fact for this column.
      record_date: istDateKey(action.recordDate),
      ratio: numeric(action.ratio),
      observed_ratio: observedRatioOf(action.details),
      cash: numeric(action.dividendPerShare),
      source: action.source?.trim() || CORP_ACTION_UNKNOWN_SOURCE,
      published_at: publishedAt,
      source_object_uri: CORP_ACTION_SOURCE_OBJECT_URI,
      source_record_key: action.id,
      observed_at: observedAt,
    },
  };
}

/**
 * The key that decides whether silver already holds a row.
 *
 * The VALUES are in it, not just the natural key, because the table is
 * APPEND-ONLY and its DDL says a correction is a NEW ROW with a later
 * `observed_at`. Mongo's own key is `(symbol, exchange, type, exDate)`, so a
 * revised ratio or a late record date arrives on the SAME Mongo row — a key
 * made of those four alone would skip it and the correction would never reach
 * the lake, which is `eventSilverKey`'s `enriched_at` problem in a different
 * column.
 *
 * `observed_at` is deliberately NOT in the key. It moves on every `updatedAt`
 * touch, including ones that changed nothing, and including one this sink
 * cannot see; including it would append a duplicate row every time the
 * corporate-actions sync re-asserted an unchanged action.
 *
 * `observed_ratio` IS in it, for `ratio`'s reason. A re-run of the price-derived
 * detector rewrites `details.observedRatio` on the SAME Mongo row, and for a
 * capital adjustment that value — not `ratio` — is the factor the chart divides
 * by.
 *
 * NUMBERS ARE SPELLED, NOT INTERPOLATED. BigQuery hands a NUMERIC back as a
 * wrapper or a string (`"5"`, `"1.333333"`), and `String(5)` is `"5"` while the
 * column round-trips as `"5.000000"` — so both sides go through `numKey`, which
 * is the same trap `isoOf` documents for TIMESTAMP one table over.
 */
export function corpActionSilverKey(row: {
  listing_id: string;
  action_type: string;
  ex_date: string | null;
  record_date: string | null;
  ratio: number | null;
  observed_ratio: number | null;
  cash: number | null;
  source: string;
}): string {
  return [
    row.listing_id,
    row.action_type,
    row.ex_date ?? "",
    row.record_date ?? "",
    numKey(row.ratio),
    numKey(row.observed_ratio),
    numKey(row.cash),
    row.source,
  ].join("\u0000");
}

/** A key silver already holds, with the parser version and Mongo row that wrote it. */
export interface ExistingCorpActionKey {
  key: string;
  parserVersion: string;
  /** The Mongo `_id` — a row is present only as ITS OWN row. MONEY-1607 review. */
  sourceRecordKey: string;
}

/**
 * What "silver already holds this" means: the SAME Mongo row with the same
 * values. `corpActionSilverKey` alone is the values, so a different `_id`
 * carrying identical ones — a twin — used to count as present: skipped, and
 * then left with no silver row at all once the third or fourth arm deleted the
 * row it had matched (its `_id` gone, or moved). NUL-joined like the key.
 */
function presentKey(sourceRecordKey: string, key: string): string {
  return `${sourceRecordKey}\u0000${key}`;
}

/**
 * Which candidates to append — MONEY-1522 review.
 *
 * ## ON A RELOAD, ONLY THE CURRENT VERSION'S ROWS ARE "ALREADY THERE"
 *
 * `--reload` ends by deleting the older-version rows it has replaced. The
 * version-blind read this replaced counted those older rows as present too, so
 * a candidate whose VALUES the new version left unchanged — same key — was
 * skipped as already written and then deleted with its predecessor: lost from
 * silver by a run that reported success. That is the ordinary case, not an edge
 * one: a bump that fixes one column leaves every other row's key alone.
 *
 * It had NOT fired on prod — measured 2026-09-23, every one of the 1,908 Mongo
 * rows with no silver row is explained (1,771 IST twins collapsed below, 137
 * created after the last run), because the v1 -> v2 reload was a hand DELETE
 * followed by a plain run. The next `--reload` would have been the first.
 *
 * A PLAIN run still counts every version: it deletes nothing, so an older row
 * really is the lake's copy and appending beside it would duplicate the action.
 *
 * EACH MONGO ROW IS JUDGED BY ITS OWN SILVER ROW — MONEY-1607 review. Twins
 * (two `_id`s, identical values) used to collapse to the first, which made one
 * Mongo row's presence stand in for another's; the prune arms judge by `_id`,
 * so deleting the stand-in orphaned the twin. Gold already keeps ONE
 * observation per event (`action_latest`), so two identical rows never apply
 * twice. Measured 2026-09-23: 0 twin groups among 57,452 rows — MONEY-1530
 * deleted the 1,771 IST twins — so nothing on prod moves.
 */
export function planCorpActionAppend(
  candidates: readonly CorpActionSilverRow[],
  existing: readonly ExistingCorpActionKey[],
  reload: boolean,
): CorpActionSilverRow[] {
  const present = new Set(
    existing
      .filter((e) => !reload || e.parserVersion === CORP_ACTION_PARSER_VERSION)
      .map((e) => presentKey(e.sourceRecordKey, e.key)),
  );
  const pending: CorpActionSilverRow[] = [];
  for (const row of candidates) {
    const key = presentKey(row.source_record_key, corpActionSilverKey(row));
    if (present.has(key)) continue;
    present.add(key);
    pending.push(row);
  }
  return pending;
}

/**
 * The smallest Mongo read, as a fraction of the older version's distinct
 * `source_record_key`s, that may drive the ORPHAN prune — MONEY-1522 review.
 *
 * Healthy, the two are about equal: the older version was written from this
 * same table, and the table only grows between repairs. The largest deliberate
 * deletion on record is MONEY-1530's re-anchor, 1,772 of 59,224 rows (3.0%).
 * A read under 90% is more than three times that — it says the READ is short
 * (a filter, a truncated page, the wrong database), not that the table shrank,
 * and it is refused rather than acted on. A real shrink past 10% is a repair an
 * operator knows about, and deserves a hand-written DELETE, not a side effect.
 */
export const ORPHAN_PRUNE_MIN_READ_RATIO = 0.9;

/** The older-version rows whose Mongo row is gone, or why that arm will not run. */
export interface OrphanPrunePlan {
  /** `source_record_key`s to prune. EMPTY whenever `refused` is set. */
  orphans: string[];
  refused: string | null;
}

/**
 * Which older-version rows name a Mongo `_id` that no longer exists — the second
 * prune arm, MONEY-1522 review.
 *
 * The scoped arm (`deleteSupersededParserVersions`) only removes an older row
 * once a CURRENT row exists for the same `source_record_key`. A row whose Mongo
 * source was DELETED never gets one: MONEY-1530's re-anchor deletes 1,772 loser
 * `_id`s, so their older rows — carrying the retired two-part `listing_id` —
 * would survive every reload and ship in every release.
 *
 * This arm decides by ABSENCE, which is the thing the scoped arm was built to
 * stop doing: an empty or truncated read makes EVERY key look absent. So it runs
 * only on a read that proves it is the whole table, and is refused — pruning
 * nothing, by name — when the read is:
 *   - EMPTY;
 *   - SHORT of the count taken before it (`counted`): the read skipped rows,
 *     whatever the reason. Rows inserted DURING the read only raise it, and
 *     they cannot be orphans anyway;
 *   - under {@link ORPHAN_PRUNE_MIN_READ_RATIO} of the older version's keys.
 *
 * The result is an explicit key list, so the DELETE names what it removes
 * rather than deleting by negation at statement time.
 *
 * THE THIRD ARM REUSES IT, with `version` "current-version" — MONEY-1607. A
 * CURRENT-version row whose Mongo row is deleted later (a MONEY-1600
 * retirement, a hand delete) is reached by neither arm above, stays in silver
 * and keeps adjusting gold. Same proof, same floor: the current version was
 * written from this same table. The sink reads those keys BEFORE it counts
 * Mongo, so a row appended from a Mongo row newer than the read — by this run
 * or a concurrent one — is never in the set being judged.
 */
export function planOrphanPrune(
  read: { ids: ReadonlySet<string>; counted: number },
  olderKeys: Iterable<string>,
  version = "older-version",
): OrphanPrunePlan {
  const older = new Set(olderKeys);
  const refuse = (why: string): OrphanPrunePlan => ({
    orphans: [],
    refused: why,
  });
  if (read.ids.size === 0) return refuse("the Mongo read is EMPTY");
  if (read.ids.size < read.counted) {
    return refuse(
      `the Mongo read holds ${read.ids.size} of the ${read.counted} rows ` +
        "counted before it — not the full table",
    );
  }
  if (read.ids.size < ORPHAN_PRUNE_MIN_READ_RATIO * older.size) {
    return refuse(
      `the Mongo read holds ${read.ids.size} ids against ${older.size} ` +
        `${version} keys, under the ${ORPHAN_PRUNE_MIN_READ_RATIO} floor — ` +
        "a short read, not a smaller table",
    );
  }
  return {
    orphans: [...older].filter((k) => !read.ids.has(k)),
    refused: null,
  };
}

/**
 * A current-version row's IDENTITY in a restatement: its Mongo row plus the
 * place it occupies in gold — MONEY-1607 review.
 *
 * `action_latest` keeps ONE observation per `(market, listing_id, action_type,
 * ex_date)`, Mongo's own unique key lifted, latest `observed_at` first. A
 * correction that keeps those four (a revised ratio, cash, record date or
 * source) lands in the SAME partition and wins on `observed_at`, so gold is
 * already right and silver keeps the history the DDL promises. A correction
 * that MOVES one of them — the subjects repair's BONUS -> OTHER, an ex-date
 * move — lands in a NEW partition, the old row survives in its own, and gold
 * applies both. Only that second kind is a restatement.
 *
 * `RESTATED_KEY_SQL` is the same string built in SQL. They sit together so the
 * two spellings cannot drift, and the sink deletes by it.
 */
export function restatedKey(row: {
  source_record_key: string;
  market: string;
  listing_id: string;
  action_type: string;
  ex_date: string | null;
}): string {
  return [
    row.source_record_key,
    row.market,
    row.listing_id,
    row.action_type,
    row.ex_date ?? "",
  ].join("|");
}

export const RESTATED_KEY_SQL =
  "CONCAT(source_record_key, '|', market, '|', listing_id, '|', " +
  "action_type, '|', IFNULL(CAST(ex_date AS STRING), ''))";

/** The current-version rows a later Mongo correction has MOVED, or why not. */
export interface RestatedPrunePlan {
  /** `restatedKey`s of the stale rows. EMPTY whenever `refused` is set. */
  stale: string[];
  refused: string | null;
  /** Rows whose Mongo row exists but no longer maps — kept, and counted. */
  unmapped: number;
}

/**
 * Which current-version rows a Mongo correction has moved to another gold
 * partition — the fourth prune arm, MONEY-1607 review.
 *
 * The third arm judges by `_id`, so it skips a row whose Mongo row still
 * EXISTS: retype ZEEL's BONUS to OTHER after a reload and the appender writes
 * the OTHER row beside the BONUS one, the BONUS row's `_id` is still there, and
 * ZEEL stays divided by it in gold. This compares each current-version row with
 * what its Mongo row maps to NOW (`mapped`, `restatedKey` by
 * `source_record_key`, from this run's read) and names the ones that differ.
 *
 * Same whole-read proof as the orphan arms, refused by name through
 * `planOrphanPrune`. A row whose Mongo row is gone is the third arm's; a row
 * whose Mongo row no longer MAPS (a refusal) is kept — "cannot say" is not
 * "moved".
 */
export function planRestatedPrune(
  read: { ids: ReadonlySet<string>; counted: number },
  current: readonly Parameters<typeof restatedKey>[0][],
  mapped: ReadonlyMap<string, string>,
): RestatedPrunePlan {
  const proof = planOrphanPrune(
    read,
    current.map((r) => r.source_record_key),
    "current-version",
  );
  if (proof.refused) return { stale: [], refused: proof.refused, unmapped: 0 };
  const stale = new Set<string>();
  let unmapped = 0;
  for (const row of current) {
    if (!read.ids.has(row.source_record_key)) continue;
    const now = mapped.get(row.source_record_key);
    if (now === undefined) {
      unmapped++;
      continue;
    }
    const was = restatedKey(row);
    if (was !== now) stale.add(was);
  }
  return { stale: [...stale], refused: null, unmapped };
}

/**
 * The write, in the only safe order: APPEND FIRST, PRUNE LAST.
 *
 * The sink used to delete the superseded version and then insert. The insert is
 * ~30 sequential statements with no transaction across them, so a crash between
 * the two left a GAP: the old rows gone, the new ones partly written. In this
 * order the same crash leaves DUPLICATES — both versions live — which the next
 * `--reload` repairs, because `planCorpActionAppend` then counts only the
 * current version's rows as present.
 *
 * A reload prunes even when there is nothing to append. That run IS the re-run
 * after a crash between the two steps, and the early return the old code took
 * there would have left both versions live for ever.
 *
 * Two arms, counted apart: `superseded` (a current row replaced it) and
 * `orphaned` (its Mongo row is gone — `planOrphanPrune`; empty when refused).
 */
export async function appendThenPrune(
  pending: readonly CorpActionSilverRow[],
  reload: boolean,
  orphans: readonly string[],
  effects: {
    append: (rows: readonly CorpActionSilverRow[]) => Promise<void>;
    pruneSuperseded: () => Promise<number>;
    pruneOrphans: (keys: readonly string[]) => Promise<number>;
  },
): Promise<{ appended: number; superseded: number; orphaned: number }> {
  if (pending.length > 0) await effects.append(pending);
  if (!reload) return { appended: pending.length, superseded: 0, orphaned: 0 };
  const superseded = await effects.pruneSuperseded();
  const orphaned = orphans.length > 0 ? await effects.pruneOrphans(orphans) : 0;
  return { appended: pending.length, superseded, orphaned };
}

/**
 * The WIRE spelling of a `NUMERIC(18, 6)`: a fixed-6 decimal string, or null.
 *
 * A STRING on the wire, then `CAST(... AS NUMERIC)` in the SQL — the same
 * reasoning `event-lake-sink` gives for `observed_at`: a struct field typed
 * NUMERIC rejects the whole 2,000-row batch on one bad value, where a CAST
 * fails by NAME. It is `CAST`, never `SAFE_CAST`, because a value this function
 * produced can only fail the cast if this function is wrong — and turning that
 * into a silent NULL is how a column empties itself while the job reports
 * success.
 *
 * NULL SURVIVES AS NULL. `CAST('' AS NUMERIC)` errors, so the empty string the
 * KEY uses must never reach the wire.
 */
export function numWire(v: number | null | undefined): string | null {
  const n = numeric(v);
  return n === null ? null : n.toFixed(6);
}

/** One canonical decimal spelling for a NUMERIC(18, 6), either side of the wire. */
export function numKey(v: number | null | undefined): string {
  return numWire(v) ?? "";
}

/** The row as the INSERT's `UNNEST(@rows)` struct sees it — every field a STRING. */
export interface CorpActionWireRow {
  market: string;
  listing_id: string;
  action_type: string;
  ex_date: string | null;
  record_date: string | null;
  ratio: string | null;
  observed_ratio: string | null;
  cash: string | null;
  source: string;
  published_at: string;
  source_object_uri: string;
  source_record_key: string;
  observed_at: string;
}

export function toCorpActionWireRow(
  row: CorpActionSilverRow,
): CorpActionWireRow {
  return {
    ...row,
    ratio: numWire(row.ratio),
    observed_ratio: numWire(row.observed_ratio),
    cash: numWire(row.cash),
  };
}

/**
 * Three states, never two: how many mapped rows name a `listing_id` the bars
 * actually hold.
 *
 * `NOT_MEASURED` when either side is empty, because "no bars to check against"
 * and "these rows match no bar" are different facts and a `>= 0` comparison
 * makes them identical — the same not-measured-is-not-passed defect the XBRL
 * identity rung had. An empty CANDIDATE set is the same: a quiet incremental
 * night must not read as the wrong spelling.
 *
 * `NONE` is FATAL at the call site. A zero overlap over a non-empty bar set is
 * not a coverage figure, it is the wrong `listing_id` spelling, and it is
 * invisible in every other counter: the load succeeds, the rows land, and the
 * join in part (b) returns nothing for ever.
 */
export type JoinCoverage =
  | { state: "NOT_MEASURED"; matched: 0; total: number }
  | { state: "NONE"; matched: 0; total: number; sample: string[] }
  | {
      state: "MEASURED";
      matched: number;
      total: number;
      rate: number;
      sample: string[];
    };

export function joinCoverage(
  rows: readonly { listing_id: string }[],
  barListingIds: ReadonlySet<string>,
  sampleCap = 10,
): JoinCoverage {
  const total = rows.length;
  if (barListingIds.size === 0 || total === 0)
    return { state: "NOT_MEASURED", matched: 0, total };

  let matched = 0;
  const unmatched = new Set<string>();
  for (const r of rows) {
    if (barListingIds.has(r.listing_id)) matched++;
    else if (unmatched.size < sampleCap) unmatched.add(r.listing_id);
  }
  const sample = [...unmatched];
  if (matched === 0) return { state: "NONE", matched: 0, total, sample };
  return {
    state: "MEASURED",
    matched,
    total,
    rate: matched / total,
    sample,
  };
}
