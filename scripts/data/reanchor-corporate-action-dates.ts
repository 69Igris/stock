#!/usr/bin/env tsx
/**
 * Re-anchor `corporate_actions` dates to UTC midnight, and collapse the events
 * the old anchors stored twice — MONEY-1530.
 *
 * The parser that wrote these rows resolved NSE's `"08-Sep-2026"` in the
 * process's local time, so the same ex-date is 00:00Z from Cloud Run and 18:30Z
 * the day before from a laptop in IST. The parser is fixed
 * (`nse-filings-logic.ts` `safeOptionalDate`); this repairs what it already
 * wrote. The rule, the survivor choice and the measurements behind both are in
 * `./reanchor-corporate-action-dates-logic.ts`.
 *
 * ## SAFETY
 *
 *   - DRY RUN BY DEFAULT. It reads, plans, prints, and proves on the in-memory
 *     result that a second run would find nothing to do.
 *   - `--env=qa|prod` IS REQUIRED and is the ONLY way to name a database.
 *     `pinJobEnv` resolves `DATABASE_URL_{ENV}` from Secret Manager and the
 *     client is built from that URI explicitly (MONEY-1514). The ambient
 *     `DATABASE_URL` — the repo `.env` is QA — is never read, and nothing here
 *     imports the `@usemoney/database` singleton, which captures it at import.
 *   - ARMING follows `dedupe-candles.ts`, the closest sibling that is also a
 *     dedupe-by-authority: `--apply` ASKS (a TTY prompt echoing the redacted
 *     host), and `--apply --yes` is the non-interactive consent — two
 *     deliberate flags, for an operator or agent that has read the dry run.
 *     `classify-corporate-actions.ts` (same table) writes on a bare `--apply`
 *     with no prompt and no env pin; `reclassify-instruments.ts` and
 *     `resector-real-estate.ts` are TTY-ONLY and cannot be run from a
 *     non-interactive shell at all.
 *   - REVERSIBLE. Every document written or deleted is copied, verbatim, into
 *     `corporate_actions_money1530_backup` first — keyed on its own `_id` with
 *     `$setOnInsert`, so a re-run never overwrites the ORIGINAL with a
 *     half-migrated copy — and the copies are counted back before anything is
 *     touched. `--restore` puts every one of them back.
 *   - COMPARE-AND-SET. Each write names what it read (`updatedAt` for fills and
 *     deletes, `exDate` for moves). A row the 04:30 IST corporate-actions-sync
 *     changed in between is NOT written; the run stops and says so, and running
 *     it again re-plans from the current state. Better still, do not run it
 *     across 04:30 IST.
 *   - IDEMPOTENT. Re-planning the result finds nothing; the run checks that on
 *     the real collection after it writes, and exits non-zero if it does not.
 *
 * ## Usage
 *
 *   export CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook      # pinJobEnv shells out to gcloud
 *   npx tsx scripts/data/reanchor-corporate-action-dates.ts --env=prod
 *   npx tsx scripts/data/reanchor-corporate-action-dates.ts --env=prod --apply --yes
 *   npx tsx scripts/data/reanchor-corporate-action-dates.ts --env=prod --restore
 *   npx tsx scripts/data/reanchor-corporate-action-dates.ts --env=prod --restore --apply --yes
 *
 * QA needs no run of its own: `corporate_actions` reaches QA through
 * `sync-prod-to-qa.sh`, which `mongorestore --drop`s prod's copy over QA's.
 */
import { PrismaClient } from "@prisma/client";
import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import { pinJobEnv } from "@usemoney/core/ops/gcp-secrets";
import { redactUri } from "@usemoney/core/ops/atlas-heatmap";
import {
  backupVerified,
  consent,
  deleteOps,
  fmt as n,
  idOf,
  presentIds,
  readAll,
  readWhole,
  updateOps,
  assertWrite,
  type RawDoc,
  type Run,
} from "./corporate-action-repair-io";
import {
  ANCHORS,
  BACKUP_COLLECTION,
  planReanchor,
  planRestore,
  readDate,
  simulateApply,
  type BackupDoc,
  type ReanchorPlan,
} from "./reanchor-corporate-action-dates-logic";

const SCRIPT = "reanchor-corporate-action-dates";
const COLLECTION = "corporate_actions";
/** Statements per restore command. */
const CHUNK = 500;

const ARGS = parseCliArgsOrExit(
  process.argv.slice(2),
  { bare: ["apply", "yes", "restore"], valued: ["env"], numeric: [] },
  SCRIPT,
);

const log = (...a: unknown[]): void => console.log(`[${SCRIPT}]`, ...a);

function anchorOf(raw: RawDoc | undefined): string {
  const t = readDate(raw?.exDate);
  return t === null ? "?" : new Date(t).toISOString().slice(11, 16) + "Z";
}

function report(plan: ReanchorPlan, docs: readonly RawDoc[]): void {
  const byId = new Map(docs.map((d) => [idOf(d), d]));
  log("time of day (UTC) of each date-only field:");
  for (const [field, counts] of Object.entries(plan.census)) {
    for (const [label, c] of Object.entries(counts)) {
      log(`   ${field.padEnd(11)} ${label.padEnd(26)} ${n(c)}`);
    }
  }
  log(
    `   (anchors this migration understands: ${[...ANCHORS.values()].join(", ")})`,
  );
  log(`refused, left untouched: ${n(plan.refused.length)}`);
  for (const r of plan.refused.slice(0, 10)) {
    log(`   ${r.id} ${r.field}=${JSON.stringify(r.value)}`);
  }

  const tally = (keys: string[]): string =>
    [
      ...keys.reduce(
        (m, k) => m.set(k, (m.get(k) ?? 0) + 1),
        new Map<string, number>(),
      ),
    ]
      .sort((a, b) => b[1] - a[1])
      .map(([k, c]) => `${k} ${n(c)}`)
      .join(" · ");
  const g = plan.groups;
  log(`events stored more than once: ${n(g.length)}`);
  if (g.length > 0) {
    log(`   by type:          ${tally(g.map((x) => x.type))}`);
    log(`   decided by:       ${tally(g.map((x) => x.reason))}`);
    log(
      `   survivor anchor:  ${tally(g.map((x) => anchorOf(byId.get(x.survivor))))}`,
    );
    log(
      `   carried in:       ${tally(g.flatMap((x) => x.carried)) || "nothing"}`,
    );
    const conflicts = g.flatMap((x) =>
      x.conflicts.map((c) => ({ key: x.key, ...c })),
    );
    log(
      `   CONFLICTS (survivor's value kept, loser's is in the backup): ${conflicts.length}`,
    );
    for (const c of conflicts) {
      log(
        `      ${c.key} ${c.field}: kept ${JSON.stringify(c.kept)} dropped ${JSON.stringify(c.dropped)}`,
      );
    }
    const structural = g.filter(
      (x) => x.type === "SPLIT" || x.type === "BONUS",
    );
    log(`   SPLIT/BONUS (these move charts): ${structural.length}`);
    for (const x of structural) {
      const s = byId.get(x.survivor);
      log(
        `      ${x.key} ratio=${JSON.stringify(s?.ratio ?? null)} survivor=${anchorOf(s)} ${x.reason}`,
      );
    }
  }

  const moved = (f: string): number =>
    plan.moves.filter((m) => f in m.set).length;
  log("writes:");
  log(`   backup  ${n(plan.backup.length)} documents -> ${BACKUP_COLLECTION}`);
  log(
    `   fill    ${n(plan.fills.length)} survivors, before their duplicates go`,
  );
  log(`   delete  ${n(plan.deletes.length)} duplicates`);
  log(
    `   move    ${n(plan.moves.length)} rows (exDate ${n(moved("exDate"))}, recordDate ${n(moved("recordDate"))})`,
  );
}

function isEmpty(plan: ReanchorPlan): boolean {
  return (
    plan.fills.length + plan.deletes.length + plan.moves.length === 0 &&
    plan.groups.length === 0
  );
}

async function reanchor(run: Run, target: string): Promise<void> {
  const docs = await readWhole(run, COLLECTION);
  log(`read ${n(docs.length)} documents`);

  const plan = planReanchor(docs, new Date());
  report(plan, docs);

  // Prove idempotency BEFORE writing anything: the same planner over the
  // in-memory result must find no work.
  const again = planReanchor(simulateApply(docs, plan), new Date());
  if (!isEmpty(again)) {
    throw new Error(
      `a second run would still find ${again.fills.length} fills, ` +
        `${again.deletes.length} deletes, ${again.moves.length} moves — ` +
        "refusing a plan that does not converge.",
    );
  }
  log("idempotency: re-planning the simulated result finds nothing to do");

  if (isEmpty(plan)) {
    log("nothing to do.");
    return;
  }
  if (!ARGS.has("apply")) {
    log(
      "DRY RUN — nothing written. Re-run with --apply (--yes non-interactively).",
    );
    return;
  }

  await consent(
    ARGS,
    target,
    `back up ${n(plan.backup.length)}, fill ${n(plan.fills.length)}, ` +
      `delete ${n(plan.deletes.length)}, move ${n(plan.moves.length)} in ${COLLECTION}`,
  );

  const held = await backupVerified(run, BACKUP_COLLECTION, plan.backup);
  log(`   backup: ${n(held)} documents in ${BACKUP_COLLECTION}, verified`);

  // Fill survivors, delete their duplicates, then move onto the freed keys.
  await updateOps(run, COLLECTION, plan.fills, "fill survivors");
  log(`   fill survivors: ${n(plan.fills.length)}`);
  await deleteOps(run, COLLECTION, plan.deletes, "delete duplicates");
  log(`   delete duplicates: ${n(plan.deletes.length)}`);
  await updateOps(run, COLLECTION, plan.moves, "re-anchor dates");
  log(`   re-anchor dates: ${n(plan.moves.length)}`);

  const after = planReanchor(await readAll(run, COLLECTION), new Date());
  if (!isEmpty(after)) {
    report(after, []);
    throw new Error(
      "the collection still needs work after the write — see above.",
    );
  }
  log("verified: re-planning the collection finds nothing to do.");
}

async function restore(run: Run, target: string): Promise<void> {
  const backup = (await readAll(
    run,
    BACKUP_COLLECTION,
  )) as unknown as BackupDoc[];
  const present = await presentIds(
    run,
    COLLECTION,
    backup.map((b) => idOf(b.doc)),
  );
  const plan = planRestore(backup, present);
  log(
    `backup holds ${n(backup.length)}: replace ${n(plan.replace.length)}, re-insert ${n(plan.insert.length)}`,
  );
  if (!ARGS.has("apply")) {
    log(
      "DRY RUN — nothing written. Re-run with --restore --apply (--yes non-interactively).",
    );
    return;
  }
  await consent(
    ARGS,
    target,
    `restore ${n(backup.length)} documents in ${COLLECTION}`,
  );

  // Replace FIRST: a survivor moved onto its duplicate's key has to move off it
  // before the duplicate can come back.
  for (let i = 0; i < plan.replace.length; i += CHUNK) {
    const slice = plan.replace.slice(i, i + CHUNK);
    const res = await run({
      update: COLLECTION,
      updates: slice.map((doc) => {
        const { _id, ...rest } = doc;
        return { q: { _id }, u: rest };
      }),
      ordered: true,
    });
    assertWrite(res, slice.length, "restore (replace)");
  }
  for (let i = 0; i < plan.insert.length; i += CHUNK) {
    const slice = plan.insert.slice(i, i + CHUNK);
    const res = await run({
      insert: COLLECTION,
      documents: slice,
      ordered: true,
    });
    assertWrite(res, slice.length, "restore (re-insert)");
  }
  log(`restored ${n(backup.length)} documents. ${BACKUP_COLLECTION} is kept.`);
}

async function main(): Promise<void> {
  const env = ARGS.value("env");
  if (env !== "qa" && env !== "prod") {
    throw new Error(
      "--env=qa or --env=prod is required; nothing else names a database.",
    );
  }
  // Fail before reading 59k rows: a prompt nobody can answer is not consent.
  if (ARGS.has("apply") && !ARGS.has("yes") && !process.stdin.isTTY) {
    throw new Error(
      "--apply asks for confirmation and stdin is not a TTY. Read the dry run, " +
        "then pass --apply --yes.",
    );
  }
  const { databaseUrl } = pinJobEnv(env);
  const target = `${redactUri(databaseUrl)} (--env=${env})`;
  log(
    `${ARGS.has("restore") ? "RESTORE" : "RE-ANCHOR"} — ${ARGS.has("apply") ? "APPLY" : "DRY RUN"} — ${target}`,
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
    else await reanchor(run, target);
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
