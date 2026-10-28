/**
 * Backfill scripts must not report success over data they failed to fetch —
 * MONEY-1238.
 *
 * These three run as Cloud Run jobs, so the script's exit code IS the job's
 * status. Each had computed a failure and then failed to let it reach that exit
 * code, in a different way:
 *
 *   - `feed-backfill` returned from `main()` on its transport stop-loss, which
 *     resolves the promise normally, so the `.catch` never ran.
 *   - `xbrl-backfill` left `fetchFailed` out of its exit expression while BOTH
 *     of its sibling passes gate on it — and one of them writes down the reason.
 *   - `corp-actions-backfill` recorded only the windows the FETCHER reported,
 *     so a THROWN leg was recorded nowhere and the run printed "COMPLETE".
 *
 * ## Why these are structural
 *
 * `scripts/` is type-checked by nothing and executed by no test — every one of
 * these needs a live Mongo and a live exchange to run. So the assertions read
 * the source. To stay out of the shadow-test trap the audit found twice, each
 * one is anchored on the DECISION (an assignment to `process.exitCode`, an
 * append to the list the verdict is computed from) rather than on prose, and
 * each is mutation-verified: deleting the decision turns it red.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");

/** LINE comments first, then BLOCK — MONEY-1143. The reverse order leaves the
 *  contents of a block comment behind whenever it contains a `//`. */
const strip = (rel: string): string =>
  readFileSync(join(REPO, rel), "utf8")
    .replace(/^[^\S\r\n]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

describe("MONEY-1238 — feed-backfill's stop-loss is a FAILED run", () => {
  const CODE = strip("scripts/jobs/feed-backfill.ts");

  it("the transport stop-loss sets a non-zero exit before returning", () => {
    // THE DEFECT: `return` from main() resolves the promise, so the `.catch`
    // that sets exitCode never ran. NSE refusing our egress — the exact thing
    // the stop-loss exists to detect — produced a SUCCEEDED Cloud Run job.
    const block = /if \(shouldAbort\(runs\.transport[\s\S]*?\n {6}\}/.exec(
      CODE,
    );
    assert.ok(block, "could not locate the transport stop-loss block");
    assert.match(
      block[0],
      /process\.exitCode = 1;[\s\S]*?return;/,
      "a deliberate abort must still exit non-zero",
    );
  });

  it("the payload stop-loss records the abandoned family", () => {
    // Not fatal — a feed that did not exist in the requested era is a
    // legitimate outcome — but the family holds NO data, so it must survive to
    // the final summary instead of scrolling past as a mid-run warn.
    assert.match(CODE, /abandonedFamilies\.push\(family\.id\)/);
    assert.match(
      CODE,
      /abandonedFamilies\.length > 0[\s\S]*?ABANDONED/,
      "abandoned families must be reported at the end of the run",
    );
  });
});

describe("MONEY-1238 — xbrl-backfill gates on what it could not fetch", () => {
  const CODE = strip("scripts/jobs/xbrl-backfill.ts");

  it("the main walk's exit expression includes fetchFailed", () => {
    // Both sibling passes already do this, and one states why verbatim: "a
    // fetch failure is a filing whose row we do NOT have and cannot tell apart
    // from one that has none". The main walk — which does the bulk of the
    // work — omitted it, so a window where thousands of filings 404'd printed
    // its counts, exited 0, and the shard was ticked off as complete.
    // Collected as WHOLE gates, then selected — MONEY-1238. The first version
    // of this test used `/if \(\s*failedWindows[\s\S]*?process\.exitCode = 1;/`
    // and was VACUOUS: the lazy span began at an earlier `if (failedWindows...)`
    // WARN block and ran through the gate, so the captured text still contained
    // `totals.fetchFailed` from a neighbouring block after the mutation removed
    // it from the gate itself. It passed against mutated source. `[^)]*?` cannot
    // cross a `)`, so each match here is exactly one condition.
    const gates = [
      ...CODE.matchAll(/if \(([^)]*?)\)\s*\{\s*process\.exitCode = 1;\s*\}/g),
    ].map((m) => m[1]!);
    const walkGate = gates.find((g) => /failedWindows\.length/.test(g));
    assert.ok(
      walkGate,
      `could not locate the main walk's exit gate; found:\n${gates.join("\n")}`,
    );
    assert.match(
      walkGate,
      /totals\.fetchFailed > 0/,
      "undownloaded filings must fail the run, as both sibling passes already do",
    );
  });

  it("an unreadable archive probe is COUNTED, not silently assumed present", () => {
    // Assuming PRESENT on a read error is the RIGHT call and is kept: a read
    // outage is not evidence of absence, and treating it as one would re-scrape
    // NSE for thousands of filings we already hold. What was wrong is that
    // "assumed present" and "confirmed present" were the same number, so a
    // total storage outage — every probe throwing — printed MISSING 0 and
    // exited 0, which reads as a fully archived corpus.
    // A bounded WINDOW rather than a `}`-terminated match: the log line is a
    // template literal, so `${key}` and `${String(err)}` each contribute a `}`,
    // and a non-greedy match ends inside the string it is trying to span. This
    // test failed for exactly that reason before the window replaced it — the
    // regex was wrong, not the code it was inspecting.
    const at = CODE.indexOf("archive probe failed");
    assert.notEqual(at, -1, "could not locate the archive probe catch");
    const c = CODE.slice(at, at + 300);
    assert.match(c, /out\.probeFailed\+\+/, "a failed probe must be counted");
    assert.match(
      c,
      /present = true/,
      "the conservative assumption must be PRESERVED — flipping it re-scrapes NSE",
    );
    // Bounded window, same reason as above: an unbounded lazy span would find
    // some LATER `process.exitCode = 1` and pass even with this gate deleted.
    const g = CODE.indexOf("r.probeFailed > 0");
    assert.notEqual(g, -1, "no gate on the probe-failure count");
    assert.match(
      CODE.slice(g, g + 700),
      /process\.exitCode = 1/,
      "an unproven coverage verdict must not exit 0",
    );
  });
});

describe("MONEY-1238 — corp-actions-backfill records a THROWN leg", () => {
  const CODE = strip("scripts/jobs/corp-actions-backfill.ts");

  it("both leg catches append to the list the verdict is computed from", () => {
    // THE DEFECT: `tally.failedWindows.push(...src.failedWindows)` sits INSIDE
    // the try, after the await. When the fetcher throws — a typed rate-limit
    // error re-raises, and so does any transport failure — control jumps to the
    // catch, which only logged. A 20-year walk in which every leg threw printed
    // twenty lines, zero failed windows, "COMPLETE: every window was fetched."
    // and exit 0: the completion verdict computed over an empty list.
    const catches = CODE.match(/catch \(err\) \{[\s\S]*?\n {6}\}/g) ?? [];
    const legCatches = catches.filter((c) => /leg failed for/.test(c));
    assert.equal(legCatches.length, 2, "expected an NSE and a BSE leg catch");
    for (const c of legCatches) {
      assert.match(
        c,
        /windowFailed = true;/,
        `a thrown leg must mark its window as failed:\n${c}`,
      );
    }
    // ONE ENTRY PER WINDOW — MONEY-1236. Both catches used to push directly, so
    // a window where NSE *and* BSE threw was recorded TWICE: the failure count
    // doubled and the heal list re-fetched the same range twice. The flag is set
    // by either leg and consumed once, after both have run.
    assert.match(
      CODE,
      /let windowFailed = false;/,
      "the flag must be declared per window, inside the loop",
    );
    assert.match(
      CODE,
      /if \(windowFailed\) tally\.failedWindows\.push\(\{ from: w\.from, to: w\.to \}\);/,
      "and consumed exactly once per window",
    );
    const directPushes =
      CODE.match(/tally\.failedWindows\.push\(\{ from: w\.from/g) ?? [];
    assert.equal(
      directPushes.length,
      1,
      `exactly one per-window push; found ${directPushes.length}`,
    );
  });

  it("failedWindows still decides the exit code", () => {
    // The append is only worth anything because this consumes it.
    assert.match(
      CODE,
      /tally\.failedWindows\.length > 0[\s\S]*?process\.exitCode = 1;[\s\S]*?\} else \{[\s\S]*?COMPLETE/,
      "the COMPLETE banner must be the else-arm of the failure gate",
    );
  });
});
