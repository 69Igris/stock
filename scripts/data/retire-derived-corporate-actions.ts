#!/usr/bin/env tsx
/**
 * Retire price-derived corporate actions their own series no longer supports —
 * MONEY-1600.
 *
 * `derive-corporate-actions.ts` only ever adds `source: "DERIVED"` rows. This
 * re-reads each one against its OWN listing's exchange closes with the
 * detector's own test and deletes what that test now refuses. The rule and the
 * measurements are in `./retire-derived-corporate-actions-logic.ts`; the test is
 * `verifyCliff` in `packages/core/src/market-data/corporate-action-detect.ts`.
 *
 * A ONE-OFF, not a pass inside a job: the detector has no scheduled job to
 * host it. `derive-corporate-actions.ts` is run by hand through
 * `run-market-data-job.sh derive`, on the ambient-`DATABASE_URL` singleton with
 * a bare `--apply` — none of the backup, compare-and-set or restore this needs.
 * Its `MAX_CLIFF_GAP_DAYS` guard stops it writing a row this would retire.
 *
 * ## SAFETY — the MONEY-1530 contract (`reanchor-corporate-action-dates.ts`)
 *
 *   - DRY RUN BY DEFAULT; it proves on the in-memory result that a second run
 *     finds nothing to do.
 *   - `--env=qa|prod` is REQUIRED and is the only way to name a database:
 *     `pinJobEnv` resolves the URI and the client is built from it here.
 *   - `--apply` asks (TTY); `--apply --yes` is the non-interactive consent.
 *   - Every retired row is copied, verbatim, to
 *     `corporate_actions_money1600_backup` first and counted back. Deletes are
 *     compare-and-set on `source: "DERIVED"` and the `updatedAt` that was read.
 *   - `--restore` re-inserts every backed-up row that is not present again.
 *
 * ## After an apply
 *
 * The chart and tile paths read Mongo, so they stop applying a retired row
 * within the web cache's 5 minutes and on the next tile build. The LAKE follows
 * on the next `corp-action-lake-sink.ts --apply`: an older-version row goes
 * with a `--reload`'s orphan arm, and a current-version row with the third arm
 * (MONEY-1607), which runs on every `--apply` under the same whole-read proof.
 *
 * ## Usage
 *
 *   export CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook
 *   npx tsx scripts/data/retire-derived-corporate-actions.ts --env=prod
 *   npx tsx scripts/data/retire-derived-corporate-actions.ts --env=prod --apply --yes
 *   npx tsx scripts/data/retire-derived-corporate-actions.ts --env=prod --restore
 *   npx tsx scripts/data/retire-derived-corporate-actions.ts --env=prod --restore --apply --yes
 *
 * QA needs no run of its own: `corporate_actions` reaches QA through
 * `sync-prod-to-qa.sh`.
 */
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
  presentIds,
  readAll,
  readWhole,
  type RawDoc,
  type Run,
} from "./corporate-action-repair-io";
import {
  BACKUP_COLLECTION,
  idOfDoc,
  planRetire,
  planRetireRestore,
  sessionDay,
  simulateRetire,
  type Evidence,
  type RetireBackupDoc,
  type RetirePlan,
} from "./retire-derived-corporate-actions-logic";
import { readDate } from "./reanchor-corporate-action-dates-logic";

const SCRIPT = "retire-derived-corporate-actions";
const COLLECTION = "corporate_actions";
/** The detector reads exchange closes only; Yahoo's are already adjusted. */
const EXCHANGE_SOURCES = ["BHAVCOPY", "BHAVCOPY_HIST"];
const CHUNK = 500;

const ARGS = parseCliArgsOrExit(
  process.argv.slice(2),
  { bare: ["apply", "yes", "restore"], valued: ["env"], numeric: [] },
  SCRIPT,
);

const log = (...a: unknown[]): void => console.log(`[${SCRIPT}]`, ...a);

const firstBatch = (res: RawDoc): RawDoc[] =>
  (res.cursor as { firstBatch?: RawDoc[] } | undefined)?.firstBatch ?? [];

/** One close either side of a row's day, from the listing's exchange series. */
async function closeAt(
  run: Run,
  instrumentId: unknown,
  date: RawDoc,
  direction: 1 | -1,
): Promise<{ date: Date; close: number; volume: number } | null> {
  const bar = firstBatch(
    await run({
      find: "daily_prices",
      filter: {
        instrumentId,
        source: { $in: EXCHANGE_SOURCES },
        close: { $gt: 0 },
        date,
      },
      sort: { date: direction },
      projection: { date: 1, close: 1 },
      limit: 1,
      singleBatch: true,
    }),
  )[0];
  const t = readDate(bar?.date);
  if (!bar || t === null || !Number.isFinite(t)) return null;
  return { date: new Date(t), close: Number(bar.close), volume: 0 };
}

/** Each DERIVED row's evidence, or null when no instrument trades it. */
async function evidenceFor(
  run: Run,
  rows: readonly RawDoc[],
): Promise<Map<string, Evidence | null>> {
  const instruments = firstBatch(
    await run({
      find: "instrument_mappings",
      filter: { symbol: { $in: [...new Set(rows.map((r) => r.symbol))] } },
      projection: { symbol: 1, exchange: 1 },
      limit: 50_000,
      batchSize: 50_000,
      singleBatch: true,
    }),
  );
  const byKey = new Map(
    instruments.map((i) => [
      `${String(i.symbol)}:${String(i.exchange)}`,
      i._id,
    ]),
  );
  const out = new Map<string, Evidence | null>();
  for (const row of rows) {
    const instrumentId = byKey.get(
      `${String(row.symbol)}:${String(row.exchange)}`,
    );
    const day = sessionDay(row.exDate);
    if (instrumentId === undefined || day === null) {
      out.set(idOfDoc(row), null);
      continue;
    }
    const iso = (ms: number) => ({ $date: new Date(ms).toISOString() });
    out.set(idOfDoc(row), {
      onDay: await closeAt(
        run,
        instrumentId,
        { $gte: iso(day.start), $lt: iso(day.end) },
        1,
      ),
      before: await closeAt(run, instrumentId, { $lt: iso(day.start) }, -1),
    });
  }
  return out;
}

/** Read WHOLE and counted back, as the MONEY-1530 repairs do, then narrowed. */
async function derivedRows(run: Run): Promise<RawDoc[]> {
  return (await readWhole(run, COLLECTION)).filter(
    (d) => d.source === "DERIVED",
  );
}

function report(plan: RetirePlan): void {
  const tally = new Map<string, number>();
  for (const j of plan.judged)
    tally.set(j.verdict, (tally.get(j.verdict) ?? 0) + 1);
  log(
    `DERIVED rows judged: ${n(plan.judged.length)} — ` +
      [...tally].map(([k, v]) => `${k} ${n(v)}`).join(" · "),
  );
  const fmtRow = (j: RetirePlan["judged"][number]): string =>
    `${j.key} ratio=${j.ratio} observed=${j.observedRatio?.toFixed(4) ?? "-"} ` +
    `gap=${j.gapDays === null ? "none before it" : `${Math.round(j.gapDays)}d`}`;
  log(`RETIRE (backed up, then deleted): ${n(plan.deletes.length)}`);
  for (const j of plan.judged.filter(
    (x) => x.verdict === "REFUTED" || x.verdict === "GAP",
  )) {
    log(`   ${j.verdict.padEnd(8)} ${fmtRow(j)}`);
  }
  const unknown = plan.judged.filter((x) =>
    ["NO_BAR_BEFORE", "NO_BAR_ON_DAY", "NO_LISTING", "NO_RATIO"].includes(
      x.verdict,
    ),
  );
  log(`left alone, UNKNOWN (no series speaks to them): ${n(unknown.length)}`);
  for (const j of unknown) log(`   ${j.verdict.padEnd(13)} ${fmtRow(j)}`);
}

async function retire(run: Run, target: string): Promise<void> {
  const rows = await derivedRows(run);
  const evidence = await evidenceFor(run, rows);
  const plan = planRetire(rows, evidence);
  report(plan);

  const again = planRetire(simulateRetire(rows, plan), evidence);
  if (again.deletes.length > 0) {
    throw new Error(
      `a second run would still retire ${again.deletes.length} rows — refusing a plan that does not converge.`,
    );
  }
  log("idempotency: re-planning the simulated result finds nothing to do");

  if (plan.deletes.length === 0) {
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
    `back up and delete ${n(plan.deletes.length)} DERIVED rows of ${COLLECTION}`,
  );
  const held = await backupVerified(run, BACKUP_COLLECTION, plan.backup);
  log(`   backup: ${n(held)} documents in ${BACKUP_COLLECTION}, verified`);
  await deleteOps(run, COLLECTION, plan.deletes, "retire DERIVED rows");
  log(`   retired: ${n(plan.deletes.length)}`);

  const remaining = await derivedRows(run);
  const after = planRetire(remaining, await evidenceFor(run, remaining));
  if (after.deletes.length > 0) {
    throw new Error(
      `${after.deletes.length} rows still retire after the write.`,
    );
  }
  log("verified: re-judging the collection retires nothing.");
}

async function restore(run: Run, target: string): Promise<void> {
  const backup = (await readAll(
    run,
    BACKUP_COLLECTION,
  )) as unknown as RetireBackupDoc[];
  const present = await presentIds(
    run,
    COLLECTION,
    backup.map((b) => idOf(b.doc)),
  );
  const plan = planRetireRestore(backup, present);
  log(
    `backup holds ${n(backup.length)}: re-insert ${n(plan.insert.length)}, ` +
      `already present (left as they are) ${n(plan.present.length)}`,
  );
  if (plan.insert.length === 0) {
    log("nothing to do.");
    return;
  }
  if (!ARGS.has("apply")) {
    log(
      "DRY RUN — nothing written. Re-run with --restore --apply (--yes non-interactively).",
    );
    return;
  }
  await consent(
    ARGS,
    target,
    `re-insert ${n(plan.insert.length)} rows into ${COLLECTION}`,
  );
  for (let i = 0; i < plan.insert.length; i += CHUNK) {
    const slice = plan.insert.slice(i, i + CHUNK);
    const res = await run({
      insert: COLLECTION,
      documents: slice,
      ordered: true,
    });
    // A duplicate-key error here means the detector re-created the event under
    // a new _id since; that row is the current one and this one stays backed up.
    assertWrite(res, slice.length, "restore (re-insert)");
  }
  log(`restored ${n(plan.insert.length)}. ${BACKUP_COLLECTION} is kept.`);
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
    `${ARGS.has("restore") ? "RESTORE" : "RETIRE"} — ${ARGS.has("apply") ? "APPLY" : "DRY RUN"} — ${target}`,
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
    else await retire(run, target);
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
