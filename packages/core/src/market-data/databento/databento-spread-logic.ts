/**
 * `spread_cost_daily`: quoted and effective spread per listing-session.
 * MONEY-1505 (B5). Pure — no GCS, no BigQuery, no clock.
 *
 * ## THIS IS NOT THE COST MODEL, AND THE GRAIN IS THE DIFFERENCE
 *
 * `databento-cost-model-logic.ts` builds a MONTHLY model at
 * (listing x time-of-day), version-pinned, for sizing a backtest's
 * transaction costs. This builds a DAILY series at (listing x session) for the
 * lake, so a reader can ask "what did it cost to trade this name on this day".
 *
 * Everything that can be computed once is imported from there rather than
 * re-derived: `quoteSample`, `effectiveSpreadBps`, `Reservoir`, `percentile`,
 * `seedForCell`, `todBucketFor`. Only the CELL KEY and the summary shape are
 * new. Re-implementing the bps arithmetic would be a second definition of "the
 * spread" that could drift from the one a backtest is priced against.
 *
 * ## THE ASYMMETRY, WHICH IS THE WHOLE DESIGN
 *
 *   `bbo-1m` is TIME-UNIFORM — one record a minute per symbol whether or not
 *   anything traded. It is the QUOTED spread.
 *
 *   `tbbo` is ACTIVITY-WEIGHTED — one record per trade, so a busy minute
 *   contributes hundreds and a quiet one none. It is the EFFECTIVE spread and
 *   NOTHING ELSE.
 *
 * Folding a tbbo record's QUOTE into the quoted lane would re-weight that
 * statistic toward the moments people were trading, which is when spreads are
 * tightest: a number that looks like a quoted spread, sits in a column named
 * for one, is biased low, and carries nothing in the row to say so.
 * `databento-spread-logic.test.ts` pins it with a golden fixture — a tbbo
 * stream must leave `quoteSampleCount` UNMOVED.
 *
 * ## THE TIMESTAMPS DIFFER AND IT IS EASY TO GET BACKWARDS
 *
 * On `bbo-1m`, `ts_recv` is the interval END, so one millisecond back puts a
 * 16:00:00.000 record in the session that closed rather than the one that
 * follows. On `tbbo` it is the EVENT stamp of one print and is used as-is —
 * shifting it would move a trade at a boundary into the previous session for
 * no reason.
 *
 * ## MEMORY: CELLS ARE FLUSHED WHEN THE SESSION ADVANCES
 *
 * A year of (listing, session) cells is ~125,000 reservoirs, which at a full
 * `bbo-1m` day (960 records, one a minute) is ~1 GB of live floats. So cells
 * are SUMMARISED and dropped as soon as the stream leaves their session, and
 * only the summaries (~150 bytes each) survive. Both real file shapes advance
 * monotonically through sessions — a symbol-year file is time-ordered for one
 * symbol, a day file holds one session — so at most one session's cells are
 * live at a time.
 *
 * A (listing, session) that is summarised TWICE means two files covered one
 * symbol-day, which cannot happen through the harvest's own uniqueness but
 * would silently halve a median if it did. `mergeSpreadSummary` counts it
 * rather than averaging two medians, which is not a thing that can be done
 * honestly.
 */

import { usMarketDateKey } from "../us-market-hours";
import {
  Reservoir,
  effectiveSpreadBps,
  percentile,
  quoteSample,
  seedForCell,
  todBucketFor,
} from "./databento-cost-model-logic";
import { numeric, numericRequired } from "./databento-lake-logic";
import { isTbboRow, type BboRow, type TbboRow } from "./databento-logic";

/** Which statistic a record may contribute to. NEVER both. */
export type SpreadLane = "quoted" | "effective";

export type SpreadRecordRejection =
  | "outside-session"
  | "unusable-quote"
  | "unusable-trade";

export interface SpreadSample {
  lane: SpreadLane;
  valueBps: number;
  /** The ET session date this record belongs to. */
  sessionDate: string;
}

/**
 * One parsed quote or trade record into a lane, a value and a session — or the
 * NAMED reason it contributes to nothing.
 *
 * The reasons are distinct because the operational answers are: a spike in
 * `outside-session` is a clock bug, and a spike in `unusable-quote` is a
 * crossed or locked book, which is a data-quality finding. A single "skipped"
 * total would make the two look the same.
 *
 * `kind` is passed EXPLICITLY rather than sniffed from the row, because
 * `TbboRow extends BboRow`: a bbo row is not structurally distinguishable from
 * a tbbo row that happens to lack a price, and deciding the lane from the shape
 * would put a tbbo record with an unreadable price into the QUOTED lane —
 * exactly the bias this module exists to prevent.
 */
export function spreadSampleFor(
  row: BboRow | TbboRow,
  kind: "bbo" | "tbbo",
): SpreadSample | { rejected: SpreadRecordRejection } {
  // See the header: the bbo stamp is an interval END, the tbbo stamp is an
  // event.
  const at = new Date(kind === "tbbo" ? row.tsMs : row.tsMs - 1);

  // The SAME session test the cost model applies, including early closes —
  // `todBucketFor` returns null before 04:00 and from the session's own close
  // + post window. A quote outside the session is a vendor artefact or a clock
  // bug, and either way it is not a cost anyone could pay.
  if (todBucketFor(at) === null) return { rejected: "outside-session" };
  const sessionDate = usMarketDateKey(at);

  if (kind === "tbbo") {
    if (!isTbboRow(row)) return { rejected: "unusable-trade" };
    const value = effectiveSpreadBps(row.price, row.bid, row.ask);
    if (value === null) return { rejected: "unusable-trade" };
    return { lane: "effective", valueBps: value, sessionDate };
  }

  const sample = quoteSample(row.bid, row.ask, row.bidSize, row.askSize);
  if ("rejected" in sample) return { rejected: "unusable-quote" };
  return { lane: "quoted", valueBps: sample.spreadBps, sessionDate };
}

/* ─────────────────────────────────────────────────────────────────────────
   Cells
   ──────────────────────────────────────────────────────────────────────── */

export interface SpreadDayCell {
  listingId: string;
  symbol: string;
  sessionDate: string;
  quoted: Reservoir;
  effective: Reservoir;
  /**
   * The archived object the LAST quoted sample came from.
   *
   * A row is folded from many files and `source_object_uri` is NOT NULL, so
   * it has to name one of them — the DDL says so in the column's own
   * description, and the full set is in the `partition_load` claim. It is the
   * QUOTED side's object deliberately: that is the one the stored median and
   * p90 came from, and a tbbo object would name a file that contributed
   * nothing to either.
   *
   * Empty until a quoted sample lands, and a cell with no quoted sample
   * produces no row at all.
   */
  quotedObjectUri: string;
}

export function spreadDayKey(listingId: string, sessionDate: string): string {
  return `${listingId}|${sessionDate}`;
}

export function newSpreadDayCell(
  listingId: string,
  symbol: string,
  sessionDate: string,
): SpreadDayCell {
  const base = seedForCell(spreadDayKey(listingId, sessionDate));
  // TWO DIFFERENT SEEDS from one key. Sharing one would make the effective
  // reservoir keep exactly the records the quoted one kept, so the row's two
  // statistics would be drawn from a single sub-sample rather than two
  // independent ones — and here they come from different FILES entirely, so
  // that would be a coincidence with no meaning at all.
  return {
    listingId,
    symbol,
    sessionDate,
    quoted: new Reservoir(base),
    effective: new Reservoir(base ^ 0x27d4eb2f),
    quotedObjectUri: "",
  };
}

export interface SpreadDaySummary {
  listingId: string;
  symbol: string;
  sessionDate: string;
  /** See `SpreadDayCell.quotedObjectUri`. */
  quotedObjectUri: string;
  medianSpreadBps: number;
  p90SpreadBps: number;
  quoteSampleCount: number;
  effectiveSpreadBps: number | null;
  effectiveSampleCount: number | null;
}

/**
 * A cell's summary, or `null` when it measured nothing that may be stored.
 *
 * A QUOTED SAMPLE IS REQUIRED. `tbbo-top50` is a strict subset of the bbo
 * baseline (verified 2026-09-07: 0 missing), so a cell holding trades and no
 * quotes means the bbo file for that session did not arrive — a gap to fix,
 * not a measurement. Writing it with NULL quoted columns would put that gap in
 * a table where it reads as "this listing has no spread", and the NOT NULL on
 * `median_spread_bps` in the DDL is the same rule expressed in the schema.
 *
 * `null` rather than a row of zeros for the same reason `summarizeCell` gives:
 * a zero-spread row reads as a free-to-trade listing and would make a backtest
 * of an illiquid name look like its best idea.
 */
export function summarizeSpreadDay(
  cell: SpreadDayCell,
): SpreadDaySummary | null {
  if (cell.quoted.count === 0) return null;
  return {
    listingId: cell.listingId,
    symbol: cell.symbol,
    sessionDate: cell.sessionDate,
    quotedObjectUri: cell.quotedObjectUri,
    medianSpreadBps: percentile(cell.quoted.values, 0.5),
    p90SpreadBps: percentile(cell.quoted.values, 0.9),
    quoteSampleCount: cell.quoted.count,
    effectiveSpreadBps:
      cell.effective.count > 0 ? percentile(cell.effective.values, 0.5) : null,
    effectiveSampleCount:
      cell.effective.count > 0 ? cell.effective.count : null,
  };
}

/**
 * Combine two summaries for ONE (listing, session), PER LANE.
 *
 * This is the join between the two passes: the bbo pass fills the quoted lane
 * and leaves `effectiveSampleCount` null, and the tbbo pass does the reverse.
 * Merging per LANE rather than taking one summary whole is what lets them meet
 * — and it is why a tbbo summary cannot move `quoteSampleCount`: it has none
 * to contribute, so the quoted half of the merge is a no-op by construction
 * rather than by a guard somebody could delete.
 *
 * `collision` counts the case that must not happen: BOTH sides carrying
 * samples in the same lane, which means two files covered one symbol-session.
 * The larger sample wins, because it is the more complete measurement — but
 * two medians cannot be averaged into a true median, so the number is reported
 * rather than smoothed.
 */
export interface SpreadMergeResult {
  summary: SpreadDaySummary;
  collisions: number;
}

export function mergeSpreadSummary(
  existing: SpreadDaySummary | undefined,
  incoming: SpreadDaySummary,
): SpreadMergeResult {
  if (existing === undefined) return { summary: incoming, collisions: 0 };
  if (
    existing.listingId !== incoming.listingId ||
    existing.sessionDate !== incoming.sessionDate
  ) {
    throw new Error(
      `mergeSpreadSummary: refusing to merge ${existing.listingId}@${existing.sessionDate} ` +
        `with ${incoming.listingId}@${incoming.sessionDate} — the caller keyed them wrongly`,
    );
  }

  let collisions = 0;
  const merged: SpreadDaySummary = { ...existing };

  if (incoming.quoteSampleCount > 0) {
    if (existing.quoteSampleCount > 0) {
      collisions++;
      if (incoming.quoteSampleCount > existing.quoteSampleCount) {
        merged.medianSpreadBps = incoming.medianSpreadBps;
        merged.p90SpreadBps = incoming.p90SpreadBps;
        merged.quoteSampleCount = incoming.quoteSampleCount;
        // The uri FOLLOWS the numbers. Keeping the loser's would name a file
        // that did not produce the stored median.
        merged.quotedObjectUri = incoming.quotedObjectUri;
      }
    } else {
      merged.medianSpreadBps = incoming.medianSpreadBps;
      merged.p90SpreadBps = incoming.p90SpreadBps;
      merged.quoteSampleCount = incoming.quoteSampleCount;
      merged.quotedObjectUri = incoming.quotedObjectUri;
    }
  }

  const incomingEffective = incoming.effectiveSampleCount ?? 0;
  const existingEffective = existing.effectiveSampleCount ?? 0;
  if (incomingEffective > 0) {
    if (existingEffective > 0) {
      collisions++;
      if (incomingEffective > existingEffective) {
        merged.effectiveSpreadBps = incoming.effectiveSpreadBps;
        merged.effectiveSampleCount = incoming.effectiveSampleCount;
      }
    } else {
      merged.effectiveSpreadBps = incoming.effectiveSpreadBps;
      merged.effectiveSampleCount = incoming.effectiveSampleCount;
    }
  }

  // The SYMBOL follows whichever side is authoritative for the quoted lane;
  // both passes resolve through the same symbology, so a disagreement would be
  // a listing-id collision rather than a naming difference.
  return { summary: merged, collisions };
}

/* ─────────────────────────────────────────────────────────────────────────
   The row
   ──────────────────────────────────────────────────────────────────────── */

export interface SpreadCostRow {
  market: string;
  listing_id: string;
  symbol: string;
  session_date: string;
  median_spread_bps: number;
  p90_spread_bps: number;
  quote_sample_count: string;
  effective_spread_bps: number | null;
  effective_sample_count: string | null;
  source: string;
  source_object_uri: string;
  source_record_key: string;
  parser_version: string;
  pipeline_run_id: string;
  observed_at: string;
  ingested_at: string;
}

export function toSpreadCostRow(
  summary: SpreadDaySummary,
  ctx: {
    market: string;
    source: string;
    parserVersion: string;
    pipelineRunId: string;
    observedAtMs: number;
    ingestedAtMs: number;
  },
): SpreadCostRow {
  return {
    market: ctx.market,
    listing_id: summary.listingId,
    symbol: summary.symbol,
    session_date: summary.sessionDate,
    median_spread_bps: numericRequired(summary.medianSpreadBps),
    p90_spread_bps: numericRequired(summary.p90SpreadBps),
    // INT64 over the JSON load path is a decimal string. See
    // `toTradeBarRow` — a JS number loses precision above 2^53 and a bigint
    // throws inside JSON.stringify.
    quote_sample_count: String(summary.quoteSampleCount),
    effective_spread_bps: numeric(summary.effectiveSpreadBps),
    effective_sample_count:
      summary.effectiveSampleCount === null
        ? null
        : String(summary.effectiveSampleCount),
    source: ctx.source,
    source_object_uri: summary.quotedObjectUri,
    source_record_key: spreadDayKey(summary.listingId, summary.sessionDate),
    parser_version: ctx.parserVersion,
    pipeline_run_id: ctx.pipelineRunId,
    observed_at: new Date(ctx.observedAtMs).toISOString(),
    ingested_at: new Date(ctx.ingestedAtMs).toISOString(),
  };
}
