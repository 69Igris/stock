/**
 * Purge `parse:<family>` checkpoints so archived files re-parse — MONEY-1175.
 *
 * ## Why this is needed at all
 *
 * `feed-parse` records one `feed_backfill_progress` row per (family, day) with
 * `status: "DONE"` and skips those days on the next run. That is normally
 * exactly right — it makes the nightly job resumable and cheap.
 *
 * It becomes a trap when a run completes SUCCESSFULLY but writes nothing. That
 * is what MONEY-1175 did: `writeCash` skipped every row whose (instrumentId,
 * date) cell was already occupied — including cells owned by YAHOO — then
 * checkpointed the day as DONE. The file was read, the rows were discarded, and
 * the checkpoint now guarantees the file is never read again.
 *
 * The evidence is unambiguous: `parse:nse-cm-udiff-bhavcopy` is checkpointed
 * through 2026-08-11, yet `BHAVCOPY_HIST` rows stop at 2026-03-12 for most
 * symbols. 643 days marked done; five months of them landed nothing.
 *
 * So a data-loss fix in the WRITER is not enough — the checkpoints that
 * recorded the loss as success have to go too, or the corrected writer never
 * sees those files.
 *
 * ## Safety
 *
 * Deleting a checkpoint destroys no data. The worst case is that a day is
 * re-parsed unnecessarily, and the corrected `writeCash` treats an
 * already-correct day as a no-op (equal authority does not upgrade). The
 * expensive resource is time, not correctness.
 *
 * Families must be named explicitly — there is no `--all`. Purging every family
 * would re-parse the derivatives archive too, which is ~100M rows of work for a
 * bug that never touched it.
 *
 * Usage:
 *   node --import tsx scripts/migrations/purge-parse-checkpoints.ts --families=nse-cm-legacy
 *   node --import tsx scripts/migrations/purge-parse-checkpoints.ts --families=a,b,c --apply
 *   node --import tsx scripts/migrations/purge-parse-checkpoints.ts --families=a --from=2026-03-01 --apply
 */

import "dotenv/config";

import { prisma } from "@usemoney/database";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const APPLY = argv.includes("--apply");
const FAMILIES = (arg("families") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const FROM = arg("from");
const TO = arg("to");

const log = (...a: unknown[]) => console.log("[purge-checkpoints]", ...a);

async function main(): Promise<void> {
  if (FAMILIES.length === 0) {
    log("refusing to run: pass --families=<id>[,<id>…] explicitly.");
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  const dateFilter: Record<string, Date> = {};
  if (FROM) dateFilter.gte = new Date(`${FROM}T00:00:00.000Z`);
  if (TO) dateFilter.lte = new Date(`${TO}T00:00:00.000Z`);

  log(
    `families=${FAMILIES.join(",")} ` +
      `${FROM || TO ? `window=${FROM ?? "…"}..${TO ?? "…"} ` : "(full history) "}` +
      `mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );

  let grand = 0;
  for (const family of FAMILIES) {
    const where = {
      family: `parse:${family}`,
      ...(FROM || TO ? { date: dateFilter } : {}),
    };
    const n = await prisma.feedBackfillProgress.count({ where });
    const range = await prisma.feedBackfillProgress.aggregate({
      where,
      _min: { date: true },
      _max: { date: true },
    });
    log(
      `  parse:${family.padEnd(28)} ${String(n).padStart(6)} checkpoint(s)  ` +
        `${range._min.date?.toISOString().slice(0, 10) ?? "-"} .. ` +
        `${range._max.date?.toISOString().slice(0, 10) ?? "-"}`,
    );
    grand += n;

    if (APPLY && n > 0) {
      const res = await prisma.feedBackfillProgress.deleteMany({ where });
      log(`     deleted ${res.count}`);
    }
  }

  log(`${APPLY ? "deleted" : "would delete"} ${grand.toLocaleString()} checkpoint(s)`);
  if (!APPLY) log("dry-run: pass --apply to delete. Nothing changed.");
  else
    log(
      "next: re-run feed-parse for these families. Watch the " +
        "`upgraded-from-lower-source` counter — it is the repair, and on any " +
        "SECOND run it must fall to ~0.",
    );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[purge-checkpoints] failed:", err);
  process.exitCode = 1;
});
