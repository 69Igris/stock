/**
 * `lake-gold` — build gold: run the Dataform CLI over `dataform/`. MONEY-1611.
 *
 * Replaces the managed Dataform service `setup-dataform.sh` used to provision
 * (founder decision, 2026-09-23, option B). No Git connection, no token: the
 * CLI compiles the `dataform/` directory baked into THIS image, so the SQL
 * built is the SQL of the release the job is pinned to — and the
 * `[build-provenance]` line names that commit. The argv mapping and the verdict
 * are pure and tested: `packages/core/src/ops/lake-gold-logic.ts`.
 *
 * ## Usage (the job's --args; gcloud splits them on commas)
 *
 *   --env qa|prod                    required; must match the job's suffix
 *   --actions NAME                   one model, repeatable; default: tag `gold`
 *   --include-deps                   with --actions: also build what it reads
 *   --include-dependents             with --actions: also build what reads it,
 *                                    INCLUDING its assertions
 *   --full-refresh                   rebuild incremental tables from scratch
 *
 * There is no dry-run mode; `goldCliArgs` says why.
 *
 * ## It will not build over a silver table that is MID-RELOAD
 *
 * Before the CLI starts, the job reads the lake ledger for live LOADING claims
 * on the silver tables gold reads (`goldLoadingQuery`). A month load deletes
 * and then loads, not atomically, so a build in between reads the month as
 * empty — and `event_return_outcome` keeps what it computed. Any live claim
 * prints `SKIPPED_LOADING <table>: <partitions>`. A plain scheduled run then
 * exits 0: a slot during a backfill is expected, and the next slot builds. A
 * TARGETED run (--actions or --full-refresh) exits 1 and prints when to retry,
 * because the deployed args would never redo it (`goldLoadingSkip`).
 *
 * ## Exit codes
 *
 *   0  every selected action built and every assertion passed, OR a plain
 *      scheduled run was skipped because an input is mid-reload
 *      (`skipped_loading`)
 *   1  anything else — a failed assertion, a failed build, a skipped action,
 *      a requested action that did not run, a TARGETED run skipped because an
 *      input is mid-reload (`skipped_loading_targeted`), an unreadable ledger,
 *      a refused argument, or the CLI missing
 *   3  guardCompletion: main() never settled (MONEY-1608)
 *
 * Runs as `lake-dataform-{env}@` (gold WRITER, silver READER, jobUser, and READ
 * on `lake_bronze_{env}.partition_load` ALONE), provisioned by
 * `scripts/ops/setup-dataform.sh`.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BigQuery } from "@google-cloud/bigquery";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { GCP_PROJECT_ID } from "@usemoney/core/ops/gcp-secrets";
import { LAKE_REGION } from "@usemoney/core/ops/lake-layout";
import { guardCompletion } from "@usemoney/core/ops/job-completion";
import {
  goldCliArgs,
  goldCredentials,
  goldLoadingQuery,
  goldLoadingSkip,
  goldVerdict,
  parseGoldArgs,
  tallyGoldOutput,
  type GoldLoadingRow,
} from "@usemoney/core/ops/lake-gold-logic";
import { CLAIM_LEASE_MS } from "@usemoney/lake/ledger-logic";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { flushMetrics } from "@usemoney/datadog/metrics";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const JOB = "lake-gold";

/** `scripts/jobs/` in the repo and `workers/dist/` in the image are both two
 *  levels below the directory that holds `dataform/`. */
const PROJECT_DIR = fileURLToPath(new URL("../../dataform", import.meta.url));

const log = {
  info: (...a: unknown[]) => console.log(`[${JOB}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${JOB}]`, ...a),
  error: (...a: unknown[]) => console.error(`[${JOB}]`, ...a),
};

/**
 * Run the CLI, streaming its output through and keeping a copy to tally.
 *
 * ONE BUFFER PER STREAM. Chunks of stdout and stderr arrive interleaved, so a
 * single buffer can splice a stderr chunk into the middle of a stdout line and
 * the tally loses that line's verdict.
 *
 * `npm_config_offline`: the CLI `npm i`s `@dataform/core` into a temp copy of
 * the project on EVERY compile. The image caches that exact version
 * (workers/Dockerfile), and offline makes a cache miss an error instead of a
 * silent fetch of code at run time. `NO_COLOR` keeps the transcript parseable.
 */
function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("dataform", args, {
      env: { ...process.env, NO_COLOR: "1", npm_config_offline: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      process.stdout.write(b);
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      process.stderr.write(b);
      stderr += b.toString("utf8");
    });
    child.on("error", (e) =>
      reject(
        new Error(
          `could not start the Dataform CLI (${e.message}). The workers image links ` +
            "it from tools/dataform-cli; locally, put a 3.0.0 `dataform` on PATH",
        ),
      ),
    );
    // A signal leaves `code` null: that is a failure, never a 0.
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Live LOADING claims on gold's silver inputs, or `null` when the ledger could
 * not be read. "Could not ask" is not "nothing is loading", so the caller
 * refuses to build on `null` rather than treating it as clear.
 */
async function readLiveLoading(
  env: "qa" | "prod",
): Promise<GoldLoadingRow[] | null> {
  const { query, params } = goldLoadingQuery(env, CLAIM_LEASE_MS);
  try {
    const bq = new BigQuery({
      projectId: GCP_PROJECT_ID,
      location: LAKE_REGION,
    });
    const [rows] = await bq.query({ query, params, location: LAKE_REGION });
    return (
      rows as Array<{ table: string; partitions: string; clears_at: string }>
    ).map((r) => ({
      table: String(r.table),
      partitions: String(r.partitions),
      clearsAt: String(r.clears_at),
    }));
  } catch (err) {
    log.error(`ledger read failed: ${(err as Error).message}`);
    return null;
  }
}

async function main(): Promise<number> {
  await initJobTelemetry();
  reportBuildProvenance(log, JOB);
  const args = parseGoldArgs(process.argv.slice(2), process.env.CLOUD_RUN_JOB);

  const loading = await readLiveLoading(args.env);
  if (loading === null) {
    const reason = `ledger_unreadable: lake_bronze_${args.env}.partition_load`;
    log.error(
      `FAILED could not read lake_bronze_${args.env}.partition_load, so a build ` +
        "over a silver table that is mid-reload cannot be ruled out. Not building.",
    );
    reportJobOutcome({
      job: JOB,
      selected: 0,
      written: 0,
      unhealthy: true,
      skippedReason: reason,
    });
    await flushMetrics();
    return 1;
  }
  if (loading.length > 0) {
    const skip = goldLoadingSkip(loading, args);
    for (const line of skip.lines) log.warn(`WARN ${line}`);
    if (skip.targeted) {
      // The deployed args will not redo a targeted run, so this one must be
      // seen: a non-zero exit, and when the same --args can succeed.
      log.error(
        `FAILED a targeted run (${[
          ...args.actions.map((a) => `--actions ${a}`),
          ...(args.fullRefresh ? ["--full-refresh"] : []),
        ].join(" ")}) was NOT run: a silver input is ` +
          `mid-reload. Retry after ${skip.retryAfter} with the same --args (a live ` +
          "LOADING claim counts to its lease end; accepted sooner, it clears 30 min " +
          "after that).",
      );
    } else {
      log.info(
        `outcome skipped_loading — a silver input is mid-reload; the next slot ` +
          `builds (estimated clear at ${skip.retryAfter})`,
      );
    }
    reportJobOutcome({
      job: JOB,
      selected: 0,
      written: 0,
      unhealthy: skip.targeted,
      skippedReason: skip.reason,
    });
    await flushMetrics();
    return skip.exitCode;
  }

  const credentialsPath = join(
    mkdtempSync(join(tmpdir(), "lake-gold-")),
    "df-credentials.json",
  );
  writeFileSync(credentialsPath, JSON.stringify(goldCredentials()));
  const cliArgs = goldCliArgs(args, PROJECT_DIR, credentialsPath);
  log.info(`RUN env=${args.env} — dataform ${cliArgs.join(" ")}`);

  const { code, stdout, stderr } = await runCli(cliArgs);
  const tally = tallyGoldOutput(`${stdout}\n${stderr}`);
  const verdict = goldVerdict(tally, code, args);
  for (const w of verdict.warnings) log.warn(`WARNING ${w}`);
  for (const p of verdict.problems) log.error(`FAILED ${p}`);
  log.info(
    `outcome ${JSON.stringify({
      env: args.env,
      actions: args.actions,
      fullRefresh: args.fullRefresh,
      cliExit: code,
      built: tally.built.length,
      assertionsPassed: tally.assertionsPassed.length,
      assertionsFailed: tally.assertionsFailed.length,
      buildFailed: tally.buildFailed.length,
      skipped: tally.skipped.length,
      disabled: tally.disabled.length,
      ok: verdict.ok,
    })}`,
  );

  // Counted in ACTIONS: a table built or an assertion that passed is
  // "written"; a failure or a skip behind one is "failed".
  const failed =
    tally.assertionsFailed.length +
    tally.buildFailed.length +
    tally.skipped.length;
  reportJobOutcome({
    job: JOB,
    selected: tally.built.length + tally.assertionsPassed.length + failed,
    written: tally.built.length + tally.assertionsPassed.length,
    failed,
    unhealthy: !verdict.ok,
    ...(verdict.ok ? {} : { skippedReason: verdict.problems.join("; ") }),
  });
  await flushMetrics();
  return verdict.ok ? 0 : 1;
}

guardCompletion(JOB, main()).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`[${JOB}] FAILED: ${(err as Error).message}`);
    process.exit(1);
  },
);
