/**
 * RE-PARSE stored XBRL filings from the ARCHIVED XML — MONEY-1252.
 *
 * ## Why this job exists
 *
 * `packages/core/src/market-data/xbrl-financials-logic.ts` gained two concepts
 * in MONEY-1250 — `bankBalanceOther` and `currentInvestments` — and the
 * projection's `totalCash` became `sumPresent([cashAndCashEquivalents,
 * bankBalanceOther, currentInvestments])` (`xbrl-projection.ts:1090`). Note the
 * split: the PARSER learned the two concepts, the PROJECTION sums them. Which
 * is why re-parsing is necessary AND not sufficient — the projection has to run
 * again afterwards, and the "NEXT STEP" line at the end of this job says so.
 *
 * The incumbent's cash column is
 * `CashAndCashEquivalents + BankBalanceOtherThanCashAndCashEquivalents +
 * CurrentInvestments`: 28 of 29 sampled filings fit that exactly (RELIANCE
 * 106,502 -> 225,211, WIPRO 12,197 -> 53,345, TCS 8,342 -> 46,152) and 0 of 29
 * fit cash alone.
 *
 * Both lines were ALWAYS in the filings — same balance sheet, same context.
 * They simply had no concept in our table. So every one of the ~96,000 rows
 * already in `xbrl_filings` was parsed by a table that could not see them,
 * their `facts.values` do not carry them, and `totalCash` still publishes about
 * a quarter of a company's cash. The F3 gate reads `totalCash` 81.5%
 * disagreement.
 *
 * Re-parsing the SAME BYTES with the CURRENT parser is the entire fix. There is
 * no new data to fetch and nothing upstream to ask.
 *
 * ## THE ONE SAFETY PROPERTY: this job NEVER touches NSE
 *
 * Every document it reads comes from `feeds/NSE/results-xbrl/` in GCS via
 * `FeedArchiveStore.get`, which is a bare object read. It deliberately does NOT
 * use `getFeedAsset` or `fetchXml`: BOTH of those re-fetch from the exchange on
 * an archive miss, by design, because for the ingest a miss means "we do not
 * have it yet". Here a miss means "we already hold the row and simply cannot
 * improve it", and ~2,044 of 96,056 rows are in that state (archive coverage
 * measured 2026-08-25: 94,012 / 96,056 = 97.9%; 100% for period-years
 * 2017-2025, 70% for 2026). A fallback would turn a counted skip into two
 * thousand requests at the one host this whole feature depends on and which has
 * throttled us before.
 *
 * An archive miss is COUNTED and SKIPPED. It does not fail the run either —
 * see `reparseExitCode` for why a permanent, known, un-actionable condition
 * must not paint the task red.
 *
 * ## The write path is REUSED, never reimplemented
 *
 * `reparseStoredFiling` calls `storeFiling` and then `storeAnnualCompanion`,
 * which are the same two functions the nightly download loop calls per
 * document. Both legs are mandatory: the second re-parses the same bytes for
 * the YEAR's contextRef and writes a SECOND row, and ANNUAL is exactly what the
 * reconcile gate compares. A re-parse that ran only the first leg would rewrite
 * 75,238 quarterly rows and leave all 20,338 annual ones stale.
 *
 * ## One DOCUMENT, up to two ROWS — and the walk is over ROWS
 *
 * A March-quarter document is stored TWICE: the quarter (`storeFiling`) and the
 * year (`storeAnnualCompanion`). Measured on prod 2026-08-25 the table averages
 * **1.34 rows per distinct `sourceUrl`** (96,056 rows; 75,238 QUARTERLY, 20,338
 * ANNUAL, 480 HALF_YEARLY), and in a 400-row sample EVERY annual row had a
 * non-annual sibling at the same URL.
 *
 * This job walks ROWS, so it reads ~26% of documents twice — once from each of
 * their rows — and each read rewrites BOTH rows. That is deliberate, and the
 * alternative was rejected: selecting only non-ANNUAL rows would be ~26%
 * cheaper and would rest on "every ANNUAL row has a quarterly sibling", which
 * is a 400-row SAMPLE, not a proof. A document whose PRIMARY period is the full
 * year stores an ANNUAL row with no sibling, and excluding it would leave it
 * permanently stale while the run reported DRAINED — the silent-exclusion shape
 * this whole ticket is repairing. Redundant work is visible; a skipped row is
 * not.
 *
 * The consequence for the counters, stated so nobody has to infer it:
 * `--limit` counts ROWS (so `--limit=500` is ~372 distinct documents — the
 * MONEY-1207 duplication-factor trap), and `written` counts UPSERTS, so a row
 * re-persisted from both of its document's rows counts twice. Neither affects
 * the property the zero-write monitor rests on: `selected` is zero exactly when
 * the scope held nothing.
 *
 * `storeFiling` also sets `projectedAt: null` when `projectionInputChanged`.
 * That is load-bearing and must not be bypassed: without the clear, the nightly
 * projection selects with `unprojectedOnly` and skips these rows as
 * already-projected, so the corrected `totalCash` would never reach
 * `stock_financials` and this job would have changed nothing a reader can see.
 *
 * ## DRY RUN BY DEFAULT
 *
 * `--apply` is required to write. Without it the REAL write path still runs —
 * parse, `storeFiling`, `storeAnnualCompanion`, instrument resolution, the
 * incumbent read and the `projectionInputChanged` decision — against a no-op
 * upsert. That makes the rehearsal answer the only question worth asking
 * beforehand ("how many rows actually MOVE?") instead of merely counting rows,
 * and it does it through the same code the apply will run rather than through a
 * second estimate that can disagree.
 *
 * The job-outcome metric still reports `written: 0` for a dry run. The
 * would-have number lives in the reason string, where it is a plan rather than
 * a measurement.
 *
 * ## Resume
 *
 * The cursor is `XbrlFiling.id` — a Mongo ObjectId, unique and ascending — and
 * every run prints `--after-id=<lastId>`. There is no checkpoint table on
 * purpose: the MONEY-1189 postmortem is a catalogue of checkpoints recording
 * DONE for work that never happened. Re-running a range is also free of
 * consequence, because a re-parse of unchanged bytes produces identical facts,
 * `projectionInputChanged` returns false, and `projectedAt` is left alone.
 *
 * Usage (dry run is the default):
 *   npx tsx scripts/jobs/xbrl-reparse.ts --limit=50
 *   npx tsx scripts/jobs/xbrl-reparse.ts --from=2024 --to=2024 --apply
 *   npx tsx scripts/jobs/xbrl-reparse.ts --apply --after-id=6a8602e00051c49dd1295298
 *
 * As a Cloud Run job (`scripts/ops/setup-xbrl-reparse-job.sh`):
 *   ./scripts/ops/run-market-data-job.sh xbrlreparse prod
 *   ./scripts/ops/run-market-data-job.sh xbrlreparse prod --apply --from=2024 --to=2024
 *
 * NOTE `gcloud run jobs execute --args` splits on COMMAS, so each comma starts
 * a NEW argument. A stray comma inside a flag is a routine mistake, which is
 * why an unrecognised argument is FATAL here rather than ignored.
 */

import prisma, { Prisma } from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { flushMetrics } from "@usemoney/datadog/metrics";
// The WRITE PATH, imported rather than restated. `reparseStoredFiling` runs
// `storeFiling` + `storeAnnualCompanion` — the same pair the nightly download
// loop runs per document — so this job cannot drift from the ingest on
// periodType, cumulative, basis, or the projection-cursor clear.
import {
  reparseStoredFiling,
  type StoredFilingRef,
  type XbrlStoreDeps,
} from "../../workers/src/processors/xbrl-sync";
// The archive-key grammar. Shared with `xbrl-backfill.ts --archive-existing`,
// because the grammar is FROZEN (~66,950 objects per bucket) and a second copy
// of it would not be a bug to fix but objects to migrate.
import { candidateArchiveKeysForFiling } from "../../workers/src/processors/xbrl-sync-logic";
// This job is its OWN entry point — it does NOT boot through
// workers/src/index.ts, which is where initFeedArchive() is called for the push
// worker. Importing it here is what actually wires the GCS store.
import { initFeedArchive } from "../../workers/src/lib/feed-archive-store";
import {
  getFeedArchiveStore,
  resolveFeedArchiveMode,
} from "@usemoney/core/market-data";
// MONEY-1205 T5 — Cloud Run JOBS pin their image at provision time and a deploy
// of the SERVICE does not move them, so this job can run weeks-old code, exit 0
// and report success while skipping work it has never heard of. The only place
// that drift is observable is this line.
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import {
  parseReparseArgs,
  resolveReparseApply,
  periodYearWindow,
  isUsableArchivedXml,
  runReparseLoop,
  reparseJobOutcome,
  describeReparseOutcome,
  describeReparseRow,
  describeReparseStop,
  reparseExitCode,
  type ReparseRowResult,
} from "./xbrl-reparse-logic.mjs";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const log = {
  info: (...a: unknown[]) => console.log("[xbrl-reparse]", ...a),
  warn: (...a: unknown[]) => console.warn("[xbrl-reparse]", ...a),
};

/** A page row: the archive-key inputs, the cursor, and the write-path ref. */
interface ReparseRow extends StoredFilingRef {
  id: string;
  periodEnd: Date;
  periodType: string;
}

/**
 * Prisma, wrapped so the run can COUNT what the write path decided.
 *
 * Two jobs, one seam:
 *
 *   1. **`projectionReset`.** `storeFiling` clears `projectedAt` exactly when
 *      `projectionInputChanged` — i.e. when the re-parse produced different
 *      facts. That is THE number this job exists to move, and it is observed
 *      here at the upsert rather than re-derived, so it is the write path's own
 *      decision and not a second copy of it that can disagree. (Re-deriving it
 *      would also cost a second read of every row's `facts`.)
 *
 *   2. **The dry run.** With `apply` false the upsert is a no-op and everything
 *      above it still runs for real. That is what makes the rehearsal answer
 *      "how many rows MOVE?" through the same code the apply will run.
 *
 * Everything else delegates verbatim. A deps double that quietly changed
 * behaviour would make the rehearsal a lie about the apply, which is worse than
 * having no rehearsal.
 */
function makeDeps(
  apply: boolean,
  onProjectionReset: () => void,
): XbrlStoreDeps {
  return {
    instrumentMapping: {
      findFirst: async (args) => {
        const row = await prisma.instrumentMapping.findFirst(
          args as Prisma.InstrumentMappingFindFirstArgs,
        );
        return row === null ? null : { id: row.id };
      },
    },
    xbrlFiling: {
      // Supplied, so `storeFiling` takes its REAL branch. Its absence "fails
      // open" to an unconditional projection clear (MONEY-1238) — safe, but it
      // would make `projectionReset` count every row and measure nothing.
      findUnique: async (args) => {
        const row = await prisma.xbrlFiling.findUnique(
          args as Prisma.XbrlFilingFindUniqueArgs,
        );
        return row === null
          ? null
          : { sourceUrl: row.sourceUrl, facts: row.facts };
      },
      upsert: async (args) => {
        const payload = args as { update?: Record<string, unknown> };
        // `storeFiling` spreads `projectedAt: null` into `update` ONLY when the
        // facts moved, so the key's PRESENCE is the signal. Reading the value
        // would be wrong: `null` is the value it always carries.
        if (payload.update && "projectedAt" in payload.update) {
          onProjectionReset();
        }
        if (!apply) return {};
        return prisma.xbrlFiling.upsert(args as Prisma.XbrlFilingUpsertArgs);
      },
    },
  };
}

/**
 * Locate and read one row's archived document. NEVER fetches.
 *
 * A read that THROWS is not evidence of absence — the same call the
 * `--archive-existing` probe makes, and the same reasoning: treating a storage
 * outage as "not archived" would report a corpus-wide gap that is really an IAM
 * problem. It gets its own counter (and its own `transportFailures` metric) so
 * "assumed unreadable" and "confirmed absent" can never be added together.
 * One increment per ROW at most: the loop breaks on the first throw.
 */
async function readArchivedXml(
  store: { get: (key: string) => Promise<Buffer | null> },
  row: ReparseRow,
): Promise<
  | { kind: "xml"; xml: string; key: string }
  | { kind: "missing" }
  | {
      kind: "read-failed";
    }
> {
  for (const key of candidateArchiveKeysForFiling(row)) {
    let bytes: Buffer | null;
    try {
      bytes = await store.get(key);
    } catch (err) {
      log.warn(`archive read FAILED for ${key}: ${String(err)}`);
      return { kind: "read-failed" };
    }
    if (bytes && bytes.length > 0) {
      return { kind: "xml", xml: bytes.toString("utf-8"), key };
    }
  }
  return { kind: "missing" };
}

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Without this the job logs to
  // stdout only: `initLogger()` had exactly one caller in the whole repo.
  await initJobTelemetry();
  reportBuildProvenance(log, "xbrl-reparse");

  const { args, errors } = parseReparseArgs(process.argv.slice(2));
  if (errors.length > 0) {
    for (const e of errors) log.warn(`ARGUMENT ERROR: ${e}`);
    log.warn(
      "Refusing to run. Flags: --apply --dry-run --from=YYYY --to=YYYY " +
        "--symbols=A,B --after-id=<ObjectId> --limit=N --page=N --budget-sec=N",
    );
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  const apply = resolveReparseApply(args);

  // Wire the GCS store BEFORE anything can read. Unlike `xbrl-backfill.ts` this
  // job is a pure READER of the archive, so it needs a store in EVERY mode —
  // `archive` on prod and `replay` on QA both register one, and both serve the
  // same bytes for a `get`. What it must never do is run WITHOUT one: with no
  // store every row would report `archive-missing` and the run would print a
  // confident, complete-looking "94,012 rows have no archived XML".
  initFeedArchive();
  const store = getFeedArchiveStore();
  if (!store) {
    throw new Error(
      `No feed archive store is registered (FEED_ARCHIVE_MODE=` +
        `${resolveFeedArchiveMode()}). This job READS every document from ` +
        `GCS and never fetches, so without a store it would report every row ` +
        `as un-archived and exit 0. Set FEED_ARCHIVE_MODE and ` +
        `GCP_STORAGE_BUCKET. Refusing to run.`,
    );
  }

  const periodEnd = periodYearWindow(args.fromYear, args.toYear);
  const where: Prisma.XbrlFilingWhereInput = {
    exchange: "NSE",
    ...(periodEnd ? { periodEnd } : {}),
    ...(args.symbols && args.symbols.length > 0
      ? { symbol: { in: args.symbols } }
      : {}),
  };
  // Counted WITH the resume cursor applied, so "remaining" is what is actually
  // left rather than the size of the whole shard. A completeness number
  // reported at the wrong granularity is the MONEY-1189 defect restated.
  const remainingAtStart = await prisma.xbrlFiling.count({
    where: { ...where, ...(args.afterId ? { id: { gt: args.afterId } } : {}) },
  });

  log.info(
    `apply=${apply} (--apply=${args.apply}, --dry-run=${args.dryRun}), ` +
      `archiveMode=${resolveFeedArchiveMode()}, ` +
      `period=${args.fromYear ?? "-"}..${args.toYear ?? "-"}, ` +
      `symbols=${args.symbols?.length ?? "all"}, ` +
      `afterId=${args.afterId ?? "-"}, limit=${args.limit || "none"}, ` +
      `page=${args.page}, budget=${args.budgetMs / 60_000}m, ` +
      `inScope=${remainingAtStart}`,
  );
  if (!apply) {
    log.info(
      "DRY RUN — the real write path runs against a NO-OP upsert, so the " +
        "counts below are what an --apply run would do. Nothing is written.",
    );
  }

  let projectionResetInRow = false;
  const deps = makeDeps(apply, () => {
    projectionResetInRow = true;
  });

  const outcome = await runReparseLoop<ReparseRow>(
    {
      apply,
      limit: args.limit,
      page: args.page,
      budgetMs: args.budgetMs,
    },
    {
      fetchPage: (cursor, take) =>
        prisma.xbrlFiling.findMany({
          // THE CURSOR. Keyset on `id`, which is a Mongo ObjectId: unique and
          // ascending, so the page provably advances. Verified against prod
          // 2026-08-25 — page 2 was strictly greater than and disjoint from
          // page 1. `runReparseLoop` still MEASURES the advance rather than
          // trusting it (MONEY-1211).
          where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
          select: {
            id: true,
            symbol: true,
            sourceUrl: true,
            isin: true,
            basis: true,
            filerKind: true,
            audited: true,
            periodEnd: true,
            periodType: true,
            filedAt: true,
          },
          orderBy: { id: "asc" },
          take,
        }),
      processRow: async (row): Promise<ReparseRowResult> => {
        const found = await readArchivedXml(store, row);
        if (found.kind === "missing") return { kind: "archive-missing" };
        if (found.kind === "read-failed")
          return { kind: "archive-read-failed" };
        // An HTML challenge page archived as XML would parse as `not-xbrl` and
        // be counted `unparseable`, which sends the next investigation to the
        // concept table instead of to the archive. Same guard `fetchXml` keeps
        // on the ingest side, for the same reason.
        if (!isUsableArchivedXml(found.xml)) {
          log.warn(`archived object is not a document: ${found.key}`);
          return { kind: "archive-unusable" };
        }

        projectionResetInRow = false;
        const verdict = await reparseStoredFiling(row, found.xml, deps);
        return {
          kind: "parsed",
          bucket: verdict.bucket,
          refusal: verdict.refusal,
          annual: verdict.annual,
          projectionReset: projectionResetInRow,
        };
      },
      now: () => Date.now(),
      onPage: (i, progress, totals) => {
        log.info(
          `page ${i + 1}: rows ${progress.rowsRead}, cursor ` +
            `${progress.cursorBefore ?? "-"} -> ${progress.cursorAfter ?? "-"}` +
            `, running selected ${totals.selected}, stored ${totals.stored}` +
            ` (+${totals.storedAnnual} annual), changed ` +
            `${totals.projectionReset}, archive-missing ${totals.archiveMissing}`,
        );
      },
      describeRow: describeReparseRow,
    },
    args.afterId,
  );

  // ── ONE structured summary, always — including the zero case ──
  log.info(`SUMMARY ${describeReparseOutcome(outcome)}`);
  log.info(
    `buckets ${JSON.stringify(outcome.totals.buckets)} ` +
      `refusals ${JSON.stringify(outcome.totals.refusals)} ` +
      `annualAmbiguous ${outcome.totals.annualAmbiguous} ` +
      `annualUnreadable ${outcome.totals.annualUnreadable}`,
  );
  if (outcome.totals.examples.length > 0) {
    log.info(`examples:\n  ${outcome.totals.examples.join("\n  ")}`);
  }

  if (outcome.totals.archiveMissing > 0) {
    // NOT an error, and deliberately not part of the exit code. It is a
    // measured 2.1% that this job cannot close without NSE traffic it refuses
    // to make. The warning names the remedy so the number is actionable
    // instead of merely alarming.
    log.warn(
      `${outcome.totals.archiveMissing} row(s) have NO archived XML and were ` +
        `SKIPPED — they keep their pre-MONEY-1250 totalCash. This job never ` +
        `fetches, by design. Closing the gap is a prod-only run of ` +
        `\`xbrl-backfill.ts --archive-existing\`, which re-fetches from NSE; ` +
        `count it first with --dry-run.`,
    );
  }
  if (outcome.totals.archiveReadFailed > 0) {
    log.warn(
      `UNPROVEN — ${outcome.totals.archiveReadFailed} row(s) could not be ` +
        `READ from storage (not the same as absent), so every count above ` +
        `excludes them. Re-run those rows once storage is healthy.`,
    );
  }

  const outcomeReport = reparseJobOutcome(outcome);
  try {
    reportJobOutcome(outcomeReport);
  } catch (err) {
    // An observability helper must never fail the run it observes.
    log.warn(`job-outcome report failed (ignored): ${String(err)}`);
  }

  const stopLine = describeReparseStop(outcome);
  const code = reparseExitCode(outcome);
  if (code === 0) log.info(stopLine);
  else log.warn(stopLine);

  if (apply && outcome.totals.projectionReset > 0) {
    log.info(
      `NEXT STEP: ${outcome.totals.projectionReset} row(s) had projectedAt ` +
        `cleared, so the nightly xbrl-projection will re-project them. To ` +
        `move them sooner, run the drain: ` +
        `gcloud run jobs execute xbrl-projection-drain-prod ...`,
    );
  }

  process.exitCode = code;
  // MONEY-1278 — flush before the process ends. `datadog-metrics` batches on a
  // 15-second timer, so a job that exits first takes the outcome above with it:
  // the counters die in the buffer, nothing reaches Datadog, and the job's
  // monitor reads NO DATA — which is indistinguishable from health once its
  // no-data notification is muted. Never throws (see flushMetrics).
  await flushMetrics();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[xbrl-reparse] FAILED", err);
  await flushMetrics();
  await prisma.$disconnect();
  process.exit(1);
});
