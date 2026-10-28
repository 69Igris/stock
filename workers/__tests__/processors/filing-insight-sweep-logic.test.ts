/**
 * The `us-filing-insight` sweep — MONEY-1324 (P17).
 *
 * Covers the three decisions the fan-out is made of, each of which has a
 * measured defect behind it:
 *
 *   ARMING       `US_FILING_INSIGHT_APPLY` is compared to the LITERAL "true".
 *                Both directions are pinned, because a silent DISARM is as much
 *                a defect as a silent arm — `MF_METADATA_PROVIDER` sat unset for
 *                months while its cron fired weekly and its job exited having
 *                written nothing (MONEY-1214).
 *   DISPATCH     one topic carries a sweep AND per-document leaves. A message
 *                naming neither is `ignore`, NEVER `sweep`: inferring a
 *                whole-cohort fan-out from an absent field would let one
 *                malformed leaf spend a cohort of PAID model calls.
 *   THE PLAN     the analyse/skip judgement is DELEGATED to the leaf's own
 *                `decideInsightAction` rather than restated. MONEY-1255 paid for
 *                one job that named a GCS object by a substring rule and
 *                selected the row by an exact one — the file was right and the
 *                row was unreachable for the life of the table.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// MONEY-1326 — every path below is anchored to THIS FILE, never to
// `process.cwd()`. The reads used to be bare relative strings, so they resolved
// correctly only when the runner's cwd happened to be `workers/` (which is what
// `yarn test` does, per-workspace) and threw ENOENT from the repo root. Same
// class as the MONEY-1314 coverage test that resolved its roots from the cwd
// and silently scanned ZERO files.
const WORKERS = join(import.meta.dirname, "..", "..");

import {
  classifyFilingInsightMessage,
  DEFAULT_FANOUT_LIMIT,
  FAILED_RETRY_COOLDOWN_MS,
  indexInsights,
  insightKey,
  isCoolingDown,
  isFilingInsightArmed,
  MAX_FANOUT_LIMIT,
  planInsightFanout,
  resolveFanoutLimit,
  SWEEP_SCAN_CAP,
  US_FILING_INSIGHT_APPLY_ENV,
  type SweepDocument,
  type SweepInsightRow,
} from "../../src/processors/filing-insight-sweep-logic";
import { INSIGHT_STATUS } from "../../src/processors/us-filing-insight-selectors-logic";

const NOW = new Date("2026-09-02T12:00:00.000Z");

function doc(over: Partial<SweepDocument> = {}): SweepDocument {
  return {
    id: over.id ?? "doc-1",
    accession: "0001193125-26-378529",
    sequence: 11,
    cik10: "0000320193",
    symbol: "HOS",
    form: "8-K",
    documentType: "EX-99.1",
    filedAt: new Date("2026-08-30T00:00:00.000Z"),
    items: [],
    textPath: "edgar/text/0001193125-26-378529/11.txt",
    textHash: "hash-a",
    ...over,
  };
}

function insight(over: Partial<SweepInsightRow> = {}): SweepInsightRow {
  return {
    accession: "0001193125-26-378529",
    sequence: 11,
    insightStatus: INSIGHT_STATUS.READY,
    sourceTextHash: "hash-a",
    ...over,
  };
}

const plan = (
  documents: readonly SweepDocument[],
  insights: readonly SweepInsightRow[] = [],
  limit = DEFAULT_FANOUT_LIMIT,
) => planInsightFanout({ documents, insights, now: NOW, limit });

/* ═══════════════════════════════════════════════════════════════════════ */

describe("US_FILING_INSIGHT_APPLY arms the fan-out (MONEY-1324)", () => {
  it("ARMED by the literal string, and by nothing else", () => {
    assert.equal(
      isFilingInsightArmed({ [US_FILING_INSIGHT_APPLY_ENV]: "true" }),
      true,
    );
  });

  it("DISARMED when absent — the direction MF_METADATA_PROVIDER lost", () => {
    // Both directions are asserted deliberately. A guard that only proves the
    // ARMED case cannot tell a deployment that silently turned itself off from
    // one that was never turned on, which is the state that cost MONEY-1214
    // months of a weekly cron writing nothing.
    assert.equal(isFilingInsightArmed({}), false);
  });

  it('DISARMED by "false" — Boolean("false") is TRUE and would arm it', () => {
    assert.equal(
      isFilingInsightArmed({ [US_FILING_INSIGHT_APPLY_ENV]: "false" }),
      false,
    );
    // The trap spelled out: a `Boolean()` implementation passes every other
    // case in this file and fails only this one.
    assert.equal(Boolean("false"), true);
  });

  it("DISARMED by every near-miss spelling", () => {
    for (const v of ["TRUE", "True", " true", "true ", "1", "yes", "on", ""]) {
      assert.equal(
        isFilingInsightArmed({ [US_FILING_INSIGHT_APPLY_ENV]: v }),
        false,
        `"${v}" armed the lane`,
      );
    }
  });

  it("reads the env PER CALL, not once at import", () => {
    // A module-scope read freezes at import; on a warm Cloud Run container that
    // turns a redeployed switch into no switch at all. Driving the same
    // function with two different environments in one process is the only way
    // to see the difference.
    const env: NodeJS.ProcessEnv = {};
    assert.equal(isFilingInsightArmed(env), false);
    env[US_FILING_INSIGHT_APPLY_ENV] = "true";
    assert.equal(isFilingInsightArmed(env), true);
    delete env[US_FILING_INSIGHT_APPLY_ENV];
    assert.equal(isFilingInsightArmed(env), false);
  });

  it("[source] the comparison is literal and the env is a PARAMETER", () => {
    // Asserting the helper BEHAVES proves nothing about how it is written, and
    // "read per call" is a property of the source rather than of one call.
    const src = readFileSync(
      join(WORKERS, "src", "processors", "filing-insight-sweep-logic.ts"),
      "utf8",
    );
    const code = src
      .replace(/^[^\S\n]*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(
      code,
      /env\[US_FILING_INSIGHT_APPLY_ENV\]\s*===\s*"true"/,
      "the arming test is no longer a literal string comparison",
    );
    assert.ok(
      !/Boolean\(/.test(code),
      'Boolean("false") is true — it must never gate this flag',
    );
    assert.match(
      code,
      /env:\s*NodeJS\.ProcessEnv\s*=\s*process\.env/,
      "process.env must be read in the PARAMETER LIST (per call), never into a " +
        "module-scope const",
    );
    assert.ok(
      !/^const\s+\w+\s*=\s*process\.env/m.test(code),
      "a module-scope process.env read freezes at import",
    );
  });
});

describe("one topic, two message shapes (MONEY-1324)", () => {
  it("a documentId is a LEAF", () => {
    assert.equal(
      classifyFilingInsightMessage({ documentId: "abc" }),
      "document",
    );
  });

  it('mode "sweep" is a SWEEP', () => {
    assert.equal(classifyFilingInsightMessage({ mode: "sweep" }), "sweep");
  });

  it("a message naming NEITHER is ignored, never swept", () => {
    // The footgun this ordering exists to close: reading "no documentId" as
    // "fan out the whole cohort" makes a truncated or malformed leaf spend a
    // cohort of paid model calls.
    for (const m of [
      {},
      { mode: "" },
      { mode: "SWEEP" },
      { documentId: "" },
      null,
      7,
      "sweep",
    ]) {
      assert.equal(
        classifyFilingInsightMessage(m),
        "ignore",
        `${JSON.stringify(m)} was not ignored`,
      );
    }
  });

  it("a documentId WINS over a stray mode — a leaf can never become a sweep", () => {
    assert.equal(
      classifyFilingInsightMessage({ documentId: "abc", mode: "sweep" }),
      "document",
    );
  });
});

describe("fan-out limit (MONEY-1324)", () => {
  it("defaults when absent, malformed, zero or negative", () => {
    // A malformed message must not silently disable the fan-out while every
    // log line reads as a healthy tick.
    for (const v of [undefined, null, "50", NaN, Infinity, 0, -5, {}]) {
      assert.equal(
        resolveFanoutLimit(v),
        DEFAULT_FANOUT_LIMIT,
        `for ${String(v)}`,
      );
    }
  });

  it("honours a smaller request and CLAMPS a larger one", () => {
    assert.equal(resolveFanoutLimit(25), 25);
    assert.equal(resolveFanoutLimit(10_000), MAX_FANOUT_LIMIT);
    assert.equal(resolveFanoutLimit(7.9), 7);
  });

  it("the constants are the sizes the docblock reasons about", () => {
    // A floor with no verified ceiling is not a premise: if these drift, the
    // arithmetic in the module docblock (477 documents draining in ~5 ticks,
    // 4 retries/day rather than 144) stops being true of the code.
    assert.equal(DEFAULT_FANOUT_LIMIT, 100);
    assert.equal(MAX_FANOUT_LIMIT, 500);
    assert.equal(SWEEP_SCAN_CAP, 20_000);
    assert.equal(FAILED_RETRY_COOLDOWN_MS, 6 * 60 * 60 * 1000);
  });
});

describe("the FAILED retry cooldown (MONEY-1324)", () => {
  const failedAt = (at: Date) =>
    insight({
      insightStatus: INSIGHT_STATUS.FAILED,
      sourceTextHash: null,
      analysedAt: at,
    });

  it("holds a FAILED row inside the window", () => {
    const at = new Date(NOW.getTime() - 60 * 60 * 1000);
    assert.equal(isCoolingDown(failedAt(at), NOW), true);
  });

  it("releases it once the window has passed", () => {
    const at = new Date(NOW.getTime() - FAILED_RETRY_COOLDOWN_MS - 1);
    assert.equal(isCoolingDown(failedAt(at), NOW), false);
  });

  it("never holds a row that is not FAILED", () => {
    const at = new Date(NOW.getTime() - 1000);
    for (const status of [
      INSIGHT_STATUS.READY,
      INSIGHT_STATUS.SKIPPED,
      INSIGHT_STATUS.PENDING,
    ]) {
      assert.equal(
        isCoolingDown(insight({ insightStatus: status, analysedAt: at }), NOW),
        false,
        `${status} was held`,
      );
    }
    assert.equal(isCoolingDown(null, NOW), false);
  });

  it("does NOT hold a FAILED row with no attempt timestamp", () => {
    // "Absent" is not a value. Refusing to retry on an unknown timestamp would
    // strand the row forever — the same trap the selectors module documents for
    // `textPath`, from the other side.
    assert.equal(
      isCoolingDown(insight({ insightStatus: INSIGHT_STATUS.FAILED }), NOW),
      false,
    );
    assert.equal(
      isCoolingDown(
        insight({ insightStatus: INSIGHT_STATUS.FAILED, analysedAt: null }),
        NOW,
      ),
      false,
    );
    assert.equal(
      isCoolingDown(
        insight({
          insightStatus: INSIGHT_STATUS.FAILED,
          analysedAt: new Date("nonsense"),
        }),
        NOW,
      ),
      false,
    );
  });
});

describe("planInsightFanout (MONEY-1324)", () => {
  it("publishes a document that has never been analysed", () => {
    const p = plan([doc()]);
    assert.deepEqual(p.publish, ["doc-1"]);
    assert.equal(p.owed, 1);
    assert.equal(p.upToDate, 0);
  });

  it("skips a READY document whose text has not changed", () => {
    const p = plan([doc()], [insight()]);
    assert.deepEqual(p.publish, []);
    assert.equal(p.owed, 0);
    assert.equal(p.upToDate, 1);
  });

  it("RE-publishes a READY document whose text HAS changed", () => {
    const p = plan([doc({ textHash: "hash-b" })], [insight()]);
    assert.deepEqual(p.publish, ["doc-1"]);
  });

  it("does NOT re-publish a SKIPPED document — terminal by content", () => {
    // Re-offering it buys the same non-answer on every tick forever, which is
    // the reason SKIPPED is not spelled FAILED.
    const p = plan(
      [doc()],
      [insight({ insightStatus: INSIGHT_STATUS.SKIPPED })],
    );
    assert.deepEqual(p.publish, []);
    assert.equal(p.upToDate, 1);
  });

  it("RE-publishes a FAILED document once its cooldown has passed", () => {
    // THE RETRY CHANNEL. The route ACKs 200 on every path, so Pub/Sub never
    // redelivers; if this sweep did not re-select FAILED, one model blip would
    // drop a document permanently — MONEY-1314's black hole.
    const cold = new Date(NOW.getTime() - FAILED_RETRY_COOLDOWN_MS - 1);
    const p = plan(
      [doc()],
      [
        insight({
          insightStatus: INSIGHT_STATUS.FAILED,
          sourceTextHash: null,
          analysedAt: cold,
        }),
      ],
    );
    assert.deepEqual(p.publish, ["doc-1"]);
    assert.equal(p.cooldownHeld, 0);
  });

  it("HOLDS a FAILED document still inside its cooldown, and counts it", () => {
    const warm = new Date(NOW.getTime() - 60_000);
    const p = plan(
      [doc()],
      [
        insight({
          insightStatus: INSIGHT_STATUS.FAILED,
          sourceTextHash: null,
          analysedAt: warm,
        }),
      ],
    );
    assert.deepEqual(p.publish, []);
    assert.equal(p.cooldownHeld, 1);
    // Held is NOT up-to-date. Collapsing the two would hide a lane stuck in a
    // retry loop behind a healthy-looking "already read" number.
    assert.equal(p.upToDate, 0);
    assert.equal(p.owed, 0);
  });

  it("[delegation] the cohort rules are the LEAF's, not a second copy", () => {
    // Each of these is refused by `decideInsightAction`, which the planner
    // calls rather than restating. If the planner ever grows its own cohort
    // test, these are the cases that will drift apart first.
    const outOfCohort: Array<[string, SweepDocument]> = [
      ["form 10-K", doc({ form: "10-K" })],
      ["documentType EX-10.1", doc({ documentType: "EX-10.1" })],
      ["textPath absent", doc({ textPath: undefined })],
      ["textPath empty", doc({ textPath: "" })],
    ];
    for (const [label, d] of outOfCohort) {
      const p = plan([d]);
      assert.deepEqual(p.publish, [], `${label} was published`);
      assert.equal(p.upToDate, 1, `${label} was not counted as up-to-date`);
    }
    // And the control: the SAME fixture with none of those mutations IS
    // published, so the assertions above are discriminating rather than
    // universally true of this fixture.
    assert.deepEqual(plan([doc()]).publish, ["doc-1"]);
  });

  it("6-K is in the cohort — an items-gated rule would drop all 1,256", () => {
    const p = plan([doc({ form: "6-K", items: [] })]);
    assert.deepEqual(p.publish, ["doc-1"]);
  });

  it("counts a row with no id instead of publishing an empty documentId", () => {
    const p = plan([doc({ id: undefined })]);
    assert.deepEqual(p.publish, []);
    assert.equal(p.missingId, 1);
    assert.equal(p.owed, 0);
  });

  it("the LIMIT caps publishing but NOT the reported queue depth", () => {
    // `owed` is the honest denominator. Capping it too would make a backlog
    // read as permanently equal to the batch size — the number an arming
    // decision gets made on would be a constant.
    const docs = Array.from({ length: 7 }, (_, i) =>
      doc({ id: `doc-${i}`, accession: `acc-${i}` }),
    );
    const p = plan(docs, [], 3);
    assert.equal(p.publish.length, 3);
    assert.deepEqual([...p.publish], ["doc-0", "doc-1", "doc-2"]);
    assert.equal(p.owed, 7);
    assert.equal(p.scanned, 7);
  });

  it("publishes in the order it was given — oldest filing first", () => {
    // The caller orders `filedAt ASC` (`buildInsightCohortOrderBy`). A planner
    // that reordered would undo the rotation the query is chosen for:
    // newest-first over a GROWING queue pushes the oldest rows further down
    // every cycle and never reaches them (MONEY-1255).
    const docs = ["c", "a", "b"].map((s) =>
      doc({ id: s, accession: `acc-${s}` }),
    );
    assert.deepEqual([...plan(docs).publish], ["c", "a", "b"]);
  });

  it("matches an insight to its document on (accession, sequence)", () => {
    // Not on documentId: the insight's key is the DOCUMENT's natural key, which
    // is what makes a re-analysis an update rather than a second row.
    const d = doc({ accession: "acc-1", sequence: 4 });
    const wrongSequence = insight({ accession: "acc-1", sequence: 5 });
    assert.deepEqual(plan([d], [wrongSequence]).publish, ["doc-1"]);
    const right = insight({ accession: "acc-1", sequence: 4 });
    assert.deepEqual(plan([d], [right]).publish, []);
  });

  it("indexInsights keys on the shared natural key", () => {
    const rows = [insight({ accession: "a", sequence: 1 })];
    const m = indexInsights(rows);
    assert.equal(m.size, 1);
    assert.ok(m.has(insightKey({ accession: "a", sequence: 1 })));
    assert.equal(insightKey({ accession: "a", sequence: 1 }), "a:1");
  });

  it("[control] an empty cohort is an empty plan, not a crash", () => {
    const p = plan([], [insight()]);
    assert.deepEqual(p.publish, []);
    assert.equal(p.owed, 0);
    assert.equal(p.scanned, 0);
  });
});
