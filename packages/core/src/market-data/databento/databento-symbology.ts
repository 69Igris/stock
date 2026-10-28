/**
 * (raw_symbol, date) → `listingId` — MONEY-1373.
 *
 * PURE. The Prisma read that produces the rows lives in the caller; this module
 * takes plain objects, so its test needs no database and the rule it encodes can
 * be exercised exhaustively.
 *
 * ## The defect this exists to prevent, from the other side
 *
 * MONEY-980 finding 2: A TICKER IS NOT A SECURITY. Tiingo's master holds two
 * rows for `DOW` on NYSE — Dow Chemical (1972-2017) and Dow Inc. (2019-) —
 * identical in exchange, assetType and currency, differing only by window. That
 * is why every `Candle` carries a `listingId` and why a full-range read must
 * never concatenate two companies.
 *
 * The Tiingo backbone met that problem from the LIVE side: it asks the vendor
 * for a ticker and gets whichever company occupies it today. Databento hands us
 * the opposite problem — a file of HISTORICAL bars whose rows carry a raw symbol
 * and a timestamp, and it is our job to decide which security each row belongs
 * to. A row from 2015 under `DOW` is Dow Chemical; the same ticker in a 2024
 * file is Dow Inc.; and nothing in the row says so.
 *
 * ## Ambiguity QUARANTINES, it never guesses
 *
 * A date that resolves to zero listings, or to two that are genuinely different
 * securities, produces a counted quarantine row and no bar. That is deliberate
 * and it is the expensive-looking choice: a quarantined symbol is visible in the
 * job outcome and can be fixed by extending the master, while a guessed
 * `listingId` files a bar under another company and is indistinguishable from a
 * correct one forever after. `CandleRepository.resolveCurrentListingId` makes
 * the same call — it returns null rather than taking the first of two.
 */

import { usMarketDayBoundsUtc } from "../us-market-hours";

/** One occupancy window, as `us_instruments` records it. */
export interface ListingRow {
  symbol: string;
  exchange: string;
  listingId: string;
  listingStartDate: Date | null;
  listingEndDate: Date | null;
  listingStatus: string;
}

export interface ResolvedListing {
  listingId: string;
  exchange: string;
  listingStatus: string;
}

export type QuarantineReason = "none" | "ambiguous";

export type ListingResolution =
  | { ok: true; listing: ResolvedListing; multiVenue: boolean }
  | { ok: false; reason: QuarantineReason; candidates: number };

/**
 * Which venue wins when one security lists on several.
 *
 * A dual-venue listing is ONE company with one `listingStartDate` on two
 * boards, and a bar from a CONSOLIDATED feed belongs to neither venue
 * specifically — the trade could have printed on either. So a stable choice is
 * needed and any stable choice is defensible; primary-listing venues come
 * first so the exchange stamped on the row is the one a reader expects.
 *
 * `candle-sink.ts` makes the same call for the realtime path and states it the
 * same way ("first wins, deterministically ... both are the same company").
 * Here the order is EXPLICIT rather than left to a query's natural order,
 * because the two writers must agree: a session written by Databento under
 * NASDAQ and refreshed by the realtime sink under BATS would look like two
 * sources to a reader that groups by exchange.
 */
export const US_EXCHANGE_PRIORITY: readonly string[] = [
  "NASDAQ",
  "NYSE",
  "NYSE ARCA",
  "AMEX",
  "NYSE MKT",
  "NYSE NAT",
  "BATS",
];

function venueRank(exchange: string): number {
  const i = US_EXCHANGE_PRIORITY.indexOf(exchange);
  return i === -1 ? US_EXCHANGE_PRIORITY.length : i;
}

/** Group the master rows by symbol. */
export function buildListingIndex(
  rows: readonly ListingRow[],
): Map<string, ListingRow[]> {
  const out = new Map<string, ListingRow[]>();
  for (const row of rows) {
    const key = row.symbol.trim().toUpperCase();
    const bucket = out.get(key);
    if (bucket) bucket.push(row);
    else out.set(key, [row]);
  }
  return out;
}

/**
 * Does `at` fall inside this window?
 *
 * The start bound is INCLUSIVE and the end bound is inclusive TO THE END OF
 * THAT DAY: `listingEndDate` is the last date the security traded, and a bar
 * stamped 15:59 on that date belongs to it. Comparing against the raw date
 * would exclude every bar of a listing's final session — which is exactly the
 * session a delisting makes interesting.
 *
 * An absent bound is open: a listing with no start date has always existed as
 * far as we know, and one with no end date is still trading.
 */
export function windowCoversDate(row: ListingRow, at: Date): boolean {
  const t = at.getTime();
  if (row.listingStartDate !== null) {
    // The ET SESSION START of the first day, not UTC midnight. Under EST the
    // pre-market of session D begins 04:00 ET = 09:00 UTC on D, so a UTC
    // comparison is correct here by luck rather than construction; making it
    // explicit keeps both bounds on one clock.
    const startMs = usMarketDayBoundsUtc(
      etDateKeyOf(row.listingStartDate),
    ).startMs;
    if (t < startMs) return false;
  }
  if (row.listingEndDate !== null) {
    // THE END OF THE ET SESSION, not the end of the UTC day.
    //
    // This was `Date.UTC(...getUTCDate() + 1)` — a UTC day-end — while every
    // session key in this branch is the ET session date. Under EST the
    // 19:00-19:59 ET hour of the final session lands on UTC D+1, so it fell
    // OUTSIDE the listing that traded it. Measured on the QA master over
    // listings ending in EST inside the harvest range: 768 sessions lost their
    // post-market hour to quarantine, and 48 had it stamped with a DIFFERENT
    // security's `listingId` — a successor whose `listingStartDate` is D+1.
    //
    // `BNY` on 2026-02-06 is the concrete one: bars from 19:00 ET were
    // attributed to `BNY:NYSE:1973-05-03` instead of `BNY:NYSE:2001-07-27`.
    // That is the DOW hazard the whole `listingId` design exists to prevent,
    // arriving through the one bound nobody converted.
    const endMs = usMarketDayBoundsUtc(etDateKeyOf(row.listingEndDate)).endMs;
    if (t >= endMs) return false;
  }
  return true;
}

/**
 * The ET calendar date a stored listing bound denotes.
 *
 * The master stores these at exact UTC midnight (verified across 24,332 rows),
 * so the UTC calendar parts ARE the intended date and reading them in ET would
 * shift every one back a day. This reads the parts, then hands them to the ET
 * calendar — which is what makes the bound a SESSION rather than an instant.
 */
function etDateKeyOf(at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Which security a bar at `at` belongs to.
 *
 * Three outcomes, and the third is the one that matters:
 *
 *   one window                one security. Resolved.
 *   several windows, same
 *   security on several
 *   venues                    resolved by {@link US_EXCHANGE_PRIORITY}, and
 *                             counted as `multiVenue` so a coverage report can
 *                             tell it apart from a clean single-venue hit.
 *   anything else             QUARANTINE. Zero windows means we have no row for
 *                             that security at that date; two windows that are
 *                             not one dual-listed security means the ticker was
 *                             recycled and the data cannot tell us which
 *                             occupant printed the bar.
 *
 * "Same security on several venues" is decided by an IDENTICAL
 * `listingStartDate`, not by proximity: two companies that happened to list in
 * the same week are still two companies, and a tolerance window here would
 * merge them silently.
 */
export function resolveListingForDate(
  windows: readonly ListingRow[] | undefined,
  at: Date,
): ListingResolution {
  if (windows === undefined || windows.length === 0) {
    return { ok: false, reason: "none", candidates: 0 };
  }
  let matches = windows.filter((w) => windowCoversDate(w, at));
  if (matches.length === 0) {
    return { ok: false, reason: "none", candidates: 0 };
  }
  // MONEY-1617 — a PHANTOM loses a tie, and only a tie. Where a longer window
  // also covers the session the phantom is dropped; a session ONLY the short
  // window covers still resolves to it (29 of prod's 80 are IPO start-date
  // restatements whose first days nothing else covers).
  if (matches.length > 1) {
    const real = matches.filter((w) => !isPhantomWindow(w, windows));
    if (real.length > 0) matches = real;
  }
  if (matches.length === 1) {
    const m = matches[0]!;
    return {
      ok: true,
      listing: {
        listingId: m.listingId,
        exchange: m.exchange,
        listingStatus: m.listingStatus,
      },
      multiVenue: false,
    };
  }

  const startKey = (w: ListingRow): string =>
    w.listingStartDate === null
      ? ""
      : w.listingStartDate.toISOString().slice(0, 10);
  const firstStart = startKey(matches[0]!);
  const sameSecurity =
    matches.every((w) => startKey(w) === firstStart) &&
    new Set(matches.map((w) => w.exchange)).size === matches.length;

  if (!sameSecurity) {
    // A recycled ticker with overlapping windows, or two rows on ONE venue.
    // Neither can be resolved from the data, and a guess here is a bar filed
    // under another company that nothing downstream can detect.
    return { ok: false, reason: "ambiguous", candidates: matches.length };
  }

  const chosen = [...matches].sort(
    (a, b) => venueRank(a.exchange) - venueRank(b.exchange),
  )[0]!;
  return {
    ok: true,
    listing: {
      listingId: chosen.listingId,
      exchange: chosen.exchange,
      listingStatus: chosen.listingStatus,
    },
    multiVenue: true,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Phantom windows and the writer clip — MONEY-1617
   ──────────────────────────────────────────────────────────────────────── */

/** A window this short that overlaps a longer one on its own venue is a phantom. */
export const PHANTOM_WINDOW_MAX_DAYS = 5;

const DAY_MS = 86_400_000;

function windowDays(w: ListingRow): number | null {
  if (w.listingStartDate === null || w.listingEndDate === null) return null;
  return Math.round(
    (w.listingEndDate.getTime() - w.listingStartDate.getTime()) / DAY_MS,
  );
}

/**
 * A master row of {@link PHANTOM_WINDOW_MAX_DAYS} days or less that overlaps a
 * LONGER window of the same symbol on the same venue.
 *
 * `GAB:NYSE:2026-09-21` is the measured case: a one-day row (created 09-22)
 * inside `GAB:NYSE:1987-11-05`, which took GAB's 09-21 bar. DERIVED from the
 * master on every call and never stored, so it cannot go stale: the day a
 * genuine new occupant's window grows past five days it stops being one.
 */
export function isPhantomWindow(
  w: ListingRow,
  siblings: readonly ListingRow[],
): boolean {
  const days = windowDays(w);
  if (days === null || days > PHANTOM_WINDOW_MAX_DAYS) return false;
  const start = w.listingStartDate!.getTime();
  const end = w.listingEndDate!.getTime();
  return siblings.some((o) => {
    if (o === w || o.listingId === w.listingId) return false;
    if (o.symbol !== w.symbol || o.exchange !== w.exchange) return false;
    const od = windowDays(o);
    if (od !== null && od <= PHANTOM_WINDOW_MAX_DAYS) return false;
    const oStart = o.listingStartDate?.getTime() ?? -Infinity;
    const oEnd = o.listingEndDate?.getTime() ?? Infinity;
    // The longer window must OUTLAST the short one: a new occupant of five
    // days or less that overlaps its predecessor's LAST day is a handover, not
    // a phantom, and must not be given back to the predecessor.
    return oStart <= end && oEnd >= start && oEnd >= end;
  });
}

/** Every phantom in a master, for the sync's report. */
export function findPhantomWindows(rows: readonly ListingRow[]): ListingRow[] {
  const byVenue = new Map<string, ListingRow[]>();
  for (const r of rows) {
    const k = `${r.symbol}\u0000${r.exchange}`;
    const b = byVenue.get(k);
    if (b) b.push(r);
    else byVenue.set(k, [r]);
  }
  const out: ListingRow[] = [];
  for (const group of byVenue.values()) {
    if (group.length < 2) continue;
    for (const w of group) if (isPhantomWindow(w, group)) out.push(w);
  }
  return out;
}

/** A master window, declared structurally so `packages/lake` can pass its own. */
export interface OccupancyWindowLike {
  listingId: string;
  listingStartDate: Date | null;
  listingEndDate: Date | null;
}

/**
 * The symbol's UNIQUE latest-ending window — its current occupant — or null.
 *
 * ## WHY "LATEST-ENDING" IS THE CURRENT OCCUPANT — MONEY-1616
 *
 * Tiingo dates a SECURITY's price history, not the time it has held a ticker.
 * Barrick's `B` row starts in 1985 (its history under ABX) and so overlaps
 * Barnes Group's `B` to 2025; the master holds 437 such overlapping pairs.
 * Tiingo also serves a ticker's CURRENT occupant only, so the one series the
 * store holds under `B` is Barrick's, and it is stamped with Barrick's id.
 * The occupant is the window that runs latest: measured 2026-09-24, 177,550
 * of the 196,569 AMBIGUOUS rows carry it, and 7 of 7 price-level spot checks
 * confirmed the label (B 2024 at $17.42 on 18.6M shares is Barrick).
 *
 * A TIE IS NULL, never a pick. Two windows ending together (two ACTIVE rows,
 * or WNS's two rows both ending 2025-10-16) say nothing about which one the
 * series belongs to. An open end is later than any date. A single window is
 * null too: one window is never ambiguous, so there is no question to answer.
 * An Invalid Date end is null rather than skipped — skipping it would make the
 * window beside it "unique" on no evidence.
 *
 * DELIBERATELY A SECOND COPY of `@usemoney/lake`'s `latestOccupantOf`
 * (`packages/lake/src/us-sink-logic.ts`): `packages/lake` must not import core
 * and core must not depend on lake, so the candle writer's clip (MONEY-1617)
 * and the lake gate each hold one. The agreement test
 * (`__tests__/market-data/latest-occupant-agreement.test.ts`) holds them
 * together — the `numeric()` / `istDateKey` arrangement.
 */
export function latestOccupantOf<W extends OccupancyWindowLike>(
  windows: readonly W[],
): W | null {
  if (windows.length < 2) return null;
  let best: W | null = null;
  let bestEnd = -Infinity;
  let tie = false;
  for (const w of windows) {
    const end =
      w.listingEndDate === null ? Infinity : w.listingEndDate.getTime();
    if (Number.isNaN(end)) return null;
    if (end > bestEnd) {
      best = w;
      bestEnd = end;
      tie = false;
    } else if (end === bestEnd) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/** Why a writer dropped a bar instead of filing it. NAMED, never a boolean. */
export type ClipDropReason = "OUTSIDE_EVERY_WINDOW" | "AMBIGUOUS_WINDOW";

export interface ClippedBar<B> {
  bar: B;
  listingId: string;
  listingStatus: string;
}

export interface ClipResult<B> {
  kept: ClippedBar<B>[];
  dropped: Record<ClipDropReason, number>;
}

/**
 * File each bar under the window that covers its session — MONEY-1617.
 *
 * Tiingo answers for a TICKER, so a response carries every session the ticker
 * ever printed; a writer that stamps them all with the listing it asked about
 * files a predecessor's (or a successor's) prices under the wrong identity.
 * `windows` is every master row of this symbol ON THIS VENUE; `fetched` is the
 * listing the request was made for and is added if absent, so a failed sibling
 * lookup degrades to "clip to the fetched window", never to "drop everything".
 *
 * Resolution is {@link resolveListingForDate} (so a phantom loses a tie). A bar
 * no window covers is dropped. Where several REAL windows cover a session, the
 * fetched listing keeps the bar only if it is ACTIVE (today's nightly
 * behaviour) or is the symbol's unique latest occupant
 * ({@link latestOccupantOf}, the lake gate's own rule). Otherwise it is
 * dropped: Tiingo serves only the CURRENT occupant, so a DELISTED fetch of `B`
 * (Barnes, to 2025) receives Barrick's series from 1985, and "the fetched one
 * keeps it" would file Barrick's prices under Barnes's id — the DOW hazard.
 * Both drops are counted.
 */
export function clipBarsToListingWindows<B extends { date: string }>(args: {
  bars: readonly B[];
  windows: readonly ListingRow[];
  fetched: ListingRow;
  /**
   * Every master window of the SYMBOL, all venues — the population the lake
   * gate names the occupant from. Defaults to `windows`.
   */
  symbolWindows?: readonly ListingRow[];
}): ClipResult<B> {
  // An ACTIVE listing is still trading: its master `endDate` is only the last
  // session the master file had seen, and the nightly fetches the session
  // after it whenever Tiingo's master lags its prices by a day. Clipping at
  // that date would drop the newest bar of EVERY listing on such a night.
  const open = (w: ListingRow): ListingRow =>
    w.listingStatus === "ACTIVE" ? { ...w, listingEndDate: null } : w;
  const fetched = open(args.fetched);
  const { bars } = args;
  const windows = [
    ...args.windows.filter((w) => w.listingId !== fetched.listingId).map(open),
    fetched,
  ];
  const fetchedIsPhantom = isPhantomWindow(fetched, windows);
  // RAW windows, as the lake reads them: an ACTIVE end is the master's last
  // date, not open, so this is `latestOccupantOf` exactly as the gate runs it.
  const occupantPool = args.symbolWindows ?? args.windows;
  const fetchedMayKeepTies =
    !fetchedIsPhantom &&
    (fetched.listingStatus === "ACTIVE" ||
      latestOccupantOf(
        occupantPool.some((w) => w.listingId === fetched.listingId)
          ? occupantPool
          : [...occupantPool, args.fetched],
      )?.listingId === fetched.listingId);
  const out: ClipResult<B> = {
    kept: [],
    dropped: { OUTSIDE_EVERY_WINDOW: 0, AMBIGUOUS_WINDOW: 0 },
  };
  for (const bar of bars) {
    let at: Date;
    try {
      at = new Date(usMarketDayBoundsUtc(bar.date).startMs);
    } catch {
      // A malformed date is not this function's to judge — the caller's own
      // date rule drops and counts it.
      out.kept.push({
        bar,
        listingId: fetched.listingId,
        listingStatus: fetched.listingStatus,
      });
      continue;
    }
    const r = resolveListingForDate(windows, at);
    if (r.ok) {
      out.kept.push({
        bar,
        listingId: r.listing.listingId,
        listingStatus: r.listing.listingStatus,
      });
    } else if (r.reason === "none") {
      out.dropped.OUTSIDE_EVERY_WINDOW++;
    } else if (fetchedMayKeepTies && windowCoversDate(fetched, at)) {
      out.kept.push({
        bar,
        listingId: fetched.listingId,
        listingStatus: fetched.listingStatus,
      });
    } else {
      out.dropped.AMBIGUOUS_WINDOW++;
    }
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────
   The ledger
   ──────────────────────────────────────────────────────────────────────── */

export interface QuarantineEntry {
  none: number;
  ambiguous: number;
  firstDate: string;
  lastDate: string;
}

export interface QuarantineSummary {
  quarantinedSymbols: number;
  quarantinedRows: number;
  /** The worst offenders, for the job-outcome line. */
  sample: Array<{
    symbol: string;
    reason: QuarantineReason;
    rows: number;
    firstDate: string;
    lastDate: string;
  }>;
}

/**
 * What could not be mapped, and over what span.
 *
 * A COUNT is not enough on its own. "417 rows quarantined" could be one dead
 * ticker across three years or every symbol on one day, and those need opposite
 * responses — the first is a master gap to backfill, the second is a bad file to
 * re-download. Recording the date span per symbol makes the two distinguishable
 * in the job outcome without a query.
 */
export class QuarantineLedger {
  private readonly entries = new Map<string, QuarantineEntry>();
  private rows = 0;

  add(symbol: string, reason: QuarantineReason, at: Date): void {
    this.rows++;
    const day = at.toISOString().slice(0, 10);
    const key = symbol.trim().toUpperCase();
    const existing = this.entries.get(key);
    if (existing === undefined) {
      this.entries.set(key, {
        none: reason === "none" ? 1 : 0,
        ambiguous: reason === "ambiguous" ? 1 : 0,
        firstDate: day,
        lastDate: day,
      });
      return;
    }
    if (reason === "none") existing.none++;
    else existing.ambiguous++;
    if (day < existing.firstDate) existing.firstDate = day;
    if (day > existing.lastDate) existing.lastDate = day;
  }

  get size(): number {
    return this.entries.size;
  }

  get rowCount(): number {
    return this.rows;
  }

  summary(sampleSize = 20): QuarantineSummary {
    const sample = [...this.entries.entries()]
      .map(([symbol, e]) => ({
        symbol,
        reason: (e.ambiguous > e.none
          ? "ambiguous"
          : "none") as QuarantineReason,
        rows: e.none + e.ambiguous,
        firstDate: e.firstDate,
        lastDate: e.lastDate,
      }))
      .sort((a, b) => b.rows - a.rows)
      .slice(0, sampleSize);
    return {
      quarantinedSymbols: this.entries.size,
      quarantinedRows: this.rows,
      sample,
    };
  }
}
