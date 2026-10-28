/**
 * US (NYSE / Nasdaq) market-hours session detector tests.
 *
 * Source: packages/core/src/market-data/us-market-hours.ts
 *
 * WHAT THESE TESTS ARE FOR, in order of how badly each failure hides:
 *
 *   1. DST. The module's whole reason for using `Intl` instead of the
 *      hand-rolled offset its NSE sibling uses is that ET moves twice a
 *      year. A fixed `-05:00` produces plausible sessions all year and
 *      wrong ones for eight months. The DST tests below assert on the SAME
 *      UTC INSTANT either side of a transition — 13:45Z is `pre` in the
 *      first week of March and `rth` in the second — so an offset constant
 *      cannot make them both pass. Mutation-verified: replacing the Intl
 *      derivation with a fixed -05:00 reddens them.
 *   2. THE EARLY-CLOSE TABLE. This one fails SILENTLY in production. The
 *      day still trades, nothing 404s, nothing alarms — the module just
 *      reports `rth` for three hours after the closing bell, and a
 *      staleness alarm screams at a feed that is correctly idle. Nothing
 *      upstream would tell us.
 *   3. THE OBSERVED-vs-NOMINAL HOLIDAY RULE. A table keyed on nominal
 *      dates looks completely normal: every entry is a real holiday, and
 *      the weekend rule hides the mistake because the nominal date is a
 *      Saturday the exchange is shut on anyway. What is LOST is the
 *      weekday the exchange actually closed, which then reads as open. The
 *      premise block asserts no holiday key falls on a weekend, which is
 *      exactly the shape that mistake takes.
 *   4. BOUNDARIES TO THE MINUTE. Off by one minute at 09:30 and the alarm
 *      is armed 60 seconds early every single trading day.
 *
 * DELIBERATELY NOT USING THE MODULE'S OWN ZONE MATH TO BUILD THE FIXTURES.
 * `et()` below takes the UTC offset as an EXPLICIT ARGUMENT supplied by
 * the test author (5 for EST, 4 for EDT). If the helper called back into
 * the module's timezone derivation, a bug there would cancel out against
 * itself and every assertion would pass over broken source.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  US_EARLY_CLOSE_DAYS,
  US_EARLY_CLOSE_MINUTES,
  US_HOLIDAY_TABLE_YEARS,
  US_MARKET_HOLIDAYS,
  US_POST_CLOSE_MINUTES,
  US_PRE_OPEN_MINUTES,
  US_RTH_CLOSE_MINUTES,
  US_RTH_OPEN_MINUTES,
  getUsEarlyClose,
  getUsMarketHoliday,
  isUsHolidayCalendarCovered,
  isUsMarketOpen,
  isUsTradingDay,
  lastCompletedUsSession,
  nextUsSessionBoundary,
  usMarketDateKey,
  usMarketDayBoundsUtc,
  usMarketSession,
  usSessionLabel,
  type UsMarketSession,
} from "../../src/market-data/us-market-hours";

/** UTC offset hours to SUBTRACT from ET to reach UTC. Stated per-test. */
const EST = 5;
const EDT = 4;

/**
 * Build the UTC instant for an ET wall clock. The offset is an argument,
 * not a lookup: the test author asserts which side of DST the date is on,
 * so the module cannot supply the answer to its own exam.
 */
function et(
  year: number,
  month: number,
  day: number,
  hh: number,
  mm: number,
  utcOffsetHours: number,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, hh + utcOffsetHours, mm, 0, 0),
  );
}

/** ISO 8601 UTC literal — used where the POINT is a fixed absolute instant. */
function utc(iso: string): Date {
  return new Date(iso);
}

// ---------------------------------------------------------------------------
// 1. Session boundaries, to the minute
// ---------------------------------------------------------------------------

describe("usMarketSession — session boundaries on a normal day", () => {
  // Wednesday 18 February 2026. EST (UTC-5), no holiday, no early close.
  const day = (hh: number, mm: number) => et(2026, 2, 18, hh, mm, EST);

  it("closed one minute before the feed day opens (03:59 ET)", () => {
    assert.equal(usMarketSession(day(3, 59)), "closed");
  });

  it("pre at exactly 04:00 ET", () => {
    assert.equal(usMarketSession(day(4, 0)), "pre");
  });

  it("still pre one minute before the bell (09:29 ET)", () => {
    assert.equal(usMarketSession(day(9, 29)), "pre");
  });

  it("rth at exactly 09:30 ET", () => {
    assert.equal(usMarketSession(day(9, 30)), "rth");
  });

  it("still rth one minute before the close (15:59 ET)", () => {
    assert.equal(usMarketSession(day(15, 59)), "rth");
  });

  it("post at exactly 16:00 ET", () => {
    assert.equal(usMarketSession(day(16, 0)), "post");
  });

  it("still post one minute before the feed day ends (19:59 ET)", () => {
    assert.equal(usMarketSession(day(19, 59)), "post");
  });

  it("closed at exactly 20:00 ET", () => {
    assert.equal(usMarketSession(day(20, 0)), "closed");
  });

  it("closed at ET midnight", () => {
    // hourCycle h23 territory: under `hour12: false` some ICU builds render
    // midnight as hour 24, which would put this instant past 20:00 and still
    // return "closed" — for entirely the wrong reason. 00:30 pins the rest
    // of that hour so the two cannot both be explained by the same slip.
    assert.equal(usMarketSession(day(0, 0)), "closed");
    assert.equal(usMarketSession(day(0, 30)), "closed");
  });
});

describe("usMarketSession — the same grid holds under EDT", () => {
  // Wednesday 17 June 2026. EDT (UTC-4). Juneteenth is the 19th, a Friday,
  // so this Wednesday is an ordinary full session.
  const day = (hh: number, mm: number) => et(2026, 6, 17, hh, mm, EDT);

  it("04:00 / 09:30 / 16:00 / 20:00 ET land identically in summer", () => {
    assert.equal(usMarketSession(day(3, 59)), "closed");
    assert.equal(usMarketSession(day(4, 0)), "pre");
    assert.equal(usMarketSession(day(9, 29)), "pre");
    assert.equal(usMarketSession(day(9, 30)), "rth");
    assert.equal(usMarketSession(day(15, 59)), "rth");
    assert.equal(usMarketSession(day(16, 0)), "post");
    assert.equal(usMarketSession(day(19, 59)), "post");
    assert.equal(usMarketSession(day(20, 0)), "closed");
  });
});

// ---------------------------------------------------------------------------
// 2. DST — both directions, on the SAME UTC instant
// ---------------------------------------------------------------------------

describe("usMarketSession — DST forward (second Sunday in March)", () => {
  // US DST begins 02:00 local on Sunday 8 March 2026.
  //
  // 13:45Z is the whole test. It is 08:45 ET under EST and 09:45 ET under
  // EDT — one is before the opening bell, the other is a quarter-hour into
  // the session. A fixed offset MUST get one of them wrong.
  it("13:45Z is pre on the Friday before, rth on the Monday after (2026)", () => {
    const before = utc("2026-03-06T13:45:00Z"); // Fri, EST -> 08:45 ET
    const after = utc("2026-03-09T13:45:00Z"); // Mon, EDT -> 09:45 ET

    assert.equal(usMarketSession(before), "pre");
    assert.equal(usMarketSession(after), "rth");
    assert.notEqual(
      usMarketSession(before),
      usMarketSession(after),
      "same UTC wall time must classify differently across the transition",
    );
  });

  it("13:45Z does the same across the 2027 transition (14 March)", () => {
    // Not the same dates — a second year proves the module reads tzdata
    // rather than special-casing one weekend.
    assert.equal(usMarketSession(utc("2027-03-12T13:45:00Z")), "pre"); // Fri EST
    assert.equal(usMarketSession(utc("2027-03-15T13:45:00Z")), "rth"); // Mon EDT
  });

  it("the ET wall clock itself shifts by exactly one hour", () => {
    // Falsifies the same mutation from the other side: the SESSION could in
    // principle agree by luck; the date key + boundary cannot.
    assert.equal(usMarketDateKey(utc("2026-03-06T13:45:00Z")), "2026-03-06");
    assert.equal(usMarketDateKey(utc("2026-03-09T13:45:00Z")), "2026-03-09");
    // 09:30 ET on the Monday is 13:30Z under EDT, not 14:30Z.
    assert.equal(
      nextUsSessionBoundary(utc("2026-03-09T12:00:00Z")).toISOString(),
      "2026-03-09T13:30:00.000Z",
    );
  });
});

describe("usMarketSession — DST back (first Sunday in November)", () => {
  // US DST ends 02:00 local on Sunday 1 November 2026.
  it("13:45Z is rth on the Friday before, pre on the Monday after (2026)", () => {
    const before = utc("2026-10-30T13:45:00Z"); // Fri, EDT -> 09:45 ET
    const after = utc("2026-11-02T13:45:00Z"); // Mon, EST -> 08:45 ET

    assert.equal(usMarketSession(before), "rth");
    assert.equal(usMarketSession(after), "pre");
    assert.notEqual(usMarketSession(before), usMarketSession(after));
  });

  it("13:45Z does the same across the 2027 transition (7 November)", () => {
    assert.equal(usMarketSession(utc("2027-11-05T13:45:00Z")), "rth"); // Fri EDT
    assert.equal(usMarketSession(utc("2027-11-08T13:45:00Z")), "pre"); // Mon EST
  });

  it("the closing bell moves an hour later in UTC after the fall back", () => {
    // 16:00 ET = 20:00Z under EDT, 21:00Z under EST.
    assert.equal(
      nextUsSessionBoundary(utc("2026-10-30T18:00:00Z")).toISOString(),
      "2026-10-30T20:00:00.000Z",
    );
    assert.equal(
      nextUsSessionBoundary(utc("2026-11-02T18:00:00Z")).toISOString(),
      "2026-11-02T21:00:00.000Z",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Full-day holidays
// ---------------------------------------------------------------------------

describe("usMarketSession — a full holiday is closed at every hour", () => {
  it("Thanksgiving Day, Thursday 26 November 2026", () => {
    assert.equal(
      getUsMarketHoliday(et(2026, 11, 26, 12, 0, EST)),
      "Thanksgiving Day",
    );
    for (let hh = 0; hh < 24; hh++) {
      assert.equal(
        usMarketSession(et(2026, 11, 26, hh, 0, EST)),
        "closed",
        `Thanksgiving ${hh}:00 ET must be closed`,
      );
      assert.equal(isUsMarketOpen(et(2026, 11, 26, hh, 30, EST)), false);
    }
  });

  it("the Wednesday before Thanksgiving is an ordinary full session", () => {
    // The control. Without it, "closed all day" would also pass if the
    // module had simply stopped classifying anything as rth in November.
    assert.equal(usMarketSession(et(2026, 11, 25, 12, 0, EST)), "rth");
    assert.equal(getUsMarketHoliday(et(2026, 11, 25, 12, 0, EST)), null);
  });

  it("Good Friday and Juneteenth 2026 are closed during rth hours", () => {
    assert.equal(usMarketSession(et(2026, 4, 3, 11, 0, EDT)), "closed");
    assert.equal(usMarketSession(et(2026, 6, 19, 11, 0, EDT)), "closed");
  });
});

describe("US holidays observed on a shifted weekday", () => {
  it("Independence Day 2027 falls on a SUNDAY and is observed the Monday", () => {
    // 4 July 2027 is a Sunday. The exchange closes Monday the 5th. A table
    // keyed on the NOMINAL date would leave Monday reading as a full
    // session — the mistake this test exists to catch.
    assert.equal(
      getUsMarketHoliday(et(2027, 7, 5, 11, 0, EDT)),
      "Independence Day (observed)",
    );
    assert.equal(usMarketSession(et(2027, 7, 5, 11, 0, EDT)), "closed");

    // Both neighbours trade, so the whole week is not simply blacked out.
    assert.equal(usMarketSession(et(2027, 7, 2, 11, 0, EDT)), "rth"); // Fri
    assert.equal(usMarketSession(et(2027, 7, 6, 11, 0, EDT)), "rth"); // Tue

    // The nominal Sunday is closed too, but as a WEEKEND, not a holiday.
    assert.equal(usMarketSession(et(2027, 7, 4, 11, 0, EDT)), "closed");
    assert.equal(getUsMarketHoliday(et(2027, 7, 4, 11, 0, EDT)), null);
  });

  it("Independence Day 2026 falls on a SATURDAY and is observed the Friday", () => {
    assert.equal(
      getUsMarketHoliday(et(2026, 7, 3, 11, 0, EDT)),
      "Independence Day (observed)",
    );
    assert.equal(usMarketSession(et(2026, 7, 3, 11, 0, EDT)), "closed");
    assert.equal(usMarketSession(et(2026, 7, 6, 11, 0, EDT)), "rth"); // Mon
  });

  it("New Year's Day on a SATURDAY is not observed at all (NYSE exception)", () => {
    // 1 January 2028 is a Saturday. Unlike every other holiday, the NYSE
    // does NOT shut the preceding Friday, and does not take the Monday
    // either. Both neighbours are full sessions.
    assert.equal(usMarketSession(et(2027, 12, 31, 11, 0, EST)), "rth"); // Fri
    assert.equal(usMarketSession(et(2028, 1, 3, 11, 0, EST)), "rth"); // Mon
    assert.equal(getUsMarketHoliday(et(2027, 12, 31, 11, 0, EST)), null);
    assert.equal(getUsMarketHoliday(et(2028, 1, 3, 11, 0, EST)), null);
    assert.equal(US_MARKET_HOLIDAYS["2028-01-01"], undefined);
  });
});

// ---------------------------------------------------------------------------
// 4. Early closes
// ---------------------------------------------------------------------------

describe("usMarketSession — early-close days end rth at 13:00 ET", () => {
  it("day after Thanksgiving 2026 (Fri 27 Nov): 13:00 ET is post, not rth", () => {
    const day = (hh: number, mm: number) => et(2026, 11, 27, hh, mm, EST);

    assert.equal(getUsEarlyClose(day(12, 0)), "Day after Thanksgiving");
    assert.equal(usMarketSession(day(12, 59)), "rth");
    assert.equal(usMarketSession(day(13, 0)), "post");
    assert.equal(isUsMarketOpen(day(13, 0)), false);

    // 15:00 ET would be rth on any normal day. Here it is after-hours.
    assert.equal(usMarketSession(day(15, 0)), "post");
    assert.equal(usMarketSession(day(15, 59)), "post");

    // Pre is untouched, and the feed day still ends at 20:00.
    assert.equal(usMarketSession(day(4, 0)), "pre");
    assert.equal(usMarketSession(day(19, 59)), "post");
    assert.equal(usMarketSession(day(20, 0)), "closed");
  });

  it("Christmas Eve 2026 (Thu 24 Dec) is an early close", () => {
    assert.equal(usMarketSession(et(2026, 12, 24, 12, 59, EST)), "rth");
    assert.equal(usMarketSession(et(2026, 12, 24, 13, 0, EST)), "post");
    // Christmas Day itself is a full closure.
    assert.equal(usMarketSession(et(2026, 12, 25, 12, 0, EST)), "closed");
  });

  it("3 July 2028 (Mon, ahead of Tue 4 July) is an early close, under EDT", () => {
    // Under EDT, so the mutation "hardcode EST" cannot pass this one either.
    assert.equal(usMarketSession(et(2028, 7, 3, 12, 59, EDT)), "rth");
    assert.equal(usMarketSession(et(2028, 7, 3, 13, 0, EDT)), "post");
    assert.equal(usMarketSession(et(2028, 7, 4, 12, 0, EDT)), "closed");
    assert.equal(usMarketSession(et(2028, 7, 5, 12, 0, EDT)), "rth");
  });

  it("a normal day at 13:00 ET is still rth — the control", () => {
    // Without this, deleting the early-close table entirely would still let
    // "13:00 is post" pass if the module had simply moved the close to 13:00
    // for everyone.
    assert.equal(usMarketSession(et(2026, 11, 25, 13, 0, EST)), "rth");
    assert.equal(usMarketSession(et(2026, 11, 25, 15, 59, EST)), "rth");
    assert.equal(getUsEarlyClose(et(2026, 11, 25, 13, 0, EST)), null);
  });
});

// ---------------------------------------------------------------------------
// 5. Weekends
// ---------------------------------------------------------------------------

describe("usMarketSession — weekends are closed at every hour", () => {
  it("Saturday 18 April 2026", () => {
    for (let hh = 0; hh < 24; hh++) {
      assert.equal(usMarketSession(et(2026, 4, 18, hh, 0, EDT)), "closed");
    }
    assert.equal(getUsMarketHoliday(et(2026, 4, 18, 11, 0, EDT)), null);
  });

  it("Sunday 19 April 2026", () => {
    for (let hh = 0; hh < 24; hh++) {
      assert.equal(usMarketSession(et(2026, 4, 19, hh, 0, EDT)), "closed");
    }
  });

  it("the surrounding Friday and Monday are full sessions", () => {
    assert.equal(usMarketSession(et(2026, 4, 17, 11, 0, EDT)), "rth");
    assert.equal(usMarketSession(et(2026, 4, 20, 11, 0, EDT)), "rth");
  });

  it("the weekend is scored on the ET calendar, not UTC", () => {
    // 2026-04-18T02:00Z is still FRIDAY 22:00 ET — closed, but because the
    // feed day ended at 20:00, not because it is Saturday. And
    // 2026-04-20T02:00Z is still SUNDAY 22:00 ET. A UTC-based weekend test
    // gets both of these backwards.
    assert.equal(usMarketDateKey(utc("2026-04-18T02:00:00Z")), "2026-04-17");
    assert.equal(usMarketDateKey(utc("2026-04-20T02:00:00Z")), "2026-04-19");
    assert.equal(usMarketSession(utc("2026-04-18T02:00:00Z")), "closed");
  });
});

// ---------------------------------------------------------------------------
// 6. isUsMarketOpen
// ---------------------------------------------------------------------------

describe("isUsMarketOpen", () => {
  it("is true only for rth, never for pre or post", () => {
    assert.equal(isUsMarketOpen(et(2026, 2, 18, 4, 0, EST)), false); // pre
    assert.equal(isUsMarketOpen(et(2026, 2, 18, 9, 29, EST)), false); // pre
    assert.equal(isUsMarketOpen(et(2026, 2, 18, 9, 30, EST)), true); // rth
    assert.equal(isUsMarketOpen(et(2026, 2, 18, 15, 59, EST)), true); // rth
    assert.equal(isUsMarketOpen(et(2026, 2, 18, 16, 0, EST)), false); // post
    assert.equal(isUsMarketOpen(et(2026, 2, 18, 20, 0, EST)), false); // closed
  });

  it("agrees with usMarketSession across a whole trading day, minute by minute", () => {
    // The two must never disagree — this is the definition, asserted rather
    // than assumed, across all 1,440 minutes of an early-close day (the day
    // most likely to expose a disagreement).
    for (let m = 0; m < 24 * 60; m++) {
      const at = et(2026, 11, 27, Math.floor(m / 60), m % 60, EST);
      assert.equal(isUsMarketOpen(at), usMarketSession(at) === "rth");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. nextUsSessionBoundary
// ---------------------------------------------------------------------------

describe("nextUsSessionBoundary — arming and disarming an alarm", () => {
  it("returns each in-day boundary on a normal session", () => {
    const day = (hh: number, mm: number) => et(2026, 2, 18, hh, mm, EST);
    const at = (hh: number, mm: number) => day(hh, mm).toISOString();

    assert.equal(nextUsSessionBoundary(day(2, 0)).toISOString(), at(4, 0));
    assert.equal(nextUsSessionBoundary(day(4, 0)).toISOString(), at(9, 30));
    assert.equal(nextUsSessionBoundary(day(9, 29)).toISOString(), at(9, 30));
    assert.equal(nextUsSessionBoundary(day(9, 30)).toISOString(), at(16, 0));
    assert.equal(nextUsSessionBoundary(day(15, 59)).toISOString(), at(16, 0));
    assert.equal(nextUsSessionBoundary(day(16, 0)).toISOString(), at(20, 0));
    assert.equal(nextUsSessionBoundary(day(19, 59)).toISOString(), at(20, 0));
  });

  it("skips a weekend after Friday's 20:00 ET", () => {
    // Friday 17 April 2026, 20:00 ET -> Monday 20 April, 04:00 ET.
    assert.equal(
      nextUsSessionBoundary(et(2026, 4, 17, 20, 0, EDT)).toISOString(),
      et(2026, 4, 20, 4, 0, EDT).toISOString(),
    );
  });

  it("skips a holiday and the weekend behind it", () => {
    // Wed 25 Nov 2026 20:00 ET -> Thanksgiving is Thursday -> Friday 27th.
    assert.equal(
      nextUsSessionBoundary(et(2026, 11, 25, 20, 0, EST)).toISOString(),
      et(2026, 11, 27, 4, 0, EST).toISOString(),
    );
    // From inside Thanksgiving itself, at any hour.
    assert.equal(
      nextUsSessionBoundary(et(2026, 11, 26, 11, 0, EST)).toISOString(),
      et(2026, 11, 27, 4, 0, EST).toISOString(),
    );
    // Christmas 2026 is a Friday -> next is Monday 28 December.
    assert.equal(
      nextUsSessionBoundary(et(2026, 12, 25, 11, 0, EST)).toISOString(),
      et(2026, 12, 28, 4, 0, EST).toISOString(),
    );
  });

  it("returns 13:00 ET as the rth boundary on an early-close day", () => {
    assert.equal(
      nextUsSessionBoundary(et(2026, 11, 27, 10, 0, EST)).toISOString(),
      et(2026, 11, 27, 13, 0, EST).toISOString(),
    );
    assert.equal(
      nextUsSessionBoundary(et(2026, 11, 27, 13, 0, EST)).toISOString(),
      et(2026, 11, 27, 20, 0, EST).toISOString(),
    );
  });

  it("stays correct in absolute time across a spring-forward weekend", () => {
    // An alarm armed Friday 6 March 2026 at 20:00 ET (EST) must wake at
    // Monday 04:00 ET — which is 08:00Z under EDT, NOT 09:00Z. A module
    // that computed the target by adding a fixed number of hours to the
    // arming instant would be an hour late every March.
    assert.equal(
      nextUsSessionBoundary(utc("2026-03-07T01:00:00Z")).toISOString(),
      "2026-03-09T08:00:00.000Z",
    );
    // And an hour early every November, symmetrically: Friday 30 October
    // 2026 20:00 EDT -> Monday 04:00 EST = 09:00Z.
    assert.equal(
      nextUsSessionBoundary(utc("2026-10-31T00:00:00Z")).toISOString(),
      "2026-11-02T09:00:00.000Z",
    );
  });

  it("always lands strictly in the future, on an actual change of session", () => {
    // The property that makes it usable as an alarm: re-classifying one
    // millisecond BEFORE the returned instant must give the current answer,
    // and AT it must give a different one. Swept across a fortnight that
    // contains a weekend, a full holiday and an early close.
    const start = utc("2026-11-20T00:00:00Z");
    const stepMs = 37 * 60 * 1000; // 37 minutes — coprime with the hour grid
    for (let i = 0; i < 14 * 24 * 60 * 60 * 1000; i += stepMs) {
      const at = new Date(start.getTime() + i);
      const boundary = nextUsSessionBoundary(at);
      assert.ok(
        boundary.getTime() > at.getTime(),
        `boundary ${boundary.toISOString()} must be after ${at.toISOString()}`,
      );
      assert.equal(
        usMarketSession(new Date(boundary.getTime() - 1)),
        usMarketSession(at),
        `session must not change between ${at.toISOString()} and the ms before ${boundary.toISOString()}`,
      );
      assert.notEqual(
        usMarketSession(boundary),
        usMarketSession(at),
        `session must actually change at ${boundary.toISOString()}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 8. usSessionLabel
// ---------------------------------------------------------------------------

describe("usSessionLabel", () => {
  it("names every session, with no empty or duplicated label", () => {
    const sessions: readonly UsMarketSession[] = [
      "closed",
      "pre",
      "rth",
      "post",
    ];
    const labels = sessions.map(usSessionLabel);
    assert.deepEqual(labels, ["Closed", "Pre-market", "Open", "After-hours"]);
    assert.equal(new Set(labels).size, sessions.length);
    for (const label of labels) assert.ok(label.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 9. PREMISE — the tests above are only meaningful if the tables are real
// ---------------------------------------------------------------------------

describe("premise: the holiday and early-close tables are well-formed", () => {
  const KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

  /** Parse a table key back to its ET calendar parts, independently. */
  function parseKey(key: string): { y: number; m: number; d: number } {
    const match = KEY.exec(key);
    assert.ok(match, `table key ${key} must be YYYY-MM-DD`);
    return {
      y: Number(match[1]),
      m: Number(match[2]),
      d: Number(match[3]),
    };
  }

  function weekdayOf(key: string): number {
    const { y, m, d } = parseKey(key);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  it("the holiday table is non-empty", () => {
    // If this is ever 0 every "closed on a holiday" assertion above passes
    // vacuously for weekend/clock reasons instead.
    assert.ok(
      Object.keys(US_MARKET_HOLIDAYS).length >= 25,
      `expected at least 25 holidays across ${US_HOLIDAY_TABLE_YEARS.first}-${US_HOLIDAY_TABLE_YEARS.last}`,
    );
  });

  it("every holiday key parses, round-trips, and names a holiday", () => {
    for (const [key, name] of Object.entries(US_MARKET_HOLIDAYS)) {
      const { y, m, d } = parseKey(key);
      // Round-trip through the module's own ET projection at ET noon, which
      // no offset can push onto an adjacent day.
      assert.equal(
        usMarketDateKey(new Date(Date.UTC(y, m - 1, d, 17, 0, 0))),
        key,
        `${key} must round-trip through usMarketDateKey`,
      );
      assert.equal(typeof name, "string");
      assert.ok(name.length > 0, `${key} must carry a holiday name`);
    }
  });

  it("no holiday falls on a weekend — observed dates only", () => {
    // The shape the nominal-vs-observed mistake takes. A "2026-07-04" entry
    // would be a real holiday on a real date and completely wrong: the
    // exchange actually shut on Friday the 3rd.
    for (const key of Object.keys(US_MARKET_HOLIDAYS)) {
      const wd = weekdayOf(key);
      assert.ok(
        wd !== 0 && wd !== 6,
        `${key} (${US_MARKET_HOLIDAYS[key]}) falls on a weekend — a nominal date crept into an observed table`,
      );
    }
  });

  it("every covered year carries a full slate of holidays", () => {
    // 10 per year, with TWO exceptions, and neither is derivable:
    //   2025 has ELEVEN — 9 January was a national day of mourning for
    //        President Carter, generated by no rule at all.
    //   2028 has NINE — 1 January 2028 is a Saturday and the NYSE does not
    //        observe New Year's Day at all in that case.
    // A half-added year fails here rather than in production.
    const expected: Readonly<Record<number, number>> = {
      2023: 10,
      2024: 10,
      2025: 11,
      2026: 10,
      2027: 10,
      2028: 9,
    };
    for (
      let year = US_HOLIDAY_TABLE_YEARS.first;
      year <= US_HOLIDAY_TABLE_YEARS.last;
      year++
    ) {
      const count = Object.keys(US_MARKET_HOLIDAYS).filter((k) =>
        k.startsWith(`${year}-`),
      ).length;
      assert.equal(
        count,
        expected[year],
        `${year} should carry ${expected[year]} full-day closures, found ${count}`,
      );
    }
  });

  it("the early-close table is non-empty and disjoint from the holidays", () => {
    const keys = Object.keys(US_EARLY_CLOSE_DAYS);
    assert.ok(keys.length >= 4, "expected at least 4 early-close days");
    for (const key of keys) {
      parseKey(key);
      const wd = weekdayOf(key);
      assert.ok(wd !== 0 && wd !== 6, `${key} early close falls on a weekend`);
      assert.equal(
        US_MARKET_HOLIDAYS[key],
        undefined,
        `${key} cannot be both a full closure and a half day — the 2027 Christmas Eve trap`,
      );
      const { y } = parseKey(key);
      assert.ok(
        y >= US_HOLIDAY_TABLE_YEARS.first && y <= US_HOLIDAY_TABLE_YEARS.last,
        `${key} sits outside the declared coverage window`,
      );
      const name = US_EARLY_CLOSE_DAYS[key];
      assert.ok(typeof name === "string" && name.length > 0);
    }
  });

  it("every covered year has a day-after-Thanksgiving early close", () => {
    // The one generator that fires unconditionally. Its absence in any
    // covered year is a table that was filled in by hand and stopped early.
    for (
      let year = US_HOLIDAY_TABLE_YEARS.first;
      year <= US_HOLIDAY_TABLE_YEARS.last;
      year++
    ) {
      const found = Object.entries(US_EARLY_CLOSE_DAYS).filter(
        ([k, v]) => k.startsWith(`${year}-11-`) && v.includes("Thanksgiving"),
      );
      assert.equal(
        found.length,
        1,
        `${year} needs one post-Thanksgiving half day`,
      );
    }
  });

  it("the session boundaries are strictly ordered", () => {
    assert.ok(US_PRE_OPEN_MINUTES < US_RTH_OPEN_MINUTES);
    assert.ok(US_RTH_OPEN_MINUTES < US_EARLY_CLOSE_MINUTES);
    assert.ok(US_EARLY_CLOSE_MINUTES < US_RTH_CLOSE_MINUTES);
    assert.ok(US_RTH_CLOSE_MINUTES < US_POST_CLOSE_MINUTES);
    assert.ok(US_POST_CLOSE_MINUTES <= 24 * 60);
    // The measured Tiingo feed day: 04:00-20:00 ET.
    assert.equal(US_PRE_OPEN_MINUTES, 4 * 60);
    assert.equal(US_POST_CLOSE_MINUTES, 20 * 60);
    assert.equal(US_RTH_OPEN_MINUTES, 9 * 60 + 30);
    assert.equal(US_RTH_CLOSE_MINUTES, 16 * 60);
    assert.equal(US_EARLY_CLOSE_MINUTES, 13 * 60);
  });

  it("declares its own coverage window, so its lapse is visible", () => {
    assert.ok(US_HOLIDAY_TABLE_YEARS.first <= US_HOLIDAY_TABLE_YEARS.last);
    assert.equal(isUsHolidayCalendarCovered(et(2026, 6, 17, 12, 0, EDT)), true);
    assert.equal(isUsHolidayCalendarCovered(et(2028, 6, 19, 12, 0, EDT)), true);
    // The LOWER bound moved to 2023 for MONEY-1373 — the Databento harvest
    // walks 2023-03-28 onward and uses this calendar as its coverage
    // denominator. Pinned in both directions so a later trim is visible.
    assert.equal(isUsHolidayCalendarCovered(et(2023, 6, 19, 12, 0, EDT)), true);
    assert.equal(isUsHolidayCalendarCovered(et(2025, 6, 19, 12, 0, EDT)), true);
    // Outside the table the module still answers — it just answers without
    // holiday knowledge, and this is how a caller finds out.
    assert.equal(
      isUsHolidayCalendarCovered(et(2029, 6, 19, 12, 0, EDT)),
      false,
    );
    assert.equal(
      isUsHolidayCalendarCovered(et(2019, 6, 19, 12, 0, EDT)),
      false,
    );
  });

  it("an Invalid Date throws instead of resolving to a session", () => {
    // "Could not tell" is a distinct outcome. Returning "closed" would
    // disarm a staleness alarm forever; returning "rth" would make it
    // scream at a correctly idle feed. Neither is detectable.
    const bad = new Date("not-a-date");
    assert.throws(() => usMarketSession(bad), TypeError);
    assert.throws(() => nextUsSessionBoundary(bad), TypeError);
    assert.throws(() => usMarketDateKey(bad), TypeError);
    assert.throws(() => getUsMarketHoliday(bad), TypeError);
    assert.throws(() => getUsEarlyClose(bad), TypeError);
    assert.throws(() => isUsHolidayCalendarCovered(bad), TypeError);
  });
});

// ---------------------------------------------------------------------------
// 9. The ET SESSION DATE as a key — MONEY-1373
// ---------------------------------------------------------------------------

/**
 * These three exports exist because two candle writers keyed a "day" on the
 * UTC calendar and collided. The US feed day runs 04:00-20:00 ET, so under EST
 * the 19:00-19:59 ET post-market hour lands on the UTC day that ALSO holds the
 * next session's 04:00 ET pre-market: one UTC key, two sessions, and whichever
 * writer got there first locked the other out of both.
 *
 * The fixtures below keep the house rule from the header — `et()` takes the
 * offset as an ARGUMENT, so the module never supplies the answer to its own
 * exam. Every bound is stated as an absolute instant the test author computed,
 * not as something read back out of the module.
 */
describe("usMarketDayBoundsUtc — one ET calendar day as a UTC interval", () => {
  it("round-trips: the first and last millisecond both belong to the key", () => {
    // The post-condition that makes the interval usable as a query window. If
    // it fails the window selects a neighbouring session's rows, which reads
    // as "that day already holds another source" — the exact refusal shape
    // MONEY-1373 is about.
    for (const key of [
      "2026-02-18",
      "2026-06-17",
      "2026-03-08",
      "2026-11-01",
      "2026-12-31",
      "2027-01-01",
    ]) {
      const { startMs, endMs } = usMarketDayBoundsUtc(key);
      assert.ok(endMs > startMs, `${key}: the interval must be non-empty`);
      assert.equal(usMarketDateKey(new Date(startMs)), key, `${key}: start`);
      assert.equal(
        usMarketDateKey(new Date(endMs - 1)),
        key,
        `${key}: last millisecond`,
      );
      assert.notEqual(
        usMarketDateKey(new Date(endMs)),
        key,
        `${key}: endMs is EXCLUSIVE — it must belong to the next day`,
      );
    }
  });

  it("an ordinary EST day is 24h, starting at ET midnight (05:00Z)", () => {
    const b = usMarketDayBoundsUtc("2026-02-18");
    assert.equal(b.startMs, et(2026, 2, 18, 0, 0, EST).getTime());
    assert.equal(b.endMs, et(2026, 2, 19, 0, 0, EST).getTime());
    assert.equal(b.endMs - b.startMs, 24 * 3_600_000);
  });

  it("an ordinary EDT day is 24h, starting at ET midnight (04:00Z)", () => {
    const b = usMarketDayBoundsUtc("2026-06-17");
    assert.equal(b.startMs, et(2026, 6, 17, 0, 0, EDT).getTime());
    assert.equal(b.endMs, et(2026, 6, 18, 0, 0, EDT).getTime());
    assert.equal(b.endMs - b.startMs, 24 * 3_600_000);
  });

  it("SPRING FORWARD: 2026-03-08 is 23 hours long", () => {
    // Second Sunday in March, the post-2007 US rule — verified against the
    // runtime's tzdata before being pinned here, not copied from a calendar.
    // 00:00 ET is EST (-5) because the transition is at 02:00 local; the next
    // midnight is EDT (-4). `+ 86_400_000` from the start would overshoot by an
    // hour and reach into 2026-03-09, selecting the next session's rows.
    const b = usMarketDayBoundsUtc("2026-03-08");
    assert.equal(b.startMs, et(2026, 3, 8, 0, 0, EST).getTime());
    assert.equal(b.endMs, et(2026, 3, 9, 0, 0, EDT).getTime());
    assert.equal(
      b.endMs - b.startMs,
      23 * 3_600_000,
      "the spring-forward day is 23 hours, not 24",
    );
  });

  it("FALL BACK: 2026-11-01 is 25 hours long", () => {
    // First Sunday in November. `+ 86_400_000` would stop an hour SHORT here —
    // the opposite error, and the one that leaves a session's last hour
    // unexamined and therefore undefended.
    const b = usMarketDayBoundsUtc("2026-11-01");
    assert.equal(b.startMs, et(2026, 11, 1, 0, 0, EDT).getTime());
    assert.equal(b.endMs, et(2026, 11, 2, 0, 0, EST).getTime());
    assert.equal(
      b.endMs - b.startMs,
      25 * 3_600_000,
      "the fall-back day is 25 hours, not 24",
    );
  });

  it("the surrounding days are ordinary, so the transitions are where we say", () => {
    // A premise check. If 2026-03-07 were also 23h the pin above would be
    // asserting something other than a DST transition.
    for (const key of [
      "2026-03-07",
      "2026-03-09",
      "2026-10-31",
      "2026-11-02",
    ]) {
      const b = usMarketDayBoundsUtc(key);
      assert.equal(
        b.endMs - b.startMs,
        24 * 3_600_000,
        `${key} must be an ordinary 24-hour day`,
      );
    }
  });

  it("crosses a month and a year boundary without special-casing", () => {
    const dec = usMarketDayBoundsUtc("2026-12-31");
    assert.equal(usMarketDateKey(new Date(dec.endMs)), "2027-01-01");
    const feb = usMarketDayBoundsUtc("2028-02-29");
    assert.equal(
      usMarketDateKey(new Date(feb.endMs)),
      "2028-03-01",
      "2028 is a leap year",
    );
  });

  it("THROWS on a malformed or impossible key rather than guessing", () => {
    // A plausible-but-wrong window silently selects the wrong rows. `Date.UTC`
    // rolls 30 February forward to 2 March without complaining, which is
    // exactly the kind of quiet substitution this rejects.
    for (const bad of [
      "",
      "2026-3-8",
      "20260308",
      "2026-03-08T00:00:00Z",
      "not-a-date",
      "2026-02-30",
      "2026-13-01",
      "2027-02-29",
    ]) {
      assert.throws(
        () => usMarketDayBoundsUtc(bad),
        RangeError,
        `${JSON.stringify(bad)} must be refused`,
      );
    }
  });
});

describe("isUsTradingDay", () => {
  it("is true on an ordinary weekday", () => {
    assert.equal(isUsTradingDay("2026-02-18"), true);
  });

  it("is false on a weekend", () => {
    assert.equal(isUsTradingDay("2026-04-18"), false, "Saturday");
    assert.equal(isUsTradingDay("2026-04-19"), false, "Sunday");
  });

  it("is false on a full-day holiday", () => {
    assert.equal(isUsTradingDay("2026-11-26"), false, "Thanksgiving");
    assert.equal(
      isUsTradingDay("2026-07-03"),
      false,
      "Independence (observed)",
    );
  });

  it("is TRUE on an early-close day — a half day still trades", () => {
    // The half-day table moves the rth boundary to 13:00 ET; it does not shut
    // the exchange. Treating a half day as non-trading would skip the day
    // after Thanksgiving every single year, and the day still prints.
    for (const key of Object.keys(US_EARLY_CLOSE_DAYS)) {
      assert.equal(
        isUsTradingDay(key),
        true,
        `${key} is a short day, not a closure`,
      );
    }
  });

  it("agrees with usMarketSession: a non-trading day is closed at noon", () => {
    // Two code paths, one table. This is the assertion that catches them
    // drifting apart.
    for (const key of [
      "2026-02-18",
      "2026-04-18",
      "2026-04-19",
      "2026-11-26",
      "2026-11-27",
    ]) {
      const [y, m, d] = key.split("-").map(Number);
      const noon = et(y!, m!, d!, 12, 0, EST);
      assert.equal(
        isUsTradingDay(key),
        usMarketSession(noon) !== "closed",
        `${key}: isUsTradingDay and usMarketSession must agree`,
      );
    }
  });

  it("knows the BACK years the harvest walks, not just the forward ones", () => {
    // The case that actually failed: `US_HOLIDAY_TABLE_YEARS.first` was 2026
    // while the Databento harvest walks 2023-03-28 onward, so 2024-01-01 came
    // back TRUE — a trading day — and every holiday in 2023-2025 counted as a
    // missing session against the vendor. ~10 false alarms a year, and the
    // report reads as a supply problem rather than a calendar one.
    assert.equal(isUsTradingDay("2024-01-01"), false, "New Year's Day 2024");
    assert.equal(isUsTradingDay("2024-01-02"), true, "the Tuesday after it");
    assert.equal(isUsTradingDay("2023-01-02"), false, "New Year's observed");
    assert.equal(isUsTradingDay("2023-04-07"), false, "Good Friday 2023");
    assert.equal(isUsTradingDay("2025-12-25"), false, "Christmas 2025");
  });

  it("knows the ONE-OFF Carter closure, which no rule generates", () => {
    // 9 January 2025 was a national day of mourning for President Carter. It
    // is a Thursday in the middle of an ordinary week — a calendar derived
    // from nth-weekday rules calls it a full trading day, and that is the
    // standing argument for holidays being DATA in this module.
    assert.equal(isUsTradingDay("2025-01-09"), false);
    assert.equal(isUsTradingDay("2025-01-08"), true, "the Wednesday before");
    assert.equal(isUsTradingDay("2025-01-10"), true, "the Friday after");
  });

  it("THROWS on a malformed key", () => {
    assert.throws(() => isUsTradingDay("2026-2-18"), RangeError);
    assert.throws(() => isUsTradingDay("2026-02-31"), RangeError);
  });
});

describe("lastCompletedUsSession — the most recent session that is OVER", () => {
  // Wednesday 18 February 2026, EST. Monday the 16th is Washington's
  // Birthday, so the previous trading day is Tuesday the 17th.
  it("at 19:59 ET today is NOT yet complete — yesterday's session is returned", () => {
    assert.equal(
      lastCompletedUsSession(et(2026, 2, 18, 19, 59, EST)),
      "2026-02-17",
    );
  });

  it("at 20:00 ET exactly today IS complete", () => {
    // The boundary is inclusive: 20:00 is US_POST_CLOSE_MINUTES, the end of
    // the feed day. Off by one minute here and every consumer is a day behind
    // for sixty seconds a night.
    assert.equal(
      lastCompletedUsSession(et(2026, 2, 18, 20, 0, EST)),
      "2026-02-18",
    );
    assert.equal(
      lastCompletedUsSession(et(2026, 2, 18, 20, 1, EST)),
      "2026-02-18",
    );
  });

  it("an EARLY-CLOSE day still completes at 20:00 ET, not at 13:00", () => {
    // Friday 27 November 2026 is the day after Thanksgiving: rth ends 13:00 ET
    // and POST RUNS TO 20:00. `US_EARLY_CLOSE_DAYS` is read only by
    // `rthCloseMinutes`; `usMarketSession`'s last comparison is against
    // US_POST_CLOSE_MINUTES unconditionally. Anyone "fixing" this to complete
    // a half day at 13:00 would declare the session over with seven hours of
    // extended-hours quotes still arriving.
    assert.equal(usMarketSession(et(2026, 11, 27, 15, 0, EST)), "post");
    assert.equal(
      lastCompletedUsSession(et(2026, 11, 27, 13, 30, EST)),
      "2026-11-25",
      "13:30 on a half day is post, not complete — Thanksgiving Thu is closed",
    );
    assert.equal(
      lastCompletedUsSession(et(2026, 11, 27, 20, 1, EST)),
      "2026-11-27",
    );
  });

  it("on a Monday after a Friday holiday it walks back to the Thursday", () => {
    // Good Friday 2026-04-03. Monday 6th at 10:00 ET: today is unfinished,
    // Sunday and Saturday are weekends, Friday is the holiday.
    assert.equal(
      lastCompletedUsSession(et(2026, 4, 6, 10, 0, EDT)),
      "2026-04-02",
    );
  });

  it("on a Sunday it returns the Friday", () => {
    assert.equal(
      lastCompletedUsSession(et(2026, 4, 19, 12, 0, EDT)),
      "2026-04-17",
    );
    assert.equal(
      lastCompletedUsSession(et(2026, 4, 18, 12, 0, EDT)),
      "2026-04-17",
      "Saturday too",
    );
  });

  it("never returns a weekend or a holiday, minute by minute across a week", () => {
    // The property, not a case. A plausible wrong date is the failure mode
    // this function throws to avoid, so nothing here may return one.
    let at = et(2026, 11, 23, 0, 0, EST).getTime();
    const end = et(2026, 11, 30, 0, 0, EST).getTime();
    for (; at < end; at += 37 * 60_000) {
      const key = lastCompletedUsSession(new Date(at));
      assert.equal(
        isUsTradingDay(key),
        true,
        `${new Date(at).toISOString()} -> ${key} is not a trading day`,
      );
      assert.ok(
        key <= usMarketDateKey(new Date(at)),
        `${key} must not be in the future of ${usMarketDateKey(new Date(at))}`,
      );
    }
  });

  it("is stable across a DST transition — the day either side is complete", () => {
    // Friday 6 March 2026 is EST, Monday 9 March is EDT. A noon-anchored step
    // back is what keeps the probe on the right calendar day through the shift.
    assert.equal(
      lastCompletedUsSession(et(2026, 3, 6, 21, 0, EST)),
      "2026-03-06",
    );
    assert.equal(
      lastCompletedUsSession(et(2026, 3, 9, 10, 0, EDT)),
      "2026-03-06",
    );
    assert.equal(
      lastCompletedUsSession(et(2026, 11, 2, 10, 0, EST)),
      "2026-10-30",
    );
  });

  it("an Invalid Date throws instead of resolving to a session", () => {
    assert.throws(() => lastCompletedUsSession(new Date("nope")), TypeError);
  });
});
