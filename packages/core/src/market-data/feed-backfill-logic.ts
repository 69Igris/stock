/**
 * PURE decision logic for the historical feed backfill — MONEY-941 (P3).
 *
 * No Prisma, no fetch, no GCS, no clock. Every function here is a function of
 * its arguments, so the decisions that actually determine whether the backfill
 * is correct — when a range has genuinely ended, when to back off, when to give
 * up — are unit-testable without touching an exchange.
 *
 * The I/O half lives in `scripts/jobs/feed-backfill.ts`. This half sits in
 * packages/core because that is where business logic belongs in this repo —
 * and because it makes the decisions testable inside core's own suite.
 */

import type { ReportFamily } from "./report-registry";

// ─── Walk sequence ───────────────────────────────────────────────────

/** IST `YYYY-MM-DD` for a Date. */
export function isoDay(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/** Parse `YYYY-MM-DD` at UTC noon so the +5:30 shift cannot cross a day. */
export function parseDay(iso: string): Date {
  return new Date(`${iso}T12:00:00.000Z`);
}

/**
 * UTC midnight of the IST trading day `d` falls on — the DailyPrice /
 * DerivativeEOD date convention (MONEY-1100 postmortem).
 *
 * `dateFromArchiveKey` returns UTC NOON on purpose (`parseDay` keeps +5:30
 * from crossing a day during the WALK), and every parser that computes its own
 * trading date re-normalizes — but a writer that stamps or QUERIES with the
 * raw noon value silently forks a second date-series 12 hours away from every
 * midnight row. That is exactly what the delivery writers did: 3,237,416
 * noon-dated DailyPrice rows, and 15.9M BSE delivery lookups matching ZERO
 * price rows because both sides were right about the day and wrong about the
 * hour. Writers normalize HERE, once, at the boundary.
 */
export function utcMidnightOf(d: Date): Date {
  return new Date(`${isoDay(d)}T00:00:00.000Z`);
}

/** Saturday or Sunday in IST. */
export function isWeekend(d: Date): boolean {
  const dow = new Date(d.getTime() + 5.5 * 60 * 60 * 1000).getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Weekdays in `[from, to]`, NEWEST FIRST.
 *
 * ## Why weekdays and not "trading days"
 *
 * `nse-holidays.ts` covers FY26-27 only. There is no free, reliable holiday
 * calendar for 1994-2020, and inventing one would produce false absences. So
 * the rule is deliberately dumb: skip weekends, fetch every weekday, and let a
 * 404 mean "no file for this day" without trying to explain why. A holiday and
 * a genuine gap are indistinguishable to us and — importantly — they are also
 * EQUIVALENT: both mean there is nothing to archive.
 *
 * ## Why newest-first
 *
 * A backfill can always be interrupted: Cloud Run job timeouts, a throttling
 * exchange, someone stopping it. Descending order means whatever completes is
 * the MOST RECENT history, which is the part every downstream consumer wants
 * first. Ascending order would leave a truncated run holding only the 1990s.
 */
export function weekdaysDescending(from: string, to: string): Date[] {
  const out: Date[] = [];
  const lo = parseDay(from).getTime();
  for (let t = parseDay(to).getTime(); t >= lo; t -= 86_400_000) {
    const d = new Date(t);
    if (!isWeekend(d)) out.push(d);
  }
  return out;
}

// ─── K-miss: when has a range actually ENDED? ────────────────────────

/**
 * Consecutive weekday misses that end a range, once below the declared floor.
 *
 * 20 is chosen against the observed failure, not picked round: NSE's archive is
 * SPARSE, and P1 found a gap one day wide in 1994. A month of consecutive
 * absent weekdays is not a gap, it is the edge of history. Smaller values risk
 * amputating real history at a long holiday cluster or an outage.
 */
export const DEFAULT_K_MISS = 20;

export interface RangeState {
  /** Consecutive MISSING days seen so far, reset by any hit. */
  consecutiveMisses: number;
  /** True once the walk has descended past the family's declared startDate. */
  belowFloor: boolean;
}

/**
 * Should the walk stop treating this family as having more history?
 *
 * The single most important rule in the backfill, and the one P1's findings
 * exist to enforce: **an in-range 404 is a GAP, never end-of-history.**
 * Availability is not monotonic — 1994-11-03 is present, 11-04 is a genuine
 * 404, and 12-01 is present again. A walker that stops at the first 404, or
 * bisects, will silently amputate whatever lies beyond the hole and report
 * success.
 *
 * So misses inside the declared range never stop anything. Only once the walk
 * is BELOW the declared floor — i.e. already in exploratory territory, looking
 * for the true edge — does a long run of misses mean "there is nothing more".
 */
export function shouldEndRange(
  state: RangeState,
  kMiss = DEFAULT_K_MISS,
): boolean {
  return state.belowFloor && state.consecutiveMisses >= kMiss;
}

/** Fold one day's outcome into the range state. */
export function advanceRange(
  state: RangeState,
  outcome: "DONE" | "MISSING" | "ERROR",
  dayIso: string,
  floorIso: string,
): RangeState {
  return {
    // An ERROR is not evidence of absence — we never learned anything — so it
    // must not push the walk toward declaring the range over.
    consecutiveMisses: outcome === "MISSING" ? state.consecutiveMisses + 1 : 0,
    belowFloor: state.belowFloor || dayIso < floorIso,
  };
}

// ─── Host backoff ────────────────────────────────────────────────────

/** Consecutive throttles before a host is paused outright. */
export const THROTTLES_BEFORE_PAUSE = 3;
/** How long a paused host stays paused. */
export const HOST_PAUSE_MS = 15 * 60 * 1000;

export interface HostState {
  consecutiveThrottles: number;
  pausedUntil: number;
}

export function emptyHostState(): HostState {
  return { consecutiveThrottles: 0, pausedUntil: 0 };
}

/**
 * Fold one response into a host's throttle state.
 *
 * Backing off per HOST rather than per family is the point: NSE rate-limits by
 * IP, so a 403 on one family is a statement about the whole host. Continuing to
 * hammer it with a different family's URLs is what turns a soft throttle into a
 * hard IP block — and this egress is the one `bhavcopy-sync` needs nightly.
 */
export function noteHostOutcome(
  state: HostState,
  throttled: boolean,
  now: number,
): HostState {
  if (!throttled)
    return { consecutiveThrottles: 0, pausedUntil: state.pausedUntil };
  const n = state.consecutiveThrottles + 1;
  return {
    consecutiveThrottles: n,
    pausedUntil:
      n >= THROTTLES_BEFORE_PAUSE ? now + HOST_PAUSE_MS : state.pausedUntil,
  };
}

export function hostIsPaused(state: HostState, now: number): boolean {
  return now < state.pausedUntil;
}

/**
 * Exponential backoff for retry `attempt` (0-based), capped.
 *
 * Named for the backfill rather than generically: `@usemoney/core`'s root
 * barrel already exports a `backoffMs` from the broker clients, and a duplicate
 * name there is a hard TS2308 build error, not a lint nit.
 */
export function backfillBackoffMs(
  attempt: number,
  baseMs = 2000,
  capMs = 60_000,
): number {
  return Math.min(capMs, baseMs * 2 ** attempt);
}

// ─── Stop-loss ───────────────────────────────────────────────────────

/**
 * Why an ERROR happened, which decides whether it may abort the run.
 *
 * `transport` — the request itself failed: 403/429 after retries, a socket
 *   error, a 5xx, a timeout. The host is refusing us or is unreachable.
 *
 * `payload`  — the host answered **200** and we rejected the body: HTML instead
 *   of CSV, an empty JSON container, a missing header token. The host IS
 *   serving us; this particular day just has no file behind that URL.
 *
 * Collapsing these into one "error" count is the category error that caused two
 * separate production aborts. A 200 is positive evidence the host is healthy,
 * so it must never feed a stop-loss whose entire question is "has the host
 * stopped serving us?".
 */
export type FeedErrorKind = "transport" | "payload";

/** Consecutive TRANSPORT failures before the whole run aborts. */
export const DEFAULT_TRANSPORT_STOP_LOSS = 25;

/**
 * Consecutive CALENDAR-ADJACENT payload failures before one family is skipped.
 *
 * Deliberately much larger than the transport limit, and measured on adjacent
 * weekdays (see {@link isPrecedingWeekday}). Real holidays never cluster beyond
 * a long weekend, so 60 consecutive trading days of "the host answered but it
 * is not this feed" means the URL pattern is wrong for that era — not that the
 * calendar is busy. Skipping the family beats spending an hour archiving
 * interstitials.
 */
export const DEFAULT_PAYLOAD_STOP_LOSS = 60;

/**
 * Should the run abort?
 *
 * Takes CONSECUTIVE **transport** failures. Both qualifiers were learned from
 * production aborts, and dropping either one reintroduces a real bug.
 *
 * ## Why not cumulative (abort #1)
 *
 * The first version counted TOTAL errors. On a market holiday the exchange does
 * not 404 — it answers 200 with an ordinary HTML page, which is rejected and
 * recorded ERROR. At ~15 holidays a year the limit of 25 was reached inside two
 * years of a thirty-year walk, so every deep backfill was guaranteed to abort.
 * A BSE and an NSE family both died at exactly 423 done / 25 errors — identical
 * numbers from different exchanges, because they share one holiday calendar.
 *
 * ## Why consecutive alone was not enough (abort #2)
 *
 * Switching to consecutive counting looked correct and still aborted instantly
 * on the very next run. Resume excludes DONE and MISSING days from the plan, so
 * the 25 previously-errored holidays — scattered across twenty months of
 * calendar — became the first 25 entries of the plan, back to back. They were
 * consecutive in WALK ORDER while being nowhere near each other in time.
 * Counting loop iterations measured the wrong axis.
 *
 * ## What actually separates the cases
 *
 * The kind of failure, not its position:
 *
 *   payload   200 + wrong body -> host is healthy -> never aborts the run
 *   transport refused/unreachable -> host is not serving us -> aborts
 *
 * This needs no guess about whether a given HTML page is a holiday notice or a
 * throttle page — a distinction that cannot be made from the bytes, and whose
 * attempted resolution is what produced both earlier bugs.
 */
export function shouldAbort(
  consecutiveTransportErrors: number,
  limit = DEFAULT_TRANSPORT_STOP_LOSS,
): boolean {
  return consecutiveTransportErrors >= limit;
}

/** One calendar day, in the UTC-noon space `weekdaysDescending` produces. */
const DAY_MS = 86_400_000;

/**
 * The weekday immediately before `day`, skipping Sat/Sun in IST.
 *
 * Friday is the predecessor of Monday.
 */
export function previousWeekday(day: Date): Date {
  let t = day.getTime() - DAY_MS;
  while (isWeekend(new Date(t))) t -= DAY_MS;
  return new Date(t);
}

/**
 * Is `older` the weekday immediately preceding `newer`?
 *
 * This is the compaction-immune test. A descending walk visits calendar-adjacent
 * weekdays, so a genuine unbroken failure streak satisfies it every step. A
 * RESUMED walk visits only the days that are not yet terminal, so previously
 * errored days arrive back-to-back in the plan while sitting months apart in the
 * calendar — and fail this test immediately.
 *
 * Compared on `isoDay` so the caller's time-of-day cannot matter.
 */
export function isPrecedingWeekday(newer: Date, older: Date): boolean {
  return isoDay(previousWeekday(newer)) === isoDay(older);
}

/** The two independent failure streaks a walk tracks. */
export interface ErrorRuns {
  /** Consecutive transport failures. Aborts the RUN — the host is the problem. */
  transport: number;
  /** Consecutive calendar-adjacent payload failures. Skips one FAMILY. */
  payload: number;
  /** Day of the last payload failure, for the adjacency test. */
  lastPayloadDay: Date | null;
}

export function emptyErrorRuns(): ErrorRuns {
  return { transport: 0, payload: 0, lastPayloadDay: null };
}

/**
 * Fold one day's outcome into both streaks.
 *
 * Extracted into core, as a pure function over the SAME `Date` values the walk
 * iterates, specifically so the resume-compaction case can be tested. Both
 * earlier fixes were unit-tested and both still failed in production, because
 * the tests exercised a counter in isolation rather than the day sequence a
 * resumed plan actually produces.
 *
 * - DONE / MISSING reset everything: a 200 with a real body, or a clean 404,
 *   both prove the host is answering.
 * - A transport failure also clears the payload streak — once a request fails
 *   outright we no longer know what that day would have returned.
 * - A payload failure clears the transport streak, because it arrived on a 200.
 */
export function advanceErrorRuns(
  runs: ErrorRuns,
  status: "DONE" | "MISSING" | "ERROR",
  kind: FeedErrorKind | undefined,
  day: Date,
): ErrorRuns {
  if (status !== "ERROR") return emptyErrorRuns();

  if (kind === "transport") {
    return { transport: runs.transport + 1, payload: 0, lastPayloadDay: null };
  }

  const adjacent =
    runs.lastPayloadDay !== null &&
    isPrecedingWeekday(runs.lastPayloadDay, day);

  return {
    transport: 0,
    payload: adjacent ? runs.payload + 1 : 1,
    lastPayloadDay: day,
  };
}

// ─── Plan ────────────────────────────────────────────────────────────

export interface FamilyPlan {
  family: ReportFamily;
  /** Newest-first weekdays to visit, already excluding checkpointed days. */
  days: Date[];
  /** The declared floor, for the below-floor test. */
  floorIso: string;
}

/**
 * Build one family's day list, minus everything already terminal.
 *
 * `done` holds days that need no further work. MISSING counts as done for the
 * SAME run window — re-asking a known-absent day just burns the exchange's
 * patience — but it is stored rather than forgotten so a later, wider run can
 * reconsider it if the range is re-explored.
 */
/**
 * Chunk START dates in `[from, to]`, newest first, stepping by `days`.
 *
 * Range-addressed families (BSE index history) return a whole span per request,
 * so the walker must step by the window rather than by the day. Starts are
 * anchored to `to` and walked backwards so the newest window is complete and
 * any truncation lands on the oldest — same reasoning as the daily walk.
 *
 * Weekends are NOT skipped here: a 30-day window contains them by definition,
 * and skipping a start date that happens to fall on a Saturday would leave a
 * hole the size of a whole chunk.
 */
export function chunkStartsDescending(
  from: string,
  to: string,
  days: number,
): Date[] {
  const step = Math.max(1, Math.floor(days)) * 86_400_000;
  const lo = parseDay(from).getTime();
  const out: Date[] = [];
  for (let t = parseDay(to).getTime(); t >= lo; t -= step) {
    // Clamp the start so the final window cannot begin before the floor.
    out.push(new Date(Math.max(lo, t - step + 86_400_000)));
  }
  return out;
}

export function planFamily(
  family: ReportFamily,
  from: string,
  to: string,
  done: ReadonlySet<string>,
  exploreBelowFloorDays = 0,
): FamilyPlan {
  // Optionally descend below the declared floor to find the true edge; the
  // K-miss rule is what stops it.
  const lo = exploreBelowFloorDays
    ? isoDay(
        new Date(parseDay(from).getTime() - exploreBelowFloorDays * 86_400_000),
      )
    : from;

  // Range-addressed families step by their window; day-addressed ones by
  // weekday. Getting this wrong for a chunked family means 30 requests for
  // data the first one already returned, against a rate-limited host.
  const all = family.chunkDays
    ? chunkStartsDescending(lo, to, family.chunkDays)
    : weekdaysDescending(lo, to);

  const days = all.filter((d) => !done.has(isoDay(d)));
  return { family, days, floorIso: from };
}

/**
 * The special-session walk (MONEY-1613): EXACTLY `candidates` — the calendar's
 * `specialSessionCandidateDates()` — inside `[from, to]` (the family's era),
 * newest first, minus what is already terminal. This is the only plan that
 * visits a weekend, and only those weekends — never every weekend.
 */
export function planSpecialSessions(
  family: ReportFamily,
  from: string,
  to: string,
  done: ReadonlySet<string>,
  candidates: readonly string[],
): FamilyPlan {
  if (family.chunkDays) {
    throw new Error(
      `${family.id} is range-addressed (chunkDays) — a special-session date is not a chunk start`,
    );
  }
  const days = [...candidates]
    .sort()
    .filter((d) => d >= from && d <= to && !done.has(d))
    .reverse()
    .map(parseDay);
  return { family, days, floorIso: from };
}

/** Human summary of a completed family walk. */
export interface FamilyTally {
  done: number;
  missing: number;
  error: number;
  bytes: number;
}

export function emptyTally(): FamilyTally {
  return { done: 0, missing: 0, error: 0, bytes: 0 };
}

export function summarizeFamily(id: string, t: FamilyTally): string {
  const mb = (t.bytes / 1_048_576).toFixed(1);
  return `${id}: ${t.done} archived, ${t.missing} missing, ${t.error} errors, ${mb} MB`;
}

// ─── Archive key → trading day ───────────────────────────────────────

const MONTH_TOKENS = "JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC";

/**
 * Recover the trading day from an archived object's key.
 *
 * The parse pass reads objects back out of GCS and must know which day each
 * one is. Rather than ask every family to declare a reverse-parser, the token
 * formats the exchanges actually use are tried in a fixed order.
 *
 * Two of them (`SCBSEALL{DDMM}` and BSE's legacy `DDMMYY` cash names) cannot
 * name their own year unambiguously, so both are resolved against the archive
 * key's `/YYYY/MM/` segments and REJECTED on disagreement rather than guessed.
 *
 * ## Order matters and is not arbitrary
 *
 * `YYYYMMDD` is tried before `DDMMYYYY` because both are eight digits and only
 * the anchor tells them apart: the former is matched with a leading `19|20`
 * year, so `08082026` (8 Aug 2026, DDMMYYYY) cannot be mis-read as a year-first
 * token, while `20260807` can only parse one way. Reversing the order would
 * silently turn every MTO file into a date ~2000 years out.
 *
 * ## Known limitation
 *
 * Returns null for names carrying only a `DDMM` token — BSE's
 * `SCBSEALL0708.zip` keeps its year in the PATH, not the filename. That family
 * is archived but not parsed today; whoever adds it must pass the year in
 * separately rather than widen this function, because a bare `DDMM` is
 * genuinely ambiguous across 30 years of archive.
 */
export function dateFromArchiveKey(key: string): Date | null {
  const base = key.split("/").pop() ?? "";

  // Rolling families are prefixed `YYYY-MM-DD-` by the archiver itself.
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(base);
  if (iso) return isoOrNull(`${iso[1]}-${iso[2]}-${iso[3]}`);

  // YYYYMMDD (UDiFF).
  //
  // A matching PATTERN is not a valid DATE, and the two formats genuinely
  // collide: `ind_close_all_20052016.csv` (20 May 2016) reads as year 2005,
  // month 20, day 16 under this regex — year-anchoring does NOT prevent it,
  // because "2005" is a perfectly good year prefix. An earlier comment here
  // claimed the anchor made the collision impossible; it does not.
  //
  // So each branch FALLS THROUGH on an invalid candidate instead of returning
  // its null. Returning early made every such name undateable and the file was
  // skipped outright: 67 `ind_close_all` days dropped in a single sweep, which
  // is why IndexClose had holes across whole eras and every F&O basis for those
  // days came out null.
  const ymd = /(?:^|\D)((?:19|20)\d{2})(\d{2})(\d{2})(?:\D|$)/.exec(base);
  const ymdDate = ymd ? isoOrNull(`${ymd[1]}-${ymd[2]}-${ymd[3]}`) : null;
  if (ymdDate) return ymdDate;

  // DDMMYYYY (MTO, sec_bhavdata_full, EGR, ind_close_all).
  const dmy = /(?:^|\D)(\d{2})(\d{2})((?:19|20)\d{2})(?:\D|$)/.exec(base);
  const dmyDate = dmy ? isoOrNull(`${dmy[3]}-${dmy[2]}-${dmy[1]}`) : null;
  if (dmyDate) return dmyDate;

  // SCBSEALL{DDMM} (BSE gross delivery) — the basename carries NO YEAR, so the
  // year comes from the archive key's own /YYYY/MM/ path segments. Found the
  // expensive way: all 4,836 archived files skipped as "no date token" on the
  // first delivery-parse run (MONEY-1100 P4.1). The file's MM must MATCH the
  // path's MM — a mismatch means a mis-filed object, and stamping it with
  // either month would store a whole day under a wrong date; null is honest.
  const ddmm = /^SCBSEALL(\d{2})(\d{2})\./i.exec(base);
  if (ddmm) {
    const path = /\/((?:19|20)\d{2})\/(\d{2})\/[^/]+$/.exec(key);
    if (path && path[2] === ddmm[2]) {
      return isoOrNull(`${path[1]}-${ddmm[2]}-${ddmm[1]}`);
    }
    return null;
  }

  // DDMMYY (BSE legacy cash: `eq150323_csv.zip`, `EQ_ISINCODE_150323.zip`) —
  // MONEY-1101.
  //
  // Anchored on the two exact filename prefixes rather than matched as a
  // generic six-digit run, which is the whole safety argument: a bare `\d{6}`
  // would happily bite a scrip code, a settlement number or the tail of any
  // other token, and mis-dating an object is worse than failing to date it.
  //
  // The two-digit year is confirmed against the key's own `/YYYY/MM/` segments
  // instead of being trusted — the same treatment SCBSEALL gets above, and for
  // the same reason: `23` alone cannot distinguish 1923 from 2023, and the
  // archiver already wrote the unambiguous year into the path. A file whose own
  // YY/MM disagrees with the path is a MIS-FILED object; stamping it with
  // either value would store a whole trading day under a wrong date, so null
  // (→ counted `unreadable`, retried) is the honest answer.
  const ddmmyy = /^(?:eq|EQ_ISINCODE_)(\d{2})(\d{2})(\d{2})(?:_csv)?\./i.exec(
    base,
  );
  if (ddmmyy) {
    const path = /\/((?:19|20)\d{2})\/(\d{2})\/[^/]+$/.exec(key);
    if (path && path[2] === ddmmyy[2] && path[1]!.slice(-2) === ddmmyy[3]) {
      return isoOrNull(`${path[1]}-${ddmmyy[2]}-${ddmmyy[1]}`);
    }
    return null;
  }

  // DDMMMYYYY (legacy cm/fo, e.g. cm03NOV1994bhav).
  const dMon = /(\d{2})([A-Z]{3})((?:19|20)\d{2})/.exec(base.toUpperCase());
  if (dMon) {
    const idx = MONTH_TOKENS.indexOf(dMon[2]!);
    if (idx >= 0 && idx % 3 === 0) {
      const month = String(idx / 3 + 1).padStart(2, "0");
      return isoOrNull(`${dMon[3]}-${month}-${dMon[1]}`);
    }
  }

  // DD-Mon-YYYY, the SEPARATED variant — `fii_stats_13-Aug-2026.xls` and
  // `Corporate_bond_report_13-Aug-2026.csv` (MONEY-1204 / P0.1).
  //
  // Deliberately a SEPARATE branch rather than relaxing the contiguous
  // DDMMMYYYY regex above. Loosening that one to tolerate optional separators
  // would re-scan every already-working family — 30 years and ~67,000 archived
  // objects — for a widened pattern, to fix two families. A new branch reached
  // only after every existing branch has declined cannot regress any of them.
  //
  // The dashes are what defeated the earlier regexes: `13-Aug-2026` has no
  // eight-digit run for YYYYMMDD/DDMMYYYY and no contiguous DDMMMYYYY token, so
  // all six branches returned null and `feed-parse` skipped 100% of the family
  // with a `no date token` warning. That reads identically to "NSE published
  // nothing" — 1,636 archived fii-stats objects would have parsed to zero rows
  // while every counter reported a clean run.
  //
  // `[A-Z]{3,}` then sliced to 3 so a future `13-August-2026` still resolves;
  // the month is validated against MONTH_TOKENS, and `isoOrNull` rejects an
  // impossible day, so a false positive has to survive both.
  const dashMon =
    /(?:^|[^0-9A-Z])(\d{1,2})-([A-Z]{3,})-((?:19|20)\d{2})(?:\D|$)/.exec(
      base.toUpperCase(),
    );
  if (dashMon) {
    const idx = MONTH_TOKENS.indexOf(dashMon[2]!.slice(0, 3));
    if (idx >= 0 && idx % 3 === 0) {
      const month = String(idx / 3 + 1).padStart(2, "0");
      const day = dashMon[1]!.padStart(2, "0");
      return isoOrNull(`${dashMon[3]}-${month}-${day}`);
    }
  }
  return null;
}

/** `YYYY-MM-DD` at UTC noon, rejecting anything that rolls over. */
function isoOrNull(iso: string): Date | null {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt;
}

// ─── Archives-door fallback ──────────────────────────────────────────

/**
 * Consecutive throttles on the static archive before the door is tried.
 *
 * Lower than {@link THROTTLES_BEFORE_PAUSE} on purpose: the point is to try the
 * alternative route BEFORE giving up on the host for 15 minutes, since a
 * successful door fetch means the walk never has to pause at all.
 */
export const THROTTLES_BEFORE_DOOR = 2;

/**
 * Should this fetch be retried through the `/api/reports` archives door?
 *
 * Both conditions are required, and the second is the load-bearing one: a
 * family with no confirmed door descriptor must NEVER be sent to the door on a
 * guessed name, because a wrong name returns the same 404 an absent file does
 * and the walk would record MISSING for days that actually exist.
 */
export function shouldTryDoor(
  consecutiveThrottles: number,
  hasDoorDescriptor: boolean,
  threshold = THROTTLES_BEFORE_DOOR,
): boolean {
  return hasDoorDescriptor && consecutiveThrottles >= threshold;
}
