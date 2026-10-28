/**
 * UNIT TEST — report-archive-sync pure logic (MONEY-1097 / Data Engine P2).
 *
 * Exercises the REAL exports from
 * workers/src/processors/report-archive-sync-logic.ts (no shadow copies):
 *   - `completedFamilyIds`   — which families an earlier run today FINISHED
 *   - `selectFamiliesToFetch`— the 19:30 → 21:45 skip decision
 *   - `tallyOutcomes` / `summarizeRun`
 *   - `extractFileKeys`      — fileKeys out of a daily-reports payload
 *   - `diffObservedFileKeys` — the weekly drift signal
 *   - `previousObservedKeys` — baseline lookup across prior runs
 *
 * Pure functions only: no Prisma, no fetch, no GCS, no timers — so nothing here
 * can orphan the runner.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  completedFamilyIds,
  selectFamiliesToFetch,
  tallyOutcomes,
  summarizeRun,
  extractFileKeys,
  diffObservedFileKeys,
  previousObservedKeys,
  DRIFT_GUARD_KEYS,
  type FamilyResult,
} from "../../src/processors/report-archive-sync-logic";
import type { ReportFamily } from "@usemoney/core/market-data";

/**
 * Minimal stand-in — only the fields the pure logic reads.
 *
 * NOT a cast. `as ReportFamily` here was silently wrong (MONEY-1326): the
 * literal was missing `backfillable`, which the registry made REQUIRED, and a
 * cast is precisely what stops a fixture from telling you it has fallen behind
 * the type it claims to be. Declared instead, so the next required field added
 * to `ReportFamily` fails here.
 */
const family = (id: string): ReportFamily => ({
  id,
  exchange: "NSE",
  feed: id,
  buildUrl: () => `https://example.test/${id}`,
  cadence: "daily",
  startDate: "2020-01-01",
  format: "csv",
  enabled: true,
  backfillable: true,
  provenance: "p2-probed",
  notes: "test",
});

const DAY = "2026-08-07";
const run = (results: FamilyResult[], day = DAY): { metadata: unknown } => ({
  metadata: { day, cadence: "daily", results },
});

describe("completedFamilyIds", () => {
  it("treats archived and skipped as finished", () => {
    const done = completedFamilyIds(
      [
        run([
          { id: "a", outcome: "archived" },
          { id: "b", outcome: "skipped" },
        ]),
      ],
      DAY,
    );
    assert.deepEqual([...done].sort(), ["a", "b"]);
  });

  it("does NOT treat absent as finished — that is the whole point of the 2nd run", () => {
    // A 404 at 19:30 usually means "not published yet". If it counted as done,
    // the 21:45 run would skip exactly the late files it was added to collect
    // and would look successful while doing nothing.
    const done = completedFamilyIds(
      [
        run([
          { id: "late", outcome: "absent" },
          { id: "broken", outcome: "failed" },
          { id: "junk", outcome: "rejected" },
        ]),
      ],
      DAY,
    );
    assert.equal(done.size, 0);
  });

  it("unions across several prior runs", () => {
    const done = completedFamilyIds(
      [
        run([{ id: "a", outcome: "archived" }]),
        run([{ id: "b", outcome: "archived" }]),
      ],
      DAY,
    );
    assert.deepEqual([...done].sort(), ["a", "b"]);
  });

  it("ignores malformed metadata rather than throwing", () => {
    // A legacy or half-written row must degrade to "nothing known, fetch it
    // again" — never abort the night's archiving.
    const done = completedFamilyIds(
      [
        { metadata: null },
        { metadata: "not an object" },
        { metadata: { results: "not an array" } },
        {
          metadata: {
            day: DAY,
            results: [null, 42, { id: 1, outcome: "archived" }],
          },
        },
        {},
        run([{ id: "ok", outcome: "archived" }]),
      ],
      DAY,
    );
    assert.deepEqual([...done], ["ok"]);
  });

  it("ignores runs recorded for a DIFFERENT day — the backfill bug", () => {
    // The caller's query had a lower bound only, so a backfill for 2026-07-20
    // pulled in the last five NIGHTS' runs and their terminal entries filtered
    // every family out: the job completed having fetched nothing, while NSE
    // prunes. Matching on the recorded day makes the skip set correct however
    // sloppy the window is.
    const done = completedFamilyIds(
      [run([{ id: "a", outcome: "archived" }], "2026-08-08")],
      "2026-07-20",
    );
    assert.equal(done.size, 0);
  });

  it("does NOT treat rejected as finished", () => {
    // Rejected bytes are usually a throttle page, and 21:45 is exactly when to
    // ask again — marking them done would suppress the retry the run exists for.
    const done = completedFamilyIds(
      [run([{ id: "throttled", outcome: "rejected" }])],
      DAY,
    );
    assert.equal(done.size, 0);
  });

  it("treats `fetched` as finished — nothing more to do today", () => {
    // `fetched` means validated bytes that were NOT stored because the archive
    // is disarmed. A re-fetch would not store them either.
    const done = completedFamilyIds(
      [run([{ id: "unstored", outcome: "fetched" }])],
      DAY,
    );
    assert.deepEqual([...done], ["unstored"]);
  });

  it("does NOT treat `store-failed` as finished — the armed-archive postmortem", () => {
    // Archive ARMED, bytes validated, GCS write failed. The night the archive
    // was first armed these were recorded as terminal `fetched`, the 21:45 run
    // skipped every one of them as "done", and the day's files needed manual
    // recovery while NSE prunes. A failed store is bytes we do NOT have —
    // exactly what the second run exists to retry.
    const done = completedFamilyIds(
      [
        run([
          { id: "gcs-blip", outcome: "store-failed" },
          { id: "landed", outcome: "archived" },
        ]),
      ],
      DAY,
    );
    assert.deepEqual([...done], ["landed"]);
  });
});

describe("selectFamiliesToFetch", () => {
  it("drops families finished earlier today and keeps the rest", () => {
    const due = [family("a"), family("b"), family("c")];
    const picked = selectFamiliesToFetch(due, new Set(["b"]));
    assert.deepEqual(
      picked.map((f) => f.id),
      ["a", "c"],
    );
  });

  it("returns everything when nothing has run yet (the 19:30 pass)", () => {
    const due = [family("a"), family("b")];
    assert.equal(selectFamiliesToFetch(due, new Set()).length, 2);
  });

  it("returns nothing when the evening run got everything", () => {
    const due = [family("a"), family("b")];
    assert.equal(selectFamiliesToFetch(due, new Set(["a", "b"])).length, 0);
  });
});

describe("tallyOutcomes / summarizeRun", () => {
  it("counts each outcome separately", () => {
    const counts = tallyOutcomes([
      { id: "1", outcome: "archived" },
      { id: "2", outcome: "archived" },
      { id: "3", outcome: "absent" },
      { id: "4", outcome: "rejected" },
      { id: "5", outcome: "failed" },
      { id: "6", outcome: "skipped" },
      { id: "7", outcome: "fetched" },
      { id: "8", outcome: "store-failed" },
    ]);
    assert.deepEqual(counts, {
      archived: 2,
      fetched: 1,
      "store-failed": 1,
      absent: 1,
      rejected: 1,
      failed: 1,
      skipped: 1,
    });
  });

  it("reports store-failed in the summary line — an armed archive losing writes must be visible", () => {
    const line = summarizeRun(
      "2026-08-07",
      tallyOutcomes([{ id: "1", outcome: "store-failed" }]),
    );
    assert.match(line, /store-failed 1/);
  });

  it("keeps absent distinct from failed in the summary line", () => {
    // All-absent is a holiday; all-failed is an outage. Collapsing them is how
    // MONEY-1085's zero-signal failure happened, so the line must separate them.
    const line = summarizeRun(
      "2026-08-07",
      tallyOutcomes([
        { id: "1", outcome: "absent" },
        { id: "2", outcome: "failed" },
      ]),
    );
    assert.match(line, /absent 1/);
    assert.match(line, /failed 1/);
  });

  it("returns all-zero counts for an empty run", () => {
    assert.deepEqual(tallyOutcomes([]), {
      archived: 0,
      fetched: 0,
      "store-failed": 0,
      absent: 0,
      rejected: 0,
      failed: 0,
      skipped: 0,
    });
  });
});

describe("extractFileKeys", () => {
  // Shape taken from the real daily-reports?key=EGR payload captured in P1.
  const payload = {
    PreviousDay: [
      { fileKey: "EGR-NCL-CONTRACT-DELTA", fileActlName: "EG_BC06082026.DAT" },
    ],
    FutureDay: [],
    CurrentDay: [
      { fileKey: "EGR-NCL-CONTRACT-DELTA", fileActlName: "EG_BC07082026.DAT" },
      { fileKey: "EGR-OTHER" },
    ],
  };

  it("de-duplicates a key that appears in more than one bucket", () => {
    assert.deepEqual(extractFileKeys(payload), [
      "EGR-NCL-CONTRACT-DELTA",
      "EGR-OTHER",
    ]);
  });

  it("returns [] for junk instead of throwing", () => {
    // Runs inside a WARN-only guard: an upstream shape change must never be
    // able to fail the night's archiving.
    for (const junk of [null, undefined, 42, "text", {}, { a: 1 }]) {
      assert.deepEqual(extractFileKeys(junk), []);
    }
  });

  it("skips entries without a usable string fileKey", () => {
    assert.deepEqual(
      extractFileKeys({
        x: [{ fileKey: "" }, { fileKey: 7 }, null, { fileKey: " A " }],
      }),
      ["A"],
    );
  });
});

describe("diffObservedFileKeys", () => {
  const registry = new Set(["known-a"]);

  it("establishes a baseline on the first run and warns about nothing", () => {
    // Self-seeding: without this, someone would have to hand-maintain a list of
    // "keys we already know about", which would go stale immediately.
    const diff = diffObservedFileKeys(null, ["a", "b"], registry);
    assert.equal(diff.baseline, true);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
  });

  it("reports only what is NEW since the previous observation", () => {
    // Diffing against the registry instead would warn about ~150 keys every
    // single week, and a warning that always fires is not a signal.
    const diff = diffObservedFileKeys(["a", "b"], ["b", "c"], registry);
    assert.equal(diff.baseline, false);
    assert.deepEqual(diff.added, ["c"]);
    assert.deepEqual(diff.removed, ["a"]);
  });

  it("is silent when nothing changed", () => {
    const diff = diffObservedFileKeys(["a", "b"], ["b", "a"], registry);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
  });

  it("still reports unregistered keys as information", () => {
    const diff = diffObservedFileKeys(
      ["known-a"],
      ["known-a", "mystery"],
      registry,
    );
    assert.deepEqual(diff.unregistered, ["mystery"]);
  });

  it("polls the documented set of NSE sections", () => {
    assert.ok(DRIFT_GUARD_KEYS.includes("EGR"));
    assert.ok(DRIFT_GUARD_KEYS.includes("CM"));
    assert.equal(new Set(DRIFT_GUARD_KEYS).size, DRIFT_GUARD_KEYS.length);
  });
});

describe("previousObservedKeys", () => {
  it("returns the most recent observation", () => {
    const keys = previousObservedKeys([
      { metadata: { observedFileKeys: ["newest"] } },
      { metadata: { observedFileKeys: ["older"] } },
    ]);
    assert.deepEqual(keys, ["newest"]);
  });

  it("skips runs that carry no observation (the nightly archive runs)", () => {
    const keys = previousObservedKeys([
      { metadata: { results: [] } },
      { metadata: null },
      { metadata: { observedFileKeys: ["found"] } },
    ]);
    assert.deepEqual(keys, ["found"]);
  });

  it("returns null when no prior run observed anything", () => {
    assert.equal(previousObservedKeys([{ metadata: { results: [] } }]), null);
    assert.equal(previousObservedKeys([]), null);
  });

  it("rejects an EMPTY observation — a failed sweep is not a baseline", () => {
    // One Akamai challenge poisons all 12 keys (the cookie is cached 5 min), so
    // the sweep yields []. Accepting that would make next week report ~200 keys
    // DISAPPEARED and the week after ~200 NEW — a fail-open default cached as a
    // value, which this repo has been bitten by before.
    // The empty sweep is SKIPPED and the last good observation is used, so a
    // blocked Saturday costs nothing instead of poisoning two weeks of diffs.
    assert.deepEqual(
      previousObservedKeys([
        { metadata: { observedFileKeys: [] } },
        { metadata: { observedFileKeys: ["real"] } },
      ]),
      ["real"],
    );
    // ...and an empty one on its own yields no baseline at all.
    assert.equal(
      previousObservedKeys([{ metadata: { observedFileKeys: [] } }]),
      null,
    );
  });

  it("rejects a non-string array rather than seeding a bad baseline", () => {
    assert.equal(
      previousObservedKeys([{ metadata: { observedFileKeys: [1, 2] } }]),
      null,
    );
  });
});
