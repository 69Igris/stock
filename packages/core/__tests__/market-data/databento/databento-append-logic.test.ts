/**
 * The daily append's gap arithmetic — MONEY-1373.
 *
 * Every defect this guards against produces a run that EXITS 0. Asking for an
 * embargoed session returns an empty result that is indistinguishable from a
 * market holiday; asking for one we already hold spends money on bytes we have;
 * and advancing the high-water mark past a session that was never fetched
 * leaves a hole nothing will ever fill, because the next run starts after it.
 *
 * The dates are real ones with real closures: 2026-11-26 is Thanksgiving,
 * 2026-07-03 is the observed Independence Day (the 4th is a Saturday), and
 * 2026-11-01 is the fall-back DST boundary.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_APPEND_SESSIONS,
  computeAppendGap,
  highWaterMarkFromChunks,
  hwmForFromDate,
  sessionDateForExclusiveEnd,
  terminalStatesFor,
} from "../../../src/market-data/databento/databento-append-logic";
import { usMarketDayBoundsUtc } from "../../../src/market-data/us-market-hours";

/**
 * The vendor's EXCLUSIVE range end when it has published through `dateKey`.
 *
 * The REAL shape, not the ET day end: the vendor's range end sits at UTC
 * midnight, which is 20:00 EDT / 19:00 EST — never 24:00 ET. Using the ET day
 * end here would make every case in this file more generous than production.
 */
function publishedThrough(dateKey: string): number {
  return dataDayEnd(dateKey);
}

/** 20:00 ET on `dateKey` — the last instant that can carry a bar. */
function dataDayEnd(dateKey: string): number {
  return usMarketDayBoundsUtc(dateKey).startMs + 20 * 60 * 60_000;
}

/** 15:00 IST on a date = 09:30 UTC — the primary append trigger. */
function atAppendHour(dateKey: string): Date {
  return new Date(`${dateKey}T09:30:00Z`);
}

/* ─────────────────────────────────────────────────────────────────────── */

describe("the three-day outage", () => {
  it("walks Tue, Wed and Thu after a mark stuck on Monday", () => {
    // The acceptance case. Mark on Mon 2026-11-16; it is now Fri 2026-11-20 at
    // the 15:00 IST trigger, and the vendor has published through Thursday
    // under the T+1 embargo.
    const gap = computeAppendGap({
      hwmSessionDate: "2026-11-16",
      datasetRangeEndUtcMs: publishedThrough("2026-11-19"),
      now: atAppendHour("2026-11-20"),
    });
    assert.equal(gap.ok, true);
    assert.deepEqual(gap.sessions, ["2026-11-17", "2026-11-18", "2026-11-19"]);
  });

  it("bounds the window at the first and last session it asked for", () => {
    const gap = computeAppendGap({
      hwmSessionDate: "2026-11-16",
      datasetRangeEndUtcMs: publishedThrough("2026-11-19"),
      now: atAppendHour("2026-11-20"),
    });
    assert.ok(gap.ok);
    assert.equal(gap.startMs, usMarketDayBoundsUtc("2026-11-17").startMs);
    // EXCLUSIVE, and equal to the last session's DATA DAY end (20:00 ET), not
    // its ET calendar end (24:00 ET). The four hours between the two carry no
    // bars, and asking for them is a 422 — the vendor's range end is at UTC
    // midnight, which is 20:00 EDT / 19:00 EST and never 24:00 ET.
    assert.equal(gap.endMsExclusive, dataDayEnd("2026-11-19"));
    assert.ok(
      gap.endMsExclusive < usMarketDayBoundsUtc("2026-11-19").endMs,
      "the ET calendar end is the value that 422s; it must not be sent",
    );
  });
});

describe("closures are skipped, not counted as gaps", () => {
  it("steps over a weekend", () => {
    // Mark Fri 2026-11-20; now Tue 2026-11-24, published through Monday.
    const gap = computeAppendGap({
      hwmSessionDate: "2026-11-20",
      datasetRangeEndUtcMs: publishedThrough("2026-11-23"),
      now: atAppendHour("2026-11-24"),
    });
    assert.ok(gap.ok);
    assert.deepEqual(gap.sessions, ["2026-11-23"]);
  });

  it("steps over Thanksgiving", () => {
    // Mark Wed 2026-11-25; now Sat 2026-11-28, published through Fri the 27th.
    // The 26th is a full closure and must not appear.
    const gap = computeAppendGap({
      hwmSessionDate: "2026-11-25",
      datasetRangeEndUtcMs: publishedThrough("2026-11-27"),
      now: atAppendHour("2026-11-28"),
    });
    assert.ok(gap.ok);
    assert.deepEqual(gap.sessions, ["2026-11-27"]);
    assert.ok(!gap.sessions.includes("2026-11-26"));
  });

  it("steps over an observed holiday on a Friday", () => {
    // 2026-07-04 is a Saturday, so the 3rd is closed. Mark Thu the 2nd, now
    // Tue the 7th, published through Mon the 6th.
    const gap = computeAppendGap({
      hwmSessionDate: "2026-07-02",
      datasetRangeEndUtcMs: publishedThrough("2026-07-06"),
      now: atAppendHour("2026-07-07"),
    });
    assert.ok(gap.ok);
    assert.deepEqual(gap.sessions, ["2026-07-06"]);
  });

  it("a gap made ENTIRELY of closures is UP_TO_DATE, not a hole", () => {
    // Mark Fri; now Sunday. The calendar moved and the market did not.
    const gap = computeAppendGap({
      hwmSessionDate: "2026-11-20",
      datasetRangeEndUtcMs: publishedThrough("2026-11-20"),
      now: new Date("2026-11-22T09:30:00Z"),
    });
    assert.deepEqual(gap, {
      ok: false,
      sessions: [],
      skipReason: "UP_TO_DATE",
    });
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("the three skips are three DIFFERENT answers", () => {
  it("a never-harvested entry says NO_HWM_RUN_HARVEST_FIRST", () => {
    const gap = computeAppendGap({
      hwmSessionDate: null,
      datasetRangeEndUtcMs: publishedThrough("2026-11-19"),
      now: atAppendHour("2026-11-20"),
    });
    assert.deepEqual(gap, {
      ok: false,
      sessions: [],
      skipReason: "NO_HWM_RUN_HARVEST_FIRST",
    });
  });

  it("a current entry says UP_TO_DATE — the retry run's healthy answer", () => {
    // The 18:00 IST retry after a good 15:00 primary. One free range call and
    // nothing spent, which is the acceptance for "a re-run is a no-op".
    const gap = computeAppendGap({
      hwmSessionDate: "2026-11-19",
      datasetRangeEndUtcMs: publishedThrough("2026-11-19"),
      now: new Date("2026-11-20T12:30:00Z"),
    });
    assert.deepEqual(gap, {
      ok: false,
      sessions: [],
      skipReason: "UP_TO_DATE",
    });
  });

  it("an embargoed session says NOT_YET_PUBLISHED, not UP_TO_DATE", () => {
    // The calendar says Thursday is over; the vendor has published only
    // through Wednesday. Reporting UP_TO_DATE here would make a persistent
    // vendor lag look like a permanently healthy pipeline.
    const gap = computeAppendGap({
      hwmSessionDate: "2026-11-18",
      datasetRangeEndUtcMs: publishedThrough("2026-11-18"),
      now: atAppendHour("2026-11-20"),
    });
    assert.deepEqual(gap, {
      ok: false,
      sessions: [],
      skipReason: "NOT_YET_PUBLISHED",
    });
  });

  it("an UNKNOWN range is NOT an available one", () => {
    // A null here means the metadata call failed. Treating that as "everything
    // is available" would submit a job for a session that may not exist — at
    // exactly the moment the vendor is least able to serve it.
    const gap = computeAppendGap({
      hwmSessionDate: "2026-11-16",
      datasetRangeEndUtcMs: null,
      now: atAppendHour("2026-11-20"),
    });
    assert.deepEqual(gap, {
      ok: false,
      sessions: [],
      skipReason: "NOT_YET_PUBLISHED",
    });
  });
});

describe("availability is the DATA DAY; the request end is DETERMINISTIC", () => {
  it("a range ending exactly at 20:00 ET publishes that session", () => {
    // 20:00 ET is `US_POST_CLOSE_MINUTES` — the last instant that can carry a
    // bar — and in EDT it is exactly where the vendor's UTC-midnight range end
    // falls. So a session becomes available the moment its data day is
    // complete, with no waiting.
    const gap = computeAppendGap({
      hwmSessionDate: "2026-11-18",
      datasetRangeEndUtcMs: dataDayEnd("2026-11-19"),
      now: atAppendHour("2026-11-20"),
    });
    assert.ok(gap.ok);
    assert.deepEqual(gap.sessions, ["2026-11-19"]);
  });

  it("one millisecond short of it does NOT — a partial session is not bought", () => {
    // This is the winter case. In EST the vendor's UTC midnight is 19:00 ET,
    // an hour INSIDE the data day. Judging the session available there and
    // clamping the request to it lost 19:00-20:00 ET on every winter session
    // while the high-water mark advanced past it — permanently, and invisibly,
    // because `reportCoverage` counts sessions with at least one bar.
    const gap = computeAppendGap({
      hwmSessionDate: "2026-11-18",
      datasetRangeEndUtcMs: dataDayEnd("2026-11-19") - 1,
      now: atAppendHour("2026-11-20"),
    });
    assert.deepEqual(gap, {
      ok: false,
      sessions: [],
      skipReason: "NOT_YET_PUBLISHED",
    });
  });

  it("the vendor's UTC-MIDNIGHT range end publishes that session in EDT", () => {
    // THE MEASURED SHAPE, and the reason this rule exists at all. On
    // 2026-09-07 `metadata.get_dataset_range` answered `2026-09-05T00:00:00Z`
    // with Friday 2026-09-04 fully published. Our ET session END for that
    // Friday is 2026-09-05T04:00Z — FOUR HOURS LATER — so testing the session
    // end against the range end judged the newest published session
    // unavailable and the append would have lagged one session behind the
    // vendor FOREVER.
    //
    // Under EDT, UTC midnight IS 20:00 ET, so the data day is exactly covered.
    const rangeEnd = Date.parse("2026-09-05T00:00:00Z");
    assert.equal(
      rangeEnd,
      dataDayEnd("2026-09-04"),
      "EDT: midnight = 20:00 ET",
    );
    const gap = computeAppendGap({
      hwmSessionDate: "2026-09-03",
      datasetRangeEndUtcMs: rangeEnd,
      now: atAppendHour("2026-09-07"),
    });
    assert.ok(gap.ok, `expected a session, got ${JSON.stringify(gap)}`);
    assert.deepEqual(gap.sessions, ["2026-09-04"]);
  });

  it("in EST it waits one day rather than buying 19:00-20:00 ET short", () => {
    // 2026-01-09 is a Friday under EST, so UTC midnight is 19:00 ET — an hour
    // short of the data day. The session is NOT available yet.
    const fri = "2026-01-09";
    const utcMidnight = Date.parse("2026-01-10T00:00:00Z");
    assert.ok(
      utcMidnight < dataDayEnd(fri),
      "EST: the vendor's midnight is INSIDE the data day",
    );
    // The whole object, not `.skipReason` — `AppendGap` is a discriminated
    // union and the field exists only on the `ok: false` arm, so reaching for
    // it directly does not type-check and would hide which arm was returned.
    assert.deepEqual(
      computeAppendGap({
        hwmSessionDate: "2026-01-08",
        datasetRangeEndUtcMs: utcMidnight,
        now: atAppendHour("2026-01-10"),
      }),
      { ok: false, sessions: [], skipReason: "NOT_YET_PUBLISHED" },
    );
    // The next UTC midnight covers it, and nothing was lost.
    const later = computeAppendGap({
      hwmSessionDate: "2026-01-08",
      datasetRangeEndUtcMs: Date.parse("2026-01-11T00:00:00Z"),
      now: atAppendHour("2026-01-12"),
    });
    assert.ok(later.ok);
    assert.deepEqual(later.sessions, [fri]);
    assert.equal(later.endMsExclusive, dataDayEnd(fri));
  });

  it("the request end depends ONLY on the session — never on the vendor", () => {
    // THE IDEMPOTENCY KEY. `windowIsPinnedFor` is HARVEST-only by design, so
    // for the APPEND `start` and `end` are part of the unique key. An `end`
    // that moved with the vendor's range would make a stalled session's row
    // unfindable on the next run — and it would BUY THE SAME SESSIONS AGAIN.
    const args = {
      hwmSessionDate: "2026-11-18",
      now: atAppendHour("2026-11-20"),
    } as const;
    const saturday = computeAppendGap({
      ...args,
      datasetRangeEndUtcMs: dataDayEnd("2026-11-19"),
    });
    const monday = computeAppendGap({
      ...args,
      datasetRangeEndUtcMs: dataDayEnd("2026-11-23"),
    });
    assert.ok(saturday.ok && monday.ok);
    assert.deepEqual(saturday.sessions, monday.sessions);
    assert.equal(
      saturday.endMsExclusive,
      monday.endMsExclusive,
      "the window moved with the vendor; the ledger key would move with it",
    );
    // And it is never past what the vendor holds.
    assert.ok(saturday.endMsExclusive <= dataDayEnd("2026-11-19"));
    assert.ok(saturday.startMs < saturday.endMsExclusive);
  });

  it("an OLDER session's end is its own data day, not the newest one's", () => {
    const gap = computeAppendGap({
      hwmSessionDate: "2026-11-16",
      datasetRangeEndUtcMs: publishedThrough("2026-11-19"),
      now: atAppendHour("2026-11-20"),
      maxSessions: 1,
    });
    assert.ok(gap.ok);
    assert.deepEqual(gap.sessions, ["2026-11-17"]);
    assert.equal(gap.endMsExclusive, dataDayEnd("2026-11-17"));
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("a long outage is capped and closed OLDEST FIRST", () => {
  it("takes 30 sessions and defers the rest", () => {
    const gap = computeAppendGap({
      hwmSessionDate: "2026-06-01",
      datasetRangeEndUtcMs: publishedThrough("2026-08-31"),
      now: atAppendHour("2026-09-01"),
    });
    assert.ok(gap.ok);
    assert.equal(gap.sessions.length, DEFAULT_MAX_APPEND_SESSIONS);
    assert.ok(gap.deferred > 20, `deferred ${gap.deferred}`);
    // OLDEST first, so the gap closes from the far end and the series never
    // has a hole in the middle.
    assert.equal(gap.sessions[0], "2026-06-02");
  });

  it("the next run picks up exactly where the last one stopped", () => {
    const first = computeAppendGap({
      hwmSessionDate: "2026-06-01",
      datasetRangeEndUtcMs: publishedThrough("2026-08-31"),
      now: atAppendHour("2026-09-01"),
    });
    assert.ok(first.ok);
    const second = computeAppendGap({
      hwmSessionDate: first.sessions[first.sessions.length - 1]!,
      datasetRangeEndUtcMs: publishedThrough("2026-08-31"),
      now: atAppendHour("2026-09-01"),
    });
    assert.ok(second.ok);
    // No overlap and no hole between the two runs.
    assert.ok(second.sessions[0]! > first.sessions[first.sessions.length - 1]!);
    assert.equal(
      first.sessions.length + second.sessions.length + second.deferred,
      first.sessions.length + first.deferred,
    );
  });

  it("a custom cap is honoured and zero is refused", () => {
    const gap = computeAppendGap({
      hwmSessionDate: "2026-06-01",
      datasetRangeEndUtcMs: publishedThrough("2026-08-31"),
      now: atAppendHour("2026-09-01"),
      maxSessions: 5,
    });
    assert.ok(gap.ok);
    assert.equal(gap.sessions.length, 5);
    assert.throws(
      () =>
        computeAppendGap({
          hwmSessionDate: "2026-06-01",
          datasetRangeEndUtcMs: publishedThrough("2026-08-31"),
          now: atAppendHour("2026-09-01"),
          maxSessions: 0,
        }),
      RangeError,
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("--from names the first session to FETCH", () => {
  it("the implied mark is the trading day BEFORE it", () => {
    // Returning the raw date would silently skip the very session the operator
    // asked for, because the walk starts strictly after the mark.
    assert.equal(hwmForFromDate("2026-11-19"), "2026-11-18");
  });

  it("steps back over a weekend", () => {
    assert.equal(hwmForFromDate("2026-11-23"), "2026-11-20");
  });

  it("steps back over a holiday", () => {
    // The day before Thanksgiving Friday is the closure itself.
    assert.equal(hwmForFromDate("2026-11-27"), "2026-11-25");
  });

  it("the session it implies is actually fetched", () => {
    const from = "2026-11-23";
    const gap = computeAppendGap({
      hwmSessionDate: hwmForFromDate(from),
      datasetRangeEndUtcMs: publishedThrough("2026-11-25"),
      now: atAppendHour("2026-11-26"),
    });
    assert.ok(gap.ok);
    assert.equal(gap.sessions[0], from);
  });
});

describe("the high-water mark reads back one millisecond", () => {
  it("an EXCLUSIVE end maps to the session it closed", () => {
    // `end` lands at 00:00 ET of the FOLLOWING day. Reading it directly would
    // advance the mark by one session that was never fetched — the silent-hole
    // failure this whole module exists to avoid.
    const end = new Date(usMarketDayBoundsUtc("2026-11-19").endMs);
    assert.equal(sessionDateForExclusiveEnd(end), "2026-11-19");
  });

  it("holds across a multi-session window", () => {
    const end = new Date(usMarketDayBoundsUtc("2026-11-25").endMs);
    assert.equal(sessionDateForExclusiveEnd(end), "2026-11-25");
  });

  it("holds on both sides of the DST boundary", () => {
    // 2026-11-01 is the fall-back Sunday. A fixed -5 offset would put every
    // summer session on the wrong date; a fixed -4 would do it in winter.
    assert.equal(
      sessionDateForExclusiveEnd(
        new Date(usMarketDayBoundsUtc("2026-10-30").endMs),
      ),
      "2026-10-30",
    );
    assert.equal(
      sessionDateForExclusiveEnd(
        new Date(usMarketDayBoundsUtc("2026-11-02").endMs),
      ),
      "2026-11-02",
    );
  });

  it("round-trips every session of a DST-crossing fortnight", () => {
    for (const day of [
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
    ]) {
      assert.equal(
        sessionDateForExclusiveEnd(new Date(usMarketDayBoundsUtc(day).endMs)),
        day,
      );
    }
  });
});

describe("a multi-chunk entry's mark is its newest COMPLETE window", () => {
  const endOf = (dateKey: string) =>
    new Date(usMarketDayBoundsUtc(dateKey).endMs);
  const startOf = (dateKey: string) =>
    new Date(usMarketDayBoundsUtc(dateKey).startMs);
  /** One terminal row: chunk `h` bought sessions `from`..`to`. */
  const row = (h: string, from: string, to: string) => ({
    symbolsHash: h,
    start: startOf(from),
    end: endOf(to),
  });

  it("one chunk is just that chunk", () => {
    const r = highWaterMarkFromChunks(
      [row("a", "2026-11-16", "2026-11-19")],
      1,
    );
    assert.equal(r.mark, "2026-11-19");
    assert.equal(r.furthest, "2026-11-19");
    assert.equal(r.furthestChunks, 1);
  });

  it("a LAGGING chunk holds the whole entry back", () => {
    // Chunks A and B both bought Mon-Tue; that night only A landed Wed-Thu.
    // Reporting Thursday would start the next run on Friday and leave B
    // permanently short of Wednesday and Thursday.
    const r = highWaterMarkFromChunks(
      [
        row("a", "2026-11-16", "2026-11-17"),
        row("b", "2026-11-16", "2026-11-17"),
        row("a", "2026-11-18", "2026-11-19"),
      ],
      2,
    );
    assert.equal(r.mark, "2026-11-17");
    assert.equal(r.furthest, "2026-11-19");
    assert.equal(r.furthestChunks, 1);
  });

  it("the gap that follows actually re-fetches the lagging sessions", () => {
    const r = highWaterMarkFromChunks(
      [
        row("a", "2026-11-16", "2026-11-17"),
        row("b", "2026-11-16", "2026-11-17"),
        row("a", "2026-11-18", "2026-11-19"),
      ],
      2,
    );
    const gap = computeAppendGap({
      hwmSessionDate: r.mark,
      datasetRangeEndUtcMs: usMarketDayBoundsUtc("2026-11-19").endMs,
      now: new Date("2026-11-20T09:30:00Z"),
    });
    assert.ok(gap.ok);
    assert.deepEqual(gap.sessions, ["2026-11-18", "2026-11-19"]);
  });

  it("several windows for ONE chunk: the newest wins", () => {
    const r = highWaterMarkFromChunks(
      [
        row("a", "2026-11-16", "2026-11-17"),
        row("a", "2026-11-19", "2026-11-19"),
        row("a", "2026-11-18", "2026-11-18"),
      ],
      1,
    );
    assert.equal(r.mark, "2026-11-19");
  });

  it("MONEY-1539: a population that RE-HASHES every night still advances", () => {
    // The prod ledger, shape for shape. MASTER is re-read from us_instruments
    // each run and gains or loses a listing most nights, so every chunk hashes
    // differently every night: the harvest's 8 hashes (window through Tue
    // 2026-09-08) are never bought again. The old per-hash MINIMUM therefore
    // read 2026-09-08 for ever and every append re-bought from 2026-09-09.
    const rows = [];
    for (let c = 0; c < 8; c++) {
      rows.push({
        symbolsHash: `harvest-${c}`,
        start: new Date("2023-03-28T04:00:00Z"),
        end: new Date("2026-09-09T00:00:00Z"),
      });
    }
    // Two nights later all 8 NEW hashes landed for the window 09-09..09-21.
    for (let c = 0; c < 8; c++) {
      rows.push({
        symbolsHash: `night-${c}`,
        start: new Date("2026-09-09T04:00:00Z"),
        end: new Date("2026-09-22T00:00:00Z"),
      });
    }
    const r = highWaterMarkFromChunks(rows, 8);
    assert.equal(r.mark, "2026-09-21");

    // THE PLANNER'S START DATE — the acceptance line of the ticket. Wed
    // 2026-09-23 at the 15:00 IST trigger, vendor published through Tue: the
    // next run asks for Tue 09-22 ONLY, not 09-09 onward.
    const gap = computeAppendGap({
      hwmSessionDate: r.mark,
      datasetRangeEndUtcMs: Date.parse("2026-09-23T00:00:00Z"),
      now: new Date("2026-09-23T09:30:00Z"),
    });
    assert.ok(gap.ok);
    assert.equal(
      new Date(gap.startMs).toISOString(),
      "2026-09-22T04:00:00.000Z",
      "the append re-requests history it already holds",
    );
    assert.deepEqual(gap.sessions, ["2026-09-22"]);
  });

  it("a night with a chunk missing does not advance — the next asks again", () => {
    // 7 of 8 terminal (one chunk stuck QUOTED, which is not terminal and is
    // therefore absent from the input). The mark stays at the last window all
    // 8 completed, so the missing chunk's sessions are bought again.
    const rows = [];
    for (let c = 0; c < 8; c++) {
      rows.push(row(`h${c}`, "2026-09-01", "2026-09-08"));
    }
    for (let c = 0; c < 7; c++) {
      rows.push(row(`n${c}`, "2026-09-09", "2026-09-09"));
    }
    const r = highWaterMarkFromChunks(rows, 8);
    assert.equal(r.mark, "2026-09-08");
    assert.equal(r.furthest, "2026-09-09");
    assert.equal(r.furthestChunks, 7);
  });

  it("a window is (start, end), not end alone", () => {
    // Half the chunks bought from 09-01 and half from 09-07; both end 09-08.
    // Nothing bought 09-01..09-04 for the second half, so no window is whole.
    const rows = [];
    for (let c = 0; c < 4; c++)
      rows.push(row(`a${c}`, "2026-09-01", "2026-09-08"));
    for (let c = 0; c < 4; c++)
      rows.push(row(`b${c}`, "2026-09-07", "2026-09-08"));
    assert.equal(highWaterMarkFromChunks(rows, 8).mark, null);
  });

  it("no window with every chunk is null, which reads as NO_HWM", () => {
    const r = highWaterMarkFromChunks(
      [row("a", "2026-11-16", "2026-11-17")],
      2,
    );
    assert.equal(r.mark, null);
    assert.equal(r.furthest, "2026-11-17");
  });

  it("no rows at all is null, which reads as NO_HWM", () => {
    const r = highWaterMarkFromChunks([], 1);
    assert.equal(r.mark, null);
    assert.equal(r.furthest, null);
    const gap = computeAppendGap({
      hwmSessionDate: r.mark,
      datasetRangeEndUtcMs: usMarketDayBoundsUtc("2026-11-19").endMs,
      now: new Date("2026-11-20T09:30:00Z"),
    });
    assert.deepEqual(gap, {
      ok: false,
      sessions: [],
      skipReason: "NO_HWM_RUN_HARVEST_FIRST",
    });
  });

  it("order of the input does not change the answer", () => {
    const rows = [
      row("a", "2026-11-16", "2026-11-17"),
      row("b", "2026-11-16", "2026-11-17"),
      row("a", "2026-11-18", "2026-11-19"),
      row("b", "2026-11-18", "2026-11-18"),
    ];
    assert.deepEqual(
      highWaterMarkFromChunks(rows, 2),
      highWaterMarkFromChunks([...rows].reverse(), 2),
    );
  });
});

describe("which states count as coverage", () => {
  it("a loadable entry counts only LOADED", () => {
    assert.deepEqual(terminalStatesFor({ load: true }), ["LOADED"]);
  });

  it("an archive-only entry also counts DOWNLOADED", () => {
    // Its records never reach `candles`, so it can never reach LOADED.
    assert.deepEqual(terminalStatesFor({ load: false }), [
      "DOWNLOADED",
      "LOADED",
    ]);
  });

  it("NO non-terminal state counts, for either kind", () => {
    // The deploy contract could only forbid two literals near the query, so
    // adding "QUOTED" — a row written BEFORE anything is bought — passed the
    // whole suite. A quoted-but-never-purchased window would then advance the
    // mark past sessions nothing holds.
    for (const load of [true, false]) {
      const states = terminalStatesFor({ load });
      for (const bad of [
        "QUOTED",
        "SUBMITTED",
        "PROCESSING",
        "DONE",
        "FAILED",
        "EXPIRED",
      ]) {
        assert.ok(
          !states.includes(bad),
          `${bad} counts as coverage for load=${load}`,
        );
      }
    }
  });
});
