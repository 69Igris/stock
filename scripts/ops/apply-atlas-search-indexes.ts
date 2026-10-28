/**
 * Apply this repo's Atlas Vector Search index definitions. MONEY-1499 (B8).
 *
 * ## Why this exists
 *
 * Until now `document_embeddings_vector_index` existed ONLY in the Atlas UI.
 * There was no diff, no review, no way to recreate it, and no way to tell
 * whether what is live is what anyone intended. `atlas-search-indexes.json`
 * beside this file is now the source; this script is the only thing that
 * writes it, and it is idempotent.
 *
 * ## Usage
 *
 *   npx tsx scripts/ops/apply-atlas-search-indexes.ts --env=prod             # dry run
 *   npx tsx scripts/ops/apply-atlas-search-indexes.ts --env=prod --apply
 *   npx tsx scripts/ops/apply-atlas-search-indexes.ts --env=prod --verify    # exit 3 on drift
 *   npx tsx scripts/ops/apply-atlas-search-indexes.ts --env=prod --probe --apply
 *
 * DRY RUN IS THE DEFAULT. `--apply` is required to write anything, and a
 * `verify-only` index is never written even with it.
 *
 * ## --probe, and why it is not optional before the backfill
 *
 * Two things this migration depends on are unprovable by reading, and BOTH are
 * silent when wrong:
 *
 *   1. that `prisma.$runCommandRaw` carries an extended-JSON binary of subtype
 *      9 into Mongo intact — Prisma's own `Bytes` scalar writes subtype 0, and
 *      a subtype-0 value is simply not a vector to `mongot`;
 *   2. that Atlas accepts a BinData `queryVector` through that same transport.
 *
 * The probe answers both against ONE synthetic row in its own throwaway
 * collection, in about a minute, rather than letting a six-hour backfill and a
 * cut-over discover it. It writes nothing into `document_embeddings_v2` and
 * deletes nothing at all; the cleanup is printed for a human to run.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import { GCP_PROJECT_ID } from "@usemoney/core/ops/gcp-secrets";
import {
  parseIndexManifest,
  planIndex,
  validateSpec,
  verdictFor,
  type IndexSpec,
  type LiveIndex,
} from "@usemoney/core/ops/atlas-search-index-logic";
import {
  EXPECTED_DIMS,
  PROBE_COLLECTION,
  encodeInt8Vector,
  quantizeInt8,
  toEjsonBinary,
  toEjsonQueryVector,
} from "@usemoney/core/embeddings-int8-logic";

const SCRIPT = "apply-atlas-search-indexes";
/**
 * Resolved from the REPO ROOT, which is where every script in this folder is
 * documented to run from. Not from `__dirname` / `import.meta.url`: this
 * folder holds scripts written in both module systems, and each of those two
 * spellings throws under the other one.
 */
const MANIFEST = join(
  process.cwd(),
  "scripts",
  "ops",
  "atlas-search-indexes.json",
);
/** A vectorSearch index on a small collection builds in about a minute. */
const PROBE_WAIT_MS = 180_000;
const PROBE_POLL_MS = 5_000;

const ARGS = parseCliArgsOrExit(
  process.argv.slice(2),
  { bare: ["apply", "verify", "probe"], valued: ["env"], numeric: [] },
  SCRIPT,
);

function databaseUrlForEnv(env: string): string {
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

/**
 * `$listSearchIndexes` is an aggregation STAGE on the connection we already
 * hold, so this needs no Atlas Admin API key pair — the same door B0 §7 used.
 *
 * THREE STATES, never two. A stage that could not run and a collection with no
 * indexes are different facts, and collapsing them is how `listFiles` failing
 * open to `[]` becomes a recorded finding in this repo.
 */
async function listSearchIndexes(
  raw: Raw,
  collection: string,
): Promise<{ ok: true; indexes: LiveIndex[] } | { ok: false; reason: string }> {
  try {
    const res = await raw({
      aggregate: collection,
      pipeline: [{ $listSearchIndexes: {} }],
      cursor: {},
    });
    const batch = ((res.cursor as { firstBatch?: unknown[] })?.firstBatch ??
      []) as LiveIndex[];
    return { ok: true, indexes: batch };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const env = ARGS.value("env");
  if (env !== "qa" && env !== "prod") {
    console.error(`[${SCRIPT}] --env=qa|prod is required`);
    process.exit(1);
  }
  const apply = ARGS.has("apply");
  const verifyOnly = ARGS.has("verify");
  const probe = ARGS.has("probe");

  if (!existsSync(MANIFEST)) {
    console.error(
      `[${SCRIPT}] ${MANIFEST} not found — run this from the repo root`,
    );
    process.exit(1);
  }
  const specs = parseIndexManifest(JSON.parse(readFileSync(MANIFEST, "utf8")));

  // Validate BEFORE connecting. A definition that would make Atlas silently
  // skip every vector must never reach the cluster, and refusing it costs no
  // connection at all.
  const problems = specs.flatMap((s) => validateSpec(s));
  if (problems.length > 0) {
    console.error(`[${SCRIPT}] the manifest is not applicable:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`[${SCRIPT}] manifest OK — ${specs.length} index definitions`);

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrlForEnv(env) } },
  });
  const raw: Raw = (cmd) =>
    prisma.$runCommandRaw(cmd as never) as unknown as Promise<
      Record<string, unknown>
    >;

  try {
    if (probe) {
      await runProbe(raw, specs, apply);
      return;
    }

    const plans = [];
    for (const spec of specs) {
      // The probe index is provisioned only by --probe; it is not part of the
      // steady-state estate and applying it here would create a collection
      // nobody asked for.
      if (spec.manage === "probe") continue;
      const live = await listSearchIndexes(raw, spec.collection);
      if (!live.ok) {
        console.error(
          `[${SCRIPT}] DID NOT RUN for ${spec.collection}: ${live.reason}\n` +
            "  (this is NOT the same as 'no indexes' — refusing to plan against an unknown)",
        );
        process.exitCode = 1;
        continue;
      }
      plans.push(
        planIndex(spec, live.indexes.find((i) => i.name === spec.name) ?? null),
      );
    }

    for (const plan of plans) {
      const { spec, action, reason } = plan;
      console.log(
        `  ${action.toUpperCase().padEnd(6)} ${spec.collection}.${spec.name} — ${reason}`,
      );
      if (verifyOnly || !apply || action === "noop" || action === "drift")
        continue;
      if (action === "create") {
        await raw({
          createSearchIndexes: spec.collection,
          indexes: [
            { name: spec.name, type: spec.type, definition: spec.definition },
          ],
        });
        console.log(`         created — Atlas builds it asynchronously`);
      } else {
        await raw({
          updateSearchIndex: spec.collection,
          name: spec.name,
          definition: spec.definition,
        });
        console.log(`         updated — Atlas REBUILDS the index`);
      }
    }

    const verdict = verdictFor(plans);
    console.log(`[${SCRIPT}] ${verdict.summary}`);
    if (!apply && !verifyOnly)
      console.log(`[${SCRIPT}] DRY RUN — nothing written. Pass --apply.`);
    if (verdict.exitCode !== 0) process.exitCode = verdict.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Writes ONE synthetic row and asks the two questions that cannot be answered
 * by reading code. Every step reports what it proved, because a probe that
 * says only "ok" is a probe nobody can act on when it later says "not ok".
 */
async function runProbe(
  raw: Raw,
  specs: readonly IndexSpec[],
  apply: boolean,
): Promise<void> {
  const spec = specs.find((s) => s.manage === "probe");
  if (!spec) throw new Error("the manifest declares no probe index");
  if (!apply) {
    console.log(
      `[${SCRIPT}] --probe needs --apply (it writes one synthetic row). Nothing done.`,
    );
    return;
  }

  // A deterministic non-degenerate vector: nothing about the CONTENT matters,
  // only that it quantizes and round-trips.
  const floats = Array.from(
    { length: EXPECTED_DIMS },
    (_, i) => Math.sin(i + 1) / 8,
  );
  const q = quantizeInt8(floats);
  if (!q.ok) throw new Error(`the probe vector did not quantize: ${q.reason}`);
  const payload = encodeInt8Vector(q.bytes);

  console.log(
    `[${SCRIPT}] 1/4 writing one row into ${PROBE_COLLECTION} (subtype 9, ${payload.length} B)`,
  );
  await raw({
    update: PROBE_COLLECTION,
    updates: [
      {
        q: { _id: "probe" },
        u: {
          $set: {
            _id: "probe",
            embedding: toEjsonBinary(payload),
            note: "MONEY-1499 canary",
          },
        },
        upsert: true,
      },
    ],
  });

  // Read it straight back. If Prisma downgraded the subtype, or mangled the
  // bytes, this is where it shows — BEFORE an index exists to blame.
  const back = await raw({
    find: PROBE_COLLECTION,
    filter: { _id: "probe" },
    limit: 1,
  });
  const doc = ((back.cursor as { firstBatch?: Record<string, unknown>[] })
    ?.firstBatch ?? [])[0];
  const bin = (
    doc?.embedding as { $binary?: { subType?: string; base64?: string } }
  )?.$binary;
  console.log(
    `[${SCRIPT}] 2/4 read back: subType=${bin?.subType ?? "MISSING"} ` +
      `bytes=${bin?.base64 ? Buffer.from(bin.base64, "base64").length : 0}`,
  );
  if (bin?.subType !== "09") {
    throw new Error(
      `subtype came back as ${JSON.stringify(bin?.subType)} — Atlas will not index this as a ` +
        "vector. The whole v2 design depends on subtype 9 surviving $runCommandRaw.",
    );
  }

  const live = await listSearchIndexes(raw, PROBE_COLLECTION);
  if (!live.ok) throw new Error(`could not list probe indexes: ${live.reason}`);
  if (!live.indexes.some((i) => i.name === spec.name)) {
    console.log(`[${SCRIPT}] 3/4 creating ${spec.name}`);
    await raw({
      createSearchIndexes: PROBE_COLLECTION,
      indexes: [
        { name: spec.name, type: spec.type, definition: spec.definition },
      ],
    });
  }
  const deadline = Date.now() + PROBE_WAIT_MS;
  let queryable = false;
  while (Date.now() < deadline) {
    const now = await listSearchIndexes(raw, PROBE_COLLECTION);
    if (
      now.ok &&
      now.indexes.some((i) => i.name === spec.name && i.queryable === true)
    ) {
      queryable = true;
      break;
    }
    await new Promise((r) => setTimeout(r, PROBE_POLL_MS));
  }
  console.log(`[${SCRIPT}] 3/4 index queryable=${queryable}`);
  if (!queryable)
    throw new Error("the probe index did not become queryable within the wait");

  const queryVector = toEjsonQueryVector(floats);
  if (!queryVector) throw new Error("the probe query vector did not quantize");
  const res = await raw({
    aggregate: PROBE_COLLECTION,
    pipeline: [
      {
        $vectorSearch: {
          index: spec.name,
          path: "embedding",
          queryVector,
          numCandidates: 10,
          limit: 1,
        },
      },
      { $project: { _id: 1, score: { $meta: "vectorSearchScore" } } },
    ],
    cursor: {},
  });
  const hits =
    (res.cursor as { firstBatch?: Record<string, unknown>[] })?.firstBatch ??
    [];
  console.log(
    `[${SCRIPT}] 4/4 $vectorSearch with a BinData queryVector returned ${hits.length} row(s)`,
  );
  if (hits.length === 0) {
    throw new Error(
      "the index is queryable and the row is stored, but the search matched nothing — " +
        "that is the SILENT-SKIP shape: check the index definition carries no `quantization`.",
    );
  }
  console.log(
    `[${SCRIPT}] PROBE PASSED. Both unknowns are answered: subtype 9 survives ` +
      "$runCommandRaw, and Atlas accepts a BinData queryVector through it.\n" +
      `[${SCRIPT}] cleanup (a human step, this script deletes nothing):\n` +
      `  db.${PROBE_COLLECTION}.dropSearchIndex("${spec.name}"); db.${PROBE_COLLECTION}.drop();`,
  );
}

main().catch((err) => {
  console.error(`[${SCRIPT}]`, err instanceof Error ? err.message : err);
  process.exit(1);
});
