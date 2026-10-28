/**
 * UNIT TEST — price-sync's sync-log STATUS must come from real counts.
 * MONEY-1238, item 3.
 *
 * ## The defect
 *
 * The backfill branch closed its `marketDataSyncLog` row with a LITERAL:
 *
 *     data: { status: "COMPLETED", completedAt: new Date() }
 *
 * — no `recordsProcessed`, no `recordsFailed`, nothing read from the run.
 * `runHistoricalBackfill` returned `void`, so `totalInserted` and `totalErrors`
 * were summed, printed in one console line, and discarded at the function
 * boundary. A signal that cannot leave the function it is computed in cannot
 * reach anything that decides.
 *
 * ## And the counts it had would have lied anyway
 *
 * `yahooFetchChart` (packages/core/src/market-data/yahoo-api.ts:591) catches
 * EVERY transport error — 403, 429, timeout, DNS — and returns `[]`. It never
 * rejects, so the worker's `try/catch` around it was unreachable and
 * `backfillPrices` reported `{inserted: 0, errors: 0}`. A Yahoo egress block
 * printed
 *
 *     "Backfill complete: 0 prices inserted, 0 errors"
 *
 * beside a spotless COMPLETED row — field for field identical to a re-run of an
 * already-populated range, which is a genuinely healthy no-op.
 *
 * Same story on the quote branch, one level deeper: `refreshAllQuotes` has a
 * `failed += batch.length` inside a catch around `fetchQuotes(...)`, and
 * `yahooFetchQuotes` wraps its chunks in `Promise.allSettled` and returns a
 * partial Map rather than rejecting (yahoo-api.ts:498-521). That counter is
 * DEAD no matter what Yahoo does.
 *
 * The fix is the repo's standing rule — give "couldn't determine" its own
 * value. `YahooFetchErrorOpts.onError` already exists for exactly this, so the
 * worker counts what core swallows without changing core's never-throw
 * contract, and three states separate: transport-failed / answered-empty /
 * wrote-rows.
 *
 * ## What is asserted
 *
 * BEHAVIOUR on the real `resolveBackfillStatus` / `resolveQuoteRefreshStatus`,
 * with the healthy-no-op case pinned so the guard cannot be "fixed" into
 * failing every idempotent re-run. Plus WIRING: the totals leave the function,
 * the status is computed, and both fetchers pass an `onError`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../_support/repo-root";

import {
  resolveBackfillStatus,
  resolveQuoteRefreshStatus,
  type BackfillTotals,
} from "../../src/processors/price-sync-logic";

const spaces = (s: string): string => s.replace(/[^\n]/g, " ");

function blankComments(src: string): string {
  return src
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p1: string) =>
      p1 === undefined ? spaces(m) : p1 + spaces(m.slice(p1.length)),
    )
    .replace(/\/\*[\s\S]*?\*\//g, (m) => spaces(m));
}

const RAW = readFileSync(
  join(repoRoot(), "workers", "src", "processors", "price-sync.ts"),
  "utf8",
);
const CODE = blankComments(RAW);

const ROUTE = blankComments(
  readFileSync(
    join(repoRoot(), "workers", "src", "routes", "price-sync.ts"),
    "utf8",
  ),
);

/** 1,000 instruments, all answered, bars written. */
const healthy: BackfillTotals = {
  selected: 1000,
  attempted: 1000,
  inserted: 28_000,
  errors: 0,
  fetchFailures: 0,
  emptyResponses: 0,
};

describe("price-sync backfill status (MONEY-1238)", () => {
  it("a clean run is COMPLETED with no reason", () => {
    assert.deepEqual(resolveBackfillStatus(healthy), {
      status: "COMPLETED",
      reason: null,
    });
  });

  it("REGRESSION: a total Yahoo egress block is FAILED, not COMPLETED", () => {
    // The shape that used to print "0 prices inserted, 0 errors" beside a
    // spotless COMPLETED row. `errors` stays 0 because core swallows; the
    // signal is `fetchFailures`, which only exists because of `onError`.
    const v = resolveBackfillStatus({
      ...healthy,
      inserted: 0,
      fetchFailures: 1000,
    });
    assert.equal(v.status, "FAILED");
    assert.match(v.reason ?? "", /egress-block/);
  });

  it("REGRESSION: Yahoo answering 200-with-nothing for everything is FAILED", () => {
    // The second zero-shape. `fetchChart` warns and returns [] on a
    // `chart.error` envelope WITHOUT calling onError, so this case has
    // fetchFailures 0 and would otherwise be invisible.
    const v = resolveBackfillStatus({
      ...healthy,
      inserted: 0,
      emptyResponses: 1000,
    });
    assert.equal(v.status, "FAILED");
    assert.match(v.reason ?? "", /ZERO\s+bars/);
  });

  it("THE CASE THAT MUST NOT FAIL: a healthy idempotent re-run", () => {
    // Yahoo answered with bars, every bar was already stored, so `inserted` is
    // legitimately 0 with nothing broken. This is why the rule is NOT
    // `inserted === 0 → FAILED`: a guard that fires here would cry wolf on
    // every re-run of a historical range and get switched off.
    assert.deepEqual(resolveBackfillStatus({ ...healthy, inserted: 0 }), {
      status: "COMPLETED",
      reason: null,
    });
  });

  it("nothing written WITH something broken is FAILED", () => {
    const v = resolveBackfillStatus({
      ...healthy,
      inserted: 0,
      fetchFailures: 3,
    });
    assert.equal(v.status, "FAILED");
    assert.match(v.reason ?? "", /nothing was written/);

    const w = resolveBackfillStatus({ ...healthy, inserted: 0, errors: 7 });
    assert.equal(w.status, "FAILED");
    assert.match(w.reason ?? "", /7 upsert error/);
  });

  it("a PARTIAL run stays COMPLETED and says so", () => {
    // Some instruments failed, most landed. Retrying the whole ~10k sweep for
    // three symbols is not worth it; recording that it happened is.
    const v = resolveBackfillStatus({
      ...healthy,
      fetchFailures: 3,
      errors: 2,
    });
    assert.equal(v.status, "COMPLETED");
    assert.match(v.reason ?? "", /^partial: /);
    assert.match(v.reason ?? "", /3 fetch failure/);
    assert.match(v.reason ?? "", /2 upsert error/);
  });

  it("selecting instruments and fetching NONE of them is FAILED", () => {
    // Every selected instrument filtered out by `isUnfetchableYahooSymbol` or a
    // null yahooSymbol. Not a market condition — a mapping break — and the old
    // code reported it as a clean COMPLETED with no counts at all.
    const v = resolveBackfillStatus({
      ...healthy,
      attempted: 0,
      inserted: 0,
      selected: 1000,
    });
    assert.equal(v.status, "FAILED");
    assert.match(v.reason ?? "", /NONE was fetchable/);
  });

  it("selecting NOTHING is not a failure", () => {
    // An explicit instrumentIds list that resolved to no active rows. There is
    // no work and nothing broke.
    assert.deepEqual(
      resolveBackfillStatus({
        selected: 0,
        attempted: 0,
        inserted: 0,
        errors: 0,
        fetchFailures: 0,
        emptyResponses: 0,
      }),
      { status: "COMPLETED", reason: null },
    );
  });
});

describe("price-sync quote-refresh status (MONEY-1238)", () => {
  it("a clean refresh is COMPLETED with no reason", () => {
    assert.deepEqual(
      resolveQuoteRefreshStatus({
        refreshed: 9500,
        failed: 0,
        fetchFailures: 0,
      }),
      { status: "COMPLETED", reason: null },
    );
  });

  it("REGRESSION: zero refreshed is FAILED even with zero reported failures", () => {
    // The exact shape a Yahoo block produces: `refreshAllQuotes`'s
    // `failed += batch.length` never runs because `yahooFetchQuotes` does not
    // reject, so the row would have read COMPLETED / 0 / 0.
    //
    // Unlike the backfill, `refreshed === 0` IS decisive here: `latestQuote`
    // is upserted on every run, so a healthy refresh over a non-empty selection
    // always increments it. There is no idempotent no-op to protect.
    const v = resolveQuoteRefreshStatus({
      refreshed: 0,
      failed: 0,
      fetchFailures: 0,
    });
    assert.equal(v.status, "FAILED");
    assert.match(v.reason ?? "", /0 quotes refreshed/);
  });

  it("a partial refresh stays COMPLETED and reports both counters", () => {
    const v = resolveQuoteRefreshStatus({
      refreshed: 9000,
      failed: 4,
      fetchFailures: 2,
    });
    assert.equal(v.status, "COMPLETED");
    assert.match(v.reason ?? "", /^partial: 9000 refreshed/);
    assert.match(v.reason ?? "", /4 upsert failure/);
    assert.match(v.reason ?? "", /2 batch fetch failure/);
  });
});

describe("price-sync: the counts REACH the sync log (MONEY-1238)", () => {
  it("[meta] the source this file reasons over actually loaded", () => {
    assert.ok(RAW.length > 3000, `price-sync.ts did not load (${RAW.length}B)`);
    assert.ok(CODE.includes("processPriceSync"));
  });

  it("[meta] the stripper strips LINE before BLOCK", () => {
    const src = [
      "// a line comment mentioning /* an unterminated block",
      "const verdict = resolveBackfillStatus(totals);",
      '/* a block mentioning status: "COMPLETED", inside */',
    ].join("\n");
    const out = blankComments(src);
    assert.equal(out.split("\n").length, src.split("\n").length);
    assert.ok(out.includes("resolveBackfillStatus(totals)"));
    assert.ok(!/"COMPLETED"/.test(out));
  });

  it("REGRESSION: no literal COMPLETED survives on a success path", () => {
    // The whole defect in one line. The only remaining literal status in this
    // file is the "RUNNING" seed and the "FAILED" written from the catch.
    assert.doesNotMatch(
      CODE,
      /status: "COMPLETED"/,
      "the sync-log status must be computed from the run's counts",
    );
  });

  it("runHistoricalBackfill RETURNS its totals", () => {
    assert.match(
      CODE,
      /\): Promise<BackfillTotals> \{/,
      "the backfill used to return void, so its two counters died at the " +
        "function boundary",
    );
  });

  it("both branches compute a verdict and write it", () => {
    assert.match(CODE, /verdict = resolveBackfillStatus\(totals\);/);
    assert.match(CODE, /verdict = resolveQuoteRefreshStatus\(\{/);
    assert.match(
      CODE,
      /status: verdict\.status,/,
      "the computed status must be the one persisted",
    );
  });

  it("the sync-log row carries BOTH count columns", () => {
    assert.match(CODE, /recordsProcessed,\n\s*recordsFailed,/);
  });

  it("the swallowed transport failures are added to recordsFailed", () => {
    // `result.failed` / `totals.errors` cannot see a transport outage — the
    // counters in core that would are unreachable — so the observed failures
    // must be ADDED, not assumed to already be in there.
    assert.match(
      CODE,
      /recordsFailed = totals\.errors \+ totals\.fetchFailures;/,
    );
    assert.match(
      CODE,
      /recordsFailed = result\.failed \+ tally\.fetchFailures;/,
    );
  });

  it("both Yahoo fetchers install an onError counter", () => {
    // Without these the whole `fetchFailures` dimension is permanently 0 and
    // every assertion above about a Yahoo block is unreachable in production.
    const onErrors = CODE.match(/onError: \(error\) => \{/g) ?? [];
    assert.equal(
      onErrors.length,
      2,
      `expected an onError on both the chart and the quote fetcher, found ` +
        `${onErrors.length}`,
    );
    // THREE increments, not two — MONEY-1236. The two `onError` observers plus
    // the per-quote `transformRawQuote` catch. That third one restores coverage
    // an earlier revision dropped: removing the try/catch around the FETCH was
    // right (`yahooFetchQuotes` reports via `onError` and never rejects), but it
    // left the normalisation loop uncovered, so one malformed quote escaped
    // `refreshAllQuotes` and marked the entire sync log FAILED instead of
    // degrading to a partial map.
    const bumps = CODE.match(/tally\.fetchFailures\+\+;/g) ?? [];
    assert.equal(
      bumps.length,
      3,
      `two onError observers plus the transform guard; found ${bumps.length}`,
    );
    assert.match(
      CODE,
      /try \{\s*results\.set\(symbol, transformRawQuote\(symbol, quote\)\);/,
      "the transform must be guarded PER QUOTE, so one bad payload costs one symbol",
    );
  });

  it("REGRESSION: the unreachable try/catch around the chart fetch is gone", () => {
    // It could never fire — `yahooFetchChart` does not reject — and leaving it
    // there is what made the swallow look handled.
    assert.doesNotMatch(
      CODE,
      /Failed to fetch historical data for \$\{yahooSymbol\}:`,\s*error,\s*\);\s*return \[\];/,
    );
  });

  it("the error tally is per-RUN, never module scope", () => {
    // A module-level counter on a warm Cloud Run container turns a per-run
    // number into a per-container one — the lifetime bug this repo already paid
    // for with the stock-document-sync API budget.
    assert.match(
      CODE,
      /const tally: YahooErrorTally = \{ fetchFailures: 0 \};/,
    );
    assert.doesNotMatch(CODE, /^let fetchFailures/m);
  });

  it("the empty-response counter distinguishes itself from a fetch failure", () => {
    // Three states need three counters. An empty answer is only `empty` when
    // the transport did NOT fail on that same call, which is what the
    // before/after comparison encodes.
    assert.match(
      CODE,
      /if \(bars\.length === 0 && tally\.fetchFailures === failuresBefore\) \{/,
    );
  });
});

describe("price-sync route: loud, but deliberately not a NACK (MONEY-1238)", () => {
  it("the route OBSERVES the run outcome", () => {
    assert.match(ROUTE, /const result = await processPriceSync\(data\);/);
    assert.match(ROUTE, /if \(!result\.ok\) \{/);
  });

  it("a FAILED run is loud in the log and in the body", () => {
    assert.match(ROUTE, /console\.error\(`\[price-sync\] run reported FAILED/);
    assert.match(
      ROUTE,
      /return c\.json\(\{ success: false, retried: false, \.\.\.result \}, 200\);/,
    );
  });

  it("REGRESSION: a FAILED run must NOT 500", () => {
    // Deliberate, and the reasoning must not be silently discarded:
    // `price-backfill-incremental-daily` walks ~10k instruments with a 500 ms
    // pause every 10, which is already past Pub/Sub's 600 s MAXIMUM ack
    // deadline. NACKing on purpose starts a SECOND concurrent copy of a run
    // that is still going. The decider wired here is the sync-log row.
    assert.doesNotMatch(ROUTE, /\.\.\.result \}, 500\)/);
  });
});
