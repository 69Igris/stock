/**
 * One report per data-writing job run — MONEY-1220.
 *
 * ## The class of bug this exists to make visible
 *
 * In a single week six scheduled jobs ran on time, reported success, and wrote
 * nothing:
 *
 *   feed-parse          pinned to a 10-day-stale image
 *   financial-data-sync tier selector matched 0 of 10,444 instruments
 *   mf-metadata         MF_METADATA_PROVIDER unset, so no provider registered
 *   news-sync           gated on a column that is 0 for every row
 *   filings-sync        same
 *   financial-data-sync (again) Tickertape 403 on every symbol, silently
 *
 * Every schedule was ENABLED, every invocation returned 200, every dashboard
 * was green. The only symptom was a table that had stopped growing — and
 * nobody watches a table for absence. A monitor on "did the schedule fire"
 * cannot see any of these, because the schedule always fired.
 *
 * The signal that separates a healthy run from all six is not the exit code.
 * It is **`selected > 0 && written === 0`**: the job found work and produced
 * nothing. That is never normal and always worth waking someone for.
 *
 * ## Why a shared helper rather than a log line per job
 *
 * Each job already printed its own summary in its own shape, so no query could
 * span them and a new job could omit the line entirely without anything
 * noticing. This emits the same metrics and the same structured line for
 * every job.
 *
 * ## The guard that makes "the NEXT job cannot join the list quietly" true
 *
 * That sentence used to name a function, `assertReportsJobOutcome`, which did
 * not exist — `grep -rn assertReportsJobOutcome` over the whole repo returned
 * this comment and nothing else (MONEY-1238). The real check was a hand-typed
 * five-name list in the tests, and a list cannot fail for a file that is not on
 * it: 42 of the 45 processors that issue Prisma writes were reporting nothing,
 * three of them (`xbrl-sync`, `events-sync`, `bhavcopy-sync`) while a monitor
 * watched for their metric and sat permanently in NO DATA.
 *
 * The guard is now a DIRECTORY SCAN — see
 * `packages/datadog/__tests__/job-outcome-coverage.test.ts`. It walks
 * `workers/src/processors/*.ts`, and any file that issues a Prisma write and
 * does not call `reportJobOutcome` must appear in a dated, reasoned baseline
 * that can only shrink. A NEW processor fails it on the day it lands.
 */

import { incrementCounter } from "./metrics";
import { METRIC_PREFIX } from "./constants";

export interface JobOutcome {
  /** Stable job id, matching the scheduler name minus the env suffix. */
  job: string;
  /** Rows the job CHOSE to work on. */
  selected: number;
  /** Rows it actually persisted. The number that matters. */
  written: number;
  /** Rows it attempted and could not persist. */
  failed?: number;
  /**
   * UPSTREAM calls that failed — MONEY-1250 review. Its own counter because it
   * is not measured in ROWS.
   *
   * Four jobs had four conventions for this and they cannot all be right:
   * `market-movers-sync` excluded a circuit break from `selected` and `failed`
   * on unit-purity grounds, `news-rss-sync` folded feed failures into `failed`
   * (feeds, not rows), and `intraday-sync` / `price-sync` folded fetch failures
   * into BOTH `selected` and `failed` (calls, not bars).
   *
   * Unit purity was the correct instinct and the consequence was the problem:
   * an NSE 403 emitted `selected 0, written 0, failed 0` — byte-identical to a
   * healthy no-change poll — so the exact silent-block shape this module exists
   * for was the one thing it could not express. A block is not a row that
   * failed to persist; it is a reason no rows were considered. It gets a
   * counter that says so, and the row counters stay pure.
   */
  transportFailures?: number;
  /**
   * Why nothing (or less than expected) was written. Required reading when
   * `selected > 0 && written === 0` — "0 written" without a reason is exactly
   * the silence this module replaces.
   */
  skippedReason?: string;
  /**
   * This run's OWN health gate did not come back green — MONEY-1401 review
   * finding 5. Its own counter for the same reason `transportFailures` has one:
   * it is not measured in ROWS, and the row counters must stay pure.
   *
   * The gap it closes: `mf-sync` writes all ~14,300 NAVs and then finds it
   * CANNOT MEASURE whether the feed was complete. It reports
   * `selected=14300, written=14300, failed=0` — byte-identical to a pass in
   * every Datadog surface, because `skippedReason` is free text in a log line
   * and nothing queries a log line. "A completeness check that failed to run
   * must not read as a pass" held in prose only.
   *
   * IT COVERS BOTH "the gate FAILED" AND "the gate could not RUN", deliberately.
   * Both are non-green, both want the same human, and `skippedReason` already
   * spells them differently (`incomplete:` vs `completeness-unmeasured:`) for
   * whoever reads the line. Collapsing them here makes "could not measure"
   * LOUDER, which is the safe direction — the opposite of MONEY-1234's
   * shruggable INCOMPARABLE verdict.
   *
   * IT CANNOT BE DERIVED FROM `skippedReason`, and that was measured rather
   * than assumed: of the ~50 call sites in `workers/src/processors`, many set
   * it on a perfectly healthy run — `xbrl-projection` / `xbrl-ratios` when
   * disarmed, `candle-evict` on a dry run ("a dry run cannot page anyone"),
   * `bhavcopy-sync` and `stock-document-extract` to carry a CENSUS,
   * `news-rss-sync` for "all N item(s) already known". Deriving an alarm from
   * its presence would page on every one of them. So the caller has to SAY it.
   */
  unhealthy?: boolean;
}

/**
 * Metric names as PASSED to `incrementCounter`.
 *
 * These are NOT what arrives in Datadog. `datadog-metrics` is initialised with
 * `prefix: METRIC_PREFIX`, so the series is `stockbook.job.written`. Anything
 * that QUERIES the metric — a monitor, a dashboard, a notebook — must use
 * {@link EMITTED_JOB_METRICS}.
 */
export const JOB_METRICS = {
  selected: "job.selected",
  written: "job.written",
  failed: "job.failed",
  transportFailures: "job.transport_failures",
  unhealthy: "job.unhealthy",
} as const;

/**
 * The fully-qualified series names that actually reach Datadog — MONEY-1238.
 *
 * The single source of truth for `scripts/ops/datadog/monitor-zero-write.json`,
 * asserted against the rendered monitor in the tests. Kept as a derived
 * constant rather than a second literal for the reason the defect proves: a
 * hand-copied `job.written` in the monitor and a `prefix` in `metrics.ts` are
 * two spellings of one fact, and they had already disagreed.
 */
export const EMITTED_JOB_METRICS = {
  selected: `${METRIC_PREFIX}${JOB_METRICS.selected}`,
  written: `${METRIC_PREFIX}${JOB_METRICS.written}`,
  failed: `${METRIC_PREFIX}${JOB_METRICS.failed}`,
  transportFailures: `${METRIC_PREFIX}${JOB_METRICS.transportFailures}`,
  unhealthy: `${METRIC_PREFIX}${JOB_METRICS.unhealthy}`,
} as const;

/**
 * Emit every counter in {@link JOB_METRICS} and one structured line.
 *
 * Never throws: a metrics backend that is down must not fail the job that was
 * reporting to it. `incrementCounter` already no-ops when uninitialised, and
 * the log line is the fallback signal for environments with no Datadog at all
 * (it is greppable as `job.written=0`).
 */
export function reportJobOutcome(outcome: JobOutcome): void {
  const { job, selected, written } = outcome;
  const failed = outcome.failed ?? 0;
  const tags = { job };

  try {
    incrementCounter(JOB_METRICS.selected, selected, tags);
    incrementCounter(JOB_METRICS.written, written, tags);
    incrementCounter(JOB_METRICS.failed, failed, tags);
    incrementCounter(
      JOB_METRICS.transportFailures,
      outcome.transportFailures ?? 0,
      tags,
    );
    // ZERO INCLUDED, like the four above. A monitor's `default_zero()` needs
    // the series to exist, and a job that STOPS emitting must be different
    // from a job that reported healthy.
    incrementCounter(JOB_METRICS.unhealthy, outcome.unhealthy ? 1 : 0, tags);
  } catch {
    // Reporting is never worth failing a run for.
  }

  const line = JSON.stringify({
    msg: "job-outcome",
    job,
    selected,
    written,
    failed,
    ...(outcome.transportFailures
      ? { transportFailures: outcome.transportFailures }
      : {}),
    ...(outcome.unhealthy ? { unhealthy: true } : {}),
    ...(outcome.skippedReason ? { skippedReason: outcome.skippedReason } : {}),
  });

  // A job that found work and wrote none is a WARNING even when it "succeeded".
  // This is the whole point of the module, so it is the one branch that changes
  // severity rather than just wording.
  // An upstream that would not answer is a warning on its own — MONEY-1250
  // review. Without this branch a total block emits a clean `0/0/0`, which is
  // indistinguishable from a healthy quiet run in both the metrics and the log.
  if ((outcome.transportFailures ?? 0) > 0 && written === 0) {
    console.warn(
      `[job-outcome] ${job} wrote 0 after ${outcome.transportFailures} ` +
        `UPSTREAM failure(s) — ${outcome.skippedReason ?? "no reason reported"} ${line}`,
    );
    return;
  }
  if (selected > 0 && written === 0) {
    console.warn(
      `[job-outcome] ${job} selected ${selected} and wrote 0 — ` +
        `${outcome.skippedReason ?? "no reason reported"} ${line}`,
    );
    return;
  }
  // LAST of the three, so the two above keep naming the more specific cause.
  // This one is the branch that catches a run which WROTE everything it
  // selected and still is not healthy — the `14300/14300/0` completeness case,
  // which reached `console.log` and read as a clean night.
  if (outcome.unhealthy) {
    console.warn(
      `[job-outcome] ${job} reported itself UNHEALTHY — ` +
        `${outcome.skippedReason ?? "no reason reported"} ${line}`,
    );
    return;
  }
  console.log(`[job-outcome] ${line}`);
}
