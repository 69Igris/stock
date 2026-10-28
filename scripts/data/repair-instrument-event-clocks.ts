/**
 * Repair `instrument_events` clocks — MONEY-1531, with MONEY-1521's un-stamp.
 *
 * ## What it repairs
 *
 * `publishEvents` rewrote `observedAt` on every upsert until MONEY-1531 made it
 * create-only, and the news poll re-emits every article its overlap re-reads.
 * Measured on prod 2026-09-23: 11,871 of 11,976 events (99.1%, all
 * TIINGO_NEWS) carry an `observedAt` AFTER their own `ingestedAt`, median
 * 4.8 h, max 10.9 h. `observedAt` is the only clock a point-in-time read may
 * use, so every one of those headlines is dated hours late.
 *
 * ## The rule
 *
 *   observedAt := min(observedAt, ingestedAt)      where it moved
 *   $unset expiresAt                               wherever it is set
 *
 * `ingestedAt` is `@default(now())`, written once by the create, which is the
 * first emission. It trails the true first sighting by at most the poll's own
 * write loop — 72 s, measured as the lead of the 105 rows no re-emission moved
 * — so a repaired clock is never early. The decision is `planClockRepair` in
 * `packages/lake/src/events-logic.ts`, tested there.
 *
 * `expiresAt` is cleared because every value in the collection was stamped
 * `(moved) observedAt + 30d` by a writer with no knowledge of the lake. Under
 * MONEY-1521 only `event-lake-sink` stamps it, after silver holds the row at
 * its CURRENT key — and it re-reads every unstamped row on every run, so the
 * 5,323 rows already in silver are re-stamped on its next run (at their
 * repaired key, which `--reload` is what puts in silver).
 *
 * ## Order — this is step 2 of 3
 *
 *   1. deploy the workers carrying MONEY-1531 (create-only `observedAt`, no
 *      `expiresAt` write). Before that, the old writer re-moves every row the
 *      news overlap re-reads within minutes of this repair. Running early is
 *      not harmful — the repair is idempotent and the lake sink REFUSES a moved
 *      clock by name — it is just undone and has to be run again.
 *   2. this, `--apply` (`--apply --yes` from a non-interactive shell).
 *   3. `event-lake-sink --env <env> --reload --apply`, which rewrites silver
 *      from the repaired serving copy and stamps what it wrote.
 *
 * ## Safety
 *
 *   - DRY RUN BY DEFAULT. `--apply` is required to write anything.
 *   - `--apply` ASKS: a prompt for "yes" with the masked target host, refused
 *     outright on a non-TTY stdin. `--apply --yes` is the non-interactive
 *     consent, for an operator or agent that has read the dry run; `--yes`
 *     without `--apply` is refused. The convention of `dedupe-candles.ts` and
 *     `reanchor-corporate-action-dates.ts`; the grammar is
 *     `parseClockRepairArgs` in `packages/lake/src/events-logic.ts`, tested
 *     there.
 *   - `--env` is REQUIRED and PINS the target: `pinJobEnv` resolves the URI
 *     from Secret Manager for that environment and the client is built from it
 *     explicitly. `@usemoney/database` is never imported — its singleton
 *     captures the ambient `DATABASE_URL` at import, and the repo's `.env` is
 *     QA (MONEY-1514). Unlike those siblings there is no
 *     `DATABASE_URL=... --apply` form: an unpinned target is not offered.
 *   - Every write is compare-and-set on the `observedAt` it read, and RAW, so
 *     `updatedAt` does not move. A second run plans nothing.
 *   - REVERSIBLE. Before the first write, every row it will modify is copied —
 *     `_id`, `eventId`, the original `observedAt` and `expiresAt`, and what it
 *     writes over them — into `instrument_events_money1531_backup`, keyed on
 *     the row's own `_id` with `$setOnInsert` (a re-run keeps the FIRST
 *     original), and the copies are COUNTED BACK; a short count writes nothing.
 *     The machinery is the `corporate_actions` repairs'
 *     (`corporate-action-repair-io.ts`).
 *   - `--restore` is FIELD-LEVEL, like `repair-corporate-action-dividends.ts`:
 *     it puts back only the fields the repair wrote, and each only while the
 *     row still holds the value written — so a clock re-dated since, or an
 *     `expiresAt` `event-lake-sink` has stamped since, is left alone and
 *     listed. Dry run by default; `--restore --apply --yes` writes.
 *   - EXITS NON-ZERO when a planned write matched nothing or the re-census
 *     after the write still finds rows to repair: both mean the
 *     pre-MONEY-1531 workers are still deployed and re-moving clocks, and a 0
 *     would let step 3 load a serving copy that is still being re-dated.
 *
 * ## Usage
 *
 *   export CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook      # pinJobEnv shells out to gcloud
 *   npx tsx scripts/data/repair-instrument-event-clocks.ts --env prod                # dry run
 *   npx tsx scripts/data/repair-instrument-event-clocks.ts --env prod --apply        # prompts
 *   npx tsx scripts/data/repair-instrument-event-clocks.ts --env prod --apply --yes  # non-interactive
 *   npx tsx scripts/data/repair-instrument-event-clocks.ts --env prod --restore                # dry run
 *   npx tsx scripts/data/repair-instrument-event-clocks.ts --env prod --restore --apply --yes  # WRITES
 */

import { PrismaClient, type Prisma } from "@prisma/client";
import { pinJobEnv } from "@usemoney/core/ops/gcp-secrets";
import {
  CLOCK_REPAIR_BACKUP_COLLECTION,
  INSTRUMENT_EVENTS_COLLECTION,
  clockRepairBackup,
  clockRepairCommand,
  clockRepairVerdict,
  parseClockRepairArgs,
  planClockRepair,
  planClockRestore,
  type ClockBackupDoc,
  type EventClockRepair,
} from "@usemoney/lake/events-logic";
import {
  backupVerified,
  readAll,
  updateOps,
  type RawDoc,
  type Run,
} from "./corporate-action-repair-io";

const PAGE = 5_000;
/** Statements per `update` command. Far inside Mongo's 100,000 and 16 MB. */
const WRITE_CHUNK = 1_000;

/** Host of a Mongo URI, for display. Never prints a credential. */
function maskedHost(uri: string): string {
  const authority = uri.replace(/^[a-z+]+:\/\//i, "").split("/")[0] ?? "";
  return authority.slice(authority.lastIndexOf("@") + 1).trim();
}

async function confirmWrite(
  host: string,
  env: string,
  change: string,
): Promise<void> {
  process.stdout.write(
    `\n!!  This will WRITE to a database.\n` +
      `      target : ${host}\n` +
      `      env    : ${env}\n` +
      `   ${change}\n` +
      `   Type 'yes' to continue: `,
  );
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(String(d).trim()));
  });
  // `once("data")` left stdin FLOWING, which holds the event loop open: the
  // write would finish and the process would never exit.
  process.stdin.pause();
  // Non-zero on abort: an abort is not success.
  if (answer !== "yes") throw new Error("Aborted.");
}

interface Census {
  scanned: number;
  repairs: EventClockRepair[];
  moved: number;
  unset: number;
  /** Hours each moved clock sat after its own creation, per source. */
  driftBySource: Map<string, number[]>;
}

async function census(prisma: PrismaClient): Promise<Census> {
  const out: Census = {
    scanned: 0,
    repairs: [],
    moved: 0,
    unset: 0,
    driftBySource: new Map(),
  };
  let cursor: string | undefined;
  for (;;) {
    // CURSOR-PAGED on `id` ASC, never skip/take: a `skip` shifts under a
    // concurrent insert, so a row can be handed out twice or never.
    const page = await prisma.instrumentEvent.findMany({
      select: {
        id: true,
        eventId: true,
        source: true,
        observedAt: true,
        ingestedAt: true,
        expiresAt: true,
      },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    out.scanned += page.length;
    cursor = page[page.length - 1]!.id;
    for (const row of page) {
      const repair = planClockRepair(row);
      if (!repair) continue;
      out.repairs.push(repair);
      if (repair.unsetExpiresAt) out.unset++;
      if (repair.observedAt) {
        out.moved++;
        const drift = out.driftBySource.get(row.source) ?? [];
        drift.push(
          (row.observedAt.getTime() - row.ingestedAt.getTime()) / 3_600_000,
        );
        out.driftBySource.set(row.source, drift);
      }
    }
    if (page.length < PAGE) break;
  }
  return out;
}

function report(c: Census): void {
  console.log(
    `  scanned ${c.scanned} row(s); ${c.repairs.length} need repair — ` +
      `${c.moved} observedAt moved past ingestedAt, ${c.unset} expiresAt to unset`,
  );
  for (const [source, drift] of c.driftBySource) {
    drift.sort((a, b) => a - b);
    const at = (p: number) =>
      drift[Math.min(drift.length - 1, Math.floor(p * drift.length))]!;
    console.log(
      `    ${source}: ${drift.length} moved, drift p50 ${at(0.5).toFixed(2)}h ` +
        `p90 ${at(0.9).toFixed(2)}h max ${drift[drift.length - 1]!.toFixed(2)}h`,
    );
  }
}

/**
 * `--restore`: the backup's fields back onto every row still holding the value
 * the repair wrote (`planClockRestore`). Compare-and-set, so a row that moves
 * between this read and the write fails the run by name rather than being
 * overwritten.
 */
async function restore(
  prisma: PrismaClient,
  run: Run,
  host: string,
  env: string,
  apply: boolean,
  yes: boolean,
): Promise<void> {
  const backup = (await readAll(
    run,
    CLOCK_REPAIR_BACKUP_COLLECTION,
  )) as unknown as ClockBackupDoc[];
  const ids = backup.map((b) => b._id.$oid);
  const current = new Map<
    string,
    { observedAt: Date; expiresAt: Date | null }
  >();
  for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
    for (const row of await prisma.instrumentEvent.findMany({
      where: { id: { in: ids.slice(i, i + WRITE_CHUNK) } },
      select: { id: true, observedAt: true, expiresAt: true },
    })) {
      current.set(row.id, row);
    }
  }
  const plan = planClockRestore(backup, current);
  console.log(
    `  backup holds ${backup.length}: restore ${plan.ops.length} ` +
      `(${plan.partial.length} of them one field only), changed since the ` +
      `repair (left as they are) ${plan.changedSince.length}, no longer in ` +
      `${INSTRUMENT_EVENTS_COLLECTION} ${plan.gone.length}`,
  );
  for (const id of plan.changedSince.slice(0, 10)) {
    console.log(`    changed since: ${id}`);
  }
  if (!apply) {
    console.log(
      "\n  DRY RUN — nothing written. Re-run with --restore --apply (--yes non-interactively).\n",
    );
    return;
  }
  if (plan.ops.length === 0) {
    console.log("\n  nothing to restore.\n");
    return;
  }
  if (!host) {
    throw new Error("could not determine the target host — refusing to write");
  }
  const change = `It restores ${plan.ops.length} instrument_events row(s) from ${CLOCK_REPAIR_BACKUP_COLLECTION}.`;
  if (!yes) await confirmWrite(host, env, change);
  await updateOps(
    run,
    INSTRUMENT_EVENTS_COLLECTION,
    plan.ops,
    "restore clocks",
  );
  console.log(
    `\n  restored ${plan.ops.length}. ${CLOCK_REPAIR_BACKUP_COLLECTION} is kept.\n`,
  );
}

async function repair(
  prisma: PrismaClient,
  run: Run,
  host: string,
  env: string,
  apply: boolean,
  yes: boolean,
): Promise<void> {
  const before = await census(prisma);
  report(before);
  console.log(
    `  backup: ${before.repairs.length} row(s) -> ${CLOCK_REPAIR_BACKUP_COLLECTION} before any write`,
  );
  if (!apply) {
    console.log(
      "\n  DRY RUN — nothing written. Re-run with --apply (--yes non-interactively).\n",
    );
    return;
  }
  if (before.repairs.length === 0) {
    console.log("\n  nothing to repair.\n");
    return;
  }
  // On BOTH paths: the target must be identifiable before a write, whether a
  // human reads it in the prompt or an agent reads it in the log line above.
  if (!host) {
    throw new Error("could not determine the target host — refusing to write");
  }
  // `--apply --yes` is consent already given; a bare `--apply` asks.
  const change = `It repairs ${before.repairs.length} instrument_events row(s): observedAt := min(observedAt, ingestedAt), $unset expiresAt.`;
  if (!yes) await confirmWrite(host, env, change);

  // BEFORE the first write, and counted back: a short count throws here, with
  // nothing modified.
  const held = await backupVerified(
    run,
    CLOCK_REPAIR_BACKUP_COLLECTION,
    before.repairs.map(clockRepairBackup),
  );
  console.log(
    `  backup: ${held} row(s) in ${CLOCK_REPAIR_BACKUP_COLLECTION}, verified`,
  );

  let matched = 0;
  let modified = 0;
  for (let i = 0; i < before.repairs.length; i += WRITE_CHUNK) {
    const res = (await prisma.$runCommandRaw(
      clockRepairCommand(
        before.repairs.slice(i, i + WRITE_CHUNK),
      ) as unknown as Prisma.InputJsonObject,
    )) as { n?: number; nModified?: number; writeErrors?: unknown[] };
    // A raw write answers `ok: 1` with its failures in an array.
    if (res.writeErrors?.length) {
      throw new Error(
        `${res.writeErrors.length} write error(s), first ` +
          JSON.stringify(res.writeErrors[0]),
      );
    }
    matched += Number(res.n ?? 0);
    modified += Number(res.nModified ?? 0);
  }
  console.log(
    `\n  wrote: matched ${matched}, modified ${modified} of ${before.repairs.length} planned`,
  );

  // Re-read from scratch rather than trusting the write counts.
  const after = await census(prisma);
  console.log("  after:");
  report(after);
  const failure = clockRepairVerdict({
    planned: before.repairs.length,
    matched,
    remaining: after.repairs.length,
  });
  if (failure) throw new Error(failure);
}

async function main(): Promise<void> {
  const {
    env,
    apply,
    yes,
    restore: restoring,
  } = parseClockRepairArgs(process.argv.slice(2), Boolean(process.stdin.isTTY));
  // FIRST, before any client exists — MONEY-1514.
  const { databaseUrl } = pinJobEnv(env);
  const host = maskedHost(databaseUrl);
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const run: Run = async (command) =>
    (await prisma.$runCommandRaw(
      command as Prisma.InputJsonObject,
    )) as unknown as RawDoc;
  try {
    console.log(
      `\n  instrument_events clock ${restoring ? "RESTORE" : "repair"} — ${apply ? "APPLY" : "DRY RUN"} — env=${env} host=${host}`,
    );
    if (restoring) await restore(prisma, run, host, env, apply, yes);
    else await repair(prisma, run, host, env, apply, yes);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
