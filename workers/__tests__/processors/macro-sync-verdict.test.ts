/**
 * UNIT TEST — macro-sync's `ok` must include whether rows were WRITTEN.
 * MONEY-1238, item 1.
 *
 * ## The defect
 *
 *     const ok = results.every((r) => r.fetched && r.recognised && r.parsed > 0);
 *
 * Three fetch/parse properties and nothing about the write. `written` was
 * computed by `writeObservations`, logged, returned in the result, and read by
 * nobody who decides anything — so a run in which every single
 * `macroSeries.upsert` threw produced `written: 0, parsed: 90, ok: true`, the
 * route answered 200, and Pub/Sub acked.
 *
 * That matters more here than almost anywhere else in this repo: RBI's
 * `param=2` forex page serves exactly ONE "as on" column, so a week acked
 * without being stored does not exist for us afterwards. The Tuesday
 * `macro-sync-midweek` run is the only second chance, and it only helps if
 * Saturday's run admitted it failed.
 *
 * ## What is asserted
 *
 * Both halves, because either alone is worthless:
 *
 *   BEHAVIOUR — `judgeMacroSource` / `macroRunOk`, the REAL exports the
 *   processor calls. No shadow copy.
 *
 *   WIRING — that `processMacroSync` actually calls them and that the old
 *   expression is gone. A correct verdict function nobody calls is exactly the
 *   defect class this ticket is about, and this repo has paid for
 *   "merged ≠ wired" before.
 *
 * The source scan strips LINE comments BEFORE block comments (MONEY-1143), and
 * it must: the processor's own comments QUOTE the old expression verbatim, so
 * an un-stripped scan would find the banned shape in prose and fail forever.
 *
 * Nothing here opens a socket, a Prisma handle or a timer.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../_support/repo-root";

import {
  judgeMacroSource,
  isMacroSourceOk,
  macroRunOk,
  macroFailureReasons,
  type MacroSourceOutcome,
} from "../../src/processors/macro-sync-logic";

/* -------------------------------------------------------------------------- */
/* source scan                                                                 */
/* -------------------------------------------------------------------------- */

const spaces = (s: string): string => s.replace(/[^\n]/g, " ");

/**
 * Blank comment BODIES, preserving offsets and newlines.
 *
 * LINE comments first, BLOCK comments second (MONEY-1143): a `//` comment
 * containing `/*` otherwise opens a phantom block that swallows real code up to
 * the next terminator.
 */
function blankComments(src: string): string {
  return src
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p1: string) =>
      p1 === undefined ? spaces(m) : p1 + spaces(m.slice(p1.length)),
    )
    .replace(/\/\*[\s\S]*?\*\//g, (m) => spaces(m));
}

const RAW = readFileSync(
  join(repoRoot(), "workers", "src", "processors", "macro-sync.ts"),
  "utf8",
);
const CODE = blankComments(RAW);

/** A healthy source outcome, mutated per case. */
const healthy: MacroSourceOutcome = {
  fetched: true,
  recognised: true,
  parsed: 90,
  written: 90,
  writeFailed: 0,
};

describe("macro-sync verdict: the write decides too (MONEY-1238)", () => {
  it("[meta] the sources this file reasons over actually loaded", () => {
    // A structural suite whose file read silently returned "" passes every
    // `doesNotMatch` and is worth nothing.
    assert.ok(RAW.length > 2000, `macro-sync.ts did not load (${RAW.length}B)`);
    assert.ok(
      CODE.includes("processMacroSync"),
      "comment-stripping ate the code it was supposed to preserve",
    );
  });

  it("[meta] the stripper strips LINE before BLOCK", () => {
    const src = [
      "// a line comment mentioning /* an unterminated block",
      "const ok = macroRunOk(results);",
      "/* a real block mentioning results.every( inside */",
    ].join("\n");
    const out = blankComments(src);
    assert.equal(out.split("\n").length, src.split("\n").length);
    assert.ok(
      out.includes("macroRunOk(results)"),
      "the REAL statement must survive stripping",
    );
    assert.ok(
      !/results\.every\(/.test(out),
      "an expression mentioned only inside a block comment must not count",
    );
  });

  it("a fully-written source is OK", () => {
    assert.equal(judgeMacroSource(healthy), "OK");
    assert.equal(isMacroSourceOk(healthy), true);
  });

  it("REGRESSION: parsed 90, written 0 is NOT ok", () => {
    // The exact production shape the old expression called healthy: the page
    // fetched, the table parsed, 90 observations came out, and MongoDB took
    // none of them.
    const r = { ...healthy, written: 0, writeFailed: 90 };
    assert.equal(judgeMacroSource(r), "NOTHING_WRITTEN");
    assert.equal(isMacroSourceOk(r), false);
  });

  it("REGRESSION: written 0 with writeFailed 0 is still NOT ok", () => {
    // `writeFailed` is not the only route to an empty write — a writer that
    // returned early stores nothing and throws nothing. Both are failures, and
    // the verdict must not depend on the error counter to notice.
    const r = { ...healthy, written: 0, writeFailed: 0 };
    assert.equal(judgeMacroSource(r), "NOTHING_WRITTEN");
  });

  it("a PARTIAL write is not ok — the page cannot be re-read", () => {
    // 89 of 90 stored. The forex page publishes one non-backfillable column, so
    // the missing row is a permanent hole; the route 500s and the redelivery
    // re-upserts on (seriesId, period), which is a no-op for the 89.
    const r = { ...healthy, written: 89, writeFailed: 1 };
    assert.equal(judgeMacroSource(r), "PARTIAL_WRITE");
    assert.equal(isMacroSourceOk(r), false);
  });

  it("a write failure alone is enough, even at full count", () => {
    // Defensive: `written === parsed` yet something threw. The two counters are
    // separate on purpose, so neither may mask the other.
    const r = { ...healthy, written: 90, writeFailed: 3 };
    assert.equal(judgeMacroSource(r), "PARTIAL_WRITE");
  });

  it("the fetch/parse verdicts still hold, and stay distinguishable", () => {
    assert.equal(
      judgeMacroSource({ ...healthy, fetched: false, recognised: false }),
      "FETCH_FAILED",
    );
    assert.equal(
      judgeMacroSource({ ...healthy, recognised: false }),
      "NO_TABLE",
    );
    assert.equal(
      judgeMacroSource({ ...healthy, parsed: 0, written: 0 }),
      "NO_TRACKED_SERIES",
    );
  });

  it("the earliest failure is the one named", () => {
    // A source that never fetched has written nothing either. Reporting
    // NOTHING_WRITTEN for it would send an operator to the database for a
    // problem that is at RBI.
    assert.equal(
      judgeMacroSource({
        fetched: false,
        recognised: false,
        parsed: 0,
        written: 0,
        writeFailed: 0,
      }),
      "FETCH_FAILED",
    );
  });

  it("the RUN is ok only when EVERY source is", () => {
    const bad = { ...healthy, written: 0, writeFailed: 90 };
    assert.equal(macroRunOk([healthy, healthy, healthy]), true);
    assert.equal(macroRunOk([healthy, bad, healthy]), false);
  });

  it("REGRESSION: an EMPTY run is not a clean run", () => {
    // `[].every(...)` is `true`. The processor's early return for "the operator
    // named ids that match nothing" relied on a separate branch to say
    // ok:false; folding the floor into the verdict means the two cannot drift.
    assert.equal(macroRunOk([]), false);
  });

  it("macroFailureReasons names the failing sources and only those", () => {
    const reasons = macroFailureReasons([
      { ...healthy, sourceId: "rbi-nsdp-rates" },
      { ...healthy, sourceId: "rbi-nsdp-forex", written: 0, writeFailed: 24 },
      { ...healthy, sourceId: "rbi-nsdp-prices", written: 5 },
    ]);
    assert.deepEqual(reasons, [
      { sourceId: "rbi-nsdp-forex", verdict: "NOTHING_WRITTEN" },
      { sourceId: "rbi-nsdp-prices", verdict: "PARTIAL_WRITE" },
    ]);
  });
});

describe("macro-sync verdict: WIRED into the processor (MONEY-1238)", () => {
  it("processMacroSync computes `ok` from macroRunOk", () => {
    assert.match(
      CODE,
      /const ok = macroRunOk\(results\);/,
      "the run verdict must come from the shared function — a correct " +
        "judgement nobody calls is the defect, not the fix",
    );
  });

  it("REGRESSION: the old fetch/parse-only expression is gone from CODE", () => {
    assert.doesNotMatch(
      CODE,
      /results\.every\(\s*\(r\)\s*=>\s*r\.fetched/,
      "`ok` must not be re-derived from fetch/parse fields alone",
    );
  });

  it("the write FAILURE count reaches the returned result", () => {
    // `writeObservations` returns {written, failed}; if `failed` is not carried
    // onto the result the verdict can never see PARTIAL_WRITE, and the pure
    // function above becomes decorative.
    assert.match(
      CODE,
      /return \{ \.\.\.base, written, writeFailed: failed \};/,
      "the per-row upsert failure count must reach MacroSourceResult",
    );
  });

  it("writeObservations RETURNS its failure count rather than only logging it", () => {
    assert.match(
      CODE,
      /\): Promise<\{ written: number; failed: number \}> \{/,
      "a count that cannot leave the function cannot reach a decider",
    );
    assert.match(
      CODE,
      /return \{ written, failed \};/,
      "both counters must be returned",
    );
  });

  it("every construction of a source result carries writeFailed", () => {
    // Three literals build a MacroSourceResult (`empty`, `base`, the write
    // return). If one omits the field TypeScript catches it — but a `0`
    // hard-coded into the write path would compile and silently disarm
    // PARTIAL_WRITE, so the count of REAL wirings is pinned here.
    const occurrences = CODE.match(/writeFailed/g) ?? [];
    assert.ok(
      occurrences.length >= 4,
      `expected writeFailed at the interface + 3 construction sites, ` +
        `found ${occurrences.length}`,
    );
    assert.doesNotMatch(
      CODE,
      /return \{ \.\.\.base, written, writeFailed: 0 \}/,
      "hard-coding the failure count to zero re-disarms the verdict",
    );
  });
});
