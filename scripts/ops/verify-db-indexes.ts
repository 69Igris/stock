#!/usr/bin/env tsx
/**
 * Does this environment enforce the unique constraints its writers assume?
 * MONEY-1485.
 *
 * ## Why this exists
 *
 * `putCandles` absorbs a duplicate-key collision correctly — a `createMany`
 * that collides falls back to per-row inserts and counts a duplicate as a
 * no-op. That is right, and it is right ONLY IF the unique index exists.
 *
 * In QA it did not. Duplicates predated the `@@unique`, so `prisma db push`
 * could not build `candles_symbol_exchange_timeframe_ts_key`, the index was
 * never created, and the collision the code is written to absorb never
 * happened. Every duplicate inserted cleanly and was counted as `created` — a
 * green run writing exactly the rows its own contract forbids. It surfaced
 * through a developer's local `yarn dev`, not through any monitor, test or job
 * outcome.
 *
 * And `prisma db push` is the ONLY thing that creates these indexes, and it is
 * a DEVELOPER action: it appears in `turbo.json` and in hand-run setup scripts,
 * and in NO deploy pipeline. So a deployed environment can run indefinitely
 * without an index its writers depend on, and nothing says so.
 *
 * ## Safety
 *
 * READ-ONLY, with no `--apply` to forget. It issues `listCollections` and
 * `listIndexes` and nothing else — it never creates an index, because creating
 * one over a table that already holds duplicates is the operation that FAILS,
 * and doing it unattended against prod is not something a verification script
 * should be able to do by accident.
 *
 * ## Usage
 *
 *   npx tsx scripts/ops/verify-db-indexes.ts                 # whatever .env points at (QA)
 *   npx tsx scripts/ops/verify-db-indexes.ts --env qa
 *   npx tsx scripts/ops/verify-db-indexes.ts --env prod
 *   npx tsx scripts/ops/verify-db-indexes.ts --env prod --all # list OK rows too
 *
 * Exit codes: 0 sound · 1 MISSING/WEAKENED found · 2 the audit REFUSED to judge.
 * The third is separate on purpose — "I could not measure" must never share an
 * exit code with "I measured and it was fine".
 */
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

import { auditDatabaseIndexes } from "../../packages/core/src/database/index-guard";
import { formatIndexAudit } from "../../packages/core/src/database/index-guard-logic";

const GCP_PROJECT = "stock-book-483718";

function databaseUrlForEnv(env: "qa" | "prod"): string {
  const secret = env === "qa" ? "DATABASE_URL_QA" : "DATABASE_URL_PROD";
  const out = execFileSync(
    "gcloud",
    [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${secret}`,
      `--project=${GCP_PROJECT}`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: "stockbook" },
    },
  ).trim();
  if (!out) throw new Error(`Could not read ${secret} from Secret Manager`);
  return out;
}

/** Host only. `URL` keeps credentials in username/password, never in `host`. */
function maskedHost(uri: string): string | null {
  try {
    return new URL(uri).host || null;
  } catch {
    const authority = uri.replace(/^[a-z+]+:\/\//i, "").split("/")[0] ?? "";
    const at = authority.lastIndexOf("@");
    return (at >= 0 ? authority.slice(at + 1) : authority).trim() || null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--env");
  const env = i >= 0 ? argv[i + 1] : null;
  if (env !== null && env !== "qa" && env !== "prod") {
    throw new Error(`--env must be qa or prod (got ${String(env)})`);
  }
  const showAll = argv.includes("--all");

  const url = env === null ? process.env.DATABASE_URL : databaseUrlForEnv(env);
  if (!url) throw new Error("No DATABASE_URL — pass --env qa|prod or set it");

  const client = new PrismaClient({ datasources: { db: { url } } });
  console.log(
    `[verify-db-indexes] ${env ?? "(DATABASE_URL)"} -> ${maskedHost(url) ?? "?"}`,
  );

  try {
    const audit = await auditDatabaseIndexes(client);

    if (audit.refusal !== null) {
      console.error(`\nREFUSED: ${audit.refusal}`);
      process.exitCode = 2;
      return;
    }

    if (showAll) {
      for (const f of audit.findings) {
        console.log(`  [${f.verdict}] ${f.model} -> ${f.collection}`);
      }
      console.log("");
    }

    console.log(formatIndexAudit(audit));

    if (audit.failing > 0) {
      console.error(
        `\n${audit.failing} constraint(s) are NOT enforced by this database. ` +
          "Every writer that relies on one of them is currently able to store " +
          "rows the schema forbids, and will report success doing it.",
      );
      process.exitCode = 1;
    }
  } finally {
    await client.$disconnect();
  }
}

/**
 * Guarded so importing this file (a test, a future wrapper) does not connect to
 * a database — the `dedupe-candles.ts` discipline, for the same reason.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  /verify-db-indexes\.(ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
