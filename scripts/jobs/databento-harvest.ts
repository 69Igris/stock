/**
 * The one-time Databento history harvest — MONEY-1373.
 *
 * Buys, downloads, verifies and loads the intraday history named by
 * `scripts/data/databento-manifest.json`, one manifest entry per execution.
 * Every step is resumable from the inventory (`databento_batch_jobs`), because
 * the unit of work is a 24-hour Cloud Run JOB task and the vendor's batch jobs
 * take hours to become downloadable.
 *
 * ## The shape, and why it is not one pass
 *
 * A batch purchase is asynchronous at the VENDOR. `batch.submit_job` returns
 * immediately; the files appear minutes-to-hours later and then expire 30 days
 * after SUBMISSION. So the run is a state machine over the inventory rather
 * than a pipeline:
 *
 *   quote -> submit -> poll -> download+verify -> load -> coverage
 *
 * and a killed task resumes at whichever state each row reached. `--step` runs
 * one stage in isolation, which is what makes the QA rehearsal possible:
 * `--step=quote` reaches the vendor's free `metadata.get_cost` and nothing
 * else.
 *
 * ## What must not happen, in order of how much it would cost
 *
 *   1. BUYING A WINDOW TWICE. Every submission goes through
 *      `withDatabentoBudget`, whose first act is an idempotent lookup on
 *      (purpose, entry, schema, symbolsHash, start, end) — now a database
 *      unique key as well. `databento-budget-wiring.test.ts` scans this file's
 *      source and fails if `submitBatchJob(` appears outside the guard.
 *   2. A BARE `--apply` WALKING THE WHOLE MANIFEST. The last entry is the
 *      TB-scale `ohlcv-1s` archive. `--apply` without `--entry=` exits 1 before
 *      any request, printing the entry ids — the same rule
 *      `run-market-data-job.sh` applies to `xbrl`, for the same reason.
 *   3. LETTING FILES EXPIRE. The only remedy past `tsExpiration` is to buy the
 *      range again, and by then the Standard subscription is likely cancelled.
 *      Rows within two days of it are reported at ERROR level with a counter.
 *   4. DOWNLOADING INTO NOWHERE. `--apply` without `GCP_STORAGE_BUCKET` is
 *      refused before the first request: metered bytes that land nowhere are
 *      spend with nothing to show, and the run would report success. The BSE
 *      job is the record of what that looks like (MONEY-1258).
 *
 * ## Usage
 *
 * ### Cloud Run Job — the primary form
 *
 *   gcloud run jobs execute databento-harvest-prod --region=asia-south1 \
 *     --args=--step=quote
 *   gcloud run jobs execute databento-harvest-prod --region=asia-south1 \
 *     --args=--apply,--entry=ohlcv-1m-baseline
 *
 * The EQUALS form survives gcloud's `--args` comma split. `--entry` is
 * repeatable and no value it takes contains a comma.
 *
 * ### Local (dry runs only)
 *
 *   node --import tsx scripts/jobs/databento-harvest.ts                 # quotes everything
 *   node --import tsx scripts/jobs/databento-harvest.ts --entry=ohlcv-1m-baseline
 *
 * DRY RUN IS THE DEFAULT, `--apply` is a BARE flag, and the ARM
 * (`DATABENTO_HARVEST_APPLY=true`) is a separate, deploy-time fact. `--apply`
 * without the arm continues AS A DRY RUN and says so — the operator still gets
 * the quote report, which is the useful half.
 */

// Explicit, and first: every credential this script needs (DATABENTO_API_KEY,
// DATABASE_URL, the GCS vars) comes from the environment, and `feed-parse.ts`
// shipped without this line and silently ran unauthenticated.
import "dotenv/config";

import prisma from "@usemoney/database";
import { recordSourceObject } from "@usemoney/lake/ledger";
import { judgeBackfillOutcome } from "@usemoney/core/ops/backfill-outcome";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { flushMetrics, gauge, incrementCounter } from "@usemoney/datadog/metrics";
import { DATABENTO_METRICS } from "@usemoney/core/market-data/databento/databento-metrics";

import {
  DATABENTO_MAX_SYMBOLS_PER_REQUEST,
  DATABENTO_SOURCE,
  LOADABLE_SCHEMAS,
  classifyFile,
  databentoArchiveKey,
  fileSessionDate,
  type DatabentoDatasetRange,
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
  listJobs,
  resolveDatabentoEnv,
  submitBatchJob,
} from "@usemoney/core/market-data/databento/databento-client";
import {
  DatabentoBudgetExceededError,
  formatBudgetLine,
  monthWindowUtc,
  reportQuoteDrift,
  withDatabentoBudget,
  type BudgetKey,
  type DatabentoJobRow,
} from "@usemoney/core/market-data/databento/databento-budget";
import {
  chunkSymbols,
  datasetForEntry,
  orderedEntries,
  orderedEntryIds,
  parseManifest,
  resolveEntryRange,
  resolveSymbolSet,
  symbolsHash,
  type DatabentoManifest,
  type DatabentoManifestEntry,
} from "@usemoney/core/market-data/databento/databento-manifest-logic";
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
  computeCoverage,
  coverageFromCount,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  isExpiringSoon,
  isHarvestArmed,
  mapWithConcurrency,
  memoisedListFiles,
  resolveApply,
  resolveShard,
  shardOwns,
  worstCoverage,
  type CoverageReport,
  type ShardSpec,
} from "@usemoney/core/market-data/databento/databento-harvest-logic";
import { getDatabentoArchiveStore } from "@usemoney/core/market-data/databento/databento-archive";
import { usMarketDateKey } from "@usemoney/core/market-data/us-market-hours";
import {
  countSessionsPerSymbol,
  createBudgetDeps,
  createSessionWriterDeps,
  fetchListingRows,
  fetchMasterSymbols,
  listSessionsForSymbol,
  advanceJobStateIfComplete,
  readFileRecords,
  replaceFileRecords,
  toLedgerSourceObjects,
  markLedgerBacked,
  readJobForLedger,
  stampFileLoaded,
  stampFileVerified,
  type DatabentoFileRecord,
} from "@usemoney/core/market-data/databento/databento-repo";

import { initCandleColdStore } from "../../workers/src/lib/candle-cold-store-gcs";
import { initDatabentoArchiveStore } from "../../workers/src/lib/databento-archive-gcs";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

/* ─────────────────────────────────────────────────────────────────────────
   CLI
   ──────────────────────────────────────────────────────────────────────── */

const STEPS = [
  "quote",
  "poll",
  "download",
  "load",
  "coverage",
  "all",
] as const;
type Step = (typeof STEPS)[number];

/**
 * Module scope, so a bad argument costs nothing: no database connection, no
 * vendor request, no money. The parser itself is shared
 * (`@usemoney/core/ops/cli-args`) rather than inlined — see that module's
 * header for why a fourth copy of the Tiingo region was refused.
 */
const ARGS = parseCliArgsOrExit(
  process.argv.slice(2),
  {
    bare: ["apply", "dry-run"],
    valued: [
      "entry",
      "step",
      "shard",
      "max-wait-min",
      "chunk",
      "download-concurrency",
    ],
    numeric: ["max-wait-min", "chunk", "download-concurrency"],
    repeatable: ["entry"],
  },
  "databento-harvest",
);

const APPLY_ASKED = ARGS.has("apply");
const ENTRIES = ARGS.all("entry");
const STEP = (ARGS.value("step") ?? "all") as Step;
const MAX_WAIT_MIN = ARGS.number("max-wait-min", 600);
/** One MASTER chunk, 0-based. Absent = every chunk. */
const ONLY_CHUNK = ARGS.value("chunk") === undefined ? null : ARGS.number("chunk", 0) - 1;
/**
 * Archive downloads in flight. Lower it if the vendor starts 429ing; there is
 * no reason to raise it, because the bound is the vendor and GCS rather than
 * anything on this side.
 */
const DOWNLOAD_CONCURRENCY = ARGS.number(
  "download-concurrency",
  DEFAULT_DOWNLOAD_CONCURRENCY,
);

const log = {
  info: (...a: unknown[]) => console.log("[databento-harvest]", ...a),
  warn: (...a: unknown[]) => console.warn("[databento-harvest]", ...a),
  error: (...a: unknown[]) => console.error("[databento-harvest]", ...a),
};

const POLL_INTERVAL_MS = 60_000;
/**
 * The environment this run stamps its ledger rows with — see
 * {@link resolveDatabentoEnv}. It reads `DATABENTO_ENV` first: the image bakes
 * `NODE_ENV=production` for BOTH environments, so deriving it from `NODE_ENV`
 * stamped every QA execution `env: "prod"`.
 */
const ENV = resolveDatabentoEnv();

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ─────────────────────────────────────────────────────────────────────────
   The per-file inventory
   ──────────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────────
   The database seam
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The `symbolSet` LABEL for the row being created.
 *
 * Handed to the ledger through a getter rather than a parameter because
 * `createQuotedJob`'s signature belongs to the budget guard, which has no
 * opinion about labels — the identity of a purchase is `symbolsHash`, and this
 * is only what an operator reads. Set immediately before each
 * `withDatabentoBudget` call.
 */
let currentSymbolSetLabel = "";

const budgetDeps = createBudgetDeps({
  env: ENV,
  symbolSetLabel: () => currentSymbolSetLabel,
});
const writerDeps = createSessionWriterDeps();

/* ─────────────────────────────────────────────────────────────────────────
   Counters
   ──────────────────────────────────────────────────────────────────────── */

const totals = {
  /**
   * Rows a sharded load refused. Counted SEPARATELY from `errors` because it
   * must reach the exit code on its own: `judgeBackfillOutcome` divides
   * failures by units ATTEMPTED, and a `--step=load` run that refuses every row
   * attempts nothing — so the judge takes its `attempted === 0` early return
   * and the execution reports SUCCESS having loaded nothing. `gcloud run jobs
   * execute --wait` then prints a green result for a run that did no work,
   * which is the exact shape this repo keeps paying for.
   */
  shardRefusals: 0,
  chunksConsidered: 0,
  chunksQuoted: 0,
  chunksSubmitted: 0,
  chunksReused: 0,
  quoteUsd: 0,
  jobsPolled: 0,
  jobsPending: 0,
  jobsExpiring: 0,
  filesConsidered: 0,
  filesDownloaded: 0,
  filesVerifyFailed: 0,
  filesLoaded: 0,
  rowsWritten: 0,
  rowsDeleted: 0,
  refusedD1: 0,
  quarantinedRows: 0,
  quarantinedSymbols: 0,
  coverageSymbols: 0,
  coverageIncomplete: 0,
  /** Files already in the archive, adopted without a metered fetch. */
  filesResumed: 0,
  /** Chunks whose quote or submission failed. A UNIT of `chunksConsidered`. */
  chunksFailed: 0,
  /** Files whose download or load failed. A UNIT of `filesConsidered`. */
  filesFailed: 0,
  /** Anything that went wrong, in any unit. For the log line, never a ratio. */
  errors: 0,
};

/**
 * The vendor's EXCLUSIVE available end, per schema, read ONCE per run.
 *
 * `null` until `main()` has fetched it. A `null` reaching `resolveEntryRange`
 * means "no clamp", which is only right on a dry run that never reaches the
 * vendor — so `main()` fetches it before any step, unconditionally.
 */
const vendorRanges = new Map<string, DatabentoDatasetRange>();

/**
 * The vendor's available end for one (dataset, schema), read ONCE per dataset.
 *
 * KEYED BY DATASET, not global. An entry may override the manifest's dataset
 * (`datasetForEntry`), and every dataset has its own range: EQUS.MINI begins
 * 2023-03-28 and EQUS.SUMMARY 2024-07-01. Clamping one dataset's window to
 * ANOTHER's end is how a request lands past the available end and is answered
 * 422 — the exact failure the clamp exists to prevent, reintroduced by sharing
 * one cache.
 *
 * `undefined` means "not fetched", which `resolveEntryRange` reads as "no
 * clamp". `main()` fetches every dataset the selected entries name before any
 * step runs, so that only happens on a path that never reaches the vendor.
 */
async function loadVendorRange(dataset: string): Promise<DatabentoDatasetRange> {
  const hit = vendorRanges.get(dataset);
  if (hit !== undefined) return hit;
  const range = await getDatasetRange(dataset);
  vendorRanges.set(dataset, range);
  return range;
}

function vendorRangeEndMs(dataset: string, schema: string): number | undefined {
  const range = vendorRanges.get(dataset);
  if (range === undefined) return undefined;
  const per = range.bySchema[schema];
  return (per ?? range).end.getTime();
}

/* ─────────────────────────────────────────────────────────────────────────
   Steps
   ──────────────────────────────────────────────────────────────────────── */

function wants(step: Step): boolean {
  return STEP === "all" || STEP === step;
}

/**
 * Quote every chunk, and submit the ones the budget allows.
 *
 * The dry-run product is the printed line per chunk — entry, chunk, quote,
 * spend so far, budget. That IS the QA acceptance, and it is what the runbook
 * reads to confirm the Standard subscription is live: an included window quotes
 * $0.00 and a metered one does not.
 */
async function stepQuote(
  entry: DatabentoManifestEntry,
  manifest: DatabentoManifest,
  apply: boolean,
  now: Date,
): Promise<void> {
  const symbols = await resolveSymbolSet({
    names: entry.symbolSets,
    manifest,
    resolveMaster: fetchMasterSymbols,
  });
  const range = resolveEntryRange(entry, {
    now,
    historyFloor: manifest.historyFloor,
    // CLAMPED to what the vendor has. The vendor's range end is at UTC
    // midnight and any `end` past it is a 422; our ET session end for the
    // newest session is 4-5 h later. `resolveEntryRange` already applied this
    // clamp when given the value — nothing passed it, so every window that
    // reached the latest session was rejected.
    datasetRangeEndMs: vendorRangeEndMs(
      datasetForEntry(entry, manifest),
      entry.schema,
    ),
  });
  const chunks = chunkSymbols(symbols, DATABENTO_MAX_SYMBOLS_PER_REQUEST);

  log.info(
    `${entry.id}: ${symbols.length} symbol(s) in ${chunks.length} chunk(s), ` +
      `${new Date(range.startMs).toISOString().slice(0, 10)}..` +
      `${new Date(range.endMsExclusive).toISOString().slice(0, 10)}`,
  );

  for (let i = 0; i < chunks.length; i++) {
    if (ONLY_CHUNK !== null && i !== ONLY_CHUNK) continue;
    const chunk = chunks[i]!;
    totals.chunksConsidered++;
    const request = {
      dataset: datasetForEntry(entry, manifest),
      schema: entry.schema,
      symbols: chunk,
      start: new Date(range.startMs),
      end: new Date(range.endMsExclusive),
      // THE SPLIT SHAPE, FROM THE MANIFEST. These two were absent, so
      // `buildSubmitJobForm` fell back to its defaults — `split_symbols:
      // false, split_duration: "day"` — and the manifest's `splitSymbols:
      // true, splitDuration: "year"` reached nothing. The vendor confirmed
      // what it received: `split_symbols false, split_duration "day"`.
      //
      // It is not a cosmetic mismatch. The whole loader is built around one
      // file being ONE SYMBOL-YEAR: `DEFAULT_MAX_BUFFERED_ROWS_PER_SYMBOL`
      // is 120,000 precisely because a symbol-year of M1 is 98,280 rows, so
      // the buffer flushes ONCE at end of stream and writes ONE cold shard.
      //
      // With daily files carrying every symbol, all 507 buffers flush per
      // file into shards that grow all year, so each write re-reads and
      // re-encodes a larger object than the last. MEASURED on the first real
      // harvest: 92 s for the first file, 358 s by file 124, rising ~2.1 s
      // per file — 439,569 shard writes for this entry against 2,028, and an
      // extrapolated 78 hours against a 24 h task timeout. `ohlcv-1h-master`
      // at 14,055 symbols would have been 12.2 MILLION shard writes.
      splitSymbols: entry.splitSymbols,
      splitDuration: entry.splitDuration,
    };
    currentSymbolSetLabel = `${entry.symbolSets.join("+")}:${i + 1}/${chunks.length}`;

    try {
      const outcome = await withDatabentoBudget(
        {
          purpose: "HARVEST",
          entryId: entry.id,
          schema: entry.schema,
          symbolsHash: symbolsHash(chunk),
          start: request.start,
          end: request.end,
          dataset: request.dataset,
          symbolCount: chunk.length,
          request,
          apply,
        },
        budgetDeps,
        () => getCost(request),
        () => submitBatchJob(request),
      );

      log.info(formatBudgetLine({ entryId: currentSymbolSetLabel, outcome }));
      if (outcome.status === "dry-run") {
        totals.chunksQuoted++;
        totals.quoteUsd += outcome.quoteUsd;
      } else if (outcome.status === "submitted") {
        totals.chunksSubmitted++;
        totals.quoteUsd += outcome.quoteUsd;
        // The vendor's own number, once it exists, against what we were
        // quoted. Silence here would let a repriced window pass unremarked.
        const drift = reportQuoteDrift({
          entryId: `${entry.id} ${currentSymbolSetLabel}`,
          jobId: outcome.job.id,
          quotedUsd: outcome.quoteUsd,
          actualUsd: outcome.job.costUsd,
        });
        if (drift) log.warn(drift);
      } else {
        totals.chunksReused++;
      }
    } catch (err) {
      if (err instanceof DatabentoBudgetExceededError) {
        // The budget REFUSES rather than trimming, so this ends the entry
        // instead of quietly buying a narrower window nobody asked for.
        log.error(err.message);
        totals.chunksFailed++;
        totals.errors++;
        throw err;
      }
      totals.chunksFailed++;
      totals.errors++;
      log.error(`${entry.id} chunk ${i + 1}: ${errText(err)}`);
    }
  }
}

/**
 * The entry ids every step after `quote` must restrict itself to.
 *
 * WITHOUT THIS the scope guard is one step deep. `--apply` refuses a bare run
 * because the manifest's last entry is the TB-scale 1s archive — but only
 * `stepQuote` iterated the selected entries. Poll, download, load and expiry
 * all queried `{purpose: "HARVEST", state: ...}` with no `entryId`, so an
 * operator running `--apply --entry=ohlcv-1m-baseline` and expecting a small
 * job would have `stepDownload` pick up a previously-submitted 1s row sitting
 * in DONE and start pulling terabytes into the same 24-hour task.
 *
 * `undefined` means "every entry", which is what a dry run over the whole
 * manifest wants.
 */
let selectedEntryIds: string[] | undefined;

/** `{ entryId: { in: [...] } }`, or `{}` when nothing was named. */
function entryScope(): { entryId?: { in: string[] } } {
  return selectedEntryIds === undefined
    ? {}
    : { entryId: { in: selectedEntryIds } };
}

/**
 * Watch the states of the jobs we own until they settle or the clock runs out.
 *
 * `list_jobs` is summary-only since the vendor's 2026-08 change, so this polls
 * cheaply there (one call for every job) and spends a `get_job_details` only on
 * the jobs whose state MOVED. Reaching `--max-wait-min` is NOT a failure — the
 * rows keep their state and the next execution resumes from them.
 */
async function stepPoll(now: Date): Promise<void> {
  const deadline = now.getTime() + MAX_WAIT_MIN * 60_000;
  // 31 days: one past the 30-day expiry, so a job that expired while we were
  // not looking is still visible in the listing rather than silently absent.
  const since = new Date(now.getTime() - 31 * 86_400_000);

  for (;;) {
    const pending = await prisma.databentoBatchJob.findMany({
      where: {
        purpose: "HARVEST",
        state: { in: ["SUBMITTED", "PROCESSING"] },
        ...entryScope(),
      },
      select: { id: true, jobId: true, state: true },
    });
    if (pending.length === 0) {
      log.info("poll: nothing pending");
      return;
    }

    const owned = new Map(
      pending.filter((r) => r.jobId !== null).map((r) => [r.jobId!, r]),
    );
    const summaries = await listJobs({
      // `received` IS a vendor state and `mapVendorState` already knows it.
      // Omitting it here made a job the vendor had accepted but not yet queued
      // invisible to every summary — so `stepPoll` never saw it, never
      // advanced it, and burned the full `--max-wait-min` waiting for a job it
      // was not asking about.
      states: ["received", "queued", "processing", "done", "expired"],
      since,
    });

    // COUNT DEPARTURES, NOT TRANSITIONS. This counted every state CHANGE as a
    // job leaving the pending set, and `SUBMITTED -> PROCESSING` is a change
    // that stays pending. On the very first poll after a submit — every job
    // `SUBMITTED` here and `processing` at the vendor — that made
    // `moved === pending.length`, so `stillPending` hit 0 and the loop
    // returned immediately. `--max-wait-min` was never reached, nothing
    // reached `DONE`, `stepDownload` found no rows, and the run exited 0
    // having spent the money and fetched nothing.
    let moved = 0;
    let departed = 0;
    for (const summary of summaries) {
      const row = owned.get(summary.id);
      if (row === undefined) continue;
      const next = mapVendorState(summary.state);
      if (next !== row.state) {
        moved++;
        totals.jobsPolled++;
        await recordJobDetails(row.id, summary.id, next);
      }
      if (next !== "SUBMITTED" && next !== "PROCESSING") departed++;
    }

    const stillPending = pending.length - departed;
    log.info(
      `poll: ${pending.length} pending, ${moved} state change(s), ` +
        `${departed} settled, ${stillPending} waiting`,
    );
    if (stillPending <= 0) return;
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      totals.jobsPending = stillPending;
      log.info(
        `PENDING ${stillPending} job(s) — reached --max-wait-min=${MAX_WAIT_MIN}. ` +
          "Not a failure: the inventory keeps the state and the next execution " +
          "resumes from it.",
      );
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** The vendor's state vocabulary onto ours. */
function mapVendorState(state: string): string {
  switch (state) {
    case "done":
      return "DONE";
    case "expired":
      return "EXPIRED";
    case "processing":
      return "PROCESSING";
    case "queued":
    case "received":
      return "SUBMITTED";
    default:
      // A state the vendor added since this was written. Mapping it silently to
      // PROCESSING makes the row poll forever: `cancelled` is not going to
      // become `done`, and nothing else in this job can tell the difference
      // between "still working" and "will never finish".
      log.warn(
        `unknown vendor job state ${JSON.stringify(state)} — treating it as ` +
          "PROCESSING, which will POLL UNTIL --max-wait-min. If this is a " +
          "terminal state (e.g. cancelled), map it in mapVendorState.",
      );
      return "PROCESSING";
  }
}

/** Pull the full record and store the numbers the summary does not carry. */
async function recordJobDetails(
  rowId: string,
  jobId: string,
  state: string,
): Promise<void> {
  const details = await getJobDetails(jobId);
  await prisma.databentoBatchJob.update({
    where: { id: rowId },
    data: {
      state,
      costUsd: details.costUsd,
      recordCount:
        details.recordCount === null ? null : BigInt(details.recordCount),
      billedSize: details.billedSize === null ? null : BigInt(details.billedSize),
      tsExpiration: details.tsExpiration ? new Date(details.tsExpiration) : null,
    },
  });
  if (state === "EXPIRED") {
    log.error(
      `job ${jobId} is EXPIRED. Its files are gone from the vendor and the ` +
        "only remedy is to buy the range again — do not re-run this entry " +
        "without a deliberate decision to spend.",
    );
    totals.errors++;
  }
}

/**
 * Fetch and checksum every file of every `DONE` row.
 *
 * NEVER SHARDED, and it took a re-read to see why the first version was wrong.
 * It ran on the LEADER only and then filtered the file list by shard — so on a
 * four-task execution one task downloaded one quarter of the files and the
 * other three quarters were never fetched at all, while the run reported
 * success. Downloading is a whole-JOB operation; only the LOAD has a
 * partitionable unit.
 *
 * A checksum mismatch marks that FILE unverified with the detail and leaves the
 * ROW in `DONE`, so the next execution retries exactly the file that failed
 * rather than the job. `downloadToArchive` deletes the bad object before it
 * throws, so a half-written archive object never survives to be loaded.
 */
async function stepDownload(): Promise<void> {
  const store = getDatabentoArchiveStore();
  if (store === null) {
    throw new Error(
      "No Databento archive store is registered, so downloads would land " +
        "nowhere while still spending the vendor's bytes. Set " +
        "GCP_STORAGE_BUCKET.",
    );
  }

  const rows = await prisma.databentoBatchJob.findMany({
    where: { purpose: "HARVEST", state: "DONE", ...entryScope() },
    select: {
      id: true,
      jobId: true,
      dataset: true,
      schema: true,
      start: true,
      files: true,
    },
  });

  for (const row of rows) {
    if (row.jobId === null) continue;
    // BOUND to a const. The pool below is a closure, and TypeScript discards a
    // property narrowing across one — `row.jobId` reverts to `string | null`
    // inside the task however the loop guarded it out here.
    const jobId = row.jobId;
    let records = readFileRecords(row.files);
    if (records.length === 0) {
      // FIRST SIGHT of this job: persist the inventory once, before the loop,
      // so the per-file stamps below have rows to hit. This is the ONLY
      // whole-array replace left in this step.
      //
      // Through the SAME cache the per-file lookups use, so the listing is
      // fetched once per job rather than once here and again on the first
      // `findVendorFile` miss.
      records = (await memoisedListFiles(fileCache, jobId, listFiles)).map(
        (f) => toRecord(f, row),
      );
      await replaceFileRecords(row.id, records);
    }

    let changed = false;
    // BOUNDED-CONCURRENCY, not serial.
    //
    // A download is ~1.5 s of WAITING — the vendor, then GCS — and the process
    // is idle for all of it. Serially that is 23.4 h for `ohlcv-1h-master`,
    // which does not fit inside this job's own 24 h task cap: the step could
    // not finish however long it was left alone.
    //
    // Nothing here contends. Every file is a DISTINCT GCS object and every
    // stamp is a positional `files.$` update, so two slots never touch one
    // document field. `totals` is incremented between awaits on one thread, so
    // `++` is atomic with respect to the event loop. The vendor's own 429s stay
    // handled by the client's retry ladder, which at 8 in flight is a safety
    // net rather than the pacing mechanism.
    //
    // Per-file failures are caught INSIDE the task. `mapWithConcurrency` does
    // not catch, and one unreadable file must not abandon the other 56,219.
    await mapWithConcurrency(records, DOWNLOAD_CONCURRENCY, async (record) => {
      totals.filesConsidered++;
      if (record.verified) return;

      // A file already in the archive is not re-fetched from a METERED vendor.
      //
      // ONLY when the record carries NO `detail`. `downloadToArchive` writes to
      // GCS BEFORE it digests, and on a checksum mismatch its cleanup delete is
      // `.catch(() => {})` — so a CORRUPT object can outlive the failure that
      // produced it, with the record stamped `verified: false` and a detail
      // naming the mismatch. Taking the shortcut on that record would promote a
      // file that failed its checksum to `verified`, load it into `candles`,
      // and turn a loud DatabentoChecksumError into silence. Restricting it to
      // a detail-free record keeps the case this exists for — a run killed
      // between the successful write and the stamp — and refuses the one that
      // costs data.
      if (record.detail === undefined && (await store.exists(record.archiveKey))) {
        await stampFileVerified({
          rowId: row.id,
          filename: record.filename,
          verified: true,
        });
        // NOT `filesDownloaded`: nothing was fetched and nothing was billed.
        totals.filesResumed++;
        changed = true;
        return;
      }

      const file = await findVendorFile(jobId, record.filename);
      if (file === null) {
        await stampFileVerified({
          rowId: row.id,
          filename: record.filename,
          verified: false,
          detail: "not present in batch.list_files",
        });
        totals.filesVerifyFailed++;
        changed = true;
        return;
      }
      try {
        const { bytes } = await downloadToArchive({
          file,
          key: record.archiveKey,
          store,
        });
        // STAMPED PER FILE, not once per row at the end.
        //
        // `ohlcv-1s-baseline` is ~850 daily files. The whole-array replace that
        // used to sit after this loop persisted NOTHING until every file in the
        // row was done, so a task killed at file 800 — a redeploy, a task
        // timeout, an OOM — re-downloaded all 800 from a metered vendor on the
        // next run. This is a positional `files.$` update, so two tasks
        // stamping different files of one row do not overwrite each other.
        await stampFileVerified({
          rowId: row.id,
          filename: record.filename,
          verified: true,
          size: bytes,
        });
        totals.filesDownloaded++;
      } catch (err) {
        const detail = errText(err).slice(0, 500);
        await stampFileVerified({
          rowId: row.id,
          filename: record.filename,
          verified: false,
          detail,
        });
        totals.filesVerifyFailed++;
        totals.filesFailed++;
        totals.errors++;
        log.error(`download ${record.filename}: ${detail}`);
      }
      changed = true;
    });

    if (changed) {
      await advanceJobStateIfComplete({ rowId: row.id, requireLoaded: false });
    }

    // MONEY-1472 (B1) — mirror into `lake_bronze.source_object`, AFTER the
    // download pass rather than on first sight.
    //
    // `toRecord` stamps `verified: false`, and verification happens in the loop
    // above — so mirroring before it would write every row `PRESENT` with
    // nothing to ever re-write it, making `VERIFIED` structurally unreachable
    // in a table clustered on `state`. Running here means the records carry
    // their real verification, and a job already holding files (i.e. all of
    // prod) is mirrored too rather than skipped.
    //
    // Re-reading the records: the loop stamped them in Mongo, not in `records`.
    const fresh = await readJobForLedger(row.id);
    // GUARDED. This ran on EVERY pass for every `state: "DONE"` row, and
    // `ledgerBacked` was written here but never read — so a re-run of
    // `--entry=ohlcv-1h-master` re-MERGEd all 42,084 of its files. A row leaves
    // DONE only when every file verifies, so ONE permanently-unfetchable file
    // ("not present in batch.list_files") pins its row in DONE and re-mirrors
    // the whole inventory for ever. `LEDGER_CONCURRENCY` does not rescue that:
    // these are DML statements against ONE table, which BigQuery runs ~2 at a
    // time and queues, and the surrounding try/catch swallows the resulting
    // quotaExceeded — so `markLedgerBacked` is skipped and the next pass
    // repeats it.
    if (fresh && (changed || !fresh.ledgerBacked)) {
      await mirrorToLedger(fresh, fresh.records);
    }

    // `files` is still written above and stays until B5 finishes. Two writers
    // for one fact is a transition with an end date, not a design.
  }
}

function toRecord(
  file: DatabentoFile,
  row: { jobId: string | null; dataset: string; schema: string; start: Date },
): DatabentoFileRecord {
  return {
    filename: file.filename,
    size: file.size,
    sha256: file.sha256,
    kind: classifyFile(file.filename),
    verified: false,
    archiveKey: databentoArchiveKey({
      dataset: row.dataset,
      schema: row.schema,
      year: row.start.getUTCFullYear(),
      jobId: row.jobId ?? "unknown",
      filename: file.filename,
    }),
  };
}

/**
 * PROMISES, not resolved arrays — see `memoisedListFiles`.
 *
 * Keyed by vendor job id and never evicted on success: one job's listing is
 * ~56,220 filenames for `ohlcv-1h-master` and the step walks exactly one row
 * at a time, so the map holds one entry for the duration of that row.
 */
const fileCache = new Map<string, Promise<DatabentoFile[]>>();

async function findVendorFile(
  jobId: string,
  filename: string,
): Promise<DatabentoFile | null> {
  const files = await memoisedListFiles(fileCache, jobId, listFiles);
  return files.find((f) => f.filename === filename) ?? null;
}

/**
 * Stream every downloaded DATA file into `candles`.
 *
 * One file in flight per task. The loader's per-symbol buffer is what bounds
 * the heap (`databento-loader-memory.spawntest.ts` measures it), and the writer
 * is AWAITED so a slow database applies back-pressure to the read rather than
 * letting rows pile up in memory.
 */
async function stepLoad(shard: ShardSpec | null): Promise<void> {
  const store = getDatabentoArchiveStore();
  if (store === null) throw new Error("No Databento archive store registered");

  const rows = await prisma.databentoBatchJob.findMany({
    where: {
      purpose: "HARVEST",
      state: { in: ["DOWNLOADED", "DONE"] },
      ...entryScope(),
    },
    select: {
      id: true,
      jobId: true,
      schema: true,
      entryId: true,
      files: true,
      splitSymbols: true,
    },
  });

  for (const row of rows) {
    if (!LOADABLE_SCHEMAS.includes(row.schema as never)) {
      log.info(
        `${row.entryId}: schema ${row.schema} is archive-only — not loaded ` +
          "into candles by design.",
      );
      continue;
    }

    // A SHARDED LOAD REQUIRES SYMBOL-SPLIT FILES, and the shape must come
    // from the ROW rather than the manifest.
    //
    // `shardOwns` hashes the FILENAME. That partitions the files, which is the
    // same thing as partitioning the WRITES only when one file maps to one cold
    // shard — i.e. when the vendor split the job by symbol. Under a day-split
    // job every file carries every symbol, so `equs-mini-20240102…` and
    // `equs-mini-20240103…` hash to different tasks and BOTH rewrite
    // `candles/US/M1/AAPL/2024`. The cold write is read-merge-write with no
    // generation precondition, so that is a lost update: two tasks succeed, one
    // task's rows survive, and nothing anywhere reports a number that is wrong.
    //
    // THIS CHECK READ THE MANIFEST AND WAS THEREFORE A FALSE BACKSTOP. The
    // manifest says what the entry would be bought as TODAY; the row says what
    // it WAS bought as. The first harvest was bought day-split and the manifest
    // was then corrected to `splitSymbols: true` — so the manifest-based check
    // answered "symbol-split" about the one job in existence that is not, and
    // waved through exactly the run it was written to refuse.
    //
    // `null` is every row predating the column, and refusing on null is the
    // safe reading: an unknown shape is unproven, and the unproven rows are the
    // legacy ones. Such an entry still loads correctly UNSHARDED, just slower.
    if (shard !== null && row.splitSymbols !== true) {
      log.error(
        `${row.entryId}: REFUSING a sharded load (shard ` +
          `${shard.index + 1}/${shard.count}). This job was bought with ` +
          `splitSymbols=${String(row.splitSymbols)}, so its files are not one ` +
          "per symbol and two tasks would write the same cold shard — one " +
          "task's rows would be silently lost. Re-run with --step=load and no " +
          "--shard/--tasks, or re-buy it split by symbol (runbook §9b).",
      );
      totals.errors++;
      totals.shardRefusals++;
      continue;
    }

    const records = readFileRecords(row.files);
    const pending = records
      .filter(
        (r) =>
          r.kind === "data" &&
          r.verified &&
          r.loadedAt === undefined &&
          shardOwns(r.filename, shard),
      )
      // NEWEST FIRST. A harvest is a backfill of years, and it can be
      // interrupted — by the 24 h task cap, an operator, a redeploy. Oldest
      // first leaves the survivor holding 2023 and still missing the sessions
      // every backtest and every product surface actually reads; newest first
      // leaves it holding the recent end, which is the half worth having.
      //
      // `fileSessionDate` reads the session off the vendor's own filename
      // (`equs-mini-20240102.ohlcv-1m.csv.zst`). A name it cannot parse sorts
      // LAST rather than throwing — an undated file is a single-file,
      // unsplit job, and there is no "newest" to speak of.
      .sort((a, b) =>
        (fileSessionDate(b.filename) ?? "").localeCompare(
          fileSessionDate(a.filename) ?? "",
        ),
      );
    if (pending.length === 0) continue;

    const listings = await loadListingIndex();
    const quarantine = new QuarantineLedger();

    for (const record of pending) {
      // COUNTED HERE TOO, not only in `stepDownload`. `judgeBackfillOutcome`
      // divides `filesFailed` by `filesConsidered`, and a `--step=load` run
      // never touches the download step — so the denominator was 0, the judge
      // took its `attempted === 0` early return, and a shard in which EVERY
      // file failed exited 0 reporting a healthy run. That is the only legal
      // sharded invocation, so it is the path most likely to be run this way.
      totals.filesConsidered++;
      const stream = await store.getStream(record.archiveKey);
      if (stream === null) {
        // PERSISTED, not just mutated in memory. Since the load stopped
        // writing the whole `files` array back (the sharding race), an
        // in-memory mutation here would be discarded — and the file would be
        // re-attempted every night against an archive object that is not
        // there, forever, with the reason recorded nowhere.
        const detail = "archive object absent at load time";
        await stampFileVerified({
          rowId: row.id,
          filename: record.filename,
          verified: false,
          detail,
        });
        totals.filesFailed++;
        totals.errors++;
        log.error(`load ${record.filename}: ${detail}`);
        continue;
      }
      const counters = emptySessionWriteCounters();
      const loaded = await loadOhlcvStream({
        stream,
        schema: row.schema as DatabentoSchema,
        listings,
        quarantine,
        writer: (batch) => writeSymbolBatch(batch, writerDeps, counters),
      });
      // A FILE WITH FAILED WRITES IS NOT LOADED.
      //
      // `putCandles` does not throw on a per-row failure — `insertNew` catches
      // into `result.failed` — so `writeHotSession` counted it and returned
      // normally. The stamp below was unconditional, the loop guard is
      // `loadedAt !== undefined`, and the row then flipped to LOADED, which is
      // what `readHighWaterMark` reads. So a session whose weaker rows were
      // DELETED and whose replacements never landed was recorded as done, the
      // mark advanced past it, and the next run reported UP_TO_DATE over an
      // empty session. The header's claim that the gap is "healed by the next
      // idempotent run" was false.
      if (counters.failed > 0) {
        totals.errors += counters.failed;
        await stampFileVerified({
          rowId: row.id,
          filename: record.filename,
          verified: false,
          detail: `${counters.failed} row write(s) failed during load`,
        });
        log.error(
          `${record.filename}: ${counters.failed} row write(s) FAILED — not ` +
            "stamping it loaded. The session may now hold fewer bars than " +
            "before, because the displacement deleted first. Re-run " +
            "--step=load for this entry.",
        );
        continue;
      }

      // ATOMIC, per file. Every shard reads the same `files` array, so a
      // whole-array write-back would be last-writer-wins and three quarters of
      // a four-task load would vanish while every task reported success.
      const stamped = await stampFileLoaded({
        rowId: row.id,
        filename: record.filename,
        loadedRows: counters.rowsWritten,
        loadedAt: new Date(),
      });
      if (stamped === 0) {
        log.warn(
          `${record.filename} was loaded but no inventory row matched it — ` +
            "the file list and the archive disagree.",
        );
      }
      totals.filesLoaded++;
      totals.rowsWritten += counters.rowsWritten;
      totals.rowsDeleted += counters.rowsDeleted;
      totals.refusedD1 += counters.refusedD1;
      if (counters.refusedD1 > 0) {
        // MUST stay 0. A non-zero value means an intraday writer reached the
        // daily series, which is the one displacement that is never allowed.
        log.error(
          `${record.filename}: refusedD1=${counters.refusedD1} — a writer ` +
            "attempted to displace a DAILY session.",
        );
        totals.errors += counters.refusedD1;
      }
      log.info(
        `loaded ${record.filename}: rows=${loaded.rowsMapped} ` +
          `written=${counters.rowsWritten} displaced=${counters.sessionsDisplaced} ` +
          `refused=${counters.sessionsRefused} cold=${counters.coldShardsWritten}`,
      );
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
            .map(
              (s) => `${s.symbol}(${s.reason},${s.rows},${s.firstDate}..${s.lastDate})`,
            )
            .join(" "),
      );
    }

    // RE-READS, rather than trusting what this task stamped. Under sharding no
    // single task knows whether the others have finished, so each one checks
    // after its own last file and whichever finds the set complete performs the
    // transition. Idempotent, so two tasks finding it complete is harmless.
    const advanced = await advanceJobStateIfComplete({
      rowId: row.id,
      requireLoaded: true,
    });
    if (advanced !== null) log.info(`${row.entryId}: job ${row.jobId} -> ${advanced}`);
  }
}

let listingIndexCache: Map<string, ListingRow[]> | null = null;

async function loadListingIndex(): Promise<Map<string, ListingRow[]>> {
  if (listingIndexCache !== null) return listingIndexCache;
  const rows = await fetchListingRows();
  listingIndexCache = buildListingIndex(rows);
  log.info(`listing index: ${rows.length} row(s), ${listingIndexCache.size} symbol(s)`);
  return listingIndexCache;
}

/**
 * What landed, against what the US calendar says should have.
 *
 * TWO PASSES, and the split is a size constraint rather than an optimisation.
 * Pass one counts DISTINCT ET sessions per symbol server-side; pass two
 * enumerates the actual gaps for the worst offenders only. Collecting date
 * arrays for every symbol in one aggregation is ~90 MB at MASTER scale through
 * a 16 MB BSON ceiling — it would not fail cleanly, it would fail at whichever
 * symbol crossed the line.
 */
async function stepCoverage(
  entry: DatabentoManifestEntry,
  manifest: DatabentoManifest,
  now: Date,
): Promise<void> {
  const range = resolveEntryRange(entry, {
    now,
    historyFloor: manifest.historyFloor,
    // CLAMPED to what the vendor has. The vendor's range end is at UTC
    // midnight and any `end` past it is a 422; our ET session end for the
    // newest session is 4-5 h later. `resolveEntryRange` already applied this
    // clamp when given the value — nothing passed it, so every window that
    // reached the latest session was rejected.
    datasetRangeEndMs: vendorRangeEndMs(
      datasetForEntry(entry, manifest),
      entry.schema,
    ),
  });
  const fromKey = new Date(range.startMs).toISOString().slice(0, 10);
  // THE ET SESSION, not a UTC slice of the exclusive bound. `endMsExclusive`
  // is 00:00 ET of D+1; one millisecond back is 23:59:59.999 ET of D, whose
  // UTC date is already D+1. So this reported one session MORE than was ever
  // bought, and `coverageIncomplete` came out at 100% of symbols on every
  // weekday-to-weekday boundary. `fromKey` derives from `startMs`, which is
  // 00:00 ET and slices correctly, so the error was one-sided and looked like
  // a real gap.
  const toKey = usMarketDateKey(new Date(range.endMsExclusive - 1));
  const timeframe = entry.schema === "ohlcv-1h" ? "H1" : "M1";

  const counts = await countSessionsPerSymbol({
    timeframe,
    source: DATABENTO_SOURCE,
    startMs: range.startMs,
    endMs: range.endMsExclusive,
  });
  if (counts.size === 0) {
    log.warn(
      `${entry.id}: coverage found ZERO loaded sessions in ` +
        `${fromKey}..${toKey}. That is not 100% coverage of nothing — it is ` +
        "either an unloaded entry or a wrong timeframe.",
    );
    return;
  }

  // THE SYMBOL DENOMINATOR IS THE ENTRY'S OWN SYMBOL SET, not the aggregation.
  //
  // `countSessionsPerSymbol` is a `$group` over `candles`, so it holds only
  // symbols that produced rows. A symbol whose every bar was quarantined is
  // not 0%-covered in that map — it is ABSENT, and the report's denominator
  // shrank to match its numerator. 2,000 symbols bought and 1,995 quarantined
  // rendered as "5 symbol(s), 0 short", with `totals.errors` at 0 and exit 0.
  //
  // This is the same MONEY-1189 class the SESSION axis was already fixed for
  // (the calendar supplies that denominator). The symbol axis was left on the
  // arrived data, in the file whose comment names the ticket.
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
        fromDateKey: fromKey,
        toDateKey: toKey,
      }),
    );
  }
  const absent = expected.filter((sym) => !counts.has(sym)).length;
  if (absent > 0) {
    log.warn(
      `${entry.id}: ${absent} of ${expected.length} symbol(s) produced NO ` +
        "rows at all. They are counted as 0% covered rather than omitted — " +
        "an absent symbol is not a complete one.",
    );
  }
  totals.coverageSymbols += reports.length;

  const worst = worstCoverage(reports, 10);
  totals.coverageIncomplete += reports.filter((r) => r.missingCount > 0).length;

  // Pass two: name the gaps, but only for the ten symbols an operator will
  // actually look at.
  const named: CoverageReport[] = [];
  for (const report of worst) {
    const sessions = await listSessionsForSymbol({
      symbol: report.symbol,
      timeframe,
      source: DATABENTO_SOURCE,
      startMs: range.startMs,
      endMs: range.endMsExclusive,
    });
    named.push(
      computeCoverage({
        symbol: report.symbol,
        sessionsPresent: sessions,
        fromDateKey: fromKey,
        toDateKey: toKey,
      }),
    );
  }

  log.info(
    `${entry.id} coverage ${fromKey}..${toKey} tf=${timeframe}: ` +
      `${reports.length} symbol(s), ${totals.coverageIncomplete} incomplete`,
  );
  for (const r of named) {
    log.info(
      `  ${r.symbol}: ${r.present}/${r.expected} ` +
        `(${r.ratio === null ? "n/a" : (r.ratio * 100).toFixed(1) + "%"}) ` +
        `missing ${r.missingCount}: ${(r.missing ?? []).slice(0, 6).join(",")}` +
        ((r.missing?.length ?? 0) > 6 ? ", …" : ""),
    );
  }
}


/**
 * Files that will stop existing before we have them.
 *
 * ERROR level and a counter, not a warning. Past `tsExpiration` the bytes are
 * gone from the vendor and the only remedy is to buy the range again — after
 * the Standard subscription lapses, at usage prices.
 */
async function stepExpiry(now: Date): Promise<void> {
  const rows = await prisma.databentoBatchJob.findMany({
    where: {
      purpose: "HARVEST",
      state: { in: ["SUBMITTED", "PROCESSING", "DONE"] },
      tsExpiration: { not: null },
      ...entryScope(),
    },
    select: { jobId: true, entryId: true, tsExpiration: true, files: true },
  });
  for (const row of rows) {
    const records = readFileRecords(row.files);
    const complete = records.length > 0 && records.every((r) => r.verified);
    if (complete) continue;
    if (!isExpiringSoon(row.tsExpiration, now)) continue;
    totals.jobsExpiring++;
    log.error(
      `EXPIRING ${row.entryId} job ${row.jobId ?? "(unsubmitted)"} at ` +
        `${row.tsExpiration?.toISOString()} with ` +
        `${records.filter((r) => !r.verified).length} file(s) still unverified. ` +
        "Past that instant the only remedy is to buy the range again.",
    );
  }
  incrementCounter(DATABENTO_METRICS.expiringJobs, totals.jobsExpiring, {
    job: "databento-harvest",
  });
}

/**
 * Write a job's file inventory to the lake ledger. Never throws.
 *
 * ## IT RUNS ON EVERY PASS, NOT ONLY FIRST SIGHT
 *
 * The first cut sat inside `if (records.length === 0)`, which made it
 * unreachable twice over. `toRecord` stamps `verified: false` at that moment —
 * verification happens later, in the download loop — so every ledger row would
 * have been written `PRESENT` and NOTHING would ever have re-written it:
 * `VERIFIED` was structurally unreachable, in a table clustered on `state`.
 * And every job row that already had files, which is all of prod, never
 * entered the branch at all.
 *
 * ## IT BATCHES
 *
 * One `recordSourceObject` per file is one BigQuery query job per file.
 * `ohlcv-1h-master` alone is 42,084 files; serial MERGEs at ~1-3 s each is
 * 12-35 h of blocking work in front of a download step already sized at ~2.9 h,
 * inside a 24 h task cap. Bounded concurrency is the same lever the download
 * loop below already uses, for the same reason.
 */
async function mirrorToLedger(
  row: { id: string; jobId: string | null; dataset: string; costUsd?: number | null },
  records: readonly Parameters<typeof toLedgerSourceObjects>[1][number][],
): Promise<void> {
  if (records.length === 0) return;
  // REFUSED rather than defaulted. A ternary on LAKE_ENV silently resolves a
  // prod run to `qa`; `lakeConfig()` in the client throws for the same reason.
  const env = process.env.LAKE_ENV;
  if (env !== "qa" && env !== "prod") {
    console.error(
      `[databento] ledger mirror SKIPPED: LAKE_ENV is "${String(env)}" — ` +
        "set it on the job (scripts/ops/setup-databento-jobs.sh)",
    );
    return;
  }

  try {
    const rows = toLedgerSourceObjects(row, records, { env, now: new Date() });
    let written = 0;
    // Bounded concurrency, like the download loop. Not serial — see the header.
    const LEDGER_CONCURRENCY = 8;
    for (let i = 0; i < rows.length; i += LEDGER_CONCURRENCY) {
      await Promise.all(
        rows.slice(i, i + LEDGER_CONCURRENCY).map(async (r) => {
          await recordSourceObject(r);
          written++;
        }),
      );
    }
    await markLedgerBacked(row.id);
    console.log(
      `[databento] ledger: ${written}/${rows.length} file(s) for ${row.jobId ?? row.id} ` +
        `(${rows.filter((r) => r.state === "VERIFIED").length} verified)`,
    );
  } catch (err) {
    console.error(
      `[databento] ledger mirror FAILED for ${row.jobId ?? row.id}: ${String(err)} — ` +
        "ledgerBacked stays unset; ledger-backfill-databento will retry it",
    );
  }
}

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Every Cloud Run job does this;
  // without it the job logs to stdout only and its monitors sit in NO DATA.
  await initJobTelemetry();
  // FIRST. This runs as a Cloud Run JOB, and a job PINS ITS IMAGE AT SETUP
  // TIME — deploying the workers SERVICE does not move it. So this line is the
  // only runtime answer to "is the running job the code I pushed?", and on this
  // repo that has already gone wrong: a MONEY-1189 fix sat un-executed on the
  // nightly jobs after release. `scripts/ops/setup-databento-jobs.sh` is the
  // ONLY thing that re-pins it.
  reportBuildProvenance(log, "databento-harvest");

  if (!STEPS.includes(STEP)) {
    throw new Error(`--step=${STEP} is not one of ${STEPS.join(" | ")}`);
  }

  // BEFORE anything else that costs time. `databentoApiKey()` throws a message
  // naming the Secret Manager entries; without this the run walks the whole
  // manifest, fails per-chunk inside the guard's try/catch, and reaches the
  // coverage step having reported a page of errors for one missing variable.
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

  const armed = isHarvestArmed();
  const decision = resolveApply(APPLY_ASKED, armed);
  if (decision.armMissing) {
    log.warn(
      'ARM MISSING — DATABENTO_HARVEST_APPLY is not "true"; staying in ' +
        "dry-run. Arming is a DEPLOY, not a flag: a command line cannot " +
        "authorise a spend on its own.",
    );
  }
  const apply = decision.apply;

  // THE SCOPE GUARD, before any request. The manifest's last entry is the
  // TB-scale 1s archive; a bare `--apply` would walk it in the same execution
  // as everything else. Dry-run without `--entry` is fine — quoting everything
  // is the point of a dry run.
  const manifest = parseManifest(manifestJson);
  if (apply && ENTRIES.length === 0) {
    log.error(
      "--apply requires at least one --entry=<id>. Refusing to walk the whole " +
        "manifest in one execution — the last entry is the TB-scale 1s " +
        "archive. Entries, in manifest order:\n  " +
        orderedEntryIds(manifest).join("\n  "),
    );
    process.exitCode = 1;
    return;
  }

  const ordered = orderedEntries(manifest);
  const entriesById = new Map(ordered.map((e) => [e.id, e]));
  const unknown = ENTRIES.filter((id) => !entriesById.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `--entry=${unknown.join(",")} is not in the manifest. Known: ` +
        orderedEntryIds(manifest).join(", "),
    );
  }

  // FAIL CLOSED, before the first request. A download that lands nowhere has
  // spent metered money and produced nothing, and the run would report success.
  const archiveReady = initDatabentoArchiveStore();
  const coldReady = initCandleColdStore();
  if (apply && !archiveReady) {
    throw new Error(
      "GCP_STORAGE_BUCKET is unset, so no Databento archive store could be " +
        "registered — refusing to --apply. The vendor's bytes are metered and " +
        "expire 30 days after submission; downloading them into nowhere spends " +
        "the money and leaves nothing to re-load from.",
    );
  }
  if (apply && !coldReady && wants("load")) {
    throw new Error(
      "GCP_STORAGE_BUCKET is unset, so no candle cold store could be " +
        "registered — refusing to load. Intraday history older than the " +
        "45-day hot window has nowhere to go and every such session would " +
        "fail one at a time after the download was already paid for.",
    );
  }

  const shard = resolveShard(ARGS.value("shard"));
  // SHARDING APPLIES TO THE LOAD, AND ONLY THE LOAD.
  //
  // `--step=all` runs quote -> poll -> download -> load in one process, and the
  // first three are LEADER-ONLY by construction (only task 0 does them). Tasks
  // 1..N-1 therefore skip straight to `stepLoad` and find nothing downloaded
  // yet — so an N-task `--step=all` is one task doing the work and N-1
  // reporting a clean, empty, successful run. Refusing is the whole difference
  // between "the sharding did nothing" and "the sharding looked like it worked".
  if (shard !== null && STEP === "all") {
    throw new Error(
      "sharding applies to --step=load only; run the download on one task, " +
        "then the load on N. With --step=all the non-leader tasks reach the " +
        "load before the leader has downloaded anything and exit 0 having " +
        "done nothing.",
    );
  }
  const now = new Date();
  // FREE, and the whole reason a window that reaches the newest session does
  // not 422. One call PER DATASET the manifest names — an entry may override
  // it, and each dataset has its own available range.
  const datasets = [
    ...new Set(manifest.entries.map((e) => datasetForEntry(e, manifest))),
  ];
  for (const ds of datasets) await loadVendorRange(ds);
  log.info(
    `env=${ENV} step=${STEP} apply=${apply}${apply ? "" : " (DRY RUN)"} ` +
      `vendorRangeEnd=${datasets
        .map((d) => `${d}:${vendorRanges.get(d)!.end.toISOString()}`)
        .join(" ")} ` +
      `entries=${ENTRIES.length === 0 ? "(all)" : ENTRIES.join(",")} ` +
      `shard=${shard === null ? "none" : `${shard.index}/${shard.count}`} ` +
      `archive=${archiveReady ? "on" : "OFF"} cold=${coldReady ? "on" : "OFF"}`,
  );

  // Manifest order when nothing is named, so a dry run quotes the cheap
  // entries before the expensive ones and an operator reading the log top-down
  // sees the same sequence the harvest would buy in.
  const selected = ENTRIES.length > 0 ? ENTRIES : orderedEntryIds(manifest);
  // Every step after `quote` restricts itself to these. Left undefined when
  // nothing was named, which is what a whole-manifest dry run wants.
  selectedEntryIds = ENTRIES.length > 0 ? [...ENTRIES] : undefined;

  // Submit, poll and download are WHOLE-JOB operations, so they run on one
  // task only. Sharding them would have every task submit the same window and
  // download the same files — the loader is the only step with a partitionable
  // unit (a file).
  const leader = shard === null || shard.index === 0;

  for (const id of selected) {
    const entry = entriesById.get(id);
    if (entry === undefined) continue;
    if (wants("quote") && leader) {
      await stepQuote(entry, manifest, apply, now);
    }
  }

  if (apply && leader && wants("poll")) await stepPoll(now);
  if (apply && leader && wants("download")) await stepDownload();
  if (apply && wants("load")) await stepLoad(shard);
  // LEADER ONLY. The aggregation reads the whole `candles` window for the
  // entry; an N-task execution would run it N times and report the same
  // numbers N times, which reads as N times the work having been checked.
  if (leader && wants("coverage")) {
    for (const id of selected) {
      const entry = entriesById.get(id);
      if (entry === undefined) continue;
      if (LOADABLE_SCHEMAS.includes(entry.schema as never)) {
        await stepCoverage(entry, manifest, now);
      }
    }
  }
  // NOT gated on `apply` — MONEY-1373 T4.
  //
  // Files expire 30 DAYS AFTER SUBMISSION (not after completion), and this job
  // has no cron by design: a scheduled harvest would be a standing
  // authorisation to spend. So if the only thing that watched the clock were an
  // ARMED run, nothing would watch it at all once the buy finished — and past
  // the expiry the only remedy is to buy the range again, at usage prices,
  // after the subscription has lapsed. It is a read plus a counter; it spends
  // nothing and it emits a ZERO point, which is what makes the series exist.
  // NO DATA and "healthy" look identical in Datadog (MONEY-1278).
  if (leader) await stepExpiry(now);

  const window = monthWindowUtc(now);
  const spent = await budgetDeps.sumMonthSpendUsd(window);
  log.info(
    `chunks considered=${totals.chunksConsidered} quoted=${totals.chunksQuoted} ` +
      `submitted=${totals.chunksSubmitted} reused=${totals.chunksReused} ` +
      `quoteUsd=${totals.quoteUsd.toFixed(2)} monthSpentUsd=${spent.toFixed(2)}`,
  );
  log.info(
    `files considered=${totals.filesConsidered} downloaded=${totals.filesDownloaded} ` +
      `resumed=${totals.filesResumed} ` +
      `verifyFailed=${totals.filesVerifyFailed} loaded=${totals.filesLoaded} ` +
      `rowsWritten=${totals.rowsWritten} quarantined=${totals.quarantinedRows} ` +
      `pending=${totals.jobsPending} expiring=${totals.jobsExpiring} ` +
      `chunksFailed=${totals.chunksFailed} filesFailed=${totals.filesFailed} ` +
      `otherErrors=${totals.errors - totals.chunksFailed - totals.filesFailed}`,
  );
  if (!apply) log.info("DRY RUN — pass --apply (bare flag) and arm the job to write.");

  reportJobOutcome({
    job: "databento-harvest",
    selected: totals.filesConsidered + totals.chunksConsidered,
    written: totals.rowsWritten,
    failed: totals.errors,
  });

  // COUNT THE UNITS YOU COUNTED IN `attempted`.
  //
  // `attempted` is chunks plus files; `totals.errors` also carries per-JOB
  // failures (an EXPIRED batch job) and per-ROW writer failures, so a run whose
  // every chunk and file succeeded could still be judged failed — and, worse,
  // `succeeded` could go NEGATIVE and turn a healthy run's ratio into a
  // failure verdict. The unit-matched counters are the two below; `rowsFailed`
  // is reported separately in the log line above because it is a different
  // denominator, not a different opinion about the same one.
  const unitsAttempted = totals.chunksConsidered + totals.filesConsidered;
  const unitsFailed = totals.chunksFailed + totals.filesFailed;
  const verdict = judgeBackfillOutcome({
    stopped: false,
    attempted: unitsAttempted,
    succeeded: Math.max(0, unitsAttempted - unitsFailed),
    failed: unitsFailed,
  });
  if (verdict.exitCode !== 0) {
    log.warn(`FAILED RUN — ${verdict.reason}`);
    process.exitCode = verdict.exitCode;
  }

  // A REFUSED SHARD IS A FAILED RUN, and the judge above cannot see it.
  //
  // `unitsAttempted` counts chunks and files; a `--step=load` execution that
  // refuses every row touches neither, so `judgeBackfillOutcome` takes its
  // `attempted === 0` early return and hands back exitCode 0. The operator's
  // `gcloud run jobs execute --wait` then reports SUCCESS for a task that
  // loaded nothing and said so only in a log line nobody is watching.
  if (totals.shardRefusals > 0) {
    log.error(
      `FAILED RUN — ${totals.shardRefusals} row(s) refused a sharded load. ` +
        "Nothing was loaded for them. See the per-row error above.",
    );
    process.exitCode = 1;
  }

  // Names from `DATABENTO_METRICS`, never a literal — the two spellings of
  // `sessions_displaced` this module exists to stop are documented there.
  //
  // BEFORE `flushMetrics()`, which is not a style point: `datadog-metrics`
  // buffers, so a counter emitted after the flush is dropped silently.
  const tags = { job: "databento-harvest" };
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
  // GAUGE. A running monthly total is a LEVEL; incrementing it once per run
  // would sum the same month over and over.
  gauge(DATABENTO_METRICS.spendUsd, spent, tags);

  // BEFORE exit, and awaited. `datadog-metrics` buffers, so a process that
  // exits without this drops every counter it just reported — silently, which
  // renders as NO DATA rather than as an alert.
  await flushMetrics();
}

main()
  .catch((err) => {
    console.error("[databento-harvest] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
