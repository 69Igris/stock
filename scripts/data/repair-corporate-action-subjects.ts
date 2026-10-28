#!/usr/bin/env tsx
/**
 * Re-read `corporate_actions` subjects with the fixed parser and write what it
 * would have written. MONEY-1598, MONEY-1599 and MONEY-1603 are counted apart.
 *
 *   MONEY-1598  SPLIT_FILL / SPLIT_CORRECT  split ratios from "Fv Split Rs.10/-
 *               To Rs.2/", which names no "From" (156 nulls, JBMA, SHARONBIO)
 *   MONEY-1599  DIVIDEND_INSERT             the dividend a combined subject
 *                                           dropped (56)
 *               SPLIT_INSERT / BONUS_INSERT the legs NSE abbreviated as "Spl"
 *                                           and "Bon" (9 + 3, review round)
 *               RETYPE                      BONUS rows of debentures, NCRPS,
 *                                           preference or DVR shares -> OTHER
 *                                           (5, ZEEL's 22 among them)
 *   MONEY-1603  DIVIDEND_FILL / DIVIDEND_CORRECT  amounts from "Int Div-Rs 0.5"
 *               (1,694 nulls), and two dividends in one subject summed (405);
 *               an amount it cannot account for is UNREAD, never a part (0)
 *
 * The rules and measurements are in `./repair-corporate-action-subjects-logic.ts`.
 *
 * ## SAFETY — the same contract as `repair-corporate-action-bonus.ts`
 *
 *   - DRY RUN BY DEFAULT. Before writing, it checks on the in-memory result
 *     that a second run finds nothing to do.
 *   - `--env=qa|prod` is REQUIRED and is the only way to name a database.
 *   - `--apply` asks (TTY); `--apply --yes` is the non-interactive consent.
 *   - Every row it updates or inserts is copied to
 *     `corporate_actions_money1598_1599_1603_backup` first and counted back.
 *   - Updates are compare-and-set on every field they change plus `updatedAt`.
 *     Inserts and retypes are guarded by the unique key. A failed statement
 *     exits non-zero, naming the failed write.
 *   - `--restore` puts back only what this repair wrote: the changed fields of
 *     an updated row, and it deletes an inserted row. It does this only while
 *     the row still holds the written values.
 *
 * ## ORDER
 *
 *   1. repair-corporate-action-bonus.ts --apply --yes (MONEY-1542)
 *   2. this, --apply --yes
 *   3. corp-action-lake-sink.ts --env prod --apply --reload
 *
 * Step 3 must come AFTER this. The retyped rows sit in silver at v2 only. The
 * reload prunes a v2 row once its `_id` has a v3 row, so the stale BONUS goes
 * with it. After a v3 reload that happened first, those BONUS rows would stay.
 *
 * ## Usage
 *
 *   export CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook
 *   npx tsx scripts/data/repair-corporate-action-subjects.ts --env=prod
 *   npx tsx scripts/data/repair-corporate-action-subjects.ts --env=prod --apply --yes
 *   npx tsx scripts/data/repair-corporate-action-subjects.ts --env=prod --restore
 *   npx tsx scripts/data/repair-corporate-action-subjects.ts --env=prod --restore --apply --yes
 */
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import { pinJobEnv } from "@usemoney/core/ops/gcp-secrets";
import { redactUri } from "@usemoney/core/ops/atlas-heatmap";
import {
  assertWrite,
  consent,
  deleteOps,
  fmt as n,
  idOf,
  readAll,
  readWhole,
  updateOps,
  type RawDoc,
  type Run,
} from "./corporate-action-repair-io";
import {
  BACKUP_COLLECTION,
  backupStatements,
  planSubjectRepair,
  planSubjectRestore,
  simulateSubjectRepair,
  type Role,
  type SubjectBackupDoc,
  type SubjectRepairPlan,
} from "./repair-corporate-action-subjects-logic";

const SCRIPT = "repair-corporate-action-subjects";
const COLLECTION = "corporate_actions";
/** Statements per write command. */
const CHUNK = 500;

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

function tally(values: unknown[]): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(String(v), (m.get(String(v)) ?? 0) + 1);
  return [...m]
    .sort((a, b) => b[1] - a[1])
    .map(([k, c]) => `${k} x${c}`)
    .join(", ");
}

function report(plan: SubjectRepairPlan): void {
  const of = (r: Role) => plan.changes.filter((c) => c.role === r);
  log("── MONEY-1598 — split ratios ──");
  log(
    `   SPLIT_FILL (null; the face value names it): ${of("SPLIT_FILL").length} — ratio ${tally(of("SPLIT_FILL").map((c) => c.to))}`,
  );
  log(
    `   SPLIT_CORRECT (the face value disagrees): ${of("SPLIT_CORRECT").length}`,
  );
  for (const c of of("SPLIT_CORRECT"))
    log(`      ${c.key} ${String(c.from)} -> ${String(c.to)} | ${c.details}`);
  log(
    `   confirmed by the face value, left alone: ${plan.confirmed.length} ${plan.confirmed.join(" ")}`,
  );
  log(
    `   left alone — differs only from an a:b token: ${plan.unattributed.length}`,
  );
  for (const u of plan.unattributed)
    log(`      ${u.key} stored ${String(u.stored)}, token ${u.parsed}`);

  log("── MONEY-1599 — combined subjects ──");
  const div = of("DIVIDEND_INSERT");
  log(
    `   DIVIDEND_INSERT: ${div.length} — beside ${tally(div.map((c) => c.from))}; ` +
      `with an amount ${div.filter((c) => c.to !== null).length}, null ${div.filter((c) => c.to === null).length}`,
  );
  for (const c of div.slice(0, 5))
    log(`      e.g. ${c.key} ${String(c.from)} + DIVIDEND ${String(c.to)}`);
  for (const role of ["SPLIT_INSERT", "BONUS_INSERT"] as const) {
    log(
      `   ${role} (NSE's "Spl-Rs10 To Rs2" / "Bon 1:1" beside another action): ${of(role).length}`,
    );
    for (const c of of(role))
      log(
        `      ${c.key} ${String(c.from)} + ${role.split("_")[0]} ${String(c.to)} | ${c.details}`,
      );
  }
  log(
    `   a row of the leg's type already on the listing that day: ${plan.legPresent.length}`,
  );
  for (const p of plan.legPresent)
    log(
      `      ${p.key} ${p.type} stored ${String(p.stored)}, subject ${String(p.parsed)}`,
    );
  log(`   RETYPE (a bonus of no shares): ${of("RETYPE").length}`);
  for (const c of of("RETYPE"))
    log(`      ${c.key} BONUS -> ${String(c.to)} | ${c.details}`);
  log(`   REFUSED: ${plan.refused.length}`);
  for (const r of plan.refused) log(`      ${r.key} ${r.reason}`);

  log("── MONEY-1603 — dividend amounts ──");
  const fill = of("DIVIDEND_FILL");
  log(
    `   DIVIDEND_FILL (null; the subject names an amount): ${n(fill.length)}`,
  );
  for (const c of fill.slice(0, 3))
    log(`      e.g. ${c.key} -> ${String(c.to)} | ${c.details}`);
  const fix = of("DIVIDEND_CORRECT");
  log(
    `   DIVIDEND_CORRECT (our parser's old value; the subject names more): ${fix.length}`,
  );
  for (const c of fix)
    log(`      ${c.key} ${String(c.from)} -> ${String(c.to)} | ${c.details}`);
  log(
    `   left alone — a stored amount no parser of ours read from the subject: ${plan.dividendUnattributed.length}`,
  );
  for (const u of plan.dividendUnattributed)
    log(`      ${u.key} stored ${String(u.stored)}, subject ${u.parsed}`);
  log(
    `   MONEY-1599 legs (${"NSE_REPARSE"}), left to the repair that wrote them: ${plan.legsSkipped}`,
  );
  log(
    `   UNREAD — the subject names an amount the parser cannot account for (kept as stored, never filled with a part): ${plan.dividendUnread.length}`,
  );
  for (const u of plan.dividendUnread)
    log(
      `      ${u.key} stored ${String(u.stored)}, unread ${u.unread.join(", ")}`,
    );
}

/**
 * Record every row in the backup, then COUNT THEM BACK — the contract of
 * `corporate-action-repair-io.ts`'s `backupVerified`, whose `$setOnInsert` is
 * kept byte-identical for the repairs already applied with it. Here `wrote` is
 * rewritten on every run: see `backupStatements`.
 */
async function backupLatest(
  run: Run,
  plan: SubjectRepairPlan,
): Promise<number> {
  const statements = backupStatements(plan.backup, new Date());
  for (let i = 0; i < statements.length; i += CHUNK) {
    const slice = statements.slice(i, i + CHUNK);
    const res = await run({
      update: BACKUP_COLLECTION,
      updates: slice,
      ordered: false,
    });
    assertWrite(res, slice.length, "backup");
  }
  let held = 0;
  for (let i = 0; i < plan.backup.length; i += CHUNK) {
    const res = await run({
      count: BACKUP_COLLECTION,
      query: {
        _id: {
          $in: plan.backup.slice(i, i + CHUNK).map((b) => ({ $oid: b.id })),
        },
      },
    });
    held += Number(res.n);
  }
  if (held !== plan.backup.length) {
    throw new Error(
      `backup holds ${held} of ${plan.backup.length} — nothing modified.`,
    );
  }
  return held;
}

async function repair(run: Run, target: string): Promise<void> {
  const docs = await readWhole(run, COLLECTION);
  log(`read ${n(docs.length)} documents`);
  const plan = planSubjectRepair(docs, new Date(), newObjectId);
  report(plan);

  const again = planSubjectRepair(
    simulateSubjectRepair(docs, plan),
    new Date(),
    newObjectId,
  );
  if (again.changes.length > 0) {
    throw new Error(
      `a second run would still make ${again.changes.length} changes — refusing a plan that does not converge.`,
    );
  }
  log("idempotency: re-planning the simulated result finds nothing to do");

  if (plan.changes.length === 0) {
    log("nothing to do.");
    return;
  }
  log(
    `writes: backup ${n(plan.backup.length)} -> ${BACKUP_COLLECTION}, ` +
      `update ${n(plan.updates.length)}, insert ${n(plan.inserts.length)}`,
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
    `update ${n(plan.updates.length)} and insert ${n(plan.inserts.length)} rows of ${COLLECTION}`,
  );
  const held = await backupLatest(run, plan);
  log(`   backup: ${n(held)} documents in ${BACKUP_COLLECTION}, verified`);
  await updateOps(run, COLLECTION, plan.updates, "update");
  log(`   updated: ${n(plan.updates.length)}`);
  if (plan.inserts.length > 0) {
    const res = await run({
      insert: COLLECTION,
      documents: plan.inserts,
      ordered: false,
    });
    assertWrite(res, plan.inserts.length, "insert DIVIDEND");
  }
  log(`   inserted: ${n(plan.inserts.length)}`);

  const after = planSubjectRepair(
    await readAll(run, COLLECTION),
    new Date(),
    newObjectId,
  );
  if (after.changes.length > 0) {
    throw new Error(
      `${after.changes.length} rows still need repair after the write.`,
    );
  }
  log("verified: re-planning the collection finds nothing to do.");
}

async function restore(run: Run, target: string): Promise<void> {
  const backup = (await readAll(
    run,
    BACKUP_COLLECTION,
  )) as unknown as SubjectBackupDoc[];
  const ids = new Set(backup.map((b) => idOf(b.doc)));
  const current = new Map(
    (await readAll(run, COLLECTION))
      .filter((d) => ids.has(idOf(d)))
      .map((d) => [idOf(d), d]),
  );
  const plan = planSubjectRestore(backup, current);
  log(
    `backup holds ${n(backup.length)}: put back ${n(plan.updates.length)}, ` +
      `delete ${n(plan.deletes.length)}, changed since the repair (kept) ` +
      `${plan.changedSince.length}, not in ${COLLECTION} ${plan.gone.length}`,
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
    `put back ${n(plan.updates.length)} rows and delete ${n(plan.deletes.length)}`,
  );
  await deleteOps(
    run,
    COLLECTION,
    plan.deletes,
    "delete inserted DIVIDEND/SPLIT/BONUS legs",
  );
  await updateOps(run, COLLECTION, plan.updates, "restore fields");
  log(
    `restored ${n(plan.updates.length)}, deleted ${n(plan.deletes.length)}. ${BACKUP_COLLECTION} is kept.`,
  );
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
