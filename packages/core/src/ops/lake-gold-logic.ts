/**
 * `lake-gold` — build gold with the Dataform CLI. MONEY-1611.
 *
 * The pure half: argv -> the CLI invocation, and the CLI's output -> a
 * verdict. `scripts/jobs/lake-gold.ts` does the I/O and calls `main()` at
 * module scope, so a test cannot import it.
 *
 * ## WHY THE CLI, AND NOT THE MANAGED DATAFORM SERVICE
 *
 * Founder decision, 2026-09-23. The managed service compiles a Git BRANCH,
 * which needs a GitHub token nobody had created, and compiles whatever that
 * branch says at 06:00 — not what was deployed. The job runs the CLI against
 * the `dataform/` directory baked into the workers image, so the SQL it builds
 * is exactly the SQL of the release the job is pinned to, and the
 * `[build-provenance]` line names that commit.
 *
 * ## ONE ENVIRONMENT VALUE, FOUR PLACES IT HAS TO LAND
 *
 * `workflow_settings.yaml` defaults to QA (`defaultDataset: lake_gold_qa`,
 * `vars.env: qa`). A prod run must override the schema, the assertion schema
 * AND `vars.env`, and `includes/datasets.js` derives every silver read and gold
 * write from `vars.env` alone. All three are built here from ONE `--env`, so
 * they cannot disagree — the managed plan carried them as three hand-typed
 * fields of a release config. The assertion schema is not optional: left at
 * the QA default, a prod run writes its built-in assertion views into
 * `lake_gold_qa`, which `lake-dataform-prod@` cannot see, and the CLI then
 * tries to CREATE that dataset.
 *
 * ## THE EXIT CODE IS NOT TRUSTED ALONE
 *
 * CLI 3.0.0 returns 0 in two states that are not success: an `--actions` name
 * that matches nothing (it is DROPPED, the run executes nothing, "Running..."
 * and exit 0), and an unhandled rejection (its handler prints and never sets
 * a code). So the verdict needs BOTH a zero exit AND a transcript that shows
 * at least one action ran and none failed or was skipped.
 */
import { GCP_PROJECT_ID, type JobEnv } from "./gcp-secrets";
import { LAKE_REGION, datasetFor } from "./lake-layout";

export interface GoldArgs {
  env: JobEnv;
  /** Action names (`event_return_outcome`). Empty = the whole `gold` tag. */
  actions: string[];
  includeDeps: boolean;
  includeDependents: boolean;
  fullRefresh: boolean;
}

const BOOLEAN_FLAGS = {
  "--include-deps": "includeDeps",
  "--include-dependents": "includeDependents",
  "--full-refresh": "fullRefresh",
} as const;

/**
 * Parse the job's own flags. Every value is its own token because gcloud
 * splits `--args` on commas: `--args=--env,prod,--actions,event_return_outcome`.
 *
 * UNKNOWN FLAGS ARE REFUSED rather than forwarded. Forwarding would let
 * `--vars=env=qa` or `--default-schema=…` through, which is exactly the split
 * between the dataset a run reads and the one it writes that this module
 * exists to make impossible.
 *
 * `cloudRunJob` is `process.env.CLOUD_RUN_JOB`. Inside a job the SERVICE
 * ACCOUNT belongs to the job's `-{env}` suffix — `lake-dataform-prod@` can
 * write `lake_gold_prod` and nothing else — so `lake-gold-prod --env qa` is
 * refused up front, naming the job to run instead. Same rule as
 * `databaseUrlForEnv`.
 */
export function parseGoldArgs(
  argv: readonly string[],
  cloudRunJob?: string,
): GoldArgs {
  const out: GoldArgs = {
    env: "qa",
    actions: [],
    includeDeps: false,
    includeDependents: false,
    fullRefresh: false,
  };
  let env: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--env") env = argv[++i];
    else if (a === "--actions") {
      const name = argv[++i];
      // A BARE model name. CLI 3.0.0 matches a dotted name only against the
      // full `project.dataset.name`, and matches no wildcard at all — both
      // are DROPPED, not refused, and the run then executes nothing.
      if (!name || !/^[A-Za-z0-9_]+$/.test(name)) {
        throw new Error(`--actions needs one action name, got "${name ?? ""}"`);
      }
      out.actions.push(name);
    } else if (Object.hasOwn(BOOLEAN_FLAGS, a)) {
      // hasOwn, not `in`: `in` walks the prototype, so `constructor` and
      // `__proto__` were accepted as flags.
      out[BOOLEAN_FLAGS[a as keyof typeof BOOLEAN_FLAGS]] = true;
    } else {
      throw new Error(
        `unknown argument "${a}". Allowed: --env, --actions NAME (repeatable), ` +
          `${Object.keys(BOOLEAN_FLAGS).join(", ")}`,
      );
    }
  }
  if (env !== "qa" && env !== "prod") {
    throw new Error("--env must be qa or prod");
  }
  out.env = env;
  // Without --actions the job selects by `--tags gold`, and the CLI accepts
  // the dependency flags against a TAG too — so these would silently widen
  // the scheduled run instead of scoping a targeted one.
  if ((out.includeDeps || out.includeDependents) && out.actions.length === 0) {
    throw new Error("--include-deps / --include-dependents need --actions");
  }
  const suffix = cloudRunJob ? /-(qa|prod)$/.exec(cloudRunJob)?.[1] : undefined;
  if (suffix !== undefined && suffix !== env) {
    throw new Error(
      `--env ${env} inside Cloud Run job ${cloudRunJob}, whose service account ` +
        `writes ${datasetFor("lake_gold", suffix as JobEnv)} only. Execute ` +
        `${cloudRunJob!.replace(/-(qa|prod)$/, `-${env}`)} instead.`,
    );
  }
  return out;
}

/**
 * `.df-credentials.json`. NO `credentials` key on purpose: without one the
 * CLI's BigQuery client falls back to Application Default Credentials, which
 * inside Cloud Run is the job's own service account. A key file here would
 * be a second identity that beats the runtime one.
 */
export function goldCredentials(): { projectId: string; location: string } {
  return { projectId: GCP_PROJECT_ID, location: LAKE_REGION };
}

/**
 * The `dataform run` argv. The project dir comes FIRST and every array flag
 * is written `--flag=value`: `--actions` and `--tags` are yargs arrays, and a
 * space-separated value list swallows whatever token follows it.
 *
 * NO `--dry-run`, deliberately. In CLI 3.0.0 a dry run is neither read-only
 * nor informative here: after a table action dry-runs clean the runner calls
 * `setMetadata` — a REAL write of descriptions and labels — on a target that
 * exists, and on one that does not it fails with "Error setting metadata:
 * Cannot read properties of null", while every model downstream fails "Not
 * found" because nothing upstream was created. On an empty gold dataset it
 * validates the root models only and reports the rest as failures. The
 * image build compiles the project (workers/Dockerfile); a real run's
 * assertions check the data.
 */
export function goldCliArgs(
  args: GoldArgs,
  projectDir: string,
  credentialsPath: string,
): string[] {
  const gold = datasetFor("lake_gold", args.env);
  return [
    "run",
    projectDir,
    `--credentials=${credentialsPath}`,
    `--default-database=${GCP_PROJECT_ID}`,
    `--default-location=${LAKE_REGION}`,
    `--default-schema=${gold}`,
    `--assertion-schema=${gold}`,
    `--vars=env=${args.env}`,
    // The compile child is killed at 5 s by default, and a Cloud Run task
    // has one vCPU.
    "--timeout=60s",
    ...(args.actions.length > 0
      ? args.actions.map((a) => `--actions=${a}`)
      : ["--tags=gold"]),
    ...(args.includeDeps ? ["--include-deps"] : []),
    ...(args.includeDependents ? ["--include-dependents"] : []),
    ...(args.fullRefresh ? ["--full-refresh"] : []),
  ];
}

export interface GoldTally {
  /** Tables, views and incremental tables that built cleanly. */
  built: string[];
  assertionsPassed: string[];
  assertionsFailed: string[];
  /** Tables and operations that FAILED. Assertions are counted apart. */
  buildFailed: string[];
  /** Skipped because something upstream failed. */
  skipped: string[];
  /** Selected but `disabled: true` in their config — no task ran. */
  disabled: string[];
}

// CLI 3.0.0's `printExecutedAction`, one line per finished action, at column
// 0. The SQL of a failed task is echoed INDENTED, so anchoring at the line
// start cannot mistake a statement for a verdict.
const RESULT_LINE =
  /^(Table created|Operation completed successfully|Assertion passed|Assertion failed|Dataset creation failed|Operation failed|Skipping dataset creation|Skipping assertion execution|Skipping operation execution|Dataset creation disabled|Assertion execution disabled|Operation execution disabled):\s+(\S+)/;

export function tallyGoldOutput(output: string): GoldTally {
  const t: GoldTally = {
    built: [],
    assertionsPassed: [],
    assertionsFailed: [],
    buildFailed: [],
    skipped: [],
    disabled: [],
  };
  // eslint-disable-next-line no-control-regex
  for (const line of output.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    const m = RESULT_LINE.exec(line);
    if (!m) continue;
    const [, kind, target] = m as unknown as [string, string, string];
    if (kind.endsWith("disabled")) t.disabled.push(target);
    else if (kind.startsWith("Skipping")) t.skipped.push(target);
    else if (kind === "Assertion failed") t.assertionsFailed.push(target);
    else if (kind.startsWith("Assertion")) t.assertionsPassed.push(target);
    else if (kind.endsWith("failed")) t.buildFailed.push(target);
    else t.built.push(target);
  }
  return t;
}

export interface GoldVerdict {
  ok: boolean;
  /** Why the run is not a success. Empty when `ok`. */
  problems: string[];
  /** True problems' non-fatal cousins, logged at WARN. */
  warnings: string[];
}

export function goldVerdict(
  tally: GoldTally,
  cliExit: number,
  args: GoldArgs,
): GoldVerdict {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (cliExit !== 0) problems.push(`the Dataform CLI exited ${cliExit}`);
  if (tally.assertionsFailed.length > 0) {
    problems.push(
      `${tally.assertionsFailed.length} assertion(s) FAILED: ${tally.assertionsFailed.join(" ")}`,
    );
  }
  if (tally.buildFailed.length > 0) {
    problems.push(
      `${tally.buildFailed.length} action(s) failed to build: ${tally.buildFailed.join(" ")}`,
    );
  }
  if (tally.skipped.length > 0) {
    problems.push(
      `${tally.skipped.length} action(s) skipped behind a failure: ${tally.skipped.join(" ")}`,
    );
  }
  const ran =
    tally.built.length +
    tally.assertionsPassed.length +
    tally.assertionsFailed.length +
    tally.buildFailed.length;
  if (ran === 0) {
    problems.push(
      "no action ran. An --actions name that matches nothing is DROPPED by the " +
        "CLI, which then runs nothing and exits 0 — check the spelling",
    );
  }
  // Per NAME, not just "something ran": `--actions rolling_stats --actions
  // event_retrun_outcome` builds rolling_stats and silently drops the typo.
  const reached = new Set(
    [
      ...tally.built,
      ...tally.assertionsPassed,
      ...tally.assertionsFailed,
      ...tally.buildFailed,
      ...tally.skipped,
    ].map((target) => target.split(".").pop()),
  );
  for (const name of args.actions) {
    if (!reached.has(name)) {
      problems.push(`\`${name}\` did not run (dropped by the CLI)`);
    }
  }
  if (tally.disabled.length > 0) {
    warnings.push(
      `${tally.disabled.length} action(s) are DISABLED in their config and ran ` +
        `nothing: ${tally.disabled.join(" ")}`,
    );
  }
  if (
    args.actions.length > 0 &&
    tally.built.length > 0 &&
    tally.assertionsPassed.length + tally.assertionsFailed.length === 0
  ) {
    warnings.push(
      "a targeted run rebuilt tables and checked NOTHING. Assertions depend on " +
        "their model, so add --include-dependents to run them",
    );
  }
  return { ok: problems.length === 0, problems, warnings };
}

/**
 * The silver tables gold READS — exactly the `declare(...)` calls in
 * dataform/definitions/silver_views/declarations.js, held in agreement by
 * lake-gold-job.test.ts.
 */
export const GOLD_SILVER_INPUTS = [
  "price_bar_d1",
  "corporate_action",
  "listing",
  "instrument_event",
  "index_eod",
] as const;

/**
 * How recently a gold input must have been WRITTEN, in any claim state, for a
 * reload walk to count as still in progress. A replay claims one month, loads
 * it, ACCEPTs it (stamping `loaded_at`) and claims the next, so between two
 * months there is no LOADING row at all — measured on prod 2026-09-23, the
 * live US replay showed one LOADING row for price_bar_d1 at age 0 min. A gate
 * on LOADING alone passes in that gap and the walk then deletes the next month
 * UNDER the build. Thirty minutes is several times the slowest per-month cycle
 * the replays have logged (~106 s India bars, 136-298 s F&O).
 */
export const GOLD_QUIET_MS = 30 * 60_000;

/**
 * Silver inputs that are MID-RELOAD — the gate that keeps a build off them.
 *
 * A month load DELETEs and then LOADs (packages/lake/src/load.ts), and the pair
 * is not atomic. A build between the two reads the month as EMPTY, and for
 * `event_return_outcome` that is not self-healing: its COMPLETE rows older
 * than the incremental window are never re-read, so a gap computed tonight is
 * kept. So a reload in progress on any input skips the run; the next slot
 * builds.
 *
 * "In progress" is a LIVE LOADING claim — same lease arithmetic as the
 * ledger's `decideClaim` and `sync-prod-to-qa.sh`, `now - loaded_at <=
 * CLAIM_LEASE_MS` — OR any claim written within `GOLD_QUIET_MS` (a walk between
 * two months). The lease is a PARAMETER because it lives in packages/lake,
 * which core does not import; the job passes `CLAIM_LEASE_MS` and the spawn
 * test pins what it sent.
 *
 * What it cannot see: a reload STARTED after the build began, and the three
 * unclaimed silver writers (identity-sync, corp-action-lake-sink,
 * event-lake-sink). Hence the ORDER note in setup-dataform.sh: after any
 * historical replay, full-refresh `event_return_outcome`.
 */
export function goldLoadingQuery(
  env: JobEnv,
  leaseMs: number,
): {
  query: string;
  params: { dataset: string; tables: string[]; lease: number; quiet: number };
} {
  return {
    // `clears_at`: when THIS table stops matching, if nothing new is claimed —
    // a live claim's lease end, otherwise 30 min after the newest claim. A
    // live claim ACCEPTED sooner re-stamps `loaded_at`, so for it this is an
    // upper bound; for a quiet-window match it is exact.
    query: `SELECT \`table\`, STRING_AGG(DISTINCT partition_key, ', ' ORDER BY partition_key) AS partitions,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(IF(
    state = 'LOADING' AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), loaded_at, MILLISECOND) <= @lease,
    TIMESTAMP_ADD(loaded_at, INTERVAL @lease MILLISECOND),
    TIMESTAMP_ADD(loaded_at, INTERVAL @quiet MILLISECOND)))) AS clears_at
FROM \`${GCP_PROJECT_ID}.${datasetFor("lake_bronze", env)}.partition_load\`
WHERE dataset = @dataset AND \`table\` IN UNNEST(@tables)
  AND ((state = 'LOADING' AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), loaded_at, MILLISECOND) <= @lease)
    OR TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), loaded_at, MILLISECOND) <= @quiet)
GROUP BY \`table\`
ORDER BY \`table\``,
    params: {
      dataset: datasetFor("lake_silver", env),
      tables: [...GOLD_SILVER_INPUTS],
      lease: leaseMs,
      quiet: GOLD_QUIET_MS,
    },
  };
}

/** One row of `goldLoadingQuery`. `clearsAt` is an ISO-8601 UTC instant. */
export interface GoldLoadingRow {
  table: string;
  partitions: string;
  clearsAt: string;
}

export interface GoldLoadingSkip {
  /** `SKIPPED_LOADING <table>: <partitions>`, one per mid-reload input. */
  lines: string[];
  /** The latest `clearsAt`: the gate cannot pass before this. */
  retryAfter: string;
  /** Asked for something specific — the deployed args will not redo it. */
  targeted: boolean;
  exitCode: 0 | 1;
  /** `skipped_loading` or `skipped_loading_targeted`, for the outcome. */
  reason: string;
}

/**
 * What a mid-reload skip MEANS depends on what the run was asked to do.
 *
 * A plain scheduled run (no --actions, no --full-refresh) exits 0: the next
 * slot runs the same args and builds. A TARGETED run exits 1. The documented
 * step after a replay is `--full-refresh --actions event_return_outcome`, and
 * it is exactly the run most likely to land inside the 30-min quiet window the
 * replay leaves behind; skipped with exit 0, the next scheduled slot runs the
 * DEPLOYED incremental args and the full refresh silently never happens.
 */
export function goldLoadingSkip(
  rows: ReadonlyArray<GoldLoadingRow>,
  args: GoldArgs,
): GoldLoadingSkip {
  const targeted = args.actions.length > 0 || args.fullRefresh;
  // ISO-8601 UTC at one fixed width sorts as a string.
  const retryAfter = rows
    .map((r) => r.clearsAt)
    .reduce((a, b) => (b > a ? b : a), "");
  const tables = rows.map((r) => r.table).join(", ");
  return {
    lines: rows.map((r) => `SKIPPED_LOADING ${r.table}: ${r.partitions}`),
    retryAfter,
    targeted,
    exitCode: targeted ? 1 : 0,
    reason: targeted
      ? `skipped_loading_targeted: ${tables}; retry after ${retryAfter}`
      : `skipped_loading: ${tables}`,
  };
}
