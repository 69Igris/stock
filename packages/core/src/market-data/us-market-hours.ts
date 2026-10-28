/**
 * US (NYSE / Nasdaq) market-hours session detector.
 *
 * Companion to `market-hours.ts`, which does the same job for NSE/BSE.
 * Deliberately a SEPARATE module rather than a widened one: the two
 * exchanges disagree on every axis that matters — the session grid, the
 * holiday calendar, the early-close concept (NSE has none), and above all
 * the timezone, which is fixed for IST and moves twice a year for ET. A
 * shared `MarketPhase` union would have had to name states one exchange
 * never enters.
 *
 * PURE by contract: every function takes an explicit `at: Date`. There is
 * no `Date.now()` default here — unlike `getNseMarketStatus(date = new
 * Date())` — because the first consumer is a staleness alarm, and an alarm
 * that can read the clock itself is an alarm you cannot test at a boundary.
 * No I/O, no env reads, no module-level mutable state.
 *
 * Session grid (US Eastern wall clock). The boundaries are NOT the NYSE
 * floor session — they are the day of the REALTIME FEED, measured against
 * Tiingo: the feed's day runs 04:00–20:00 ET, so "post" ends at 20:00 and
 * everything outside is genuinely dark rather than merely quiet.
 *
 *   - pre     04:00–09:29:59  ET  extended-hours quotes flowing
 *   - rth     09:30–15:59:59  ET  regular trading hours
 *   - post    16:00–19:59:59  ET  extended-hours quotes flowing
 *   - closed  everything else, plus all day Sat/Sun and on a market holiday
 *
 * On an EARLY-CLOSE day (see `US_EARLY_CLOSE_DAYS`) `rth` ends at 13:00 ET
 * and `post` runs 13:00–20:00 ET. `pre` is unaffected.
 *
 * `isUsMarketOpen` is true ONLY during `rth`. Pre and post are real
 * sessions with real prints, but they are thin, and callers that want to
 * treat them as live must ask for the session by name.
 *
 * WHY `Intl` AND NOT AN OFFSET CONSTANT
 * -------------------------------------
 * `market-hours.ts` derives IST with a hand-rolled `+5:30` constant and
 * says so in its header. That is correct FOR IST, which has never observed
 * daylight saving. It is wrong for ET, twice a year, by exactly one hour:
 *
 *   - EST is UTC-05:00 (early Nov → mid Mar)
 *   - EDT is UTC-04:00 (mid Mar → early Nov)
 *
 * A fixed `-05:00` would report 13:45 UTC as 08:45 ET all year, which is
 * `pre`. It is `pre` in February and `rth` in June. The failure is not
 * theoretical and it is not spread evenly: it is a solid EIGHT MONTHS of
 * wrong answers under EDT, and the transition days themselves — the second
 * Sunday in March and the first Sunday in November — are precisely when a
 * staleness alarm would misfire, because an hour-shifted grid says "the
 * feed should be live" while the venue is still shut (or says "closed"
 * through the first hour of the real session and suppresses a genuine
 * stall). Hand-rolled DST arithmetic is worse still: the US rule changed in
 * 2007 and can change again by an act of Congress, so an if-statement over
 * month boundaries encodes a fact that is not ours to know.
 *
 * So the wall clock is derived from the instant by `Intl.DateTimeFormat`
 * with `timeZone: "America/New_York"`, which reads the ICU tzdata shipped
 * with the runtime. The formatter is built once at module scope: it is
 * stateless and expensive to construct, so this is a cache, NOT the
 * frozen-at-import env read that this repo has been bitten by (a tz
 * database does not change between two calls in one container's life, and
 * if it did we would want the process restarted anyway).
 *
 * `en-US` is the locale on purpose — it is the one locale guaranteed
 * present in a small-icu build. Timezone data is present in every ICU
 * build, so this works on a slim Node image.
 *
 * HOLIDAYS ARE DATA, NOT DERIVED
 * ------------------------------
 * See `US_MARKET_HOLIDAYS` below for the table, its sourcing rules and how
 * to extend it past `US_HOLIDAY_TABLE_YEARS.last`.
 */

/** The four states of the US extended-hours trading day. */
export type UsMarketSession = "closed" | "pre" | "rth" | "post";

// ---------------------------------------------------------------------------
// Session boundaries, as minutes from ET midnight.
// ---------------------------------------------------------------------------

/** 04:00 ET — the realtime feed's day begins. */
export const US_PRE_OPEN_MINUTES = 4 * 60;
/** 09:30 ET — regular trading hours open. */
export const US_RTH_OPEN_MINUTES = 9 * 60 + 30;
/** 16:00 ET — regular trading hours close on a normal day. */
export const US_RTH_CLOSE_MINUTES = 16 * 60;
/** 13:00 ET — regular trading hours close on an early-close day. */
export const US_EARLY_CLOSE_MINUTES = 13 * 60;
/** 20:00 ET — the realtime feed's day ends. */
export const US_POST_CLOSE_MINUTES = 20 * 60;

// ---------------------------------------------------------------------------
// Holiday calendar
// ---------------------------------------------------------------------------

/**
 * NYSE / Nasdaq FULL-DAY closures, keyed by the ET calendar date the
 * exchange is actually shut (`YYYY-MM-DD`).
 *
 * THE KEY IS THE OBSERVED DATE, NEVER THE NOMINAL ONE. Independence Day
 * 2026 is stored as `2026-07-03` because 4 July 2026 is a Saturday; the
 * nominal date is a Saturday, on which the exchange is shut anyway, and a
 * table keyed nominally would have declared the Friday a trading day. The
 * NYSE observance rules (Rule 7.2) are:
 *
 *   - a holiday on SATURDAY is observed the preceding Friday
 *   - a holiday on SUNDAY is observed the following Monday
 *   - EXCEPT New Year's Day: when 1 January falls on a Saturday the
 *     exchange does NOT close the preceding Friday, and does not shift to
 *     the Monday either — the holiday simply does not occur. That is why
 *     2028 has no New Year entry below and 31 December 2027 (a Friday) is
 *     a full trading day. This exception has caught real calendars out; it
 *     is pinned by a test.
 *
 * Derivation of each entry, so a future year can be produced the same way
 * rather than copied from a screenshot:
 *
 *   New Year's Day        1 Jan (observance exception above)
 *   MLK Day               3rd Monday in January
 *   Washington's Birthday 3rd Monday in February
 *   Good Friday           the Friday before Easter Sunday (computus)
 *   Memorial Day          last Monday in May
 *   Juneteenth            19 June
 *   Independence Day      4 July
 *   Labor Day             1st Monday in September
 *   Thanksgiving Day      4th Thursday in November
 *   Christmas Day         25 December
 *
 * TO EXTEND: append the next year's ten observed dates here, add its
 * early closes to `US_EARLY_CLOSE_DAYS`, and bump
 * `US_HOLIDAY_TABLE_YEARS.last`. The premise test walks every year in that
 * range and fails if one is short of its holidays, so a half-added year
 * cannot ship silently. Cross-check against the NYSE's published calendar
 * before believing the arithmetic — the exchange has closed for national
 * days of mourning (Presidents Ford, Bush, and Carter on 9 January 2025,
 * which is in the table below) and for weather (Sandy, 2012), and no rule
 * generates those. So a year is not always ten entries: 2025 has ELEVEN and
 * 2028 has nine.
 *
 * The value is the holiday NAME, for UI and for logs: a closed-market
 * badge reading "Closed · Thanksgiving Day" is debuggable, one reading
 * "Closed" is not.
 */
export const US_MARKET_HOLIDAYS: Readonly<Record<string, string>> =
  Object.freeze({
    // ---- 2023 -------------------------------------------------------------
    // Extended BACKWARDS by MONEY-1373. The Databento harvest walks
    // 2023-03-28 -> today and `isUsTradingDay` is its coverage DENOMINATOR, so
    // with the table starting at 2026 every market holiday in 2023-2025 read
    // as a MISSING SESSION — about ten false alarms a year, blamed on the
    // vendor. A report that cries wolf thirty times is a report nobody reads.
    // Every date below was re-derived from the rules above (computus for Good
    // Friday, nth-weekday for the rest) and cross-checked for weekday, not
    // copied.
    //
    // 1 January 2023 is a Sunday -> observed Monday 2 January.
    "2023-01-02": "New Year's Day (observed)",
    "2023-01-16": "Martin Luther King Jr. Day",
    "2023-02-20": "Washington's Birthday",
    "2023-04-07": "Good Friday",
    "2023-05-29": "Memorial Day",
    "2023-06-19": "Juneteenth National Independence Day",
    "2023-07-04": "Independence Day",
    "2023-09-04": "Labor Day",
    "2023-11-23": "Thanksgiving Day",
    "2023-12-25": "Christmas Day",

    // ---- 2024 -------------------------------------------------------------
    // 1 January 2024 is a Monday — no observance shift.
    "2024-01-01": "New Year's Day",
    "2024-01-15": "Martin Luther King Jr. Day",
    "2024-02-19": "Washington's Birthday",
    "2024-03-29": "Good Friday",
    "2024-05-27": "Memorial Day",
    "2024-06-19": "Juneteenth National Independence Day",
    "2024-07-04": "Independence Day",
    "2024-09-02": "Labor Day",
    "2024-11-28": "Thanksgiving Day",
    "2024-12-25": "Christmas Day",

    // ---- 2025 -------------------------------------------------------------
    // ELEVEN closures, not ten. 9 January 2025 was a national day of mourning
    // for President Carter — a ONE-OFF, generated by no rule, and precisely
    // the entry a derived calendar gets wrong. It is the standing argument for
    // this table being DATA: the header already names the Ford and Bush
    // closures and the 2012 Sandy shutdown for the same reason.
    "2025-01-01": "New Year's Day",
    "2025-01-09": "National Day of Mourning (President Carter)",
    "2025-01-20": "Martin Luther King Jr. Day",
    "2025-02-17": "Washington's Birthday",
    "2025-04-18": "Good Friday",
    "2025-05-26": "Memorial Day",
    "2025-06-19": "Juneteenth National Independence Day",
    "2025-07-04": "Independence Day",
    "2025-09-01": "Labor Day",
    "2025-11-27": "Thanksgiving Day",
    "2025-12-25": "Christmas Day",

    // ---- 2026 -------------------------------------------------------------
    "2026-01-01": "New Year's Day",
    "2026-01-19": "Martin Luther King Jr. Day",
    "2026-02-16": "Washington's Birthday",
    "2026-04-03": "Good Friday",
    "2026-05-25": "Memorial Day",
    "2026-06-19": "Juneteenth National Independence Day",
    // 4 July 2026 is a Saturday → observed Friday 3 July.
    "2026-07-03": "Independence Day (observed)",
    "2026-09-07": "Labor Day",
    "2026-11-26": "Thanksgiving Day",
    "2026-12-25": "Christmas Day",

    // ---- 2027 -------------------------------------------------------------
    "2027-01-01": "New Year's Day",
    "2027-01-18": "Martin Luther King Jr. Day",
    "2027-02-15": "Washington's Birthday",
    "2027-03-26": "Good Friday",
    "2027-05-31": "Memorial Day",
    // 19 June 2027 is a Saturday → observed Friday 18 June.
    "2027-06-18": "Juneteenth National Independence Day (observed)",
    // 4 July 2027 is a Sunday → observed Monday 5 July.
    "2027-07-05": "Independence Day (observed)",
    "2027-09-06": "Labor Day",
    "2027-11-25": "Thanksgiving Day",
    // 25 December 2027 is a Saturday → observed Friday 24 December.
    "2027-12-24": "Christmas Day (observed)",

    // ---- 2028 -------------------------------------------------------------
    // NO New Year's Day entry: 1 January 2028 is a Saturday, and the NYSE
    // exception above means it is not observed at all. 2028 has NINE
    // full-day closures, not ten. The premise test knows this.
    "2028-01-17": "Martin Luther King Jr. Day",
    "2028-02-21": "Washington's Birthday",
    "2028-04-14": "Good Friday",
    "2028-05-29": "Memorial Day",
    "2028-06-19": "Juneteenth National Independence Day",
    "2028-07-04": "Independence Day",
    "2028-09-04": "Labor Day",
    "2028-11-23": "Thanksgiving Day",
    "2028-12-25": "Christmas Day",
  });

/**
 * HALF-DAY sessions: `rth` ends 13:00 ET instead of 16:00, and `post` runs
 * 13:00–20:00 ET. Keyed by observed ET calendar date, same as above.
 *
 * There are only three generators, and each one is conditional — which is
 * why this cannot be a rule and has to be a table:
 *
 *   1. The day AFTER Thanksgiving. Fires every year, since Thanksgiving is
 *      always a Thursday and the Friday is always a trading day.
 *   2. Christmas Eve, only when 24 December is itself a weekday AND is not
 *      the observed Christmas holiday. 2026 qualifies (Thu, with Christmas
 *      on the Friday). 2027 does NOT — 24 December is the OBSERVED
 *      Christmas closure, a full day off, so an early close there would
 *      re-open a shut exchange. 2028 does not either: 24 December is a
 *      Sunday.
 *   3. 3 July, only when it is a weekday and 4 July is a weekday holiday.
 *      2028 qualifies (Mon, ahead of Tue 4 July). 2026 does NOT — 3 July
 *      is the full-day OBSERVED holiday. 2027 does not — 3 July is a
 *      Saturday. The exchange does not shift this early close to another
 *      day when it lapses, so there is no 2 July 2026 half day.
 *
 * A missing entry here is the quiet failure mode: the day still trades, so
 * nothing 404s and nothing alarms — the module simply reports `rth` for
 * three hours after the closing bell, and a staleness alarm fires against
 * a feed that is correctly idle.
 */
export const US_EARLY_CLOSE_DAYS: Readonly<Record<string, string>> =
  Object.freeze({
    // ---- 2023 -------------------------------------------------------------
    // Back-filled with the holidays by MONEY-1373, from the three generators
    // above rather than by hand. All three years qualify for a 3 July half day
    // (Mon/Wed/Thu respectively, each ahead of a weekday 4 July). No Christmas
    // Eve half day in 2023: 24 December is a SUNDAY.
    "2023-07-03": "Day before Independence Day",
    "2023-11-24": "Day after Thanksgiving",

    // ---- 2024 -------------------------------------------------------------
    "2024-07-03": "Day before Independence Day",
    "2024-11-29": "Day after Thanksgiving",
    "2024-12-24": "Christmas Eve",

    // ---- 2025 -------------------------------------------------------------
    "2025-07-03": "Day before Independence Day",
    "2025-11-28": "Day after Thanksgiving",
    "2025-12-24": "Christmas Eve",

    // ---- 2026 -------------------------------------------------------------
    "2026-11-27": "Day after Thanksgiving",
    "2026-12-24": "Christmas Eve",

    // ---- 2027 -------------------------------------------------------------
    // No Christmas Eve half day: 2027-12-24 is the observed Christmas
    // CLOSURE (see US_MARKET_HOLIDAYS). No 3 July half day: it is a Saturday.
    "2027-11-26": "Day after Thanksgiving",

    // ---- 2028 -------------------------------------------------------------
    // No Christmas Eve half day: 2028-12-24 is a Sunday.
    "2028-07-03": "Day before Independence Day",
    "2028-11-24": "Day after Thanksgiving",
  });

/**
 * The inclusive ET-calendar-year range `US_MARKET_HOLIDAYS` actually
 * covers. Exported because the table is FINITE and its lapse is otherwise
 * invisible: outside this range `usMarketSession` answers the time-of-day
 * question honestly and knows about weekends, but it will call Christmas
 * 2029 an ordinary Tuesday.
 *
 * THE LOWER BOUND IS AS LOAD-BEARING AS THE UPPER ONE, which is not obvious
 * until a backfill walks into it. `first` was 2026 while the Databento
 * harvest walked 2023-03-28 onward using `isUsTradingDay` as its coverage
 * DENOMINATOR: every holiday in 2023-2025 counted as a missing session, ~10
 * false alarms a year, and the natural reading was "the vendor has gaps"
 * (MONEY-1373).
 *
 * `isUsHolidayCalendarCovered` turns that into a question a caller (or a
 * monitor, or a test) can ask, rather than a wrong answer nobody sees. It
 * is deliberately NOT enforced inside `usMarketSession`: throwing on an
 * out-of-range date would convert a stale calendar into a hard outage on
 * 1 January 2029, which is a worse trade than a handful of misread
 * holidays plus a visible signal.
 */
export const US_HOLIDAY_TABLE_YEARS: {
  readonly first: number;
  readonly last: number;
} = Object.freeze({ first: 2023, last: 2028 });

// ---------------------------------------------------------------------------
// ET wall-clock derivation
// ---------------------------------------------------------------------------

/**
 * Built once — a `DateTimeFormat` is stateless and costs real time to
 * construct, and this module is called on every alarm tick.
 *
 * `hourCycle: "h23"` rather than `hour12: false`: the two are not
 * interchangeable. Under `hour12: false` some ICU versions render midnight
 * as hour "24", which would make `minutesFromMidnight` 1440 and push every
 * midnight instant past the end of the day.
 */
const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

interface EtClock {
  /** ET calendar year. */
  year: number;
  /** ET calendar month, 1–12 (NOT the JS 0–11 convention). */
  month: number;
  /** ET calendar day of month, 1–31. */
  day: number;
  /** 0 Sun .. 6 Sat, for the ET calendar date. */
  weekday: number;
  /** Minutes since ET midnight, 0–1439. */
  minutesFromMidnight: number;
  /** `YYYY-MM-DD` ET calendar date — the holiday-table key. */
  dateKey: string;
}

/** Reject an Invalid Date loudly. See `usMarketSession` for the reasoning. */
function assertValidInstant(at: Date, fn: string): void {
  if (Number.isNaN(at.getTime())) {
    throw new TypeError(`${fn}: received an Invalid Date`);
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Project a UTC instant onto the America/New_York wall clock.
 *
 * `formatToParts` rather than parsing a formatted string: the string form
 * is locale- and ICU-version-dependent, the parts are not. The weekday is
 * derived arithmetically from the resulting ET calendar date instead of
 * being read off a localized `weekday` part, so no locale name-matching is
 * involved anywhere.
 */
function toEtClock(at: Date): EtClock {
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;

  for (const part of ET_FORMAT.formatToParts(at)) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      default:
        break;
    }
  }

  return {
    year,
    month,
    day,
    // Date.UTC on the ET calendar date gives a weekday that cannot be off
    // by a timezone, because no time-of-day is involved.
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    minutesFromMidnight: hour * 60 + minute,
    dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
  };
}

/**
 * The America/New_York UTC offset in milliseconds at a given instant
 * (-4h under EDT, -5h under EST).
 *
 * Derived, never assumed: read the ET wall clock, re-read it AS IF it were
 * UTC, and the difference is the offset.
 */
/**
 * CAVEAT: minute-aligned inputs only.
 *
 * This builds `Date.UTC(...)` with `seconds` and `ms` fixed at 0 but subtracts
 * the FULL `at.getTime()`, so for an instant that is not minute-aligned the
 * result is wrong by up to 59,999 ms. Latent rather than live: the only caller
 * is `etWallClockToUtc`, which is fed session boundaries (04:00, 09:30, 13:00,
 * 16:00, 20:00) — all minute-aligned, against whole-hour US offsets.
 *
 * Written down because this reads like a general-purpose helper and is not one.
 * A future caller passing `Date.now()` would get a plausible, slightly wrong
 * offset with nothing to reveal it.
 */
function etOffsetMs(at: Date): number {
  const c = toEtClock(at);
  const asUtc = Date.UTC(
    c.year,
    c.month - 1,
    c.day,
    Math.floor(c.minutesFromMidnight / 60),
    c.minutesFromMidnight % 60,
    0,
    0,
  );
  return asUtc - at.getTime();
}

/**
 * Inverse of `toEtClock`: build the UTC instant for an ET wall-clock time.
 *
 * Two-step fixed point. The first guess uses the offset at the pseudo-
 * instant (the wall clock read as UTC), which lands within an hour of the
 * answer; the second uses the offset at that guess, which is correct
 * unless the two are on opposite sides of a DST transition.
 *
 * Every wall-clock time this module converts is a session boundary —
 * 04:00, 09:30, 13:00, 16:00, 20:00 — and US transitions happen at 02:00
 * local, so none of them can land in the nonexistent 02:00–03:00 spring
 * gap or the repeated autumn hour. This helper is intentionally private
 * for that reason; it is not a general-purpose zoned-time constructor.
 */
function etWallClockToUtc(
  year: number,
  month: number,
  day: number,
  minutesFromMidnight: number,
): Date {
  const asUtc = Date.UTC(
    year,
    month - 1,
    day,
    Math.floor(minutesFromMidnight / 60),
    minutesFromMidnight % 60,
    0,
    0,
  );
  const firstGuess = asUtc - etOffsetMs(new Date(asUtc));
  return new Date(asUtc - etOffsetMs(new Date(firstGuess)));
}

// ---------------------------------------------------------------------------
// Calendar queries
// ---------------------------------------------------------------------------

/** The ET calendar date of an instant, as `YYYY-MM-DD`. */
export function usMarketDateKey(at: Date): string {
  assertValidInstant(at, "usMarketDateKey");
  return toEtClock(at).dateKey;
}

/**
 * Minutes since ET midnight, 0–1439 — MONEY-1373.
 *
 * Exported so the cost model can bucket a quote by time of day without
 * building a second ET clock. It is the same DST-aware conversion
 * `usMarketSession` reads, and that is the whole point: the offset changes
 * twice a year, and a private copy would put every summer quote an hour off
 * while the two implementations both looked correct in isolation. This repo
 * has paid for one-fact-two-spellings often enough to spend an export on it.
 */
export function usEtMinutesFromMidnight(at: Date): number {
  assertValidInstant(at, "usEtMinutesFromMidnight");
  return toEtClock(at).minutesFromMidnight;
}

/**
 * `YYYY-MM-DD` back to ET calendar parts, as an `EtClock` pinned at ET
 * midnight.
 *
 * Returning the same shape `toEtClock` returns is the point, not a
 * convenience: `isNonTradingDay` then answers the weekend/holiday question for
 * a KEY and for an INSTANT down one code path, so an edit to
 * `US_MARKET_HOLIDAYS` cannot come to mean two different things depending on
 * which door the caller came through.
 *
 * Rejects a malformed key AND an impossible date. The second half is the one
 * that hides: `Date.UTC(2026, 1, 30)` does not throw, it rolls forward to
 * 2 March — so the components are round-tripped and a move is raised. A
 * silently rolled date would hand back bounds for a day nobody asked about,
 * and every post-condition downstream would still look internally consistent.
 */
function parseUsDateKey(dateKey: string, fn: string): EtClock {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!parts) {
    throw new RangeError(
      `${fn}: expected an ET calendar date as YYYY-MM-DD, received ` +
        JSON.stringify(dateKey),
    );
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new RangeError(`${fn}: ${dateKey} is not a real calendar date`);
  }
  return {
    year,
    month,
    day,
    weekday: probe.getUTCDay(),
    minutesFromMidnight: 0,
    dateKey,
  };
}

/**
 * The UTC half-open interval `[startMs, endMs)` spanned by one ET calendar
 * day — MONEY-1373.
 *
 * ## Why this exists at all
 *
 * A caller that wants "the rows belonging to this US day" reaches for
 * `dayStart` and `dayStart + 86_400_000`, and that constant is wrong twice a
 * year in opposite directions. Handing the range out from here means the two
 * writers that share a session key (`tiingo-rt-sink-logic`'s
 * `groupBySymbolDay` and the candle sink's day-verdict query) cannot disagree
 * about where the day ends — which is the whole shape of the defect this
 * ticket fixes one layer up.
 *
 * ## Post-conditions, which the tests assert rather than trust
 *
 *   usMarketDateKey(new Date(startMs))   === dateKey
 *   usMarketDateKey(new Date(endMs - 1)) === dateKey
 *   endMs > startMs, always
 *
 * and the two that make the point:
 *
 *   2026-03-08 is 23 hours long   (spring forward, 02:00 EST -> 03:00 EDT)
 *   2026-11-01 is 25 hours long   (fall back,      02:00 EDT -> 01:00 EST)
 *
 * Both dates were verified against the runtime's own tzdata before being
 * pinned — 2026-03-08 is the second Sunday in March and 2026-11-01 the first
 * Sunday in November, which is the post-2007 US rule. They are Sundays, so
 * neither is a trading day; the arithmetic is what matters, not the session.
 *
 * ET midnight is safe to convert even on those days: US transitions happen at
 * 02:00 local, so midnight never lands in the nonexistent spring gap or the
 * repeated autumn hour, which is the precondition `etWallClockToUtc`
 * documents for itself.
 *
 * Throws `RangeError` on a malformed or impossible key rather than returning
 * a plausible range — a wrong window silently selects the wrong rows.
 */
export function usMarketDayBoundsUtc(dateKey: string): {
  startMs: number;
  endMs: number;
} {
  const c = parseUsDateKey(dateKey, "usMarketDayBoundsUtc");
  // Date.UTC rolls month and year over for us; no calendar arithmetic here.
  const next = new Date(Date.UTC(c.year, c.month - 1, c.day + 1));
  return {
    startMs: etWallClockToUtc(c.year, c.month, c.day, 0).getTime(),
    endMs: etWallClockToUtc(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      0,
    ).getTime(),
  };
}

/**
 * Does the exchange trade at all on this ET calendar date? — MONEY-1373.
 *
 * Weekday and not a full-day closure. An EARLY-CLOSE day IS a trading day:
 * `US_EARLY_CLOSE_DAYS` moves the `rth` boundary to 13:00 ET and leaves `post`
 * running to 20:00, so the session is shorter, not absent. A caller that
 * treated a half day as non-trading would skip the day after Thanksgiving
 * every year.
 *
 * Same `US_HOLIDAY_TABLE_YEARS` caveat as `usMarketSession`: outside the
 * table's range this is a weekday answer with no holiday knowledge behind it.
 * Ask `isUsHolidayCalendarCovered` if that matters to you.
 */
export function isUsTradingDay(dateKey: string): boolean {
  return !isNonTradingDay(parseUsDateKey(dateKey, "isUsTradingDay"));
}

/**
 * The holiday NAME if the ET calendar date of `at` is a full-day NYSE /
 * Nasdaq closure, else `null`. Weekends are NOT holidays — they are
 * handled separately, so this stays a question about the calendar.
 */
export function getUsMarketHoliday(at: Date): string | null {
  assertValidInstant(at, "getUsMarketHoliday");
  return US_MARKET_HOLIDAYS[toEtClock(at).dateKey] ?? null;
}

/**
 * The reason NAME if the ET calendar date of `at` is a 13:00 ET early
 * close, else `null`.
 */
export function getUsEarlyClose(at: Date): string | null {
  assertValidInstant(at, "getUsEarlyClose");
  return US_EARLY_CLOSE_DAYS[toEtClock(at).dateKey] ?? null;
}

/**
 * Whether `US_MARKET_HOLIDAYS` actually has an opinion about the ET
 * calendar year of `at`. False means the answer from `usMarketSession` is
 * a weekday-and-clock answer with no holiday knowledge behind it — see
 * `US_HOLIDAY_TABLE_YEARS`.
 */
export function isUsHolidayCalendarCovered(at: Date): boolean {
  assertValidInstant(at, "isUsHolidayCalendarCovered");
  const { year } = toEtClock(at);
  return (
    year >= US_HOLIDAY_TABLE_YEARS.first && year <= US_HOLIDAY_TABLE_YEARS.last
  );
}

/** Saturday or Sunday on the ET calendar. */
function isWeekend(clock: EtClock): boolean {
  return clock.weekday === 0 || clock.weekday === 6;
}

/** Non-trading ET calendar day: weekend or full-day holiday. */
function isNonTradingDay(clock: EtClock): boolean {
  return isWeekend(clock) || US_MARKET_HOLIDAYS[clock.dateKey] !== undefined;
}

/** The minute `rth` ends on a given ET calendar day. */
function rthCloseMinutes(clock: EtClock): number {
  return US_EARLY_CLOSE_DAYS[clock.dateKey] !== undefined
    ? US_EARLY_CLOSE_MINUTES
    : US_RTH_CLOSE_MINUTES;
}

// ---------------------------------------------------------------------------
// Session classification
// ---------------------------------------------------------------------------

/**
 * Classify an instant into one of the four US extended-hours sessions.
 *
 * An Invalid Date THROWS rather than resolving to anything. Both defaults
 * would be wrong in a way nobody would notice: `"closed"` disarms a
 * staleness alarm forever, `"rth"` makes it scream at a correctly idle
 * feed. "We could not tell" is a distinct outcome and it is raised as one.
 */
export function usMarketSession(at: Date): UsMarketSession {
  assertValidInstant(at, "usMarketSession");
  const clock = toEtClock(at);

  // A holiday or a weekend is closed at every hour of the ET day, including
  // the 04:00–20:00 window that would otherwise read as pre/rth/post.
  if (isNonTradingDay(clock)) return "closed";

  const m = clock.minutesFromMidnight;
  if (m < US_PRE_OPEN_MINUTES) return "closed";
  if (m < US_RTH_OPEN_MINUTES) return "pre";
  if (m < rthCloseMinutes(clock)) return "rth";
  if (m < US_POST_CLOSE_MINUTES) return "post";
  return "closed";
}

/** True only during regular trading hours. Pre and post are not "open". */
export function isUsMarketOpen(at: Date): boolean {
  return usMarketSession(at) === "rth";
}

/**
 * The next instant at which `usMarketSession(at)` changes its answer:
 * the end of the current session, or the start of the next one when the
 * market is closed.
 *
 * This is what lets a staleness alarm ARM and DISARM instead of polling —
 * schedule a wake-up here, re-classify, repeat. It is exact to the minute
 * and DST-correct in both directions, so an alarm set at 15:00 ET on the
 * Friday before a spring-forward Sunday still wakes at the right absolute
 * instant.
 *
 * Search is bounded at 10 ET days, which comfortably clears the longest
 * real run of non-trading days (a Thu/Fri holiday pair straddling a
 * weekend is four). If the bound is ever hit — only reachable by a table
 * edit that closes the exchange for a fortnight — it throws rather than
 * returning a plausible wrong date.
 */
export function nextUsSessionBoundary(at: Date): Date {
  assertValidInstant(at, "nextUsSessionBoundary");
  const clock = toEtClock(at);

  if (!isNonTradingDay(clock)) {
    const m = clock.minutesFromMidnight;
    // Each in-day boundary is the start of the NEXT state.
    const upcoming = [
      US_PRE_OPEN_MINUTES,
      US_RTH_OPEN_MINUTES,
      rthCloseMinutes(clock),
      US_POST_CLOSE_MINUTES,
    ];
    for (const boundary of upcoming) {
      if (m < boundary) {
        return etWallClockToUtc(clock.year, clock.month, clock.day, boundary);
      }
    }
    // Past 20:00 ET — fall through to the next trading day's 04:00.
  }

  // Walk forward to the next trading day and return its 04:00 ET.
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Anchor at noon ET so a DST shift can never push the probe onto the
  // wrong calendar day while stepping.
  let probe = etWallClockToUtc(clock.year, clock.month, clock.day, 12 * 60);
  for (let i = 0; i < 10; i++) {
    probe = new Date(probe.getTime() + DAY_MS);
    const next = toEtClock(probe);
    if (isNonTradingDay(next)) continue;
    return etWallClockToUtc(
      next.year,
      next.month,
      next.day,
      US_PRE_OPEN_MINUTES,
    );
  }
  throw new RangeError(
    `nextUsSessionBoundary: no trading day within 10 days of ${clock.dateKey}`,
  );
}

/**
 * The ET date of the most recent US session that has FINISHED — MONEY-1373.
 *
 * "Finished" is `US_POST_CLOSE_MINUTES` (20:00 ET), the end of the feed's day,
 * not the closing bell. That holds on an EARLY-CLOSE day too, and it is worth
 * saying because it reads like an exception and is not: `US_EARLY_CLOSE_DAYS`
 * is consulted only by `rthCloseMinutes`, which moves the `rth` -> `post`
 * boundary to 13:00 ET. `usMarketSession`'s last comparison is against
 * `US_POST_CLOSE_MINUTES` unconditionally, so post-market runs 13:00–20:00 on
 * a half day and the day still completes at 20:00 ET. Anyone who "fixed" this
 * to close a half day at 13:00 would declare the session complete while seven
 * hours of extended-hours quotes were still arriving.
 *
 * Today counts only once it is over: at 19:59 ET this returns YESTERDAY's
 * session, at 20:01 ET it returns today. A weekend or a holiday is never
 * returned — the walk steps back to the previous TRADING day.
 *
 * The step is noon-anchored, the same discipline `nextUsSessionBoundary` uses:
 * a DST shift moves the probe by an hour, and from noon an hour cannot reach
 * another calendar day. Bounded at 15 steps, which clears any real run of
 * closures by a wide margin (the longest is four), and it THROWS rather than
 * returning a plausible wrong date — a silently wrong session date is a whole
 * day of rows filed under the wrong key.
 */
export function lastCompletedUsSession(now: Date): string {
  assertValidInstant(now, "lastCompletedUsSession");
  const clock = toEtClock(now);

  if (
    !isNonTradingDay(clock) &&
    clock.minutesFromMidnight >= US_POST_CLOSE_MINUTES
  ) {
    return clock.dateKey;
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  let probe = etWallClockToUtc(clock.year, clock.month, clock.day, 12 * 60);
  for (let i = 0; i < 15; i++) {
    probe = new Date(probe.getTime() - DAY_MS);
    const prev = toEtClock(probe);
    if (!isNonTradingDay(prev)) return prev.dateKey;
  }
  throw new RangeError(
    `lastCompletedUsSession: no trading day within 15 days before ${clock.dateKey}`,
  );
}

/**
 * Badge text for a session. Unlike `formatClosedReason` in the NSE module
 * this is total — it names the open state too — because the US grid has
 * three non-closed states and a caller cannot render "LIVE" for all of
 * them.
 */
export function usSessionLabel(session: UsMarketSession): string {
  switch (session) {
    case "pre":
      return "Pre-market";
    case "rth":
      return "Open";
    case "post":
      return "After-hours";
    case "closed":
      return "Closed";
  }
}
