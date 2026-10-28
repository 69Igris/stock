/**
 * MONEY-1325 — the report must be able to RUN, not merely to exist.
 *
 * ## The guard that read as coverage
 *
 * `job-outcome-coverage.test.ts` scans `workers/src/processors/*.ts` and
 * requires any file issuing a Prisma write to call `reportJobOutcome` or hold a
 * dated permit. It works as a ratchet — it went red the day a new processor
 * landed. It is also blind to the only thing that makes the call worth
 * anything:
 *
 *     MUTATION, run 2026-09-02. Move `reportJobOutcome` in
 *     `us-filing-insight.ts` out of its `finally` and below the final return,
 *     so it can never execute on the skip path. `job-outcome-coverage.test.ts`
 *     stays GREEN at 16/16.
 *
 * That is not a hypothetical. `stock-document-extract` shipped with its call
 * below an empty-queue early return and emitted NOTHING on an idle night, so a
 * `notify_no_data` monitor over a series that never emits read healthy exactly
 * when the job was doing nothing. MONEY-1255 moved it into a `finally` and
 * wrote down why. The guard that exists to prevent that class could not see it,
 * before or after.
 *
 * ## The rule
 *
 *   In a processor that reports, EVERY `return` must emit first.
 *
 * Three shapes satisfy it, and all three are already in this tree:
 *
 *   `finally`      the strongest — every exit emits, a throw included.
 *                  8 processors, incl. `us-filing-insight`, `us-eod-sync`,
 *                  `stock-document-extract`.
 *   exit helper    `return finish();` where `finish()` emits.
 *                  `stock-document-ingest`, `tiingo-news-poll`.
 *   per-block      `report({…}); return;` inside each early-exit branch.
 *                  `corporate-actions-sync`'s no-rows-from-any-source path.
 *
 * The last two collapse into one verdict here (`guarded`): the analysis is
 * "does every return emit", and a helper reached by `return finish()` is one
 * way of answering yes.
 *
 * ## Why `throw` is COUNTED and never FAILED
 *
 * A `return` that emits nothing is SILENT: the route ACKs 200, the schedule
 * looks like it ran, and the only trace is a metric series with a hole in it
 * that no query can distinguish from a quiet market. That is the entire defect
 * class, and it is what this guard fails on.
 *
 * A `throw` is loud through four other channels — a 500, a Pub/Sub redelivery,
 * five failed attempts, the dead-letter consumer's founder notification
 * (MONEY-1204). Six processors throw deliberately for exactly that reason and
 * say so in their own comments: `mf-metadata-sync` ("a no-op run that exits 0
 * is what hid a dead upstream for three months"), `peers-sync`,
 * `corporate-actions-sync`, `news-rss-sync`, `mf-nav-backfill`,
 * `report-archive-sync`. Failing them would make this guard fire on the correct
 * pattern, and a guard that fires on everything is deleted as fast as one that
 * fires on nothing. The count is PRINTED instead, so the debt is visible
 * without being a wall.
 *
 * THAT SIX IS NOT THE CENSUS, and the two numbers answer different questions.
 * Six files throw ON PURPOSE; the printed census counts files with a throw that
 * emits NOTHING, and it has been 4 since before MONEY-1328 (measured on HEAD:
 * `mf-metadata-sync`, `news-rss-sync`, `nse-announcements-sync`,
 * `report-archive-sync`). `corporate-actions-sync` and `peers-sync` throw and
 * report first, which is the shape the rest of this file is arguing for — so
 * they are correctly absent from a list of silent throws.
 *
 * ## The survey, measured before anything was changed
 *
 * 44 of 115 processors call the reporter:
 *
 *     8   `finally`    every exit emits, throws included
 *    32   `guarded`    every return emits; 4 of them have an unguarded throw
 *     4   `bypassed`   a return leaves the function having emitted nothing
 *
 * The four were baselined rather than fixed by MONEY-1325: each was a runtime
 * change to a scheduled job, and that ticket was the guard. MONEY-1328 fixed
 * all four, re-measured on the same scan:
 *
 *     9   `finally`    +1 — institutional-flow-sync, the unbackfillable one
 *    35   `guarded`    +3 — circulars, nse-announcements, stock-document-embed
 *     0   `bypassed`
 *
 * The baseline stays (empty). It is keyed (file -> function -> COUNT), the
 * shape `scripts/ops/typecheck-scripts.ts` uses, and for its reason: a
 * line-keyed baseline moves on every edit above it and gets regenerated
 * blindly, which is the same as no baseline. It ratchets in BOTH directions —
 * one more unguarded return fails, and one fewer fails too, with the
 * instruction to lower the count. Without the second arm a fixed processor
 * quietly re-earns its allowance, and that arm is what PROVED the four fixes
 * landed: each repaired file turned its own permit into a failure.
 *
 * The `throw` census is 4, not the 6 this header once claimed in prose — the
 * NUMBER is computed and printed by the last case, and the sentence naming six
 * files was never derived from it.
 *
 * ## Three short-circuits graded a whole FILE on one function
 *
 * `classifyReportPlacement` used to answer file-wide from the first thing it
 * found, and every one of the three handed out a verdict STRONGER than the
 * evidence:
 *
 *   The first call site inside ANY `finally`, in ANY function, returned
 *   `finally` for the whole file — the verdict `mustBeFinally` below accepts as
 *   proof an outage cannot recur. It never asked whether the `try` is ENTERED,
 *   so a `finally` nested in a loop or an `if` graded as the strongest shape
 *   while being exactly as conditional as the branch around it. That is
 *   MONEY-1255 rebuilt: an empty page never enters the loop, the early return
 *   emits nothing, and a `notify_no_data` monitor cannot tell that from a quiet
 *   market.
 *
 *   The first `guarded` anchor returned for the whole file, so a compliant job
 *   exonerated a bypassed one declared after it — and the variable holding the
 *   fallback was named `worst` while holding the LAST non-guarded placement.
 *
 * All three are gone. `judgeAnchor` decides per anchor, a `finally` counts only
 * when its `try` sits at that anchor's own statement level, and the file's
 * verdict is its WORST anchor's. Measured before it landed: all 9 `finally`
 * processors satisfy the tighter rule, so the census is unchanged at
 * 9/35/0 — this bought strictness, not a re-baseline.
 *
 * Both are LATENT today (no file here has two job anchors, and no `finally`
 * sits inside a loop), which is exactly why they are pinned by FIXTURES rather
 * than by a scan assertion: a scan over a tree with no instances of a shape
 * proves nothing about that shape.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  blankNonCode,
  classifyReportPlacement,
  enclosingScope,
  matchingClose,
  outcomeReporterNames,
  type Placement,
} from "./job-outcome-source-scan";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PROCESSOR_DIR = join(ROOT, "workers", "src", "processors");

// ---------------------------------------------------------------------------
// the baseline
// ---------------------------------------------------------------------------

interface BypassPermit {
  /** Unguarded `return`s, per reporting function. Exact — see the header. */
  returns: Readonly<Record<string, number>>;
  /** What is silent, and what the fix is. Dated. */
  reason: string;
}

/**
 * Processors whose report cannot run on an early return.
 *
 * EMPTY, as of MONEY-1328 — and the emptiness is the point rather than an
 * absence of findings. MONEY-1325 surveyed 115 processors, found four, and
 * baselined them because each fix was a runtime change to a scheduled job and
 * that ticket was the guard. All four were repaired on 2026-09-02:
 *
 *   circulars-sync.ts            2 refusal exits (fetch-null, unrecognised
 *                                shape) now emit from inside their own block,
 *                                matching the two exits in that file that
 *                                already did.
 *   institutional-flow-sync.ts   moved to a `finally` — the strongest shape,
 *                                because the endpoint takes no date parameter,
 *                                so a silent day never enters the record.
 *   nse-announcements-sync.ts    the `rows.length === 0` return was DELETED;
 *                                an empty window now falls through to the
 *                                report it was skipping.
 *   stock-document-embed.ts      same, for `documents.length === 0`.
 *
 * Keep the map and the two arms below. A baseline that is deleted along with
 * its last entry is a baseline the next finding has to re-argue from scratch,
 * and the SHRINK arm — which is what proved these four landed — only exists
 * because the map does.
 */
const RETURN_BYPASS_BASELINE: ReadonlyMap<string, BypassPermit> = new Map<
  string,
  BypassPermit
>([]);

/**
 * Files whose report is in a `finally` or behind an exit helper, pinned BY NAME.
 *
 * The baseline above cannot hold this on its own. Moving a call out of a
 * `finally` and down to the tail leaves a file `guarded` — no early return
 * bypasses it TODAY — so nothing fails, and the next early return added above
 * it lands silently. These are the files whose placement was argued for in
 * writing, three of them by a ticket that measured the outage. Weakening one
 * now costs a deliberate edit to a test that says why it was placed there.
 */
const PINNED_STRONG_PLACEMENT: ReadonlyArray<readonly [string, string]> = [
  ["us-filing-insight.ts", "MONEY-1324 — a leaf's ordinary outcome is a SKIP"],
  ["filing-insight-sweep.ts", "MONEY-1324 — an idle tick must still emit"],
  [
    "stock-document-extract.ts",
    "MONEY-1255 — the incident this class is named for",
  ],
  [
    "bse-announcements-sync.ts",
    "MONEY-1255 — reported nothing for its entire life",
  ],
  ["us-eod-sync.ts", "MONEY-980 — notify_no_data over a Tue-Sat cron"],
  ["stock-document-ingest.ts", "MONEY-1314 — `return finish()` on every path"],
  [
    "institutional-flow-sync.ts",
    "MONEY-1328 — UNBACKFILLABLE: the endpoint takes no date, so a silent day " +
      "never enters the record",
  ],
];

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

interface Scanned {
  file: string;
  placement: Placement;
}

async function scan(): Promise<Scanned[]> {
  const files = (await readdir(PROCESSOR_DIR))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort();
  const out: Scanned[] = [];
  for (const file of files) {
    const code = blankNonCode(
      await readFile(join(PROCESSOR_DIR, file), "utf8"),
    );
    out.push({ file, placement: classifyReportPlacement(code) });
  }
  return out;
}

const countBy = (rows: Scanned[], v: Placement["verdict"]): number =>
  rows.filter((r) => r.placement.verdict === v).length;

/**
 * The SHRINK arm, as a pure function over (baseline, scan).
 *
 * Extracted so it can be driven by a fixture. `RETURN_BYPASS_BASELINE` is
 * empty — deliberately, and the emptiness is the achievement — but an empty map
 * makes the ratchet case below iterate zero times and assert NOTHING: replacing
 * its `stale.push` with a `continue` broke no test. That is the arm that PROVED
 * MONEY-1328's four fixes landed, so leaving it unexercised means the next
 * fixed processor can quietly re-earn its allowance and nothing says so.
 *
 * Its expectation is a hardcoded literal independent of the scan, so it was
 * never self-referential — only untested. `[meta] the shrink arm fires` below
 * supplies the entries the real baseline no longer has.
 */
export function staleBaselineEntries(
  baseline: ReadonlyMap<string, BypassPermit>,
  rows: readonly Scanned[],
): string[] {
  const byFile = new Map(rows.map((r) => [r.file, r.placement]));
  const stale: string[] = [];
  for (const [file, permit] of baseline) {
    const placement = byFile.get(file);
    if (!placement) {
      stale.push(`${file} — no such processor any more`);
      continue;
    }
    if (placement.verdict !== "bypassed") {
      stale.push(
        `${file} — now \`${placement.verdict}\`; delete its entry — ${permit.reason}`,
      );
    }
  }
  return stale;
}

// ---------------------------------------------------------------------------

describe("MONEY-1325 — the outcome report is REACHABLE, not merely present", () => {
  it("[meta] the scan is live on both halves", async () => {
    const rows = await scan();
    // A scan that silently matches nothing PASSES (MONEY-1093). Floors on the
    // walk, on the reporter detector, and on BOTH good verdicts — a classifier
    // stuck on `bypassed` would make the ratchet fire on everything, and one
    // stuck on `guarded` would make it fire on nothing.
    assert.ok(
      rows.length > 100,
      `expected 100+ processor files, found ${rows.length} — the walk is broken`,
    );
    const reporting = rows.filter((r) => r.placement.verdict !== "absent");
    assert.ok(
      reporting.length >= 40,
      `expected 40+ reporting processors, found ${reporting.length} — the ` +
        `reporter detector is broken and every assertion below is vacuous`,
    );
    assert.ok(
      countBy(rows, "finally") >= 6,
      `expected 6+ processors reporting from a \`finally\`, found ` +
        `${countBy(rows, "finally")}`,
    );
    assert.ok(
      countBy(rows, "guarded") >= 25,
      `expected 25+ \`guarded\` processors, found ${countBy(rows, "guarded")} ` +
        `— a classifier that calls everything \`bypassed\` is noise, not a guard`,
    );
  });

  it("[meta] the classifier FIRES on the mutation this ticket is about", () => {
    // Report below an early return: the exact edit that leaves
    // `job-outcome-coverage.test.ts` green.
    const bypassed = classifyReportPlacement(
      blankNonCode(`
        import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
        export async function processThing(): Promise<void> {
          const rows = await prisma.thing.findMany({});
          if (rows.length === 0) return;
          const written = await write(rows);
          reportJobOutcome({ job: "thing", selected: rows.length, written });
        }
      `),
    );
    assert.equal(bypassed.verdict, "bypassed");
    assert.deepEqual(bypassed.unguardedReturns, ["processThing:return"]);
  });

  it("[meta] the classifier SPARES all three correct shapes", () => {
    // The other arm. A guard that fires on everything is as useless as one that
    // fires on nothing, and it is the arm a "stricter is safer" edit removes.
    const inFinally = classifyReportPlacement(
      blankNonCode(`
        export async function processThing(): Promise<void> {
          let written = 0;
          try {
            const rows = await prisma.thing.findMany({});
            if (rows.length === 0) return;
            written = await write(rows);
          } finally {
            reportJobOutcome({ job: "thing", selected: 0, written });
          }
        }
      `),
    );
    assert.equal(inFinally.verdict, "finally");

    const exitHelper = classifyReportPlacement(
      blankNonCode(`
        export async function processThing(): Promise<Outcome> {
          let written = 0;
          const rows = await prisma.thing.findMany({});
          if (rows.length === 0) return finish();
          written = await write(rows);
          return finish();
          function finish(): Outcome {
            reportJobOutcome({ job: "thing", selected: 0, written });
            return { written };
          }
        }
      `),
    );
    assert.equal(
      exitHelper.verdict,
      "guarded",
      exitHelper.unguardedReturns.join(","),
    );

    const perBlock = classifyReportPlacement(
      blankNonCode(`
        export async function processThing(): Promise<void> {
          const rows = await prisma.thing.findMany({});
          if (rows.length === 0) {
            reportJobOutcome({ job: "thing", selected: 0, written: 0, skippedReason: "idle" });
            return;
          }
          const written = await write(rows);
          reportJobOutcome({ job: "thing", selected: rows.length, written });
        }
      `),
    );
    assert.equal(
      perBlock.verdict,
      "guarded",
      perBlock.unguardedReturns.join(","),
    );
  });

  it("[meta] a `finally` inside a LOOP or an `if` is not the strongest shape", () => {
    // MONEY-1325's `finally` test short-circuited on the FIRST call site found
    // inside ANY `finally`, in ANY function, and graded the whole FILE with it.
    // A `finally` only runs if its `try` is ENTERED, so one nested in a loop is
    // exactly as conditional as the loop — and this shape got `finally`, the
    // verdict `mustBeFinally` accepts as proof an outage cannot recur, while
    // reproducing MONEY-1255 exactly: an empty `rows` never enters the loop,
    // the early return emits nothing, and a `notify_no_data` monitor over a
    // series with a hole in it reads as a quiet market.
    const inLoop = classifyReportPlacement(
      blankNonCode(`
        export async function processThing(): Promise<void> {
          const rows = await prisma.thing.findMany({});
          for (const r of rows) {
            try { await one(r); } finally { reportJobOutcome({ job: "thing", selected: 1, written: 1 }); }
          }
          if (rows.length === 0) return;
          await write(rows);
        }
      `),
    );
    assert.equal(inLoop.verdict, "bypassed");
    assert.deepEqual(inLoop.unguardedReturns, ["processThing:return"]);

    const inBranch = classifyReportPlacement(
      blankNonCode(`
        export async function processThing(): Promise<void> {
          const rows = await prisma.thing.findMany({});
          if (rows.length > 0) {
            try { await write(rows); } finally { reportJobOutcome({ job: "thing", selected: 1, written: 1 }); }
          }
          if (rows.length === 0) return;
        }
      `),
    );
    assert.equal(inBranch.verdict, "bypassed");

    // The other arm, and it is the one a "stricter is safer" edit removes: a
    // `try`/`finally` at the FUNCTION's own statement level is entered
    // unconditionally, and all nine `finally` processors in this tree are that
    // shape. Calling them conditional would fire the guard on the correct
    // pattern, which is how a guard gets deleted.
    const atFunctionLevel = classifyReportPlacement(
      blankNonCode(`
        export async function processThing(): Promise<void> {
          let written = 0;
          try {
            const rows = await prisma.thing.findMany({});
            if (rows.length === 0) return;
            written = await write(rows);
          } finally {
            reportJobOutcome({ job: "thing", selected: 0, written });
          }
        }
      `),
    );
    assert.equal(atFunctionLevel.verdict, "finally");
  });

  it("[meta] with TWO job anchors the WORST verdict wins, not the first", () => {
    // The classifier returned on the first `guarded` anchor, so in a file with
    // two jobs the compliant one exonerated the other — and the variable
    // holding the fallback was named `worst` while holding the LAST
    // non-guarded placement. Order-dependent, and silent: nothing changes its
    // mind, the second job simply stops being asked.
    //
    // No file in this tree has two job anchors today, which is exactly why this
    // has to be a fixture rather than a scan assertion.
    const twoJobs = classifyReportPlacement(
      blankNonCode(`
        export async function processAlpha(): Promise<void> {
          const rows = await prisma.thing.findMany({});
          reportJobOutcome({ job: "alpha", selected: rows.length, written: 0 });
        }
        export async function processBeta(): Promise<void> {
          const rows = await prisma.other.findMany({});
          if (rows.length === 0) return;
          reportJobOutcome({ job: "beta", selected: rows.length, written: 0 });
        }
      `),
    );
    assert.equal(
      twoJobs.verdict,
      "bypassed",
      "a compliant first job must not vouch for a bypassed second one",
    );
    assert.deepEqual(twoJobs.unguardedReturns, ["processBeta:return"]);

    // …and the reverse order must give the same answer, or the verdict is
    // decided by declaration order rather than by the code.
    const reversed = classifyReportPlacement(
      blankNonCode(`
        export async function processBeta(): Promise<void> {
          const rows = await prisma.other.findMany({});
          if (rows.length === 0) return;
          reportJobOutcome({ job: "beta", selected: rows.length, written: 0 });
        }
        export async function processAlpha(): Promise<void> {
          const rows = await prisma.thing.findMany({});
          reportJobOutcome({ job: "alpha", selected: rows.length, written: 0 });
        }
      `),
    );
    assert.equal(reversed.verdict, "bypassed");
    assert.deepEqual(reversed.unguardedReturns, ["processBeta:return"]);
  });

  it("[meta] an ARROW-declared exported processor is not `never-called`", () => {
    // `isExportedFunction` required the literal `function` keyword, so
    // `export const processThing = async () => {` read as NOT exported. The
    // orphan branch is `not exported AND no call sites in this file`, and a
    // processor's caller is a ROUTE IN ANOTHER FILE — zero local call sites is
    // its normal state. So the first arrow-declared processor to land would go
    // red claiming its reporter can never run, when it plainly does.
    //
    // A FALSE FAILURE is not the safe direction here. It is how a baseline
    // becomes a regeneration ritual, which is the outcome this file spends
    // several paragraphs arguing against.
    const arrowJob = classifyReportPlacement(
      blankNonCode(`
        export const processThing = async (m: Message): Promise<void> => {
          const rows = await prisma.thing.findMany({});
          reportJobOutcome({ job: "thing", selected: rows.length, written: 0 });
        };
      `),
    );
    assert.equal(
      arrowJob.verdict,
      "guarded",
      `an arrow-declared processor was graded ${arrowJob.verdict} ` +
        `(${arrowJob.unguardedReturns.join(",")})`,
    );

    // The genuinely orphaned shape must still fire — a NON-exported helper
    // holding the only reporter, that nothing calls.
    const orphanHelper = classifyReportPlacement(
      blankNonCode(`
        const emitOutcome = (): void => {
          reportJobOutcome({ job: "thing", selected: 0, written: 0 });
        };
      `),
    );
    assert.equal(orphanHelper.verdict, "bypassed");
  });

  it("[meta] an UNCALLED exit helper does not count as guarded", () => {
    // The failure mode a naive per-function analysis has: `emitOutcome` is
    // three lines long and has no early return, so judged on its own it is
    // perfectly "guarded" while the processor never reaches it. Seven
    // processors in this tree report through a helper, so this is the common
    // case and not a corner.
    const orphan = classifyReportPlacement(
      blankNonCode(`
        export async function processThing(): Promise<void> {
          const rows = await prisma.thing.findMany({});
          if (rows.length === 0) return;
          await write(rows);
          function emitOutcome(): void {
            reportJobOutcome({ job: "thing", selected: 0, written: 0 });
          }
        }
      `),
    );
    assert.equal(orphan.verdict, "bypassed");
    assert.ok(
      orphan.unguardedReturns.includes("processThing:fall-through"),
      `expected the ORDINARY path to be named as emitting nothing, got ` +
        `${JSON.stringify(orphan.unguardedReturns)}`,
    );
  });

  it("[meta] an arrow-assigned reporter helper is still recognised", () => {
    // `price-sync.ts` reports through `const emitOutcome = (reason) => {…}`.
    // The fat arrow contains an `=`, so a name pattern anchored on `=` either
    // stops before the binding or runs past it — and an unnamed helper drops
    // out of the fixpoint, at which point the processor reads as reporting from
    // a nested function it never calls. That is a FALSE FAILURE, and a false
    // failure on a real processor is how a baseline becomes a regeneration
    // ritual.
    const arrowHelper = classifyReportPlacement(
      blankNonCode(`
        export async function processThing(): Promise<void> {
          let written = 0;
          const emitOutcome = (reason: string): void => {
            reportJobOutcome({ job: "thing", selected: 0, written, skippedReason: reason });
          };
          try {
            const rows = await prisma.thing.findMany({});
            written = await write(rows);
            emitOutcome("ok");
            return;
          } catch (err) {
            emitOutcome("threw");
            throw err;
          }
        }
      `),
    );
    assert.equal(
      arrowHelper.verdict,
      "guarded",
      arrowHelper.unguardedReturns.join(","),
    );
    assert.deepEqual(arrowHelper.unguardedThrows, []);
  });

  it("[meta] a top-level reporting helper is judged through its CALLER", () => {
    // Seven processors report through a top-level helper —
    // `reportXbrlSyncOutcome`, `reportBhavcopyOutcome`, `reportMoversOutcome`.
    // Judged on its own the helper is trivially compliant; the question is
    // whether the JOB reaches it, so the helper's call sites have to become
    // report sites in the processor. Here the caller skips it on one path.
    const leaky = classifyReportPlacement(
      blankNonCode(`
        function reportThingOutcome(written: number): void {
          reportJobOutcome({ job: "thing", selected: 0, written });
        }
        export async function processThing(): Promise<void> {
          const rows = await prisma.thing.findMany({});
          if (rows.length === 0) return;
          reportThingOutcome(await write(rows));
        }
      `),
    );
    assert.equal(leaky.verdict, "bypassed");
    assert.deepEqual(leaky.unguardedReturns, ["processThing:return"]);

    const clean = classifyReportPlacement(
      blankNonCode(`
        function reportThingOutcome(written: number): void {
          reportJobOutcome({ job: "thing", selected: 0, written });
        }
        export async function processThing(): Promise<void> {
          const rows = await prisma.thing.findMany({});
          if (rows.length === 0) {
            reportThingOutcome(0);
            return;
          }
          reportThingOutcome(await write(rows));
        }
      `),
    );
    assert.equal(clean.verdict, "guarded", clean.unguardedReturns.join(","));
  });

  it("[meta] a `return` inside a CALLBACK is not an exit from the job", () => {
    // `rows.filter(r => { if (!r.ok) return false; return true; })` must not
    // read as two silent exits. Over-firing here would push the baseline to
    // most of the directory, which is how a ratchet becomes a regeneration
    // ritual.
    const callbacks = classifyReportPlacement(
      blankNonCode(`
        export async function processThing(): Promise<void> {
          const rows = await prisma.thing.findMany({});
          const keep = rows.filter((r) => {
            if (!r.ok) return false;
            return true;
          });
          reportJobOutcome({ job: "thing", selected: rows.length, written: keep.length });
        }
      `),
    );
    assert.equal(
      callbacks.verdict,
      "guarded",
      callbacks.unguardedReturns.join(","),
    );
  });

  it("[meta] coverage is DOMINANCE, not mere precedence", () => {
    // Both directions of the same rule, and each one is a real processor.
    //
    // A call in a branch does NOT cover a later exit — the branch may not have
    // been taken, and accepting it would let a report buried in an `if (debug)`
    // vouch for every skip path after it.
    const branchOnly = classifyReportPlacement(
      blankNonCode(`
        export async function processThing(): Promise<void> {
          const rows = await prisma.thing.findMany({});
          if (rows.length > 100) {
            reportJobOutcome({ job: "thing", selected: rows.length, written: 0 });
          }
          if (rows.length === 0) return;
          await write(rows);
        }
      `),
    );
    assert.equal(branchOnly.verdict, "bypassed");
    assert.ok(branchOnly.unguardedReturns.includes("processThing:return"));

    // A call at FUNCTION level DOES cover an exit nested below it — it has
    // already run. This is `corporate-actions-sync`'s total-failure throw,
    // which the block-scoped test called silent when it is not, and calling a
    // correct pattern broken is how a guard gets deleted.
    const dominating = classifyReportPlacement(
      blankNonCode(`
        export async function processThing(): Promise<void> {
          const rows = await prisma.thing.findMany({});
          const failures = await write(rows);
          reportJobOutcome({ job: "thing", selected: rows.length, written: rows.length - failures });
          if (failures === rows.length) {
            throw new Error("persisted NOTHING");
          }
        }
      `),
    );
    assert.equal(dominating.verdict, "guarded");
    assert.deepEqual(
      dominating.unguardedThrows,
      [],
      "a throw BELOW a function-level report was reported as emitting nothing",
    );
  });

  it("[meta] the verdict survives REFORMATTING", async () => {
    // The property the whole approach rests on: this is a source scan, and a
    // source scan that changes its mind when prettier reflows an argument list
    // is a source scan nobody will keep. Reflow a real processor's whitespace
    // and re-ask.
    const raw = await readFile(
      join(PROCESSOR_DIR, "us-filing-insight.ts"),
      "utf8",
    );
    const before = classifyReportPlacement(blankNonCode(raw));
    const reflowed = raw
      .replace(/\n\s+/g, "\n ")
      .replace(/\(\s*\{/g, "({")
      .replace(/\}\s*\)/g, "})");
    const after = classifyReportPlacement(blankNonCode(reflowed));
    assert.equal(before.verdict, "finally");
    assert.equal(
      after.verdict,
      before.verdict,
      "reformatting changed the verdict — the scan is keyed on layout, not on " +
        "structure, and it will be regenerated blindly the first time it fires",
    );
  });

  it("[regression] no processor reports on a path an early `return` skips", async () => {
    const rows = await scan();
    const offenders: string[] = [];
    for (const { file, placement } of rows) {
      if (placement.verdict !== "bypassed") continue;
      const permit = RETURN_BYPASS_BASELINE.get(file);
      const actual: Record<string, number> = {};
      for (const site of placement.unguardedReturns) {
        const fn = site.split(":")[0]!;
        actual[fn] = (actual[fn] ?? 0) + 1;
      }
      if (!permit) {
        offenders.push(
          `${file} — ${JSON.stringify(actual)} (no baseline entry)`,
        );
        continue;
      }
      if (JSON.stringify(actual) !== JSON.stringify(permit.returns)) {
        offenders.push(
          `${file} — baseline says ${JSON.stringify(permit.returns)}, ` +
            `scan found ${JSON.stringify(actual)}`,
        );
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "A `reportJobOutcome` in these processors sits below a `return`, so the " +
        "metric is NOT emitted on that path. The run ACKs 200, the schedule " +
        "looks healthy, and a `notify_no_data` monitor over a series with a " +
        "hole in it cannot tell that from a quiet market — which is what " +
        "`stock-document-extract` did on every idle night until MONEY-1255. " +
        "Fix: move the call into a `finally` (the strongest shape — a throw " +
        "emits too), or emit inside each early-exit branch before its " +
        "`return`. If the count went DOWN, lower the baseline instead.\n" +
        offenders.join("\n"),
    );
  });

  it("[meta] the SHRINK arm fires — on a repaired file and on a deleted one", async () => {
    // The arm below iterates `RETURN_BYPASS_BASELINE`, which is EMPTY, so it
    // asserts nothing about anything: swapping its `stale.push` for a
    // `continue` broke no test. It is also the arm that proved MONEY-1328's
    // four fixes landed — without it a repaired processor silently keeps its
    // allowance and the next bypass added to that file is covered by a permit
    // nobody re-read. So the logic is driven here with the entries the real
    // baseline no longer has.
    const permit = (reason: string): BypassPermit => ({
      returns: { processThing: 1 },
      reason,
    });
    const rows: Scanned[] = [
      {
        file: "repaired.ts",
        placement: {
          verdict: "guarded",
          fn: "processThing",
          unguardedReturns: [],
          unguardedThrows: [],
        },
      },
      {
        file: "still-broken.ts",
        placement: {
          verdict: "bypassed",
          fn: "processThing",
          unguardedReturns: ["processThing:return"],
          unguardedThrows: [],
        },
      },
    ];

    // A permit whose file was FIXED, and a permit whose file is GONE, both go
    // stale; a permit whose finding is still live does not.
    assert.deepEqual(
      staleBaselineEntries(
        new Map([
          ["repaired.ts", permit("moved into a finally")],
          ["deleted.ts", permit("job retired")],
          ["still-broken.ts", permit("not fixed yet")],
        ]),
        rows,
      ),
      [
        "repaired.ts — now `guarded`; delete its entry — moved into a finally",
        "deleted.ts — no such processor any more",
      ],
    );

    // …and the arm must stay SILENT when every permit is still earned, or it
    // fires on everything and gets deleted.
    assert.deepEqual(
      staleBaselineEntries(
        new Map([["still-broken.ts", permit("not fixed yet")]]),
        rows,
      ),
      [],
    );
  });

  it("[ratchet] every baseline entry is still a live finding", async () => {
    const rows = await scan();
    const stale = staleBaselineEntries(RETURN_BYPASS_BASELINE, rows);
    assert.deepEqual(
      stale,
      [],
      "These are baselined as unreachable and are not. The list must only ever " +
        "SHRINK: a permit that outlives its finding is a permit that silently " +
        "covers the NEXT bypass added to the same file.\n" +
        stale.join("\n"),
    );
  });

  it("[ratchet] the strongest placements are pinned by name", async () => {
    const rows = await scan();
    const byFile = new Map(rows.map((r) => [r.file, r.placement]));
    const weakened: string[] = [];
    for (const [file, why] of PINNED_STRONG_PLACEMENT) {
      const placement = byFile.get(file);
      if (!placement) {
        weakened.push(`${file} — gone; re-point this pin (${why})`);
        continue;
      }
      if (placement.verdict === "bypassed") {
        weakened.push(`${file} — now BYPASSED (${why})`);
      }
    }
    assert.deepEqual(weakened, [], weakened.join("\n"));
    // …and the four strongest must still be `finally` specifically. Dropping to
    // `guarded` is not a failure today and IS the step before one.
    const mustBeFinally = [
      "us-filing-insight.ts",
      "filing-insight-sweep.ts",
      "stock-document-extract.ts",
      "bse-announcements-sync.ts",
      "us-eod-sync.ts",
      // MONEY-1328. The one job in this directory whose data cannot be
      // re-fetched: `/api/fiidiiTradeReact` takes no date parameter and serves
      // only the current reading, so a day this job goes silent is a day that
      // never enters the record. `guarded` would be enough to satisfy the
      // ratchet and is NOT enough here.
      "institutional-flow-sync.ts",
    ];
    for (const file of mustBeFinally) {
      assert.equal(
        byFile.get(file)?.verdict,
        "finally",
        `${file} no longer reports from a \`finally\`, so a throw now emits ` +
          `nothing — and every one of these was placed there by a ticket that ` +
          `measured the outage`,
      );
    }
  });

  it("[meta] the reachability scan agrees with the COVERAGE scan on who reports", async () => {
    // The two guards read the same directory through the same blanker and must
    // not disagree about the population. A file the coverage scan counts as
    // reporting and this one calls `absent` is a hole in one of them, and it is
    // exactly the state that let the alias refactor go unnoticed (MONEY-1238).
    const rows = await scan();
    const disagreements: string[] = [];
    for (const { file, placement } of rows) {
      const code = blankNonCode(
        await readFile(join(PROCESSOR_DIR, file), "utf8"),
      );
      const callsIt = outcomeReporterNames(code).some((n) =>
        new RegExp(`\\b${n}\\s*\\(`).test(code),
      );
      if (callsIt !== (placement.verdict !== "absent")) {
        disagreements.push(
          `${file}: coverage-style says ${callsIt}, placement says ` +
            `${placement.verdict}`,
        );
      }
    }
    assert.deepEqual(disagreements, [], disagreements.join("\n"));
  });

  it("prints the throw-only census out loud", async () => {
    const rows = await scan();
    const throwers = rows.filter(
      (r) =>
        r.placement.verdict !== "absent" &&
        r.placement.unguardedThrows.length > 0,
    );
    // Printed, never asserted — see the header. Six of these throw ON PURPOSE
    // so the route 500s and the dead-letter consumer reaches a human; failing
    // them would make this guard fire on the correct pattern.
    console.log(
      `[job-outcome reachability] ${countBy(rows, "finally")} finally / ` +
        `${countBy(rows, "guarded")} guarded / ${countBy(rows, "bypassed")} ` +
        `bypassed of ${rows.filter((r) => r.placement.verdict !== "absent").length} ` +
        `reporting processors — ${throwers.length} also have a \`throw\` that ` +
        `emits nothing: ${throwers.map((t) => t.file).join(", ")}`,
    );
    assert.ok(
      countBy(rows, "finally") > 0,
      "at least one processor must use a `finally`",
    );
  });
});

describe("MONEY-1325 — the blanker the verdicts rest on", () => {
  it("a `/*` inside a STRING does not open a comment", () => {
    // The mirror of MONEY-1143, and it is live in this tree: three processors
    // send an HTTP `Accept` header containing `*` `/` `*`. Under the old
    // regex pair each one opened a block comment that ran to the next real
    // `*` `/`, blanking ~40 lines of code — INCLUDING the string's own closing
    // quote, which then unbalanced every quote after it.
    const src = [
      'const HEADERS = { accept: "application/xml,text/xml,*' + '/*" };',
      "await prisma.thing.deleteMany({ where: {} });",
      'reportJobOutcome({ job: "thing", selected: 1, written: 1 });',
    ].join("\n");
    const code = blankNonCode(src);
    assert.equal(
      code.split("\n").length,
      src.split("\n").length,
      "offsets and line count must be preserved",
    );
    assert.match(
      code,
      /deleteMany/,
      "the write after the header was swallowed",
    );
    assert.match(
      code,
      /reportJobOutcome\(/,
      "the report after the header was swallowed",
    );
  });

  it("a `//` inside a STRING does not open a line comment", () => {
    const code = blankNonCode(
      'const u = "https://nsearchives.nseindia.com/x";\nreportJobOutcome({ job: "a", selected: 1, written: 1 });',
    );
    assert.match(code, /reportJobOutcome\(/);
  });

  it("a nested object inside `${…}` does not desynchronise the braces", () => {
    // `login-briefing.ts:199` — `${n.toLocaleString("en-IN", { … })}`. A walker
    // that stops at the first `}` treats the REAL closing brace as template
    // text, blanks it, and every brace verdict after that point is wrong. Two
    // processor files were unbalanced by exactly this.
    const src = [
      "function f(): void {",
      '  const s = `worth ${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;',
      "  g(s);",
      "}",
    ].join("\n");
    const code = blankNonCode(src);
    let depth = 0;
    for (const ch of code) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    assert.equal(
      depth,
      0,
      `braces unbalanced by ${depth}: ${JSON.stringify(code)}`,
    );
  });

  it("a brace inside a STRING inside `${…}` does not desynchronise", () => {
    // One level in from the phantom-comment fix, and the same shape: the
    // interpolation walker counted RAW braces, so `${x ?? "{"}` left the file
    // unbalanced from that point and every scope verdict after it was wrong.
    //
    // The live instance in this tree — `document-process.ts:94`,
    // `` `"${doc?.title || "Document"}"` `` — happens to BALANCE, so no verdict
    // changed. That is luck, and the brace-balance case below only catches a
    // desync that fails to cancel out.
    for (const [label, src] of [
      [
        "open brace in a string",
        'const s = `${x ?? "{"}`;\nfunction f(): void { g(); }',
      ],
      [
        "close brace in a string",
        'const s = `${x ?? "}"}`;\nfunction f(): void { g(); }',
      ],
      [
        "brace in a block comment",
        "const s = `${/* } */ x}`;\nfunction f(): void { g(); }",
      ],
      [
        "the live document-process shape",
        'const m = `"${doc?.title || "Document"}" is ready.`;\nfunction f(): void { g(); }',
      ],
    ] as const) {
      const code = blankNonCode(src);
      let depth = 0;
      let min = 0;
      for (const ch of code) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth < min) min = depth;
        }
      }
      assert.equal(depth, 0, `${label}: unbalanced by ${depth}`);
      assert.equal(min, 0, `${label}: went negative (${min})`);
      // …and the real code AFTER the template must survive, or the walker ate
      // the rest of the file instead of just miscounting it.
      assert.match(code, /function f\(\): void \{ g\(\); \}/, label);
    }
  });

  it("every processor file is brace-BALANCED after blanking", async () => {
    // The load-bearing property. Every placement verdict is a brace walk, so a
    // single desynchronised file silently reports the wrong scope for every
    // call site in it — and reports it as a PASS, because a lost call site
    // looks like a file that does not report.
    const files = (await readdir(PROCESSOR_DIR)).filter((f) =>
      f.endsWith(".ts"),
    );
    const broken: string[] = [];
    for (const file of files) {
      const code = blankNonCode(
        await readFile(join(PROCESSOR_DIR, file), "utf8"),
      );
      let depth = 0;
      let min = 0;
      for (const ch of code) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth < min) min = depth;
        }
      }
      if (depth !== 0 || min < 0)
        broken.push(`${file} (final ${depth}, min ${min})`);
    }
    assert.deepEqual(
      broken,
      [],
      `the blanker desynchronised:\n${broken.join("\n")}`,
    );
  });

  it("[meta] the scope walker reaches the enclosing PROCESSOR through a TS return type", () => {
    // `): Promise<{ ok: boolean; results: R[] }> {` — the braces of the return
    // TYPE sit between the parameter list and the body, so the raw text before
    // the body's `{` ends in `]; }>` and matches no function-header pattern.
    // `index-constituent-sync.ts` has exactly this signature, and without the
    // collapse it reads as having no enclosing function at all — which is a
    // silent PASS.
    const src = [
      "export async function processThing(",
      "  m: Message,",
      "): Promise<{ ok: boolean; results: R[] }> {",
      "  reportJobOutcome({ job: 'thing', selected: 0, written: 0 });",
      "  return { ok: true, results: [] };",
      "}",
    ].join("\n");
    const code = blankNonCode(src);
    const at = code.indexOf("reportJobOutcome");
    const scope = enclosingScope(code, at);
    assert.equal(scope?.name, "processThing");
    assert.ok(
      matchingClose(code, scope!.open) > at,
      "the resolved function body must contain the call it was resolved from",
    );
  });
});
