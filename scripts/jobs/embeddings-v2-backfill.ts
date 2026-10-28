/**
 * `document_embeddings` -> `document_embeddings_v2`. MONEY-1499 (B8).
 *
 * A Cloud Run JOB, not a Pub/Sub handler: 5.95M rows and ~67 GiB read is hours,
 * and Pub/Sub's ack deadline maxes out at 600s — past which the message is
 * REDELIVERED and a second copy of the job runs beside the first.
 *
 * ## What it does, and the three things it never does
 *
 * It reads v1 in `_id` order from a checkpoint, quantizes each vector to int8
 * (docs/reference/embeddings-decision-2026-09.md §5), and inserts into v2.
 *
 *   - It DELETES NOTHING. Not a row, not a collection, not an index. v1 is
 *     renamed at the very end and kept 30 days (B0 §6); the drop after that
 *     window is a founder action that has no code here.
 *   - It never SILENTLY SKIPS. A row it cannot migrate goes to
 *     `document_embeddings_v2_refusals` with a NAMED reason, and if refusals
 *     pass 1% of a meaningful sample the run STOPS rather than manifesting
 *     hundreds of thousands of rows and reporting success.
 *   - It never renames v1 on a count it has not checked. `--rename-v1` refuses
 *     unless v2 holds at least as many rows as v1 AND the flag is already `on`.
 *
 * ## Modes
 *
 *   (default)     migrate a slice, from the checkpoint
 *   --verify      counts, checkpoint position, refusals — writes nothing
 *   --census      B0 §6 criterion 5: duplication + chunks-per-docId, over v2
 *   --rename-v1   the guarded cut-over rename
 *
 * ## Usage
 *
 *   npx tsx scripts/jobs/embeddings-v2-backfill.ts --env=prod --verify
 *   npx tsx scripts/jobs/embeddings-v2-backfill.ts --env=prod --apply
 *   npx tsx scripts/jobs/embeddings-v2-backfill.ts --env=prod --census
 *   npx tsx scripts/jobs/embeddings-v2-backfill.ts --env=prod --rename-v1 --apply
 *
 * TWO KEYS FOR EVERY WRITE. `--apply` ASKS; the environment ARMS
 * (`EMBEDDINGS_V2_BACKFILL_APPLY` / `EMBEDDINGS_V2_RENAME_APPLY`, compared
 * against the literal string `"true"`, read per call). `--apply` without the
 * arm continues as a dry run and says so, because the dry run still produces
 * the counts, which is the useful half.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import { GCP_PROJECT_ID } from "@usemoney/core/ops/gcp-secrets";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { flushMetrics } from "@usemoney/datadog/metrics";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";
import {
  CHECKPOINT_COLLECTION,
  DEFAULT_CORPUS_MODEL,
  EMBEDDINGS_V2_FLAG,
  EXPECTED_DIMS,
  REFUSAL_ABORT_MIN_SCANNED,
  REFUSAL_COLLECTION,
  V1_COLLECTION,
  V1_RETIRED_COLLECTION,
  V2_COLLECTION,
  buildRefusalDocument,
  buildV2Document,
  checkRenameReady,
  migrateRow,
  resolveEmbeddingsMode,
  shouldAbortForRefusals,
  type MigrationRefusal,
} from "@usemoney/core/embeddings-int8-logic";
import { drainCursor } from "@usemoney/core/embeddings-v2-read";

const JOB = "embeddings-v2-backfill";

// The shape every other Cloud Run job entry point uses (tiingo-us-backfill,
// feed-backfill, xbrl-backfill): one object with info/warn. It is what
// `reportBuildProvenance` takes, and `@usemoney/logger`'s getLogger() is keyed
// to a fixed LoggerModule union with no entry for a script.
const log = {
  info: (...a: unknown[]) => console.log(`[${JOB}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${JOB}]`, ...a),
};
const CHECKPOINT_ID = "v1-to-v2";
const DEFAULT_BATCH = 500;
/**
 * 500 rows of v1 is ~6 MB of BSON against Mongo's 16 MB reply cap, with room
 * for the long tail (`content` maxes at 5,867 B). It is a PAGE SIZE, not the
 * control: the control is the checkpoint, which makes any interruption cost
 * one page.
 */
const DEFAULT_MAX_MINUTES = 330;

const ARGS = parseCliArgsOrExit(
  process.argv.slice(2),
  {
    bare: ["apply", "verify", "census", "rename-v1"],
    valued: ["env", "batch", "max-minutes", "model"],
    numeric: ["batch", "max-minutes"],
  },
  JOB,
);

/** Literal string, read PER CALL. `Boolean("false")` is `true`. */
function isBackfillArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["EMBEDDINGS_V2_BACKFILL_APPLY"] === "true";
}
function isRenameArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["EMBEDDINGS_V2_RENAME_APPLY"] === "true";
}

/**
 * The connection string, from the environment IN CLOUD RUN and from Secret
 * Manager on a laptop — MONEY-1499 review, F2.
 *
 * ## `gcloud` IS NOT IN THE RUNTIME IMAGE
 *
 * `workers/Dockerfile`'s runtime stage is `node:22-alpine` plus openssl,
 * chromium, ffmpeg and fonts. There is no google-cloud-sdk, so the unguarded
 * `execFileSync("gcloud", …)` this replaced died with `spawnSync gcloud ENOENT`
 * on EVERY execution, in both environments. `doc-ingest-backfill.ts` already
 * records the rule in the repo's own words: "The Admin API rather than gcloud,
 * which is not in the runtime image."
 *
 * And the secret was already there and simply never read —
 * `setup-embeddings-v2-job.sh:186` mounts
 * `--set-secrets="DATABASE_URL=${DB_SECRET}:latest,…"`.
 *
 * ## Why it branches on CLOUD_RUN_JOB rather than `process.env.DATABASE_URL ?? …`
 *
 * A bare `??` would let an operator's stray shell `DATABASE_URL` — almost
 * always QA, since that is what `.env` holds — silently win over an explicit
 * `--env=prod`, pointing a prod run at the wrong cluster while every log line
 * says prod. The flag has to stay load-bearing where a human passes it.
 *
 * In Cloud Run the mounted variable IS the authority: the job's own spec chose
 * the secret, so `--env` there is a label rather than a selector, and an absent
 * variable is a provisioning fault that must fail loudly rather than fall back
 * to a `gcloud` that cannot run.
 */
function databaseUrlForEnv(env: string): string {
  if (process.env["CLOUD_RUN_JOB"]) {
    const mounted = process.env["DATABASE_URL"];
    if (!mounted) {
      throw new Error(
        "DATABASE_URL is not set inside a Cloud Run job. It is mounted by " +
          "setup-embeddings-v2-job.sh via --set-secrets; re-run that script. " +
          "NOT falling back to gcloud: it is not in the runtime image.",
      );
    }
    return mounted;
  }

  const secret = env === "qa" ? "DATABASE_URL_QA" : "DATABASE_URL_PROD";
  const out = execFileSync(
    "gcloud",
    [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${secret}`,
      `--project=${GCP_PROJECT_ID}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: "stockbook" },
    },
  ).trim();
  if (!out) throw new Error(`Could not read ${secret} from Secret Manager`);
  return out;
}

type Raw = (cmd: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Doc = Record<string, unknown>;

/**
 * FIRST BATCH ONLY — correct at these three call sites and NOWHERE ELSE.
 *
 * The server caps `firstBatch` at 101 documents whatever `limit` asks for, so
 * this is a truncating read. It is used for the checkpoint (`limit: 1`), the
 * refusals-by-reason `$group` (five possible reasons) and the census `$group`
 * (one row) — results that cannot reach 101 by construction. The migration's
 * own page read uses `drainCursor`; if you add a fourth caller that could
 * return more than a handful of rows, use that instead.
 */
function batchOf(res: Doc): Doc[] {
  return ((res.cursor as { firstBatch?: Doc[] })?.firstBatch ?? []) as Doc[];
}

const sha256 = (s: string): Uint8Array =>
  new Uint8Array(createHash("sha256").update(s).digest());

/**
 * A count, or a THROW — never a zero that means "I could not read it".
 *
 * MONEY-1499 review. `Number(res.n ?? 0)` made an ABSENT `n` read as 0, and 0
 * is the value that means "nothing outstanding" to the rename gate. It is not
 * hypothetical: `$runCommandRaw` returns RELAXED extended JSON today, under
 * which a count is a plain number, but the same reply under CANONICAL carries
 * `{$numberLong: "5951933"}` — `Number({...})` is NaN — and this file's own
 * `toNumberArray` header documents that exact serializer hazard for vectors.
 */
function countFrom(res: Doc, what: string): number {
  const raw = res.n;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(
      `${what} did not return a finite count (n=${JSON.stringify(raw)}). ` +
        "Refusing to treat an unreadable count as zero.",
    );
  }
  return n;
}

async function countOf(raw: Raw, collection: string): Promise<number> {
  return countFrom(await raw({ count: collection }), `count(${collection})`);
}

/**
 * v1 rows the backfill has NOT reached — MONEY-1499 review, F3.
 *
 * Counted as the LEFTOVER SET past the checkpoint, `_id > lastId`, not as
 * `v1 - v2 - refusals`. That subtraction is the number `--verify` prints, and
 * it stops meaning anything once mode is "on": v1 freezes, v2 grows on live
 * traffic, and the difference goes negative while un-migrated rows remain.
 *
 * The leftover set does not drift, because it asks the only question that
 * matters on a one-way door — did the walk reach the end of v1?
 *
 * A null checkpoint means the backfill has never run, which is NOT zero
 * outstanding; it is all of v1.
 */
async function outstandingV1Rows(raw: Raw): Promise<number> {
  const cp = await readCheckpoint(raw);
  const lastId = (cp?.lastId as { $oid?: string })?.$oid ?? null;
  if (!lastId) return countOf(raw, V1_COLLECTION);
  const res = await raw({
    count: V1_COLLECTION,
    query: { _id: { $gt: { $oid: lastId } } },
  });
  return countFrom(res, `count(${V1_COLLECTION}, _id > checkpoint)`);
}

async function readCheckpoint(raw: Raw): Promise<Doc | null> {
  const res = await raw({
    find: CHECKPOINT_COLLECTION,
    filter: { _id: CHECKPOINT_ID },
    limit: 1,
  });
  return batchOf(res)[0] ?? null;
}

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Without this the job logs to
  // stdout only, and its `[job-outcome]` line is the only thing a monitor can
  // see going wrong.
  await initJobTelemetry();
  // FIRST, and before any argument is read. A Cloud Run JOB PINS ITS IMAGE AT
  // PROVISION TIME — deploying the workers SERVICE does not move it — so this
  // line is the only runtime answer to "is the running job the code I pushed?".
  // It matters more here than on a nightly: this job's `--rename-v1` is a
  // ONE-WAY door, and the gate that guards it (`checkRenameReady`) lives in the
  // image. A stale image is a stale gate refusing or permitting on stale rules.
  reportBuildProvenance(log, "embeddings-v2-backfill");

  const env = ARGS.value("env");
  if (env !== "qa" && env !== "prod") {
    // THROW, not `process.exit(1)` — see the tail of this file. `exit`
    // terminates before the `.finally` that flushes logs and metrics.
    throw new Error("--env=qa|prod is required");
  }
  // MONEY-1499 review. Inside a Cloud Run job the MOUNTED DATABASE_URL is the
  // authority and `--env` selects nothing, so a typo'd `--env=qa` against
  // `embeddings-v2-backfill-prod` used to run silently against PROD with a
  // transcript identical to the QA run the operator believed they were doing —
  // `--rename-v1` included. The provisioner sets DD_ENV=${ENV} on the job, so
  // the job knows which environment it IS; disagreeing with the operator is a
  // refusal rather than a preference.
  const jobEnv = process.env["DD_ENV"];
  if (process.env["CLOUD_RUN_JOB"] && jobEnv && jobEnv !== env) {
    throw new Error(
      `--env=${env} but this job is provisioned as DD_ENV=${jobEnv} ` +
        `(${process.env["CLOUD_RUN_JOB"]}). Inside a Cloud Run job the mounted ` +
        "DATABASE_URL decides the cluster, so the flag cannot move it — and a " +
        "run that names the wrong environment is indistinguishable in its own " +
        "output from one that named the right one.",
    );
  }
  const model = ARGS.value("model") ?? DEFAULT_CORPUS_MODEL;
  const batch = ARGS.number("batch", DEFAULT_BATCH);
  const maxMinutes = ARGS.number("max-minutes", DEFAULT_MAX_MINUTES);

  const uri = databaseUrlForEnv(env);
  const prisma = new PrismaClient({ datasources: { db: { url: uri } } });
  const raw: Raw = (cmd) =>
    prisma.$runCommandRaw(cmd as never) as unknown as Promise<
      Record<string, unknown>
    >;

  try {
    if (ARGS.has("verify")) return await verify(raw);
    if (ARGS.has("census")) return await census(raw);
    if (ARGS.has("rename-v1")) return await renameV1(raw, prisma, uri);
    await backfill(raw, { model, batch, maxMinutes });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Counts, the cursor, and the LEFTOVER SET AS A QUERY.
 *
 * B0's closing note asks for exactly this: "make the leftover set QUERYABLE
 * rather than inferred". A migration that reports "5,912,004 of 5,951,933" has
 * said nothing about WHICH rows are missing; a `_id: {$gt: ...}` filter the
 * operator can paste is the difference between a number and a handle.
 */
async function verify(raw: Raw): Promise<void> {
  const [v1, v2, refusals, cp, pastCheckpoint] = await Promise.all([
    countOf(raw, V1_COLLECTION),
    countOf(raw, V2_COLLECTION),
    countOf(raw, REFUSAL_COLLECTION),
    readCheckpoint(raw),
    outstandingV1Rows(raw),
  ]);
  const lastId = (cp?.lastId as { $oid?: string })?.$oid ?? null;
  console.log(`── ${JOB} --verify ──`);
  console.log(
    `  env=${process.env["DD_ENV"] ?? "(unset)"} ` +
      `job=${process.env["CLOUD_RUN_JOB"] ?? "(local)"}`,
  );
  console.log(`  ${V1_COLLECTION.padEnd(34)} ${v1.toLocaleString()}`);
  console.log(`  ${V2_COLLECTION.padEnd(34)} ${v2.toLocaleString()}`);
  console.log(
    `  ${REFUSAL_COLLECTION.padEnd(34)} ${refusals.toLocaleString()}`,
  );
  console.log(
    `  accounted for (v2+refused)         ${(v2 + refusals).toLocaleString()}`,
  );
  // TWO DIFFERENT NUMBERS, TWO DIFFERENT NAMES — MONEY-1499 review.
  //
  // This line used to be labelled `outstanding`, which is also the name of the
  // rename gate's input, and they are not the same quantity. The subtraction
  // goes NEGATIVE in "on" mode (v1 frozen, v2 growing on live traffic), so the
  // operator reading it during the seven-day soak sees something like -86,594,
  // reads "comfortably done", arms the rename, and is refused by a gate quoting
  // a completely different figure — with nothing in either output saying they
  // measure different things.
  console.log(
    `  v1 - accounted for                 ${(v1 - v2 - refusals).toLocaleString()}` +
      `   (negative in "on" mode: v2 grows on live traffic)`,
  );
  console.log(
    `  past the checkpoint                ${pastCheckpoint.toLocaleString()}` +
      `   <- THIS is what --rename-v1 gates on`,
  );
  console.log(
    `  checkpoint                         ${lastId ?? "(none — never run)"}`,
  );
  if (lastId) {
    console.log(
      `\n  the leftover set, as a query:\n` +
        `    db.${V1_COLLECTION}.find({ _id: { $gt: ObjectId("${lastId}") } })`,
    );
  }
  if (refusals > 0) {
    const byReason = await raw({
      aggregate: REFUSAL_COLLECTION,
      pipeline: [
        { $group: { _id: "$reason", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ],
      cursor: {},
    });
    console.log("\n  refusals by reason:");
    for (const r of batchOf(byReason))
      console.log(`    ${String(r._id).padEnd(16)} ${r.n}`);
  }
  // WRITTEN 0, FAILED 0 — MONEY-1499 review. `--verify` writes nothing and
  // `reportJobOutcome` tags only `{job}`, with no mode dimension, so reporting
  // `written: v2` here puts ~5.9M onto the same series a zero-write monitor
  // reads and reporting `failed: refusals` alerts a failure monitor on a
  // read-only command. One inspection run in the window would make the monitor
  // unable to fire for a genuine no-op backfill ever again — the MONEY-1238
  // shape this repo has paid for four times. The numbers are still PRINTED,
  // which is what an operator running --verify actually wants.
  reportJobOutcome({ job: JOB, selected: v1, written: 0, failed: 0 });
}

async function backfill(
  raw: Raw,
  opts: { model: string; batch: number; maxMinutes: number },
): Promise<void> {
  const armed = isBackfillArmed();
  const asked = ARGS.has("apply");
  const apply = asked && armed;
  if (asked && !armed) {
    console.log(
      `[${JOB}] ARM MISSING — EMBEDDINGS_V2_BACKFILL_APPLY is not "true"; staying in dry-run. ` +
        "Arming is a DEPLOY, not a flag.",
    );
  }

  const cp = await readCheckpoint(raw);
  let cursor = (cp?.lastId as Doc | undefined) ?? null;
  const deadline = Date.now() + opts.maxMinutes * 60_000;

  /**
   * A DRY RUN STOPS AT THE SAMPLE, and that is not timidity.
   *
   * Unbounded, it would read all 5.95M rows and ~67 GiB from the cluster that
   * serves the product, for hours, to write nothing — the exact shape of the
   * unbounded aggregation B0 had to kill. The cap is the refusal ceiling's own
   * minimum population, so a dry run measures precisely the thing it can
   * measure: whether the refusal rate is survivable.
   */
  const dryRunCap = REFUSAL_ABORT_MIN_SCANNED;

  let scanned = 0;
  let written = 0;
  let already = 0;
  let refused = 0;
  const reasons = new Map<MigrationRefusal, number>();

  console.log(
    `[${JOB}] ${apply ? "APPLY" : "DRY RUN"} from ${
      (cursor as { $oid?: string })?.$oid ?? "the beginning"
    }, batch=${opts.batch}, model=${opts.model}`,
  );

  for (;;) {
    if (Date.now() > deadline) {
      console.log(
        `[${JOB}] wall-clock budget reached — stopping cleanly, checkpoint is current`,
      );
      break;
    }
    // DRAINED, not read as one batch. A `find` through `$runCommandRaw` hands
    // back `firstBatch`, which the server caps at 101 documents whatever the
    // `limit` says — so `--batch=500` would silently be 101, and the operator's
    // sizing arithmetic would be wrong by 5x with nothing reporting it.
    const page = await drainCursor(
      raw,
      {
        find: V1_COLLECTION,
        ...(cursor ? { filter: { _id: { $gt: cursor } } } : {}),
        sort: { _id: 1 },
        limit: opts.batch,
      },
      V1_COLLECTION,
      opts.batch,
    );
    if (page.length === 0) {
      console.log(`[${JOB}] reached the end of ${V1_COLLECTION}`);
      break;
    }

    const inserts: Doc[] = [];
    const refusalDocs: Doc[] = [];
    const now = new Date().toISOString();
    for (const row of page) {
      scanned++;
      const verdict = migrateRow(
        {
          _id: row._id,
          embedding: row.embedding as number[] | null,
          embeddingModel: row.embeddingModel as string | null,
        },
        { model: opts.model, dims: EXPECTED_DIMS },
      );
      if (verdict.ok) {
        inserts.push(
          buildV2Document(row, verdict.bytes, { model: opts.model, sha256 }),
        );
      } else {
        refused++;
        reasons.set(verdict.reason, (reasons.get(verdict.reason) ?? 0) + 1);
        refusalDocs.push(buildRefusalDocument(row, verdict.reason, now));
      }
    }

    if (apply) {
      if (inserts.length > 0) {
        // `ordered: false` so one duplicate does not abandon the rest of the
        // page, and a duplicate `_id` IS the idempotency: a re-run of a page
        // whose checkpoint never landed collides instead of doubling.
        const res = await raw({
          insert: V2_COLLECTION,
          documents: inserts,
          ordered: false,
        });
        const n = typeof res.n === "number" ? res.n : 0;
        const dupes = (
          res.writeErrors as { code?: number }[] | undefined
        )?.filter((e) => e.code === 11000).length;
        const other = (
          res.writeErrors as { code?: number; errmsg?: string }[] | undefined
        )?.filter((e) => e.code !== 11000);
        if (other && other.length > 0) {
          throw new Error(
            `insert into ${V2_COLLECTION} failed: ${other[0]?.errmsg ?? "unknown"}`,
          );
        }
        written += n;
        already += dupes ?? 0;
      }
      if (refusalDocs.length > 0) {
        await raw({
          insert: REFUSAL_COLLECTION,
          documents: refusalDocs,
          ordered: false,
        });
      }
      cursor = page[page.length - 1]!._id as Doc;
      await raw({
        update: CHECKPOINT_COLLECTION,
        updates: [
          {
            q: { _id: CHECKPOINT_ID },
            u: {
              $set: {
                _id: CHECKPOINT_ID,
                lastId: cursor,
                scanned,
                written,
                refused,
                updatedAt: new Date().toISOString(),
              },
            },
            upsert: true,
          },
        ],
      });
    } else {
      cursor = page[page.length - 1]!._id as Doc;
    }

    if (shouldAbortForRefusals(scanned, refused)) {
      throw new Error(
        `refusal rate ${((refused / scanned) * 100).toFixed(2)}% over ${scanned} rows exceeds the ` +
          `1% ceiling — B0 measured this corpus as 100% one model at ${EXPECTED_DIMS} dims, so this ` +
          `has found something the measurement did not. Reasons: ${[...reasons]
            .map(([r, n]) => `${r}=${n}`)
            .join(" ")}`,
      );
    }
    if (scanned % (opts.batch * 20) === 0) {
      console.log(
        `[${JOB}] scanned=${scanned} written=${written} already=${already} refused=${refused}`,
      );
    }
    if (!apply && scanned >= dryRunCap) {
      console.log(
        `[${JOB}] dry-run sample of ${scanned} rows reached — stopping. ` +
          `Refusal rate ${((refused / scanned) * 100).toFixed(3)}% against a 1% ceiling.`,
      );
      break;
    }
  }

  console.log(
    `[${JOB}] done: scanned=${scanned} written=${written} alreadyPresent=${already} refused=${refused}`,
  );
  for (const [r, n] of reasons) console.log(`  refused ${r}: ${n}`);
  if (!apply)
    console.log(
      `[${JOB}] DRY RUN — nothing written and the checkpoint did not move.`,
    );
  reportJobOutcome({ job: JOB, selected: scanned, written, failed: refused });
}

/**
 * B0 §6 criterion 5, which B0 itself could not run: a `$group` over 5.87M rows
 * blew that script's deliberate 120s ceiling against the cluster that serves
 * the product.
 *
 * It runs HERE because this is a Cloud Run job with hours of budget and no
 * user waiting, it runs against v2 (~38 GiB rather than 67), and `contentSha`
 * is already on the row. It still reports THREE states — a `$group` that could
 * not finish is not a corpus with no duplication.
 */
async function census(raw: Raw): Promise<void> {
  console.log(`── ${JOB} --census (full scan of ${V2_COLLECTION}) ──`);
  for (const [label, field, where] of [
    ["duplicate content", "$contentSha", {}],
    // `docId` is `String?` and most of the user-side corpus (holdings, trades,
    // preferences, analysis) has none — MONEY-1499 review. Mongo groups every
    // one of those under `_id: null`, so an ungated group reports the whole
    // null population as ONE document with millions of chunks: a fabricated
    // `max`, an inflated `redundant`, and the real per-document fan-out
    // averaged into the same bucket and unreadable. These numbers go into a
    // decision document, so a grouping artifact there answers the duplication
    // question wrongly while looking answered.
    ["chunks per docId (docId set)", "$docId", { docId: { $ne: null } }],
  ] as const) {
    try {
      const res = await raw({
        aggregate: V2_COLLECTION,
        pipeline: [
          ...(Object.keys(where).length > 0 ? [{ $match: where }] : []),
          { $group: { _id: field, n: { $sum: 1 } } },
          {
            $group: {
              _id: null,
              groups: { $sum: 1 },
              rows: { $sum: "$n" },
              redundant: { $sum: { $subtract: ["$n", 1] } },
              max: { $max: "$n" },
            },
          },
        ],
        cursor: {},
        allowDiskUse: true,
      });
      const r = batchOf(res)[0];
      if (!r) {
        console.log(
          `  ${label}: the stage ran and returned NOTHING (an empty collection?)`,
        );
        continue;
      }
      const rows = Number(r.rows ?? 0);
      const redundant = Number(r.redundant ?? 0);
      console.log(
        `  ${label}: ${Number(r.groups).toLocaleString()} distinct over ` +
          `${rows.toLocaleString()} rows — ${redundant.toLocaleString()} redundant ` +
          `(${rows ? ((redundant / rows) * 100).toFixed(2) : "0.00"}%), max ${r.max}`,
      );
    } catch (err) {
      console.log(
        `  ${label}: DID NOT RUN — ${err instanceof Error ? err.message : String(err)}\n` +
          "    (this is NOT 'no duplication'; the census is unanswered)",
      );
      process.exitCode = 1;
    }
  }
  console.log(
    "\n  Paste these numbers into docs/reference/embeddings-decision-2026-09.md §3 —\n" +
      "  B0 deferred the census here precisely so they would land back in that document.",
  );
  // The `.finally(flushMetrics)` comment at the foot of this file claims all
  // three read modes report an outcome. This one did not. Read-only, so the
  // same 0/0 as --verify; `failed` carries the DID-NOT-RUN groups, which is a
  // real failure of this command rather than of the corpus.
  reportJobOutcome({
    job: JOB,
    selected: 1,
    written: 0,
    failed: process.exitCode === 1 ? 1 : 0,
  });
}

/**
 * The cut-over. The single move in this ticket that is hard to undo, so it is
 * the one with the most refusals in front of it.
 *
 * `renameCollection` PRESERVES the collection — it is not a drop, and the drop
 * after B0's 30-day window has no code anywhere in this repo.
 */
async function renameV1(
  raw: Raw,
  prisma: PrismaClient,
  uri: string,
): Promise<void> {
  const [v1Count, v2Count, refusalCount, flag, outstanding] = await Promise.all(
    [
      countOf(raw, V1_COLLECTION),
      countOf(raw, V2_COLLECTION),
      countOf(raw, REFUSAL_COLLECTION),
      prisma.platformConfig.findUnique({ where: { key: EMBEDDINGS_V2_FLAG } }),
      outstandingV1Rows(raw),
    ],
  );
  const mode = resolveEmbeddingsMode(flag?.value);
  const verdict = checkRenameReady({
    v1Count,
    v2Count,
    refusalCount,
    // `-1`, not 0, when the flag is absent: 0 is a REAL acceptance of a corpus
    // with no refusals, so defaulting to it would silently accept the one case
    // the flag exists for. A sentinel that can never equal a count refuses.
    acceptedRefusals: ARGS.value("accept-refusals")
      ? ARGS.number("accept-refusals", -1)
      : refusalCount === 0
        ? 0
        : -1,
    mode,
    armed: ARGS.has("apply") && isRenameArmed(),
    outstanding,
  });

  console.log(`── ${JOB} --rename-v1 ──`);
  console.log(
    `  env=${process.env["DD_ENV"] ?? "(unset)"} ` +
      `job=${process.env["CLOUD_RUN_JOB"] ?? "(local)"}`,
  );
  console.log(
    `  v1=${v1Count.toLocaleString()} v2=${v2Count.toLocaleString()} ` +
      `refused=${refusalCount.toLocaleString()} ` +
      `pastCheckpoint=${outstanding.toLocaleString()} mode=${mode}`,
  );
  if (!verdict.ok) {
    // THROW, not `process.exit(1)` — MONEY-1499 review, and the same rule this
    // file's tail states 40 lines below. `exit` skips the `.catch` that reports
    // the outcome AND the `.finally` that flushes logs and metrics, so the one
    // execution where the one-way door was BLOCKED would be byte-identical, in
    // Datadog, to one that never ran.
    throw new Error(`REFUSED: ${verdict.reason}`);
  }

  // `renameCollection` may ONLY be run against the `admin` database, and
  // Prisma's `$runCommandRaw` always targets the database in the connection
  // string — so this one command uses the driver directly. `dbStats` names
  // that database without parsing (and possibly mis-parsing) the URI.
  const stats = await raw({ dbStats: 1 });
  const db = String(stats.db ?? "");
  if (!db)
    throw new Error("could not determine the database name from dbStats");

  // Declared in `workers/package.json` (it was already a root dependency and
  // would have resolved through the hoist, but a bundled job relying on a
  // hoist is an undeclared dependency that breaks the day the hoist moves).
  // Imported dynamically so the other three modes never pay for a driver they
  // do not use.
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri);
  try {
    await client.connect();
    await client.db("admin").command({
      renameCollection: `${db}.${V1_COLLECTION}`,
      to: `${db}.${V1_RETIRED_COLLECTION}`,
      // Explicit, though it is the default: an accidental `true` here would
      // DESTROY whatever already sat at the target name.
      dropTarget: false,
    });
  } finally {
    await client.close();
  }
  console.log(
    `[${JOB}] renamed ${V1_COLLECTION} -> ${V1_RETIRED_COLLECTION}. It is KEPT, not dropped.\n` +
      `[${JOB}] take the Atlas snapshot now if you have not, and diarise the 30-day window.`,
  );
  reportJobOutcome({ job: JOB, selected: 1, written: 1, failed: 0 });
}

main()
  .catch((err) => {
    console.error(`[${JOB}]`, err instanceof Error ? err.message : err);
    reportJobOutcome({ job: JOB, selected: 0, written: 0, failed: 1 });
    // `process.exitCode`, NOT `process.exit(1)`. The latter terminates before
    // the `finally` below runs, so the failure counter — the one an absence
    // monitor is actually watching for — would be the one counter guaranteed
    // never to arrive.
    process.exitCode = 1;
  })
  // A `finally`, because `main()` returns early from inside its own `try` for
  // --verify, --census and --rename-v1, and each of those reports an outcome.
  // `datadog-metrics` batches on a 15s timer and this job's fast paths finish
  // in under a second, so an un-awaited flush drops every counter silently —
  // which renders as NO DATA, indistinguishable from an idle healthy job.
  .finally(async () => {
    await flushMetrics();
  });
