/**
 * MONEY-1220 — the zero-write signal, and the list of jobs that must emit it.
 *
 * Six scheduled jobs ran on time, returned 200, and wrote nothing in a single
 * week. Every schedule was ENABLED, every dashboard green. The only symptom was
 * a table that stopped growing, and nobody watches a table for absence.
 *
 * This file covers the HELPER's behaviour. The two checks that keep it from
 * decaying live next door, because both were missing and both had to be built
 * from scratch (MONEY-1238):
 *
 *   monitor-agreement.test.ts     the monitor queries the series the code
 *                                 emits, in the environment the workers tag —
 *                                 asserted against the RENDERED monitor, not
 *                                 the template
 *   job-outcome-coverage.test.ts  a directory scan over workers/src/processors:
 *                                 a NEW data-writing processor that forgets to
 *                                 report fails on the day it lands
 *
 * What used to sit at the bottom of THIS file was a hand-typed five-name list,
 * which cannot fail for a file that is not on it — 38 of 44 writers were silent
 * — and a `monitor.includes(JOB_METRICS.written)` substring check that passed
 * with or without the metric prefix, i.e. passed while describing the exact
 * condition that was true. Both are gone; neither was replaced in place.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import datadogMetrics from "datadog-metrics";
import {
  reportJobOutcome,
  JOB_METRICS,
  EMITTED_JOB_METRICS,
} from "../src/job-outcome";
import { METRIC_PREFIX } from "../src/constants";

/**
 * The counter seam — MONEY-1401.
 *
 * `metrics.ts` does `import datadogMetrics from "datadog-metrics"` and calls
 * `.increment` at CALL time, so replacing the two methods on that CJS object
 * intercepts every counter this package emits without a module registry hack
 * (`mock.module` needs an experimental flag this repo does not pass — see
 * `packages/core/src/market-data/tiingo-budget.ts`).
 *
 * `init` is replaced too, and that is the point rather than tidiness:
 * `ensureInit()` returns early without `DD_API_KEY`, so the counters are
 * unobservable until a key is set — and a REAL `init` with a key installs
 * datadog-metrics' 15 s flush timer and orphans the run. A no-op `init` gives
 * us the `initialized` latch and no timer.
 *
 * Installed at module scope, before any `describe` body runs, and never
 * restored: `initialized` latches true on the first report, so handing the
 * real `increment` back mid-file would send later calls into a library that
 * was never actually initialised.
 */
const emitted: Array<{ name: string; value: number }> = [];
const ddm = datadogMetrics as unknown as Record<string, unknown>;
ddm.init = () => {};
ddm.increment = (name: string, value: number) =>
  void emitted.push({ name, value });
process.env.DD_API_KEY = "job-outcome-test";

/** Counters emitted by one call, by metric name. */
function counters(fn: () => void): Map<string, number> {
  emitted.length = 0;
  fn();
  return new Map(emitted.map((e) => [e.name, e.value]));
}

/** Capture console output for one call. */
function capture(fn: () => void): { log: string[]; warn: string[] } {
  const log: string[] = [];
  const warn: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => void log.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void warn.push(a.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return { log, warn };
}

describe("reportJobOutcome", () => {
  it("WARNS when the job found work and wrote nothing", () => {
    // The entire point. This is the one condition that separates a healthy run
    // from all six incidents, and it must be louder than a normal line.
    const { warn, log } = capture(() =>
      reportJobOutcome({ job: "t", selected: 100, written: 0, failed: 0 }),
    );
    assert.equal(warn.length, 1, "no warning for selected>0 written=0");
    assert.equal(log.length, 0, "logged at info level instead of warn");
    assert.match(warn[0]!, /selected 100 and wrote 0/);
  });

  it("does NOT warn when there was genuinely nothing to do", () => {
    // A job with an empty queue is healthy. Alerting on it is how a real alert
    // gets ignored.
    const { warn } = capture(() =>
      reportJobOutcome({ job: "t", selected: 0, written: 0 }),
    );
    assert.deepEqual(warn, []);
  });

  it("does not warn on a normal run", () => {
    const { warn, log } = capture(() =>
      reportJobOutcome({ job: "t", selected: 100, written: 97, failed: 3 }),
    );
    assert.deepEqual(warn, []);
    assert.equal(log.length, 1);
  });

  it("says WHY, when a reason was given", () => {
    const { warn } = capture(() =>
      reportJobOutcome({
        job: "t",
        selected: 5,
        written: 0,
        skippedReason: "provider unconfigured",
      }),
    );
    assert.match(warn[0]!, /provider unconfigured/);
  });

  it("admits when no reason was given rather than staying silent", () => {
    const { warn } = capture(() =>
      reportJobOutcome({ job: "t", selected: 5, written: 0 }),
    );
    assert.match(warn[0]!, /no reason reported/);
  });

  it("emits a machine-readable line in every case", () => {
    const { log } = capture(() =>
      reportJobOutcome({ job: "t", selected: 4, written: 4 }),
    );
    const json = log[0]!.slice(log[0]!.indexOf("{"));
    const parsed = JSON.parse(json) as Record<string, unknown>;
    assert.equal(parsed.job, "t");
    assert.equal(parsed.selected, 4);
    assert.equal(parsed.written, 4);
  });

  it("never throws — reporting must not fail the run it reports on", () => {
    assert.doesNotThrow(() =>
      reportJobOutcome({
        job: "t",
        selected: Number.NaN,
        written: Number.POSITIVE_INFINITY,
      }),
    );
  });

  // ── MONEY-1401 review finding 5 — `unhealthy` ─────────────────────────────
  //
  // `skippedReason` reaches a LOG LINE and nothing queries a log line, so three
  // of this branch's new self-checks emitted a report that was byte-identical
  // to a pass in every Datadog surface. `mf-sync`'s "could not measure
  // completeness" state was the sharpest: `selected=14300, written=14300,
  // failed=0` at INFO, under a comment claiming a failed check must not read as
  // a pass.

  it("a run that WROTE everything it selected can still be UNHEALTHY", () => {
    // The case no existing branch could express: nothing is owed, nothing
    // failed, and the run's own gate did not come back green.
    //
    // MUTATION: delete the `outcome.unhealthy` warn branch -> RED.
    const { warn, log } = capture(() =>
      reportJobOutcome({
        job: "mf-sync",
        selected: 14_300,
        written: 14_300,
        failed: 0,
        unhealthy: true,
        skippedReason: "completeness-unmeasured: connection reset",
      }),
    );
    assert.equal(log.length, 0, "reported at INFO — identical to a pass");
    assert.equal(warn.length, 1);
    assert.match(warn[0]!, /UNHEALTHY/);
    assert.match(warn[0]!, /completeness-unmeasured/);
  });

  it("puts `unhealthy` in the structured line, and omits it otherwise", () => {
    // Absent rather than `false`: the line is grepped and indexed, and a key
    // that is present on every healthy run is a key nobody filters on.
    const parse = (s: string) =>
      JSON.parse(s.slice(s.indexOf("{"))) as Record<string, unknown>;

    const { warn } = capture(() =>
      reportJobOutcome({ job: "t", selected: 1, written: 1, unhealthy: true }),
    );
    assert.equal(parse(warn[0]!).unhealthy, true);

    const { log } = capture(() =>
      reportJobOutcome({ job: "t", selected: 1, written: 1 }),
    );
    assert.ok(!("unhealthy" in parse(log[0]!)));
  });

  it("does NOT infer unhealthy from `skippedReason` — that was measured", () => {
    // THE REASON THE FIELD EXISTS AT ALL. Deriving the alarm from a present
    // `skippedReason` is the obvious shortcut and it is wrong: of the ~50 call
    // sites in workers/src/processors, many set it on a healthy run —
    // `xbrl-projection`/`xbrl-ratios` when DISARMED, `candle-evict` on a dry
    // run ("a dry run cannot page anyone"), `bhavcopy-sync` and
    // `stock-document-extract` to carry a CENSUS, `news-rss-sync` for "all N
    // item(s) already known". Every one of them would page.
    //
    // MUTATION: `if (outcome.unhealthy)` -> `if (outcome.skippedReason)` -> RED.
    const { warn, log } = capture(() =>
      reportJobOutcome({
        job: "xbrl-ratios",
        selected: 0,
        written: 0,
        skippedReason: "DISARMED (XBRL_RATIOS_APPLY != true) — planned 1,704",
      }),
    );
    assert.deepEqual(warn, [], "a disarmed run must not warn");
    assert.equal(log.length, 1);
  });

  it("emits job.unhealthy UNCONDITIONALLY, zero included, carrying the FLAG", () => {
    // BEHAVIOURAL — MONEY-1401. This was a source scan asserting the emit block
    // matched `/incrementCounter\(\s*JOB_METRICS\.unhealthy\s*,/` and held no
    // `if (`, which cannot see the VALUE. Measured: `outcome.unhealthy ? 1 : 0`
    // -> `? 0 : 0` left 12/12 green, and so did swapping the flag for
    // `outcome.transportFailures`. The first makes the series permanently zero,
    // which is the "healthy and stopped-reporting are the same zero" shape this
    // case exists to kill.
    const healthy = counters(() =>
      reportJobOutcome({ job: "t", selected: 1, written: 1 }),
    );
    const unhealthy = counters(() =>
      reportJobOutcome({ job: "t", selected: 1, written: 1, unhealthy: true }),
    );

    // A POINT ON EVERY RUN. `default_zero()` needs the series to exist, so a
    // healthy run must emit 0 rather than nothing.
    assert.equal(
      healthy.get(JOB_METRICS.unhealthy),
      0,
      "a healthy run must still emit the counter, at 0",
    );
    assert.equal(unhealthy.get(JOB_METRICS.unhealthy), 1);

    // The four alongside it, same rule.
    for (const name of [
      JOB_METRICS.selected,
      JOB_METRICS.written,
      JOB_METRICS.failed,
      JOB_METRICS.transportFailures,
    ]) {
      assert.ok(healthy.has(name), `${name} must be emitted on a healthy run`);
    }

    // NOT `transportFailures` WEARING THE FLAG'S NAME. Non-zero transport
    // failures with `unhealthy` unset must still leave the alarm at 0, or the
    // monitor pages on an upstream blip the log line already reports.
    const transportOnly = counters(() =>
      reportJobOutcome({
        job: "t",
        selected: 1,
        written: 1,
        transportFailures: 3,
      }),
    );
    assert.equal(transportOnly.get(JOB_METRICS.transportFailures), 3);
    assert.equal(
      transportOnly.get(JOB_METRICS.unhealthy),
      0,
      "job.unhealthy must carry the `unhealthy` flag, not another field",
    );
  });

  it("names its metrics once, and says which name reaches Datadog", () => {
    // Two names, one fact. `JOB_METRICS` is what the code PASSES;
    // `EMITTED_JOB_METRICS` is what arrives, because datadog-metrics prepends
    // `METRIC_PREFIX`. Anything that QUERIES the metric must use the second.
    //
    // Asserted here as an exact equality rather than a substring: the bare name
    // is a substring of the prefixed one, so `includes()` cannot tell them
    // apart — which is how the monitor came to query a series nobody emits.
    // The end-to-end check against the rendered monitor is in
    // monitor-agreement.test.ts.
    assert.equal(JOB_METRICS.written, "job.written");
    assert.equal(JOB_METRICS.selected, "job.selected");
    assert.equal(EMITTED_JOB_METRICS.written, `${METRIC_PREFIX}job.written`);
    assert.equal(EMITTED_JOB_METRICS.selected, `${METRIC_PREFIX}job.selected`);
    assert.notEqual(
      EMITTED_JOB_METRICS.written,
      JOB_METRICS.written,
      "if these are ever equal the prefix has been dropped and every monitor " +
        "built on EMITTED_JOB_METRICS silently starts watching a dead series",
    );
  });
});
