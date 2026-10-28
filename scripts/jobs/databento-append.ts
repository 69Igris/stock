/**
 * The daily Databento append — MONEY-1373.
 *
 * Extends what the harvest bought, one session's worth per night, for the
 * manifest entries marked `append: true`. Same foundation as
 * `databento-harvest.ts`: the same budget guard, the same inventory, the same
 * session writer. What differs is the WINDOW — the harvest is told one, and the
 * append computes one.
 *
 * ## Why it runs at 15:00 IST and not at 13:00
 *
 * The vendor publishes a session under a T+1 embargo: the prior US session
 * becomes available around 09:00 UTC, which is 14:30 IST. A 13:00 IST cron
 * would ask for a session that does not exist yet and get an EMPTY RESULT —
 * indistinguishable from a market holiday, from a symbol list that resolved to
 * nothing, and from a broken query. So the primary trigger is 15:00 IST and the
 * retry is 18:00, both Tue-Saturday because a US session closing 16:00 ET lands
 * after midnight IST on the following day.
 *
 * The clock is not trusted on its own, either. `metadata.get_dataset_range` is
 * read before every append and the gap is clamped to it, so a vendor running
 * late produces a NAMED skip (`NOT_YET_PUBLISHED`) rather than a purchase of
 * nothing.
 *
 * ## The three skips are three different answers
 *
 *   NO_HWM_RUN_HARVEST_FIRST  this entry was never harvested — a human decides
 *   UP_TO_DATE                the healthy steady state; the 18:00 retry after a
 *                             good 15:00 run reports this and spends nothing
 *   NOT_YET_PUBLISHED         come back later; expected around the embargo
 *
 * All three exit 0 with `selected: 0` and the reason on the job-outcome line.
 * Collapsing them into one "nothing to do" would make a never-harvested entry
 * report the same thing, forever, as a perfectly current one — which is the
 * shape of every silent-no-op defect in this repo's history.
 *
 * ## Usage
 *
 *   gcloud run jobs execute databento-append-prod --region=asia-south1 --args=--apply
 *   node --import tsx scripts/jobs/databento-append.ts            # dry run: prints the gap
 *   node --import tsx scripts/jobs/databento-append.ts --entry=ohlcv-1m-baseline --from=2026-09-01
 *
 * DRY RUN IS THE DEFAULT, `--apply` is a BARE flag, and the ARM
 * (`DATABENTO_APPEND_APPLY=true`) is a separate deploy-time fact.
 */

import "dotenv/config";

import prisma from "@usemoney/database";
import { judgeBackfillOutcome } from "@usemoney/core/ops/backfill-outcome";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import {
  flushMetrics,
  gauge,
  incrementCounter,
} from "@usemoney/datadog/metrics";
import { DATABENTO_METRICS } from "@usemoney/core/market-data/databento/databento-metrics";

import { streamObjectSummaries } from "@usemoney/storage";
import {
  DATABENTO_MAX_SYMBOLS_PER_REQUEST,
  DATABENTO_SOURCE,
  LOADABLE_SCHEMAS,
  archiveJobsWithoutLedgerRow,
  classifyFile,
  databentoArchiveKey,
  type DatabentoFile,
  type DatabentoJob,
  type DatabentoSchema,
} from "@usemoney/core/market-data/databento/databento-logic";
// THE MANIFEST TRAVELS IN THE IMAGE — MONEY-1373 I0.
//
// It was `readFileSync(join(process.cwd(), "scripts/data/…"))`, and the
// workers runtime stage copies only `workers/dist`, `workers/package.json` and
// the two `node_modules` trees, with `WORKDIR /app/workers`. There is no
// `scripts/` in the image, so EVERY execution — armed or not, dry run or not —
// died with ENOENT before its first free metadata call, which is exactly the
// "cheapest possible probe" the setup banner recommends running first.
//
// Importing it makes the manifest part of the artifact the job PINS, which is
// also the right ownership: a job runs the manifest it was built with, and a
// manifest edit therefore needs a deploy and a re-pin rather than appearing
// under a running job's feet.
import manifestJson from "../data/databento-manifest.json" with { type: "json" };
import {
  databentoApiKey,
  downloadToArchive,
  getCost,
  getDatasetRange,
  getJobDetails,
  listFiles,
  resolveDatabentoEnv,
  submitBatchJob,
} from "@usemoney/core/market-data/databento/databento-client";
import {
  DatabentoBudgetExceededError,
  formatBudgetLine,
  monthWindowUtc,
  reportQuoteDrift,
  withDatabentoBudget,
} from "@usemoney/core/market-data/databento/databento-budget";
import {
  chunkSymbols,
  datasetForEntry,
  orderedEntries,
  parseManifest,
  resolveSymbolSet,
  symbolsHash,
  type DatabentoManifest,
  type DatabentoManifestEntry,
} from "@usemoney/core/market-data/databento/databento-manifest-logic";
import {
  computeAppendGap,
  highWaterMarkFromChunks,
  hwmForFromDate,
  terminalStatesFor,
  sessionDateForExclusiveEnd,
  type AppendSkipReason,
} from "@usemoney/core/market-data/databento/databento-append-logic";
import {
  coverageFromCount,
  isAppendArmed,
  resolveApply,
  worstCoverage,
  type CoverageReport,
} from "@usemoney/core/market-data/databento/databento-harvest-logic";
import {
  countSessionsPerSymbol,
  createBudgetDeps,
  createCostModelVersion,
  createSessionWriterDeps,
  fetchListingRows,
  fetchMasterSymbols,
  finishCostModelVersion,
  latestCostModelVersion,
  latestArchivedTbboEnd,
  listArchivedBboFiles,
  listArchivedFilesBySchema,
  listingDollarVolume,
  nextCostModelVersion,
  readFileRecords,
  writeCostModelRows,
  type DatabentoFileRecord,
} from "@usemoney/core/market-data/databento/databento-repo";
import {
  buildListingIndex,
  QuarantineLedger,
  type ListingRow,
} from "@usemoney/core/market-data/databento/databento-symbology";
import {
  emptySessionWriteCounters,
  writeSymbolBatch,
} from "@usemoney/core/market-data/databento/databento-session-writer";
import { loadOhlcvStream } from "@usemoney/core/market-data/databento/databento-candle-loader";
import {
  DATABENTO_ARCHIVE_PREFIX,
  getDatabentoArchiveStore,
} from "@usemoney/core/market-data/databento/databento-archive";
import {
  buildCostModel,
  tbboFoldWindow,
} from "@usemoney/core/market-data/databento/databento-cost-model";
import { shouldRebuildCostModel } from "@usemoney/core/market-data/databento/databento-cost-model-logic";
import { lastCompletedUsSession } from "@usemoney/core/market-data/us-market-hours";

import { initCandleColdStore } from "../../workers/src/lib/candle-cold-store-gcs";
import { initDatabentoArchiveStore } from "../../workers/src/lib/databento-archive-gcs";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

/* ─────────────────────────────────────────────────────────────────────────
   CLI
   ──────────────────────────────────────────────────────────────────────── */

const ARGS = parseCliArgsOrExit(
  process.argv.slice(2),
  {
    bare: ["apply", "dry-run", "rebuild-cost-model"],
    valued: ["entry", "from", "max-wait-min"],
    numeric: ["max-wait-min"],
    repeatable: ["entry"],
  },
  "databento-append",
);

const APPLY_ASKED = ARGS.has("apply");
const ENTRIES = ARGS.all("entry");
const FROM = ARGS.value("from");
const MAX_WAIT_MIN = ARGS.number("max-wait-min", 45);

const log = {
  info: (...a: unknown[]) => console.log("[databento-append]", ...a),
  warn: (...a: unknown[]) => console.warn("[databento-append]", ...a),
  error: (...a: unknown[]) => console.error("[databento-append]", ...a),
};

/** 30 s, not the harvest's 60 s: an append job covers ONE session and lands in minutes. */
const POLL_INTERVAL_MS = 30_000;
/**
 * The environment this run stamps its ledger rows with — see
 * {@link resolveDatabentoEnv}. It reads `DATABENTO_ENV` first: the image bakes
 * `NODE_ENV=production` for BOTH environments, so deriving it from `NODE_ENV`
 * stamped every QA execution `env: "prod"`.
 */
const ENV = resolveDatabentoEnv();
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

let currentSymbolSetLabel = "";
const budgetDeps = createBudgetDeps({
  env: ENV,
  symbolSetLabel: () => currentSymbolSetLabel,
});
const writerDeps = createSessionWriterDeps();

const totals = {
  entriesConsidered: 0,
  sessionsPlanned: 0,
  sessionsDeferred: 0,
  chunksSubmitted: 0,
  chunksReused: 0,
  quoteUsd: 0,
  filesDownloaded: 0,
  filesLoaded: 0,
  rowsWritten: 0,
  rowsDeleted: 0,
  sessionsDisplaced: 0,
  refusedD1: 0,
  quarantinedRows: 0,
  quarantinedSymbols: 0,
  errors: 0,
  transportFailures: 0,
  /** Archive job folders no ledger row names (MONEY-1540); -1 = not checked. */
  archiveOrphans: -1,
};

/** Per-entry skip reasons, for one honest `skippedReason` on the outcome line. */
const skips = new Map<string, AppendSkipReason>();

/* ─────────────────────────────────────────────────────────────────────────
   The high-water mark
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The latest ET session this entry actually HOLDS — across EVERY chunk.
 *
 * TWO things here are load-bearing and both are about not advancing past a
 * hole.
 *
 * FIRST, only rows that reached a TERMINAL state for their kind count:
 * `LOADED` for an entry whose records become candles, `DOWNLOADED` for an
 * archive-only one. NOT `SUBMITTED` or `DONE` — a window that was bought but
 * never loaded is spend, not coverage, and counting it would move the mark
 * past a session with no bars in it.
 *
 * SECOND, the mark is the end of the newest WINDOW that all of today's chunk
 * count completed — see `highWaterMarkFromChunks`. Not a per-`symbolsHash`
 * minimum: MASTER re-hashes most nights, and a minimum over hashes that are
 * never bought again pinned `ohlcv-1h-master` at 2026-09-08 for good
 * (MONEY-1539).
 */
async function readHighWaterMark(
  entry: DatabentoManifestEntry,
  expectedChunks: number,
): Promise<string | null> {
  const terminal = terminalStatesFor(entry);
  const rows = await prisma.databentoBatchJob.findMany({
    where: { entryId: entry.id, state: { in: terminal } },
    select: { symbolsHash: true, start: true, end: true },
  });
  // The SELECTION is pure and lives in `databento-append-logic.ts`, where it
  // has a unit test; a source scan here could not tell two policies apart.
  const { mark, furthest, furthestChunks } = highWaterMarkFromChunks(
    rows,
    expectedChunks,
  );
  if (mark === null && rows.length > 0) {
    log.warn(
      `${entry.id}: no purchase window has all ${expectedChunks} chunk(s) ` +
        "terminal — treating the entry as un-harvested rather than advancing " +
        "past sessions a chunk never held. Re-harvest it, or pass --from= " +
        "deliberately.",
    );
  }
  if (furthest !== null && furthest !== mark) {
    log.warn(
      `${entry.id}: the newest window reaches ${furthest} with only ` +
        `${furthestChunks} of ${expectedChunks} chunk(s) terminal. Using ` +
        `${mark ?? "none"}, so the missing chunks are re-asked for rather ` +
        "than skipped past.",
    );
  }
  return mark;
}

/** One dataset-range read per RUN. See its call site for why. */
let datasetRangeCache: Promise<
  Awaited<ReturnType<typeof getDatasetRange>>
> | null = null;

function datasetRangeOnce(
  dataset: string,
): Promise<Awaited<ReturnType<typeof getDatasetRange>>> {
  // The PROMISE is cached, not the resolved value, so two concurrent callers
  // share one in-flight request rather than racing to start a second.
  datasetRangeCache ??= getDatasetRange(dataset);
  return datasetRangeCache;
}

/* ─────────────────────────────────────────────────────────────────────────
   One entry
   ──────────────────────────────────────────────────────────────────────── */

async function appendEntry(
  entry: DatabentoManifestEntry,
  manifest: DatabentoManifest,
  apply: boolean,
  now: Date,
): Promise<void> {
  totals.entriesConsidered++;

  // SYMBOLS FIRST, because the high-water mark needs the CHUNK COUNT to tell
  // "this chunk is behind" from "this chunk does not exist". It is one Prisma
  // read even on an entry that turns out to be UP_TO_DATE — cheap against the
  // alternative, which is advancing the mark past sessions a re-chunked
  // population never held.
  const symbols = await resolveSymbolSet({
    names: entry.symbolSets,
    manifest,
    resolveMaster: fetchMasterSymbols,
  });
  const chunks = chunkSymbols(symbols, DATABENTO_MAX_SYMBOLS_PER_REQUEST);

  let hwm = await readHighWaterMark(entry, chunks.length);
  if (FROM !== undefined) {
    if (hwm !== null) {
      // A `--from` on an entry that already has coverage is refused rather
      // than honoured. The idempotent lookup would skip the overlapping
      // windows anyway, so this costs nothing — but an override that silently
      // did nothing would leave the operator believing a re-append happened.
      throw new Error(
        `--from=${FROM} was passed but ${entry.id} already holds sessions ` +
          `through ${hwm}. --from is for an entry with NO high-water mark ` +
          "(the first append after a harvest that did not include it). " +
          "Refusing rather than quietly ignoring it.",
      );
    }
    hwm = hwmForFromDate(FROM);
    log.info(`${entry.id}: --from=${FROM} → treating ${hwm} as the mark`);
  }

  // The VENDOR's availability, per schema. Free, and the whole reason an
  // embargoed session becomes a named skip instead of an empty purchase.
  //
  // Fetched ONCE PER RUN, not once per entry. Three entries would otherwise
  // make three identical calls — and, worse, three calls that straddle a
  // release could return different `end` values, so two entries would compute
  // their gaps against different beliefs about what exists.
  let rangeEndMs: number | null = null;
  let rangeReadOk = false;
  // The ENTRY's dataset, not the manifest's. No appendable entry overrides it
  // today, and that is exactly why this must not restate the fallback: the day
  // one does, a hardcoded `manifest.dataset` buys the wrong data under the
  // right entry id, and the purchase cannot be undone. Declared OUTSIDE the
  // try, because the submission below needs it whether or not the range read
  // threw.
  const entryDataset = datasetForEntry(entry, manifest);
  try {
    const range = await datasetRangeOnce(entryDataset);
    const perSchema = range.bySchema[entry.schema];
    rangeEndMs = (perSchema ?? range).end.getTime();
    rangeReadOk = true;
  } catch (err) {
    totals.transportFailures++;
    log.error(`${entry.id}: dataset range unreadable — ${errText(err)}`);
  }

  // A SUCCESSFUL READ THAT YIELDS NO BOUND IS A BUG, NOT AN EMBARGO.
  //
  // `computeAppendGap` treats a null range as NOT_YET_PUBLISHED, which is the
  // right call when the metadata call FAILED — but it makes every other way of
  // arriving at null indistinguishable from a vendor running late. A mutation
  // that fed the gap a null range made the append return NOT_YET_PUBLISHED on
  // every entry, forever, appending nothing, and exiting 0; the whole suite
  // stayed green because the deploy contract compared the two calls' TEXTUAL
  // positions in the file rather than their values.
  if (rangeReadOk && !Number.isFinite(rangeEndMs)) {
    throw new Error(
      `${entry.id}: metadata.get_dataset_range succeeded but yielded no ` +
        `usable end for schema ${entry.schema}. Refusing to report ` +
        "NOT_YET_PUBLISHED — that reads as a late vendor and would silence " +
        "this entry indefinitely.",
    );
  }

  const gap = computeAppendGap({
    hwmSessionDate: hwm,
    datasetRangeEndUtcMs: rangeEndMs,
    now,
  });
  if (!gap.ok) {
    skips.set(entry.id, gap.skipReason);
    log.info(`${entry.id}: ${gap.skipReason} (hwm=${hwm ?? "none"})`);
    return;
  }

  totals.sessionsPlanned += gap.sessions.length;
  totals.sessionsDeferred += gap.deferred;
  log.info(
    `${entry.id}: ${gap.sessions.length} session(s) ` +
      `${gap.sessions[0]}..${gap.sessions[gap.sessions.length - 1]}` +
      (gap.deferred > 0 ? ` (+${gap.deferred} deferred to the next run)` : ""),
  );

  const start = new Date(gap.startMs);
  const end = new Date(gap.endMsExclusive);

  const rowIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const request = {
      dataset: entryDataset,
      schema: entry.schema,
      symbols: chunk,
      start,
      end,
      // ONE FILE. A daily window is small, and a single file is one download,
      // one checksum and one load — splitting it would multiply the per-file
      // bookkeeping for no benefit at this size.
      splitSymbols: false,
      splitDuration: "none" as const,
    };
    currentSymbolSetLabel = `${entry.symbolSets.join("+")}:${i + 1}/${chunks.length}`;

    try {
      const outcome = await withDatabentoBudget(
        {
          purpose: "APPEND",
          entryId: entry.id,
          schema: entry.schema,
          symbolsHash: symbolsHash(chunk),
          start,
          end,
          dataset: entryDataset,
          symbolCount: chunk.length,
          request,
          apply,
        },
        budgetDeps,
        () => getCost(request),
        () => submitBatchJob(request),
      );
      log.info(
        formatBudgetLine({
          entryId: `${entry.id} ${currentSymbolSetLabel}`,
          outcome,
        }),
      );

      if (outcome.status === "submitted") {
        totals.chunksSubmitted++;
        totals.quoteUsd += outcome.quoteUsd;
        rowIds.push(outcome.row.id);
        const drift = reportQuoteDrift({
          entryId: `${entry.id} ${currentSymbolSetLabel}`,
          jobId: outcome.job.id,
          quotedUsd: outcome.quoteUsd,
          actualUsd: outcome.job.costUsd,
        });
        if (drift) log.warn(drift);
      } else if (outcome.status === "reused") {
        totals.chunksReused++;
        rowIds.push(outcome.row.id);
      } else {
        totals.quoteUsd += outcome.quoteUsd;
      }
    } catch (err) {
      if (err instanceof DatabentoBudgetExceededError) {
        log.error(err.message);
        totals.errors++;
        throw err;
      }
      totals.errors++;
      log.error(`${entry.id} chunk ${i + 1}: ${errText(err)}`);
    }
  }

  if (!apply || rowIds.length === 0) return;

  const settled = await pollUntilDone(rowIds, now);
  await downloadAndLoad(rowIds, entry);

  // COVERAGE ONLY WHEN SOMETHING SETTLED. `pollUntilDone` returning on
  // `--max-wait-min` logs "NOT a failure — the retry run resumes from exactly
  // here", and three lines later `reportCoverage` found no rows, logged
  // "ZERO sessions landed … the load produced no rows" at ERROR, incremented
  // `totals.errors`, and drove `judgeBackfillOutcome` to exit 1. The comment
  // and the code said opposite things, and the error blamed the loader for a
  // vendor that was simply still working.
  if (!settled) {
    skips.set(entry.id, "POLL_TIMEOUT");
    log.info(
      `${entry.id}: no job settled within --max-wait-min=${MAX_WAIT_MIN}; ` +
        "skipping the coverage check. The 18:00 retry resumes from the " +
        "inventory.",
    );
    return;
  }
  await reportCoverage(
    entry,
    manifest,
    gap.sessions,
    gap.startMs,
    gap.endMsExclusive,
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Poll · download · load
   ──────────────────────────────────────────────────────────────────────── */

async function pollUntilDone(rowIds: string[], now: Date): Promise<boolean> {
  const deadline = now.getTime() + MAX_WAIT_MIN * 60_000;
  for (;;) {
    const rows = await prisma.databentoBatchJob.findMany({
      where: { id: { in: rowIds }, state: { in: ["SUBMITTED", "PROCESSING"] } },
      select: { id: true, jobId: true },
    });
    if (rows.length === 0) return true;

    for (const row of rows) {
      if (row.jobId === null) continue;
      try {
        const details = await getJobDetails(row.jobId);
        const state =
          details.state === "done"
            ? "DONE"
            : details.state === "expired"
              ? "EXPIRED"
              : "PROCESSING";
        await prisma.databentoBatchJob.update({
          where: { id: row.id },
          data: {
            state,
            costUsd: details.costUsd,
            recordCount:
              details.recordCount === null ? null : BigInt(details.recordCount),
            billedSize:
              details.billedSize === null ? null : BigInt(details.billedSize),
            tsExpiration: details.tsExpiration
              ? new Date(details.tsExpiration)
              : null,
          },
        });
      } catch (err) {
        totals.transportFailures++;
        log.error(`poll ${row.jobId}: ${errText(err)}`);
      }
    }

    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      // NOT a failure. The rows keep their state and the 18:00 retry — or
      // tomorrow's primary — resumes from exactly here.
      log.info(
        `PENDING ${rows.length} job(s) at --max-wait-min=${MAX_WAIT_MIN}. ` +
          "The inventory keeps the state; the retry run resumes from it.",
      );
      return false;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function downloadAndLoad(
  rowIds: string[],
  entry: DatabentoManifestEntry,
): Promise<void> {
  const store = getDatabentoArchiveStore();
  if (store === null) throw new Error("No Databento archive store registered");

  const rows = await prisma.databentoBatchJob.findMany({
    where: { id: { in: rowIds }, state: { in: ["DONE", "DOWNLOADED"] } },
    select: {
      id: true,
      jobId: true,
      dataset: true,
      schema: true,
      start: true,
      files: true,
      state: true,
    },
  });

  const listings = entry.load ? await loadListingIndex() : null;
  const quarantine = new QuarantineLedger();

  for (const row of rows) {
    // A local const, not `row.jobId`: the narrowing above does not survive
    // into the `.map` closure below, where TypeScript sees `string | null`
    // again.
    const jobId = row.jobId;
    if (jobId === null) continue;
    // ONE `batch.list_files` per row. It was called twice — once to build the
    // inventory when the row had none, then again for every row to resolve
    // download URLs — so a first-sight row paid two metered calls for the same
    // answer and every other row paid one it could have shared.
    let vendorFiles: DatabentoFile[] | null = null;
    const listVendorFiles = async (): Promise<DatabentoFile[]> => {
      vendorFiles ??= await listFiles(jobId);
      return vendorFiles;
    };

    let records = readFileRecords(row.files);
    if (records.length === 0) {
      records = (await listVendorFiles()).map((file) => ({
        filename: file.filename,
        size: file.size,
        sha256: file.sha256,
        kind: classifyFile(file.filename),
        verified: false,
        archiveKey: databentoArchiveKey({
          dataset: row.dataset,
          schema: row.schema,
          year: row.start.getUTCFullYear(),
          jobId,
          filename: file.filename,
        }),
      }));
    }

    const files = await listVendorFiles();
    for (const record of records) {
      if (record.verified) continue;
      const file = files.find((f) => f.filename === record.filename);
      if (file === undefined) {
        record.detail = "not present in batch.list_files";
        totals.errors++;
        continue;
      }
      try {
        const { bytes } = await downloadToArchive({
          file,
          key: record.archiveKey,
          store,
        });
        record.verified = true;
        record.size = bytes;
        delete record.detail;
        totals.filesDownloaded++;
      } catch (err) {
        record.verified = false;
        record.detail = errText(err).slice(0, 500);
        totals.errors++;
        log.error(`download ${record.filename}: ${record.detail}`);
      }
    }

    if (listings !== null && LOADABLE_SCHEMAS.includes(row.schema as never)) {
      for (const record of records) {
        if (record.kind !== "data" || !record.verified) continue;
        if (record.loadedAt !== undefined) continue;
        const stream = await store.getStream(record.archiveKey);
        if (stream === null) {
          record.detail = "archive object absent at load time";
          record.verified = false;
          totals.errors++;
          continue;
        }
        const counters = emptySessionWriteCounters();
        await loadOhlcvStream({
          stream,
          schema: row.schema as DatabentoSchema,
          listings,
          quarantine,
          writer: (batch) => writeSymbolBatch(batch, writerDeps, counters),
        });
        // A FILE WITH FAILED WRITES IS NOT LOADED — same reason as the
        // harvest. `putCandles` returns a `failed` count rather than throwing,
        // and stamping regardless would advance the high-water mark past a
        // session whose weaker rows were deleted and whose replacements never
        // landed.
        if (counters.failed > 0) {
          totals.errors += counters.failed;
          record.verified = false;
          record.detail = `${counters.failed} row write(s) failed during load`;
          log.error(
            `${record.filename}: ${counters.failed} row write(s) FAILED — not ` +
              "stamping it loaded; the retry run will re-load it.",
          );
          continue;
        }
        record.loadedRows = counters.rowsWritten;
        record.loadedAt = new Date().toISOString();
        totals.filesLoaded++;
        totals.rowsWritten += counters.rowsWritten;
        totals.rowsDeleted += counters.rowsDeleted;
        totals.sessionsDisplaced += counters.sessionsDisplaced;
        totals.refusedD1 += counters.refusedD1;
        totals.errors += counters.failed + counters.refusedD1;
        if (counters.refusedD1 > 0) {
          log.error(
            `${record.filename}: refusedD1=${counters.refusedD1} — a writer ` +
              "attempted to displace a DAILY session.",
          );
        }
        log.info(
          `loaded ${record.filename}: written=${counters.rowsWritten} ` +
            `displaced=${counters.sessionsDisplaced} ` +
            `refused=${counters.sessionsRefused}`,
        );
      }
    }

    const dataFiles = records.filter((r) => r.kind === "data");
    const allVerified = records.length > 0 && records.every((r) => r.verified);
    const allLoaded =
      dataFiles.length > 0 && dataFiles.every((r) => r.loadedAt !== undefined);
    // A whole-array write is SAFE here and is not safe in the harvest. The
    // append takes no `--shard` and its Cloud Run job is provisioned with one
    // task, so there is no second writer to lose an update to. The harvest
    // shards its load across tasks and therefore stamps each file atomically
    // through the positional operator instead. If the append ever gains
    // tasks, this must move to `stampFileLoaded` too.
    await prisma.databentoBatchJob.update({
      where: { id: row.id },
      data: {
        files: records as unknown as object[],
        loadedRows: records.reduce((n, r) => n + (r.loadedRows ?? 0), 0),
        ...(allLoaded
          ? { state: "LOADED", loadedAt: new Date() }
          : allVerified
            ? { state: "DOWNLOADED", downloadedAt: new Date() }
            : {}),
      },
    });
  }

  const summary = quarantine.summary();
  totals.quarantinedRows += summary.quarantinedRows;
  totals.quarantinedSymbols += summary.quarantinedSymbols;
  if (summary.quarantinedRows > 0) {
    log.warn(
      `quarantined ${summary.quarantinedRows} row(s) across ` +
        `${summary.quarantinedSymbols} symbol(s): ` +
        summary.sample
          .slice(0, 5)
          .map((s) => `${s.symbol}(${s.reason},${s.rows})`)
          .join(" "),
    );
  }
}

let listingIndexCache: Map<string, ListingRow[]> | null = null;

async function loadListingIndex(): Promise<Map<string, ListingRow[]>> {
  if (listingIndexCache !== null) return listingIndexCache;
  listingIndexCache = buildListingIndex(await fetchListingRows());
  return listingIndexCache;
}

/* ─────────────────────────────────────────────────────────────────────────
   Coverage, for the sessions this run bought
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Did the sessions we asked for actually arrive?
 *
 * Scoped to THIS run's window rather than the entry's whole history, which is
 * what makes it cheap enough to run nightly — and what makes a single missing
 * session visible, instead of being one part in eight hundred of a ratio that
 * still rounds to 100%.
 */
async function reportCoverage(
  entry: DatabentoManifestEntry,
  manifest: DatabentoManifest,
  sessions: readonly string[],
  startMs: number,
  endMsExclusive: number,
): Promise<void> {
  if (!entry.load) return;
  const timeframe = entry.schema === "ohlcv-1h" ? "H1" : "M1";
  const counts = await countSessionsPerSymbol({
    timeframe,
    source: DATABENTO_SOURCE,
    startMs,
    endMs: endMsExclusive,
  });
  if (counts.size === 0) {
    log.error(
      `${entry.id}: ZERO sessions landed for ${sessions.join(",")}. That is ` +
        "not complete coverage of nothing — the load produced no rows.",
    );
    totals.errors++;
    return;
  }
  // THE ENTRY'S OWN SYMBOL SET is the denominator, not the aggregation — see
  // the same fix in the harvest. A symbol whose every bar was quarantined is
  // absent from `counts`, and reporting only what arrived can only ever say
  // 100%.
  const expected = await resolveSymbolSet({
    names: entry.symbolSets,
    manifest,
    resolveMaster: fetchMasterSymbols,
  });
  const reports: CoverageReport[] = [];
  for (const symbol of expected) {
    reports.push(
      coverageFromCount({
        symbol,
        present: counts.get(symbol) ?? 0,
        fromDateKey: sessions[0]!,
        toDateKey: sessions[sessions.length - 1]!,
      }),
    );
  }
  const worst = worstCoverage(reports, 10);
  log.info(
    `${entry.id} coverage: ${reports.length} symbol(s), ` +
      `${reports.filter((r) => r.missingCount > 0).length} short of ` +
      `${sessions.length} session(s)`,
  );
  for (const r of worst) {
    log.info(`  ${r.symbol}: ${r.present}/${r.expected}`);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Archive folders with no ledger row
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Report every `databento/…/{jobId}/` folder that no `databento_batch_jobs`
 * row names — MONEY-1540. READ-ONLY and REPORT-ONLY: it never writes a row and
 * never fails the run; whether to record an orphan is a human decision.
 *
 * Here because this is the Databento job that actually runs (twice daily,
 * prod). An orphan is spend the budget never summed and bytes no loader reads,
 * and the runbook's §9b re-buy recipe produces one by design — it deletes the
 * ledger row and keeps the bytes.
 *
 * Every OBJECT is listed, because the storage package exposes no delimiter
 * listing: 67,137 objects in 124 s measured from a laptop on 2026-09-23. So it
 * runs AFTER the purchases, where a slow listing cannot delay one.
 * `streamObjectSummaries` THROWS on a failed page, so "could not look" is
 * never reported as "none".
 */
async function reportArchiveOrphans(archiveReady: boolean): Promise<void> {
  if (!archiveReady) {
    log.info("archive orphan check: skipped — no archive bucket configured");
    return;
  }
  try {
    const objects: Array<{ name: string; size: number }> = [];
    for await (const o of streamObjectSummaries(DATABENTO_ARCHIVE_PREFIX)) {
      objects.push({ name: o.name, size: o.size });
    }
    const rows = await prisma.databentoBatchJob.findMany({
      select: { jobId: true },
    });
    const orphans = archiveJobsWithoutLedgerRow(
      objects,
      new Set(rows.flatMap((r) => (r.jobId === null ? [] : [r.jobId]))),
    );
    totals.archiveOrphans = orphans.length;
    for (const o of orphans) {
      log.warn(
        `ARCHIVE ORPHAN ${o.prefix} — ${o.objects} object(s), ${o.bytes} ` +
          `bytes, and no databento_batch_jobs row names job ${o.jobId}. ` +
          "The budget never counted it and no loader reads it.",
      );
    }
    log.info(
      `archive orphan check: ${objects.length} object(s) under ` +
        `${DATABENTO_ARCHIVE_PREFIX}, ${rows.length} ledger row(s), ` +
        `${orphans.length} job folder(s) with no ledger row`,
    );
  } catch (err) {
    log.warn(
      `archive orphan check could NOT run — ${errText(err)}. That is not ` +
        "the same as finding none.",
    );
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   The monthly cost model
   ──────────────────────────────────────────────────────────────────────── */

/** How much history one build samples. */
const COST_MODEL_TRAILING_DAYS = 365;

/**
 * Rebuild the transaction-cost model, if this is the run that should.
 *
 * MONTHLY, and the version bumps HERE and nowhere else. Rebuilding on every
 * append would give a backtest a different cost basis every night and make two
 * runs of one strategy incomparable — and a model built from one extra day of
 * quotes is not meaningfully better than yesterday's.
 *
 * A failure here does NOT fail the append. The bars are the product; the cost
 * model is derived from bytes already bought and archived, so it can be
 * rebuilt tomorrow at no vendor cost. Letting it take the run down would turn
 * a recoverable derived-data problem into a gap in the price series.
 */
async function maybeRebuildCostModel(apply: boolean, now: Date): Promise<void> {
  const forced = ARGS.has("rebuild-cost-model");
  const latest = await latestCostModelVersion();
  if (!shouldRebuildCostModel(now, latest, forced)) {
    log.info(
      `cost model: v${latest?.modelVersion} built ${latest?.builtAt.toISOString().slice(0, 10)} ` +
        "is current for this month — not rebuilding",
    );
    return;
  }

  const to = new Date(now.getTime());
  const from = new Date(to.getTime() - COST_MODEL_TRAILING_DAYS * 86_400_000);
  try {
    const result = await buildCostModel({
      from,
      to,
      trigger: forced ? "MANUAL" : "MONTHLY",
      apply,
      deps: {
        listBboFiles: listArchivedBboFiles,
        // ANCHORED AT THE ARCHIVE, not at `now`. `tbbo-top50` is
        // `append: false` — bought once inside the live Standard month and
        // never topped up — so a `now - 92d` window goes silently empty about
        // three months after the harvest, and every rebuild after that drops
        // `effectiveSpreadBps` from every row while still reporting READY.
        listTbboFiles: async () => {
          const window = tbboFoldWindow(await latestArchivedTbboEnd(ENV));
          if (window === null) return null;
          return {
            ...window,
            files: await listArchivedFilesBySchema(
              "tbbo",
              window.from,
              window.to,
              ENV,
            ),
          };
        },
        openArchive: async (key) => {
          const store = getDatabentoArchiveStore();
          return store === null ? null : store.getStream(key);
        },
        listingRows: fetchListingRows,
        listingLiquidity: listingDollarVolume,
        createVersion: createCostModelVersion,
        writeRows: writeCostModelRows,
        finishVersion: finishCostModelVersion,
        nextVersion: nextCostModelVersion,
        log: (...a) => log.info(...a),
      },
    });
    if (result.dryRun) {
      log.info(
        `cost model DRY RUN — would build v${(latest?.modelVersion ?? 0) + 1} over ` +
          `[${from.toISOString().slice(0, 10)}, ${to.toISOString().slice(0, 10)}) ` +
          `producing ${result.rowCount} row(s) over ${result.symbolCount} listing(s)`,
      );
    }
  } catch (err) {
    // Reported, not thrown. See the note above.
    log.error(`cost model rebuild failed: ${errText(err)}`);
    totals.errors++;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   main
   ──────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Every Cloud Run job does this;
  // without it the job logs to stdout only and its monitors sit in NO DATA.
  await initJobTelemetry();
  // FIRST. A Cloud Run JOB pins its image at SETUP time — deploying the
  // workers SERVICE does not move it — so this is the only runtime answer to
  // "is the running job the code I pushed?". `setup-databento-jobs.sh` is the
  // ONLY thing that re-pins it.
  reportBuildProvenance(log, "databento-append");

  // BEFORE anything else. Same reason as the harvest: without it the run
  // walks every appendable entry and reports a transport failure per entry for
  // one missing environment variable.
  // `--dry-run` is an explicit alias of the default, so it is INERT — and
  // combined with `--apply` it silently lost, which is a wrapper contract that
  // reads as "I asked for a dry run and it wrote". Fatal instead.
  if (ARGS.has("apply") && ARGS.has("dry-run")) {
    throw new Error(
      "--apply and --dry-run were both given. Refusing to guess: --dry-run is " +
        "the default, so pass neither for a dry run and only --apply to write.",
    );
  }

  databentoApiKey();

  if (FROM !== undefined && !ISO_DAY.test(FROM)) {
    throw new Error(`--from=${FROM} must be YYYY-MM-DD`);
  }

  const decision = resolveApply(APPLY_ASKED, isAppendArmed());
  if (decision.armMissing) {
    log.warn(
      'ARM MISSING — DATABENTO_APPEND_APPLY is not "true"; staying in ' +
        "dry-run. Arming is a DEPLOY, not a flag.",
    );
  }
  const apply = decision.apply;

  const manifest = parseManifest(manifestJson);

  const archiveReady = initDatabentoArchiveStore();
  const coldReady = initCandleColdStore();
  if (apply && !archiveReady) {
    throw new Error(
      "GCP_STORAGE_BUCKET is unset, so no Databento archive store could be " +
        "registered — refusing to --apply. The vendor's bytes are metered and " +
        "downloading them into nowhere spends the money and leaves nothing.",
    );
  }

  // Only the entries the manifest says the append keeps current. An entry with
  // `append: false` is a one-time buy; extending it nightly would spend on a
  // series nothing reads.
  const candidates = orderedEntries(manifest).filter(
    (e) => e.append && (ENTRIES.length === 0 || ENTRIES.includes(e.id)),
  );
  const unknown = ENTRIES.filter(
    (id) => !manifest.entries.some((e) => e.id === id),
  );
  if (unknown.length > 0) {
    throw new Error(
      `--entry=${unknown.join(",")} is not in the manifest. Appendable: ` +
        manifest.entries
          .filter((e) => e.append)
          .map((e) => e.id)
          .join(", "),
    );
  }

  const now = new Date();
  log.info(
    `env=${ENV} apply=${apply}${apply ? "" : " (DRY RUN)"} ` +
      `entries=${candidates.map((e) => e.id).join(",") || "(none appendable)"} ` +
      `archive=${archiveReady ? "on" : "OFF"} cold=${coldReady ? "on" : "OFF"} ` +
      `lastCompletedSession=${lastCompletedUsSession(now)}`,
  );

  for (const entry of candidates) {
    try {
      await appendEntry(entry, manifest, apply, now);
    } catch (err) {
      if (err instanceof DatabentoBudgetExceededError) throw err;
      totals.errors++;
      log.error(`${entry.id}: ${errText(err)}`);
    }
  }

  await maybeRebuildCostModel(apply, now);
  await reportArchiveOrphans(archiveReady);

  // ONE reason on the outcome, and only when the run PRODUCED NOTHING.
  // Reporting a skip beside real work would make a partially-skipped run look
  // like a fully-skipped one.
  //
  // The gate was `sessionsPlanned === 0`, and that made `POLL_TIMEOUT`
  // UNREACHABLE: it is set only after an entry has planned sessions and
  // submitted a job, so the one skip that means "the vendor is still working"
  // could never be reported. A run that submitted, waited out
  // `--max-wait-min` and wrote nothing therefore looked like a run that had
  // simply written nothing — with no reason attached, which is exactly the
  // reading the three named skips exist to prevent. `rowsWritten` is the
  // honest test: it still stays silent whenever real work landed.
  const skippedReason =
    totals.rowsWritten === 0 && skips.size > 0
      ? [...new Set(skips.values())].sort().join("+")
      : undefined;

  log.info(
    `entries=${totals.entriesConsidered} sessionsPlanned=${totals.sessionsPlanned} ` +
      `deferred=${totals.sessionsDeferred} submitted=${totals.chunksSubmitted} ` +
      `reused=${totals.chunksReused} quoteUsd=${totals.quoteUsd.toFixed(2)} ` +
      `files=${totals.filesDownloaded}/${totals.filesLoaded} ` +
      `rowsWritten=${totals.rowsWritten} displaced=${totals.sessionsDisplaced} ` +
      `quarantined=${totals.quarantinedRows} errors=${totals.errors} ` +
      `archiveOrphans=${totals.archiveOrphans < 0 ? "unchecked" : totals.archiveOrphans}` +
      (skippedReason ? ` skippedReason=${skippedReason}` : ""),
  );
  if (!apply)
    log.info("DRY RUN — pass --apply (bare flag) and arm the job to write.");

  // Names from `DATABENTO_METRICS`, never a literal. `sessionsDisplaced` was
  // spelled `databento.displaced_sessions` here and `sessions_displaced`
  // everywhere else — exactly the drift that module exists to stop, so it is
  // corrected to the constant rather than to a second hand-typed string.
  //
  // Every counter below is emitted BEFORE `flushMetrics()`: `datadog-metrics`
  // buffers, so one emitted after the flush is dropped silently.
  const tags = { job: "databento-append" };
  incrementCounter(
    DATABENTO_METRICS.sessionsAppended,
    totals.sessionsPlanned,
    tags,
  );
  incrementCounter(
    DATABENTO_METRICS.sessionsDisplaced,
    totals.sessionsDisplaced,
    tags,
  );
  incrementCounter(DATABENTO_METRICS.rowsDeleted, totals.rowsDeleted, tags);
  incrementCounter(
    DATABENTO_METRICS.quarantinedSymbols,
    totals.quarantinedSymbols,
    tags,
  );
  // MUST stay 0 — a tripwire rather than a metric. See databento-metrics.ts:
  // no manifest entry can name `ohlcv-1d`, so any non-zero value is a writer
  // path that reached the daily series.
  incrementCounter(DATABENTO_METRICS.displacedD1, totals.refusedD1, tags);
  // THE SPEND SERIES OUTLIVES THE HARVEST — MONEY-1373 T5.
  //
  // `spendUsd` was emitted only by `databento-harvest`, which RETIRES once the
  // history lands (it has no cron; a scheduled harvest would be a standing
  // authorisation to spend). The series would then stop, and a stopped gauge
  // renders as NO DATA — indistinguishable from a healthy month that spent
  // nothing, which is precisely the reading the budget monitor exists to make.
  // The append is the standing job, so the standing series is its.
  //
  // GAUGE, not a counter: a running monthly total is a LEVEL, and incrementing
  // it once per run would sum the same month over and over.
  const spent = await budgetDeps.sumMonthSpendUsd(monthWindowUtc(now));
  gauge(DATABENTO_METRICS.spendUsd, spent, tags);

  reportJobOutcome({
    job: "databento-append",
    selected: totals.sessionsPlanned,
    written: totals.rowsWritten,
    failed: totals.errors,
    transportFailures: totals.transportFailures,
    ...(skippedReason ? { skippedReason } : {}),
  });

  const verdict = judgeBackfillOutcome({
    stopped: false,
    attempted: totals.sessionsPlanned,
    succeeded: Math.max(0, totals.sessionsPlanned - totals.errors),
    failed: totals.errors,
  });
  if (verdict.exitCode !== 0) {
    log.warn(`FAILED RUN — ${verdict.reason}`);
    process.exitCode = verdict.exitCode;
  }

  // Awaited, before exit. `datadog-metrics` buffers, so a process that exits
  // without this drops every counter it just reported — silently, which renders
  // as NO DATA rather than as an alert.
  await flushMetrics();
}

main()
  .catch((err) => {
    console.error("[databento-append] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
