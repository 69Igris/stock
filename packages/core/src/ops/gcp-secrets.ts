/**
 * Read a GCP Secret Manager secret, and SAY WHY when it cannot be read.
 *
 * Extracted from `scripts/ops/atlas-heatmap.ts` when `databento-inventory.ts`
 * became the second caller — the same trigger `ops/cli-args.ts` records for
 * itself ("no NEW script starts a copy"). Copies two and three of a credential
 * resolver drift silently, and this one carries a measured lesson that must not
 * be re-learned per copy.
 */
import { execFileSync } from "node:child_process";

/** The one GCP project this repo talks to — seed-env.sh / test-env.sh agree. */
export const GCP_PROJECT_ID = "stock-book-483718";

export type SecretResult = { value: string } | { reason: string };

/**
 * Fetch a secret, and SAY WHY when it cannot be fetched.
 *
 * An earlier version returned `null` on any throw, which collapsed four
 * different states into one: the secret does not exist, the secret exists with
 * NO VERSIONS, the caller is not authorised, gcloud is not installed. That is
 * the MONEY-1214 shape — absent and explicitly-set must not read the same — and
 * it bit immediately on the first real run: `ALGO_MONGODB_URI_RO_PROD` IS
 * listed by `gcloud secrets list`, because the secret container was created,
 * and has zero versions. The run reported "cluster not measured" with no
 * reason, which is indistinguishable from "there is no algo cluster".
 */
export function secret(name: string): SecretResult {
  try {
    const v = execFileSync(
      "gcloud",
      [
        "secrets",
        "versions",
        "access",
        "latest",
        `--secret=${name}`,
        `--project=${GCP_PROJECT_ID}`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return v
      ? { value: v }
      : { reason: `\`${name}\` resolved to an EMPTY value` };
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? "").trim();
    // `||`, NOT `??`. When gcloud cannot be SPAWNED at all — not installed,
    // ENOENT, killed — there is no `stderr`, so `""` .split()[0] is `""`, which
    // is not nullish and sails past `??`. The reason then renders as "`NAME` — "
    // with nothing after the dash: the one of the four states this module
    // exists to name that it could not name.
    const first = stderr.split("\n")[0] || String(err);
    if (/NOT_FOUND/.test(stderr)) {
      return {
        reason:
          `\`${name}\` — NOT_FOUND. Note gcloud says "not found **or has no versions**": a ` +
          "secret container created without a version is listed by `gcloud secrets list` and " +
          "reads as provisioned right up until something tries to read it",
      };
    }
    if (/PERMISSION_DENIED|does not have secretmanager/.test(stderr)) {
      return {
        reason: `\`${name}\` — PERMISSION_DENIED for the active gcloud account`,
      };
    }
    return { reason: `\`${name}\` — ${first.slice(0, 200)}` };
  }
}

/** The two environments every per-env job takes on `--env`. */
export type JobEnv = "qa" | "prod";

/**
 * The Mongo URI for an environment — resolved from `--env`, never inherited.
 *
 * ## Why this is not just `process.env.DATABASE_URL`
 *
 * A job that reads the ambient variable and takes its DATASET from `--env` can
 * be pointed at two different environments at once. `identity-sync --env prod`
 * selects `lake_silver_prod` for its writes and, with a QA `DATABASE_URL`
 * exported in the shell, reads QA Mongo — so the production identity spine gets
 * seeded from QA instruments, silently, with every log line saying `env=prod`.
 *
 * Today that fails closed (nothing auto-loads `.env`, so the job dies on a
 * missing variable), which is luck rather than design: one `export` in a
 * terminal is all it takes. Resolving from the flag removes the state instead
 * of relying on it being unreachable — the same reason
 * `embeddings-v2-backfill` grew its own copy of this, which this replaces.
 *
 * ## The Cloud Run branch is not symmetric, deliberately
 *
 * Inside a job the MOUNTED variable is the authority: the job's own spec chose
 * which secret to attach, so `--env` there is a label rather than a selector.
 * It also cannot shell out — `gcloud` is not in the runtime image — so an
 * absent variable is a provisioning fault that must fail loudly rather than
 * degrade.
 */
export function databaseUrlForEnv(env: JobEnv): string {
  const job = process.env["CLOUD_RUN_JOB"];
  if (job) {
    // The mounted URI belongs to the JOB's environment, not to `--env`: a
    // `identity-sync-prod --args=--env,qa` would read prod Mongo and write the
    // QA lake (MONEY-1609 review). Every setup-*-job.sh names its job
    // `<name>-{env}`, so a suffix that disagrees with `--env` is refused.
    const suffix = /-(qa|prod)$/.exec(job)?.[1];
    if (suffix !== undefined && suffix !== env) {
      throw new Error(
        `--env ${env} inside Cloud Run job ${job}, which mounts the ${suffix} ` +
          `database. Execute ${job.replace(/-(qa|prod)$/, `-${env}`)} instead.`,
      );
    }
    const mounted = process.env["DATABASE_URL"];
    if (!mounted) {
      throw new Error(
        "DATABASE_URL is not set inside a Cloud Run job. It is mounted by the " +
          "job's own setup-*-job.sh via --set-secrets; re-run that script. NOT " +
          "falling back to gcloud: it is not in the runtime image.",
      );
    }
    return mounted;
  }
  const name = env === "qa" ? "DATABASE_URL_QA" : "DATABASE_URL_PROD";
  const r = secret(name);
  if ("reason" in r) {
    throw new Error(`Could not read ${name} from Secret Manager — ${r.reason}`);
  }
  return r.value;
}

/**
 * Pin a job's whole environment from its `--env` flag, before any client is
 * constructed — MONEY-1509.
 *
 * `@usemoney/database` exports a Prisma SINGLETON that reads `DATABASE_URL` at
 * construction, and `packages/lake`'s ledger reads `LAKE_ENV` / `LAKE_PROJECT`
 * per call. So the three had to agree and nothing made them: a job could write
 * prod's lake from QA's Mongo through a prod-named ledger run.
 *
 * Returns the resolved URI as well, so a caller constructing its own client
 * does not have to read the variable back out.
 */
export function pinJobEnv(env: JobEnv): { databaseUrl: string } {
  const databaseUrl = databaseUrlForEnv(env);
  process.env["DATABASE_URL"] = databaseUrl;
  process.env["LAKE_ENV"] = env;
  process.env["GCP_PROJECT_ID"] ??= GCP_PROJECT_ID;
  process.env["LAKE_PROJECT"] ??= GCP_PROJECT_ID;
  return { databaseUrl };
}
