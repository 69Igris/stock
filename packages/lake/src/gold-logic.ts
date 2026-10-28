/**
 * Turning a BigQuery row into something the tile builder can use.
 * MONEY-1506 (data-platform B4).
 *
 * PURE — no BigQuery, no environment, no clock. `gold.ts` is the I/O shell, per
 * the run protocol's `<name>-logic.ts` + `<name>.ts` split, and this half exists
 * because the decisions below are the ones that fail SILENTLY:
 *
 *   - a NUMERIC arrives as a STRING and `Number(undefined)` is `NaN`, which
 *     renders as a blank chart rather than an error;
 *   - a DATE arrives as `{ value }` and `String({})` is `"[object Object]"`,
 *     which becomes an `Invalid Date` and a bar filed under no year at all;
 *   - a NULL `actions_fingerprint` defaulted to `undefined` makes
 *     `rebuildReason` SKIP the fingerprint comparison, silently reverting the
 *     one mechanism that rebuilds a US listing's closed-year tiles after a
 *     split.
 */

/** Shape BigQuery actually hands back for a DATE column. */
export interface BqDate {
  value: string;
}

/**
 * `YYYY-MM-DD` from a BigQuery DATE, or `""` when the cell is not one.
 *
 * `""` rather than a throw, and rather than `String(v)`: the caller turns this
 * into a `Date`, and `new Date("")` is `Invalid Date` — a value every
 * downstream `Number.isFinite` guard in this repo already rejects. The
 * alternative, `"[object Object]"`, parses to `Invalid Date` too but reads in a
 * log as though a date had been supplied.
 */
export function bqDay(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "value" in v) {
    const inner = (v as { value: unknown }).value;
    return typeof inner === "string" ? inner : "";
  }
  return "";
}

/**
 * A BigQuery NUMERIC / INT64 as a JS number.
 *
 * NUMERIC arrives as a STRING (or a `Big`) precisely because it does not fit a
 * double. Coercing here is correct and is the last place it happens: every
 * consumer of these bars — `buildTilesFromBars`, the tile encoder, the chart —
 * works in doubles already.
 */
export function bqNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return Number.NaN;
  return Number(String(v));
}

export interface GoldTileListing {
  listingId: string;
  symbol: string;
  exchange: string;
  /** Newest session in the lake, `YYYY-MM-DD`. The builder's source max. */
  lastSession: string;
  /**
   * Digest of every adjustment-bearing row. `"none"` when the listing has
   * none — the same literal `fingerprintActions([])` returns, so the two sides
   * compare without a translation step.
   */
  actionsFingerprint: string;
}

export interface GoldTileListingRow {
  listing_id?: unknown;
  symbol?: unknown;
  exchange?: unknown;
  last_session?: unknown;
  actions_fingerprint?: unknown;
}

export function toTileListing(row: GoldTileListingRow): GoldTileListing {
  return {
    listingId: typeof row.listing_id === "string" ? row.listing_id : "",
    symbol: typeof row.symbol === "string" ? row.symbol : "",
    exchange: typeof row.exchange === "string" ? row.exchange : "",
    lastSession: bqDay(row.last_session),
    // NAMED, never absent. `undefined` here would make `rebuildReason` skip
    // the fingerprint comparison entirely — a US listing's closed-year tiles
    // would then survive a split for ever, and the chart would step at the
    // five-year boundary with nothing reporting it.
    actionsFingerprint:
      typeof row.actions_fingerprint === "string" && row.actions_fingerprint
        ? row.actions_fingerprint
        : "none",
  };
}

export interface GoldAdjustedBar {
  listingId: string;
  /** `YYYY-MM-DD`, the VENUE's session day. */
  sessionDate: string;
  adjOpen: number;
  adjHigh: number;
  adjLow: number;
  adjClose: number;
  adjVolume: number;
  source: string;
}

export interface GoldAdjustedBarRow {
  listing_id?: unknown;
  session_date?: unknown;
  adj_open?: unknown;
  adj_high?: unknown;
  adj_low?: unknown;
  adj_close?: unknown;
  adj_volume?: unknown;
  source?: unknown;
}

/**
 * The `adj_*` columns, kept under `adj*` names.
 *
 * `adjusted_bar_d1` carries the RAW OHLC beside the adjusted OHLC, and handing
 * an `adj_close` back as `close` is how a caller ends up adjusting twice —
 * which halves a decade of prices and still looks like a chart. The rename
 * happens at the call site, in sight of its own comment about not
 * re-adjusting.
 */
export function toAdjustedBar(row: GoldAdjustedBarRow): GoldAdjustedBar {
  return {
    listingId: typeof row.listing_id === "string" ? row.listing_id : "",
    sessionDate: bqDay(row.session_date),
    adjOpen: bqNum(row.adj_open),
    adjHigh: bqNum(row.adj_high),
    adjLow: bqNum(row.adj_low),
    adjClose: bqNum(row.adj_close),
    adjVolume: bqNum(row.adj_volume),
    // A NAMED value, never absent: `undefined` would reach the tile's parallel
    // `sources` array, and "we do not know" is a different statement from any
    // vendor's name. `normaliseSource` maps anything unrecognised to
    // "UNKNOWN" anyway; stating it here means the row itself never carries a
    // hole.
    source:
      typeof row.source === "string" && row.source ? row.source : "UNKNOWN",
  };
}
