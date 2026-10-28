/**
 * The XBRL re-parse job must ADVANCE, must not lie about a dry run, and must
 * not paint a known gap red — MONEY-1252.
 *
 * ## What this file exists to stop
 *
 * `scripts/jobs/xbrl-reparse.ts` pages 96,056 stored filings, reads each one's
 * archived XML out of GCS, and rewrites it with the CURRENT parser so
 * MONEY-1250's `bankBalanceOther` / `currentInvestments` reach rows that were
 * parsed before those concepts existed. Three ways that goes silently wrong:
 *
 *  1. **The page does not advance.** MONEY-1211: a batch ordered by a column
 *     constant across the population hands every run the same first N rows
 *     forever — written once, skipped nightly, and the rest never selected. No
 *     error, no alert, no data (681 of 781 symbols). Here the cursor is a Mongo
 *     ObjectId, which cannot be constant — but that is a claim about a query
 *     somebody can change, so the loop MEASURES the advance and this file
 *     proves the measurement stops a pager that repeats itself.
 *
 *  2. **The dry run reports rows it did not write.** The rehearsal deliberately
 *     runs the REAL write path against a no-op upsert, so `storeFiling` returns
 *     "written" for every row. Putting that number on `stockbook.job.written`
 *     would be the exact silent-success shape `reportJobOutcome` exists to
 *     make impossible.
 *
 *  3. **A permanent known gap fails the run.** ~2.1% of stored rows have no
 *     archived object and this job never fetches, by design. A red task for a
 *     condition no re-run can clear is how people stop reading task status.
 *
 * ## Why the tests are here and not against the job file
 *
 * `xbrl-reparse.ts` calls `main()` at module top level — the Cloud Run
 * entry-point convention shared with `xbrl-backfill.ts` and
 * `xbrl-projection-drain.ts`. Importing it would run the job against a real
 * database and a real bucket. The decisions therefore live in
 * `xbrl-reparse-logic.mts`, which imports nothing at runtime, and the loop takes
 * its pager, its row worker and its clock as dependencies — so all four stop
 * reasons are reachable in milliseconds instead of only after hours against a
 * 96,000-row table.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseReparseArgs,
  resolveReparseApply,
  periodYearWindow,
  isUsableArchivedXml,
  decideAfterPage,
  runReparseLoop,
  accumulateRow,
  emptyReparseTotals,
  reparseFailedCount,
  reparseJobOutcome,
  describeReparseOutcome,
  describeReparseRow,
  describeReparseStop,
  reparseExitCode,
  DEFAULT_PAGE,
  MAX_PAGE,
  DEFAULT_BUDGET_MS,
  MIN_PERIOD_YEAR,
  type ReparseLoopState,
  type PageProgress,
  type ReparseOutcomeSummary,
  type ReparseRowResult,
  type ReparseTotals,
} from "../../../scripts/jobs/xbrl-reparse-logic.mjs";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

describe("parseReparseArgs — defaults are on the safe side", () => {
  it("with no arguments: no write, no scope floor, no limit", () => {
    const { args, errors } = parseReparseArgs([]);
    assert.deepEqual(errors, []);
    assert.equal(args.apply, false);
    assert.equal(args.dryRun, false);
    // UNDEFINED, not a year. A hard-coded floor would silently exclude rows
    // below it and the run would still report DRAINED.
    assert.equal(args.fromYear, undefined);
    assert.equal(args.toYear, undefined);
    assert.equal(args.symbols, undefined);
    assert.equal(args.afterId, undefined);
    assert.equal(args.limit, 0);
    assert.equal(args.page, DEFAULT_PAGE);
    assert.equal(args.budgetMs, DEFAULT_BUDGET_MS);
  });

  it("an unknown flag is FATAL, not ignored", () => {
    // `--aply` must not parse as "no flags given". That would run a rehearsal,
    // exit 0, and look exactly like a successful apply.
    const { errors } = parseReparseArgs(["--aply"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /unknown argument "--aply"/);
  });

  it("an unknown VALUE flag is fatal too", () => {
    const { errors } = parseReparseArgs(["--from-year=2024"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /unknown argument/);
  });

  it("--from=YYYY-MM is REJECTED, naming the sibling it is not", () => {
    // xbrl-backfill.ts takes --from=2024-05 (a BROADCAST month). Same flag
    // name, different axis. Silently reading 2024 out of it, or NaN, would
    // scope the run to something nobody asked for.
    const { errors } = parseReparseArgs(["--from=2024-05"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /four-digit year/);
    assert.match(errors[0]!, /BROADCAST MONTH/);
  });

  it("a year outside the sanity range is rejected", () => {
    const { errors } = parseReparseArgs([`--from=${MIN_PERIOD_YEAR - 1}`]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /is outside/);
  });

  it("an inverted --from/--to range is rejected, not silently emptied", () => {
    const { errors } = parseReparseArgs(["--from=2025", "--to=2024"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /selects nothing/);
  });

  it("--after-id must be a 24-char hex ObjectId", () => {
    const bad = parseReparseArgs(["--after-id=not-an-objectid"]);
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0]!, /24-character hex ObjectId/);
    // Reason it is validated at all: a malformed cursor selects nothing, and
    // "selected 0" is this job's own vocabulary for "already done".
    assert.match(bad.errors[0]!, /reads as "already done"/);

    const good = parseReparseArgs(["--after-id=6A8602E00051C49DD1295298"]);
    assert.deepEqual(good.errors, []);
    assert.equal(good.args.afterId, "6a8602e00051c49dd1295298");
  });

  it("--page above the maximum is rejected", () => {
    const { errors } = parseReparseArgs([`--page=${MAX_PAGE + 1}`]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /exceeds the maximum/);
  });

  it("--limit=0 means no cap; a negative limit is an error", () => {
    assert.deepEqual(parseReparseArgs(["--limit=0"]).errors, []);
    assert.equal(parseReparseArgs(["--limit=0"]).args.limit, 0);
    assert.equal(parseReparseArgs(["--limit=-1"]).errors.length, 1);
  });

  it("--symbols is upper-cased and trimmed; an EMPTY filter is an error", () => {
    const ok = parseReparseArgs(["--symbols= reliance , tcs "]);
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.args.symbols, ["RELIANCE", "TCS"]);

    // `--symbols=,,` parses to zero symbols. That is `symbol: { in: [] }`,
    // which matches nothing — the opposite of "every symbol", and it would be
    // reported as a completed shard.
    const empty = parseReparseArgs(["--symbols=,,"]);
    assert.equal(empty.errors.length, 1);
    assert.match(empty.errors[0]!, /not "every symbol"/);
  });

  it("--budget-sec is held as milliseconds", () => {
    assert.equal(parseReparseArgs(["--budget-sec=90"]).args.budgetMs, 90_000);
  });
});

describe("resolveReparseApply — --dry-run WINS", () => {
  it("--apply alone writes", () => {
    assert.equal(resolveReparseApply(parseReparseArgs(["--apply"]).args), true);
  });

  it("no flags does not write", () => {
    assert.equal(resolveReparseApply(parseReparseArgs([]).args), false);
  });

  it("--apply AND --dry-run does NOT write", () => {
    // `run-market-data-job.sh` appends --dry-run unless the operator passed
    // --apply, so the two arriving together means somebody asked for both. The
    // answer to an ambiguous instruction about a 96,000-row rewrite is the one
    // that writes nothing.
    const { args } = parseReparseArgs(["--apply", "--dry-run"]);
    assert.equal(resolveReparseApply(args), false);
  });
});

describe("periodYearWindow — an absent bound is ABSENT, never a sentinel", () => {
  it("neither bound -> undefined, so the caller omits periodEnd entirely", () => {
    assert.equal(periodYearWindow(undefined, undefined), undefined);
  });

  it("only --from -> a gte with NO lte", () => {
    const w = periodYearWindow(2024, undefined);
    assert.ok(w);
    assert.equal(w.gte?.toISOString(), "2024-01-01T00:00:00.000Z");
    assert.equal(w.lte, undefined);
  });

  it("only --to -> an lte with NO gte", () => {
    const w = periodYearWindow(undefined, 2024);
    assert.ok(w);
    assert.equal(w.gte, undefined);
    assert.equal(w.lte?.toISOString(), "2024-12-31T23:59:59.999Z");
  });

  it("both bounds are INCLUSIVE of the whole years", () => {
    const w = periodYearWindow(2019, 2019);
    assert.ok(w?.gte && w.lte);
    // A real prod row: periodEnd is stored at UTC midnight, so a 31-Dec period
    // must fall INSIDE the window, not one millisecond past it.
    const dec31 = new Date("2019-12-31T00:00:00.000Z");
    assert.ok(w.gte.getTime() <= dec31.getTime());
    assert.ok(w.lte.getTime() >= dec31.getTime());
    // …and the first day of the year too.
    assert.ok(w.gte.getTime() <= Date.parse("2019-01-01T00:00:00.000Z"));
  });
});

describe("isUsableArchivedXml — an HTML page must not read as a parse failure", () => {
  it("a real XBRL instance is usable", () => {
    assert.equal(isUsableArchivedXml('<?xml version="1.0"?><in:xbrl/>'), true);
  });

  it("a bare root element is usable", () => {
    assert.equal(isUsableArchivedXml("<in:xbrl></in:xbrl>"), true);
  });

  it("a DOCTYPE (an HTML challenge page) is NOT", () => {
    // It would parse as `not-xbrl` -> `unparseable`, which sends the next
    // investigation to the concept table when the fault is in the archive.
    assert.equal(isUsableArchivedXml("<!DOCTYPE html><html>…"), false);
    assert.equal(isUsableArchivedXml("  \n <!-- blocked -->"), false);
  });

  it("empty or whitespace-only bytes are NOT", () => {
    assert.equal(isUsableArchivedXml(""), false);
    assert.equal(isUsableArchivedXml("   \n\t "), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Termination                                                                 */
/* -------------------------------------------------------------------------- */

function state(over: Partial<ReparseLoopState> = {}): ReparseLoopState {
  return { selected: 1, limit: 0, elapsedMs: 0, budgetMs: 60_000, ...over };
}
function progress(over: Partial<PageProgress> = {}): PageProgress {
  return { rowsRead: 10, cursorBefore: "aaa", cursorAfter: "bbb", ...over };
}

describe("decideAfterPage — the loop provably terminates", () => {
  it("a normal page continues", () => {
    assert.equal(decideAfterPage(state(), progress()), null);
  });

  it("an empty page is DRAINED, and outranks a blown budget", () => {
    // Success outranks a simultaneous cap: reporting PARTIAL over finished work
    // sends someone back to re-run a completed shard.
    assert.equal(
      decideAfterPage(
        state({ elapsedMs: 999_999, budgetMs: 1 }),
        progress({ rowsRead: 0, cursorAfter: undefined }),
      ),
      "drained",
    );
  });

  it("a REPEATED cursor is NO-ADVANCE, not a spin", () => {
    // MONEY-1211 in one assertion: the page returned rows and the cursor did
    // not move, so the next page is this page.
    assert.equal(
      decideAfterPage(
        state(),
        progress({ cursorBefore: "bbb", cursorAfter: "bbb" }),
      ),
      "no-advance",
    );
  });

  it("a BACKWARDS cursor is NO-ADVANCE", () => {
    assert.equal(
      decideAfterPage(
        state(),
        progress({ cursorBefore: "ccc", cursorAfter: "bbb" }),
      ),
      "no-advance",
    );
  });

  it("rows with no cursor at all is NO-ADVANCE", () => {
    assert.equal(
      decideAfterPage(state(), progress({ cursorAfter: undefined })),
      "no-advance",
    );
  });

  it("NO-ADVANCE outranks both caps — it is a defect, not 'come back later'", () => {
    assert.equal(
      decideAfterPage(
        state({ selected: 500, limit: 10, elapsedMs: 999_999, budgetMs: 1 }),
        progress({ cursorBefore: "bbb", cursorAfter: "bbb" }),
      ),
      "no-advance",
    );
  });

  it("--limit stops the run", () => {
    assert.equal(
      decideAfterPage(state({ selected: 10, limit: 10 }), progress()),
      "limit",
    );
  });

  it("limit=0 means NO cap and never stops the run", () => {
    assert.equal(
      decideAfterPage(state({ selected: 999_999, limit: 0 }), progress()),
      null,
    );
  });

  it("the wall-clock budget stops the run", () => {
    assert.equal(
      decideAfterPage(
        state({ elapsedMs: 60_000, budgetMs: 60_000 }),
        progress(),
      ),
      "budget",
    );
  });
});

/** A fake table of `n` rows with strictly increasing ObjectId-shaped ids. */
function fakeRows(n: number): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `6a8602e00051c49dd12${String(i).padStart(5, "0")}`,
  }));
}

/** A pager over a fake table. Keyset on id, exactly like the real query. */
function fakePager(rows: { id: string }[]) {
  const calls: { cursor: string | undefined; take: number }[] = [];
  return {
    calls,
    fetchPage: async (cursor: string | undefined, take: number) => {
      calls.push({ cursor, take });
      const start = cursor ? rows.findIndex((r) => r.id > cursor) : 0;
      if (start === -1) return [];
      return rows.slice(start, start + take);
    },
  };
}

const parsedOk: ReparseRowResult = {
  kind: "parsed",
  bucket: "financials",
  refusal: null,
  annual: "none",
  projectionReset: true,
};

describe("runReparseLoop — every row exactly once, then STOP", () => {
  it("drains a finite table, visiting each row once in id order", async () => {
    const rows = fakeRows(25);
    const pager = fakePager(rows);
    const seen: string[] = [];
    const out = await runReparseLoop(
      { apply: true, limit: 0, page: 10, budgetMs: 1_000_000 },
      {
        fetchPage: pager.fetchPage,
        processRow: async (row) => {
          seen.push(row.id);
          return parsedOk;
        },
        now: () => 0,
      },
    );
    assert.equal(out.stop, "drained");
    assert.deepEqual(
      seen,
      rows.map((r) => r.id),
    );
    assert.equal(out.totals.selected, 25);
    assert.equal(out.totals.lastId, rows[24]!.id);
  });

  it("STOPS a pager that returns the SAME page forever", async () => {
    // The MONEY-1211 shape, made terminal. Without the cursor check this loop
    // runs until the 24 h task timeout, rewriting one page over and over while
    // every counter looks healthy.
    let calls = 0;
    const out = await runReparseLoop(
      { apply: true, limit: 0, page: 3, budgetMs: 1_000_000 },
      {
        fetchPage: async () => {
          calls++;
          return fakeRows(3);
        },
        processRow: async () => parsedOk,
        now: () => 0,
      },
    );
    assert.equal(out.stop, "no-advance");
    // Two pages: the first establishes the cursor, the second repeats it. A
    // third call would already be a spin.
    assert.equal(calls, 2);
  });

  it("never over-reads past --limit", async () => {
    // A row fetched and not processed is a row the resume cursor would SKIP.
    const pager = fakePager(fakeRows(100));
    const out = await runReparseLoop(
      { apply: true, limit: 7, page: 10, budgetMs: 1_000_000 },
      {
        fetchPage: pager.fetchPage,
        processRow: async () => parsedOk,
        now: () => 0,
      },
    );
    assert.equal(out.stop, "limit");
    assert.equal(out.totals.selected, 7);
    assert.deepEqual(
      pager.calls.map((c) => c.take),
      [7],
    );
  });

  it("stops on the budget and leaves a usable resume cursor", async () => {
    const rows = fakeRows(50);
    const pager = fakePager(rows);
    // The first read is `startedAt`; every read after it is past the budget, so
    // the run must stop after page 1 rather than paging on.
    let reads = 0;
    const out = await runReparseLoop(
      { apply: true, limit: 0, page: 10, budgetMs: 100 },
      {
        fetchPage: pager.fetchPage,
        processRow: async () => parsedOk,
        now: () => (reads++ === 0 ? 0 : 200),
      },
    );
    assert.equal(out.stop, "budget");
    assert.equal(out.totals.selected, 10);
    assert.equal(out.totals.lastId, rows[9]!.id);
    // Resuming from it must pick up row 11, never re-read row 10.
    const resumed = await pager.fetchPage(out.totals.lastId ?? undefined, 5);
    assert.equal(resumed[0]!.id, rows[10]!.id);
  });

  it("honours a start cursor on the FIRST page", async () => {
    const rows = fakeRows(20);
    const pager = fakePager(rows);
    const seen: string[] = [];
    await runReparseLoop(
      { apply: true, limit: 0, page: 100, budgetMs: 1_000_000 },
      {
        fetchPage: pager.fetchPage,
        processRow: async (row) => {
          seen.push(row.id);
          return parsedOk;
        },
        now: () => 0,
      },
      rows[14]!.id,
    );
    assert.equal(pager.calls[0]!.cursor, rows[14]!.id);
    assert.deepEqual(
      seen,
      rows.slice(15).map((r) => r.id),
    );
  });

  it("an empty table drains immediately with selected 0", async () => {
    // `selected === 0` is the ONLY thing that may mean "there was nothing to
    // do" — the whole zero-write monitor rests on it.
    const out = await runReparseLoop(
      { apply: true, limit: 0, page: 10, budgetMs: 1_000_000 },
      {
        fetchPage: async () => [],
        processRow: async () => parsedOk,
        now: () => 0,
      },
    );
    assert.equal(out.stop, "drained");
    assert.equal(out.totals.selected, 0);
    assert.equal(out.totals.lastId, null);
  });

  it("a page size of 0 does NOT masquerade as 'limit reached'", async () => {
    // A mislabelled stop reports a PARTIAL run over untouched work and names
    // the wrong cause; the clamp makes it read one row and drain honestly.
    const pager = fakePager(fakeRows(2));
    const out = await runReparseLoop(
      { apply: true, limit: 0, page: 0, budgetMs: 1_000_000 },
      {
        fetchPage: pager.fetchPage,
        processRow: async () => parsedOk,
        now: () => 0,
      },
    );
    assert.equal(out.stop, "drained");
    assert.equal(out.totals.selected, 2);
  });
});

/* -------------------------------------------------------------------------- */
/* Counters                                                                    */
/* -------------------------------------------------------------------------- */

function totalsFrom(results: ReparseRowResult[]): ReparseTotals {
  const t = emptyReparseTotals();
  for (const r of results) accumulateRow(t, r);
  return t;
}

describe("accumulateRow — every refusal in its own bucket", () => {
  it("an archive miss is counted, and is NOT a parse or a store failure", () => {
    const t = totalsFrom([{ kind: "archive-missing" }]);
    assert.equal(t.selected, 1);
    assert.equal(t.archiveMissing, 1);
    assert.deepEqual(t.buckets, {});
    assert.deepEqual(t.refusals, {});
    assert.equal(t.stored, 0);
  });

  it("a read failure is separate from a miss — one is not evidence of the other", () => {
    const t = totalsFrom([{ kind: "archive-read-failed" }]);
    assert.equal(t.archiveReadFailed, 1);
    assert.equal(t.archiveMissing, 0);
  });

  it("a stored row counts as stored, and its projection clear is counted", () => {
    const t = totalsFrom([
      parsedOk,
      { ...parsedOk, projectionReset: false },
      { ...parsedOk, annual: "written" },
    ]);
    assert.equal(t.stored, 3);
    assert.equal(t.storedAnnual, 1);
    assert.equal(t.projectionReset, 2);
    assert.equal(t.buckets["financials"], 3);
  });

  it("a store REFUSAL is not a stored row", () => {
    const t = totalsFrom([
      {
        kind: "parsed",
        bucket: "financials",
        refusal: "unclassified",
        annual: "none",
        projectionReset: false,
      },
    ]);
    assert.equal(t.stored, 0);
    assert.equal(t.refusals["unclassified"], 1);
    assert.equal(t.buckets["financials"], 1);
  });

  it("a non-financials document lands in its own bucket and stores nothing", () => {
    const t = totalsFrom([
      {
        kind: "parsed",
        bucket: "nonFinancial",
        refusal: null,
        annual: "none",
        projectionReset: false,
      },
    ]);
    assert.equal(t.stored, 0);
    assert.equal(t.buckets["nonFinancial"], 1);
  });
});

describe("reparseFailedCount — no permanent floor under the numerator", () => {
  it("EXCLUDES the three known, un-actionable populations", () => {
    // ~2.1% of rows have no archived object and this job never fetches;
    // governance filings carry no financials by design; an unmapped family is a
    // recorded decision. Any of them in `failed` makes the real ones
    // unreadable — the mistake bucketForOutcome already avoids.
    const t = totalsFrom([
      { kind: "archive-missing" },
      { kind: "archive-missing" },
      {
        kind: "parsed",
        bucket: "nonFinancial",
        refusal: null,
        annual: "none",
        projectionReset: false,
      },
      {
        kind: "parsed",
        bucket: "unmappedFamily",
        refusal: null,
        annual: "none",
        projectionReset: false,
      },
    ]);
    assert.equal(reparseFailedCount(t), 0);
  });

  it("INCLUDES the failures a person can act on", () => {
    const t = totalsFrom([
      { kind: "archive-unusable" },
      {
        kind: "parsed",
        bucket: "unparseable",
        refusal: null,
        annual: "none",
        projectionReset: false,
      },
      {
        kind: "parsed",
        bucket: "unknownTaxonomy",
        refusal: null,
        annual: "none",
        projectionReset: false,
      },
      {
        kind: "parsed",
        bucket: "noPeriod",
        refusal: null,
        annual: "none",
        projectionReset: false,
      },
      {
        kind: "parsed",
        bucket: "financials",
        refusal: "no-symbol",
        annual: "none",
        projectionReset: false,
      },
      {
        kind: "parsed",
        bucket: "financials",
        refusal: null,
        annual: "unreadable",
        projectionReset: false,
      },
      {
        kind: "parsed",
        bucket: "financials",
        refusal: null,
        annual: "ambiguous",
        projectionReset: false,
      },
    ]);
    assert.equal(reparseFailedCount(t), 7);
  });

  it("a storage READ error is not in `failed` — it is not a row that failed to persist", () => {
    const t = totalsFrom([{ kind: "archive-read-failed" }]);
    assert.equal(reparseFailedCount(t), 0);
    assert.equal(t.archiveReadFailed, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* The job-outcome contract                                                    */
/* -------------------------------------------------------------------------- */

function summary(
  over: Partial<ReparseOutcomeSummary> & { totals?: ReparseTotals } = {},
): ReparseOutcomeSummary {
  return {
    stop: "drained",
    apply: true,
    totals: emptyReparseTotals(),
    pages: 1,
    elapsedMs: 1000,
    ...over,
  };
}

describe("reparseJobOutcome — MONEY-1250's contract", () => {
  it("an APPLY run reports primary + annual rows as written", () => {
    const totals = totalsFrom([parsedOk, { ...parsedOk, annual: "written" }]);
    const o = reparseJobOutcome(summary({ apply: true, totals }));
    assert.equal(o.job, "xbrl-reparse");
    assert.equal(o.selected, 2);
    assert.equal(o.written, 3); // 2 primary + 1 annual
  });

  it("a DRY RUN reports written 0 even though the write path said 'written'", () => {
    // The rehearsal runs the REAL storeFiling against a no-op upsert, so it
    // KNOWS how many rows it would persist. Emitting that on
    // `stockbook.job.written` for a run that wrote nothing is the precise lie
    // this module exists to make impossible.
    const totals = totalsFrom([parsedOk, { ...parsedOk, annual: "written" }]);
    const o = reparseJobOutcome(summary({ apply: false, totals }));
    assert.equal(o.written, 0);
    assert.equal(o.selected, 2);
    // The would-have number survives, as a PLAN rather than a measurement.
    assert.match(o.skippedReason, /^DRY RUN/);
    assert.match(o.skippedReason, /3 row\(s\) would have been/);
  });

  it("selected is ZERO exactly when the run took nothing on", () => {
    const o = reparseJobOutcome(summary({ totals: emptyReparseTotals() }));
    assert.equal(o.selected, 0);
    assert.equal(o.written, 0);
  });

  it("a storage outage lands in transportFailures, NOT in failed", () => {
    const totals = totalsFrom([
      { kind: "archive-read-failed" },
      { kind: "archive-read-failed" },
    ]);
    const o = reparseJobOutcome(summary({ totals }));
    assert.equal(o.transportFailures, 2);
    assert.equal(o.failed, 0);
  });

  it("the reason string carries the resume cursor", () => {
    const totals = totalsFrom([parsedOk]);
    totals.lastId = "6a8602e00051c49dd1295298";
    const o = reparseJobOutcome(summary({ stop: "budget", totals }));
    assert.match(o.skippedReason, /lastId=6a8602e00051c49dd1295298/);
  });
});

describe("the wrapper must FORWARD the job's opt-in literal", () => {
  // MONEY-1252. Two opposite contracts share one wrapper flag:
  //
  //   xbrl-backfill.ts   DEFAULTS TO APPLYING, `--dry-run` opts out
  //   xbrl-reparse.ts    DEFAULTS TO A DRY RUN, `--apply` opts in
  //
  // `run-market-data-job.sh` consumes `--apply` and forwards nothing, which is
  // correct for the first and silently wrong for the second. A `--apply` run
  // reached this job as NEITHER flag, so it did what its own default says: read
  // 41,924 rows, report 24,165 as changed, write nothing, over 54 minutes. It
  // fails SAFE, which is exactly why nobody would notice.
  //
  // Asserted on the SCRIPT because that is where the mismatch lives — no unit
  // test of either side alone can see a contract that spans the two.
  const wrapper = readFileSync(
    join(import.meta.dirname, "../../../scripts/ops/run-market-data-job.sh"),
    "utf8",
  );
  const job = readFileSync(
    join(import.meta.dirname, "../../../scripts/jobs/xbrl-reparse.ts"),
    "utf8",
  );

  it("xbrl-reparse declares APPLY_FLAG, because its default is a dry run", () => {
    // The premise, checked rather than assumed: if the job ever flips to
    // apply-by-default, this assertion should be revisited, not silently kept.
    assert.match(
      job,
      /--apply/,
      "the job no longer mentions --apply — has its contract changed?",
    );
    const row = /xbrlreparse\)[^\n]*/.exec(wrapper);
    assert.ok(row, "no xbrlreparse row in run-market-data-job.sh");
    assert.match(
      row[0],
      /APPLY_FLAG="--apply"/,
      "xbrlreparse must declare APPLY_FLAG or an --apply run writes NOTHING",
    );
  });

  it("the wrapper actually forwards APPLY_FLAG when applying", () => {
    // Declaring it is not enough — the forwarding branch has to exist and sit
    // on the applying side, not the dry-run side.
    assert.match(
      wrapper,
      /if \[ -n "\$APPLY_FLAG" \]; then[\s\S]{0,200}job_args\+=\("\$APPLY_FLAG"\)/,
      "APPLY_FLAG is declared but never appended to the job args",
    );
  });

  it("xbrl-backfill does NOT declare one — its default is already apply", () => {
    // The other half of the contract. Forwarding --apply to a job that does not
    // accept it is an argument error, not a no-op.
    const row = /^\s+xbrl\)[^\n]*/m.exec(wrapper);
    assert.ok(row, "no xbrl row in run-market-data-job.sh");
    assert.doesNotMatch(
      row[0],
      /APPLY_FLAG=/,
      "xbrl-backfill applies by default; forwarding --apply would be an error",
    );
  });
});

describe("reparseExitCode — red means ACTIONABLE", () => {
  it("a clean drained run is 0", () => {
    assert.equal(
      reparseExitCode(summary({ totals: totalsFrom([parsedOk]) })),
      0,
    );
  });

  it("the known 2.1% archive gap stays 0 — no re-run can clear it", () => {
    // A red task for a permanent, known, un-actionable condition is how people
    // stop reading task status. The WARN names the remedy instead.
    //
    // THE FIXTURE IS THE POINT. This case is 2,044 missing ALONGSIDE the 94,012
    // that parsed — the measured shape of the real gap. It used to be 2,044
    // missing and NOTHING else, which is not the 2.1% condition at all: a run
    // where every single row missed is what a wrong GCP_STORAGE_BUCKET, a moved
    // prefix or a revoked read grant look like. The old fixture asserted that
    // the broken-archive case exits 0.
    const totals = totalsFrom([
      ...Array.from(
        { length: 2044 },
        () => ({ kind: "archive-missing" }) as const,
      ),
      ...Array.from({ length: 200 }, () => parsedOk),
    ]);
    assert.equal(reparseExitCode(summary({ totals })), 0);
  });

  it("EVERY row missing is 1 — that is a broken archive, not a data gap", () => {
    // The fail-open this closes: `stop === "drained"`, zero failures, zero read
    // errors, and not one object readable — the run reports success having done
    // nothing. Same class as the F3 gate's Prisma select, where a zero meaning
    // "we never asked" was indistinguishable from "there is nothing there".
    //
    // The ceiling is ALL-OF-A-NON-EMPTY-SCOPE, not a percentage, because the
    // known gap is not uniform — 100% archived for 2017-2025, ~70% for 2026 —
    // so any percentage either false-fails a 2026-scoped run or sits too high
    // to catch anything. "Not one of N was readable" cannot be a property of
    // the data.
    const totals = totalsFrom(
      Array.from(
        { length: 2044 },
        () => ({ kind: "archive-missing" }) as const,
      ),
    );
    assert.equal(reparseExitCode(summary({ totals })), 1);
  });

  it("an EMPTY scope is still 0 — nothing selected, nothing broken", () => {
    // The ceiling must not fire on a run that legitimately found no rows, e.g.
    // a fully-drained re-run. `selected > 0` is what separates them.
    assert.equal(reparseExitCode(summary({ totals: totalsFrom([]) })), 0);
  });

  it("a storage READ error is 1 — the counts exclude those rows", () => {
    const totals = totalsFrom([{ kind: "archive-read-failed" }]);
    assert.equal(reparseExitCode(summary({ totals })), 1);
  });

  it("an actionable parse/store failure is 1", () => {
    const totals = totalsFrom([
      {
        kind: "parsed",
        bucket: "unknownTaxonomy",
        refusal: null,
        annual: "none",
        projectionReset: false,
      },
    ]);
    assert.equal(reparseExitCode(summary({ totals })), 1);
  });

  it("an UNREQUESTED partial stop is 1", () => {
    // Narrowed from "every PARTIAL stop is 1" by MONEY-1250 — see the case
    // below for why `limit` left this set. These two did not: nobody ASKED for
    // them. A budget stop means the scope needs more runs than the operator
    // planned, and `no-advance` is an outright defect in the page query
    // (MONEY-1211). Both need a human, so both stay red.
    for (const stop of ["budget", "no-advance"] as const) {
      assert.equal(
        reparseExitCode(summary({ stop, totals: totalsFrom([parsedOk]) })),
        1,
        `stop=${stop} must be non-zero`,
      );
    }
  });

  it("a clean stop on --limit is 0 — a requested bound is not a failure", () => {
    // THE DEFECT. `stop !== "drained"` was an unconditional 1, so every
    // `--limit` rehearsal exited non-zero — and the rehearsal is the path
    // setup-xbrl-reparse-job.sh documents as the FIRST thing an operator runs,
    // twice, before applying anything. Measured on prod 2026-08-26: 7 of the
    // day's 9 executions read as FAILED, every one of them healthy. A status
    // that is red on the normal path takes the real failures down with it.
    //
    // Not a distinct "PARTIAL" code, because Cloud Run Jobs has nowhere to put
    // one: a task succeeds on 0 and fails on everything else, so exit 2 would
    // be the same red task and the same failedCount tick as exit 1.
    assert.equal(
      reparseExitCode(
        summary({ stop: "limit", totals: totalsFrom([parsedOk, parsedOk]) }),
      ),
      0,
    );
  });

  it("a --limit run that hit REAL failures is still 1", () => {
    // The load-bearing half. Exempting the stop REASON must not exempt the
    // run's failures: every failure check is evaluated for a bounded run
    // exactly as for a drained one. Three fixtures, one per check.
    const withFailure = totalsFrom([
      {
        kind: "parsed",
        bucket: "unknownTaxonomy",
        refusal: null,
        annual: "none",
        projectionReset: false,
      },
    ]);
    assert.equal(
      reparseExitCode(summary({ stop: "limit", totals: withFailure })),
      1,
      "a store/parse failure is actionable whatever stopped the run",
    );

    const withReadError = totalsFrom([{ kind: "archive-read-failed" }]);
    assert.equal(
      reparseExitCode(summary({ stop: "limit", totals: withReadError })),
      1,
      "a storage read error is actionable whatever stopped the run",
    );

    // The broken-bucket ceiling: every row of a non-empty scope missing.
    const allMissing = totalsFrom(
      Array.from({ length: 200 }, () => ({ kind: "archive-missing" }) as const),
    );
    assert.equal(
      reparseExitCode(summary({ stop: "limit", totals: allMissing })),
      1,
      "a --limit run is exactly how a wrong bucket gets rehearsed — it must " +
        "not be the one path where that reads as success",
    );
  });

  it("the known 2.1% archive gap is still 0 under --limit", () => {
    // The bounded rehearsal must report the same verdict on the same data as
    // the full run, or the rehearsal is not one.
    const totals = totalsFrom([
      ...Array.from(
        { length: 20 },
        () => ({ kind: "archive-missing" }) as const,
      ),
      ...Array.from({ length: 180 }, () => parsedOk),
    ]);
    assert.equal(reparseExitCode(summary({ stop: "limit", totals })), 0);
  });
});

describe("describeReparseStop — a partial run always names its cursor", () => {
  const totals = totalsFrom([parsedOk]);
  totals.lastId = "6a8602e00051c49dd1295298";

  for (const stop of ["limit", "budget", "no-advance"] as const) {
    it(`${stop} prints --after-id`, () => {
      const line = describeReparseStop(summary({ stop, totals }));
      assert.match(line, /--after-id=6a8602e00051c49dd1295298/);
    });
  }

  it("the --limit line carries the whole claim, because the task is GREEN", () => {
    // This is the one stop reason whose task goes green while the scope is
    // still full, so the summary is the ONLY place an operator learns the run
    // was bounded. It has to say all three things: not drained, exits 0, and
    // where to resume. A line that said merely "PARTIAL" would let a green tick
    // read as "the shard is done".
    const line = describeReparseStop(summary({ stop: "limit", totals }));
    assert.match(line, /PARTIAL/);
    assert.match(line, /NOT drained/);
    assert.match(line, /exits 0/);
    assert.match(line, /--after-id=6a8602e00051c49dd1295298/);
  });

  it("the budget line says NON-ZERO, so the two partials cannot be confused", () => {
    const line = describeReparseStop(summary({ stop: "budget", totals }));
    assert.match(line, /NON-ZERO/);
    assert.doesNotMatch(line, /exits 0/);
  });

  it("no-advance is named a DEFECT, not a 'come back later'", () => {
    const line = describeReparseStop(summary({ stop: "no-advance", totals }));
    assert.match(line, /DEFECT/);
    assert.match(line, /MONEY-1211/);
  });

  it("drained with nothing selected says there was nothing to do", () => {
    const line = describeReparseStop(
      summary({ stop: "drained", totals: emptyReparseTotals() }),
    );
    assert.match(line, /Nothing to do/);
  });

  it("a drained APPLY run points at the projection as the next step", () => {
    // The corrected facts are in xbrl_filings and invisible to a reader until
    // the projection re-runs. A summary that stops at "DRAINED" would read as
    // "done".
    const line = describeReparseStop(summary({ stop: "drained", totals }));
    assert.match(line, /stock_financials/);
  });

  it("a drained DRY RUN says it wrote nothing", () => {
    const line = describeReparseStop(
      summary({ stop: "drained", apply: false, totals }),
    );
    assert.match(line, /DRY RUN/);
  });
});

describe("describeReparseOutcome — the summary distinguishes plan from fact", () => {
  it("an apply run says 'wrote'; a dry run says 'WOULD write'", () => {
    const totals = totalsFrom([parsedOk]);
    assert.match(
      describeReparseOutcome(summary({ apply: true, totals })),
      /wrote 1/,
    );
    assert.match(
      describeReparseOutcome(summary({ apply: false, totals })),
      /WOULD write 1/,
    );
  });
});

describe("describeReparseRow — every failure names a row, not just a count", () => {
  const row = {
    symbol: "TATACONSUM",
    periodType: "QUARTERLY",
    periodEnd: new Date("2026-03-31T00:00:00.000Z"),
    sourceUrl: "https://nsearchives.nseindia.com/corporate/xbrl/X_1.xml",
  };

  it("says nothing about a row that ended in clean writes", () => {
    assert.equal(describeReparseRow(row, parsedOk), null);
    assert.equal(
      describeReparseRow(row, { ...parsedOk, annual: "written" }),
      null,
    );
  });

  it("names EVERY row that reaches `failed` or `archiveMissing`", () => {
    // The regression this exists for: the first version returned null for every
    // parse bucket, so a run could report a non-zero `failed` with an EMPTY
    // examples list — a number with nowhere to start from. Each remedy here is
    // different (a concept-table entry, a prod-only --archive-existing fetch, a
    // poisoned GCS object), and none is derivable from the count.
    const cases: [ReparseRowResult, RegExp][] = [
      [{ kind: "archive-missing" }, /no archived XML/],
      [{ kind: "archive-read-failed" }, /archive read FAILED/],
      [{ kind: "archive-unusable" }, /not a document/],
      [
        {
          kind: "parsed",
          bucket: "unparseable",
          refusal: null,
          annual: "none",
          projectionReset: false,
        },
        /unparseable/,
      ],
      [
        {
          kind: "parsed",
          bucket: "unknownTaxonomy",
          refusal: null,
          annual: "none",
          projectionReset: false,
        },
        /unknownTaxonomy/,
      ],
      [
        {
          kind: "parsed",
          bucket: "noPeriod",
          refusal: null,
          annual: "none",
          projectionReset: false,
        },
        /noPeriod/,
      ],
      [
        {
          kind: "parsed",
          bucket: "financials",
          refusal: "unclassified",
          annual: "none",
          projectionReset: false,
        },
        /store refused: unclassified/,
      ],
      [
        {
          kind: "parsed",
          bucket: "financials",
          refusal: null,
          annual: "ambiguous",
          projectionReset: true,
        },
        /ANNUAL companion ambiguous/,
      ],
      [
        {
          kind: "parsed",
          bucket: "financials",
          refusal: null,
          annual: "unreadable",
          projectionReset: true,
        },
        /ANNUAL companion unreadable/,
      ],
    ];
    for (const [result, pattern] of cases) {
      const line = describeReparseRow(row, result);
      assert.ok(line, `no example line for ${JSON.stringify(result)}`);
      assert.match(line, pattern);
      // Always addressable: symbol, period type and period end.
      assert.match(line, /^TATACONSUM QUARTERLY 2026-03-31 —/);
    }
  });

  it("the healthy buckets do NOT produce noise", () => {
    // `nonFinancial` and `unmappedFamily` are recorded decisions, not failures,
    // and they occur in the thousands — listing them would push the real ones
    // out of the capped examples list.
    for (const bucket of ["nonFinancial", "unmappedFamily"]) {
      assert.equal(
        describeReparseRow(row, {
          kind: "parsed",
          bucket,
          refusal: null,
          annual: "none",
          projectionReset: false,
        }),
        `TATACONSUM QUARTERLY 2026-03-31 — ${bucket} (${row.sourceUrl})`,
        "they ARE listed — they are cheap to name and the counters stay clean",
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The safety property: this job NEVER reaches the exchange                    */
/* -------------------------------------------------------------------------- */

describe("xbrl-reparse.ts makes no exchange requests", () => {
  const SRC = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "scripts",
      "jobs",
      "xbrl-reparse.ts",
    ),
    "utf8",
  );

  it("reads the job source (guards against a vacuous assertion)", () => {
    // Without this, a moved file would make every assertion below pass by
    // checking an empty string.
    assert.ok(SRC.length > 1000, "job source not found or truncated");
    assert.match(SRC, /reparseStoredFiling/);
  });

  it("does not import or call getFeedAsset / fetchXml", () => {
    // BOTH re-fetch from NSE on an archive miss, by design — correct for the
    // ingest, catastrophic here: ~2,044 rows have no archived object, and a
    // fallback would turn a counted skip into two thousand requests at a host
    // that has throttled us before.
    for (const forbidden of [
      "getFeedAsset",
      "fetchXml",
      "fetchExchangeAsset",
    ]) {
      const uses = SRC.split("\n").filter(
        (l) =>
          l.includes(forbidden) &&
          !l.trimStart().startsWith("*") &&
          !l.trimStart().startsWith("//"),
      );
      assert.deepEqual(
        uses,
        [],
        `xbrl-reparse.ts must never reach the exchange, and ${forbidden} ` +
          `falls back to it on an archive miss:\n${uses.join("\n")}`,
      );
    }
  });

  it("reads bytes through the archive store's own get()", () => {
    assert.match(SRC, /getFeedArchiveStore\(\)/);
    assert.match(SRC, /store\.get\(key\)|store, row/);
  });

  it("refuses to run when no archive store is registered", () => {
    // With no store every row reports `archive-missing` and the run prints a
    // confident, complete-looking "94,012 rows have no archived XML".
    assert.match(SRC, /if \(!store\) \{[\s\S]*throw new Error/);
  });

  it("calls BOTH write legs through the shared entry point", () => {
    // `storeAnnualCompanion` is what rewrites the ANNUAL row, and ANNUAL is
    // exactly what the reconcile gate compares. A re-parse that ran only
    // `storeFiling` would leave all 20,338 annual rows stale.
    assert.match(SRC, /reparseStoredFiling\(row, found\.xml, deps\)/);
  });
});
