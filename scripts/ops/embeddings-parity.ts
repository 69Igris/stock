/**
 * v1-vs-v2 retrieval parity + latency. MONEY-1499 (B8), B0 §6 criteria 2 and 3.
 *
 * READ-ONLY. It writes nothing, deletes nothing and creates no index. It runs
 * the SAME query against both collections and compares what comes back.
 *
 * ## Usage
 *
 *   npx tsx scripts/ops/embeddings-parity.ts --env=qa
 *   npx tsx scripts/ops/embeddings-parity.ts --env=prod --out=parity.json
 *
 * ## Why it queries directly instead of calling `fetch-document-context`
 *
 * That tool applies a symbol substring filter, a Vertex/Atlas retriever
 * selection and a client-side re-sort on TOP of the vector search — layers
 * that are identical for both collections and that would blur the one
 * difference being measured. The `$vectorSearch` stage here is built by the
 * same `buildVectorSearchStage` the tool uses, with the tool's own
 * `numCandidates: topK * 12` and `limit: topK * 3`, so the measured call is
 * the one the tool makes.
 *
 * ## The latency number is a COMPARISON, not a budget
 *
 * Both sides are measured in the same run, minutes apart, against the same
 * cluster — which is the only way the "no worse than today" criterion can
 * mean anything, since today's p95 is a moving number on a shared cluster.
 * The tolerance lives in `judgeParity`, not here.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import { GCP_PROJECT_ID } from "@usemoney/core/ops/gcp-secrets";
import { buildVectorSearchStage } from "@usemoney/core/embeddings-int8-logic";
import { oid } from "@usemoney/core/embeddings-v2-write";
import {
  judgeParity,
  type QueryResult,
} from "@usemoney/core/ops/embeddings-parity-logic";

const SCRIPT = "embeddings-parity";
const QUERIES = join(
  process.cwd(),
  "scripts",
  "ops",
  "embeddings-parity-queries.json",
);
/** Same well-known system user the research corpus is stored under. */
const SYSTEM_USER_ID = "000000000000000000000001";

const ARGS = parseCliArgsOrExit(
  process.argv.slice(2),
  { bare: [], valued: ["env", "out"], numeric: [] },
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

async function main(): Promise<void> {
  const env = ARGS.value("env");
  if (env !== "qa" && env !== "prod") {
    console.error(`[${SCRIPT}] --env=qa|prod is required`);
    process.exit(1);
  }
  if (!existsSync(QUERIES)) {
    console.error(
      `[${SCRIPT}] ${QUERIES} not found — run this from the repo root`,
    );
    process.exit(1);
  }
  const spec = JSON.parse(readFileSync(QUERIES, "utf8")) as {
    topK: number;
    queries: { symbol: string; query: string }[];
  };
  const topK = spec.topK ?? 6;

  const { generateEmbedding } = await import("@usemoney/core/embeddings");
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrlForEnv(env) } },
  });

  try {
    const results: QueryResult[] = [];
    let noEmbedding = 0;

    for (const { symbol, query } of spec.queries) {
      // Exactly the string `fetch-document-context` embeds.
      const vec = await generateEmbedding(`${symbol}: ${query}`).catch(
        () => null,
      );
      if (!vec) {
        noEmbedding++;
        continue;
      }
      const run = async (mode: "off" | "on") => {
        const search = buildVectorSearchStage({
          mode,
          queryVector: vec,
          numCandidates: topK * 12,
          limit: topK * 3,
          // `oid()` — MONEY-1500. With the bare string BOTH sides returned
          // zero rows, so every overlap was 0/0 and the gate would have been
          // comparing nothing while reporting a number.
          filter: { userId: oid(SYSTEM_USER_ID) },
        });
        if (!search) return { ids: [] as string[], ms: Number.NaN };
        const started = Date.now();
        const res = (await prisma.$runCommandRaw({
          aggregate: search.aggregate,
          pipeline: [search.stage, { $project: { _id: 1 } }],
          cursor: {},
        })) as { cursor?: { firstBatch?: { _id?: { $oid?: string } }[] } };
        const ms = Date.now() - started;
        // AN UNDECODABLE `_id` IS A REFUSAL, NEVER `""` — MONEY-1499 review.
        //
        // `overlapAt` de-duplicates its first argument through a `Set`, so an
        // all-undecoded run compares [""] against [""] and scores a PERFECT
        // 1.000 — a fail-open default on the single number this whole gate
        // exists to produce, and the evidence for arming a one-way rename.
        // Same serializer hazard the repo documents for vectors: `$oid` is the
        // RELAXED spelling and nothing here controls which one comes back.
        const batch = res.cursor?.firstBatch ?? [];
        const ids = batch
          .map((d) => d._id?.$oid)
          .filter((id): id is string => typeof id === "string" && id.length > 0);
        if (ids.length !== batch.length) {
          throw new Error(
            `${batch.length - ids.length} of ${batch.length} result ids did ` +
              "not decode as { $oid }. Refusing to score a comparison against " +
              "ids that were never read.",
          );
        }
        return { ids, ms };
      };

      // v1 then v2, same query, same process, seconds apart.
      const v1 = await run("off");
      const v2 = await run("on");
      results.push({
        query: `${symbol}: ${query}`,
        v1: v1.ids,
        v2: v2.ids,
        v1Ms: v1.ms,
        v2Ms: v2.ms,
      });
    }

    if (noEmbedding > 0) {
      // NAMED, not swallowed: a query that produced no embedding was never
      // compared, and a report that silently drops them is a smaller sample
      // reporting as a full one.
      console.log(
        `[${SCRIPT}] ${noEmbedding} query/queries produced NO EMBEDDING and were not compared`,
      );
    }

    const verdict = judgeParity(results, {
      k: topK,
      minQueries: spec.queries.length,
    });

    console.log(`── ${SCRIPT} (${env}) ──`);
    console.log(
      `  queries compared   ${results.length} of ${spec.queries.length}`,
    );
    console.log(
      `  mean top-${topK} overlap  ${verdict.meanOverlap.toFixed(3)}`,
    );
    console.log(`  worst overlap      ${verdict.worstOverlap.toFixed(3)}`);
    console.log(
      `  p95 v1 / v2        ${verdict.p95V1.toFixed(0)}ms / ${verdict.p95V2.toFixed(0)}ms (${verdict.latencyRatio.toFixed(2)}x)`,
    );
    if (verdict.belowThreshold.length > 0) {
      console.log(`  below the floor    ${verdict.belowThreshold.length}`);
      for (const q of verdict.belowThreshold.slice(0, 10))
        console.log(`    - ${q}`);
    }
    console.log(`  VERDICT            ${verdict.pass ? "PASS" : "FAIL"}`);
    for (const r of verdict.reasons) console.log(`    ! ${r}`);

    const out = ARGS.value("out");
    if (out) {
      writeFileSync(
        out,
        JSON.stringify(
          { env, at: new Date().toISOString(), verdict, results },
          null,
          2,
        ),
      );
      console.log(
        `[${SCRIPT}] wrote ${out} — paste the verdict block into the PR`,
      );
    }
    if (!verdict.pass) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`[${SCRIPT}]`, err instanceof Error ? err.message : err);
  process.exit(1);
});
