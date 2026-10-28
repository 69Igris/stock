/**
 * What commit is this Cloud Run JOB actually running? — MONEY-1205 T5.
 *
 * ## The bug class
 *
 * Cloud Run JOBS pin their image at provision time. `setup-feed-backfill-job.sh`
 * reads the image off the LIVE SERVICE once (`gcloud run services describe …
 * containers[0].image`) and bakes that tag into the job spec. Redeploying the
 * SERVICE afterwards does not move the JOB. Nothing re-points it until somebody
 * re-runs the setup script, and nobody re-runs a setup script on a Tuesday.
 *
 * Measured 2026-08-18:
 *
 *   feed-parse-prod  image  = stockbook-workers:prod-fbdc29e2   (built 14-Aug)
 *   #325 (bond parsing)     = merged 16-Aug
 *   prod SERVICE image      = stockbook-workers:prod-d7eefba7   (built 18-Aug)
 *
 * So `feed-parse-prod` ran every weeknight, exited 0, reported
 * `SUCCEEDED_COUNT 1`, and skipped four bond feed families it had never heard
 * of. `bond_master` and `bond_eod` are 0 rows because of it. Nothing in the logs
 * said which commit produced that "success" — the job's own output was the same
 * shape on stale code as on fresh code.
 *
 * This is the SECOND time the class has hit a nightly job here. MONEY-1189's fix
 * shipped and then sat un-executed on the nightly jobs for the same reason.
 *
 * ## Why the fix lives at RUNTIME and not in the setup script
 *
 * A check inside `setup-feed-backfill-job.sh` only fires when somebody runs
 * setup, which is precisely the thing that was not happening. The drift bites at
 * 22:35 IST on a night nobody is watching, so that is where the fact has to be
 * emitted. `reportBuildProvenance()` costs one log line per job start and turns
 * "which commit produced this SUCCEEDED?" from unanswerable into a grep.
 *
 * ## Where the SHA comes from — the existing mechanism, not a new one
 *
 * `workers/Dockerfile`:
 *
 *     ARG DD_VERSION=unknown
 *     ENV DD_VERSION=${DD_VERSION}
 *
 * and `workers/cloudbuild.prod.yaml` builds with
 *
 *     -t gcr.io/$PROJECT_ID/stockbook-workers:prod-$COMMIT_SHA
 *     --build-arg DD_VERSION=$COMMIT_SHA
 *
 * The SAME `$COMMIT_SHA` forms the image tag and the baked `DD_VERSION`. So
 * `process.env.DD_VERSION` inside a running container is the commit that image
 * was BUILT from — a property of the image layer, not of the job spec. That
 * matters: `gcloud run jobs deploy --set-env-vars` rewrites only the job's own
 * env list and cannot forge this value, so a stale job cannot report a fresh
 * SHA. No new env var, no `--build-arg` change, no setup-script change is needed
 * for a job to answer the question.
 *
 * ## Why "unavailable" is reported as a FAILURE, not skipped
 *
 * Three real paths in this repo produce an image with no usable SHA:
 *
 *   - `workers/cloudbuild.yaml` (the parameterised `_ENV` config) never passed
 *     `--build-arg DD_VERSION` at all → the Dockerfile default `unknown` wins.
 *     (Fixed on this branch, but the class remains: it took one missing line.)
 *   - `scripts/ops/update-prod-analysis-engine.sh` computes `COMMIT_SHA` and
 *     then omits it from the prod `gcloud builds submit` → `DD_VERSION=""` and
 *     an image tagged `prod-`.
 *   - `scripts/ops/setup-infra.sh` substitutes `<short-sha>-<timestamp>`, which
 *     is a SHA with a suffix and must still parse.
 *
 * An "I could not determine the version" that logs at info and returns a truthy
 * result is the same silence the guard exists to break — it would read as a pass
 * in exactly the case where nothing is known. So the absent/placeholder cases
 * are their own outcome, they are reported at ERROR, and `compareDeployedVersion`
 * returns `indeterminate` rather than `match` whenever either side is unusable.
 *
 * ## Do NOT set EXPECTED_BUILD_SHA from setup-feed-backfill-job.sh
 *
 * The steady state today is the WARN branch: the SHA is known, nothing declares
 * what it SHOULD be, so the verdict is `indeterminate`. That permanent WARN is
 * tempting to "fix" by having the setup script pass
 * `--set-env-vars EXPECTED_BUILD_SHA=<sha from $IMAGE>`. It would turn every log
 * line green and detect NOTHING.
 *
 * Reason: the script pins the job image by reading it off the LIVE SERVICE
 * (`gcloud run services describe … containers[0].image`) and then deploys the
 * job with that image. Both values would come from the same read on the same
 * run, so `EXPECTED_BUILD_SHA` would equal the image's own baked `DD_VERSION` by
 * construction — on the day it is provisioned AND every day afterwards, because
 * neither moves. The drift being hunted is between the job and the SERVICE AS OF
 * TONIGHT, and nothing set at provision time can observe tonight. A green that
 * cannot go red is worse than the WARN it replaced, because the WARN at least
 * carries the SHA.
 *
 * An honest `EXPECTED_BUILD_SHA` has to be written by something that runs AFTER
 * a release — i.e. by the pipeline that rebuilds the service. At which point the
 * cheaper and more direct fix is for that same pipeline to re-point the job's
 * image, which removes the drift instead of reporting it. That is the
 * recommended operational change; this module is what makes the drift visible
 * until it lands, and the safety net afterwards.
 *
 * ## Why it does not refuse to run
 *
 * A nightly job that aborts because it is one commit behind is worse than the
 * disease: it converts a partial run into no run, on a schedule with no human
 * present, and it would have made the ACTUAL incident worse (the job was doing
 * useful non-bond work the whole time). Default is report-only. The opt-in lever
 * is `BUILD_PROVENANCE_STRICT` (see `shouldBlockStartup`), for a caller that has
 * decided a wrong-version run is worse than a skipped run.
 */

/** The Dockerfile's `ARG DD_VERSION=unknown` default and friends. */
const PLACEHOLDER_VERSIONS = new Set([
  "unknown",
  "manual",
  "latest",
  "none",
  "null",
  "undefined",
  "dev",
  "development",
  "local",
  // `packages/datadog/src/tracer.ts` falls back to this when DD_VERSION is
  // unset, so it can appear in copied config as if it were a real version.
  "1.0.0",
  "0.0.0",
]);

/**
 * A git SHA, optionally with the `-<timestamp>` suffix `setup-infra.sh` appends
 * (`git rev-parse --short HEAD` + `date +%Y%m%d%H%M%S`).
 *
 * Seven is the floor because that is git's shortest conventional abbreviation
 * and the shortest thing two independently-abbreviated SHAs can be compared on
 * without inviting collisions.
 */
const SHA_RE = /^([0-9a-f]{7,40})(?:-(\d{6,}))?$/;

export const MIN_SHA_CHARS = 7;

export type BuildShaParse =
  | { kind: "sha"; sha: string; raw: string; suffix?: string }
  | { kind: "absent"; raw: string | undefined; reason: string };

/**
 * Turn a raw `DD_VERSION`-shaped string into either a usable SHA or an explicit
 * "no version, and here is why".
 *
 * There is deliberately no third "probably fine" branch. Anything this cannot
 * positively identify as a SHA is `absent`, because a guard that guesses is a
 * guard that reports success on an image it could not identify.
 */
/**
 * Why each variable might legitimately be missing, and what to do about it.
 *
 * Kept per-variable because the two causes are unrelated: DD_VERSION missing is
 * a BUILD defect, EXPECTED_BUILD_SHA missing is just "nobody wired an expected
 * version yet". Sharing one sentence sent readers of the second case off to
 * inspect the build.
 */
const NOT_SET_HINTS: Record<string, string> = {
  DD_VERSION:
    "this image was not built by workers/cloudbuild.*.yaml (which pass --build-arg DD_VERSION=$COMMIT_SHA)",
  EXPECTED_BUILD_SHA:
    "nothing in this environment declares which build the job SHOULD be on, so drift cannot be detected automatically — only reported",
};

export function parseBuildSha(
  raw: string | undefined,
  /**
   * Which env var this value came from, so the reason names the right one.
   *
   * Not cosmetic. This function is used for BOTH sides of the comparison, and
   * with the name hardcoded a missing `EXPECTED_BUILD_SHA` reported "DD_VERSION
   * is not set" — pointing whoever reads it at the one variable that was
   * actually fine. Caught by running the built job binary, not by a unit test,
   * which is why there is now a unit test for it.
   */
  varName = "DD_VERSION",
): BuildShaParse {
  const hint =
    NOT_SET_HINTS[varName] ?? "no build version is available from this source";

  if (raw === undefined || raw === null) {
    return { kind: "absent", raw, reason: `${varName} is not set — ${hint}` };
  }

  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      kind: "absent",
      raw,
      reason: `${varName} is empty — the build submitted no COMMIT_SHA substitution (see update-prod-analysis-engine.sh, which tags the image \`prod-\`)`,
    };
  }

  const lowered = trimmed.toLowerCase();
  if (PLACEHOLDER_VERSIONS.has(lowered)) {
    return {
      kind: "absent",
      raw,
      reason: `${varName} is the placeholder "${trimmed}" — the image was built without --build-arg DD_VERSION, so workers/Dockerfile's ARG default won`,
    };
  }

  const m = SHA_RE.exec(lowered);
  if (!m) {
    return {
      kind: "absent",
      raw,
      reason: `${varName} "${trimmed}" is not a recognisable git SHA (expected ${MIN_SHA_CHARS}-40 hex chars, optionally followed by -<timestamp>)`,
    };
  }

  return m[2] === undefined
    ? { kind: "sha", sha: m[1]!, raw: trimmed }
    : { kind: "sha", sha: m[1]!, raw: trimmed, suffix: m[2] };
}

export type VersionVerdict =
  | { status: "match"; sha: string; comparedChars: number }
  | { status: "drift"; jobSha: string; expectedSha: string }
  | { status: "indeterminate"; reason: string };

/**
 * Compare the SHA a job is RUNNING against the SHA it SHOULD be running.
 *
 * Prefix comparison, not equality: the two sides legitimately arrive at
 * different abbreviations. Cloud Build triggers substitute the full 40-char
 * `$COMMIT_SHA`, while `setup-infra.sh` and `workers/scripts/deploy.sh` use
 * `git rev-parse --short HEAD`. Demanding equality would report permanent drift
 * between two names for the same commit — a guard that cries wolf gets muted,
 * and a muted guard is the state we started in.
 *
 * `indeterminate` is a distinct outcome and never collapses into `match`. This
 * is the "never cache a fail-open default" rule applied to a comparison: "I
 * could not tell" and "they agree" must not be the same value, because the
 * caller's severity mapping depends on telling them apart.
 */
export function compareDeployedVersion(
  jobRaw: string | undefined,
  expectedRaw: string | undefined,
): VersionVerdict {
  const job = parseBuildSha(jobRaw, "DD_VERSION");
  const expected = parseBuildSha(expectedRaw, "EXPECTED_BUILD_SHA");

  if (job.kind === "absent" && expected.kind === "absent") {
    return {
      status: "indeterminate",
      reason: `neither side is a usable SHA — running: ${job.reason}; expected: ${expected.reason}`,
    };
  }
  if (job.kind === "absent") {
    return {
      status: "indeterminate",
      reason: `cannot identify the running build — ${job.reason}`,
    };
  }
  if (expected.kind === "absent") {
    return {
      status: "indeterminate",
      reason: `nothing to compare against — ${expected.reason}`,
    };
  }

  const n = Math.min(job.sha.length, expected.sha.length);
  if (n < MIN_SHA_CHARS) {
    return {
      status: "indeterminate",
      reason: `shortest SHA is ${n} chars, below the ${MIN_SHA_CHARS}-char floor needed for a safe prefix comparison`,
    };
  }

  return job.sha.slice(0, n) === expected.sha.slice(0, n)
    ? { status: "match", sha: job.sha, comparedChars: n }
    : { status: "drift", jobSha: job.sha, expectedSha: expected.sha };
}

export type ProvenanceSeverity = "error" | "warn" | "info";

/** Just the env keys this module reads — keeps callers and tests honest. */
export interface ProvenanceEnv {
  DD_VERSION?: string | undefined;
  /**
   * The SHA this job is EXPECTED to be running, when a deploy pipeline is in a
   * position to inject one. Unset is the normal case today and yields
   * `indeterminate` (reported, not passed) rather than silence.
   */
  EXPECTED_BUILD_SHA?: string | undefined;
  /** Cloud Run sets these on JOB executions. */
  CLOUD_RUN_JOB?: string | undefined;
  CLOUD_RUN_EXECUTION?: string | undefined;
  CLOUD_RUN_TASK_INDEX?: string | undefined;
  DD_ENV?: string | undefined;
  NODE_ENV?: string | undefined;
  BUILD_PROVENANCE_STRICT?: string | undefined;
}

export interface ProvenanceReport {
  severity: ProvenanceSeverity;
  verdict: VersionVerdict;
  build: BuildShaParse;
  /** Caller-supplied entrypoint name, e.g. "feed-parse". */
  entrypoint: string;
  /** Cloud Run's job name when running as a JOB, else "not-a-cloud-run-job". */
  jobName: string;
  message: string;
  fields: Record<string, string>;
}

const UNIDENTIFIED = "unidentified";

/**
 * Build the one line a job should emit at startup.
 *
 * Pure: takes the env, returns the report. The message is prefixed
 * `[build-provenance]` and carries an UPPERCASE severity token, so it stays
 * greppable and stays honest even when it reaches a logger that has no `error`
 * channel (the job entrypoints in `scripts/jobs/` each define a two-method
 * `{info, warn}` console shim).
 */
/**
 * Which provisioning script re-points a given job at the live service image.
 *
 * MONEY-1314. Both remediation lines below used to hardcode
 * `setup-feed-backfill-job.sh` for EVERY entry point, which is the right
 * script for exactly one of them. Deriving `setup-${entrypoint}-job.sh`
 * instead is right for six of eleven and names a file that DOES NOT EXIST for
 * the other five — worse, because it sends whoever is reading the alert on a
 * hunt instead of to a wrong-but-real script.
 *
 * So it is a map, and `job-build-provenance.test.ts` asserts every value here
 * is a real file. A guessed path in an alert is a guess the reader cannot see.
 */
const SETUP_SCRIPT_BY_ENTRYPOINT: Readonly<Record<string, string>> = {
  // MONEY-1467 — both tile builders are provisioned by one script.
  "tile-build-d1-in": "setup-tile-build-job.sh",
  "tile-build-d1-us": "setup-tile-build-job.sh",
  // The feed family is provisioned together by one script.
  "feed-backfill": "setup-feed-backfill-job.sh",
  "feed-parse": "setup-feed-backfill-job.sh",
  "feed-repair": "setup-feed-backfill-job.sh",
  "fo-summary": "setup-feed-backfill-job.sh",
  "xbrl-backfill": "setup-xbrl-backfill-job.sh",
  "xbrl-projection-drain": "setup-xbrl-projection-drain-job.sh",
  "xbrl-reparse": "setup-xbrl-reparse-job.sh",
  "bse-backfill": "setup-bse-backfill-job.sh",
  "doc-ingest-backfill": "setup-doc-ingest-backfill-job.sh",
  // Both Tiingo entry points ride the one backfill job spec.
  "tiingo-us-backfill": "setup-tiingo-backfill-job.sh",
  "tiingo-us-corp-actions-backfill": "setup-tiingo-backfill-job.sh",
  "tiingo-us-news-seed": "setup-tiingo-backfill-job.sh",
  // MONEY-1373 — both Databento entry points ride the one setup script.
  "databento-harvest": "setup-databento-jobs.sh",
  "databento-append": "setup-databento-jobs.sh",
  // MONEY-1472 (B1) — the lake ledger backfill rides the same setup script as
  // the two Databento jobs whose failed mirrors it repairs.
  "ledger-backfill-databento": "setup-databento-jobs.sh",
  // MONEY-1505 (B5) — the lake bar loader rides it too: same image, same
  // service account, same bucket, and it reads the inventory those jobs write.
  "lake-load-databento": "setup-databento-jobs.sh",
  // The Tiingo corp-action ledger backfill rides the Tiingo job script.
  "ledger-backfill-tiingo": "setup-tiingo-backfill-job.sh",
  // MONEY-1499 (B8) — the v1 -> v2 embedding migration.
  "embeddings-v2-backfill": "setup-embeddings-v2-job.sh",
  // MONEY-1518 (B7) and MONEY-1521 — the two jobs that run as
  // `lake-writer-{env}@` share one provisioner: one SA, one set of grants.
  "lake-release": "setup-lake-jobs.sh",
  "event-lake-sink": "setup-lake-jobs.sh",
  // MONEY-1609 — the long lake loads, same SA and provisioner.
  "lake-replay-in": "setup-lake-jobs.sh",
  "lake-replay-us": "setup-lake-jobs.sh",
  "filing-registry-sync": "setup-lake-jobs.sh",
  "corp-action-lake-sink": "setup-lake-jobs.sh",
  "identity-sync": "setup-lake-jobs.sh",
  // MONEY-1611 — the gold build runs as `lake-dataform-{env}@`, not the lake
  // writer, so it has its own provisioner (which also owns its schedules).
  "lake-gold": "setup-dataform.sh",
};

/**
 * The remediation path for an entry point.
 *
 * An UNKNOWN entry point gets an honest instruction rather than an invented
 * filename: a new job that nobody has mapped is exactly the case where a
 * confident wrong path costs the most.
 */
export function setupScriptFor(entrypoint: string): string {
  const named = SETUP_SCRIPT_BY_ENTRYPOINT[entrypoint];
  return named
    ? `scripts/ops/${named}`
    : `this job's own scripts/ops/setup-*-job.sh (unmapped entry point — add it to SETUP_SCRIPT_BY_ENTRYPOINT)`;
}

export function buildProvenanceReport(
  env: ProvenanceEnv,
  entrypoint: string,
): ProvenanceReport {
  const build = parseBuildSha(env.DD_VERSION);
  const verdict = compareDeployedVersion(
    env.DD_VERSION,
    env.EXPECTED_BUILD_SHA,
  );
  const jobName = env.CLOUD_RUN_JOB?.trim() || "not-a-cloud-run-job";
  const deployEnv = env.DD_ENV?.trim() || env.NODE_ENV?.trim() || "unset";

  const fields: Record<string, string> = {
    entrypoint,
    job: jobName,
    env: deployEnv,
    buildSha: build.kind === "sha" ? build.sha : UNIDENTIFIED,
    verdict: verdict.status,
  };
  if (env.CLOUD_RUN_EXECUTION) fields.execution = env.CLOUD_RUN_EXECUTION;

  // The running build is unidentifiable. This is the loudest case on purpose:
  // an unversioned image is one whose behaviour cannot be reasoned about at
  // all, which is strictly worse than a known-stale one.
  if (build.kind === "absent") {
    return {
      severity: "error",
      verdict,
      build,
      entrypoint,
      jobName,
      fields,
      message:
        `[build-provenance] ERROR ${entrypoint} cannot identify the commit it is running. ` +
        `${build.reason}. Cloud Run JOBS pin their image at provision time and a ` +
        `deploy of the SERVICE does not move them, so an unidentifiable build ` +
        `cannot be told apart from a stale one. Re-run ` +
        `${setupScriptFor(entrypoint)} ` +
        `for this environment to re-point the job at the live service image.`,
    };
  }

  if (verdict.status === "drift") {
    return {
      severity: "error",
      verdict,
      build,
      entrypoint,
      jobName,
      fields: { ...fields, expectedSha: verdict.expectedSha },
      message:
        `[build-provenance] ERROR ${entrypoint} is running build ${verdict.jobSha} ` +
        `but ${verdict.expectedSha} was expected. This job's image is pinned and ` +
        `did NOT move when the service was redeployed. It will run to completion ` +
        `and report success on stale code — that is how bond_master/bond_eod ` +
        `stayed at 0 rows (MONEY-1205). Re-run ${setupScriptFor(entrypoint)}.`,
    };
  }

  if (verdict.status === "indeterminate") {
    return {
      severity: "warn",
      verdict,
      build,
      entrypoint,
      jobName,
      fields,
      message:
        `[build-provenance] WARN ${entrypoint} is running build ${build.sha}, ` +
        `NOT VERIFIED against an expected version — ${verdict.reason}. ` +
        `The SHA above is the fact worth keeping: compare it by hand against the ` +
        `image on the stockbook-workers service for this environment.`,
    };
  }

  return {
    severity: "info",
    verdict,
    build,
    entrypoint,
    jobName,
    fields: { ...fields, expectedSha: verdict.sha },
    message:
      `[build-provenance] ok ${entrypoint} is running build ${verdict.sha}, ` +
      `matching the expected version on ${verdict.comparedChars} chars.`,
  };
}

/**
 * Should an unverified/stale build STOP the job?
 *
 * No, by default, and that default is the argument: a nightly job that refuses
 * to start because it is one commit behind turns a partial run into no run at
 * all, unattended. During the actual MONEY-1205 incident `feed-parse-prod` was
 * still correctly parsing every non-bond family; aborting it would have widened
 * the outage. Report loudly, keep working.
 *
 * `BUILD_PROVENANCE_STRICT=1` flips it for a caller that has decided the
 * opposite — e.g. a one-shot backfill where a wrong-version write is expensive
 * to undo. `match` never blocks regardless.
 */
export function shouldBlockStartup(
  report: ProvenanceReport,
  env: ProvenanceEnv,
): boolean {
  const raw = env.BUILD_PROVENANCE_STRICT?.trim().toLowerCase();
  const strict = raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  return strict && report.verdict.status !== "match";
}

/** The minimum a job's console shim has to offer. `error` is optional. */
export interface ProvenanceLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/**
 * Emit the startup provenance line. Call this FIRST in a job's `main()`.
 *
 * Returns the report so a caller can act on it (see `shouldBlockStartup`), and
 * never throws — a guard that can crash the job it guards is a new outage
 * source, not a safety net.
 */
export function reportBuildProvenance(
  logger: ProvenanceLogger,
  entrypoint: string,
  env: ProvenanceEnv = process.env as ProvenanceEnv,
): ProvenanceReport {
  const report = buildProvenanceReport(env, entrypoint);

  // Degrade error -> warn -> info rather than dropping the line: the message
  // carries its own severity token precisely so this stays readable.
  if (report.severity === "error") {
    (logger.error ?? logger.warn ?? logger.info).call(logger, report.message);
  } else if (report.severity === "warn") {
    (logger.warn ?? logger.info).call(logger, report.message);
  } else {
    logger.info(report.message);
  }

  return report;
}
