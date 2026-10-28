/**
 * `lake-release` — cut an immutable parquet RELEASE. MONEY-1518 (B7).
 *
 *   npx tsx scripts/jobs/lake-release.ts --env qa                  # plan only
 *   npx tsx scripts/jobs/lake-release.ts --env qa --apply          # asks; LAKE_RELEASE_APPLY arms
 *   npx tsx scripts/jobs/lake-release.ts --env qa --verify <id>    # manifest vs bucket
 *
 * A release is `gs://stockbook-lake-{env}/releases/{release_id}/` — parquet a
 * backtest PINS, so that the same id re-read in six months answers the same
 * question. Every decision lives in `packages/core/src/ops/lake-release-logic.ts`
 * and is tested there; this file moves bytes.
 *
 * ## NO ROW PASSES THROUGH NODE
 *
 * The export is BigQuery's own `EXPORT DATA`, which writes SNAPPY parquet
 * straight to GCS. That is not a convenience: `bars_m1` for one US year is
 * tens of millions of rows, and a TypeScript writer would need them all in a
 * 2 Gi container. It also means the job is free of charge — extract/export
 * jobs are not billed — and that `overwrite = false` gives immutability as a
 * SERVER-side refusal rather than as a read-then-write this job would race
 * against its own retry.
 *
 * `EXPORT DATA`, not `bq extract`: `gold.adjusted_bar_d1` is a VIEW and
 * extract jobs refuse views.
 *
 * ## IT IS A JOB, NOT A PUB/SUB HANDLER
 *
 * Same reasoning as `lake-load-databento` and `databento-harvest`: there is no
 * 600 s ack deadline to overrun and no redelivery to guard against. A killed
 * run leaves a PARTIAL release, which is why the last thing written is
 * `manifest.json` — a release with no manifest is visibly unfinished, and
 * `verifyManifest` reports an object the manifest does not name as `UNLISTED`
 * rather than silently reading it.
 *
 * ## IT REFUSES AN EMPTY DATASET
 *
 * `assertReleaseComplete` throws before the manifest is written. As of
 * 2026-09-22 `lake_silver_prod.trade_bar_m1` holds ZERO rows (MONEY-1514 and
 * MONEY-1515 block its loader) and `lake_gold_prod` holds no `adjusted_bar_d1`
 * at all — Dataform has never been run there. So a cut today refuses, by
 * design: an immutable artifact whose `bars_m1/` is an empty directory reports
 * a clean run on no data to every reader, for ever. Re-measured 2026-09-23:
 * unchanged on prod, and QA's five silver tables hold ZERO rows each.
 *
 * ## EVERY NUMERIC COLUMN LEAVES AS FLOAT64
 *
 * `doubleReplacements` over the source's own INFORMATION_SCHEMA. Exported as
 * they are, silver's NUMERIC prices become parquet DECIMAL (an object column
 * of `Decimal` in pandas, which `lake.py`'s intraday adjustment cannot
 * multiply) and INT64 volume becomes the `bigint` the TypeScript `finite()`
 * guard drops. See that function for the ticket's rule.
 *
 * Runs as `lake-writer-{env}@` — `scripts/ops/setup-lake-jobs.sh`.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";

import { BigQuery } from "@google-cloud/bigquery";
import { Storage } from "@google-cloud/storage";

import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { guardCompletion } from "@usemoney/core/ops/job-completion";
import {
  LAKE_REGION,
  bucketForPrefix,
  datasetFor,
  type LakeEnv,
} from "@usemoney/core/ops/lake-layout";
import {
  MANIFEST_VERSION,
  RELEASE_DATASETS,
  RELEASE_LICENCE_NOTES,
  RELEASE_PREFIX,
  assertReleaseComplete,
  buildExportSql,
  doubleReplacements,
  parseReleaseId,
  planPartitions,
  releaseId,
  releaseKey,
  releaseUri,
  resolveAdjustmentPolicy,
  resolveReleaseApply,
  verifyManifest,
  type ManifestFile,
  type ReleaseDataset,
  type ReleaseManifest,
} from "@usemoney/core/ops/lake-release-logic";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { flushMetrics } from "@usemoney/datadog/metrics";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const log = {
  info: (...a: unknown[]) => console.log("[lake-release]", ...a),
  warn: (...a: unknown[]) => console.warn("[lake-release]", ...a),
  error: (...a: unknown[]) => console.error("[lake-release]", ...a),
};

interface Args {
  env: LakeEnv;
  apply: boolean;
  verify?: string;
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const env = value("--env");
  if (env !== "qa" && env !== "prod") {
    throw new Error(
      `--env must be "qa" or "prod" (got ${JSON.stringify(env)})`,
    );
  }
  const verify = value("--verify");
  // A BARE `--verify` MUST NOT FALL THROUGH TO A CUT — MONEY-1514 review.
  // `--env prod --apply --verify` (id forgotten, flag last) parsed to
  // `verify: undefined`, skipped the verify branch, and proceeded to cut a
  // release; with LAKE_RELEASE_APPLY=true it would write. Every other flag in
  // this file refuses rather than defaults; this one silently turned a read
  // into a write, which is the one direction that must never be implicit.
  // (`--verify --apply` in the other order already threw, on
  // `parseReleaseId("--apply")`.)
  if (argv.includes("--verify") && verify === undefined) {
    throw new Error(
      "--verify needs a release id: --verify <id> or --verify=<id>. " +
        "Refusing rather than falling through to a release CUT.",
    );
  }
  return { env, apply: argv.includes("--apply"), verify };
}

/** The whole (market, year[, month]) census, ASKED rather than assumed. */
async function grainsFor(
  bq: BigQuery,
  dataset: ReleaseDataset,
  qualified: string,
): Promise<{ market: string; year?: number; month?: number }[]> {
  if (dataset.partitionBy.length === 0) return [{ market: "*" }];
  const col = dataset.dateColumn;
  const wantsMonth = dataset.partitionBy.includes("month");
  const select = wantsMonth
    ? `market, EXTRACT(YEAR FROM ${col}) AS year, EXTRACT(MONTH FROM ${col}) AS month`
    : `market, EXTRACT(YEAR FROM ${col}) AS year`;
  const [rows] = await bq.query({
    query: `SELECT DISTINCT ${select} FROM \`${qualified}\` ORDER BY 1, 2${wantsMonth ? ", 3" : ""}`,
    location: LAKE_REGION,
  });
  return rows.map((r: Record<string, unknown>) => ({
    market: String(r.market),
    year: Number(r.year),
    ...(wantsMonth ? { month: Number(r.month) } : {}),
  }));
}

/**
 * The source's columns as BigQuery types them — the input to the DOUBLE rule.
 *
 * Zero rows is REFUSED: INFORMATION_SCHEMA answers an unknown table with an
 * empty result, not an error, and an empty list would export `SELECT *` with
 * every NUMERIC left as DECIMAL.
 */
async function columnsOf(
  bq: BigQuery,
  qualifiedDataset: string,
  table: string,
): Promise<{ name: string; dataType: string }[]> {
  const [rows] = await bq.query({
    query:
      `SELECT column_name, data_type FROM \`${qualifiedDataset}\`.INFORMATION_SCHEMA.COLUMNS ` +
      `WHERE table_name = @table ORDER BY ordinal_position`,
    params: { table },
    location: LAKE_REGION,
  });
  if (rows.length === 0) {
    throw new Error(
      `${qualifiedDataset}.${table}: INFORMATION_SCHEMA lists no columns`,
    );
  }
  return rows.map((r: Record<string, unknown>) => ({
    name: String(r.column_name),
    dataType: String(r.data_type),
  }));
}

/** Stream one object through sha256. Constant memory, whatever its size. */
async function sha256Of(
  storage: Storage,
  bucket: string,
  name: string,
): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(storage.bucket(bucket).file(name).createReadStream(), hash);
  return hash.digest("hex");
}

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    // A Cloud Run image carries no .git. `DD_VERSION` is the commit sha Cloud
    // Build stamps, and an UNKNOWN is named rather than left blank — a blank
    // provenance field reads as "not applicable" instead of "not recorded".
    return process.env.DD_VERSION ?? "unknown";
  }
}

async function main(): Promise<number> {
  await initJobTelemetry();
  reportBuildProvenance(log, "lake-release");
  const args = parseArgs(process.argv.slice(2));
  const projectId =
    process.env.LAKE_PROJECT ?? process.env.GCP_PROJECT_ID ?? "";
  if (!projectId)
    throw new Error("LAKE_PROJECT (or GCP_PROJECT_ID) is required");
  const bq = new BigQuery({ projectId, location: LAKE_REGION });
  const storage = new Storage({ projectId });
  const bucketName = bucketForPrefix(RELEASE_PREFIX, args.env);

  if (args.verify !== undefined) return verifyOnly(storage, bucketName, args);

  const now = new Date();
  const id = releaseId(now);
  // `--apply` ASKS, LAKE_RELEASE_APPLY ARMS. Both required, and a bare
  // `--apply` continues as a plan rather than erroring — the plan is the
  // useful half of a run whose arm flag was forgotten.
  const armed = resolveReleaseApply();
  const writing = args.apply && armed;

  console.log(
    `[lake-release] ${writing ? "APPLY" : "PLAN"} env=${args.env} release=${id} ` +
      `bucket=${bucketName} apply=${args.apply} armed=${armed}`,
  );

  if (writing) {
    // Legible refusal ahead of BigQuery's own. `overwrite=false` is the real
    // guarantee; this only makes the error say "that release exists".
    const [existing] = await storage
      .bucket(bucketName)
      .getFiles({ prefix: `${RELEASE_PREFIX}${id}/`, maxResults: 1 });
    if (existing.length > 0) {
      throw new Error(
        `Release ${id} already exists at gs://${bucketName}/${RELEASE_PREFIX}${id}/`,
      );
    }
  }

  // TWO PASSES, AND THE ORDER IS THE POINT — MONEY-1514 review.
  //
  // This was one loop that counted, exported, and only asserted completeness
  // at the end. On prod today `trade_bar_m1` is empty and `lake_gold_prod`
  // holds no `adjusted_bar_d1` at all, so the FIRST `--apply` would export
  // three datasets into `releases/{id}/` and then throw — leaving orphan
  // parquet under an id whose manifest never gets written, which `--verify`
  // cannot read and nothing in this job removes.
  //
  // The census is `COUNT(*)` plus a `SELECT DISTINCT` that were already run
  // before each export, so asking for all of them first costs nothing new.
  const countRows = async (
    qualified: string,
    name: string,
  ): Promise<number> => {
    const [[row]] = await bq.query({
      query: `SELECT COUNT(*) AS n FROM \`${qualified}\``,
      location: LAKE_REGION,
    });
    const n = Number((row as { n: unknown }).n);
    if (!Number.isFinite(n)) {
      throw new Error(`${name}: ${qualified} returned a non-numeric COUNT(*)`);
    }
    return n;
  };

  const rowCounts: Record<string, number> = {};
  const policies: string[] = [];
  const plans: {
    dataset: (typeof RELEASE_DATASETS)[number];
    plan: ReturnType<typeof planPartitions>;
    qualified: string;
    replace: string[];
  }[] = [];
  for (const dataset of RELEASE_DATASETS) {
    const qualifiedDataset = `${projectId}.${datasetFor(
      dataset.layer === "gold" ? "lake_gold" : "lake_silver",
      args.env,
    )}`;
    const qualified = `${qualifiedDataset}.${dataset.source}`;

    let grains: { market: string; year?: number; month?: number }[];
    let count = 0;
    let replace: string[];
    try {
      replace = doubleReplacements(
        await columnsOf(bq, qualifiedDataset, dataset.source),
      );
      grains = await grainsFor(bq, dataset, qualified);
      count = await countRows(qualified, dataset.name);
      if (dataset.policyColumn !== undefined) {
        const [rows] = await bq.query({
          query: `SELECT DISTINCT ${dataset.policyColumn} AS v FROM \`${qualified}\``,
          location: LAKE_REGION,
        });
        policies.push(
          resolveAdjustmentPolicy(rows.map((r: { v: string | null }) => r.v)),
        );
      }
    } catch (err) {
      // NAMED, and it does NOT become a zero. "I could not read the source" is
      // not "the source is empty" — folding them would let an outage produce a
      // release that refuses for the wrong reason, or worse, one that does not.
      throw new Error(
        `${dataset.name}: could not read ${qualified} — ${(err as Error).message}`,
      );
    }
    rowCounts[dataset.name] = count;

    const partitions = planPartitions(
      dataset,
      grains.filter((g) => g.market !== "*"),
    );
    const plan =
      dataset.partitionBy.length === 0
        ? planPartitions(dataset, [])
        : partitions;
    console.log(
      `[lake-release]   ${dataset.name}: ${count} rows, ${plan.length} partition(s), ` +
        `${replace.length} column(s) exported as FLOAT64`,
    );

    plans.push({ dataset, plan, qualified, replace });
  }

  // NOTHING HAS BEEN WRITTEN YET. Refuse here, before the first export.
  assertReleaseComplete(rowCounts);
  const adjustmentPolicy = resolveAdjustmentPolicy(policies);

  // RE-COUNT EVERY DATASET, STILL BEFORE THE FIRST EXPORT — MONEY-1529.
  //
  // The counts the manifest DECLARES were taken in pass 1, a whole census
  // before the bytes they describe. `verifyManifest` compares path, bytes and
  // crc32c and never row counts, and `EXPORT DATA` runs `overwrite = false`,
  // so a loader committing in that window would make a release permanently
  // understate its own parquet with no way to correct it.
  //
  // THIS LOOP IS SEPARATE FROM THE EXPORT LOOP ON PURPOSE. A first attempt put
  // the check inside the export loop, which reintroduced exactly what the
  // two-pass restructure above exists to prevent: datasets 1..N-1 would
  // already have written immutable parquet when dataset N refused, leaving
  // orphan objects under `releases/{id}/` with no manifest and no cleanup path
  // anywhere in this file. The invariant is stated twice above — "NOTHING HAS
  // BEEN WRITTEN YET. Refuse here, before the first export" and "a refusal
  // must leave no orphan parquet, not merely no manifest" — and a guard that
  // breaks the invariant it was added to protect is worse than none.
  //
  // KNOWN LIMIT, written down rather than discovered later: COUNT(*) cannot
  // see every concurrent write. `adjusted_bar_d1` is 1:1 with its session
  // rows, so a loader appending a BHAVCOPY bar where a YAHOO bar already
  // exists changes the exported VALUES and leaves the count unmoved. Closing
  // that needs a snapshot read (`FOR SYSTEM_TIME AS OF`) so the census and the
  // export see one version by construction — tracked, not done here.
  // WRITING ONLY. In PLAN mode nothing is exported, so a count that moved
  // between the two censuses can only produce a FALSE refusal — aborting a run
  // that writes nothing, with the advice "Stop the writer and re-cut", and
  // suppressing every PLAN line because those print after this loop. The
  // design is explicit that a bare `--apply` without the arm flag "continues
  // as a PLAN ... the plan is the useful half".
  //
  // It also keeps a billed full scan off every dry run: RELEASE_DATASETS
  // includes `adjusted_bar_d1`, a VIEW over 14.3M silver rows, so its COUNT(*)
  // re-executes the whole window computation.
  for (const { dataset, qualified } of writing ? plans : []) {
    const recount = await countRows(qualified, dataset.name);
    if (recount !== rowCounts[dataset.name]) {
      throw new Error(
        `${dataset.name}: row count moved between the census and the export ` +
          `(${rowCounts[dataset.name]} -> ${recount}). Something is writing to ` +
          `${qualified} while a release is being cut. The manifest would ` +
          `declare a count that does not describe its own parquet, and ` +
          `EXPORT DATA is overwrite=false so it could never be corrected. ` +
          `Stop the writer and re-cut.`,
      );
    }
  }

  for (const { dataset, plan, qualified, replace } of plans) {
    for (const part of plan) {
      const rel = [dataset.name, ...part.segments].join("/");
      const sql = buildExportSql({
        uriPrefix: releaseUri(args.env, id, rel),
        qualifiedSource: qualified,
        predicates: part.predicates,
        replace,
      });
      if (!writing) {
        console.log(`[lake-release]     PLAN ${rel}`);
        continue;
      }
      await bq.query({ query: sql, location: LAKE_REGION });
      console.log(`[lake-release]     WROTE ${rel}`);
    }
  }

  // Asserted BEFORE the first export above, not here — a refusal must leave no
  // orphan parquet, not merely no manifest.

  if (!writing) {
    console.log(
      `[lake-release] PLAN complete — nothing written. ` +
        `Re-run with --apply and LAKE_RELEASE_APPLY=true.`,
    );
    return 0;
  }

  const [objects] = await storage
    .bucket(bucketName)
    .getFiles({ prefix: `${RELEASE_PREFIX}${id}/` });
  // SEQUENTIAL: one streamed read at a time keeps memory flat in a 2Gi job,
  // and this runs once per cut.
  const files: ManifestFile[] = [];
  for (const o of objects) {
    files.push({
      path: o.name.slice(`${RELEASE_PREFIX}${id}/`.length),
      bytes: Number(o.metadata.size ?? 0),
      checksum: {
        algo: "crc32c" as const,
        value: String(o.metadata.crc32c ?? ""),
      },
      sha256: await sha256Of(storage, bucketName, o.name),
    });
  }
  const manifest: ReleaseManifest = {
    manifestVersion: MANIFEST_VERSION,
    releaseId: id,
    env: args.env,
    snapshotAt: now.toISOString(),
    gitSha: gitSha(),
    adjustmentPolicy,
    // MONEY-1602: membership is the LISTING windows (identity/2 dates them
    // from each source); symbol_history only supplies labels, and no source
    // dates when a label began.
    universeRule:
      "every listing in lake_silver.listing at the snapshot instant; " +
      "tradable on D = its version valid on D is not DELISTED (US windows " +
      "from Tiingo listing dates, India from the first and last bar); labels " +
      "from symbol_history, whose start dates are not known",
    calendars: ["XNYS (US, 04:00-20:00 ET sessions)", "XNSE/XBOM (India)"],
    licence: RELEASE_LICENCE_NOTES,
    rowCounts,
    files,
  };

  await storage
    .bucket(bucketName)
    .file(releaseKey(args.env, id, "manifest.json"))
    .save(JSON.stringify(manifest, null, 2), {
      contentType: "application/json",
      // The release is immutable; so is its manifest. A second cut racing the
      // same id loses here rather than replacing the first one's inventory.
      preconditionOpts: { ifGenerationMatch: 0 },
    });

  console.log(
    `[lake-release] PUBLISHED ${JSON.stringify({
      env: args.env,
      releaseId: id,
      adjustmentPolicy,
      files: manifest.files.length,
      rowCounts,
      runId: randomUUID(),
    })}`,
  );
  // Only a WRITING run reports: a PLAN is not a data-writing run, and
  // reporting it as `selected > 0, written 0` would read as the zero-write
  // shape `reportJobOutcome` exists to raise.
  const exported = Object.values(rowCounts).reduce((a, b) => a + b, 0);
  reportJobOutcome({
    job: "lake-release",
    selected: exported,
    written: exported,
  });
  await flushMetrics();
  return 0;
}

async function verifyOnly(
  storage: Storage,
  bucketName: string,
  args: Args,
): Promise<number> {
  const id = parseReleaseId(args.verify ?? "");
  const prefix = `${RELEASE_PREFIX}${id}/`;
  const [buf] = await storage
    .bucket(bucketName)
    .file(`${prefix}manifest.json`)
    .download();
  const manifest = JSON.parse(buf.toString("utf8")) as ReleaseManifest;
  const [objects] = await storage.bucket(bucketName).getFiles({ prefix });
  const problems = verifyManifest(
    manifest,
    objects
      .filter((o) => o.name !== `${prefix}manifest.json`)
      .map((o) => ({
        path: o.name.slice(prefix.length),
        bytes: Number(o.metadata.size ?? 0),
        crc32c: String(o.metadata.crc32c ?? ""),
      })),
  );
  if (problems.length === 0) {
    console.log(
      `[lake-release] VERIFY ok — ${manifest.files.length} files agree`,
    );
    return 0;
  }
  for (const p of problems) console.error(`[lake-release] VERIFY ${p}`);
  // Exit 2, not 1: a verify that DISAGREES and a verify that could not run
  // must be distinguishable to whatever runs it.
  return 2;
}

guardCompletion("lake-release", main()).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`[lake-release] FAILED: ${(err as Error).message}`);
    process.exit(1);
  },
);
