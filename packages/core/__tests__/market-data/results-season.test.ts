/**
 * Results-season windows + day grouping — MONEY-1217.
 *
 * The module these tests cover exists because "the next 30 days" is the wrong
 * unit for an Indian earnings calendar: companies report in four bursts bounded
 * by SEBI's 45/60-day filing deadlines and nothing happens in between, so a
 * rolling window is empty for most of the year through no fault of the feed. The
 * defect it removed was a month grid rendering blank cells under a green
 * "0 events" pill, which reads as "this sector has no earnings this month".
 *
 * What is worth pinning here, in order of how badly each one fails silently:
 *
 *   1. THE WINDOWS. Off by a day and the calendar drops the busiest date of the
 *      season; off by a YEAR (the Q3/Q4 fiscal rollover) and every label still
 *      reads correctly while the dates are 12 months out.
 *   2. `seasonFor` RETURNING NULL between seasons. If it snapped to the nearest
 *      window instead, mid-August would silently claim to be inside Q1 and the
 *      panel would show a window that closed five days ago as "current".
 *   3. THE GROUPING DROPPING EMPTY DAYS. This is the whole product fix. A
 *      mutation that pads the window with zero-event days must fail here.
 *
 * Source: packages/core/src/market-data/results-season.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SEASON_ORDINAL_SPAN,
  currentOrNextSeason,
  fiscalYearStart,
  groupResultsByDay,
  isSeasonOrdinalInRange,
  seasonContains,
  seasonFor,
  seasonFromOrdinal,
  seasonOrdinal,
  seasons,
  shiftSeason,
  type ResultsCalendarDay,
  type ResultsCalendarRow,
} from "../../src/market-data/results-season";

/** UTC midnight, so every comparison is against the same instants the module builds. */
function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** `YYYY-MM-DD` of a Date, UTC. */
function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The windows themselves.
// ─────────────────────────────────────────────────────────────────────────────

describe("seasons() — the four SEBI-bounded windows", () => {
  it("FY27 (fyStartYear 2026) has exactly the four documented windows", () => {
    const fy27 = seasons(2026);
    assert.equal(fy27.length, 4);
    assert.deepEqual(
      fy27.map((s) => [s.label, iso(s.start), iso(s.end)]),
      [
        // end is EXCLUSIVE — 15 Aug means "through 14 Aug".
        ["Q1 FY27", "2026-07-15", "2026-08-15"],
        ["Q2 FY27", "2026-10-15", "2026-11-15"],
        // Q3 and Q4 fall in the NEXT calendar year. Getting this backwards puts
        // the calendar a year out while every label still reads correctly.
        ["Q3 FY27", "2027-01-15", "2027-02-15"],
        ["Q4 FY27", "2027-04-15", "2027-05-31"],
      ],
    );
  });

  it("Q4 gets the 60-day annual deadline, not the 45-day quarterly one", () => {
    // The one window with a different rule. Audited annual results get 60 days
    // from 31 Mar = 30 May, so Q4's window is 46 days where the others are 31.
    const [q1, , , q4] = seasons(2026);
    const days = (s: { start: Date; end: Date }) =>
      Math.round((s.end.getTime() - s.start.getTime()) / 86_400_000);
    assert.equal(days(q1!), 31);
    assert.equal(days(q4!), 46);
  });

  it("labels follow the FY the quarter BELONGS to, not the calendar year", () => {
    assert.equal(seasons(2026)[2]!.label, "Q3 FY27");
    assert.equal(iso(seasons(2026)[2]!.start), "2027-01-15");
    // Same calendar month, different fiscal year — this is the pair that a
    // year-offset bug makes indistinguishable.
    assert.equal(seasons(2025)[2]!.label, "Q3 FY26");
    assert.equal(iso(seasons(2025)[2]!.start), "2026-01-15");
  });

  it("century rollover keeps a two-digit label", () => {
    assert.equal(seasons(2099)[0]!.label, "Q1 FY00");
  });

  it("windows never overlap and are ordered by start", () => {
    for (const fy of [2023, 2024, 2025, 2026]) {
      const list = seasons(fy);
      for (let i = 1; i < list.length; i++) {
        assert.ok(
          list[i - 1]!.end.getTime() <= list[i]!.start.getTime(),
          `${list[i - 1]!.label} overlaps ${list[i]!.label}`,
        );
      }
    }
  });
});

describe("leap day", () => {
  it("Q3 of a leap-year FY is still exactly 31 days", () => {
    // FY 2023-24's Q3 window is 15 Jan – 14 Feb 2024, a leap year. Built with
    // millisecond arithmetic from a base this is the window that drifts.
    const q3 = seasons(2023)[2]!;
    assert.equal(iso(q3.start), "2024-01-15");
    assert.equal(iso(q3.end), "2024-02-15");
    assert.equal(
      Math.round((q3.end.getTime() - q3.start.getTime()) / 86_400_000),
      31,
    );
  });

  it("29 Feb 2024 is between seasons, and Q4 still opens on 15 Apr", () => {
    assert.equal(seasonFor(d("2024-02-29")), null);
    assert.equal(iso(seasons(2023)[3]!.start), "2024-04-15");
  });

  it("a leap year does not shift the following FY's Q1", () => {
    assert.equal(iso(seasons(2024)[0]!.start), "2024-07-15");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Containment, and the null between seasons.
// ─────────────────────────────────────────────────────────────────────────────

describe("seasonFor() — boundaries", () => {
  it("includes the first day and the last day of a window", () => {
    assert.equal(seasonFor(d("2026-07-15"))?.label, "Q1 FY27");
    assert.equal(seasonFor(d("2026-08-14"))?.label, "Q1 FY27");
  });

  it("excludes the day the window closes on", () => {
    // `end` is exclusive; 15 Aug is the first day OUTSIDE Q1's window.
    assert.equal(seasonFor(d("2026-08-15")), null);
    assert.equal(seasonFor(d("2026-07-14")), null);
  });

  it("[regression] returns NULL between seasons rather than snapping", () => {
    // Mid-August through mid-October is genuinely between seasons. If this ever
    // returns the nearest window instead, the panel presents a window that
    // closed days ago as the current one, which is the class of claim this
    // whole ticket exists to stop making.
    for (const day of [
      "2026-08-19", // the measurement date on the ticket
      "2026-09-30",
      "2026-10-14",
      "2026-12-01",
      "2027-03-31",
    ]) {
      assert.equal(seasonFor(d(day)), null, `${day} should be between seasons`);
    }
  });

  it("resolves a January date into the PREVIOUS fiscal year's Q3", () => {
    // The fiscal-rollover case: Jan 2027 is inside FY 2026-27, whose Q3 window
    // starts in calendar 2027. A single-FY candidate scan misses it.
    const s = seasonFor(d("2027-01-20"));
    assert.equal(s?.label, "Q3 FY27");
    assert.equal(s?.fyStartYear, 2026);
  });

  it("seasonContains agrees with seasonFor on every boundary it is asked", () => {
    const q1 = seasons(2026)[0]!;
    assert.equal(seasonContains(q1, d("2026-07-15")), true);
    assert.equal(seasonContains(q1, d("2026-08-14")), true);
    assert.equal(seasonContains(q1, d("2026-08-15")), false);
    assert.equal(seasonContains(q1, d("2026-07-14")), false);
  });
});

describe("fiscalYearStart()", () => {
  it("rolls on 1 April, not 1 January", () => {
    assert.equal(fiscalYearStart(d("2026-03-31")), 2025);
    assert.equal(fiscalYearStart(d("2026-04-01")), 2026);
    assert.equal(fiscalYearStart(d("2026-12-31")), 2026);
    assert.equal(fiscalYearStart(d("2027-01-01")), 2026);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. What to show when nothing is open.
// ─────────────────────────────────────────────────────────────────────────────

describe("currentOrNextSeason()", () => {
  it("returns the season in progress", () => {
    assert.equal(currentOrNextSeason(d("2026-07-20")).label, "Q1 FY27");
    assert.equal(currentOrNextSeason(d("2026-08-14")).label, "Q1 FY27");
  });

  it("returns the NEXT season when between seasons (the mid-August case)", () => {
    // 19 Aug 2026 — five days after Q1 FY27 closed. This is the date on the
    // ticket, and Q2 is the correct default to put in front of a reader.
    assert.equal(currentOrNextSeason(d("2026-08-19")).label, "Q2 FY27");
    assert.equal(currentOrNextSeason(d("2026-10-14")).label, "Q2 FY27");
  });

  it("crosses the fiscal-year boundary forwards", () => {
    // After Q4 FY27 closes (30 May 2027) the next thing is Q1 FY28.
    assert.equal(currentOrNextSeason(d("2027-06-01")).label, "Q1 FY28");
    // And a December date looks forward into the next calendar year's Q3.
    assert.equal(currentOrNextSeason(d("2026-12-20")).label, "Q3 FY27");
  });

  it("never returns a season that has already closed", () => {
    // Sweep a whole year day by day: the invariant is that the answer's window
    // has not ended yet. A single hard-coded date cannot catch an off-by-one at
    // an arbitrary boundary; 365 can.
    for (let i = 0; i < 365; i++) {
      const now = new Date(d("2026-04-01").getTime() + i * 86_400_000);
      const s = currentOrNextSeason(now);
      assert.ok(
        now.getTime() < s.end.getTime(),
        `${iso(now)} → ${s.label}, which already closed on ${iso(s.end)}`,
      );
    }
  });

  it("agrees with seasonFor whenever a season IS open", () => {
    for (let i = 0; i < 365; i++) {
      const now = new Date(d("2026-04-01").getTime() + i * 86_400_000);
      const open = seasonFor(now);
      if (open) assert.equal(currentOrNextSeason(now).ordinal, open.ordinal);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Ordinals — the wire format, and the trust boundary.
// ─────────────────────────────────────────────────────────────────────────────

describe("season ordinals", () => {
  it("round-trip through seasonFromOrdinal", () => {
    for (const fy of [2024, 2025, 2026, 2027]) {
      for (const s of seasons(fy)) {
        const back = seasonFromOrdinal(s.ordinal);
        assert.deepEqual(
          [back.label, iso(back.start), iso(back.end)],
          [s.label, iso(s.start), iso(s.end)],
        );
      }
    }
  });

  it("are dense and monotonic across the fiscal-year boundary", () => {
    const q4 = seasons(2026)[3]!;
    const q1Next = seasons(2027)[0]!;
    assert.equal(q1Next.ordinal, q4.ordinal + 1);
    assert.equal(seasonOrdinal(2026, 1), seasonOrdinal(2025, 4) + 1);
  });

  it("shiftSeason walks forwards and backwards over the FY rollover", () => {
    const q4 = seasons(2026)[3]!;
    assert.equal(shiftSeason(q4, 1).label, "Q1 FY28");
    assert.equal(shiftSeason(q4, -1).label, "Q3 FY27");
    assert.equal(shiftSeason(q4, 4).label, "Q4 FY28");
    assert.equal(shiftSeason(shiftSeason(q4, 3), -3).ordinal, q4.ordinal);
  });

  it("[guard] rejects an ordinal far from now — the client supplies this", () => {
    const now = d("2026-08-19");
    const current = currentOrNextSeason(now).ordinal;
    assert.equal(isSeasonOrdinalInRange(current, now), true);
    assert.equal(isSeasonOrdinalInRange(current - 1, now), true);
    assert.equal(isSeasonOrdinalInRange(current + 1, now), true);
    assert.equal(
      isSeasonOrdinalInRange(current + SEASON_ORDINAL_SPAN, now),
      true,
    );
    // One past the span, and the pathological inputs a URL can carry.
    assert.equal(
      isSeasonOrdinalInRange(current + SEASON_ORDINAL_SPAN + 1, now),
      false,
    );
    assert.equal(isSeasonOrdinalInRange(2_000_000, now), false);
    assert.equal(isSeasonOrdinalInRange(-5, now), false);
    assert.equal(isSeasonOrdinalInRange(Number.NaN, now), false);
    assert.equal(isSeasonOrdinalInRange(Number.POSITIVE_INFINITY, now), false);

    // A FRACTION NEAR THE CURRENT SEASON is the case the integer check is
    // actually for, and the only one that discriminates. A far-away fraction
    // (1.5) and NaN are both rejected by the distance test on their own — a
    // mutation removing `Number.isInteger` survived a suite that only tried
    // those. `current + 0.5` passes the distance test and then indexes
    // `SEASON_WINDOWS[2.5]`, which is `undefined`: a client-supplied value that
    // crashes the action rather than being refused by it.
    assert.equal(isSeasonOrdinalInRange(current + 0.5, now), false);
    assert.equal(isSeasonOrdinalInRange(current - 0.25, now), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE PRODUCT FIX — grouping drops days with no events.
// ─────────────────────────────────────────────────────────────────────────────

describe("groupResultsByDay()", () => {
  const rows: ResultsCalendarRow[] = [
    {
      date: d("2026-10-22"),
      symbol: "TCS",
      name: "Tata Consultancy Services",
      title: "TCS results",
    },
    { date: d("2026-10-20"), symbol: "INFY", name: "Infosys", title: "Q2" },
    { date: d("2026-10-20"), symbol: "HDFCBANK", name: null, title: "Q2" },
  ];

  it("groups by UTC calendar day, ascending", () => {
    const days = groupResultsByDay(rows);
    assert.deepEqual(
      days.map((x) => x.date),
      ["2026-10-20", "2026-10-22"],
    );
  });

  it("sorts events within a day by symbol, so output is order-stable", () => {
    const days = groupResultsByDay(rows);
    assert.deepEqual(
      days[0]!.events.map((e) => e.symbol),
      ["HDFCBANK", "INFY"],
    );
    // Same input, shuffled: identical output. This is what lets the UI use the
    // date as a React key without rows reshuffling between fetches.
    const shuffled = groupResultsByDay([rows[2]!, rows[0]!, rows[1]!]);
    assert.deepEqual(shuffled, days);
  });

  it("carries symbol, name and title through unchanged", () => {
    const [first] = groupResultsByDay([rows[0]!]);
    assert.deepEqual(first!.events, [
      {
        symbol: "TCS",
        name: "Tata Consultancy Services",
        title: "TCS results",
      },
    ]);
  });

  it("keeps a null name null rather than inventing one", () => {
    const days = groupResultsByDay(rows);
    assert.equal(days[0]!.events[0]!.name, null);
  });

  it("[regression] emits NO day for a date with no events", () => {
    // The mutation this exists to catch: padding the window with zero-event days
    // so the UI can render a grid. That grid is the defect — a blank cell under
    // a green "0 events" pill asserts "nothing is scheduled", when the truth is
    // "nothing is ANNOUNCED YET" (NSE intimates ~2-3 weeks ahead).
    const days = groupResultsByDay(rows);
    assert.ok(
      days.every((x) => x.events.length > 0),
      "a day with zero events reached the output",
    );
    // And the count is the number of DISTINCT dates present — not the length of
    // any window. `2026-10-21` sits between the two rows and must be absent.
    const distinct = new Set(rows.map((r) => iso(r.date)));
    assert.equal(days.length, distinct.size);
    assert.ok(!days.some((x) => x.date === "2026-10-21"));
  });

  it("[regression] an empty input is an empty list, never a padded window", () => {
    const days: ResultsCalendarDay[] = groupResultsByDay([]);
    assert.deepEqual(days, []);
  });

  it("drops an Invalid Date instead of throwing the whole calendar away", () => {
    // `toISOString()` on an Invalid Date raises RangeError, so one bad row would
    // take down a whole sector's calendar.
    const days = groupResultsByDay([
      { date: new Date("nonsense"), symbol: "BAD", name: null, title: "x" },
      rows[0]!,
    ]);
    assert.deepEqual(
      days.map((x) => x.date),
      ["2026-10-22"],
    );
  });

  it("does not mutate its input", () => {
    const input: ResultsCalendarRow[] = [rows[2]!, rows[1]!, rows[0]!];
    const before = input.map((r) => r.symbol);
    groupResultsByDay(input);
    assert.deepEqual(
      input.map((r) => r.symbol),
      before,
    );
  });
});
