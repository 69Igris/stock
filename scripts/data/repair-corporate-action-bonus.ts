#!/usr/bin/env tsx
/**
 * Insert the BONUS row that MONEY-1542's parser defect dropped from NSE
 * subjects naming a split AND a bonus ("Bonus 1:1 / Face Value Split From
 * Rs.10/- To Re.1/-"). The row was typed SPLIT and the bonus was lost: 31 prod
 * rows, so gold's NSE series under-adjust (TITAN 10 where 20 is right). The
 * parser is fixed (`combinedBonusRatio`). This adds the missing row, parsed
 * from each SPLIT row's OWN stored subject, and does not change the SPLIT row.
 * The rules and the measurements are in
 * `./repair-corporate-action-bonus-logic.ts`.
 *
 * ## SAFETY — the same contract as `reanchor-corporate-action-dates.ts`
 *
 *   - DRY RUN BY DEFAULT. Before writing, it checks on the in-memory result
 *     that a second run finds nothing to do.
 *   - `--env=qa|prod` is REQUIRED and is the only way to name a database:
 *     `pinJobEnv` resolves the URI and the client is built from it here.
 *   - `--apply` asks (TTY); `--apply --yes` is the non-interactive consent.
 *   - Every row to be inserted is recorded in `corporate_actions_money1542_backup`
 *     first and counted back.
 *   - The insert is compare-and-set by the unique key. A BONUS that appeared on
 *     that key after the read fails the statement, and the run then exits
 *     non-zero, naming the failed write.
 *   - `--restore` deletes each inserted row only if nothing has written to it
 *     since (same `source` and `updatedAt`). A row an NSE re-walk has merged
 *     into is kept.
 *
 * ## ORDER
 *
 * Run AFTER `reanchor-corporate-action-dates.ts --apply` (MONEY-1530). Running
 * it first is harmless (see the logic header), but that order leaves rows for
 * the re-anchor to move. Then reload the lake so gold sees the new rows:
 *
 *   npx tsx scripts/jobs/corp-action-lake-sink.ts --env prod --apply --reload
 *
 * ## Usage
 *
 *   export CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook
 *   npx tsx scripts/data/repair-corporate-action-bonus.ts --env=prod
 *   npx tsx scripts/data/repair-corporate-action-bonus.ts --env=prod --apply --yes
 *   npx tsx scripts/data/repair-corporate-action-bonus.ts --env=prod --restore
 *   npx tsx scripts/data/repair-corporate-action-bonus.ts --env=prod --restore --apply --yes
 *
 * QA needs no run of its own: `corporate_actions` reaches QA through
 * `sync-prod-to-qa.sh`.
 */
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import { pinJobEnv } from "@usemoney/core/ops/gcp-secrets";
import { redactUri } from "@usemoney/core/ops/atlas-heatmap";
import {
  assertWrite,
  backupVerified,
  consent,
  deleteOps,
  fmt as n,
  idOf,
  readAll,
  readWhole,
  type RawDoc,
  type Run,
} from "./corporate-action-repair-io";
import {
  BACKUP_COLLECTION,
  REPAIR_SOURCE,
  planBonusRepair,
  planBonusRestore,
  simulateBonusRepair,
  type BonusBackupDoc,
} from "./repair-corporate-action-bonus-logic";

const SCRIPT = "repair-corporate-action-bonus";
const COLLECTION = "corporate_actions";

const ARGS = parseCliArgsOrExit(
  process.argv.slice(2),
  { bare: ["apply", "yes", "restore"], valued: ["env"], numeric: [] },
  SCRIPT,
);

const log = (...a: unknown[]): void => console.log(`[${SCRIPT}]`, ...a);

/** An ObjectId: 4 bytes of seconds, then 8 random. */
function newObjectId(): string {
  const secs = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, "0");
  return secs + randomBytes(8).toString("hex");
}

async function repair(run: Run, target: string): Promise<void> {
  const docs = await readWhole(run, COLLECTION);
  log(`read ${n(docs.length)} documents`);
  const plan = planBonusRepair(docs, new Date(), newObjectId);

  log(
    `INSERT BONUS (the split subject names it; no BONUS on the listing that day): ${plan.inserts.length}`,
  );
  for (const i of plan.inserts) {
    const twin = i.twin
      ? `${i.twin.exchange} files BONUS ${String(i.twin.ratio)} too (chart dedupe keeps one)`
      : "no other exchange files it";
    log(
      `   ${i.key} SPLIT ${String(i.splitRatio)} + BONUS ${i.ratio} — ${twin}`,
    );
  }
  log(
    `already present (a BONUS on that listing and IST day): ${plan.present.length}`,
  );
  for (const p of plan.present.filter(
    (x) => Number(x.stored).toFixed(6) !== x.parsed.toFixed(6),
  )) {
    log(`   ${p.key} stored ${String(p.stored)}, the subject says ${p.parsed}`);
  }
  log(`REFUSED: ${plan.refused.length}`);
  for (const r of plan.refused) {
    log(`   ${r.key} ${r.reason} subject ${r.parsed} vs ${r.twins.join(", ")}`);
  }

  const again = planBonusRepair(
    simulateBonusRepair(docs, plan),
    new Date(),
    newObjectId,
  );
  if (again.inserts.length > 0) {
    throw new Error(
      `a second run would still insert ${again.inserts.length} rows — refusing a plan that does not converge.`,
    );
  }
  log("idempotency: re-planning the simulated result finds nothing to do");

  if (plan.inserts.length === 0) {
    log("nothing to do.");
    return;
  }
  log(
    `writes: record ${n(plan.inserts.length)} -> ${BACKUP_COLLECTION}, insert ${n(plan.inserts.length)} (source ${REPAIR_SOURCE})`,
  );
  if (!ARGS.has("apply")) {
    log(
      "DRY RUN — nothing written. Re-run with --apply (--yes non-interactively).",
    );
    return;
  }
  await consent(
    ARGS,
    target,
    `insert ${n(plan.inserts.length)} BONUS rows into ${COLLECTION}`,
  );
  const held = await backupVerified(
    run,
    BACKUP_COLLECTION,
    plan.inserts.map((i) => ({ id: i.id, role: "INSERTED", doc: i.doc })),
  );
  log(`   recorded: ${n(held)} documents in ${BACKUP_COLLECTION}, verified`);
  const res = await run({
    insert: COLLECTION,
    documents: plan.inserts.map((i) => i.doc),
    ordered: false,
  });
  assertWrite(res, plan.inserts.length, "insert BONUS");
  log(`   inserted: ${n(plan.inserts.length)}`);

  const after = planBonusRepair(
    await readAll(run, COLLECTION),
    new Date(),
    newObjectId,
  );
  if (after.inserts.length > 0) {
    throw new Error(
      `${after.inserts.length} events still lack a BONUS after the write.`,
    );
  }
  log("verified: re-planning the collection finds nothing to do.");
}

async function restore(run: Run, target: string): Promise<void> {
  const backup = (await readAll(
    run,
    BACKUP_COLLECTION,
  )) as unknown as BonusBackupDoc[];
  const ids = new Set(backup.map((b) => idOf(b.doc)));
  const current = new Map(
    (await readAll(run, COLLECTION))
      .filter((d) => ids.has(idOf(d)))
      .map((d) => [idOf(d), d]),
  );
  const plan = planBonusRestore(backup, current);
  log(
    `backup holds ${n(backup.length)}: delete ${n(plan.ops.length)}, ` +
      `changed since the repair (kept) ${plan.changedSince.length}, ` +
      `not in ${COLLECTION} ${plan.gone.length}`,
  );
  for (const id of plan.changedSince.slice(0, 10))
    log(`   changed since: ${id}`);
  if (!ARGS.has("apply")) {
    log(
      "DRY RUN — nothing written. Re-run with --restore --apply (--yes non-interactively).",
    );
    return;
  }
  await consent(
    ARGS,
    target,
    `delete ${n(plan.ops.length)} inserted BONUS rows`,
  );
  await deleteOps(run, COLLECTION, plan.ops, "delete inserted BONUS");
  log(`deleted ${n(plan.ops.length)}. ${BACKUP_COLLECTION} is kept.`);
}

async function main(): Promise<void> {
  const env = ARGS.value("env");
  if (env !== "qa" && env !== "prod") {
    throw new Error(
      "--env=qa or --env=prod is required; nothing else names a database.",
    );
  }
  if (ARGS.has("apply") && !ARGS.has("yes") && !process.stdin.isTTY) {
    throw new Error(
      "--apply asks for confirmation and stdin is not a TTY. Read the dry run, then pass --apply --yes.",
    );
  }
  const { databaseUrl } = pinJobEnv(env);
  const target = `${redactUri(databaseUrl)} (--env=${env})`;
  log(
    `${ARGS.has("restore") ? "RESTORE" : "REPAIR"} — ${ARGS.has("apply") ? "APPLY" : "DRY RUN"} — ${target}`,
  );

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const run: Run = async (command) =>
    (await prisma.$runCommandRaw(
      command as Parameters<typeof prisma.$runCommandRaw>[0],
    )) as unknown as RawDoc;
  try {
    if (ARGS.has("restore")) await restore(run, target);
    else await repair(run, target);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(
    `[${SCRIPT}] failed:`,
    err instanceof Error ? err.message : err,
  );
  process.exitCode = 1;
});
