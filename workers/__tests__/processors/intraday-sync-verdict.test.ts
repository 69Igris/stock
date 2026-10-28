/**
 * UNIT TEST — intraday-sync's sync-log STATUS must come from real counts.
 * MONEY-1238, item 4.
 *
 * ## The defect, and why it is easier to miss than price-sync's
 *
 *     data: {
 *       status: "COMPLETED",
 *       recordsProcessed: totals.inserted,
 *       recordsFailed: totals.failed,
 *       …
 *     }
 *
 * The counts ARE there. That is what made it hard to see: the row looks fully
 * instrumented, and the STATUS one line above them never reads either one. A
 * run that processed 500 symbols, fetched nothing, inserted nothing and failed
 * nothing closed its row identically to a healthy one, and the only place the
 * difference showed was a console line nobody queries.
 *
 * ## `totals.failed` could not have caught it anyway
 *
 * `backfillIntradayBars` (packages/core/.../intraday-bar-service.ts:284-292)
 * catches a fetch throw and returns `{fetched: 0, inserted: 0, skipped: 0,
 * failed: 0}` — **failed: 0**. Core reports a Yahoo egress block as "nothing to
 * do", so reading `totals.failed` harder would not have helped. The worker's
 * own fetcher counts what core swallows, via `YahooFetchErrorOpts.onError`, and
 * separately counts the OTHER silent exit — the short-circuit for an instrument
 * with no `yahooSymbol`, which also returns `[]`.
 *
 * ## What is asserted
 *
 * BEHAVIOUR on the real `resolveIntradayStatus`, with the healthy 5-day-overlap
 * re-run pinned so the guard cannot be "hardened" into failing every normal
 * night. Plus WIRING, because a verdict nobody calls is the defect.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../_support/repo-root";

import {
  resolveIntradayStatus,
  type IntradayTotals,
} from "../../src/processors/intraday-sync-logic";

const spaces = (s: string): string => s.replace(/[^\n]/g, " ");

function blankComments(src: string): string {
  return src
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p1: string) =>
      p1 === undefined ? spaces(m) : p1 + spaces(m.slice(p1.length)),
    )
    .replace(/\/\*[\s\S]*?\*\//g, (m) => spaces(m));
}

const RAW = readFileSync(
  join(repoRoot(), "workers", "src", "processors", "intraday-sync.ts"),
  "utf8",
);
const CODE = blankComments(RAW);

const ROUTE = blankComments(
  readFileSync(
    join(repoRoot(), "workers", "src", "routes", "intraday-sync.ts"),
    "utf8",
  ),
);

/** 500 symbols x 3 intervals, everything answered, bars written. */
const healthy: IntradayTotals = {
  symbols: 500,
  calls: 1500,
  unmapped: 0,
  // MONEY-1236 split `unmapped` into these two. The fixture was never updated
  // and nothing noticed, because `workers/__tests__` was outside every
  // tsconfig until MONEY-1326 — so the object silently stopped satisfying
  // `IntradayTotals` while every test kept passing.
  unmappedMissing: 0,
  unmappedUnfetchable: 0,
  fetchFailures: 0,
  fetched: 90_000,
  inserted: 12_000,
  skipped: 78_000,
  failed: 0,
};

describe("intraday-sync status (MONEY-1238)", () => {
  it("a clean run is COMPLETED with no reason", () => {
    assert.deepEqual(resolveIntradayStatus(healthy), {
      status: "COMPLETED",
      reason: null,
    });
  });

  it("THE CASE THAT MUST NOT FAIL: everything already stored", () => {
    // The daily job runs with a 5-day overlap ON PURPOSE, so most of what it
    // fetches is already in the table. `inserted === 0` with `skipped` high is
    // the normal shape of a second run, and a rule of `inserted === 0 → FAILED`
    // would fire on it nightly and be switched off within the week.
    assert.deepEqual(
      resolveIntradayStatus({ ...healthy, inserted: 0, skipped: 90_000 }),
      { status: "COMPLETED", reason: null },
    );
  });

  it("REGRESSION: 500 symbols, ZERO bars fetched is FAILED", () => {
    // The shape that used to close its row COMPLETED with
    // recordsProcessed 0 / recordsFailed 0.
    const v = resolveIntradayStatus({
      ...healthy,
      fetched: 0,
      inserted: 0,
      skipped: 0,
    });
    assert.equal(v.status, "FAILED");
    assert.match(v.reason ?? "", /ZERO bars/);
  });

  it("REGRESSION: an egress block is named as such, not as an empty market", () => {
    // `backfillIntradayBars` reports a fetch throw as `failed: 0`, so without
    // the worker-side `onError` counter this is indistinguishable from a
    // quiet night.
    const v = resolveIntradayStatus({
      ...healthy,
      fetchFailures: 1500,
      fetched: 0,
      inserted: 0,
      skipped: 0,
    });
    assert.equal(v.status, "FAILED");
    assert.match(v.reason ?? "", /egress-block/);
  });

  it("an instrument-MAPPING break is a different failure from a market one", () => {
    // Every call short-circuited before Yahoo because no tracked instrument has
    // a usable `yahooSymbol`. Reporting that as "Yahoo returned nothing" sends
    // an operator to the wrong system.
    const v = resolveIntradayStatus({
      ...healthy,
      unmapped: 1500,
      unmappedMissing: 1500,
      fetched: 0,
      inserted: 0,
      skipped: 0,
    });
    assert.equal(v.status, "FAILED");
    assert.match(v.reason ?? "", /yahooSymbol/);
    assert.match(v.reason ?? "", /instrument-mapping break/);
    // The COUNT, not just the prose. `resolveIntradayStatus` interpolates
    // `unmappedMissing` into the reason, and this fixture did not carry the
    // field — so the operator-facing string read "…, undefined because the
    // instrument has NO yahooSymbol at all…" and both matchers above still
    // passed. MONEY-1326.
    assert.match(v.reason ?? "", /1500 because/);
    assert.doesNotMatch(v.reason ?? "", /undefined/);
  });

  it("MONEY-1236: all-unfetchable is COMPLETED, not a standing false alarm", () => {
    // The branch that distinguishes "every tracked instrument is BSE-only and
    // has no intraday source" from "the mapping is broken". Both short-circuit
    // every call; only the second is a defect. This branch had NO test —
    // `IntradayTotals` gained the two fields that express it and the fixture
    // never did, so there was nothing to write a case against (MONEY-1326).
    const v = resolveIntradayStatus({
      ...healthy,
      unmapped: 1500,
      unmappedUnfetchable: 1500,
      fetched: 0,
      inserted: 0,
      skipped: 0,
    });
    assert.equal(v.status, "COMPLETED");
    assert.match(v.reason ?? "", /known-unfetchable/);
    assert.match(v.reason ?? "", /Nothing is broken/);
    // It must NOT be reported as a mapping break — that was the false alarm.
    assert.doesNotMatch(v.reason ?? "", /instrument-mapping break/);
  });

  it("nothing written WITH failures is FAILED", () => {
    // Bars came back and every upsert failed — a DB problem, distinct from
    // both zero-fetch shapes above.
    const v = resolveIntradayStatus({
      ...healthy,
      inserted: 0,
      skipped: 0,
      failed: 90_000,
    });
    assert.equal(v.status, "FAILED");
    assert.match(v.reason ?? "", /nothing was written/);
  });

  it("a PARTIAL run stays COMPLETED and says so", () => {
    const v = resolveIntradayStatus({
      ...healthy,
      failed: 12,
      fetchFailures: 4,
    });
    assert.equal(v.status, "COMPLETED");
    assert.match(v.reason ?? "", /^partial: /);
    assert.match(v.reason ?? "", /12 upsert failure/);
    assert.match(v.reason ?? "", /4 fetch failure/);
  });

  it("no tracked symbols is COMPLETED — but it SAYS so", () => {
    // Nobody holds, watches or paper-trades anything. Not a failure, and not a
    // bare COMPLETED either: an empty tracked set on prod is worth a look.
    const v = resolveIntradayStatus({
      symbols: 0,
      calls: 0,
      unmapped: 0,
      unmappedMissing: 0,
      unmappedUnfetchable: 0,
      fetchFailures: 0,
      fetched: 0,
      inserted: 0,
      skipped: 0,
      failed: 0,
    });
    assert.equal(v.status, "COMPLETED");
    assert.match(v.reason ?? "", /no tracked symbols/);
  });

  it("the empty-symbol-set case outranks the zero-fetch case", () => {
    // Ordering. With `symbols: 0` there are no calls to have failed, so
    // reporting "ZERO bars across 0 fetches" would be a fabricated alarm.
    assert.equal(
      resolveIntradayStatus({
        symbols: 0,
        calls: 0,
        unmapped: 0,
        unmappedMissing: 0,
        unmappedUnfetchable: 0,
        fetchFailures: 0,
        fetched: 0,
        inserted: 0,
        skipped: 0,
        failed: 0,
      }).status,
      "COMPLETED",
    );
  });
});

describe("intraday-sync: the verdict is WIRED (MONEY-1238)", () => {
  it("[meta] the source this file reasons over actually loaded", () => {
    assert.ok(
      RAW.length > 3000,
      `intraday-sync.ts did not load (${RAW.length}B)`,
    );
    assert.ok(CODE.includes("processIntradaySync"));
  });

  it("[meta] the stripper strips LINE before BLOCK", () => {
    const src = [
      "// a line comment mentioning /* an unterminated block",
      "const verdict = resolveIntradayStatus({",
      '/* a block mentioning status: "COMPLETED", inside */',
    ].join("\n");
    const out = blankComments(src);
    assert.equal(out.split("\n").length, src.split("\n").length);
    assert.ok(out.includes("resolveIntradayStatus({"));
    assert.ok(!/"COMPLETED"/.test(out));
  });

  it("REGRESSION: the literal COMPLETED is gone", () => {
    assert.doesNotMatch(
      CODE,
      /status: "COMPLETED"/,
      "the status must be computed from the counts sitting beside it",
    );
  });

  it("the computed verdict is the one persisted", () => {
    assert.match(CODE, /const verdict = resolveIntradayStatus\(\{/);
    assert.match(CODE, /status: verdict\.status,/);
  });

  it("the swallowed transport failures reach recordsFailed", () => {
    // Core reports a fetch throw as `failed: 0`, so `totals.failed` alone
    // understates the row.
    assert.match(
      CODE,
      /recordsFailed: totals\.failed \+ tally\.fetchFailures,/,
    );
  });

  it("both silent exits of the fetcher are counted", () => {
    assert.match(
      CODE,
      /tally\.unmapped\+\+;/,
      "the no-yahooSymbol short-circuit returns [] and must not look like " +
        "'this symbol had no bars'",
    );
    assert.match(
      CODE,
      /tally\.fetchFailures\+\+;/,
      "a swallowed Yahoo error must not look like 'this symbol had no bars'",
    );
    assert.match(
      CODE,
      /onError: \(error\) => \{/,
      "counting a swallowed error needs the observer core already exposes",
    );
  });

  it("the fetch tally is per-RUN, never module scope", () => {
    // A module-level counter on a warm Cloud Run container turns a per-run
    // number into a per-container one.
    // Shape-tolerant on the FIELDS (MONEY-1236 split `unmapped` by cause), but
    // strict on what actually matters: the tally is constructed with a `const`
    // INSIDE the run function, and every counter starts at zero.
    assert.match(
      CODE,
      /const tally: IntradayFetchTally = \{[\s\S]{0,240}?\};/,
      "the tally must be constructed per run",
    );
    const init = /const tally: IntradayFetchTally = \{([\s\S]{0,240}?)\};/.exec(
      CODE,
    );
    assert.ok(init, "tally initialiser not found");
    for (const field of [
      "unmapped",
      "unmappedMissing",
      "unmappedUnfetchable",
      "fetchFailures",
    ]) {
      assert.match(
        init[1]!,
        new RegExp(`${field}:\\s*0`),
        `${field} must start at 0 on every run`,
      );
    }
    assert.match(
      CODE,
      /function makeYahooIntradayFetcher\(tally: IntradayFetchTally\)/,
      "the fetcher must be built per run around that tally, not be a module " +
        "singleton",
    );
  });

  it("the CALL count is incremented where the call is made", () => {
    // `calls` is the denominator for every "everything failed" branch. Derived
    // as symbols x intervals it would drift the moment the loop gains a
    // continue; counted at the call site it cannot.
    assert.match(
      CODE,
      /calls\+\+;\n\s*const result = await backfillIntradayBars/,
    );
  });

  it("the run RETURNS its outcome instead of dropping it", () => {
    assert.match(CODE, /\): Promise<IntradaySyncResult> \{/);
    assert.match(CODE, /ok: verdict\.status === "COMPLETED",/);
  });
});

describe("intraday-sync route: loud, but deliberately not a NACK (MONEY-1238)", () => {
  it("the route OBSERVES the run outcome", () => {
    assert.match(ROUTE, /const result = await processIntradaySync\(data\);/);
    assert.match(ROUTE, /if \(!result\.ok\) \{/);
  });

  it("a FAILED run is loud in the log and in the body", () => {
    assert.match(
      ROUTE,
      /console\.error\(`\[intraday-sync\] run reported FAILED/,
    );
    assert.match(
      ROUTE,
      /return c\.json\(\{ success: false, retried: false, \.\.\.result \}, 200\);/,
    );
  });

  it("REGRESSION: a FAILED run must NOT 500", () => {
    // 500 symbols x 3 intervals with a 200 ms pause every 10 symbols. A NACK
    // asks for a second concurrent copy of a run that already strains the
    // 600 s ack deadline. The decider wired here is the sync-log row.
    assert.doesNotMatch(ROUTE, /\.\.\.result \}, 500\)/);
  });
});
