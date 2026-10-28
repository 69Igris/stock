#!/usr/bin/env tsx
/**
 * Repair `corporate_actions.dividendPerShare` where MONEY-1535's parser defect
 * wrote a wrong value or failed to write one.
 *
 * `parseDividendPerShare` read `Rs`/`Re` inside words ("Shareholders 6 Aug" ->
 * Rs 6) and could not read BSE's "Rs. - 7.0000", so 14,412 BSE dividends and 49
 * NSE ones sit at null and two carry a wrong amount (prod, 2026-09-23). The
 * parser is fixed; this re-derives the value from each row's OWN stored
 * subject. The rules and the measurements are in
 * `./repair-corporate-action-dividends-logic.ts`.
 *
 * ## SAFETY — the same contract as `reanchor-corporate-action-dates.ts`
 *
 *   - DRY RUN BY DEFAULT; it proves on the in-memory result that a second run
 *     finds nothing to do.
 *   - `--env=qa|prod` is REQUIRED and is the only way to name a database:
 *     `pinJobEnv` resolves the URI and the client is built from it here.
 *   - `--apply` asks (TTY); `--apply --yes` is the non-interactive consent.
 *   - Every written row is copied to `corporate_actions_money1535_backup`
 *     first and counted back. Writes are compare-and-set on the `updatedAt`
 *     that was read.
 *   - `--restore` is FIELD-LEVEL: `dividendPerShare` and `updatedAt` only, on
 *     rows still holding the value written here.
 *
 * ## ORDER relative to MONEY-1530
 *
 * Run AFTER `reanchor-corporate-action-dates.ts --apply`: the re-anchor deletes
 * 1,772 duplicate rows, so repairing first writes values the dedupe then
 * throws away (they stay in its backup). Either order completes and loses
 * nothing — this touches one value field, never a date or a key, and its
 * restore touches only that field. Reverse in the opposite order: this
 * `--restore` first, then the re-anchor's.
 *
 * ## Usage
 *
 *   export CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook
 *   npx tsx scripts/data/repair-corporate-action-dividends.ts --env=prod
 *   npx tsx scripts/data/repair-corporate-action-dividends.ts --env=prod --apply --yes
 *   npx tsx scripts/data/repair-corporate-action-dividends.ts --env=prod --restore
 *   npx tsx scripts/data/repair-corporate-action-dividends.ts --env=prod --restore --apply --yes
 */
import { PrismaClient } from "@prisma/client";
import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import { pinJobEnv } from "@usemoney/core/ops/gcp-secrets";
import { redactUri } from "@usemoney/core/ops/atlas-heatmap";
import {
  backupVerified,
  consent,
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
  planDividendRepair,
  planDividendRestore,
  simulateDividendRepair,
  type DividendBackupDoc,
} from "./repair-corporate-action-dividends-logic";

const SCRIPT = "repair-corporate-action-dividends";
const COLLECTION = "corporate_actions";

const ARGS = parseCliArgsOrExit(
  process.argv.slice(2),
  { bare: ["apply", "yes", "restore"], valued: ["env"], numeric: [] },
  SCRIPT,
);

const log = (...a: unknown[]): void => console.log(`[${SCRIPT}]`, ...a);

async function repair(run: Run, target: string): Promise<void> {
  const docs = await readWhole(run, COLLECTION);
  log(`read ${n(docs.length)} documents`);
  const plan = planDividendRepair(docs, new Date());

  const corrected = plan.changes.filter((c) => c.fix === "CORRECT");
  const filled = plan.changes.filter((c) => c.fix === "FILL");
  log(
    `CORRECT (the old parser's value; the fixed one differs): ${corrected.length}`,
  );
  for (const c of corrected)
    log(`   ${c.key} ${c.source}: ${c.from} -> ${c.to}`);
  const bySource = new Map<string, number>();
  for (const c of filled) {
    const k = String(c.source);
    bySource.set(k, (bySource.get(k) ?? 0) + 1);
  }
  log(
    `FILL (null; the subject states an amount): ${n(filled.length)} — ` +
      [...bySource].map(([k, v]) => `${k} ${n(v)}`).join(" · "),
  );
  for (const c of filled.slice(0, 5)) log(`   e.g. ${c.key} -> ${c.to}`);
  log(
    `left alone — a value neither parser derives from the stored subject ` +
      `(a same-day sibling dividend's amount): ${plan.unattributed.length}`,
  );
  for (const u of plan.unattributed) {
    log(`   ${u.key} stored ${u.stored}, subject says ${u.parsed}`);
  }
  log(
    `refused — DIVIDEND rows with no dividendPerShare field: ${plan.refusedNoField.length}`,
  );

  const again = planDividendRepair(
    simulateDividendRepair(docs, plan),
    new Date(),
  );
  if (again.ops.length > 0) {
    throw new Error(
      `a second run would still write ${again.ops.length} rows — refusing a plan that does not converge.`,
    );
  }
  log("idempotency: re-planning the simulated result finds nothing to do");

  if (plan.ops.length === 0) {
    log("nothing to do.");
    return;
  }
  log(
    `writes: backup ${n(plan.backup.length)} -> ${BACKUP_COLLECTION}, set ${n(plan.ops.length)}`,
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
    `set dividendPerShare on ${n(plan.ops.length)} rows of ${COLLECTION}`,
  );
  const held = await backupVerified(run, BACKUP_COLLECTION, plan.backup);
  log(`   backup: ${n(held)} documents in ${BACKUP_COLLECTION}, verified`);
  await updateOps(run, COLLECTION, plan.ops, "set dividendPerShare");
  log(`   set dividendPerShare: ${n(plan.ops.length)}`);

  const after = planDividendRepair(await readAll(run, COLLECTION), new Date());
  if (after.ops.length > 0) {
    throw new Error(
      `${after.ops.length} rows still need repair after the write.`,
    );
  }
  log("verified: re-planning the collection finds nothing to do.");
}

async function restore(run: Run, target: string): Promise<void> {
  const backup = (await readAll(
    run,
    BACKUP_COLLECTION,
  )) as unknown as DividendBackupDoc[];
  const ids = new Set(backup.map((b) => idOf(b.doc)));
  const current = new Map(
    (await readAll(run, COLLECTION))
      .filter((d) => ids.has(idOf(d)))
      .map((d) => [idOf(d), d]),
  );
  const plan = planDividendRestore(backup, current);
  log(
    `backup holds ${n(backup.length)}: restore ${n(plan.ops.length)}, ` +
      `changed since the repair (left as they are) ${plan.changedSince.length}, ` +
      `no longer in ${COLLECTION} ${plan.gone.length}`,
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
    `restore dividendPerShare on ${n(plan.ops.length)} rows`,
  );
  await updateOps(run, COLLECTION, plan.ops, "restore dividendPerShare");
  log(`restored ${n(plan.ops.length)}. ${BACKUP_COLLECTION} is kept.`);
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
