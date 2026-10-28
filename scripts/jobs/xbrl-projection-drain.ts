/**
 * XBRL -> `StockFinancials` BACKLOG DRAIN — MONEY-1235.
 *
 * Pages `processXbrlProjectionWrite` until the unprojected backlog is gone. It
 * is the same write path the nightly `xbrl-projection` push worker uses — a
 * different WINDOW, deliberately, for exactly the reason `xbrl-backfill.ts`
 * gives: a drain that reimplements the write is a drain that drifts from the
 * nightly one, and then the two disagree about history in ways nobody notices
 * until a chart looks wrong.
 *
 * ## Why it has to exist
 *
 * Measured on prod, 2026-08-19:
 *
 *     xbrl_filings      90,188 unprojected   (71,450 QUARTERLY,
 *                                             18,381 ANNUAL, 357 HALF_YEARLY)
 *     stock_financials       0 QUARTERLY rows
 *
 * Zero quarterly rows means EVERY quarterly write is a CREATE. Until MONEY-1235
 * those creates were unconditionally suppressed and the opt-in was unreachable,
 * so the Quarterly tab could not fill however long the job ran. That half is
 * fixed. This is the other half: the nightly job cannot drain what is left.
 *
 *   - its default limit is 500 (`DEFAULT_PROJECTION_LIMIT`), sized for Pub/Sub's
 *     un-raisable 600 s ack deadline, and
 *   - its scheduler payload is scoped `{"periodTypes":["ANNUAL"]}` on purpose,
 *     so unstamped quarterly filings cannot starve annual work.
 *
 * 71,450 quarterly filings at 500 a night is ~143 nights. No Cloud Run job ran
 * the projection at all before this one: `xbrl-backfill.ts` calls only
 * `processXbrlSync` and contains zero `stockFinancials` references. This is the
 * missing runner.
 *
 * ## THE ACK DEADLINE DOES NOT APPLY HERE — do not re-impose it
 *
 * Every batch size in this repo is set by Pub/Sub's 600 s push ack deadline
 * (see the "Job throughput" table in CLAUDE.md), and a handler that runs past it
 * gets its message REDELIVERED, so a second copy starts concurrently. That is
 * why the nightly projection caps at 500.
 *
 * This is a Cloud Run JOB. There is no subscription, no message, no ack. Its
 * sibling runs with `--task-timeout=86400` and this one does too. The binding
 * constraints here are memory (the writer holds a whole page of `facts` JSON)
 * and the run's own wall-clock budget, both of which are explicit. Anyone
 * reaching for a 600 s budget out of habit is importing a constraint that is not
 * present.
 *
 * ## Arming: the environment writes, the flag can only narrow
 *
 * A write needs BOTH `XBRL_PROJECTION_APPLY=true` in the environment AND
 * `--apply` on the command line. The flag cannot arm a run the environment has
 * not armed — `StockFinancials` has no `source` in its unique key, so the first
 * XBRL write to a period destroys the incumbent value with nothing left to
 * reconcile against, and a one-way door must not be openable by an argument.
 * Flipping the env var is a deploy, which is a review.
 *
 * The comparison is against the literal string `"true"`, never `Boolean()`:
 * `Boolean("false")` is `true`, which would arm the job in the one configuration
 * meant to keep it off — and `"false"` is exactly what the job spec ships.
 *
 * ## Termination, which is the part that had to be provably correct
 *
 * The cursor is `XbrlFiling.projectedAt`, stamped by the writer on filings it
 * DECIDED about. A page therefore advances only because the previous page
 * stamped. The writer deliberately stamps neither a dry run (nothing at all) nor
 * `notDecidedIds` (create-suppressed, no-instrument) nor failures — so a page
 * can read thousands of filings and move the cursor zero, and a naive
 * `while (filingsRead > 0)` loop spins on that until the 24 h timeout with
 * nothing written and no error.
 *
 * `runDrainLoop` stops on an empty page AND on a non-advancing one, measured by
 * counting the scoped unprojected population before and after each batch. Both
 * conditions, plus the batch cap and the wall-clock budget, are proven in
 * `workers/__tests__/processors/xbrl-projection-drain-logic.test.ts`.
 *
 * ## Idempotence — no checkpoint table, on purpose
 *
 * Re-running is free. `planFinancialsWrite` returns SKIP when the row already
 * carries our stamp, our numbers and our filing's provenance, and a stamped
 * filing is not selected again at all. The MONEY-1189 postmortem is a catalogue
 * of checkpoints recording DONE for work that never happened; here the database
 * rows ARE the checkpoint, at exactly the granularity that matters.
 *
 * Usage (dry run is the default — nothing writes without --apply AND the env):
 *   npx tsx scripts/jobs/xbrl-projection-drain.ts
 *   npx tsx scripts/jobs/xbrl-projection-drain.ts --period-types=QUARTERLY
 *   npx tsx scripts/jobs/xbrl-projection-drain.ts --apply --create-missing \
 *       --symbols=RELIANCE,TCS --limit=200
 *
 * As a Cloud Run job (`scripts/ops/setup-xbrl-projection-drain-job.sh`):
 *   gcloud run jobs execute xbrl-projection-drain-prod --region=asia-south1 \
 *       --args="--apply,--create-missing,--period-types=QUARTERLY"
 *
 * NOTE `--args` splits on COMMAS, so each comma starts a NEW argument. A stray
 * comma inside a flag is a routine mistake, which is why an unrecognised
 * argument is fatal here rather than ignored.
 */

import prisma, { Prisma } from "@usemoney/database";
import {
  processXbrlProjectionWrite,
  describeNoWriteReason,
  UNPROJECTED_FILING_WHERE,
} from "../../workers/src/processors/xbrl-projection-writer";
// The REAL arming rule, imported so the drift guard below can compare it
// against this job's own copy. See `isDrainArmed` in the logic module for why a
// pure restatement plus two guards beats importing a Prisma-laden module into a
// pure-logic test.
import { isProjectionArmed } from "../../workers/src/processors/xbrl-projection";
// MONEY-1205 T5 — Cloud Run JOBS pin their image at provision time and a deploy
// of the SERVICE does not move them, so this job can run weeks-old code, exit 0
// and report success while skipping work it has never heard of. The only place
// that drift is observable is this line.
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import {
  parseDrainArgs,
  resolveDrainApply,
  isDrainArmed,
  runDrainLoop,
  describeDrainOutcome,
  describeDrainStop,
  drainExitCode,
  type DrainArgs,
} from "./xbrl-projection-drain-logic.mjs";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const log = {
  info: (...a: unknown[]) => console.log("[xbrl-projection-drain]", ...a),
  warn: (...a: unknown[]) => console.warn("[xbrl-projection-drain]", ...a),
};

/**
 * Unprojected filings in THIS RUN'S SCOPE — the loop's progress marker.
 *
 * Built from the SAME three inputs the writer's own `findMany` uses:
 * `UNPROJECTED_FILING_WHERE` (imported, never hand-copied — MONEY-1234 shipped
 * a second hand-written `{ projectedAt: null }` that matched nothing on Mongo
 * and printed a permanent all-clear over the whole backlog), plus this run's
 * `symbols` and `periodTypes`.
 *
 * SCOPED rather than global on purpose. `countUnprojectedFilings()` in the
 * processor counts the whole table, which would still work as a bare
 * advance-detector — a stamp is a stamp — but the number it produces is not
 * "what is left to do" for a `--symbols` run, and printing it as one is the
 * wrong-granularity completeness report MONEY-1189 catalogued five times.
 *
 * `UNPROJECTED_FILING_WHERE` is `{ OR: [...] }`; spreading it beside `symbol` /
 * `periodType` ANDs them, which is the intended composition.
 */
async function countRemaining(args: DrainArgs): Promise<number> {
  const where: Prisma.XbrlFilingWhereInput = {
    ...UNPROJECTED_FILING_WHERE,
    ...(args.symbols && args.symbols.length > 0
      ? { symbol: { in: args.symbols } }
      : {}),
    ...(args.periodTypes && args.periodTypes.length > 0
      ? { periodType: { in: args.periodTypes } }
      : {}),
  };
  return prisma.xbrlFiling.count({ where });
}

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Without this the job logs to
  // stdout only: `initLogger()` had exactly one caller in the whole repo.
  await initJobTelemetry();
  reportBuildProvenance(log, "xbrl-projection-drain");

  const { args, errors } = parseDrainArgs(process.argv.slice(2));
  if (errors.length > 0) {
    for (const e of errors) log.warn(`ARGUMENT ERROR: ${e}`);
    log.warn(
      "Refusing to run. Flags: --apply --dry-run --create-missing " +
        "--period-types=ANNUAL,QUARTERLY --limit=N --symbols=A,B " +
        "--max-batches=N --budget-sec=N",
    );
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  // Drift guard, one comparison, no cost. `isDrainArmed` is a restatement of
  // `isProjectionArmed` that exists so the loop's logic module stays importable
  // without Prisma. If the two ever disagree about the LIVE environment, the
  // restatement has rotted and every arming decision below is untrustworthy —
  // so crash on line one rather than run a job whose write switch is a guess.
  if (isDrainArmed(process.env) !== isProjectionArmed(process.env)) {
    throw new Error(
      "isDrainArmed and isProjectionArmed disagree about " +
        "XBRL_PROJECTION_APPLY. One of them has drifted; they must encode the " +
        'same literal `=== "true"` rule. Refusing to run.',
    );
  }

  const apply = resolveDrainApply(args, process.env);
  const armed = isDrainArmed(process.env);

  log.info(
    `apply=${apply} (env XBRL_PROJECTION_APPLY=${
      process.env.XBRL_PROJECTION_APPLY ?? "<absent>"
    } -> armed=${armed}, --apply=${args.apply}, --dry-run=${args.dryRun}), ` +
      `createMissing=${args.createMissing}, limit=${args.limit}, ` +
      `periodTypes=${args.periodTypes?.join("+") ?? "ANNUAL+QUARTERLY"}, ` +
      `symbols=${args.symbols?.length ?? "all"}, ` +
      `maxBatches=${args.maxBatches}, budget=${args.budgetMs / 60_000}m`,
  );

  if (args.apply && !armed) {
    // Loud, because this is the exact state in which a run looks successful and
    // does nothing. It is NOT an error — narrowing is legal and the run still
    // produces a useful plan — but it must never be mistaken for a drain.
    log.warn(
      "--apply was given but the ENVIRONMENT is not armed " +
        '(XBRL_PROJECTION_APPLY must be the literal string "true"). A flag ' +
        "cannot arm a run: this is a DRY RUN. Arming is a deploy — set it in " +
        "the job spec via scripts/ops/setup-xbrl-projection-drain-job.sh.",
    );
  }
  if (apply && !args.createMissing) {
    // prod: 0 quarterly stock_financials rows against 71,450 quarterly filings.
    // Without --create-missing a quarterly drain writes zero AND stamps zero,
    // so it stalls on the first batch. Say so before spending the batch.
    log.warn(
      "--create-missing is OFF. Every period with no incumbent row is " +
        "suppressed AND left unstamped (it is a property of the RUN, not the " +
        "filing), so a QUARTERLY drain will stall on batch 1: prod holds ZERO " +
        "quarterly stock_financials rows, i.e. every quarterly write is a " +
        "CREATE. This is correct for an ANNUAL drain and wrong for a " +
        "quarterly one.",
    );
  }

  const outcome = await runDrainLoop(
    { apply, maxBatches: args.maxBatches, budgetMs: args.budgetMs },
    {
      runBatch: () =>
        processXbrlProjectionWrite({
          apply,
          limit: args.limit,
          symbols: args.symbols,
          periodTypes: args.periodTypes,
          createMissing: args.createMissing,
          // THE CURSOR. Without it every batch re-reads the same first `limit`
          // filings forever — MONEY-1211's constant-ordering defect, which the
          // writer's own option comment spells out.
          unprojectedOnly: true,
        }),
      countRemaining: () => countRemaining(args),
      now: () => Date.now(),
      onBatch: (i, result, progress) => {
        log.info(
          `batch ${i + 1}: read ${result.filingsRead}, periods ${result.periods}, ` +
            `created ${result.created}, updated ${result.updated}, ` +
            `displaced ${result.displaced}, failed ${result.failed}, ` +
            `remaining ${progress.remainingBefore} -> ${progress.remainingAfter}` +
            `${result.truncatedByLimit ? `, deferred ${result.deferredByPagination}` : ""}`,
        );
        if (result.filingsRead > 0 && result.created + result.updated === 0) {
          // Reused, never restated: `describeNoWriteReason` scans the result's
          // own `skipped*`/`refused*` keys, so a counter added to the writer
          // shows up here for free. Its predecessor was a hand-written list of
          // seven and missed three added in the same ticket — one of which
          // fires on 29.5% of winner periods.
          log.warn(`batch ${i + 1}: ${describeNoWriteReason(result)}`);
        }
      },
    },
  );

  // ── ONE structured summary, always — including the zero case ──
  log.info(`SUMMARY ${describeDrainOutcome(outcome)}`);
  log.info(
    `counters ${JSON.stringify(outcome.totals.counters)} ` +
      `refused ${JSON.stringify(outcome.totals.refused)} ` +
      `truncatedBatches ${outcome.totals.truncatedBatches} ` +
      `notOkBatches ${outcome.totals.notOkBatches}`,
  );
  if (outcome.totals.examples.length > 0) {
    log.info(`examples:\n  ${outcome.totals.examples.join("\n  ")}`);
  }

  const stopLine = describeDrainStop(outcome, args);
  const code = drainExitCode(outcome);
  if (code === 0) log.info(stopLine);
  else log.warn(stopLine);

  process.exitCode = code;
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[xbrl-projection-drain] FAILED", err);
  await prisma.$disconnect();
  process.exit(1);
});
