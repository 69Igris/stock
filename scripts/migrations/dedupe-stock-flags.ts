/**
 * Collapse duplicate `StockFlag` rows — MONEY-1100.
 *
 * ## How duplicates became possible
 *
 * `StockFlag` deliberately carries NO unique constraint. The reason is in the
 * schema: a unique on `(symbol, date, kind)` would quietly turn a 40-day F&O
 * ban into ONE row, destroying the very history the table exists to record.
 *
 * The cost of that choice is that the table is append-only and therefore
 * **not idempotent under concurrent writers**. Two processes parsing the same
 * archived file both insert, and nothing complains. That is exactly what
 * happened on 2026-08-12: a local `feed-parse` run was started for the flag
 * families while the scheduled `feed-parse-prod` Cloud Run job was STILL
 * executing the same families from the 22:35 nightly. 91 identity groups were
 * written twice before the local run was stopped.
 *
 * ## What counts as a duplicate
 *
 * The full business identity — `(symbol, date, kind, value, source)`. Not
 * `(symbol, date, kind)`: a stock can legitimately carry two SURVEILLANCE
 * rows on one day from different frameworks (REG_IND vs REG1_IND), and two
 * genuinely different `value`s are two genuinely different facts. Only a
 * byte-identical repeat is a duplicate.
 *
 * Keeps the OLDEST row in each group (lowest `_id`) so `createdAt` still
 * reflects when the fact was first observed, and deletes the rest.
 *
 * Usage:
 *   node --import tsx scripts/migrations/dedupe-stock-flags.ts          # count only
 *   node --import tsx scripts/migrations/dedupe-stock-flags.ts --apply
 */

import "dotenv/config";

import { prisma } from "@usemoney/database";

const APPLY = process.argv.includes("--apply");

const log = (...a: unknown[]) => console.log("[dedupe-stock-flags]", ...a);

interface DupGroup {
  ids: Array<{ $oid: string }>;
  n: number;
}

/** Identity groups with more than one row, newest ids first within each. */
async function findDuplicateGroups(): Promise<DupGroup[]> {
  const res = (await prisma.$runCommandRaw({
    aggregate: "stock_flags",
    pipeline: [
      {
        $group: {
          _id: {
            symbol: "$symbol",
            date: "$date",
            kind: "$kind",
            value: "$value",
            source: "$source",
          },
          ids: { $push: "$_id" },
          n: { $sum: 1 },
        },
      },
      { $match: { n: { $gt: 1 } } },
      { $project: { _id: 0, ids: 1, n: 1 } },
    ],
    cursor: { batchSize: 5000 },
    allowDiskUse: true,
  })) as { cursor: { firstBatch: DupGroup[] } };
  return res.cursor.firstBatch;
}

async function main(): Promise<void> {
  const groups = await findDuplicateGroups();
  const extra = groups.reduce((sum, g) => sum + (g.n - 1), 0);
  log(
    `duplicate identity groups: ${groups.length}, redundant rows: ${extra} — ` +
      `mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );
  if (groups.length === 0) {
    log("nothing to do.");
    await prisma.$disconnect();
    return;
  }
  if (!APPLY) {
    log("dry-run: pass --apply to delete the redundant copies.");
    await prisma.$disconnect();
    return;
  }

  // Keep the LOWEST _id per group (ObjectIds are time-ordered, so that is the
  // first observation) and delete the rest.
  const doomed: Array<{ $oid: string }> = [];
  for (const g of groups) {
    const sorted = [...g.ids].sort((a, b) => (a.$oid < b.$oid ? -1 : 1));
    doomed.push(...sorted.slice(1));
  }

  let deleted = 0;
  const BATCH = 1000;
  for (let i = 0; i < doomed.length; i += BATCH) {
    const res = (await prisma.$runCommandRaw({
      delete: "stock_flags",
      deletes: [{ q: { _id: { $in: doomed.slice(i, i + BATCH) } }, limit: 0 }],
    })) as { n?: number };
    deleted += res.n ?? 0;
  }

  const remaining = (await findDuplicateGroups()).length;
  log(`DONE: deleted=${deleted} remaining duplicate groups=${remaining}`);
  if (remaining > 0) process.exitCode = 1;
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[dedupe-stock-flags] failed:", err);
  process.exitCode = 1;
});
