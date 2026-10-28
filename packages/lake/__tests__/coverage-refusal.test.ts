/**
 * One refused month must not end a replay — MONEY-1612.
 *
 * Prod, 2026-09-23: `lake-replay-in --tables delivery_daily --from 2019-10-01`
 * refused 2019-10 (`partial: 19/23 sessions present`), let the
 * `CoverageRefusedError` escape, exited 1, and never attempted the ~80 months
 * after it — while 2019-10 sat LOADING for the six-hour lease.
 *
 * The fake ledger below keeps ONE state per partition and runs the REAL
 * `decideCoverage` inside `accept`, exactly as `acceptPartition` does, so a
 * refusal here is the same class thrown for the same reason.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CoverageRefusedError,
  PartitionsRefusedError,
  acceptOrRefuse,
  decideClaim,
  decideCoverage,
  formatRefusal,
  missingSessions,
  throwIfRefused,
  type PartitionKey,
  type PartitionRefusal,
  type PartitionState,
  type RefusalLedger,
} from "../src/ledger-logic";
import { CoverageRefusedError as LedgerCoverageRefusedError } from "../src/ledger";
import {
  classifyReadDate,
  classifyReadFile,
  combineBhavcopyProbes,
  combineOwnKeyMatches,
  compareArchivedObjects,
  decideMonth,
  describeForeignSessions,
  indiaSourceHash,
  isStaleCopyCandidate,
  type OwnKeyMatch,
} from "../src/india-sink-logic";

const key = (partitionKey: string): PartitionKey => ({
  dataset: "lake_silver_prod",
  table: "delivery_daily",
  partitionKey,
  sourceHash: "h",
  parserVersion: "v1",
});

function fakeLedger(opts: { acceptThrows?: Error } = {}) {
  const state = new Map<string, PartitionState>();
  const rejected: { partitionKey: string; args: unknown }[] = [];
  const quarantined: {
    partitionKey: string;
    reason: string;
    sample?: unknown;
  }[] = [];
  const accepted: string[] = [];
  const ledger: RefusalLedger = {
    async accept(k, a) {
      if (opts.acceptThrows) throw opts.acceptThrows;
      const v = decideCoverage(a);
      if (!v.accept) throw new CoverageRefusedError(v.reason);
      state.set(k.partitionKey, "ACCEPTED");
      accepted.push(k.partitionKey);
    },
    async reject(k, a) {
      state.set(k.partitionKey, "REJECTED");
      rejected.push({ partitionKey: k.partitionKey, args: a });
    },
    async quarantine(a) {
      quarantined.push({
        partitionKey: a.partitionKey,
        reason: a.reason,
        sample: a.sample,
      });
    },
  };
  /** What `claimPartition` does before the load. */
  const claim = (pk: string) => state.set(pk, "LOADING");
  return { ledger, state, rejected, quarantined, accepted, claim };
}

const OCT = {
  // Measured on prod: 23 weekday files read, 19 sessions produced rows.
  datesRead: [
    "2019-10-01",
    "2019-10-02",
    "2019-10-03",
    "2019-10-04",
    "2019-10-07",
    "2019-10-08",
    "2019-10-09",
    "2019-10-10",
    "2019-10-11",
    "2019-10-14",
    "2019-10-15",
    "2019-10-16",
    "2019-10-17",
    "2019-10-18",
    "2019-10-21",
    "2019-10-22",
    "2019-10-23",
    "2019-10-24",
    "2019-10-25",
    "2019-10-28",
    "2019-10-29",
    "2019-10-30",
    "2019-10-31",
  ],
  /**
   * The four read dates that produced no session. NOT four holidays: three
   * are stale copies of the prior weekday, and 2019-10-28 is the only copy of
   * the Sunday 2019-10-27 Muhurat session (MONEY-1612 review).
   */
  noSession: ["2019-10-02", "2019-10-08", "2019-10-21", "2019-10-28"],
  /** What each of those files actually holds (their rows' DATE1). */
  held: {
    "2019-10-02": "2019-10-01",
    "2019-10-08": "2019-10-07",
    "2019-10-21": "2019-10-18",
    "2019-10-28": "2019-10-27",
  } as Record<string, string>,
};
const octSessions = new Set(
  OCT.datesRead.filter((d) => !OCT.noSession.includes(d)),
);

/** The script's per-month step: claim, (load), accept-or-refuse. */
async function month(
  f: ReturnType<typeof fakeLedger>,
  pk: string,
  expected: number,
  actual: number,
  missing: string[] = [],
): Promise<PartitionRefusal | null> {
  f.claim(pk);
  return acceptOrRefuse(
    key(pk),
    {
      runId: "run-1",
      rowCount: 1000,
      expectedSessions: expected,
      actualSessions: actual,
      missingSessions: missing,
    },
    f.ledger,
  );
}

describe("missingSessions", () => {
  it("names exactly the read dates that produced no session, sorted", () => {
    assert.deepEqual(
      missingSessions([...OCT.datesRead].reverse(), octSessions),
      OCT.noSession,
    );
  });
  it("is empty for a complete month", () => {
    assert.deepEqual(missingSessions(octSessions, octSessions), []);
  });
});

describe("acceptOrRefuse", () => {
  it("a coverage refusal leaves the partition REJECTED — terminal, not LOADING", async () => {
    const f = fakeLedger();
    const missing = missingSessions(OCT.datesRead, octSessions);
    const r = await month(f, "2019-10", 23, 19, missing);

    assert.ok(r, "a refusal must be returned, not thrown");
    assert.equal(f.state.get("2019-10"), "REJECTED");
    // And the lease is released: the next run may load it at once, rather
    // than skipping it for six hours as a live LOADING claim.
    assert.equal(
      decideClaim({ state: "REJECTED", loadedAtMs: 0 }, 1).action,
      "load",
    );
    assert.deepEqual(f.rejected[0]?.args, {
      runId: "run-1",
      rowCount: 1000,
      expectedSessions: 23,
      actualSessions: 19,
    });
    assert.equal(f.quarantined.length, 1);
    assert.equal(
      f.quarantined[0]?.reason,
      "COVERAGE_REFUSED partial: 19/23 sessions present",
    );
    assert.deepEqual(
      (f.quarantined[0]?.sample as { missingSessions: string[] })
        .missingSessions,
      OCT.noSession,
    );
    assert.equal(
      formatRefusal(r),
      "REFUSED delivery_daily 2019-10 partial: 19/23 sessions present — " +
        "missing: 2019-10-02, 2019-10-08, 2019-10-21, 2019-10-28",
    );
  });

  it("a complete month is ACCEPTED and neither rejected nor quarantined", async () => {
    const f = fakeLedger();
    assert.equal(await month(f, "2019-09", 20, 20), null);
    assert.equal(f.state.get("2019-09"), "ACCEPTED");
    assert.equal(f.rejected.length, 0);
    assert.equal(f.quarantined.length, 0);
  });

  it("ANY OTHER error propagates, and nothing is rejected", async () => {
    const boom = new Error("Could not reach BigQuery");
    const f = fakeLedger({ acceptThrows: boom });
    await assert.rejects(month(f, "2019-10", 23, 23), (e) => e === boom);
    assert.equal(f.rejected.length, 0);
    assert.equal(f.quarantined.length, 0);
    assert.equal(f.state.get("2019-10"), "LOADING");
  });

  it("an Error merely WORDED like a refusal is not one — matched by class", async () => {
    const f = fakeLedger({
      acceptThrows: new Error(
        "refusing to ACCEPT this partition: partial: 1/2 sessions present",
      ),
    });
    await assert.rejects(month(f, "2019-10", 2, 1));
    assert.equal(f.rejected.length, 0);
  });

  it("ledger.ts re-exports the SAME class, so its throw is caught", () => {
    assert.equal(LedgerCoverageRefusedError, CoverageRefusedError);
  });
});

describe("a run over many months", () => {
  /** The shape both replay scripts' `main` has: collect, then fail at the end. */
  async function run(
    f: ReturnType<typeof fakeLedger>,
    months: [string, number, number][],
  ): Promise<void> {
    const refused: PartitionRefusal[] = [];
    for (const [pk, exp, act] of months) {
      const r = await month(f, pk, exp, act, exp > act ? ["2019-11-12"] : []);
      if (r) refused.push(r);
    }
    throwIfRefused(refused);
  }

  it("continues past a refusal and ends non-zero, listing every refused month", async () => {
    const f = fakeLedger();
    await assert.rejects(
      run(f, [
        ["2019-10", 23, 19],
        ["2019-11", 21, 20],
        ["2019-12", 22, 22],
      ]),
      (e: unknown) => {
        assert.ok(e instanceof PartitionsRefusedError);
        assert.equal(e.refusals.length, 2);
        assert.match(e.message, /2 partition\(s\) REFUSED/);
        assert.match(
          e.message,
          /REFUSED delivery_daily 2019-10 partial: 19\/23/,
        );
        assert.match(
          e.message,
          /REFUSED delivery_daily 2019-11 partial: 20\/21/,
        );
        return true;
      },
    );
    // The months AFTER the refusal were attempted and loaded.
    assert.deepEqual(f.accepted, ["2019-12"]);
    assert.equal(f.state.get("2019-11"), "REJECTED");
  });

  it("a clean run does not throw", async () => {
    const f = fakeLedger();
    await run(f, [["2019-12", 22, 22]]);
    assert.doesNotThrow(() => throwIfRefused([]));
  });

  it("another error aborts: no later month is attempted", async () => {
    const f = fakeLedger({ acceptThrows: new Error("load exploded") });
    await assert.rejects(
      run(f, [
        ["2019-10", 23, 23],
        ["2019-11", 21, 21],
      ]),
      /load exploded/,
    );
    assert.equal(f.state.has("2019-11"), false);
  });
});

describe("both replay jobs route the accept through acceptOrRefuse", () => {
  // Wiring only — the behaviour is pinned above. Without this, a job that
  // went back to a bare `acceptPartition(` would pass every test here.
  for (const job of ["lake-replay-in.ts", "lake-replay-us.ts"]) {
    it(job, () => {
      const src = readFileSync(
        join(import.meta.dirname, "..", "..", "..", "scripts", "jobs", job),
        "utf8",
      );
      assert.equal(src.split("await acceptPartition(").length - 1, 0);
      assert.match(src, /await acceptOrRefuse\(/);
      assert.match(
        src,
        /\{ accept: acceptPartition, reject: rejectPartition, quarantine \}/,
      );
      assert.match(src, /throwIfRefused\(refused\);\s*\} catch \(err\) \{/);
    });
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   Stale copies on holidays — MONEY-1612
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The four real zero-row files on prod whose rows are the ONLY copy of a
 * weekend session (key date -> the DATE1 the file holds). Found by reading all
 * 85 delivery files whose key date has no bhavcopy archived.
 */
const WEEKEND_HELD: readonly (readonly [string, string])[] = [
  ["2019-10-28", "2019-10-27"], // Sunday Muhurat, 1,799 rows
  ["2020-11-16", "2020-11-14"], // Saturday Muhurat, 1,876 rows
  ["2024-01-22", "2024-01-20"], // Saturday full session, 2,549 rows
  ["2024-05-20", "2024-05-18"], // Saturday DR session, 2,449 rows
];

const candidate = (keyDate: string, ...mismatchedDates: string[]) =>
  isStaleCopyCandidate({ rows: 0, keyDate, mismatchedDates });

describe("isStaleCopyCandidate — the date PRECONDITION", () => {
  it("an earlier weekday -> candidate", () => {
    assert.equal(candidate("2019-10-02", "2019-10-01"), true);
    assert.equal(candidate("2019-10-21", "2019-10-18"), true); // Mon holds Fri
  });
  it("an earlier weekday in the PREVIOUS month -> candidate", () => {
    assert.equal(candidate("2020-05-01", "2020-04-30"), true);
  });
  for (const [keyDate, held] of WEEKEND_HELD) {
    it(`${keyDate} holding weekend session ${held} is NOT a candidate`, () => {
      assert.equal(candidate(keyDate, held), false);
    });
  }
  it("a date on or after the key is NOT a candidate", () => {
    assert.equal(candidate("2019-10-02", "2019-10-03"), false);
  });
  it("one weekend date among earlier weekdays -> NOT a candidate", () => {
    assert.equal(candidate("2019-10-08", "2019-10-07", "2019-10-05"), false);
  });
  it("an EMPTY file is not a candidate — a dark family stays missing", () => {
    assert.equal(candidate("2019-10-02"), false);
  });
  // MONEY-1613: a calendar weekend date is read under its OWN key, so it is a
  // candidate like any earlier weekday — the bytes still decide.
  for (const [keyDate, held] of WEEKEND_HELD) {
    it(`${keyDate} holding ${held} IS a candidate once ${held} is in the calendar`, () => {
      assert.equal(
        isStaleCopyCandidate({
          rows: 0,
          keyDate,
          mismatchedDates: [held],
          calendarDates: [held],
        }),
        true,
      );
    });
  }
  it("a weekend NOT in the calendar stays a non-candidate", () => {
    assert.equal(
      isStaleCopyCandidate({
        rows: 0,
        keyDate: "2019-10-28",
        mismatchedDates: ["2019-10-27"],
        calendarDates: ["2019-10-26"],
      }),
      false,
    );
  });
  it("a file with rows is not a candidate", () => {
    assert.equal(
      isStaleCopyCandidate({
        rows: 5,
        keyDate: "2019-10-02",
        mismatchedDates: ["2019-10-01"],
      }),
      false,
    );
  });
});

describe("compareArchivedObjects — the bytes are the proof", () => {
  it("equal md5 -> equal; different md5 -> different", () => {
    assert.equal(
      compareArchivedObjects({ md5Hash: "A" }, { md5Hash: "A" }),
      "equal",
    );
    assert.equal(
      compareArchivedObjects({ md5Hash: "A" }, { md5Hash: "B" }),
      "different",
    );
  });
  it("md5 decides when both have it, whatever crc32c says", () => {
    assert.equal(
      compareArchivedObjects(
        { md5Hash: "A", crc32c: "c" },
        { md5Hash: "B", crc32c: "c" },
      ),
      "different",
    );
  });
  it("falls back to crc32c when a side has no md5 (composite objects)", () => {
    assert.equal(
      compareArchivedObjects({ md5Hash: "A", crc32c: "c" }, { crc32c: "c" }),
      "equal",
    );
    assert.equal(
      compareArchivedObjects({ crc32c: "c" }, { crc32c: "d" }),
      "different",
    );
  });
  it("own key holds no object -> different (this file is the only copy)", () => {
    assert.equal(compareArchivedObjects({ md5Hash: "A" }, null), "different");
  });
  it("no hash both sides carry -> unreadable", () => {
    assert.equal(
      compareArchivedObjects({ md5Hash: "A" }, { crc32c: "c" }),
      "unreadable",
    );
    assert.equal(compareArchivedObjects({}, {}), "unreadable");
    assert.equal(
      compareArchivedObjects({ md5Hash: "" }, { md5Hash: "" }),
      "unreadable",
    );
  });
});

describe("combineOwnKeyMatches", () => {
  it("equal only when EVERY held date's own key matches", () => {
    assert.equal(combineOwnKeyMatches(["equal"]), "equal");
    assert.equal(combineOwnKeyMatches(["equal", "equal"]), "equal");
  });
  it("any different wins, then any unreadable", () => {
    assert.equal(combineOwnKeyMatches(["equal", "different"]), "different");
    assert.equal(
      combineOwnKeyMatches(["unreadable", "different"]),
      "different",
    );
    assert.equal(combineOwnKeyMatches(["equal", "unreadable"]), "unreadable");
  });
  it("nothing compared proves nothing -> unreadable", () => {
    assert.equal(combineOwnKeyMatches([]), "unreadable");
  });
});

describe("classifyReadFile", () => {
  const k = (
    rows: number,
    keyDate: string,
    ownKeyMatch: OwnKeyMatch | null,
    ...m: string[]
  ) => classifyReadFile({ rows, keyDate, mismatchedDates: m, ownKeyMatch });
  it("rows, or nothing at all -> fresh", () => {
    assert.equal(k(1_900, "2019-10-01", null), "fresh");
    assert.equal(k(0, "2019-10-01", null), "fresh");
  });
  it("a candidate whose bytes EQUAL its own key -> stale", () => {
    assert.equal(k(0, "2019-10-02", "equal", "2019-10-01"), "stale");
  });
  it("a candidate whose own key differs, is missing or uncompared -> foreign", () => {
    // 05112021: holds 2021-11-04, an earlier weekday, and is its ONLY copy.
    assert.equal(k(0, "2021-11-05", "different", "2021-11-04"), "foreign");
    assert.equal(k(0, "2021-11-05", "unreadable", "2021-11-04"), "foreign");
    assert.equal(k(0, "2021-11-05", null, "2021-11-04"), "foreign");
  });
  it("a weekend session is foreign even if its bytes somehow matched", () => {
    assert.equal(k(0, "2019-10-28", "equal", "2019-10-27"), "foreign");
  });
  it("a CALENDAR weekend session whose bytes match -> stale (MONEY-1613)", () => {
    const file = {
      rows: 0,
      keyDate: "2019-10-28",
      mismatchedDates: ["2019-10-27"],
      calendarDates: ["2019-10-27"],
    };
    assert.equal(classifyReadFile({ ...file, ownKeyMatch: "equal" }), "stale");
    assert.equal(
      classifyReadFile({ ...file, ownKeyMatch: "different" }),
      "foreign",
    );
  });
});

describe("classifyReadDate", () => {
  const c = (
    freshFiles: number,
    staleFiles: number,
    bhavcopyPresent: boolean | null,
    foreignFiles = 0,
  ) =>
    classifyReadDate({ freshFiles, foreignFiles, staleFiles, bhavcopyPresent });

  it("a fresh file makes a session, stale or foreign siblings or not", () => {
    assert.equal(c(1, 0, null), "session");
    assert.equal(c(1, 1, false), "session");
    assert.equal(c(1, 0, false, 1), "session");
  });
  it("only stale copies + NO bhavcopy -> holiday", () => {
    assert.equal(c(0, 1, false), "holiday");
  });
  it("only stale copies + a bhavcopy -> a real gap", () => {
    assert.equal(c(0, 1, true), "stale-gap");
  });
  it("only stale copies + no bhavcopy family to ask -> a gap, never a holiday", () => {
    assert.equal(c(0, 1, null), "stale-gap");
  });
  it("a foreign file is a gap even with no bhavcopy — never a holiday", () => {
    assert.equal(c(0, 0, false, 1), "stale-gap");
    assert.equal(c(0, 1, false, 1), "stale-gap");
  });
  it("nothing read -> no verdict", () => {
    assert.equal(c(0, 0, false), null);
  });
});

describe("combineBhavcopyProbes", () => {
  it("any exchange with a bhavcopy -> it traded", () => {
    assert.equal(combineBhavcopyProbes([false, true]), true);
    assert.equal(combineBhavcopyProbes([null, true]), true);
  });
  it("any exchange that could not be probed -> unknown", () => {
    assert.equal(combineBhavcopyProbes([false, null]), null);
  });
  it("only EVERY probe proving absence -> absent", () => {
    assert.equal(combineBhavcopyProbes([false]), false);
    assert.equal(combineBhavcopyProbes([false, false]), false);
  });
  it("no probes prove nothing -> unknown, never absent", () => {
    assert.equal(combineBhavcopyProbes([]), null);
  });
});

describe("describeForeignSessions", () => {
  it("names a weekend session the walk never reads", () => {
    assert.equal(
      describeForeignSessions("2019-10-28", ["2019-10-27"], null),
      "weekend session 2019-10-27 — not walked",
    );
  });
  it("a calendar weekend session is walked — so it is named as not held under its own key", () => {
    assert.equal(
      describeForeignSessions("2019-10-28", ["2019-10-27"], "different", [
        "2019-10-27",
      ]),
      "session 2019-10-27 — not held under its own key",
    );
  });
  it("names a session on or after the key", () => {
    assert.equal(
      describeForeignSessions("2019-10-02", ["2019-10-03"], null),
      "session 2019-10-03 — on or after its key",
    );
  });
  it("names an earlier weekday this file is the only copy of", () => {
    assert.equal(
      describeForeignSessions("2021-11-05", ["2021-11-04"], "different"),
      "session 2021-11-04 — not held under its own key",
    );
    assert.equal(
      describeForeignSessions("2021-11-05", ["2021-11-04"], "unreadable"),
      "session 2021-11-04 — its own key could not be compared",
    );
  });
});

/** One archived object, as its GCS metadata describes it. */
interface ArchivedObject {
  md5?: string;
  crc32c?: string;
}

/** One archived file on one date, as the shell sees it after parsing. */
interface DayFile extends ArchivedObject {
  rows: number;
  /** DATE1 values of the rows that did not match the key. */
  held?: string[];
  /** The bhavcopy probe for that date, if the shell would ask. */
  bhavcopy?: boolean | null;
}

const metaOf = (o: ArchivedObject): Record<string, unknown> => ({
  ...(o.md5 === undefined ? {} : { md5Hash: o.md5 }),
  ...(o.crc32c === undefined ? {} : { crc32c: o.crc32c }),
});

/**
 * `replayMonth`'s per-date fold, built only from the pure pieces it calls
 * (`isStaleCopyCandidate`, `compareArchivedObjects`, `combineOwnKeyMatches`,
 * `classifyReadFile`, `combineBhavcopyProbes`, `classifyReadDate`), then the
 * gate and the ledger. `outside` holds archived objects under keys of other
 * months, for a held date across a month boundary.
 */
async function monthFromFiles(
  pk: string,
  files: Record<string, DayFile>,
  outside: Record<string, ArchivedObject> = {},
  calendarDates: readonly string[] = [],
) {
  const datesRead = new Set<string>();
  const holidays = new Set<string>();
  const sessions = new Set<string>();
  const notes = new Map<string, string>();
  for (const [date, f] of Object.entries(files)) {
    const file = {
      rows: f.rows,
      keyDate: date,
      mismatchedDates: f.held ?? [],
      calendarDates,
    };
    let ownKeyMatch: OwnKeyMatch | null = null;
    if (isStaleCopyCandidate(file)) {
      ownKeyMatch = combineOwnKeyMatches(
        file.mismatchedDates.map((h) => {
          const own = files[h] ?? outside[h];
          return compareArchivedObjects(metaOf(f), own ? metaOf(own) : null);
        }),
      );
    }
    const kind = classifyReadFile({ ...file, ownKeyMatch });
    if (kind === "foreign") {
      notes.set(
        date,
        describeForeignSessions(
          date,
          file.mismatchedDates,
          ownKeyMatch,
          calendarDates,
        ),
      );
    }
    const fresh = kind === "fresh" ? 1 : 0;
    const foreign = kind === "foreign" ? 1 : 0;
    const staleN = kind === "stale" ? 1 : 0;
    const v = classifyReadDate({
      freshFiles: fresh,
      foreignFiles: foreign,
      staleFiles: staleN,
      bhavcopyPresent:
        fresh === 0 && foreign === 0 && staleN > 0
          ? combineBhavcopyProbes([f.bhavcopy ?? null])
          : null,
    });
    if (v !== null) datesRead.add(date);
    if (v === "holiday") holidays.add(date);
    if (kind === "fresh" && f.rows > 0) sessions.add(date);
  }
  const verdict = decideMonth({
    datesRead,
    holidays,
    sessionDates: sessions,
    rowCount: sessions.size * 1_700,
  });
  assert.equal(verdict.action, "load");
  if (verdict.action !== "load") throw new Error("unreachable");
  const f = fakeLedger();
  f.claim(pk);
  const refusal = await acceptOrRefuse(
    key(pk),
    {
      runId: "run-1",
      rowCount: sessions.size * 1_700,
      expectedSessions: verdict.expectedSessions,
      actualSessions: verdict.actualSessions,
      missingSessions: missingSessions(
        [...datesRead].filter((d) => !holidays.has(d)),
        sessions,
      ),
    },
    f.ledger,
  );
  return { refusal, verdict, state: f.state.get(pk), notes };
}

/** A real session's file: its own bytes, identified by its date. */
const session = (d: string): DayFile => ({ rows: 1_900, md5: `md5-${d}` });
/** A byte-for-byte copy of `held`'s file under another key. */
const copyOf = (held: string, bhavcopy: boolean | null): DayFile => ({
  rows: 0,
  held: [held],
  md5: `md5-${held}`,
  bhavcopy,
});
const expected = (r: Awaited<ReturnType<typeof monthFromFiles>>) =>
  r.verdict.action === "load"
    ? [r.verdict.actualSessions, r.verdict.expectedSessions]
    : null;

describe("the coverage gate over stale copies", () => {
  it("a byte-identical copy with no bhavcopy is a holiday -> ACCEPTED", async () => {
    const r = await monthFromFiles("2019-10", {
      "2019-10-01": session("2019-10-01"),
      "2019-10-02": copyOf("2019-10-01", false),
    });
    assert.deepEqual(expected(r), [1, 1]);
    assert.equal(r.refusal, null);
    assert.equal(r.state, "ACCEPTED");
  });

  it("a byte-identical copy ACROSS a month boundary -> ACCEPTED", async () => {
    // 2024-05-01 holds 2024-04-30, as on prod.
    const r = await monthFromFiles(
      "2024-05",
      {
        "2024-05-01": copyOf("2024-04-30", false),
        "2024-05-02": session("2024-05-02"),
      },
      { "2024-04-30": { md5: "md5-2024-04-30" } },
    );
    assert.deepEqual(expected(r), [1, 1]);
    assert.equal(r.state, "ACCEPTED");
  });

  it("a crc32c-only match still proves the copy -> ACCEPTED", async () => {
    const r = await monthFromFiles("2019-10", {
      "2019-10-01": { rows: 1_900, crc32c: "c1" },
      "2019-10-02": {
        rows: 0,
        held: ["2019-10-01"],
        md5: "x",
        crc32c: "c1",
        bhavcopy: false,
      },
    });
    assert.equal(r.state, "ACCEPTED");
  });

  it("05112021: the ONLY copy of an earlier weekday session -> REFUSED", async () => {
    // Prod: 04112021 is byte-identical to 03112021 (and cm04NOV2021 exists);
    // 05112021 holds 2,013 rows dated 2021-11-04, the Diwali Muhurat session.
    const r = await monthFromFiles("2021-11", {
      "2021-11-03": session("2021-11-03"),
      "2021-11-04": copyOf("2021-11-03", true),
      "2021-11-05": {
        rows: 0,
        held: ["2021-11-04"],
        md5: "md5-muhurat",
        bhavcopy: false,
      },
    });
    assert.equal(r.state, "REJECTED");
    assert.deepEqual(r.refusal?.missingSessions, ["2021-11-04", "2021-11-05"]);
    assert.equal(
      r.notes.get("2021-11-05"),
      "session 2021-11-04 — not held under its own key",
    );
  });

  it("an earlier-weekday file whose own key holds NOTHING -> REFUSED", async () => {
    const r = await monthFromFiles("2019-10", {
      "2019-10-02": copyOf("2019-10-01", false), // no 2019-10-01 archived
      "2019-10-03": session("2019-10-03"),
    });
    assert.equal(r.state, "REJECTED");
    assert.deepEqual(r.refusal?.missingSessions, ["2019-10-02"]);
  });

  it("an earlier-weekday file that cannot be compared -> REFUSED (fail-safe)", async () => {
    const r = await monthFromFiles("2019-10", {
      "2019-10-01": { rows: 1_900 },
      "2019-10-02": { rows: 0, held: ["2019-10-01"], bhavcopy: false },
    });
    assert.equal(r.state, "REJECTED");
    assert.equal(
      r.notes.get("2019-10-02"),
      "session 2019-10-01 — its own key could not be compared",
    );
  });

  it("a stale copy WITH a bhavcopy is a real gap -> refused", async () => {
    const r = await monthFromFiles("2019-10", {
      "2019-10-01": session("2019-10-01"),
      "2019-10-02": copyOf("2019-10-01", true),
    });
    assert.equal(r.state, "REJECTED");
    assert.deepEqual(r.refusal?.missingSessions, ["2019-10-02"]);
    assert.equal(r.refusal?.reason, "partial: 1/2 sessions present");
  });

  it("a stale copy nobody can probe a bhavcopy for -> refused", async () => {
    const r = await monthFromFiles("2019-10", {
      "2019-10-01": session("2019-10-01"),
      "2019-10-02": copyOf("2019-10-01", null),
    });
    assert.equal(r.state, "REJECTED");
  });

  it("an EMPTY file's date is still expected -> refused", async () => {
    // The filesZeroRows comment's claim, pinned: a zero-row file that holds
    // no other date is a missing session.
    const r = await monthFromFiles("2019-10", {
      "2019-10-01": session("2019-10-01"),
      "2019-10-03": { rows: 0 },
    });
    assert.equal(r.state, "REJECTED");
    assert.deepEqual(r.refusal?.missingSessions, ["2019-10-03"]);
  });

  for (const [keyDate, held] of WEEKEND_HELD) {
    it(`${keyDate} holds weekend session ${held}, no bhavcopy -> REFUSED, not a holiday`, async () => {
      const next = new Date(`${keyDate}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1); // a weekday session beside it
      const nextDate = next.toISOString().slice(0, 10);
      const r = await monthFromFiles(keyDate.slice(0, 7), {
        [nextDate]: session(nextDate),
        [keyDate]: {
          rows: 0,
          held: [held],
          md5: `md5-${held}`,
          bhavcopy: false,
        },
      });
      assert.equal(r.state, "REJECTED");
      assert.deepEqual(r.refusal?.missingSessions, [keyDate]);
      assert.equal(
        r.notes.get(keyDate),
        `weekend session ${held} — not walked`,
      );
    });
  }

  it("2019-10, the real shape: 3 holidays + the Muhurat file -> REFUSED at 19/20", async () => {
    const files: Record<string, DayFile> = {};
    for (const d of OCT.datesRead) {
      const held = OCT.held[d];
      files[d] = held ? copyOf(held, false) : session(d);
    }
    const r = await monthFromFiles("2019-10", files);
    assert.deepEqual(expected(r), [19, 20]);
    assert.equal(r.state, "REJECTED");
    assert.deepEqual(r.refusal?.missingSessions, ["2019-10-28"]);
    assert.equal(
      r.notes.get("2019-10-28"),
      "weekend session 2019-10-27 — not walked",
    );
  });

  // MONEY-1613 — the weekend is in the calendar, so the replay reads its OWN
  // key. Today 27102019 is not archived: still REFUSED, now naming the key.
  const octFiles = (): Record<string, DayFile> => {
    const files: Record<string, DayFile> = {};
    for (const d of OCT.datesRead) {
      const held = OCT.held[d];
      files[d] = held ? copyOf(held, false) : session(d);
    }
    return files;
  };
  const CAL = ["2019-10-26", "2019-10-27"];

  it("2019-10 with the calendar, 27102019 NOT archived (today) -> REFUSED at 19/20", async () => {
    const r = await monthFromFiles("2019-10", octFiles(), {}, CAL);
    assert.deepEqual(expected(r), [19, 20]);
    assert.equal(r.state, "REJECTED");
    assert.deepEqual(r.refusal?.missingSessions, ["2019-10-28"]);
    assert.equal(
      r.notes.get("2019-10-28"),
      "session 2019-10-27 — not held under its own key",
    );
  });

  it("2019-10 once 27102019 is archived and byte-identical -> ACCEPTED at 20/20", async () => {
    const files = octFiles();
    files["2019-10-27"] = session("2019-10-27"); // md5 === the 28th's copy
    const r = await monthFromFiles("2019-10", files, {}, CAL);
    assert.deepEqual(expected(r), [20, 20]);
    assert.equal(r.refusal, null);
    assert.equal(r.state, "ACCEPTED");
  });

  it("2019-10 once 27102019 is archived but NOT byte-identical -> REFUSED (the bytes still decide)", async () => {
    const files = octFiles();
    files["2019-10-27"] = { rows: 1_799, md5: "md5-refetched" };
    const r = await monthFromFiles("2019-10", files, {}, CAL);
    assert.deepEqual(expected(r), [20, 21]);
    assert.equal(r.state, "REJECTED");
    assert.deepEqual(r.refusal?.missingSessions, ["2019-10-28"]);
  });

  it("2019-11: Guru Nanak Jayanti -> ACCEPTED at 20/20", async () => {
    const nov = [
      "2019-11-01",
      "2019-11-04",
      "2019-11-05",
      "2019-11-06",
      "2019-11-07",
      "2019-11-08",
      "2019-11-11",
      "2019-11-12",
      "2019-11-13",
      "2019-11-14",
      "2019-11-15",
      "2019-11-18",
      "2019-11-19",
      "2019-11-20",
      "2019-11-21",
      "2019-11-22",
      "2019-11-25",
      "2019-11-26",
      "2019-11-27",
      "2019-11-28",
      "2019-11-29",
    ];
    const files: Record<string, DayFile> = {};
    for (const d of nov) files[d] = session(d);
    files["2019-11-12"] = copyOf("2019-11-11", false);
    const r = await monthFromFiles("2019-11", files);
    assert.deepEqual(expected(r), [20, 20]);
    assert.equal(r.state, "ACCEPTED");
  });

  it("without holidays, decideMonth is unchanged: 2019-10 is 19/23", () => {
    const v = decideMonth({
      datesRead: new Set(OCT.datesRead),
      sessionDates: octSessions,
      rowCount: 34_064,
    });
    assert.deepEqual(v, {
      action: "load",
      expectedSessions: 23,
      actualSessions: 19,
    });
  });
});

describe("the holiday's proof is in the source hash", () => {
  // The shell adds each probed-and-absent bhavcopy key as generation
  // "absent". Archiving that bhavcopy later must change the month's hash.
  const base = [{ date: "2019-11-11", key: "feeds/a", generation: "1" }];
  const absent = {
    date: "2019-11-12",
    key: "feeds/bhav",
    generation: "absent",
  };
  it("hashing the absent key changes the hash, and archiving it changes it again", () => {
    const without = indiaSourceHash(base);
    const withAbsent = indiaSourceHash([...base, absent]);
    const archived = indiaSourceHash([
      ...base,
      { ...absent, generation: "17" },
    ]);
    assert.notEqual(withAbsent, without);
    assert.notEqual(archived, withAbsent);
  });
});

describe("lake-replay-in wires the stale-copy rule", () => {
  // Wiring only; the dry run on prod is the runtime proof.
  const src = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "scripts",
      "jobs",
      "lake-replay-in.ts",
    ),
    "utf8",
  );
  it("delivery's mapping carries the parser's mismatched DATE1 values", () => {
    assert.match(src, /mismatchedDates: parsed\.mismatchedDates,/);
  });
  it("each file is judged against its own key date and the calendar", () => {
    assert.match(
      src,
      /const file = \{\s*rows: mapped\.rows\.length,\s*keyDate: date,\s*mismatchedDates: mapped\.mismatchedDates,\s*calendarDates: args\.calendarDates,\s*\};/,
    );
  });
  it("the walk and the foreign note read the special-session calendar (MONEY-1613)", () => {
    assert.match(
      src,
      /const calendarDates = specialSessionCandidateDates\(\);\s*const dates = enumerateSessionCandidates\(args\.from, args\.to, calendarDates\);/,
    );
    assert.match(
      src,
      /describeForeignSessions\(\s*date,\s*mapped\.mismatchedDates,\s*ownKeyMatch,\s*args\.calendarDates,\s*\)/,
    );
    assert.match(src, /head,\s*calendarDates,\s*\}\);/);
  });
  it("a candidate is compared, by hash, with the SAME family's file under each held date's key", () => {
    assert.match(src, /if \(isStaleCopyCandidate\(file\)\) \{/);
    assert.match(
      src,
      /archiveKeyFor\(\s*family,\s*new Date\(`\$\{held\}T00:00:00\.000Z`\),?\s*\)/,
    );
    assert.match(
      src,
      /compareArchivedObjects\(\s*meta,\s*ownKey \? await args\.head\(ownKey\) : null,?\s*\)/,
    );
    assert.match(src, /ownKeyMatch = combineOwnKeyMatches\(matches\);/);
    assert.match(src, /classifyReadFile\(\{ \.\.\.file, ownKeyMatch \}\)/);
  });
  it("probes are combined by the pure function", () => {
    assert.match(
      src,
      /combineBhavcopyProbes\(probes\.map\(\(p\) => p\.present\)\)/,
    );
  });
  it("a holiday hashes its absent bhavcopy keys", () => {
    assert.match(
      src,
      /contributing\.push\(\{ date, key, generation: "absent" \}\)/,
    );
  });
  it("the month verdict is given the proven holidays", () => {
    assert.match(
      src,
      /decideMonth\(\{\s*datesRead: tally\.datesRead,\s*holidays: tally\.holidays,/,
    );
  });
  it("both HEADs are archive metadata lookups, not BigQuery", () => {
    const probe = src.slice(src.indexOf("function makeBhavcopyProbe("));
    assert.match(probe.slice(0, 1500), /await getFileMetadata\(key\)/);
    const head = src.slice(src.indexOf("function makeHead("));
    assert.match(head.slice(0, 600), /hit = getFileMetadata\(key\);/);
  });
});
