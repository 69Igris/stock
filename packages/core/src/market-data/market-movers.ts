/**
 * Exchange-published top movers + live index snapshot — MONEY-1198.
 *
 * ## The bug this exists to end
 *
 * Discover's "Top movers — today" panel showed LAPL at ₹128.29 +36.48% while
 * the stock's own detail page showed ₹121.88 −5.00% with PREV CLOSE ₹128.29.
 * ₹128.29 was YESTERDAY's close: the panel ranked the previous session and
 * labelled it "today". `fetchTopMovers` ranks `latest_quotes` with NO freshness
 * predicate, and nothing bulk-refreshes that table intraday (price-sync runs
 * 23:00 IST), so the panel was a day stale by construction.
 *
 * The fix is not a better ranking query. NSE and BSE PUBLISH THEIR OWN top
 * gainers and losers; we were deriving ours from per-symbol quotes instead of
 * ingesting theirs. This module is the PURE half of ingesting the exchange's
 * own list — payload → rows. All I/O (the fetch, the archive, the upsert) lives
 * in the worker, so every decision below is unit-testable without a network or
 * a database. Same split as `institutional-flows.ts` and `stock-flags.ts`.
 *
 * ## THIS FEED CANNOT BE BACKFILLED
 *
 * `/api/live-analysis-variations` and `/api/allIndices` take NO date parameter.
 * They serve the CURRENT snapshot and nothing else — there is no window to
 * walk, no `from_date`/`to_date`, and no archive page to re-scrape. A snapshot
 * we do not fetch is a snapshot that never enters the record. Exactly the
 * property that makes `surveillance-sync` and `institutional-flow-sync` daily
 * and prod-only, and it means THE SCHEDULE IS THE ONLY THING THAT ACCRUES
 * HISTORY — the parser is not the part of this feature carrying the risk.
 *
 * ## The payload timestamp is the ONLY authority on the session
 *
 * Every bucket carries its own `timestamp` and `/api/allIndices` carries one at
 * the top level. That string — never `Date.now()`, never the fetch time — is
 * what {@link parseNseSnapshotTimestamp} converts and what the worker stores.
 * Stamping rows with the fetch time is PRECISELY the wrong-granularity mistake
 * that produced this ticket: a row written at 11:53 carrying yesterday's prices
 * is indistinguishable from a fresh one unless the SESSION is recorded, and
 * "the panel is stale" is exactly the question the stored time has to answer.
 *
 * ## Poll safety
 *
 * One whole-market request returns EVERY bucket (NIFTY, BANKNIFTY, NIFTYNEXT50,
 * SecGtr20, SecLwr20, FOSec and market-wide allSec) in ~35 KB. There is no
 * per-symbol fan-out anywhere in this feature, which is the dimension our
 * actual blocking incidents scaled with (the Screener 429 wall, MCX's 403,
 * NCDEX's JS challenge — all per-symbol walks). {@link shouldWriteSnapshot} is
 * the other half: when the payload's own timestamp has not advanced, the poll
 * is recorded as a no-change and NOTHING is rewritten, so an unchanged minute
 * never manufactures a fresh-looking write time.
 */

import { z } from "zod";

/** Provenance tag stored on every row. */
export const MARKET_MOVER_SOURCES = {
  /** NSE `/api/live-analysis-variations` — the exchange's own ranked lists. */
  nseVariations: "NSE_LIVE_VARIATIONS",
  /** NSE `/api/allIndices` — live whole-market index snapshot. */
  nseAllIndices: "NSE_ALL_INDICES",
} as const;

/**
 * Which of NSE's two published lists a row came from.
 *
 * This is taken from WHICH ENDPOINT SERVED IT, never from the sign of a percent
 * field, and the distinction is load-bearing rather than pedantic — see the
 * `net_price` note on {@link MarketMoverRow.adjPercentChange}. NSE ranks by a
 * corporate-action-adjusted percentage it does not publish the base for, so a
 * row in the GAINERS list can carry a NEGATIVE raw `perChange` (measured:
 * FEDERALBNK, 14-Aug-2026, perChange −0.01 while NSE listed it as a gainer).
 * Re-deriving direction from a sign test would silently move that row to the
 * losers list and disagree with nseindia.com on our own Discover panel.
 */
export type MoverDirection = "GAINERS" | "LOSERS";

/**
 * NSE's query value for each direction.
 *
 * *** NSE SPELLS THE LOSERS PARAMETER "loosers". ***
 *
 * This is not a typo to tidy up on the way past. Verified from our own egress
 * on 2026-08-14:
 *
 *   index=loosers -> HTTP 200, 37,583 bytes, seven populated buckets
 *   index=losers  -> HTTP 200, 32 bytes, `{"data":"Missing index or key."}`
 *
 * The correct spelling of English is an HTTP **200**, not a 404. A parser
 * reaching for `payload.NIFTY.data` on that body finds nothing, returns zero
 * rows, and reads exactly like a market where nothing fell — the silent-no-op
 * failure shape this codebase keeps re-learning. {@link parseNseMovers} rejects
 * that body explicitly (`data` is a STRING, not an array) rather than letting
 * it degrade to an empty result.
 */
export const NSE_MOVER_INDEX_PARAM: Readonly<Record<MoverDirection, string>> = {
  GAINERS: "gainers",
  // Sic. See above — "losers" is a 200 with an error body.
  LOSERS: "loosers",
};

/** Path for one direction. Built here so the worker and the archive agree. */
export function nseMoversPath(direction: MoverDirection): string {
  return `/api/live-analysis-variations?index=${NSE_MOVER_INDEX_PARAM[direction]}`;
}

/** NSE's live whole-market index snapshot. */
export const NSE_ALL_INDICES_PATH = "/api/allIndices";

/**
 * The seven buckets NSE publishes per direction, verbatim as payload keys.
 *
 * `legends` is NOT one of them — it is a `[code, label][]` lookup table sitting
 * at the same level, and a parser that treats every top-level object as a
 * bucket would try to read `.data` off an array. Whitelisting the seven is what
 * keeps `legends` (and anything NSE adds later) out of the row set.
 */
export const NSE_MOVER_BUCKETS = [
  "NIFTY",
  "BANKNIFTY",
  "NIFTYNEXT50",
  "SecGtr20",
  "SecLwr20",
  "FOSec",
  "allSec",
] as const;

export type NseMoverBucket = (typeof NSE_MOVER_BUCKETS)[number];

/** One parsed mover row — the worker's write unit. */
export interface MarketMoverRow {
  /**
   * The instant the EXCHANGE says this snapshot describes, from the bucket's
   * own `timestamp`. Never the fetch time.
   */
  snapshotAt: Date;
  /** UTC midnight of the IST session day `snapshotAt` falls in. */
  date: Date;
  exchange: "NSE" | "BSE";
  direction: MoverDirection;
  /** Which of NSE's lists this row sat in — part of the identity, see below. */
  bucket: string;
  symbol: string;
  /** EQ | BE | … NSE's series letter; absent on BSE. */
  series: string | null;
  /** Position within the bucket AS SERVED. NSE's own ranking, preserved. */
  rank: number;
  open: number | null;
  high: number | null;
  low: number | null;
  /** Last traded price. */
  ltp: number;
  /** Previous close, UNADJUSTED for a corporate action going ex today. */
  prevClose: number;
  /**
   * NSE's `perChange` — the RAW percent move against `prevClose`.
   *
   * This is the field that reconciles with `(ltp − prevClose) / prevClose`, and
   * it is NOT the field NSE ranks by.
   */
  percentChange: number;
  /**
   * NSE's `net_price` — a CORPORATE-ACTION-ADJUSTED percent change, and the
   * field NSE actually ranks its lists by.
   *
   * ## The trap
   *
   * The name says "net PRICE", so it reads as a rupee delta. It is not: on
   * 14-Aug-2026 BHARTIARTL had ltp 1999.9 against prev 1939.1 — a ₹60.80 move —
   * and `net_price` was **3.14**, the percentage. Treating it as rupees is
   * wrong by a factor of ~20 and looks plausible on every row.
   *
   * ## Why both are stored
   *
   * They usually agree, so it is tempting to keep one. They disagree on exactly
   * the rows where it matters — the ones going ex-dividend/ex-split TODAY,
   * where `prevClose` is the unadjusted close and NSE re-bases against a figure
   * it does not publish. Measured on the committed fixture:
   *
   *   APOLLOHOSP  prev 8600.00, ltp 8854.50, ex-div ₹10 today
   *               perChange 2.96  net_price 3.08  (base 8590 = 8600 − 10)
   *   HAL         prev 4945.00, ltp 4963.60, ex-div ₹10 today
   *               perChange 0.38  net_price 0.58  (base 4935)
   *   FEDERALBNK  prev  352.45, ltp  352.40, ex-div ₹1.20 today
   *               perChange −0.01 net_price 0.33  (base 351.25)
   *
   * FEDERALBNK is the one that settles the argument: the two fields DISAGREE ON
   * SIGN, and NSE served that row in the GAINERS list. Keep only `perChange`
   * and our panel calls it a loser while nseindia.com calls it a gainer. Keep
   * only `net_price` and it can no longer be reconciled against ltp/prevClose
   * at all.
   *
   * ## And the ca_* fields do not tell you when to expect it
   *
   * TECHNOCRAF carried `ca_ex_dt: "-"` — no corporate action — with perChange
   * 46.70 against net_price 9.51 (a re-base to 284, its open). So "adjusted
   * only when ca_ex_dt is set" is FALSE, and a reader must not reconstruct one
   * field from the other under any condition. Both are stored verbatim.
   */
  adjPercentChange: number | null;
  /** `ltp − prevClose`, derived. Rupees — the thing `net_price` is not. */
  rupeeChange: number;
  tradedQty: number | null;
  /** NSE publishes this in ₹ LAKH on this endpoint. Stored unconverted. */
  turnover: number | null;
  /** Ex-date of a corporate action, or null. NSE's absent-sentinel is "-". */
  caExDate: string | null;
  caPurpose: string | null;
  source: string;
}

export interface MoverParseResult {
  rows: MarketMoverRow[];
  /** Rows dropped: unparseable prices, missing symbol, bad timestamp. */
  skipped: number;
  /** Distinct bucket timestamps seen, ISO. A healthy payload has one. */
  snapshots: string[];
  /**
   * Set when the payload is structurally not a movers response at all — the
   * misspelled-parameter error body, an HTML challenge page, a bare array.
   *
   * Distinct from `rows: []` ON PURPOSE. An empty list is a claim about the
   * market ("nothing moved"); a rejected payload is a claim about the fetch.
   * The worker must never let the second masquerade as the first.
   */
  rejected: string | null;
}

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

/** IST is UTC+05:30 with no DST, so the conversion is exact arithmetic. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Parse NSE's snapshot timestamp to the UTC instant it denotes.
 *
 * The string is IST wall-clock and comes in TWO precisions from the two
 * endpoints in this same job:
 *
 *   live-analysis-variations  "14-Aug-2026 11:53:54"   (seconds)
 *   allIndices                "14-Aug-2026 11:56"      (NO seconds)
 *
 * Both are real, both measured on 2026-08-14. A regex demanding `HH:MM:SS`
 * rejects every index snapshot; one demanding `HH:MM` truncates every movers
 * snapshot to the minute and makes {@link shouldWriteSnapshot} miss changes
 * inside it. Seconds are therefore OPTIONAL and default to 0.
 *
 * Returns null rather than guessing. A wrong instant here lands a session on
 * the wrong trading day — the exact class of error this ticket is about.
 */
export function parseNseSnapshotTimestamp(raw: unknown): Date | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const m =
    /^(\d{1,2})-([A-Za-z]{3,})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
      text,
    );
  if (!m) return null;

  const day = Number(m[1]);
  const month = MONTHS[m[2]!.slice(0, 3).toUpperCase()];
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);

  if (month === undefined) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  // The string is IST wall-clock, so the UTC instant is that clock reading
  // MINUS the offset. Building it as if it were UTC and storing it would shift
  // every snapshot 5h30 into the future.
  const utcWallClock = Date.UTC(year, month, day, hour, minute, second);
  // Rejects 31-Feb and friends — Date.UTC rolls them over silently, so the
  // round-trip is the only thing that catches an impossible calendar day.
  const probe = new Date(Date.UTC(year, month, day));
  if (probe.getUTCDate() !== day || probe.getUTCMonth() !== month) return null;

  return new Date(utcWallClock - IST_OFFSET_MS);
}

/**
 * UTC midnight of the IST calendar day an instant falls in.
 *
 * Derived from the SNAPSHOT, not from "now". Replaying an archived response
 * next month must file its rows under the day the bytes describe.
 */
export function istSessionDay(instant: Date): Date {
  const ist = new Date(instant.getTime() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
}

/**
 * Parse a numeric field to a FINITE number, or null.
 *
 * Null — never 0 — on anything unparseable. A 0 price is a claim that would
 * flow into a percent change as a division by zero or an infinite move; NaN
 * propagating through money is the recurring poison defect class here. BSE's
 * payload genuinely contains nulls (17 of 2,055 rows carried null openrate /
 * ltradert / prevdayclose on 2026-08-14), so this is live data, not paranoia.
 */
export function parseMoverNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const text = String(raw ?? "")
    .replace(/,/g, "")
    .trim();
  if (!text || text === "-") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an index VALUATION ratio (pe / pb / dy), mapping NSE's sentinel to null.
 *
 * *** NSE'S "NOT APPLICABLE" FOR THESE THREE IS THE STRING "0", NOT "-". ***
 *
 * Measured on the live 2026-08-14 response: 19 of 139 indices carry
 * `pe: "0", pb: "0", dy: "0"` — INDIA VIX (a volatility index, which cannot
 * have a P/E), the strategy and debt indices, and the sectoral sub-indices NSE
 * does not compute ratios for. They are NOT companies trading at zero earnings
 * multiple; the zero means "we don't publish this".
 *
 * This is why it cannot share {@link parseMoverNumber}. There, 0 is a perfectly
 * good value and must survive — `unchanged: "0"` genuinely means no
 * constituents were flat, and collapsing it to null would lose real breadth.
 * The sentinel is field-specific, so the handling has to be too: a generic
 * "0 means absent" rule corrupts the breadth counters, and a generic "0 is a
 * number" rule renders INDIA VIX with a P/E of 0.00 on the UI.
 */
export function parseIndexRatio(raw: unknown): number | null {
  const n = parseMoverNumber(raw);
  if (n === null) return null;
  // A zero P/E, P/B or dividend yield is not a valuation anyone can hold.
  return n === 0 ? null : n;
}

/**
 * NSE writes an absent corporate action as a literal "-", not as null or "".
 * Storing the dash would make every no-action row look like it had one.
 */
function parseCaField(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  if (!text || text === "-") return null;
  return text;
}

const RawMoverRowSchema = z.object({
  symbol: z.string().optional(),
  series: z.string().optional(),
  open_price: z.union([z.string(), z.number()]).nullable().optional(),
  high_price: z.union([z.string(), z.number()]).nullable().optional(),
  low_price: z.union([z.string(), z.number()]).nullable().optional(),
  ltp: z.union([z.string(), z.number()]).nullable().optional(),
  prev_price: z.union([z.string(), z.number()]).nullable().optional(),
  net_price: z.union([z.string(), z.number()]).nullable().optional(),
  perChange: z.union([z.string(), z.number()]).nullable().optional(),
  trade_quantity: z.union([z.string(), z.number()]).nullable().optional(),
  turnover: z.union([z.string(), z.number()]).nullable().optional(),
  ca_ex_dt: z.string().nullable().optional(),
  ca_purpose: z.string().nullable().optional(),
});

/** A bucket is `{ data: [...], timestamp: "…" }`. Anything else is not one. */
const BucketSchema = z.object({
  data: z.array(z.unknown()),
  timestamp: z.string().optional(),
});

/**
 * Parse `/api/live-analysis-variations` into mover rows.
 *
 * `direction` comes from the CALLER (which endpoint it fetched), never from the
 * payload — the payload does not say, and the sign of a percent field is not a
 * substitute for knowing.
 */
export function parseNseMovers(
  payload: unknown,
  direction: MoverDirection,
): MoverParseResult {
  const rows: MarketMoverRow[] = [];
  const snapshots = new Set<string>();
  let skipped = 0;

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return {
      rows: [],
      skipped: 0,
      snapshots: [],
      rejected: "payload is not an object",
    };
  }

  const obj = payload as Record<string, unknown>;

  // The misspelled-parameter body: `{"data":"Missing index or key."}` served
  // with HTTP 200. Named explicitly so the failure is loud rather than an
  // empty market. See NSE_MOVER_INDEX_PARAM.
  if (typeof obj.data === "string") {
    return {
      rows: [],
      skipped: 0,
      snapshots: [],
      rejected: `NSE error body: ${obj.data}`,
    };
  }

  // A response carrying not one recognised bucket is a shape change or a
  // challenge page, not a quiet market.
  const present = NSE_MOVER_BUCKETS.filter((b) => b in obj);
  if (present.length === 0) {
    return {
      rows: [],
      skipped: 0,
      snapshots: [],
      rejected: "no recognised buckets in payload",
    };
  }

  for (const bucket of present) {
    const parsedBucket = BucketSchema.safeParse(obj[bucket]);
    if (!parsedBucket.success) {
      skipped++;
      continue;
    }

    // Per-bucket, because that is how NSE serves it. In practice all seven
    // agree to the second, but trusting one bucket's clock for another's rows
    // is the same class of assumption that produced this ticket.
    const snapshotAt = parseNseSnapshotTimestamp(parsedBucket.data.timestamp);
    if (snapshotAt === null) {
      // No usable session time means no way to say WHICH session these prices
      // belong to — the single question this feature exists to answer. The
      // rows are dropped rather than stamped with a guess.
      skipped += parsedBucket.data.data.length;
      continue;
    }
    snapshots.add(snapshotAt.toISOString());
    const date = istSessionDay(snapshotAt);

    let rank = 0;
    for (const candidate of parsedBucket.data.data) {
      const parsed = RawMoverRowSchema.safeParse(candidate);
      if (!parsed.success) {
        skipped++;
        continue;
      }
      const raw = parsed.data;

      const symbol = String(raw.symbol ?? "")
        .trim()
        .toUpperCase();
      const ltp = parseMoverNumber(raw.ltp);
      const prevClose = parseMoverNumber(raw.prev_price);
      const percentChange = parseMoverNumber(raw.perChange);

      // A mover with no symbol, no last price, no previous close or no percent
      // is not a mover. prevClose === 0 is excluded too: it is the denominator
      // of every percentage a reader will compute from these fields.
      if (
        !symbol ||
        ltp === null ||
        prevClose === null ||
        prevClose === 0 ||
        percentChange === null
      ) {
        skipped++;
        continue;
      }

      rank++;
      rows.push({
        snapshotAt,
        date,
        exchange: "NSE",
        direction,
        bucket,
        symbol,
        series: raw.series ? String(raw.series).trim().toUpperCase() : null,
        rank,
        open: parseMoverNumber(raw.open_price),
        high: parseMoverNumber(raw.high_price),
        low: parseMoverNumber(raw.low_price),
        ltp,
        prevClose,
        percentChange,
        // Stored verbatim and NEVER derived from percentChange — see the field
        // doc. The two are different quantities on a corporate-action day.
        adjPercentChange: parseMoverNumber(raw.net_price),
        rupeeChange: ltp - prevClose,
        tradedQty: parseMoverNumber(raw.trade_quantity),
        turnover: parseMoverNumber(raw.turnover),
        caExDate: parseCaField(raw.ca_ex_dt),
        caPurpose: parseCaField(raw.ca_purpose),
        source: MARKET_MOVER_SOURCES.nseVariations,
      });
    }
  }

  return {
    rows,
    skipped,
    snapshots: [...snapshots].sort(),
    rejected: null,
  };
}

// ── Live index snapshot ──────────────────────────────────────────────

/** One parsed index row from `/api/allIndices`. */
export interface IndexSnapshotRow {
  /** From the payload's own top-level `timestamp`. Never the fetch time. */
  snapshotAt: Date;
  date: Date;
  /** NSE's `indexSymbol`, e.g. "NIFTY 50". */
  indexSymbol: string;
  /** NSE's `index` display name. Usually equal to indexSymbol. */
  indexName: string;
  /** NSE's `key` grouping, e.g. "BROAD MARKET INDICES". */
  category: string | null;
  last: number;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  /** `variation` — the POINTS move. Unlike movers, this one really is points. */
  pointsChange: number | null;
  percentChange: number | null;
  yearHigh: number | null;
  yearLow: number | null;
  /**
   * Valuation ratios. NSE serves these as STRINGS ("20.59") and uses "0" — not
   * "-", not null — as its not-applicable sentinel. See {@link parseIndexRatio}.
   */
  pe: number | null;
  pb: number | null;
  dividendYield: number | null;
  /**
   * Constituent breadth WITHIN this index, served as strings.
   *
   * Null when NSE omits the field entirely, which it does for INDIA VIX and the
   * other non-constituent indices — the keys are simply ABSENT from those rows
   * rather than present-and-zero, so every reader of an index row must treat
   * the shape as ragged.
   */
  advances: number | null;
  declines: number | null;
  unchanged: number | null;
  source: string;
}

export interface IndexSnapshotParseResult {
  rows: IndexSnapshotRow[];
  skipped: number;
  snapshotAt: Date | null;
  /** Whole-market breadth from the payload's TOP level, not per index. */
  breadth: { advances: number; declines: number; unchanged: number } | null;
  rejected: string | null;
}

const RawIndexRowSchema = z.object({
  key: z.string().nullable().optional(),
  index: z.string().nullable().optional(),
  indexSymbol: z.string().nullable().optional(),
  last: z.union([z.string(), z.number()]).nullable().optional(),
  open: z.union([z.string(), z.number()]).nullable().optional(),
  high: z.union([z.string(), z.number()]).nullable().optional(),
  low: z.union([z.string(), z.number()]).nullable().optional(),
  previousClose: z.union([z.string(), z.number()]).nullable().optional(),
  variation: z.union([z.string(), z.number()]).nullable().optional(),
  percentChange: z.union([z.string(), z.number()]).nullable().optional(),
  yearHigh: z.union([z.string(), z.number()]).nullable().optional(),
  yearLow: z.union([z.string(), z.number()]).nullable().optional(),
  pe: z.union([z.string(), z.number()]).nullable().optional(),
  pb: z.union([z.string(), z.number()]).nullable().optional(),
  dy: z.union([z.string(), z.number()]).nullable().optional(),
  advances: z.union([z.string(), z.number()]).nullable().optional(),
  declines: z.union([z.string(), z.number()]).nullable().optional(),
  unchanged: z.union([z.string(), z.number()]).nullable().optional(),
});

/**
 * Parse `/api/allIndices` into index snapshot rows.
 *
 * Note the timestamp here has NO seconds ("14-Aug-2026 11:56") while the movers
 * endpoint's does — the two live in the same job and must share one parser, so
 * {@link parseNseSnapshotTimestamp} treats seconds as optional.
 *
 * `pe` / `pb` / `dy` / `advances` / `declines` / `unchanged` arrive as STRINGS
 * ("20.59", "36"), which is why they go through {@link parseMoverNumber} rather
 * than being read as numbers. NSE also serves "-" in the ratio fields for
 * indices that have none (VIX, sectoral sub-indices), and that dash must become
 * null, not 0 — a P/E of zero is a claim about valuation.
 */
export function parseNseAllIndices(payload: unknown): IndexSnapshotParseResult {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return {
      rows: [],
      skipped: 0,
      snapshotAt: null,
      breadth: null,
      rejected: "payload is not an object",
    };
  }

  const obj = payload as Record<string, unknown>;
  if (!Array.isArray(obj.data)) {
    return {
      rows: [],
      skipped: 0,
      snapshotAt: null,
      breadth: null,
      rejected: "payload has no data array",
    };
  }

  const snapshotAt = parseNseSnapshotTimestamp(obj.timestamp);
  if (snapshotAt === null) {
    // Same rule as the movers buckets: without the exchange's own session time
    // there is nothing to file these prices under.
    return {
      rows: [],
      skipped: obj.data.length,
      snapshotAt: null,
      breadth: null,
      rejected: "payload timestamp missing or unparseable",
    };
  }
  const date = istSessionDay(snapshotAt);

  const rows: IndexSnapshotRow[] = [];
  let skipped = 0;

  for (const candidate of obj.data) {
    const parsed = RawIndexRowSchema.safeParse(candidate);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const raw = parsed.data;

    const indexSymbol = String(raw.indexSymbol ?? raw.index ?? "").trim();
    const last = parseMoverNumber(raw.last);
    if (!indexSymbol || last === null) {
      skipped++;
      continue;
    }

    rows.push({
      snapshotAt,
      date,
      indexSymbol,
      indexName: String(raw.index ?? indexSymbol).trim(),
      category: raw.key ? String(raw.key).trim() : null,
      last,
      open: parseMoverNumber(raw.open),
      high: parseMoverNumber(raw.high),
      low: parseMoverNumber(raw.low),
      previousClose: parseMoverNumber(raw.previousClose),
      pointsChange: parseMoverNumber(raw.variation),
      percentChange: parseMoverNumber(raw.percentChange),
      yearHigh: parseMoverNumber(raw.yearHigh),
      yearLow: parseMoverNumber(raw.yearLow),
      // Ratios use the sentinel-aware parser: "0" means NSE does not publish
      // one. The breadth counters below deliberately do NOT — a 0 there is a
      // real count.
      pe: parseIndexRatio(raw.pe),
      pb: parseIndexRatio(raw.pb),
      dividendYield: parseIndexRatio(raw.dy),
      advances: parseMoverNumber(raw.advances),
      declines: parseMoverNumber(raw.declines),
      unchanged: parseMoverNumber(raw.unchanged),
      source: MARKET_MOVER_SOURCES.nseAllIndices,
    });
  }

  const a = parseMoverNumber(obj.advances);
  const d = parseMoverNumber(obj.declines);
  const u = parseMoverNumber(obj.unchanged);

  return {
    rows,
    skipped,
    snapshotAt,
    breadth:
      a !== null && d !== null && u !== null
        ? { advances: a, declines: d, unchanged: u }
        : null,
    rejected: null,
  };
}

// ── Poll economics ───────────────────────────────────────────────────

/**
 * Should this poll be written, given what we already stored?
 *
 * The endpoints supply NO cache validators — verified 2026-08-14, the responses
 * carry no `ETag`, no `Last-Modified` and no `Cache-Control`, only Akamai's
 * `server-timing: cdn-cache` — so a conditional request cannot be made and a
 * 304 is not available to us. The payload's own `timestamp` is therefore the
 * only change detector there is.
 *
 * Returns false when the snapshot has not advanced. Rewriting identical rows
 * would refresh `updatedAt` and hand every reader a row that LOOKS freshly
 * confirmed while describing an older session — a smaller version of exactly
 * the bug this module exists to end. It also makes the no-change case free.
 *
 * A snapshot that goes BACKWARDS is refused too. That is a real case, not a
 * hypothetical: NSE sits behind Akamai and an edge node can serve a slightly
 * older cached body than the one we just saw, so "not equal" is not the test.
 */
export function shouldWriteSnapshot(
  incoming: Date,
  lastStored: Date | null,
): boolean {
  if (lastStored === null) return true;
  return incoming.getTime() > lastStored.getTime();
}

/**
 * Should this poll fire? — MONEY-1200.
 *
 * ## Two wrong models, corrected in order
 *
 * FIRST the job gated on `getNseMarketStatus().isLive` — true only in the OPEN
 * phase — justified by "outside the session the data cannot change, so a poll is
 * pure risk for no information." Measured false: at 16:26 IST the gainers
 * payload carried `timestamp "14-Aug-2026 16:00:00"`, thirty minutes past the
 * close, with real closing prices.
 *
 * SECOND it gated on a 60-minute post-close SETTLE WINDOW. Also wrong, and
 * wrong in a more interesting way: probed again at 17:41 IST — over two hours
 * after the close — NSE returned BYTE-IDENTICAL bytes (32,672 for movers,
 * timestamp still 16:00:00; 113,908 for indices, still 15:30). The payload is
 * frozen at the settled close and served that way until the next session opens.
 *
 * So there is no window to catch. The question was never "when does the data
 * change" but "do we already hold the latest snapshot" — and
 * {@link shouldWriteSnapshot} answers that from the payload's own timestamp.
 * Reasoning about the clock was solving a problem that does not exist while
 * creating one that does: a scheduler provisioned after 15:30 (which is what
 * happened) captured nothing at all, for an entire weekend.
 *
 * ## What this now refuses, and why only that
 *
 * WEEKEND and HOLIDAY only. Those are the phases where a poll cannot inform us:
 * whatever NSE is serving, we have had every prior opportunity to capture it,
 * and the next session has not begun. Everything else on a weekday polls —
 * including PRE_OPEN, deliberately, because NSE is still serving the PREVIOUS
 * session's close then, so the morning poll is the catch-up that recovers a
 * close we missed.
 *
 * ## Why this is cheap despite polling more
 *
 * `shouldWriteSnapshot` refuses to write unless the payload timestamp STRICTLY
 * advances, so every poll after the first capture is a no-op. The cost is a
 * handful of requests against one whole-market endpoint with no per-symbol
 * fan-out — the axis every throttling incident here has actually scaled with.
 *
 * `getNseMarketStatus` is deliberately NOT modified: it is shared, `isLive`
 * correctly means "the session is open", and other callers rely on that. This is
 * a movers-specific policy layered on top of it.
 */
export function shouldPollMovers(
  status: { phase: string; isLive: boolean },
  _now: Date = new Date(),
): { poll: boolean; reason: string } {
  // A weekday is pollable in EVERY phase, including PRE_OPEN.
  //
  // PRE_OPEN is not an oversight: NSE is still serving the PREVIOUS session's
  // close then, so the morning poll is the catch-up that recovers a close we
  // missed — which is exactly the hole that left both tables empty across a
  // weekend when the scheduler went up after 15:30.
  if (status.phase === "WEEKEND" || status.phase === "HOLIDAY") {
    return { poll: false, reason: status.phase };
  }
  return { poll: true, reason: status.isLive ? "OPEN" : status.phase };
}

/**
 * Collapse a mover list to one row per COMPANY for display.
 *
 * A company can list on both NSE and BSE and appear in both exchanges' movers,
 * so a naive concatenation shows it twice with two different prices. ISIN is
 * the durable identity on `InstrumentMapping` — a symbol can be reassigned to a
 * different company after a rename (MONEY-1177) — so ISIN is preferred and the
 * `exchange:symbol` pair is the fallback for rows we could not resolve.
 *
 * ## NSE's movers payload carries NO ISIN
 *
 * Its fourteen fields are symbol, series, the four prices, net_price,
 * trade_quantity, turnover, market_type, the two ca_* fields and perChange —
 * checked against the live response, not assumed. So `isinBySymbol` has to come
 * from OUR `InstrumentMapping`, resolved by the worker; this function only
 * consumes the resolution. That is why the seam is a lookup argument rather
 * than a field read.
 *
 * Preference on a collision is by ABSOLUTE percent move: the exchange that
 * printed the bigger move is the one whose listing is actually trading, and for
 * a dual listing the thinner venue routinely shows a stale or wider print.
 * Ties break on exchange name so the choice is deterministic.
 */
export function dedupeMoversByCompany(
  rows: readonly MarketMoverRow[],
  isinBySymbol: ReadonlyMap<string, string>,
): MarketMoverRow[] {
  const best = new Map<string, MarketMoverRow>();
  for (const row of rows) {
    const isin = isinBySymbol.get(`${row.exchange}:${row.symbol}`);
    const key = isin ?? `${row.exchange}:${row.symbol}`;
    const held = best.get(key);
    if (held === undefined) {
      best.set(key, row);
      continue;
    }
    const a = Math.abs(row.percentChange);
    const b = Math.abs(held.percentChange);
    if (a > b || (a === b && row.exchange < held.exchange)) best.set(key, row);
  }
  return [...best.values()];
}
