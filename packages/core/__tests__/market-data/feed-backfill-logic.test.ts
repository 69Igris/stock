/**
 * UNIT TEST — historical backfill decision logic (MONEY-941 / P3 steps 2-3).
 *
 * Exercises the REAL exports from `market-data/feed-backfill-logic.ts`:
 *   - `weekdaysDescending` — the walk sequence
 *   - `advanceRange` / `shouldEndRange` — the K-miss rule
 *   - `noteHostOutcome` / `hostIsPaused` / `backfillBackoffMs` — host throttle backoff
 *   - `shouldAbort` — the error stop-loss
 *   - `planFamily` — checkpoint-aware day list
 *
 * The K-miss cases carry the most weight. P1 established that NSE's archive is
 * SPARSE — 1994-11-03 present, 11-04 a genuine 404, 12-01 present again — so a
 * walker that treats any 404 as the end of history silently amputates
 * everything beyond the first hole AND reports success. These tests encode that
 * a miss inside a range is only ever a gap.
 *
 * Pure functions: no network, no Prisma, no clock, no timers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  weekdaysDescending,
  chunkStartsDescending,
  dateFromArchiveKey,
  isWeekend,
  isoDay,
  advanceRange,
  shouldEndRange,
  emptyHostState,
  noteHostOutcome,
  hostIsPaused,
  backfillBackoffMs,
  shouldAbort,
  emptyErrorRuns,
  advanceErrorRuns,
  previousWeekday,
  isPrecedingWeekday,
  parseDay,
  DEFAULT_TRANSPORT_STOP_LOSS,
  DEFAULT_PAYLOAD_STOP_LOSS,
  planFamily,
  summarizeFamily,
  emptyTally,
  DEFAULT_K_MISS,
  shouldTryDoor,
  THROTTLES_BEFORE_DOOR,
  THROTTLES_BEFORE_PAUSE,
  HOST_PAUSE_MS,
  type RangeState,
} from "../../src/market-data/feed-backfill-logic";
import type { ReportFamily } from "../../src/market-data/report-registry";

const family = (id: string): ReportFamily =>
  ({
    id,
    exchange: "NSE",
    feed: id,
    buildUrl: () => `https://example.test/${id}`,
    cadence: "daily",
    startDate: "2020-01-01",
    format: "csv",
    enabled: false,
    backfillable: true,
    provenance: "p1-verified",
    notes: "test",
  }) as ReportFamily;

describe("walk sequence", () => {
  it("returns weekdays only, newest first", () => {
    // 2026-08-03 Mon .. 2026-08-09 Sun
    const days = weekdaysDescending("2026-08-03", "2026-08-09").map(isoDay);
    assert.deepEqual(days, [
      "2026-08-07",
      "2026-08-06",
      "2026-08-05",
      "2026-08-04",
      "2026-08-03",
    ]);
  });

  it("is newest-first so a truncated run keeps the MOST RECENT history", () => {
    // Interruption is the norm here (job timeouts, throttling). Ascending order
    // would leave a half-finished 30-year walk holding only the 1990s.
    const days = weekdaysDescending("1995-01-02", "2026-08-07");
    assert.ok(days[0]! > days[days.length - 1]!);
    assert.equal(isoDay(days[0]!), "2026-08-07");
  });

  it("identifies IST weekends", () => {
    assert.equal(isWeekend(new Date("2026-08-08T12:00:00Z")), true); // Sat
    assert.equal(isWeekend(new Date("2026-08-09T12:00:00Z")), true); // Sun
    assert.equal(isWeekend(new Date("2026-08-07T12:00:00Z")), false); // Fri
  });

  it("returns [] when the window is inverted", () => {
    assert.deepEqual(weekdaysDescending("2026-08-09", "2026-08-03"), []);
  });
});

describe("K-miss: a 404 inside a range is a GAP, never the end", () => {
  const floor = "1994-11-03";
  const walk = (
    outcomes: Array<["DONE" | "MISSING" | "ERROR", string]>,
  ): RangeState => {
    let s: RangeState = { consecutiveMisses: 0, belowFloor: false };
    for (const [o, day] of outcomes) s = advanceRange(s, o, day, floor);
    return s;
  };

  it("does NOT end the range on a miss ABOVE the floor, however long the run", () => {
    // The exact 1994 shape: present, absent, present. Also a 50-day run of
    // misses inside the declared range — still not the end, because we are not
    // below the floor and the archive is known to be holey.
    let s = walk([
      ["DONE", "1994-12-01"],
      ["MISSING", "1994-11-04"],
    ]);
    assert.equal(shouldEndRange(s), false);

    const long: Array<["MISSING", string]> = [];
    for (let i = 0; i < 50; i++) long.push(["MISSING", "1995-06-01"]);
    s = walk(long);
    assert.equal(
      shouldEndRange(s),
      false,
      "in-range misses must never end a range",
    );
  });

  it("ends the range only BELOW the floor after K consecutive misses", () => {
    const below: Array<["MISSING", string]> = [];
    for (let i = 0; i < DEFAULT_K_MISS; i++)
      below.push(["MISSING", "1994-01-05"]);
    const s = walk(below);
    assert.equal(s.belowFloor, true);
    assert.equal(shouldEndRange(s), true);
  });

  it("needs K, not K-1", () => {
    const below: Array<["MISSING", string]> = [];
    for (let i = 0; i < DEFAULT_K_MISS - 1; i++)
      below.push(["MISSING", "1994-01-05"]);
    assert.equal(shouldEndRange(walk(below)), false);
  });

  it("resets the miss run on any hit — one file proves history continues", () => {
    const seq: Array<["DONE" | "MISSING", string]> = [];
    for (let i = 0; i < DEFAULT_K_MISS - 1; i++)
      seq.push(["MISSING", "1994-01-05"]);
    seq.push(["DONE", "1994-01-04"]);
    seq.push(["MISSING", "1994-01-03"]);
    const s = walk(seq);
    assert.equal(s.consecutiveMisses, 1);
    assert.equal(shouldEndRange(s), false);
  });

  it("does NOT let ERRORs count toward ending a range", () => {
    // An error means we never learned whether the file exists. Counting it as
    // absence would let a throttling exchange convince the walker that history
    // ended — the worst possible reading of a transient failure.
    const seq: Array<["ERROR", string]> = [];
    for (let i = 0; i < DEFAULT_K_MISS + 5; i++)
      seq.push(["ERROR", "1994-01-05"]);
    const s = walk(seq);
    assert.equal(s.consecutiveMisses, 0);
    assert.equal(shouldEndRange(s), false);
  });

  it("latches belowFloor once crossed", () => {
    let s = advanceRange(
      { consecutiveMisses: 0, belowFloor: false },
      "MISSING",
      "1994-01-01",
      floor,
    );
    assert.equal(s.belowFloor, true);
    s = advanceRange(s, "DONE", "1999-01-01", floor);
    assert.equal(
      s.belowFloor,
      true,
      "must not un-latch on a later in-range day",
    );
  });
});

describe("host backoff", () => {
  it("pauses the HOST after N consecutive throttles", () => {
    let s = emptyHostState();
    const now = 1_000_000;
    for (let i = 0; i < THROTTLES_BEFORE_PAUSE; i++) {
      s = noteHostOutcome(s, true, now);
    }
    assert.equal(hostIsPaused(s, now), true);
    assert.equal(hostIsPaused(s, now + HOST_PAUSE_MS + 1), false);
  });

  it("does not pause before the threshold", () => {
    let s = emptyHostState();
    const now = 1_000_000;
    for (let i = 0; i < THROTTLES_BEFORE_PAUSE - 1; i++) {
      s = noteHostOutcome(s, true, now);
    }
    assert.equal(hostIsPaused(s, now), false);
  });

  it("resets the throttle run on any success", () => {
    let s = emptyHostState();
    s = noteHostOutcome(s, true, 1000);
    s = noteHostOutcome(s, true, 1000);
    s = noteHostOutcome(s, false, 1000);
    assert.equal(s.consecutiveThrottles, 0);
  });

  it("backs off exponentially and caps", () => {
    assert.equal(backfillBackoffMs(0), 2000);
    assert.equal(backfillBackoffMs(1), 4000);
    assert.equal(backfillBackoffMs(2), 8000);
    assert.equal(backfillBackoffMs(20), 60_000, "must cap");
  });
});

describe("dateFromArchiveKey — SCBSEALL's year lives in the PATH (MONEY-1100)", () => {
  it("combines the basename's DDMM with the key's /YYYY/MM/", () => {
    // The regression: 4,836 archived BSE gross-delivery files skipped as
    // "no date token" because SCBSEALL0207.zip carries no year.
    const d = dateFromArchiveKey(
      "feeds/BSE/gross-delivery/2026/07/SCBSEALL0207.zip",
    );
    assert.equal(d && isoDay(d), "2026-07-02");
  });

  it("returns null when the file's MM disagrees with the path's MM", () => {
    // A mis-filed object must not be stamped with either month.
    assert.equal(
      dateFromArchiveKey("feeds/BSE/gross-delivery/2026/08/SCBSEALL0207.zip"),
      null,
    );
  });

  it("does not disturb the year-bearing formats", () => {
    const mto = dateFromArchiveKey("feeds/NSE/mto/2026/08/MTO_07082026.DAT");
    assert.equal(mto && isoDay(mto), "2026-08-07");
    const udiff = dateFromArchiveKey(
      "feeds/BSE/bhavcopy/2026/08/BhavCopy_BSE_CM_0_0_0_20260807_F_0000.CSV",
    );
    assert.equal(udiff && isoDay(udiff), "2026-08-07");
  });
});

describe("dateFromArchiveKey — YYYYMMDD/DDMMYYYY collision (MONEY-1100)", () => {
  // `ind_close_all_20052016.csv` is 20 May 2016, but the YYYYMMDD regex reads
  // it as year 2005 / month 20 / day 16. Year-anchoring does not prevent this
  // — "2005" is a valid year prefix — and the branch used to RETURN that
  // invalid parse's null instead of trying DDMMYYYY, so the file was skipped
  // as undateable. 67 index-close days were dropped in one sweep, which is why
  // IndexClose had era-wide holes and every F&O basis for those days was null.
  it("falls through to DDMMYYYY when the YYYYMMDD reading is not a real date", () => {
    const d = dateFromArchiveKey(
      "feeds/NSE/indices/2016/05/ind_close_all_20052016.csv",
    );
    assert.equal(d && isoDay(d), "2016-05-20");
  });

  it("handles the other ambiguous month-20 dates in the same family", () => {
    const d = dateFromArchiveKey(
      "feeds/NSE/indices/2015/11/ind_close_all_20112015.csv",
    );
    assert.equal(d && isoDay(d), "2015-11-20");
  });

  it("still prefers a VALID YYYYMMDD reading over the DDMMYYYY one", () => {
    // 20240628: YYYYMMDD is valid (2024-06-28) and must win. The same digits
    // read as DDMMYYYY would be day 20 / month 24 — nonsense — so preferring
    // the year-anchored reading first is still right.
    const d = dateFromArchiveKey(
      "feeds/NSE/bhavcopy/2024/06/BhavCopy_NSE_CM_0_0_0_20240628_F_0000.csv.zip",
    );
    assert.equal(d && isoDay(d), "2024-06-28");
  });

  it("still returns null when there is genuinely no date token", () => {
    assert.equal(dateFromArchiveKey("feeds/NSE/x/2024/06/readme.txt"), null);
  });
});

describe("dateFromArchiveKey — BSE legacy DDMMYY (MONEY-1101)", () => {
  it("dates both legacy BSE cash filename shapes", () => {
    // Without this branch every archived object in an 18-year BSE backfill is
    // skipped as "no date token" — the same failure that dropped all 4,836
    // gross-delivery files above, at ~10x the volume.
    const plain = dateFromArchiveKey(
      "feeds/BSE/cm-legacy/2007/01/eq020107_csv.zip",
    );
    assert.equal(plain && isoDay(plain), "2007-01-02");
    const isin = dateFromArchiveKey(
      "feeds/BSE/cm-isin-legacy/2023/03/EQ_ISINCODE_150323.zip",
    );
    assert.equal(isin && isoDay(isin), "2023-03-15");
  });

  it("rejects a mis-filed object rather than guessing a century", () => {
    // `23` alone cannot distinguish 1923 from 2023, so the path supplies the
    // year and a disagreement is fatal — stamping either value would store a
    // whole trading day under the wrong date.
    assert.equal(
      dateFromArchiveKey(
        "feeds/BSE/cm-isin-legacy/2023/04/EQ_ISINCODE_150323.zip",
      ),
      null,
      "month disagreement",
    );
    assert.equal(
      dateFromArchiveKey(
        "feeds/BSE/cm-isin-legacy/2022/03/EQ_ISINCODE_150323.zip",
      ),
      null,
      "year disagreement",
    );
  });

  it("does not widen into a generic six-digit match", () => {
    // The anchor is the whole safety argument: a bare \d{6} would bite scrip
    // codes and settlement numbers, and a mis-dated object is worse than an
    // undated one.
    assert.equal(
      dateFromArchiveKey("feeds/BSE/x/2023/03/scrip_500002.zip"),
      null,
    );
  });

  it("leaves the year-bearing formats alone", () => {
    const udiff = dateFromArchiveKey(
      "feeds/BSE/bhavcopy/2024/02/BhavCopy_BSE_CM_0_0_0_20240201_F_0000.CSV",
    );
    assert.equal(udiff && isoDay(udiff), "2024-02-01");
  });
});

describe("weekday adjacency", () => {
  it("makes Friday the predecessor of Monday", () => {
    // 2026-08-10 is a Monday; 2026-08-07 the Friday before.
    assert.equal(isoDay(previousWeekday(parseDay("2026-08-10"))), "2026-08-07");
    assert.equal(isoDay(previousWeekday(parseDay("2026-08-07"))), "2026-08-06");
  });

  it("rejects days that merely LOOK close", () => {
    // Thursday -> Monday is only 3 calendar days, the same gap as Monday ->
    // Friday, but it skips Tuesday and Wednesday. A gap-size heuristic would
    // call this adjacent; the real predecessor test does not.
    assert.equal(
      isPrecedingWeekday(parseDay("2026-08-13"), parseDay("2026-08-10")),
      false,
    );
    assert.equal(
      isPrecedingWeekday(parseDay("2026-08-10"), parseDay("2026-08-07")),
      true,
    );
  });
});

describe("stop-loss", () => {
  // ReadonlyArray of readonly tuples — MONEY-1118 item 13. Every call site
  // builds its fixture with `as const` (which is right: these are fixed
  // scripts, and widening them to string[] would let a typo through), and
  // `as const` produces READONLY tuples. The mutable signature rejected them.
  //
  // Invisible until now because `packages/core/tsconfig.json` includes only
  // `src/**`, so no test file in this package had ever been type-checked.
  // Widening the parameter is the fix rather than casting at each call site:
  // the helper only reads `steps`.
  const run = (
    steps: ReadonlyArray<
      readonly [
        "DONE" | "MISSING" | "ERROR",
        "transport" | "payload" | undefined,
        string,
      ]
    >,
  ) => {
    let runs = emptyErrorRuns();
    const peak = { transport: 0, payload: 0 };
    for (const [status, kind, day] of steps) {
      runs = advanceErrorRuns(runs, status, kind, parseDay(day));
      peak.transport = Math.max(peak.transport, runs.transport);
      peak.payload = Math.max(peak.payload, runs.payload);
    }
    return { runs, peak };
  };

  it("aborts on consecutive TRANSPORT failures — the host stopped serving us", () => {
    const steps = Array.from(
      { length: DEFAULT_TRANSPORT_STOP_LOSS },
      () => ["ERROR", "transport", "2026-08-07"] as const,
    );
    const { runs } = run([...steps]);
    assert.equal(runs.transport, DEFAULT_TRANSPORT_STOP_LOSS);
    assert.equal(shouldAbort(runs.transport), true);
  });

  it("resets the transport run on DONE and on MISSING alike", () => {
    // A 404 is a completed HTTP exchange: the server answered. That is exactly
    // the evidence whose absence the stop-loss detects.
    for (const ok of ["DONE", "MISSING"] as const) {
      const { runs } = run([
        ["ERROR", "transport", "2026-08-07"],
        ["ERROR", "transport", "2026-08-06"],
        [ok, undefined, "2026-08-05"],
      ]);
      assert.equal(runs.transport, 0, `${ok} must break the transport run`);
    }
  });

  it("never lets a PAYLOAD failure feed the transport stop-loss", () => {
    // ABORT #1. A 200 carrying HTML is positive evidence the host is healthy,
    // so it cannot be evidence the host stopped serving us. 500 of them in a
    // row must leave the transport counter untouched.
    const steps: Array<["ERROR", "payload", string]> = Array.from(
      { length: 500 },
      () => ["ERROR", "payload", "2026-08-07"],
    );
    const { peak } = run(steps);
    assert.equal(peak.transport, 0);
  });

  it("survives 30 years of scattered holidays", () => {
    // ABORT #1, in the shape that actually killed it: ~15 holidays a year, each
    // isolated between trading days. A cumulative counter reached 25 inside two
    // years, so a BSE and an NSE family both died at 423 done / 25 errors —
    // identical numbers, because the exchanges share one holiday calendar.
    const steps: Array<["DONE" | "ERROR", "payload" | undefined, string]> = [];
    for (let y = 0; y < 30; y++) {
      for (let h = 0; h < 15; h++) {
        steps.push(["ERROR", "payload", "2026-08-07"]);
        steps.push(["DONE", undefined, "2026-08-06"]);
      }
    }
    const { peak } = run(steps);
    assert.equal(peak.transport, 0);
    assert.equal(peak.payload, 1, "each holiday is an isolated failure");
  });

  it("survives a RESUMED plan where past failures arrive back-to-back", () => {
    // ABORT #2, and the case both previous fixes missed. Resume excludes DONE
    // and MISSING days from the plan, so the days that previously errored are
    // the ONLY ones left in that window and arrive consecutively in walk order
    // while sitting months apart in the calendar.
    //
    // These are the real dates from the production run that aborted:
    // nse-index-snapshot's 25 errored days, newest first.
    const resumed = [
      "2026-06-26",
      "2026-05-28",
      "2026-05-01",
      "2026-04-14",
      "2026-04-03",
      "2026-03-31",
      "2026-03-06",
      "2026-02-17",
      "2026-01-26",
      "2025-12-25",
      "2025-11-05",
      "2025-10-21",
      "2025-10-02",
      "2025-08-27",
      "2025-08-15",
      "2025-04-18",
      "2025-04-10",
      "2025-03-31",
      "2025-03-14",
      "2025-02-26",
      "2025-01-26",
      "2024-12-25",
      "2024-11-20",
      "2024-11-15",
      "2024-11-01",
    ];
    const { peak } = run(resumed.map((d) => ["ERROR", "payload", d] as const));
    assert.equal(peak.transport, 0, "payload failures never abort the run");
    assert.equal(
      peak.payload,
      1,
      "months apart in the calendar means the payload streak never builds",
    );
    assert.ok(
      peak.payload < DEFAULT_PAYLOAD_STOP_LOSS,
      "a resumed plan must not trip the payload stop-loss",
    );
  });

  it("DOES trip the payload stop-loss on genuinely adjacent trading days", () => {
    // The case the payload limit exists for: the host answers 200 for every
    // consecutive weekday but the body is never this feed — a wrong URL era, or
    // a soft block. Walk 2026-08-07 backwards over real weekdays.
    const steps: Array<["ERROR", "payload", string]> = [];
    let d = parseDay("2026-08-07");
    for (let i = 0; i < DEFAULT_PAYLOAD_STOP_LOSS; i++) {
      steps.push(["ERROR", "payload", isoDay(d)]);
      d = previousWeekday(d);
    }
    const { runs } = run(steps);
    assert.equal(runs.payload, DEFAULT_PAYLOAD_STOP_LOSS);
    assert.equal(runs.transport, 0, "still not a transport problem");
  });

  it("breaks a payload streak when a real day succeeds in the middle", () => {
    const steps: Array<["ERROR" | "DONE", "payload" | undefined, string]> = [];
    let d = parseDay("2026-08-07");
    for (let i = 0; i < 30; i++) {
      steps.push(["ERROR", "payload", isoDay(d)]);
      d = previousWeekday(d);
    }
    steps.push(["DONE", undefined, isoDay(d)]);
    d = previousWeekday(d);
    for (let i = 0; i < 30; i++) {
      steps.push(["ERROR", "payload", isoDay(d)]);
      d = previousWeekday(d);
    }
    const { peak } = run(steps);
    assert.equal(
      peak.payload,
      30,
      "one success halves the streak into two survivable halves",
    );
    assert.ok(peak.payload < DEFAULT_PAYLOAD_STOP_LOSS);
  });
});

describe("planFamily", () => {
  it("skips days already checkpointed", () => {
    const plan = planFamily(
      family("f"),
      "2026-08-03",
      "2026-08-07",
      new Set(["2026-08-05", "2026-08-06"]),
    );
    assert.deepEqual(plan.days.map(isoDay), [
      "2026-08-07",
      "2026-08-04",
      "2026-08-03",
    ]);
  });

  it("records the declared floor for the below-floor test", () => {
    const plan = planFamily(family("f"), "2020-01-01", "2020-01-10", new Set());
    assert.equal(plan.floorIso, "2020-01-01");
  });

  it("can descend below the floor to hunt the true edge", () => {
    const plan = planFamily(
      family("f"),
      "2020-01-06",
      "2020-01-10",
      new Set(),
      10,
    );
    const oldest = isoDay(plan.days[plan.days.length - 1]!);
    assert.ok(oldest < "2020-01-06", "must explore below the declared floor");
    // ...but the floor recorded for the K-miss test stays the DECLARED one,
    // otherwise nothing would ever count as "below floor".
    assert.equal(plan.floorIso, "2020-01-06");
  });

  it("returns nothing when every day is checkpointed", () => {
    const all = new Set(
      weekdaysDescending("2026-08-03", "2026-08-07").map(isoDay),
    );
    assert.equal(
      planFamily(family("f"), "2026-08-03", "2026-08-07", all).days.length,
      0,
    );
  });
});

describe("summary", () => {
  it("reports missing separately from errors", () => {
    const line = summarizeFamily("nse-cm-legacy", {
      ...emptyTally(),
      done: 10,
      missing: 3,
      error: 1,
      bytes: 2_097_152,
    });
    assert.match(line, /10 archived/);
    assert.match(line, /3 missing/);
    assert.match(line, /1 errors/);
    assert.match(line, /2\.0 MB/);
  });
});

describe("dateFromArchiveKey", () => {
  const iso = (k: string): string | null =>
    dateFromArchiveKey(k)?.toISOString().slice(0, 10) ?? null;

  it("reads the UDiFF YYYYMMDD token", () => {
    assert.equal(
      iso(
        "feeds/NSE/bhavcopy/2026/08/BhavCopy_NSE_CM_0_0_0_20260807_F_0000.csv.zip",
      ),
      "2026-08-07",
    );
  });

  it("reads DDMMYYYY WITHOUT mistaking it for YYYYMMDD", () => {
    // Both tokens are 8 digits; only the leading 19|20 anchor separates them.
    // If the YYYYMMDD branch were tried unanchored (or DDMMYYYY tried first),
    // MTO_08082026 would parse as year 0808 — ~2000 years out, on every file.
    assert.equal(iso("feeds/NSE/mto/2026/08/MTO_08082026.DAT"), "2026-08-08");
  });

  it("reads the legacy DDMMMYYYY token", () => {
    assert.equal(
      iso("feeds/NSE/cm-legacy/1994/11/cm03NOV1994bhav.csv.zip"),
      "1994-11-03",
    );
    assert.equal(
      iso("feeds/NSE/fo-legacy/2000/06/fo12JUN2000bhav.csv.zip"),
      "2000-06-12",
    );
  });

  it("prefers the archiver's own ISO prefix on rolling families", () => {
    assert.equal(
      iso("feeds/NSE/bulk-deals/2026/08/2026-08-07-bulk.csv"),
      "2026-08-07",
    );
  });

  // ── MONEY-1204 / P0.1 — the SEPARATED DD-Mon-YYYY token ──────────────────
  //
  // Before this branch existed all six others returned null for these names:
  // no 8-digit run for YYYYMMDD/DDMMYYYY, and the dashes break the contiguous
  // DDMMMYYYY token. `feed-parse` then skipped 100% of both families with a
  // "no date token in the object name" warning — which is indistinguishable
  // from "NSE published nothing", so 1,636 archived fii-stats objects would
  // have produced zero rows with every counter reporting a clean run.

  it("reads DD-Mon-YYYY, the separated month token (fii_stats)", () => {
    assert.equal(
      iso("feeds/NSE/fii-stats/2026/08/fii_stats_13-Aug-2026.xls"),
      "2026-08-13",
    );
    // The archive floor, verified in the prod bucket on 2026-08-15.
    assert.equal(
      iso("feeds/NSE/fii-stats/2020/01/fii_stats_01-Jan-2020.xls"),
      "2020-01-01",
    );
  });

  it("reads DD-Mon-YYYY on the OTHER family it unblocks (corporate bond report)", () => {
    // One branch, two families. `nse-corporate-bond-report` was silently
    // undateable for the same reason and is a Lane 14b dependency.
    assert.equal(
      iso(
        "feeds/NSE/corporate-bond-report/2026/08/Corporate_bond_report_13-Aug-2026.csv",
      ),
      "2026-08-13",
    );
  });

  it("tolerates a single-digit day and a full month name", () => {
    assert.equal(iso("feeds/NSE/x/2026/09/thing_9-Sep-2026.csv"), "2026-09-09");
    assert.equal(
      iso("feeds/NSE/x/2026/08/thing_13-August-2026.csv"),
      "2026-08-13",
    );
  });

  it("rejects an impossible day and an unknown month rather than guessing", () => {
    // A matching PATTERN is not a valid DATE — the same lesson the YYYYMMDD
    // branch above records. Both guards must hold: MONTH_TOKENS for the month,
    // isoOrNull's round-trip for the day.
    assert.equal(iso("feeds/NSE/x/2026/02/thing_31-Feb-2026.csv"), null);
    assert.equal(iso("feeds/NSE/x/2026/08/thing_13-Xyz-2026.csv"), null);
  });

  it("does not disturb any family that already resolved", () => {
    // The new branch is reached only after all six existing ones decline, so
    // it cannot regress them. This pins that claim rather than asserting it.
    assert.equal(
      iso("feeds/NSE/slb-openpos/2026/08/slb_openpos_14082026.csv"),
      "2026-08-14",
    );
    assert.equal(
      iso("feeds/NSE/indices/2016/05/ind_close_all_20052016.csv"),
      "2016-05-20",
    );
    assert.equal(
      iso("feeds/BSE/bhavcopy/2023/03/eq150323_csv.zip"),
      "2023-03-15",
    );
    assert.equal(
      iso("feeds/NSE/cm-legacy/1994/11/cm03NOV1994bhav.csv"),
      "1994-11-03",
    );
  });

  it("resolves SCBSEALL's bare DDMM from the key's own path year", () => {
    // This case USED to assert null ("a bare DDMM is ambiguous, don't guess").
    // That encoded a bug as intent: the year is not ambiguous at all — it is
    // in the /YYYY/MM/ segments of the very key this function receives, and
    // asserting null cost the first delivery-parse run all 4,836 BSE files.
    // The don't-guess concern survives as the MM cross-check: see the
    // mismatched-month case in the MONEY-1100 describe above.
    assert.equal(
      iso("feeds/BSE/gross-delivery/2026/08/SCBSEALL0708.zip"),
      "2026-08-07",
    );
  });

  it("returns null for junk", () => {
    assert.equal(iso("feeds/NSE/x/2026/08/no-date-here.csv"), null);
    assert.equal(iso(""), null);
  });

  it("rejects a rolled-over date", () => {
    assert.equal(iso("feeds/NSE/x/2026/02/FILE_30022026.csv"), null);
  });
});

describe("archives-door fallback", () => {
  it("never sends a family with NO confirmed descriptor to the door", () => {
    // The load-bearing condition. A guessed door name returns the same 404 an
    // absent file does, so the walk would record MISSING for days that exist —
    // corrupting the archive's own account of what history is available.
    assert.equal(shouldTryDoor(99, false), false);
    assert.equal(shouldTryDoor(THROTTLES_BEFORE_DOOR, false), false);
  });

  it("tries the door once the throttle threshold is hit", () => {
    assert.equal(shouldTryDoor(THROTTLES_BEFORE_DOOR, true), true);
    assert.equal(shouldTryDoor(THROTTLES_BEFORE_DOOR - 1, true), false);
  });

  it("fires BEFORE the host pause, so a working door avoids the pause entirely", () => {
    assert.ok(THROTTLES_BEFORE_DOOR < THROTTLES_BEFORE_PAUSE);
  });
});

describe("chunkStartsDescending (range-addressed families)", () => {
  it("steps by the window, not by the day", () => {
    // BSE's index endpoint returns a whole span per request. Walking it daily
    // would issue 30 requests for data the first one already returned — against
    // a rate-limited host, that is the difference between finishing and being
    // blocked.
    const starts = chunkStartsDescending("2026-01-01", "2026-03-31", 30);
    assert.equal(starts.length, 3);
    assert.ok(starts[0]! > starts[1]!, "newest first");
  });

  it("clamps the oldest window so it cannot begin before the floor", () => {
    const starts = chunkStartsDescending("2026-01-01", "2026-02-15", 30);
    const oldest = starts[starts.length - 1]!;
    assert.ok(isoDay(oldest) >= "2026-01-01");
  });

  it("does NOT skip weekends — a 30-day window contains them by definition", () => {
    // Skipping a start that lands on a Saturday would leave a hole a whole
    // chunk wide, not a day wide.
    const starts = chunkStartsDescending("2026-08-01", "2026-08-31", 7);
    assert.ok(starts.length >= 4);
  });

  it("cuts a 30-year span to hundreds of requests, not thousands", () => {
    const chunked = chunkStartsDescending(
      "1986-01-01",
      "2026-08-09",
      30,
    ).length;
    const daily = weekdaysDescending("1986-01-01", "2026-08-09").length;
    assert.ok(chunked < daily / 15, `${chunked} vs ${daily}`);
  });

  it("returns at least one window for a single day", () => {
    assert.equal(
      chunkStartsDescending("2026-08-07", "2026-08-07", 30).length,
      1,
    );
  });
});
