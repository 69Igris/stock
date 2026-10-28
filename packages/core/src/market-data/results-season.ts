/**
 * Indian results seasons — MONEY-1217.
 *
 * A quarterly earnings calendar in India is NOT a rolling 30-day window. Listed
 * companies report in four tight, statutorily-bounded bursts and then nothing
 * happens for weeks, so a calendar keyed on "the next 30 days" is empty for most
 * of the year through no fault of the data. That is the defect this module
 * exists to remove: the sector deep-dive rendered a month grid with a green
 * "0 events" pill for essentially every sector, which a reader parses as "this
 * sector has no earnings this month" — a claim nobody can make from an empty
 * query.
 *
 * ## Where the windows come from
 *
 * SEBI (LODR) Reg. 33 sets the FILING deadlines, and those deadlines are what
 * actually cluster the dates:
 *
 *   - quarterly results: within **45 days** of the quarter end;
 *   - the fourth quarter / annual results: within **60 days** of the FY end.
 *
 * India's fiscal year runs 1 Apr – 31 Mar, so the four deadlines fall on 14 Aug,
 * 14 Nov, 14 Feb and 30 May. Announcements bunch into the fortnight before each
 * one, and NSE intimates the board-meeting date ~2–3 weeks ahead of the meeting
 * under Reg. 29. The windows below start on the 15th of the month before each
 * deadline, which covers the real announcement mass without pretending to be
 * something the regulation guarantees:
 *
 *   | season | fiscal quarter | window                 |
 *   | ------ | -------------- | ---------------------- |
 *   | Q1     | Apr–Jun        | 15 Jul – 14 Aug        |
 *   | Q2     | Jul–Sep        | 15 Oct – 14 Nov        |
 *   | Q3     | Oct–Dec        | 15 Jan – 14 Feb        |
 *   | Q4     | Jan–Mar        | 15 Apr – 30 May (60d)  |
 *
 * A date OUTSIDE all four is a real answer, not a lookup failure — mid-August
 * through mid-October is genuinely between seasons — so {@link seasonFor}
 * returns `null` there rather than snapping to the nearest window. Callers that
 * need something to show ask {@link currentOrNextSeason}, which says so in its
 * name.
 *
 * ## Purity
 *
 * Everything here is pure: no I/O, no `Date.now()`, no timezone lookups. `now`
 * is always injected. All dates are built with `Date.UTC(y, m, d)` rather than
 * millisecond arithmetic from a base, so a leap year cannot slide a window —
 * `+31 * 86_400_000` from 15 Jan 2024 lands on 15 Feb, but the same arithmetic
 * across a February boundary in a non-leap year does not, and that class of drift
 * is invisible until the one year it is wrong.
 *
 * ## UTC, deliberately
 *
 * `UpcomingEvent.date` is written as UTC midnight of the IST calendar day
 * (`startOfUtcDay` in `workers/src/processors/events-sync-logic.ts`), so the
 * whole calendar is a sequence of UTC-midnight instants and a UTC-keyed window
 * compares against it exactly. Introducing an IST offset here would shift every
 * boundary by 5h30m against the writer and start including or excluding the edge
 * days at random.
 */

/** Fiscal quarter within the Indian FY (Q1 = Apr–Jun). */
export type FiscalQuarter = 1 | 2 | 3 | 4;

/**
 * One results season: a labelled, half-open date window.
 *
 * `start` is INCLUSIVE and `end` is EXCLUSIVE — `end` is UTC midnight of the day
 * AFTER the last day of the window, so it drops straight into a Prisma
 * `{ gte: start, lt: end }` without an off-by-one. The table in this file's
 * header quotes the inclusive last day (14 Aug); `end` is therefore 15 Aug.
 */
export interface ResultsSeason {
  /** Display label, e.g. `"Q1 FY27"`. */
  label: string;
  /** Which fiscal quarter's results this window carries. */
  quarter: FiscalQuarter;
  /**
   * Calendar year the fiscal year STARTS in: 2026 means FY 2026-27, labelled
   * "FY27". Q3 and Q4 of that FY fall in calendar 2027.
   */
  fyStartYear: number;
  /**
   * Monotonic index, so "previous" / "next" is `ordinal ± 1` instead of date
   * arithmetic that has to know about FY rollover. Also the only value the UI
   * sends over the wire — see {@link seasonFromOrdinal}.
   */
  ordinal: number;
  /** Inclusive UTC-midnight start of the announcement window. */
  start: Date;
  /** EXCLUSIVE UTC-midnight end (the instant after the last day). */
  end: Date;
}

/**
 * The four windows, as calendar offsets from the FY start year.
 *
 * `yearOffset` is 0 for the two seasons that fall in the FY's own calendar year
 * and 1 for the two that spill into the next one — Q3 of FY 2026-27 is reported
 * in Jan-2027, not Jan-2026, and getting that backwards puts the whole calendar
 * a year out while every label still reads correctly.
 */
const SEASON_WINDOWS: ReadonlyArray<{
  quarter: FiscalQuarter;
  yearOffset: 0 | 1;
  /** 0-based month of the window start. */
  startMonth: number;
  startDay: number;
  /** 0-based month of the INCLUSIVE last day. */
  endMonth: number;
  endDay: number;
}> = [
  // Q1 Apr–Jun → 45 days after 30 Jun = 14 Aug.
  {
    quarter: 1,
    yearOffset: 0,
    startMonth: 6,
    startDay: 15,
    endMonth: 7,
    endDay: 14,
  },
  // Q2 Jul–Sep → 45 days after 30 Sep = 14 Nov.
  {
    quarter: 2,
    yearOffset: 0,
    startMonth: 9,
    startDay: 15,
    endMonth: 10,
    endDay: 14,
  },
  // Q3 Oct–Dec → 45 days after 31 Dec = 14 Feb, in the NEXT calendar year.
  {
    quarter: 3,
    yearOffset: 1,
    startMonth: 0,
    startDay: 15,
    endMonth: 1,
    endDay: 14,
  },
  // Q4 Jan–Mar → 60 days after 31 Mar = 30 May (annual results get the longer
  // deadline because they are audited).
  {
    quarter: 4,
    yearOffset: 1,
    startMonth: 3,
    startDay: 15,
    endMonth: 4,
    endDay: 30,
  },
];

const MS_PER_DAY = 86_400_000;

/** 0-based month April — the first month of the Indian fiscal year. */
const FY_START_MONTH = 3;

/**
 * How far the UI is allowed to page away from the current season, in quarters.
 *
 * The season ordinal crosses a trust boundary (it arrives from the client), and
 * `seasonFromOrdinal` happily constructs the year 500,000 — a window a database
 * would then be asked to scan. Two years either way covers every navigation the
 * panel offers (one step back, one step forward) with a wide margin, and makes
 * an out-of-range ordinal a REJECTION rather than a clamp: silently snapping a
 * nonsense input to a valid window is how a caller bug becomes invisible.
 */
export const SEASON_ORDINAL_SPAN = 8;

/** "FY27" for `fyStartYear` 2026. */
function fyLabel(fyStartYear: number): string {
  return `FY${String((fyStartYear + 1) % 100).padStart(2, "0")}`;
}

function utcDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

/** `fyStartYear * 4 + (quarter - 1)` — see {@link ResultsSeason.ordinal}. */
export function seasonOrdinal(
  fyStartYear: number,
  quarter: FiscalQuarter,
): number {
  return fyStartYear * 4 + (quarter - 1);
}

function buildSeason(
  fyStartYear: number,
  spec: (typeof SEASON_WINDOWS)[number],
): ResultsSeason {
  const year = fyStartYear + spec.yearOffset;
  return {
    label: `Q${spec.quarter} ${fyLabel(fyStartYear)}`,
    quarter: spec.quarter,
    fyStartYear,
    ordinal: seasonOrdinal(fyStartYear, spec.quarter),
    start: utcDay(year, spec.startMonth, spec.startDay),
    // Exclusive end = midnight of the day after the inclusive last day.
    // Built by adding ONE day to a real calendar date rather than by naming
    // `endDay + 1`, which would produce 31 May / 15 Feb correctly but 15 Aug
    // only by luck of the month lengths involved. `Date.UTC` normalises the
    // overflow, so this stays correct if a window is ever moved onto a month
    // end.
    end: new Date(
      utcDay(year, spec.endMonth, spec.endDay).getTime() + MS_PER_DAY,
    ),
  };
}

/**
 * The four seasons of one fiscal year, ordered by start date.
 *
 * `fyStartYear` is the CALENDAR year the FY begins in: `seasons(2026)` returns
 * the four FY27 windows, the last two of which fall in calendar 2027.
 */
export function seasons(fyStartYear: number): ResultsSeason[] {
  return SEASON_WINDOWS.map((spec) => buildSeason(fyStartYear, spec));
}

/** Reconstruct a season from its {@link ResultsSeason.ordinal}. */
export function seasonFromOrdinal(ordinal: number): ResultsSeason {
  const fyStartYear = Math.floor(ordinal / 4);
  // `((n % 4) + 4) % 4` rather than `n % 4`: JavaScript's remainder keeps the
  // sign of the dividend, so a negative ordinal (year 0 BCE territory, but the
  // range guard below is what makes that unreachable — not this) would index
  // out of the array and return `undefined`.
  const index = ((ordinal % 4) + 4) % 4;
  const spec = SEASON_WINDOWS[index]!;
  return buildSeason(fyStartYear, spec);
}

/** Move `delta` seasons forward (or backward, when negative). */
export function shiftSeason(
  season: ResultsSeason,
  delta: number,
): ResultsSeason {
  return seasonFromOrdinal(season.ordinal + Math.trunc(delta));
}

/** Whether `date` falls inside the half-open `[start, end)` window. */
export function seasonContains(season: ResultsSeason, date: Date): boolean {
  const t = date.getTime();
  return t >= season.start.getTime() && t < season.end.getTime();
}

/** The FY start year containing `date` (FY runs 1 Apr – 31 Mar). */
export function fiscalYearStart(date: Date): number {
  return date.getUTCMonth() >= FY_START_MONTH
    ? date.getUTCFullYear()
    : date.getUTCFullYear() - 1;
}

/**
 * Every season that could plausibly contain or follow `date`, ordered by start.
 *
 * Three fiscal years, not one: `date` in early January sits in FY N's Q3 window,
 * whose START is in FY N's calendar year N+1 — and `date` in late March is
 * looking forward to a Q4 window that has not opened yet. Spanning N-1..N+1 and
 * sorting makes both cases fall out of the same scan.
 */
function candidateSeasons(date: Date): ResultsSeason[] {
  const fy = fiscalYearStart(date);
  return [...seasons(fy - 1), ...seasons(fy), ...seasons(fy + 1)].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
}

/**
 * The season whose window contains `date`, or **null** between seasons.
 *
 * Null is the honest answer for ~7 months of the year and callers must handle it
 * — the whole point of this module is that "no season is open right now" and "no
 * data" are different statements. See {@link currentOrNextSeason} when a surface
 * needs something to render regardless.
 */
export function seasonFor(date: Date): ResultsSeason | null {
  return candidateSeasons(date).find((s) => seasonContains(s, date)) ?? null;
}

/**
 * The season to show by default: the one in progress, else the next to open.
 *
 * "In progress" is `now < end`, so a season stays selected through its final day
 * rather than flipping to the next one at the first date with no remaining
 * announcements. On 19 Aug 2026 — five days after Q1 FY27's window closed — this
 * returns **Q2 FY27**, which is the correct thing to put in front of a reader in
 * mid-August.
 */
export function currentOrNextSeason(now: Date): ResultsSeason {
  const candidates = candidateSeasons(now);
  const t = now.getTime();
  // The scan cannot fall through: the last candidate starts in FY+1's Q4, which
  // is at minimum ~12 months after any `now` that produced it. The `!` is
  // therefore total, and a non-null assertion beats a fabricated fallback season
  // that would silently be wrong if the span above were ever narrowed.
  return candidates.find((s) => t < s.end.getTime()) ?? candidates.at(-1)!;
}

/**
 * Whether a client-supplied ordinal is close enough to `now` to serve.
 *
 * The guard is on DISTANCE from the current season, not on absolute value, so it
 * keeps working forever without a hard-coded year.
 */
export function isSeasonOrdinalInRange(
  ordinal: number,
  now: Date,
  span: number = SEASON_ORDINAL_SPAN,
): boolean {
  if (!Number.isInteger(ordinal)) return false;
  const current = currentOrNextSeason(now).ordinal;
  return Math.abs(ordinal - current) <= span;
}

// ─────────────────────────────────────────────────────────────────────────────
// Day grouping
// ─────────────────────────────────────────────────────────────────────────────

/** One announced event on the calendar. */
export interface ResultsCalendarEvent {
  /** Bare NSE symbol, e.g. `"RELIANCE"`. */
  symbol: string;
  /** Company long name when we have one mapped, else null. */
  name: string | null;
  /** The event title as the feed stated it. */
  title: string;
}

/** One calendar day that HAS at least one event. */
export interface ResultsCalendarDay {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  events: ResultsCalendarEvent[];
}

/** A row as it comes out of `UpcomingEvent` (symbol already non-null). */
export interface ResultsCalendarRow {
  date: Date;
  symbol: string;
  name: string | null;
  title: string;
}

/**
 * Collapse rows into ascending days, **omitting every day with no events**.
 *
 * This omission is the feature, not an optimisation. The surface this feeds used
 * to render one cell per calendar day whether or not anything was announced, and
 * a wall of blank cells under a green "0 events" pill asserts something we have
 * no basis for: NSE publishes board-meeting intimations ~2–3 weeks ahead, so an
 * absent date means "not announced yet" far more often than it means "nothing
 * happens that day". A dated list of only the days we actually know about makes
 * no claim about the days we do not.
 *
 * Consequences worth keeping in mind:
 *   - `days.length` is the number of days with data, NEVER the length of the
 *     season window. Do not use it as a denominator for "coverage".
 *   - An empty return means we know of nothing in this window. It does not mean
 *     nothing will be announced, and the caller's empty state has to say so.
 *
 * Days are sorted ascending and events within a day by symbol, so the output is
 * stable for a given input regardless of the query's row order — which is what
 * makes it testable and what keeps React keys from reshuffling between fetches.
 */
export function groupResultsByDay(
  rows: readonly ResultsCalendarRow[],
): ResultsCalendarDay[] {
  const byDate = new Map<string, ResultsCalendarEvent[]>();
  for (const row of rows) {
    // `toISOString()` on an Invalid Date THROWS a RangeError rather than
    // returning a marker string, so one unparseable row would take down the
    // whole sector's calendar. Dropped instead — the same posture the feed's own
    // parsers take with a row they cannot key, and the reason the check is on
    // `getTime()` (NaN) rather than on the formatted output.
    if (!Number.isFinite(row.date.getTime())) continue;
    const key = row.date.toISOString().slice(0, 10);
    const bucket = byDate.get(key);
    const event: ResultsCalendarEvent = {
      symbol: row.symbol,
      name: row.name,
      title: row.title,
    };
    if (bucket) bucket.push(event);
    else byDate.set(key, [event]);
  }

  return Array.from(byDate.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, events]) => ({
      date,
      events: events.sort((a, b) =>
        a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0,
      ),
    }));
}
