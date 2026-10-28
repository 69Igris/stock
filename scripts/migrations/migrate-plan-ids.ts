/**
 * Migration Script: Rename legacy plan IDs in MongoDB
 *
 * Maps:
 *   AI_UNLIMITED → PREMIUM
 *   AI_ADDON     → QUERY_PACK
 *   AI_PRO       → PREMIUM
 *
 * Collections updated:
 *   - subscriptions (planId, addons[])
 *   - payments (planId)
 *   - dodo_products (planType)
 *
 * Usage:
 *   npx tsx scripts/migrations/migrate-plan-ids.ts qa
 *   npx tsx scripts/migrations/migrate-plan-ids.ts prod
 *   npx tsx scripts/migrations/migrate-plan-ids.ts all
 *
 * Idempotent: safe to re-run (updateMany with filter on old values).
 */

import { MongoClient } from "mongodb";
import { execFileSync } from "child_process";

// ── Plan ID mapping ──────────────────────────────────────────────
const PLAN_RENAMES: Record<string, string> = {
  AI_UNLIMITED: "PREMIUM",
  AI_ADDON: "QUERY_PACK",
  AI_PRO: "PREMIUM",
};

// ── Helpers ──────────────────────────────────────────────────────

function getDbUrl(env: string): string {
  // Try environment variable first
  const envKey = env === "prod" ? "DATABASE_URL_PROD" : "DATABASE_URL_QA";
  if (process.env[envKey]) return process.env[envKey]!;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  // Fall back to GCP Secret Manager
  const secretName = env === "prod" ? "DATABASE_URL_PROD" : "DATABASE_URL_QA";
  try {
    const url = execFileSync(
      "gcloud",
      ["secrets", "versions", "access", "latest", `--secret=${secretName}`],
      { encoding: "utf-8" },
    ).trim();
    return url;
  } catch {
    throw new Error(
      `Cannot resolve DB URL for "${env}". Set ${envKey} env var or configure GCP Secret Manager.`,
    );
  }
}

async function migrateEnv(env: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Migrating plan IDs for: ${env.toUpperCase()}`);
  console.log(`${"=".repeat(60)}\n`);

  const url = getDbUrl(env);
  const client = new MongoClient(url);

  try {
    await client.connect();
    const db = client.db(); // uses DB name from connection string

    // ── 1. Subscriptions.planId ─────────────────────────────────
    const subs = db.collection("Subscription");
    for (const [oldId, newId] of Object.entries(PLAN_RENAMES)) {
      const result = await subs.updateMany(
        { planId: oldId },
        { $set: { planId: newId } },
      );
      if (result.modifiedCount > 0) {
        console.log(
          `  [subscriptions] planId "${oldId}" → "${newId}": ${result.modifiedCount} updated`,
        );
      }
    }

    // ── 2. Subscriptions.addons[] ───────────────────────────────
    for (const [oldId, newId] of Object.entries(PLAN_RENAMES)) {
      const docsWithOldAddon = await subs
        .find({ addons: oldId })
        .toArray();
      for (const doc of docsWithOldAddon) {
        const updatedAddons = (doc.addons as string[]).map((a: string) =>
          a === oldId ? newId : a,
        );
        await subs.updateOne(
          { _id: doc._id },
          { $set: { addons: updatedAddons } },
        );
      }
      if (docsWithOldAddon.length > 0) {
        console.log(
          `  [subscriptions] addons[] "${oldId}" → "${newId}": ${docsWithOldAddon.length} updated`,
        );
      }
    }

    // ── 3. Payments.planId ──────────────────────────────────────
    const payments = db.collection("Payment");
    for (const [oldId, newId] of Object.entries(PLAN_RENAMES)) {
      const result = await payments.updateMany(
        { planId: oldId },
        { $set: { planId: newId } },
      );
      if (result.modifiedCount > 0) {
        console.log(
          `  [payments] planId "${oldId}" → "${newId}": ${result.modifiedCount} updated`,
        );
      }
    }

    // ── 4. DodoProducts.planType ────────────────────────────────
    const products = db.collection("dodo_products");
    for (const [oldId, newId] of Object.entries(PLAN_RENAMES)) {
      const result = await products.updateMany(
        { planType: oldId },
        { $set: { planType: newId } },
      );
      if (result.modifiedCount > 0) {
        console.log(
          `  [dodo_products] planType "${oldId}" → "${newId}": ${result.modifiedCount} updated`,
        );
      }
    }

    // ── Summary ─────────────────────────────────────────────────
    console.log(`\n  Migration complete for ${env.toUpperCase()}\n`);
  } finally {
    await client.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const target = process.argv[2];

  if (!target || !["qa", "prod", "all"].includes(target)) {
    console.error("Usage: npx tsx scripts/migrations/migrate-plan-ids.ts <qa|prod|all>");
    process.exit(1);
  }

  const envs = target === "all" ? ["qa", "prod"] : [target];

  for (const env of envs) {
    await migrateEnv(env);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
