/**
 * tile-build-d1-in — the IN D1 tile builder. MONEY-1467 (A2).
 *
 * Its OWN tsup entry because the release's re-pin loop,
 * `SETUP_SCRIPT_BY_ENTRYPOINT` and `job-build-provenance.test.ts` key on ONE
 * entry per Cloud Run job — and India and US must be two jobs, since they
 * follow different producers (bhavcopy-sync 21:00 IST, us-eod-sync 11:00 IST)
 * on different schedules. One entry serving both would leave a job re-pinned by
 * nothing: it would keep the image it was provisioned with, run last release's
 * code, and exit 0 (MONEY-1205/1250/1314/1317, one ticket each).
 *
 * The ENTRY owns telemetry, provenance and the outcome report; the shared
 * implementation owns the work and hands back its counters. Without a matching
 * entry in `workers/tsup.config.ts` this dies instantly with "Cannot find
 * module /app/dist/tile-build-d1-in.js".
 */
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { flushMetrics } from "@usemoney/datadog/metrics";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";
import { main } from "./tile-build-d1";

const JOB = "tile-build-d1-in";
const log = {
  info: (...a: unknown[]) => console.log("[tile-build-d1-in]", ...a),
  warn: (...a: unknown[]) => console.warn("[tile-build-d1-in]", ...a),
  error: (...a: unknown[]) => console.error("[tile-build-d1-in]", ...a),
};

async function run(): Promise<void> {
  // FIRST. A job pins its image at provision time and a workers deploy does
  // not move it, so a job can run weeks-old code and exit 0 — its own startup
  // output is the only place that drift is observable (MONEY-1205).
  reportBuildProvenance(log, "tile-build-d1-in");
  // A Cloud Run JOB has NO Datadog agent sidecar, so without this the job logs
  // to stdout only and never reaches the log stream the monitors read.
  await initJobTelemetry();

  const counters = await main(["--market=IN", ...process.argv.slice(2)]);

  // SELECTED counts every listing this shard considered, skips included: a run
  // that selected nothing is the defect an absence monitor exists to catch
  // (MONEY-1215), and folding skips out would make a fully-cached night
  // indistinguishable from a query that matched no rows.
  reportJobOutcome({
    job: JOB,
    selected: counters.built + counters.skipped + counters.failed,
    written: counters.built,
    failed: counters.failed,
  });

  // MANDATORY, and it is the whole reason this is not fire-and-forget:
  // `datadog-metrics` batches on a 15s timer, so a job that reports and exits
  // immediately takes its counters with it. The monitor then sees NO DATA,
  // which is indistinguishable from an idle healthy job (MONEY-1278).
  await flushMetrics();

  // A job's exit code IS its Cloud Run status.
  if (counters.failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  log.error("FATAL", err);
  process.exit(1);
});
