/**
 * The harvest's decisions — MONEY-1373.
 *
 * Every case here targets a failure that would SUCCEED: an unarmed run that
 * writes, a shard partition that drops or duplicates a file, a coverage report
 * that says 100% because nothing was expected. None of them raise an error on
 * their own, which is why they are asserted rather than reviewed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DOWNLOAD_CONCURRENCY,
  EXPIRY_WARNING_DAYS,
  actionSpendsOrFetches,
  mapWithConcurrency,
  memoisedListFiles,
  computeCoverage,
  coverageFromCount,
  isAppendArmed,
  isExpiringSoon,
  isHarvestArmed,
  nextActionFor,
  PROBE_MAX_USD,
  mayPromptForSpend,
  quoteExceedsProbeCap,
  resolveApply,
  resolveShard,
  shardOwns,
  worstCoverage,
  type InventoryState,
} from "../../../src/market-data/databento/databento-harvest-logic";

/* ─────────────────────────────────────────────────────────────────────── */

describe("the arm is a literal string, never a coercion", () => {
  it('arms on exactly "true"', () => {
    assert.equal(isHarvestArmed({ DATABENTO_HARVEST_APPLY: "true" }), true);
    assert.equal(isAppendArmed({ DATABENTO_APPEND_APPLY: "true" }), true);
  });

  it('does NOT arm on "false" — Boolean("false") is true', () => {
    // The whole reason the comparison is a string equality. A coercion here
    // arms the job in the one configuration meant to keep it off, and both
    // cloudbuild specs ship the flag PRESENT and "false" (MONEY-1214).
    assert.equal(isHarvestArmed({ DATABENTO_HARVEST_APPLY: "false" }), false);
    assert.equal(isAppendArmed({ DATABENTO_APPEND_APPLY: "false" }), false);
  });

  it("does not arm on absent, empty, TRUE, 1, or yes", () => {
    for (const v of [undefined, "", "TRUE", "True", "1", "yes", " true "]) {
      assert.equal(
        isHarvestArmed(v === undefined ? {} : { DATABENTO_HARVEST_APPLY: v }),
        false,
        `${JSON.stringify(v)} armed the job`,
      );
    }
  });

  it("reads the env PER CALL, so a changed value is seen", () => {
    // A module-scope const would freeze at import, and on a warm Cloud Run
    // container that turns a redeployed switch into no switch at all.
    const env: NodeJS.ProcessEnv = {};
    assert.equal(isHarvestArmed(env), false);
    env["DATABENTO_HARVEST_APPLY"] = "true";
    assert.equal(isHarvestArmed(env), true);
  });
});

describe("--apply ASKS; the environment ARMS", () => {
  it("both required to write", () => {
    assert.deepEqual(resolveApply(true, true), {
      apply: true,
      armMissing: false,
    });
  });

  it("an armed environment alone does NOT write", () => {
    // So a scheduled dry run stays dry even on an armed deployment.
    assert.deepEqual(resolveApply(false, true), {
      apply: false,
      armMissing: false,
    });
  });

  it("--apply without the arm stays dry AND says so", () => {
    // Continues rather than exiting: the operator still gets the quote report,
    // which is the useful half of the run they asked for.
    assert.deepEqual(resolveApply(true, false), {
      apply: false,
      armMissing: true,
    });
  });

  it("neither flag nor arm is a silent dry run, not a complaint", () => {
    assert.deepEqual(resolveApply(false, false), {
      apply: false,
      armMissing: false,
    });
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("shard resolution", () => {
  it("takes an explicit --shard=i/n", () => {
    assert.deepEqual(resolveShard("2/4", {}), { index: 2, count: 4 });
  });

  it("falls back to Cloud Run's own task variables", () => {
    // A job provisioned with --tasks=4 shards itself with no flag at all.
    assert.deepEqual(
      resolveShard(undefined, {
        CLOUD_RUN_TASK_INDEX: "3",
        CLOUD_RUN_TASK_COUNT: "8",
      }),
      { index: 3, count: 8 },
    );
  });

  it("an explicit flag beats the environment", () => {
    assert.deepEqual(
      resolveShard("0/2", {
        CLOUD_RUN_TASK_INDEX: "3",
        CLOUD_RUN_TASK_COUNT: "8",
      }),
      { index: 0, count: 2 },
    );
  });

  it("count 1 is UNSHARDED, not an error", () => {
    assert.equal(resolveShard("0/1", {}), null);
    // Cloud Run sets both variables, but a single-task execution needs no
    // index to be unsharded and must not throw for lacking one.
    assert.equal(resolveShard(undefined, { CLOUD_RUN_TASK_COUNT: "1" }), null);
    assert.equal(
      resolveShard(undefined, {
        CLOUD_RUN_TASK_COUNT: "1",
        CLOUD_RUN_TASK_INDEX: "0",
      }),
      null,
    );
  });

  it("REFUSES a task count above 1 with no index", () => {
    // The defect this replaced: the two variables were joined into "i/n", so
    // an absent index produced "/4" and threw a confusing parse error — and
    // the obvious repair, defaulting to 0, is far worse. Every task would
    // claim shard 0, load the same files, and leave three quarters of the
    // batch unloaded at four times the cost.
    assert.throws(
      () => resolveShard(undefined, { CLOUD_RUN_TASK_COUNT: "4" }),
      /Refusing to assume task 0/,
    );
    assert.throws(
      () =>
        resolveShard(undefined, {
          CLOUD_RUN_TASK_COUNT: "4",
          CLOUD_RUN_TASK_INDEX: "",
        }),
      /Refusing to assume task 0/,
    );
  });

  it("REFUSES a non-integer task count", () => {
    assert.throws(
      () => resolveShard(undefined, { CLOUD_RUN_TASK_COUNT: "many" }),
      /not an integer/,
    );
  });

  it("no flag and no task variables is unsharded", () => {
    assert.equal(resolveShard(undefined, {}), null);
  });

  it("REFUSES a malformed or out-of-range spec", () => {
    // A shard spec that parsed loosely would silently give one task the whole
    // file list while the other three did nothing — a run that looks fine and
    // takes four times as long.
    for (const bad of ["2", "a/b", "1/", "/2", "2 / 4", "-1/4"]) {
      assert.throws(() => resolveShard(bad, {}), RangeError, `accepted ${bad}`);
    }
    assert.throws(() => resolveShard("4/4", {}), /out of range/);
    assert.throws(() => resolveShard("9/2", {}), /out of range/);
  });
});

describe("the shard partition is TOTAL and DISJOINT", () => {
  const names = Array.from(
    { length: 500 },
    (_, i) => `glbx-mdp3-2026${String(i).padStart(4, "0")}.ohlcv-1m.csv.zst`,
  );

  for (const count of [2, 3, 4, 8]) {
    it(`every file is owned by EXACTLY one of ${count} shards`, () => {
      // Two tasks loading one file double-writes it; no task owning a file
      // loses it. Both are silent — the counters look plausible either way.
      for (const name of names) {
        const owners = [];
        for (let index = 0; index < count; index++) {
          if (shardOwns(name, { index, count })) owners.push(index);
        }
        assert.equal(owners.length, 1, `${name} was owned by ${owners.length}`);
      }
    });
  }

  it("is STABLE across calls, so a re-run repartitions identically", () => {
    const first = names.map((n) => shardOwns(n, { index: 1, count: 4 }));
    const second = names.map((n) => shardOwns(n, { index: 1, count: 4 }));
    assert.deepEqual(first, second);
  });

  it("actually spreads — it is not a constant", () => {
    // A hash that returned 0 for everything would pass "exactly one owner"
    // and put the whole load on task 0.
    const counts = [0, 0, 0, 0];
    for (const n of names) {
      for (let i = 0; i < 4; i++)
        if (shardOwns(n, { index: i, count: 4 })) counts[i]!++;
    }
    for (const c of counts) assert.ok(c > 50, `a shard got ${c} of 500 files`);
  });

  it("an unsharded run owns everything", () => {
    for (const n of names.slice(0, 20)) assert.equal(shardOwns(n, null), true);
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("expiry", () => {
  const now = new Date("2026-09-06T00:00:00Z");

  it("warns inside the window", () => {
    assert.equal(isExpiringSoon(new Date("2026-09-07T12:00:00Z"), now), true);
  });

  it("stays quiet outside it", () => {
    assert.equal(isExpiringSoon(new Date("2026-09-20T00:00:00Z"), now), false);
  });

  it("an ALREADY EXPIRED job is still reported", () => {
    // Past the instant is not "no longer urgent" — the bytes are gone and the
    // only remedy is to buy the range again.
    assert.equal(isExpiringSoon(new Date("2026-09-01T00:00:00Z"), now), true);
  });

  it("an unknown expiry is not a warning", () => {
    assert.equal(isExpiringSoon(null, now), false);
  });

  it("the window is two days", () => {
    assert.equal(EXPIRY_WARNING_DAYS, 2);
    const edge = new Date(now.getTime() + 2 * 86_400_000);
    assert.equal(isExpiringSoon(edge, now), false);
    assert.equal(isExpiringSoon(new Date(edge.getTime() - 1), now), true);
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("coverage is measured against the CALENDAR, not the data", () => {
  // 2026-11-23 Mon .. 2026-11-27 Fri. Thanksgiving (26th) is a full closure and
  // the 27th is a half day but still a session: 4 trading days, not 5.
  const from = "2026-11-23";
  const to = "2026-11-27";

  it("the denominator excludes the holiday", () => {
    const r = computeCoverage({
      symbol: "AAPL",
      sessionsPresent: ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"],
      fromDateKey: from,
      toDateKey: to,
    });
    assert.equal(r.expected, 4);
    assert.equal(r.present, 4);
    assert.deepEqual(r.missing, []);
    assert.equal(r.ratio, 1);
  });

  it("names the sessions that are missing", () => {
    const r = computeCoverage({
      symbol: "AAPL",
      sessionsPresent: ["2026-11-23", "2026-11-27"],
      fromDateKey: from,
      toDateKey: to,
    });
    assert.deepEqual(r.missing, ["2026-11-24", "2026-11-25"]);
    assert.equal(r.missingCount, 2);
    assert.equal(r.present, 2);
  });

  it("a bar ON the holiday does not inflate the count", () => {
    // A denominator derived from what ARRIVED can only ever report 100% — the
    // wrong-granularity class this repo has met five times (MONEY-1189).
    const r = computeCoverage({
      symbol: "AAPL",
      sessionsPresent: ["2026-11-23", "2026-11-26", "2026-11-27"],
      fromDateKey: from,
      toDateKey: to,
    });
    assert.equal(r.expected, 4);
    assert.equal(r.present, 2);
    assert.deepEqual(r.missing, ["2026-11-24", "2026-11-25"]);
  });

  it("an empty range reports ratio NULL, never 1", () => {
    // "Complete" and "there was nothing to be complete about" are different
    // answers; a run reporting 100% for an empty range looks like its best
    // night. 2026-11-28/29 is a weekend.
    const r = computeCoverage({
      symbol: "AAPL",
      sessionsPresent: [],
      fromDateKey: "2026-11-28",
      toDateKey: "2026-11-29",
    });
    assert.equal(r.expected, 0);
    assert.equal(r.ratio, null);
  });

  it("REFUSES a year the holiday table has no opinion about", () => {
    assert.throws(
      () =>
        computeCoverage({
          symbol: "AAPL",
          sessionsPresent: [],
          fromDateKey: "2019-01-02",
          toDateKey: "2019-01-10",
        }),
      RangeError,
    );
  });
});

describe("the count-only path agrees with the enumerated one", () => {
  const from = "2026-11-23";
  const to = "2026-11-27";

  it("same expected, same missingCount", () => {
    const listed = computeCoverage({
      symbol: "AAPL",
      sessionsPresent: ["2026-11-23", "2026-11-27"],
      fromDateKey: from,
      toDateKey: to,
    });
    const counted = coverageFromCount({
      symbol: "AAPL",
      present: 2,
      fromDateKey: from,
      toDateKey: to,
    });
    assert.equal(counted.expected, listed.expected);
    assert.equal(counted.missingCount, listed.missingCount);
    assert.equal(counted.ratio, listed.ratio);
  });

  it("`missing` is NULL, not [] — we did not ask", () => {
    // `[]` says nothing is missing. On a symbol short two sessions that would
    // be a lie, and it is the exact absent-vs-empty confusion behind
    // MONEY-1050, MONEY-1234 and MONEY-1235.
    const counted = coverageFromCount({
      symbol: "AAPL",
      present: 2,
      fromDateKey: from,
      toDateKey: to,
    });
    assert.equal(counted.missing, null);
    assert.notDeepEqual(counted.missing, []);
  });

  it("more sessions present than the calendar allows does not go negative", () => {
    const counted = coverageFromCount({
      symbol: "AAPL",
      present: 9,
      fromDateKey: from,
      toDateKey: to,
    });
    assert.equal(counted.missingCount, 0);
    assert.equal(counted.present, 9, "the raw count is reported, not clamped");
    assert.equal(counted.ratio, 1);
  });
});

describe("worstCoverage ranks by MISSING COUNT, not ratio", () => {
  const base = { expected: 0, present: 0, missing: null, ratio: null } as const;

  it("200-of-800 outranks 2-of-3 despite the better ratio", () => {
    const reports = [
      { ...base, symbol: "TINY", expected: 3, present: 1, missingCount: 2 },
      {
        ...base,
        symbol: "BIG",
        expected: 800,
        present: 600,
        missingCount: 200,
      },
    ];
    assert.deepEqual(
      worstCoverage(reports).map((r) => r.symbol),
      ["BIG", "TINY"],
    );
  });

  it("drops the complete symbols entirely", () => {
    const reports = [
      { ...base, symbol: "OK", expected: 10, present: 10, missingCount: 0 },
      { ...base, symbol: "BAD", expected: 10, present: 9, missingCount: 1 },
    ];
    assert.deepEqual(
      worstCoverage(reports).map((r) => r.symbol),
      ["BAD"],
    );
  });

  it("honours the limit and is stable on ties", () => {
    const reports = ["C", "A", "B"].map((symbol) => ({
      ...base,
      symbol,
      expected: 10,
      present: 5,
      missingCount: 5,
    }));
    assert.deepEqual(
      worstCoverage(reports, 2).map((r) => r.symbol),
      ["A", "B"],
    );
  });

  it("does not mutate its input", () => {
    const reports = [
      { ...base, symbol: "Z", expected: 1, present: 0, missingCount: 1 },
      { ...base, symbol: "A", expected: 9, present: 0, missingCount: 9 },
    ];
    worstCoverage(reports);
    assert.deepEqual(
      reports.map((r) => r.symbol),
      ["Z", "A"],
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("what a chunk needs next", () => {
  const row = (over: Partial<InventoryState>): InventoryState => ({
    state: "DONE",
    jobId: "job",
    filesTotal: 0,
    filesVerified: 0,
    loadedAt: null,
    ...over,
  });

  it("no row at all means quote", () => {
    assert.equal(nextActionFor(null, true), "quote");
  });

  it("QUOTED re-quotes — it is not a purchase", () => {
    // The previous run died between the create and the submit. Re-quoting is
    // safe because the guard's idempotent lookup ignores a QUOTED row.
    assert.equal(nextActionFor(row({ state: "QUOTED" }), true), "quote");
  });

  it("SUBMITTED and PROCESSING poll", () => {
    assert.equal(nextActionFor(row({ state: "SUBMITTED" }), true), "poll");
    assert.equal(nextActionFor(row({ state: "PROCESSING" }), true), "poll");
  });

  it("DONE with unverified files downloads", () => {
    assert.equal(
      nextActionFor(
        row({ state: "DONE", filesTotal: 3, filesVerified: 1 }),
        true,
      ),
      "download",
    );
  });

  it("DONE with NO file list downloads — zero verified of zero is not complete", () => {
    // `filesTotal > 0` is the guard. Without it `0 >= 0` reads as fully
    // verified and the row skips straight to load with nothing on disk.
    assert.equal(nextActionFor(row({ state: "DONE" }), true), "download");
  });

  it("DONE and fully verified loads, or goes to coverage when unloadable", () => {
    const r = row({ state: "DONE", filesTotal: 2, filesVerified: 2 });
    assert.equal(nextActionFor(r, true), "load");
    assert.equal(nextActionFor(r, false), "coverage");
  });

  it("DOWNLOADED loads, or is DONE for an archive-only schema", () => {
    // ohlcv-1s, bbo-1m, tbbo and the reference schemas never become candles.
    assert.equal(nextActionFor(row({ state: "DOWNLOADED" }), true), "load");
    assert.equal(nextActionFor(row({ state: "DOWNLOADED" }), false), "done");
  });

  it("LOADED is done and EXPIRED is expired", () => {
    assert.equal(nextActionFor(row({ state: "LOADED" }), true), "done");
    assert.equal(nextActionFor(row({ state: "EXPIRED" }), true), "expired");
  });

  it("FAILED and an UNRECOGNISED state both re-quote, never 'done'", () => {
    // The unsafe default is to assume completion: it would leave the window
    // permanently unbought while reporting a healthy run.
    assert.equal(nextActionFor(row({ state: "FAILED" }), true), "quote");
    assert.equal(nextActionFor(row({ state: "WAT" }), true), "quote");
  });

  it("only quote, poll and download reach the vendor", () => {
    assert.deepEqual(
      (
        [
          "quote",
          "poll",
          "download",
          "load",
          "coverage",
          "done",
          "expired",
        ] as const
      ).filter(actionSpendsOrFetches),
      ["quote", "poll", "download"],
    );
  });
});

describe("the probe's two money guards are DECISIONS, not strings", () => {
  // Both of these were asserted only as `assert.match(PROBE, /.../)` in the
  // deploy contract — string presence, not policy. A mutation sweep inverted
  // the TTY refusal and widened the cap a thousandfold, and the entire suite
  // stayed green. They are the only two things between a wrapper and an
  // unattended purchase.

  it("refuses to prompt when stdin is not a terminal", () => {
    // A prompt a wrapper can answer is not a safeguard, and
    // run-market-data-job.sh is exactly such a wrapper.
    assert.equal(mayPromptForSpend(false), false);
    assert.equal(mayPromptForSpend(undefined), false);
  });

  it("permits it from a real terminal", () => {
    // The premise. Without it the case above passes on a function that always
    // refuses, which would make the probe unrunnable rather than safe.
    assert.equal(mayPromptForSpend(true), true);
  });

  it("the cap is five cents", () => {
    assert.equal(PROBE_MAX_USD, 0.05);
  });

  it("refuses a quote above the cap and allows one below", () => {
    assert.equal(quoteExceedsProbeCap(0.06), true);
    assert.equal(quoteExceedsProbeCap(50), true);
    assert.equal(quoteExceedsProbeCap(0.04), false);
    assert.equal(
      quoteExceedsProbeCap(0),
      false,
      "an included window quotes $0",
    );
  });

  it("the boundary is exclusive — exactly the cap is allowed", () => {
    assert.equal(quoteExceedsProbeCap(PROBE_MAX_USD), false);
    assert.equal(quoteExceedsProbeCap(PROBE_MAX_USD + 1e-9), true);
  });

  it("REFUSES a non-finite quote rather than comparing it", () => {
    // `NaN > cap` is false, so a bare comparison treats an unreadable quote as
    // affordable — the same shape as `Number(x) || 0` turning a parse failure
    // into the sentinel for "no limit".
    assert.equal(quoteExceedsProbeCap(NaN), true);
    assert.equal(quoteExceedsProbeCap(Infinity), true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Bounded concurrency
   ──────────────────────────────────────────────────────────────────────── */

describe("MONEY-1373 — the download pool is BOUNDED", () => {
  /**
   * PEAK IN-FLIGHT, not a source regex.
   *
   * The bound is the entire point of the helper, and a regex asserting that
   * `mapWithConcurrency(` appears somewhere cannot see it: a mutation widening
   * the width to `items.length` — full unbounded fan-out, every file's fetch
   * body and every GCS upload buffer resident at once against a 4Gi container —
   * leaves such a scan green. So the test watches the counter that the mutation
   * moves.
   */
  it("never exceeds the requested width", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 40 }, (_, i) => i),
      4,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
      },
    );
    assert.equal(peak, 4);
  });

  it("actually runs them in parallel — the width is a floor as well as a cap", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 16 }, (_, i) => i),
      8,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      },
    );
    // A serial implementation passes the cap assertion above trivially. This is
    // the half that fails if the pool degenerates back to a `for` loop.
    assert.equal(peak, 8);
  });

  it("returns results in INPUT order however they complete", async () => {
    const out = await mapWithConcurrency([50, 1, 30, 2], 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    // Completion order is 1,3,2,0. Input order is what a caller stamping a
    // per-file inventory needs.
    assert.deepEqual(out, [0, 1, 2, 3]);
  });

  it("does not swallow a rejection", async () => {
    await assert.rejects(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
      /boom/,
    );
  });

  it("a width below 1 still makes progress rather than hanging", async () => {
    // Clamped, not honoured. Zero workers would resolve `Promise.all([])`
    // immediately with an array of holes — every file silently skipped and the
    // step reporting success.
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => n * 2);
    assert.deepEqual(out, [2, 4, 6]);
  });

  it("a NON-FINITE width runs every task instead of running none", async () => {
    // THE DEFECT the comment above described and the code did not cover.
    // `Math.max(1, Math.floor(NaN))` is `NaN`, `Array.from({length: NaN})` is
    // `[]`, so `Promise.all([])` resolved immediately having spawned NO
    // workers — the call returned `items.length` HOLES with no error and no
    // task run. Measured before the fix: `mapWithConcurrency([1..5], NaN, fn)`
    // ran 0 tasks.
    //
    // Assert the TASK COUNT, not just the returned array: an implementation
    // that returned the right values while skipping the work is the failure
    // being guarded, and `deepEqual` on holes-vs-values is the only thing that
    // separates them, so both halves are checked.
    for (const width of [NaN, Infinity, -Infinity]) {
      const seen: number[] = [];
      const out = await mapWithConcurrency(
        [1, 2, 3, 4, 5],
        width,
        async (n) => {
          seen.push(n);
          return n * 2;
        },
      );
      assert.deepEqual(
        seen.slice().sort((a, b) => a - b),
        [1, 2, 3, 4, 5],
        `width ${width} ran ${seen.length} of 5 tasks`,
      );
      assert.deepEqual(out, [2, 4, 6, 8, 10], `width ${width} returned holes`);
      // A hole and a stored `undefined` are `deepEqual`, so name the property
      // directly: every index must have been WRITTEN.
      assert.equal(
        Object.keys(out).length,
        5,
        `width ${width} left holes in the result array`,
      );
    }
  });

  it("an empty input does no work", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 8, async () => {
      calls += 1;
    });
    assert.deepEqual(out, []);
    assert.equal(calls, 0);
  });

  it("the default width is sized for a 4Gi container, not for the file count", () => {
    // Each slot holds one fetch body piped into one resumable GCS upload, and
    // the GCS client buffers a chunk per upload for retry. The number is a
    // memory decision; a three-digit default would be an OOM.
    assert.equal(DEFAULT_DOWNLOAD_CONCURRENCY, 8);
    assert.ok(DEFAULT_DOWNLOAD_CONCURRENCY > 1);
    assert.ok(DEFAULT_DOWNLOAD_CONCURRENCY <= 16);
  });
});

describe("memoisedListFiles — one vendor call per job, not one per pool slot", () => {
  it("collapses a whole 8-wide pool into ONE fetch", async () => {
    // THE DEFECT, exactly: the cache stored the resolved array, so it was
    // still empty when the pool's first 8 tasks looked. Eight identical,
    // metered `batch.list_files` calls for one job — and it grew with the
    // concurrency, so the fix for a slow download made the listing worse.
    const cache = new Map<string, Promise<string[]>>();
    let calls = 0;
    const fetch = async (key: string): Promise<string[]> => {
      calls += 1;
      // A real await, so a cache written after it is written too late.
      await new Promise((r) => setTimeout(r, 5));
      return [`${key}-file`];
    };

    const out = await mapWithConcurrency(
      Array.from({ length: 40 }, (_, i) => i),
      8,
      async () => (await memoisedListFiles(cache, "job-1", fetch)).length,
    );

    assert.equal(calls, 1, `${calls} vendor calls for one job`);
    assert.deepEqual(new Set(out), new Set([1]));
  });

  it("rejects every concurrent caller, then EVICTS so the next call retries", async () => {
    // A cached rejected promise is permanent. Without the eviction one
    // transient 5xx would answer every later lookup in the job's remaining
    // 24 h with the same stale failure, and no retry could reach the vendor.
    const cache = new Map<string, Promise<string[]>>();
    let calls = 0;
    const fetch = async (): Promise<string[]> => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 1));
      if (calls === 1) throw new Error("vendor 503");
      return ["ok"];
    };

    const first = memoisedListFiles(cache, "job-1", fetch);
    const second = memoisedListFiles(cache, "job-1", fetch);
    // Both callers see the failure — sharing the call means sharing its
    // outcome, not swallowing it for the ones that arrived late.
    await assert.rejects(first, /vendor 503/);
    await assert.rejects(second, /vendor 503/);
    assert.equal(calls, 1, "the failing call was not shared");

    assert.deepEqual(await memoisedListFiles(cache, "job-1", fetch), ["ok"]);
    assert.equal(calls, 2, "the rejection was cached — no retry was possible");
  });

  it("keys per job, so two jobs are two calls", async () => {
    const cache = new Map<string, Promise<string[]>>();
    let calls = 0;
    const fetch = async (key: string): Promise<string[]> => {
      calls += 1;
      return [key];
    };
    await memoisedListFiles(cache, "a", fetch);
    await memoisedListFiles(cache, "b", fetch);
    await memoisedListFiles(cache, "a", fetch);
    assert.equal(calls, 2);
  });
});
