/**
 * Re-derive the missing NSE F&O summaries — MONEY-1189 (P4.4).
 *
 * ## What happened
 *
 * Between 2024-07-08 and 2026-05-13 — 456 contiguous trading days —
 * `derivative_summary` holds BSE rows and NOTHING from NSE. 2024-07-05 has 186
 * NSE rows, 2026-05-14 has 214, and every day in between has zero. The cause
 * was three checks at the wrong granularity, each of which independently
 * reported success:
 *
 *   1. `feed-parse` parsed all 456 archived NSE F&O files and checkpointed
 *      DONE. Correct — `derivative_eod` really was written.
 *   2. `fo-summary --backfill` selected targets as `eodDates − summaryDates`,
 *      at DAY granularity. Each day already had its BSE summaries, so the day
 *      looked done and the NSE half was never derived. Every re-run agreed.
 *   3. `pruneOldEod` gated on `summarised.has(day)` — also day granularity — so
 *      it deleted the raw NSE rows that step 2 had skipped.
 *
 * Step 3 is what turns a late job into a permanent hole: the input was deleted
 * on the strength of an assumption that the derivation had happened. Both
 * granularity bugs are fixed in `scripts/jobs/fo-summary.ts`; this script
 * recovers the data they lost.
 *
 * ## Why re-parsing is unavoidable
 *
 * Summaries derive from `derivative_eod`, which now spans only ~3 months. The
 * archived bytes are intact (`feeds/NSE/fo-bhavcopy/`, one file per trading day
 * for 2024/2025/2026), so the raw rows can be rebuilt — that is precisely what
 * archive-first exists for.
 *
 * ## Why it is chunked
 *
 * 456 days × ~40k contracts ≈ 18M `derivative_eod` rows. Materialising that at
 * once is pointless load on Atlas when the rows are transient by design. So the
 * repair walks the gap in monthly chunks, each a full parse → summarise →
 * prune cycle, leaving ~840k rows in flight at a time. A chunk that fails can
 * be re-run on its own.
 *
 * ## Why checkpoints must be purged per chunk
 *
 * `feed-parse` skips any (family, date) already marked DONE, and all 456 are.
 * Deleting a chunk's checkpoints is therefore both the way to make it re-parse
 * AND the chunking mechanism: with every other day still DONE, the parse pass
 * naturally processes only the chunk just purged. Checkpoints are re-written by
 * the parse itself, so an interrupted run resumes rather than restarts.
 *
 * Usage:
 *   node --import tsx scripts/data/repair-fo-summary-gap.ts            # dry-run
 *   node --import tsx scripts/data/repair-fo-summary-gap.ts --apply
 *   node --import tsx scripts/data/repair-fo-summary-gap.ts --apply --from=2024-07 --to=2024-12
 *
 * Prefer the ops wrapper, which resolves DATABASE_URL from Secret Manager:
 *   ./scripts/ops/run-market-data-job.sh fogap prod --apply
 */

import { spawnSync } from "node:child_process";

import { prisma } from "@usemoney/database";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const APPLY = argv.includes("--apply");
/** Both halves of the gap ship together; `--only` narrows for a re-run. */
const ONLY = arg("only");

const log = {
  info: (...a: unknown[]) => console.log("[fo-gap]", ...a),
  warn: (...a: unknown[]) => console.warn("[fo-gap]", ...a),
};

const PARSE_FAMILY = "parse:nse-fo-udiff-bhavcopy";

/** `YYYY-MM` → UTC midnight of the 1st. */
const monthStart = (ym: string): Date => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1));
};
const nextMonth = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
const ym = (d: Date): string => d.toISOString().slice(0, 7);

/**
 * The days that actually need repair, measured rather than assumed.
 *
 * A hardcoded range would go stale the moment a chunk succeeds, and re-running
 * the script would redo finished work. Asking the database which days carry
 * zero NSE summaries makes the script idempotent and self-terminating: once the
 * gap is closed it finds nothing and exits.
 */
async function missingNseDays(): Promise<Date[]> {
  const res = (await prisma.$runCommandRaw({
    aggregate: "derivative_summary",
    pipeline: [
      {
        $group: {
          _id: "$date",
          nse: { $sum: { $cond: [{ $eq: ["$exchange", "NSE"] }, 1, 0] } },
        },
      },
      { $match: { nse: 0 } },
      { $sort: { _id: 1 } },
    ],
    cursor: { batchSize: 50_000 },
    allowDiskUse: true,
  })) as { cursor: { firstBatch: Array<{ _id: { $date: string } | string }>; id?: number } };

  if (Number(res.cursor.id ?? 0) !== 0) {
    throw new Error("gap query did not fit one batch — refusing a partial view");
  }
  return res.cursor.firstBatch.map((r) => {
    const iso = typeof r._id === "string" ? r._id : r._id.$date;
    return new Date(iso);
  });
}

/** Run a repo script as a child process, streaming its output. */
function run(script: string, args: string[]): boolean {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", script, ...args],
    { stdio: "inherit", env: process.env },
  );
  return res.status === 0;
}

/* parse-pass-verdict:begin
 *
 * What one `feed-parse` pass over this chunk means — MONEY-1206 (D1).
 *
 * ## The exit code stopped meaning what this driver assumed
 *
 * Before MONEY-1205, a non-zero exit from `feed-parse` meant "nothing worked",
 * so aborting on it was right. MONEY-1205 gave the run a second, entirely
 * healthy reason to exit non-zero: it parsed everything it could AND refused
 * some files it cannot read, recording each as an `UNREADABLE` checkpoint.
 *
 * That turned the old `if (!run(...)) break;` into a permanent stop. This driver
 * PURGES the window's checkpoints before every attempt — including any
 * `UNREADABLE` rows — so the refusal is re-created on every invocation, the exit
 * is non-zero every time, and the chunk can never get past pass 1. Not
 * intermittently: on EVERY invocation, forever.
 *
 * ## The predicate
 *
 * The driver already refuses to trust a retry count and measures the only thing
 * that matters — whether checkpoints for this window are still being ADDED (see
 * the comment on the parse loop). The exit code joins that same rule:
 *
 *     abort  ⇔  exitedClean === false  AND  after <= before
 *
 * A non-zero exit WITH progress is a run that did useful work and refused some
 * files; the refusals are recorded, visible, and re-checked by step 4's
 * `stillMissing` verification before anything is pruned. A non-zero exit with NO
 * progress is a genuine hard failure — bad credentials, DB down, a crash on
 * startup — and still stops the driver with the cause on screen, which is what
 * the failure branch was for.
 *
 * `after >= target` still terminates the loop, because the driver's own
 * `feedBackfillProgress.count()` filters on family + date ONLY: an `UNREADABLE`
 * row counts toward `after` exactly as a `DONE` row does, and `target` was
 * measured pre-purge over the same status-blind filter. So a window whose files
 * are permanently unreadable still reaches its target and moves on, instead of
 * spinning to the 8-attempt cap.
 *
 * Pure and marker-delimited so the regression suite executes THIS text rather
 * than asserting about it.
 */
export type ParsePassAction =
  /** Hard failure with nothing to show for it — stop the whole driver. */
  | "abort"
  /** Every archived file in the window now carries a checkpoint. */
  | "complete"
  /** The pass added nothing and the window is still short — stop this chunk. */
  | "stalled"
  /** Progress was made and there is more to do. */
  | "continue";

export interface ParsePassInput {
  /** Did the child process exit 0? */
  exitedClean: boolean;
  /** Checkpoints in this window before the pass (0 immediately after the purge). */
  before: number;
  /** Checkpoints in this window after the pass. */
  after: number;
  /** Pre-purge checkpoint count — the restore target. */
  target: number;
}

export interface ParsePassVerdict {
  action: ParsePassAction;
  /** Progress-aware line for the operator; never null, the pass is always logged. */
  message: string;
}

export function judgeParsePass(p: ParsePassInput): ParsePassVerdict {
  const progressed = p.after > p.before;
  const at = `${p.after}/${p.target} checkpoint(s)`;

  if (!p.exitedClean && !progressed) {
    return {
      action: "abort",
      message:
        `parse FAILED and added NOTHING (${at}) — stopping so the cause is ` +
        "visible. A non-zero exit with no progress is a hard failure (bad " +
        "credentials, DB down, a crash on startup), not a refused file.",
    };
  }

  const note = p.exitedClean
    ? ""
    : ` — exit was non-zero, which since MONEY-1205 also means "some files ` +
      `were refused and recorded UNREADABLE". Progress was made, so this is ` +
      `not a reason to stop; the refusals are on the checkpoint rows and step ` +
      `4 re-verifies the month before anything is pruned.`;

  if (p.after >= p.target) {
    return { action: "complete", message: `parse reached ${at}${note}` };
  }
  if (!progressed) {
    return { action: "stalled", message: `parse stalled at ${at}${note}` };
  }
  return { action: "continue", message: `parse advanced to ${at}${note}` };
}
/* parse-pass-verdict:end */

async function main(): Promise<void> {
  const missing = await missingNseDays();
  if (missing.length === 0) {
    log.info("no days with zero NSE summaries — nothing to repair");
    return;
  }

  // Group into calendar months; each month is one parse→summarise→prune cycle.
  const byMonth = new Map<string, Date[]>();
  for (const d of missing) {
    const k = ym(d);
    byMonth.set(k, [...(byMonth.get(k) ?? []), d]);
  }

  let months = [...byMonth.keys()].sort();
  const from = arg("from");
  const to = arg("to");
  if (from) months = months.filter((m) => m >= from);
  if (to) months = months.filter((m) => m <= to);
  if (ONLY) months = months.filter((m) => m === ONLY);

  log.info(
    `${missing.length} day(s) with zero NSE summaries, ` +
      `${missing[0]!.toISOString().slice(0, 10)} → ` +
      `${missing[missing.length - 1]!.toISOString().slice(0, 10)}; ` +
      `repairing ${months.length} month chunk(s) — mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );

  if (!APPLY) {
    for (const m of months.slice(0, 6)) {
      log.info(`  ${m}: ${byMonth.get(m)!.length} day(s)`);
    }
    if (months.length > 6) log.info(`  … and ${months.length - 6} more`);
    log.info("dry-run: pass --apply to repair.");
    return;
  }

  let repaired = 0;
  for (const [i, m] of months.entries()) {
    const days = byMonth.get(m)!;
    const gte = monthStart(m);
    const lt = nextMonth(gte);
    log.info(`── chunk ${i + 1}/${months.length}: ${m} (${days.length} day(s))`);

    // 1. Purge this chunk's parse checkpoints. Everything outside stays DONE,
    //    which is what confines the parse pass to this month.
    //
    //    The pre-purge count is the RESTORE TARGET for step 2. It is not
    //    `days.length`: that counts the days missing NSE summaries, while the
    //    checkpoints cover every archived file in the month — including days
    //    that summarised fine. Comparing against the smaller number satisfies
    //    the loop on the first pass and re-introduces the very partial-parse
    //    it exists to catch.
    const target = await prisma.feedBackfillProgress.count({
      where: { family: PARSE_FAMILY, date: { gte, lt } },
    });
    const purged = await prisma.feedBackfillProgress.deleteMany({
      where: { family: PARSE_FAMILY, date: { gte, lt } },
    });
    log.info(`   purged ${purged.count} parse checkpoint(s) (restore target ${target})`);

    // 2. Re-parse the archived files for the chunk into derivative_eod.
    //
    // Looped, because ONE invocation does not reliably drain the pending set:
    // on 2024-08 it exited 0 after 11 of 21 files, with no error line and no
    // end-of-family summary, leaving 10 files un-checkpointed and their days
    // without EOD rows. Rather than assume a cause, the driver measures the
    // only thing that matters — whether checkpoints for this window are still
    // being added — and re-invokes while they are. Progress-based rather than
    // a fixed retry count, so it neither gives up early on a slow month nor
    // spins on a genuinely unparseable file.
    //
    // The EXIT CODE is now read by the same rule; see `judgeParsePass`.
    let parsedOk = true;
    // Baseline 0, not the old -1 sentinel. The purge above emptied this window,
    // so zero is the true "before" and any row is progress. -1 existed only to
    // keep the stall test quiet on pass 1, and reusing it here would make a
    // pass-1 hard failure that wrote NOTHING (after = 0 > -1) read as progress —
    // the one reading this predicate must never give.
    let seen = 0;
    for (let attempt = 1; attempt <= 8; attempt++) {
      const exitedClean = run("scripts/jobs/feed-parse.ts", [
        "--families=nse-fo-udiff-bhavcopy",
      ]);
      const now = await prisma.feedBackfillProgress.count({
        where: { family: PARSE_FAMILY, date: { gte, lt } },
      });
      const verdict = judgeParsePass({
        exitedClean,
        before: seen,
        after: now,
        target,
      });
      const line = `   pass ${attempt} in ${m}: ${verdict.message}`;
      if (verdict.action === "continue" || verdict.action === "complete") {
        log.info(line);
      } else {
        log.warn(line);
      }
      if (verdict.action === "abort") {
        parsedOk = false;
        break;
      }
      seen = now;
      if (verdict.action !== "continue") break;
    }
    if (!parsedOk) break;

    // 3. Summarise. --no-prune here because step 4 prunes deliberately after
    //    verifying; letting the summariser prune would interleave the two.
    if (!run("scripts/jobs/fo-summary.ts", ["--backfill", "--no-prune"])) {
      log.warn(`   summarise FAILED for ${m} — raw rows kept for retry`);
      break;
    }

    // 4. Verify THIS chunk before pruning. The whole incident was a prune that
    //    trusted an unverified summarise, so the check is explicit and local.
    const stillMissing = (await missingNseDays()).filter(
      (d) => d >= gte && d < lt,
    );
    if (stillMissing.length > 0) {
      log.warn(
        `   ${stillMissing.length} day(s) in ${m} STILL have no NSE summaries ` +
          `(e.g. ${stillMissing.slice(0, 3).map((d) => d.toISOString().slice(0, 10)).join(", ")}) ` +
          `— keeping raw rows, not pruning`,
      );
      continue;
    }

    // 5. Prune. fo-summary's own retention pass now gates on completeness, so
    //    this drops exactly the days proven complete above.
    if (!run("scripts/jobs/fo-summary.ts", ["--backfill"])) {
      log.warn(`   prune pass FAILED for ${m} — rows remain, harmless`);
    }

    repaired += days.length;
    log.info(`   ${m} done (${repaired}/${missing.length} day(s) repaired)`);
  }

  log.info(`DONE: repaired ${repaired} day(s)`);
}

main()
  .catch((e) => {
    console.error("[fo-gap] FAILED", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
