/**
 * `scripts/data/repair-fo-summary-gap.ts` — a non-zero exit is only fatal when
 * nothing moved (MONEY-1206 / D1).
 *
 * ## The defect this suite closes
 *
 * The driver walks the 456-day NSE F&O gap in monthly chunks, and each chunk
 * begins by PURGING that month's parse checkpoints — that purge is both how the
 * month is made to re-parse and how the chunk is bounded. It then re-invoked
 * `feed-parse.ts` while checkpoints kept being added, which is the right shape:
 * measure progress, never trust a retry count.
 *
 * MONEY-1205 then gave `feed-parse` a second, entirely healthy reason to exit
 * non-zero — it refuses files it cannot read and records each as an `UNREADABLE`
 * checkpoint — and the driver's `if (!run(...)) break;` read that as a hard
 * failure. Because the purge deletes the window's `UNREADABLE` rows too, the
 * refusal is re-created on every invocation, so the abort was not intermittent:
 * the driver could never get past pass 1 of the FIRST chunk, on EVERY
 * invocation, forever.
 *
 * ## The predicate, and why deleting the failure branch would be wrong
 *
 *   abort  ⇔  exitedClean === false  AND  after <= before
 *
 * A genuine hard failure — bad credentials, DB down, a crash before any work —
 * makes no progress and must still stop the driver with the cause on screen.
 * What changed is only that "exited non-zero" stopped being sufficient.
 *
 * ## Why this suite EXECUTES the predicate
 *
 * Same reasoning as `feed-parse-unreadable.test.ts`: the script has a top-level
 * `main()` and a module-scope Prisma import, so it cannot be imported into
 * `node:test`. The decision is pure and marker-delimited, so it is lifted out of
 * the real file, written to a temp ESM module and imported. Mutate the predicate
 * in the script and these tests fail — which is exactly what a source-text
 * assertion cannot promise.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Repo root by walking up to `yarn.lock` (see the dispatch suite's note). */
function repoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "yarn.lock"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`repoRoot(): no yarn.lock above ${process.cwd()}`);
}

/** LINE comments before BLOCK: reversed, a `//` containing `/*` opens a phantom block. */
function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const ROOT = repoRoot();
const SCRIPT = join(ROOT, "scripts", "data", "repair-fo-summary-gap.ts");
/** RAW, not stripped: the extraction markers ARE comments. */
const RAW = readFileSync(SCRIPT, "utf8");
const SRC = stripComments(RAW);

/** The pure, import-free region between the `:begin` / `:end` markers. */
function markedRegion(marker: string): string {
  const begin = RAW.indexOf(`${marker}:begin`);
  const end = RAW.indexOf(`/* ${marker}:end */`);
  if (begin < 0 || end < 0 || end <= begin) {
    throw new Error(
      `repair-fo-summary-gap.ts is missing the ${marker} markers — the pure ` +
        "decision region must stay marked so this suite can execute it rather " +
        "than assert about its text",
    );
  }
  const afterComment = RAW.indexOf("*/", begin);
  if (afterComment < 0 || afterComment > end) {
    throw new Error(`${marker}:begin marker is not inside a block comment`);
  }
  return RAW.slice(afterComment + 2, end);
}

const VERDICT_SRC = markedRegion("parse-pass-verdict");

type ParsePassAction = "abort" | "complete" | "stalled" | "continue";

interface ParsePassInput {
  exitedClean: boolean;
  before: number;
  after: number;
  target: number;
}

interface Extracted {
  judgeParsePass(p: ParsePassInput): {
    action: ParsePassAction;
    message: string;
  };
}

/**
 * The extracted region as a standalone ESM module.
 *
 * `.mts` forces ESM — a bare `.ts` in os.tmpdir() has no nearby package.json and
 * tsx would treat it as CJS. Nothing is supplied but the region itself: it is
 * pure by construction, and a test below pins that it stays that way.
 */
const tempDir = mkdtempSync(join(tmpdir(), "fo-gap-extract-"));
const modulePath = join(tempDir, "extracted.mts");
writeFileSync(modulePath, `${VERDICT_SRC}\n`, "utf8");

const live = (await import(pathToFileURL(modulePath).href)) as Extracted;

after(() => rmSync(tempDir, { recursive: true, force: true }));

const pass = (over: Partial<ParsePassInput>): ParsePassInput => ({
  exitedClean: true,
  before: 0,
  after: 0,
  target: 21,
  ...over,
});

// ─── The subject is really there ─────────────────────────────────────

describe("fo-gap parse pass — the extraction is of the real file", () => {
  it("lifted a substantial region out of the shipping script", () => {
    assert.ok(
      SRC.length > 4_000,
      `repair-fo-summary-gap.ts read as ${SRC.length} chars — too small`,
    );
    assert.ok(VERDICT_SRC.length > 600, "the verdict region looks truncated");
    assert.ok(VERDICT_SRC.includes("export function judgeParsePass"));
  });

  it("executes the extracted code, not a copy of it", () => {
    assert.equal(typeof live.judgeParsePass, "function");
  });

  it("keeps the region pure, or it could not be executed here", () => {
    // Comments stripped: the prose NAMES `feedBackfillProgress.count()` while
    // explaining what the caller measures, and prose must not be able to fail a
    // check any more than it can satisfy one.
    const code = stripComments(VERDICT_SRC);
    assert.doesNotMatch(code, /\bimport\b/);
    assert.doesNotMatch(
      code,
      /\bprisma\b|\bspawnSync\b|\blog\.(info|warn)\b/,
      "the decision must stay a pure function of its argument — running the " +
        "child process and writing the log line are the caller's job",
    );
  });
});

// ─── The predicate, executed ─────────────────────────────────────────

describe("judgeParsePass — a non-zero exit is not, by itself, a failure", () => {
  it("a non-zero exit WITH progress continues", () => {
    // The whole ticket. `feed-parse` refused some files, recorded them
    // UNREADABLE, parsed the rest, and exited 1. Eleven of twenty-one files are
    // now checkpointed; there is more to do and every reason to keep going.
    const v = live.judgeParsePass(
      pass({ exitedClean: false, before: 0, after: 11, target: 21 }),
    );
    assert.equal(v.action, "continue");
    assert.match(v.message, /11\/21/);
    assert.match(v.message, /UNREADABLE/);
  });

  it("a non-zero exit that reaches the target COMPLETES, it does not abort", () => {
    // The likeliest real shape: one pass checkpoints every archived file in the
    // month — some DONE, some UNREADABLE — and exits 1 because of the refusals.
    // Aborting here would strand a month that is, in fact, finished.
    const v = live.judgeParsePass(
      pass({ exitedClean: false, before: 0, after: 21, target: 21 }),
    );
    assert.equal(v.action, "complete");
  });

  it("a non-zero exit with NO progress ABORTS — the branch must not be deleted", () => {
    // Bad credentials, Mongo unreachable, a crash on startup. Nothing moved,
    // nothing will, and the cause has to stay on screen. Deleting the failure
    // branch outright would have traded one silent failure for another.
    const v = live.judgeParsePass(
      pass({ exitedClean: false, before: 0, after: 0, target: 21 }),
    );
    assert.equal(v.action, "abort");
    assert.match(v.message, /FAILED and added NOTHING/);
  });

  it("aborts on no progress even mid-chunk, not just from zero", () => {
    // The second and later passes matter as much as the first: a run that dies
    // after 11 files and then dies again having added none is still a hard
    // failure, and `before` is 11 rather than 0.
    const v = live.judgeParsePass(
      pass({ exitedClean: false, before: 11, after: 11, target: 21 }),
    );
    assert.equal(v.action, "abort");
  });

  it("a checkpoint count that somehow went DOWN is not progress", () => {
    // `after < before` cannot happen inside one chunk, but a predicate keyed on
    // `!==` rather than `>` would call it progress and loop. Keyed on `>`.
    const v = live.judgeParsePass(
      pass({ exitedClean: false, before: 11, after: 9, target: 21 }),
    );
    assert.equal(v.action, "abort");
  });

  it("a CLEAN exit is never an abort, whatever the counts", () => {
    for (const p of [
      pass({ before: 0, after: 0, target: 21 }),
      pass({ before: 11, after: 11, target: 21 }),
      pass({ before: 0, after: 21, target: 21 }),
    ]) {
      assert.notEqual(live.judgeParsePass(p).action, "abort");
    }
  });

  it("a clean exit that adds nothing and is still short is STALLED", () => {
    // The pre-existing case this driver was already right about: `feed-parse`
    // exited 0 after 11 of 21 files with no error line. Stop the chunk, keep
    // the raw rows, do not prune.
    const v = live.judgeParsePass(pass({ before: 11, after: 11, target: 21 }));
    assert.equal(v.action, "stalled");
    assert.match(v.message, /stalled at 11\/21/);
  });

  it("reaching the target beats the stall test", () => {
    // A month whose target is 0 (nothing archived) has before === after === 0,
    // which is "no progress" AND "complete". Complete must win, or an empty
    // month is reported as a stall.
    const v = live.judgeParsePass(pass({ before: 0, after: 0, target: 0 }));
    assert.equal(v.action, "complete");
  });

  it("overshooting the target still completes", () => {
    const v = live.judgeParsePass(pass({ before: 0, after: 23, target: 21 }));
    assert.equal(v.action, "complete");
  });

  it("a clean pass that advances says so and keeps going", () => {
    const v = live.judgeParsePass(pass({ before: 0, after: 11, target: 21 }));
    assert.equal(v.action, "continue");
    assert.match(v.message, /advanced to 11\/21/);
    assert.doesNotMatch(
      v.message,
      /UNREADABLE/,
      "a clean pass must not carry the refusal note — it would train the " +
        "operator to skim past it on the pass where it is true",
    );
  });

  it("always returns a message; a pass is never silent", () => {
    for (const exitedClean of [true, false]) {
      for (const [before, after, target] of [
        [0, 0, 21],
        [0, 11, 21],
        [11, 11, 21],
        [0, 21, 21],
      ] as const) {
        const v = live.judgeParsePass({
          exitedClean,
          before,
          after,
          target,
        });
        assert.ok(v.message.length > 10, "every pass must be reportable");
      }
    }
  });
});

// ─── Wiring that cannot be executed without a DB ─────────────────────

/** `main()`'s body. */
function mainBody(): string {
  const start = SRC.indexOf("async function main(): Promise<void> {");
  assert.ok(start >= 0, "repair-fo-summary-gap.ts has no main()");
  return SRC.slice(start);
}

describe("the driver acts on the verdict", () => {
  it("passes the exit code AND both counts into the decision", () => {
    const body = mainBody();
    assert.match(body, /const verdict = judgeParsePass\(\{/);
    for (const pair of [
      "exitedClean,",
      "before: seen,",
      "after: now,",
      "target,",
    ]) {
      assert.ok(
        body.includes(pair),
        `the verdict call is missing \`${pair}\` — a counter that reaches no ` +
          "decision is the defect this ticket fixed",
      );
    }
  });

  it("no longer aborts straight off the exit code", () => {
    const body = mainBody();
    assert.doesNotMatch(
      body,
      /if \(!run\("scripts\/jobs\/feed-parse\.ts"/,
      "the driver branches on the raw exit code again. Since MONEY-1205 a " +
        "non-zero exit also means `some files were refused and recorded`, and " +
        "this driver purges those very checkpoints first — so that branch " +
        "aborts on EVERY invocation, forever.",
    );
    assert.match(
      body,
      /const exitedClean = run\("scripts\/jobs\/feed-parse\.ts"/,
      "the exit code must be captured and judged, not acted on directly",
    );
  });

  it("stops the whole driver on `abort`, and only on `abort`", () => {
    const body = mainBody();
    assert.match(
      body,
      /if \(verdict\.action === "abort"\) \{\s*parsedOk = false;\s*break;\s*\}/,
      "an abort must still stop the driver with the cause visible",
    );
    assert.match(body, /if \(!parsedOk\) break;/);
    assert.match(
      body,
      /if \(verdict\.action !== "continue"\) break;/,
      "complete and stalled end the chunk's parse loop but not the driver",
    );
  });

  it("counts checkpoints WITHOUT filtering on status", () => {
    // The property the whole `after >= target` termination rests on: an
    // UNREADABLE row counts exactly as a DONE row does, so a window whose files
    // are permanently unreadable still reaches its target and moves on instead
    // of spinning to the attempt cap. `target` is measured pre-purge over the
    // same status-blind filter, so the two are comparable by construction.
    const counts = [
      ...SRC.matchAll(
        /feedBackfillProgress\.count\(\{\s*where:\s*\{([^}]*)\}/g,
      ),
    ];
    assert.equal(
      counts.length,
      2,
      `expected 2 checkpoint counts (the pre-purge target and the per-pass ` +
        `measurement), found ${counts.length}`,
    );
    for (const m of counts) {
      assert.match(m[1]!, /family: PARSE_FAMILY/);
      assert.doesNotMatch(
        m[1]!,
        /status/,
        "filtering the count by status would exclude UNREADABLE rows, so a " +
          "month with a permanently unreadable file could never reach its " +
          "target and would burn all 8 attempts on every run",
      );
    }
  });

  it("baselines `seen` at 0, not at the old -1 sentinel", () => {
    // -1 existed only to keep the stall test quiet on pass 1. Under the new
    // predicate it would make a pass-1 hard failure that wrote NOTHING
    // (after = 0 > -1) read as progress — silently restoring the bug.
    const body = mainBody();
    assert.match(body, /let seen = 0;/);
    assert.doesNotMatch(
      body,
      /let seen = -1;/,
      "with a -1 baseline, `after > before` is true for a pass that " +
        "checkpointed nothing at all",
    );
  });

  it("still purges the window's checkpoints before re-parsing", () => {
    // The purge is what confines the parse to this month AND what makes the
    // refusal recur — so it is load-bearing for the bug's shape and must not be
    // quietly removed as a "fix".
    const body = mainBody();
    assert.match(body, /feedBackfillProgress\.deleteMany\(\{/);
    const purge = body.indexOf("deleteMany({");
    const target = body.indexOf("const target =");
    assert.ok(
      target > 0 && target < purge,
      "the restore target must be measured BEFORE the purge, or it is 0",
    );
  });

  it("still verifies the month before pruning it", () => {
    // The incident was a prune that trusted an unverified summarise. A parse
    // pass that ends non-zero must not be able to shortcut that check.
    const body = mainBody();
    const verify = body.indexOf(
      "const stillMissing = (await missingNseDays())",
    );
    const prune = body.indexOf(
      'run("scripts/jobs/fo-summary.ts", ["--backfill"])',
    );
    assert.ok(verify > 0, "the per-chunk verification is gone");
    assert.ok(prune > verify, "the prune must come AFTER the verification");
    assert.match(body.slice(verify, prune), /continue;/);
  });
});
