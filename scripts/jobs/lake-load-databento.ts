/**
 * Databento M1/H1 -> `lake_silver.trade_bar_*`, and bbo/tbbo -> `spread_cost_daily`.
 * MONEY-1505 (data-platform B5).
 *
 * ## WHAT THIS BYPASSES
 *
 * 151.5M M1 rows and 38.8M H1 rows are ALREADY IN GCS, bought and verified
 * (docs/reference/databento-inventory-2026-09.md). Nothing here contacts the
 * vendor: there is no Databento client import, no `submitBatchJob`, no budget
 * to spend. A re-load costs GCS reads and BigQuery load jobs, both effectively
 * free, where a re-purchase would cost a $199 Standard month.
 *
 * The existing loader writes those bars into Mongo `candles` and evicts the
 * older years to COLD SHARDS, and the cold path reads, merges and REWRITES a
 * whole symbol-year object per flush (`databento-session-writer.ts`) — the
 * wrong split once produced 439,569 of those rewrites. This job reuses every
 * PARSER (`parseOhlcvHeader`, `parseOhlcvRow`, `resolveListingForDate`) and
 * replaces only the SINK: rows stream to staged NDJSON which `bq load` reads
 * once, and the `lake/stage/` 14-day lifecycle rule deletes.
 *
 * ## WHY TYPESCRIPT AND NOT PYTHON (the B5 prompt asks for a decision)
 *
 * The prompt suggests Python "because the `.dbn.zst`/`.csv.zst` decode is
 * easiest with the databento Python package". Measured against what is on disk,
 * that argument does not hold here:
 *
 *   - WE DO NOT HOLD DBN. The harvest transcodes to CSV+ZSTD server-side
 *     (free, and billing is on the binary size either way), so there is no DBN
 *     to decode and the vendor SDK would be a dependency for nothing.
 *   - THE ZSTD READER EXISTS AND IS STDLIB. `zstdLines` wraps
 *     `node:zlib.createZstdDecompress` (the reason the workers image is
 *     node:22-alpine) and is already the reader for every Databento byte we
 *     have parsed.
 *   - FIVE THINGS WOULD BE RE-IMPLEMENTED IN PYTHON, each a measured trap:
 *     header-by-NAME parsing (this vendor's sibling CSV is documented
 *     `date,open,…` and is really `date,close,high,low,open`),
 *     `resolveListingForDate` (2,196 recycled US tickers — `DOW` is two
 *     companies), the quarantine ledger, `usMarketDateKey` (the ET session
 *     key), and the B1 ledger's claim/accept path. A second copy of any of
 *     them is a second definition that can drift.
 *   - THE LEDGER IS TYPESCRIPT. `@usemoney/lake` is the only writer of
 *     `partition_load`, and the prompt's own constraint is to reuse it rather
 *     than write a second one.
 *
 * `services/us-fundamentals` is Python because its PARSER is (edgartools maps
 * 2,923 XBRL tags). Here the parser is already TypeScript, so the same
 * criterion points the other way.
 *
 * ## THE UNIT OF WORK IS A (timeframe, MONTH) PARTITION
 *
 * Not a file, and not a year, and both alternatives fail for measurable
 * reasons:
 *
 *   PER FILE   44,097 vendor files against BigQuery's 1,500 load jobs per
 *              table per day. The H1 replay alone would take 28 days.
 *   PER YEAR   ~43M M1 rows in one claim. A crash restarts the year, and a
 *              nightly append would re-load twelve months to store one
 *              session.
 *
 * A month is ~3.6M M1 rows, 84 load jobs for the whole replay, and — because
 * `monthsForArchiveFile` reads the vendor's own date out of an append's
 * filename — a nightly append dirties ONE month's source hash rather than
 * twelve.
 *
 * ## IT READS THE VENDOR INVENTORY, NEVER `listFiles`
 *
 * `listArchivedFilesBySchema` builds every key from `DatabentoBatchJob.files`,
 * which the downloader itself wrote, and filters on that record's own
 * `verified` flag — a checksum result a GCS HEAD cannot see. `listFiles` fails
 * open to `[]`, so a listing-driven loader would silently load nothing on a
 * credentials blip and report success.
 *
 * `lake_bronze.source_object` is a MIRROR of that array
 * (`toLedgerSourceObjects`), so driving off it would add a lag and an
 * environment where the B1 backfill has not run would load zero files. The
 * ledger is used for what only it can do: claim, accept, quarantine, run.
 *
 * ## `--year` IS THE DATA YEAR — MONEY-1515
 *
 * The ET session year of the rows to load. Every run lists the schema's WHOLE
 * inventory, whatever archive path year a file sits under, and
 * `monthsForArchiveFile` reads the vendor's own range out of each filename
 * (`equs-mini-20240101-20241231.ohlcv-1h.AAPL.csv.zst`) to decide which months
 * the file can feed. A month is read from, and hashed over, exactly those.
 *
 * It used to be the ARCHIVE PATH year. That segment is the JOB's start year:
 * the whole H1 and M1 harvests sit under `…/2023/` and hold 2023-03-28 through
 * 2026-09, and the trailing-12-month bbo harvest sits under `…/2025/` and holds
 * 2026 too. So `--year 2023` reached only 2023's months, and 2024-01..2026-08
 * — 32 of the 43 bought months (2023-03..2026-09) — were reachable by no
 * `--year` at all: parsed and dropped. Measured 2026-09-23: `--year 2023` on
 * H1 logged 18,007 files -> 10 month partitions.
 *
 * Every bought month, H1 first (same code path, a quarter of the rows):
 *
 *     for Y in 2023 2024 2025 2026; do
 *       npx tsx scripts/jobs/lake-load-databento.ts --env prod --schema ohlcv-1h --year $Y --apply
 *     done
 *     # then the same four with --schema ohlcv-1m, and with --schema spread
 *
 * 2023-01/02 and the months after the purchase are skipped BY NAME
 * (`outside-purchase`), never claimed empty. `--month YYYY-MM` narrows a run
 * to one partition and must sit inside `--year` — the nightly top-up shape.
 *
 * A run claims only ITS year's months, so it holds at most twelve stage
 * buffers however many files and job directories feed them — see
 * `MAX_STAGE_ROWS`. Nothing loads a whole year, let alone 151.5M rows, into
 * memory: rows stream from one file at a time into those buffers.
 *
 * ## Usage
 *
 *     npx tsx scripts/jobs/lake-load-databento.ts --env prod --schema ohlcv-1h --year 2024 --month 2024-04
 *     npx tsx scripts/jobs/lake-load-databento.ts --env prod --schema ohlcv-1h --year 2024 --apply
 *     npx tsx scripts/jobs/lake-load-databento.ts --env prod --schema spread   --year 2026 --apply
 */
import type { Readable } from "node:stream";
import { pinJobEnv } from "@usemoney/core/ops/gcp-secrets";
import { guardCompletion } from "@usemoney/core/ops/job-completion";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { flushMetrics } from "@usemoney/datadog/metrics";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";
import { uploadFile, downloadStream } from "@usemoney/storage";
import {
  beginRun,
  endRun,
  claimPartition,
  acceptPartition,
  rejectPartition,
  quarantine,
  CoverageRefusedError,
} from "@usemoney/lake/ledger";
import {
  CLAIM_LEASE_MS,
  runId as buildRunId,
} from "@usemoney/lake/ledger-logic";
import { loadNdjson, purgePartitionRange } from "@usemoney/lake/load";
import {
  stageKey,
  encodeNdjson,
  STAGE_UPLOAD_POLICY,
} from "@usemoney/lake/stage-logic";
import {
  bucketForPrefix,
  datasetFor,
  type LakeEnv,
} from "@usemoney/core/ops/lake-layout";
import {
  DATABENTO_SOURCE,
  EQUS_MINI_HISTORY_FLOOR,
  fromDatabentoSymbol,
  parseOhlcvHeader,
  parseOhlcvRow,
  parseBboHeader,
  parseBboRow,
  parseTbboHeader,
  parseTbboRow,
} from "@usemoney/core/market-data/databento/databento-logic";
import { zstdLines } from "@usemoney/core/market-data/databento/databento-stream";
import {
  buildListingIndex,
  resolveListingForDate,
  QuarantineLedger,
  type ListingRow,
} from "@usemoney/core/market-data/databento/databento-symbology";
// TYPE-ONLY, and that is load-bearing rather than tidy. See `openRepo` below:
// `databento-repo` is the ONE door from this job's module graph to
// `@usemoney/database`'s import-time singleton, so its VALUES are loaded
// dynamically after `pinJobEnv`. An `import type` is erased and loads nothing.
import type { ArchivedVendorFile } from "@usemoney/core/market-data/databento/databento-repo";
import {
  LAKE_LOADABLE_SCHEMAS,
  SPREAD_COST_PARSER_VERSION,
  TRADE_BAR_PARSER_VERSION,
  assertMonthKey,
  assertPlannedMonths,
  lastDateOfMonth,
  monthKeyOf,
  monthsForArchiveFile,
  monthsOfYear,
  planMonthPartitions,
  parseDatabentoArchiveKey,
  spreadCostPartitionKey,
  toTradeBarRow,
  tradeBarMonthWindow,
  tradeBarPartitionKey,
  tradeBarTableFor,
  tradeBarTimeframeFor,
  type DatabentoArchiveParts,
} from "@usemoney/core/market-data/databento/databento-lake-logic";
import {
  mergeSpreadSummary,
  newSpreadDayCell,
  spreadDayKey,
  spreadSampleFor,
  summarizeSpreadDay,
  toSpreadCostRow,
  type SpreadCostRow,
  type SpreadDayCell,
  type SpreadDaySummary,
} from "@usemoney/core/market-data/databento/databento-spread-logic";
import { usMarketDateKey } from "@usemoney/core/market-data/us-market-hours";
import { splitCsvLine } from "@usemoney/core/market-data/csv-line";

const JOB = "lake-load-databento";
const MARKET = "US";
const GCP_PROJECT = "stock-book-483718";
const SPREAD_TABLE = "spread_cost_daily";

/**
 * Rows held before a stage object is flushed.
 *
 * THE CEILING IS TWELVE OF THESE AT ONCE, not one: one pass over a year's
 * files fans rows out to every month partition, so each holds its own buffer.
 * At ~500 bytes per row object that is ~300 MB against the job's 4Gi, plus the
 * transient NDJSON string `encodeNdjson` builds on each flush, plus the
 * de-duplication Set of any month whose files overlap (`MonthStage.seen`).
 *
 * TWELVE because `--year` is one DATA year and `allowedMonths` is its months.
 * The number of files or job directories feeding a month does not move it:
 * files are read one at a time and their rows go straight into these buffers.
 *
 * Raising it trades that headroom for fewer objects, and the objects cost
 * nothing — one `bq load` reads them all through a wildcard.
 */
const MAX_STAGE_ROWS = 50_000;

const log = {
  info: (...a: unknown[]) => console.log(...a),
  warn: (...a: unknown[]) => console.warn(...a),
  error: (...a: unknown[]) => console.error(...a),
};

/* ─────────────────────────────────────────────────────────────────────────
   The Mongo half, loaded AFTER the environment is pinned — MONEY-1514
   ──────────────────────────────────────────────────────────────────────── */

type DatabentoRepo =
  typeof import("@usemoney/core/market-data/databento/databento-repo");

let repo: DatabentoRepo | null = null;

/**
 * Load `databento-repo` only once `--env` has been pinned.
 *
 * ## THE HAZARD
 *
 * `packages/database/client.ts` constructs its Prisma singleton at MODULE
 * SCOPE from `process.env.DATABASE_URL`. This job's `--env` steered only the
 * BigQuery dataset, so `--env prod` from a shell carrying the repo's QA `.env`
 * read QA Mongo and wrote `lake_silver_prod` — silently, and here that is the
 * worst of the three jobs MONEY-1514 names: `fetchListingRows` feeds
 * `listing_id`, which is the CLUSTER KEY on `trade_bar_m1`, `trade_bar_h1` and
 * `spread_cost_daily`.
 *
 * ## WHY NOT `pinJobEnv` IN `run()` ALONE
 *
 * Because it does not work, and it is probe-verified in the ticket: with the
 * module already imported, overwriting `DATABASE_URL` afterwards leaves the
 * connection resolving the OLD host. Pinning while keeping a static import
 * would make the hazard SILENT instead of removing it — strictly worse than
 * today, which at least fails closed when `DATABASE_URL` is unset.
 *
 * ## WHY A DYNAMIC IMPORT AND NOT AN INJECTED CLIENT
 *
 * MEASURED: `databento-repo` is the ONLY module in this job's static import
 * graph that reaches `@usemoney/database`. Every other specifier the file
 * imports — the ledger, the loader, storage, telemetry, the pure databento
 * modules — loads without it. So one dynamic import closes the door
 * completely, and it closes it for every function of the repo rather than for
 * the three this job happens to call today.
 *
 * Injecting a client into `databento-repo` was rejected for the opposite
 * reason: it would leave that module's own `import { prisma }` in place, so
 * the singleton would still be built from the ambient URL and the next
 * function added there would re-open the hazard with nothing to notice. Doing
 * it properly means threading a client through ~20 call sites shared with
 * `databento-harvest`, `databento-append` and the cost-model builder — three
 * jobs that do not have this problem, because inside a Cloud Run job the
 * MOUNTED `DATABASE_URL` is the authority and `--env` is a label.
 */
function openRepo(): DatabentoRepo {
  if (repo === null) {
    throw new Error(
      `${JOB}: databento-repo was read before pinJobEnv() ran. The Prisma ` +
        `singleton captures DATABASE_URL at import, so loading it earlier ` +
        `would bind this run to whatever the shell carried rather than to ` +
        `--env.`,
    );
  }
  return repo;
}

/* ─────────────────────────────────────────────────────────────────────────
   Args
   ──────────────────────────────────────────────────────────────────────── */

type Mode = "ohlcv-1m" | "ohlcv-1h" | "spread";

interface Args {
  env: LakeEnv;
  mode: Mode;
  year: number;
  apply: boolean;
  onlyMonth: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const take = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const env = take("--env");
  if (env !== "qa" && env !== "prod")
    throw new Error("--env must be qa or prod");

  const schema = take("--schema");
  if (schema === undefined) {
    throw new Error(
      `--schema is required: ${LAKE_LOADABLE_SCHEMAS.join(" | ")} | spread`,
    );
  }
  // THE ohlcv-1s REFUSAL, at the FRONT DOOR as well as at the table lookup.
  // Two refusals for one rule, deliberately: this one names the schemas an
  // operator may pass, and `tradeBarTableFor` is the one a future code path
  // cannot get round by not coming through here.
  if (schema !== "spread") tradeBarTableFor(schema);
  const mode = schema as Mode;

  const yearRaw = take("--year");
  const year = Number(yearRaw);
  const floorYear = Number(EQUS_MINI_HISTORY_FLOOR.slice(0, 4));
  const thisYear = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < floorYear || year > thisYear) {
    throw new Error(
      `--year must be an integer in ${floorYear}..${thisYear}. EQUS.MINI's ` +
        `history floors at ${EQUS_MINI_HISTORY_FLOOR}, and asking for an ` +
        `earlier year returns an EMPTY result that is indistinguishable from ` +
        `a market holiday and from a broken query`,
    );
  }

  const onlyMonth = take("--month") ?? null;
  if (onlyMonth !== null) {
    // SHAPE FIRST. `--month 2024-13` starts with "2024-" and would otherwise
    // filter every partition out, so the run would consider nothing, load
    // nothing, and exit 0 — the silent-success shape this whole job is built
    // to refuse.
    assertMonthKey(onlyMonth);
    if (!onlyMonth.startsWith(`${year}-`)) {
      throw new Error(`--month ${onlyMonth} is not inside --year ${year}`);
    }
  }

  return { env, mode, year, apply: argv.includes("--apply"), onlyMonth };
}

/* ─────────────────────────────────────────────────────────────────────────
   Staging
   ──────────────────────────────────────────────────────────────────────── */

/** One month's in-flight stage state. */
interface MonthStage {
  monthKey: string;
  partitionKey: string;
  sourceHash: string;
  /** Rows not yet uploaded. */
  buffer: object[];
  /** How many objects have been written for this month this run. */
  objects: number;
  rows: number;
  sessions: Set<string>;
  expected: number;
  /**
   * `symbol|tsMs` of every bar staged, ONLY for a month whose files can
   * repeat a bar (`filesMayOverlap`); null otherwise. See `loadBars`.
   */
  seen: Set<string> | null;
}

class Stager {
  constructor(
    private readonly args: {
      bucket: string;
      table: string;
      runId: string;
      apply: boolean;
    },
  ) {}

  async add(stage: MonthStage, row: object): Promise<void> {
    stage.buffer.push(row);
    stage.rows++;
    if (stage.buffer.length >= MAX_STAGE_ROWS) await this.flush(stage);
  }

  async flush(stage: MonthStage): Promise<void> {
    if (stage.buffer.length === 0) return;
    const body = encodeNdjson(stage.buffer);
    stage.buffer = [];
    const key = stageKey({
      table: this.args.table,
      partitionKey: stage.partitionKey,
      // SEQUENCED INSIDE THE RUN ID, so the load's wildcard
      // `{runId}-*.ndjson` matches this run's objects and cannot pick up a
      // concurrent run's. A run id carries a full timestamp, so no run id is
      // a prefix of another.
      runId: `${this.args.runId}-${stage.objects}`,
    });
    stage.objects++;
    if (!this.args.apply) return;
    await uploadFile({
      file: Buffer.from(body, "utf8"),
      fileName: key,
      contentType: "application/x-ndjson",
      // NEVER public. A stage object is an internal intermediate and
      // `uploadFile` routes a public upload to a DIFFERENT bucket.
      isPublic: false,
      bucketName: this.args.bucket,
      ...STAGE_UPLOAD_POLICY,
    });
  }

  /** The wildcard one `bq load` reads for a whole month. */
  sourceUri(stage: MonthStage): string {
    const prefix = stageKey({
      table: this.args.table,
      partitionKey: stage.partitionKey,
      runId: this.args.runId,
    }).replace(/\.ndjson$/, "");
    return `gs://${this.args.bucket}/${prefix}-*.ndjson`;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Shared month planning
   ──────────────────────────────────────────────────────────────────────── */

interface PlannedMonth extends MonthStage {
  files: readonly ArchivedVendorFile[];
}

/**
 * The listing window: the WHOLE archive, whatever `--year` asks for.
 *
 * `--year` is the DATA year and a file under ANY path year may hold it, so the
 * planner — which reads each file's full vendor range — is what narrows. The
 * repo's own per-file filter must NOT: it keys on the FIRST date in a filename
 * (`fileSessionDate`), which for a harvest year-file is its range START, so a
 * window opening after 2023-03-28 would drop `…-20230328-20231231…` although
 * it holds the whole rest of 2023.
 */
function wholeArchive(): { from: Date; to: Date } {
  return {
    from: new Date(Date.UTC(Number(EQUS_MINI_HISTORY_FLOOR.slice(0, 4)), 0, 1)),
    to: new Date(Date.UTC(new Date().getUTCFullYear() + 2, 0, 1)),
  };
}

/**
 * The pure plan, wrapped in the mutable stage state the loader carries.
 *
 * Every DECISION — which months this run may claim, what each is built from,
 * how many sessions it should hold — lives in `planMonthPartitions`, so the
 * destructive rule (a run never claims a month it holds only the spill hour
 * of) is testable without provisioning anything.
 */
function planStages(args: {
  files: readonly { file: ArchivedVendorFile; parts: DatabentoArchiveParts }[];
  partitionKeyFor: (monthKey: string) => string;
  allowedMonths: readonly string[];
  entryStartDateKey: string;
  entryEndDateKey: string;
  todayDateKey: string;
  onlyMonth: string | null;
  /** For the refusal below, which has to name what the operator asked for. */
  schema: string;
  year: number;
}): PlannedMonth[] {
  const result = planMonthPartitions(args);
  for (const s of result.skipped) {
    // `not-this-run` is the common, healthy case (a neighbouring year's months
    // that this run's files merely touch) and would drown the log, so only the
    // two that an operator might be surprised by are printed.
    if (s.reason === "outside-purchase") {
      log.info(`  ${s.monthKey}: outside the purchased window — skipped`);
    }
  }
  // A SELECTION THAT PLANS NO MONTH REFUSES — MONEY-1515. Without it the run
  // falls through to the "already ACCEPTED — nothing to do" branch below,
  // which is a LIE when nothing was ever planned, and exits 0.
  const plans = assertPlannedMonths(result, {
    schema: args.schema,
    year: args.year,
    fileCount: args.files.length,
  });
  return plans.map((plan) => ({
    monthKey: plan.monthKey,
    partitionKey: plan.partitionKey,
    sourceHash: plan.sourceHash,
    buffer: [],
    objects: 0,
    rows: 0,
    sessions: new Set<string>(),
    expected: plan.expectedSessionCount,
    files: plan.files,
    seen: plan.filesMayOverlap ? new Set<string>() : null,
  }));
}

/* ─────────────────────────────────────────────────────────────────────────
   Bars
   ──────────────────────────────────────────────────────────────────────── */

interface BarCounters {
  filesRead: number;
  rowsRead: number;
  rowsMapped: number;
  droppedFields: number;
  droppedTimestamp: number;
  droppedPrice: number;
  droppedSymbolField: number;
  quarantined: number;
  /** A bar a second file repeated — see `filesMayOverlap`. */
  duplicateRows: number;
  monthsAccepted: number;
  monthsRejected: number;
  monthsSkipped: number;
  /** Of those, held by ANOTHER run's live lease — work that REMAINS. */
  monthsLeased: number;
}

/** Optional column indices this loader reads beyond the bar itself. */
function optionalColumns(header: string): {
  instrumentId: number;
  publisherId: number;
} {
  const idx = new Map(
    splitCsvLine(header).map((h, i) => [h.trim().toLowerCase(), i] as const),
  );
  return {
    instrumentId: idx.get("instrument_id") ?? -1,
    publisherId: idx.get("publisher_id") ?? -1,
  };
}

function intCell(cells: readonly string[], i: number): number | null {
  if (i < 0) return null;
  const raw = (cells[i] ?? "").trim();
  // EMPTY IS NULL, not 0. `Number("")` is 0 and `Number.isInteger(0)` is true,
  // so an absent instrument id would be stored as a real-looking one.
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

async function loadBars(args: Args, runId: string): Promise<BarCounters> {
  const counters: BarCounters = {
    filesRead: 0,
    rowsRead: 0,
    rowsMapped: 0,
    droppedFields: 0,
    droppedTimestamp: 0,
    droppedPrice: 0,
    droppedSymbolField: 0,
    quarantined: 0,
    duplicateRows: 0,
    monthsAccepted: 0,
    monthsRejected: 0,
    monthsSkipped: 0,
    monthsLeased: 0,
  };

  const schema = args.mode;
  const table = tradeBarTableFor(schema);
  const timeframe = tradeBarTimeframeFor(schema);
  const dataset = datasetFor("lake_silver", args.env);
  const bucket = bucketForPrefix("lake/stage/", args.env);

  const window = await openRepo().databentoSchemaWindow(schema, args.env);
  if (window === null) {
    // REFUSED, never treated as an empty range. A window of zero length makes
    // `expectedSessions` zero, and `decideCoverage` would then be the only
    // thing standing between us and an ACCEPTED empty month.
    throw new Error(
      `no DOWNLOADED/LOADED ${schema} jobs for env ${args.env}: the vendor ` +
        `inventory says nothing was bought, so there is no denominator to ` +
        `measure coverage against. Run databento-inventory.ts before this.`,
    );
  }

  // THE WHOLE ARCHIVE, every path year — see `wholeArchive`. The planner reads
  // each file's vendor range and keeps the ones that can feed `--year`.
  //
  // That includes the NEXT year's files for December: the vendor's file
  // boundary is UTC and ours is the ET session, so `{Y+1}`'s year file OPENS
  // at 19:00 ET on `{Y}-12-31` and the last hour of December lives in it.
  //
  // ponytail: those `{Y+1}` files are read END TO END for one hour of rows —
  // one extra file-year per run (H1 --year 2024 opens 9,577 + 11,276 files).
  // An early exit is possible because a symbol-year file is ts-ascending, but
  // its correctness would then rest on that ordering rather than on a skip, so
  // it is a measured optimisation and not a correctness fix.
  const archive = wholeArchive();
  const raw = await openRepo().listArchivedFilesBySchema(
    schema,
    archive.from,
    archive.to,
    args.env,
  );

  const files: { file: ArchivedVendorFile; parts: DatabentoArchiveParts }[] =
    [];
  let unparseable = 0;
  for (const file of raw) {
    const parts = parseDatabentoArchiveKey(file.archiveKey);
    if (parts === null) {
      unparseable++;
      continue;
    }
    files.push({ file, parts });
  }
  if (unparseable > 0) {
    log.warn(
      `${unparseable} archived key(s) did not parse as databento/{dataset}/{schema}/{yyyy}/{jobId}/{file} — skipped`,
    );
  }
  if (files.length === 0) {
    throw new Error(
      `no verified ${schema} files in the ${args.env} inventory at all. ` +
        `Loading zero rows and reporting success is what the ledger exists ` +
        `to prevent — this is a broken inventory query or an unharvested ` +
        `schema, not an empty year.`,
    );
  }

  const months = planStages({
    files,
    schema,
    year: args.year,
    partitionKeyFor: (m) => tradeBarPartitionKey(MARKET, timeframe, m),
    allowedMonths: monthsOfYear(args.year),
    entryStartDateKey: window.start.toISOString().slice(0, 10),
    // `end` is EXCLUSIVE on the vendor row; a coverage window is inclusive.
    entryEndDateKey: new Date(window.end.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10),
    todayDateKey: new Date().toISOString().slice(0, 10),
    onlyMonth: args.onlyMonth,
  });

  log.info(
    `${schema} ${args.year}: ${files.length} archived file(s), ` +
      `${new Set(months.flatMap((m) => m.files.map((f) => f.archiveKey))).size} ` +
      `feed ${months.length} month partition(s) in ${dataset}.${table}`,
  );

  // CLAIM BEFORE READING. A month already ACCEPTED for this (source hash,
  // parser version) is dropped from the pass entirely, so a resumed run does
  // not re-parse bytes it has already loaded.
  const wanted: PlannedMonth[] = [];
  const skipKinds: Array<"accepted" | "leased"> = [];
  for (const month of months) {
    if (!args.apply) {
      log.info(
        `  ${month.monthKey}: ${month.files.length} file(s), expect ` +
          `${month.expected} session(s)` +
          `${month.seen === null ? "" : ", files overlap — de-duplicating"} [DRY RUN]`,
      );
      wanted.push(month);
      continue;
    }
    const verdict = await claimPartition(
      {
        dataset,
        table,
        partitionKey: month.partitionKey,
        sourceHash: month.sourceHash,
        parserVersion: TRADE_BAR_PARSER_VERSION,
      },
      { runId },
    );
    if (verdict.action === "skip") {
      counters.monthsSkipped++;
      skipKinds.push(verdict.kind);
      if (verdict.kind === "leased") counters.monthsLeased++;
      log.info(`  ${month.monthKey}: skip — ${verdict.reason}`);
      continue;
    }
    wanted.push(month);
  }
  if (wanted.length === 0) {
    logEmptySelection(log, "month partition", skipKinds);
    return counters;
  }

  const wantedByMonth = new Map(wanted.map((m) => [m.monthKey, m]));
  const listings = buildListingIndex(
    (await openRepo().fetchListingRows()) as unknown as ListingRow[],
  );
  const ledger = new QuarantineLedger();
  const stager = new Stager({ bucket, table, runId, apply: args.apply });
  const ingestedAtMs = Date.now();

  // ONE PASS over the year's files, fanning rows out to their months. A file
  // is read only when at least one month it can feed is still wanted.
  //
  // NEWEST ACQUISITION FIRST: where two files repeat a bar, the copy kept
  // (the first one seen, below) is then the vendor's latest statement of it.
  // `sort` is stable, so ties keep inventory order and a re-run reads alike.
  const queued = new Set<string>();
  const toRead = wanted
    .flatMap((m) => m.files)
    .filter((f) =>
      queued.has(f.archiveKey) ? false : queued.add(f.archiveKey),
    )
    .sort((a, b) => b.acquiredAt.getTime() - a.acquiredAt.getTime());

  for (const file of toRead) {
    const stream = await downloadStream(file.archiveKey);
    if (stream === null) {
      // A vendor file the inventory vouches for and the bucket does not hold
      // is a REAL gap, not a quiet one: every month it feeds is short.
      throw new Error(
        `archived object missing: ${file.archiveKey}. The inventory says it ` +
          `is verified, so this is a bucket or credentials problem — ` +
          `continuing would load a month that is silently incomplete.`,
      );
    }
    counters.filesRead++;

    let cols: ReturnType<typeof parseOhlcvHeader> | null = null;
    let extra = { instrumentId: -1, publisherId: -1 };
    // BOTH CLOCKS ARE READ ONCE PER FILE, not per row. `observed_at` is the
    // vendor's own acquisition instant (never `now`, or it collapses into
    // `ingested_at` and back-dates the backfill to today — lake-layout.md §6),
    // and `ingested_at` is this run's. 151.5M `Date.now()` calls is a cost
    // with no answer to show for it: every row of one file is written once.
    const observedAtMs = file.acquiredAt.getTime();
    const objectUri = `gs://${bucketForPrefix(file.archiveKey, args.env)}/${file.archiveKey}`;

    // `downloadStream` is typed `NodeJS.ReadableStream` and GCS returns a real
    // `Readable`; `zstdLines` needs `.pipe`, which both have.
    for await (const line of zstdLines(stream as unknown as Readable)) {
      if (cols === null) {
        cols = parseOhlcvHeader(line);
        extra = optionalColumns(line);
        continue;
      }
      counters.rowsRead++;

      // ONE RFC-4180 scan per row, shared with the parser. Two scans over
      // 151.5M rows is a measurable cost for two provenance columns.
      const cells = splitCsvLine(line);
      const parsed = parseOhlcvRow(line, cols, cells);
      if ("rejected" in parsed) {
        if (parsed.rejected === "fields") counters.droppedFields++;
        else if (parsed.rejected === "timestamp") counters.droppedTimestamp++;
        else if (parsed.rejected === "price") counters.droppedPrice++;
        else counters.droppedSymbolField++;
        continue;
      }

      const ts = new Date(parsed.tsMs);
      // THE ET SESSION DATE, never a UTC slice. Under EST the post-market tail
      // is the next UTC day and also the same UTC day as the following
      // session's pre-market.
      const sessionDate = usMarketDateKey(ts);
      const stage = wantedByMonth.get(monthKeyOf(sessionDate));
      if (stage === undefined) continue;

      const ourSymbol = fromDatabentoSymbol(parsed.symbol);
      // ONE COPY OF A BAR, in a month whose files can repeat one
      // (`filesMayOverlap`) — the H1 append re-buys from 2026-09-09 nightly,
      // so that session arrives nine times. `trade_bar_*` has no unique key and
      // the coverage gate counts SESSIONS, so nothing after this line would
      // notice a month loaded nine times over. Keyed BEFORE listing
      // resolution, so a repeated unresolvable bar quarantines once.
      //
      // ponytail: a Set per flagged month, ~100 B a bar — ~75 MB for H1's
      // 2026-09, the only month that flags today. An M1 month is ~3.6M bars
      // (~360 MB), so if several M1 months ever flag at once, load them one
      // `--month` at a time rather than letting twelve Sets share the 4Gi.
      if (stage.seen !== null) {
        const key = `${ourSymbol}|${parsed.tsMs}`;
        if (stage.seen.has(key)) {
          counters.duplicateRows++;
          continue;
        }
        stage.seen.add(key);
      }
      const resolution = resolveListingForDate(listings.get(ourSymbol), ts);
      if (!resolution.ok) {
        counters.quarantined++;
        ledger.add(ourSymbol, resolution.reason, ts);
        continue;
      }

      await stager.add(
        stage,
        toTradeBarRow(
          {
            market: MARKET,
            listingId: resolution.listing.listingId,
            symbol: ourSymbol,
            exchange: resolution.listing.exchange,
            sourceInstrumentId: intCell(cells, extra.instrumentId),
            publisherId: intCell(cells, extra.publisherId),
            tsMs: parsed.tsMs,
            sessionDate,
            open: parsed.open,
            high: parsed.high,
            low: parsed.low,
            close: parsed.close,
            volume: parsed.volume,
            source: DATABENTO_SOURCE,
          },
          {
            sourceObjectUri: objectUri,
            pipelineRunId: runId,
            observedAtMs,
            ingestedAtMs,
          },
        ),
      );
      stage.sessions.add(sessionDate);
      counters.rowsMapped++;
    }

    if (cols === null) {
      throw new TypeError(
        `${file.archiveKey} produced no header line. An empty archive object ` +
          `is a download failure, not an empty market.`,
      );
    }
  }

  const summary = ledger.summary();
  if (summary.quarantinedRows > 0) {
    log.warn(
      `quarantined ${summary.quarantinedRows} row(s) across ${summary.quarantinedSymbols} symbol(s)`,
    );
  }
  if (counters.duplicateRows > 0) {
    log.warn(
      `dropped ${counters.duplicateRows} repeated bar(s) across overlapping ` +
        `vendor files, keeping the newest acquisition's copy — the source is ` +
        `re-delivering sessions (an append whose high-water mark is not moving)`,
    );
  }

  for (const month of wanted) {
    await stager.flush(month);
    await finishMonth({
      month,
      dataset,
      table,
      parserVersion: TRADE_BAR_PARSER_VERSION,
      runId,
      apply: args.apply,
      sourceUri: stager.sourceUri(month),
      quarantineSample: summary.sample.slice(0, 5),
      counters,
    });
  }

  warnIfLeased(log, "month partition", counters.monthsLeased);
  return counters;
}

/* ─────────────────────────────────────────────────────────────────────────
   Purge -> load -> accept, shared by both modes
   ──────────────────────────────────────────────────────────────────────── */

async function finishMonth(args: {
  month: MonthStage;
  dataset: string;
  table: string;
  parserVersion: string;
  runId: string;
  apply: boolean;
  sourceUri: string;
  quarantineSample: unknown;
  counters: { monthsAccepted: number; monthsRejected: number };
}): Promise<void> {
  const { month } = args;
  const key = {
    dataset: args.dataset,
    table: args.table,
    partitionKey: month.partitionKey,
    sourceHash: month.sourceHash,
    parserVersion: args.parserVersion,
  };

  if (!args.apply) {
    log.info(
      `  ${month.monthKey}: would load ${month.rows} row(s) over ${month.sessions.size}/${month.expected} session(s) [DRY RUN]`,
    );
    return;
  }

  if (month.objects === 0) {
    args.counters.monthsRejected++;
    await rejectPartition(key, { runId: args.runId, rowCount: 0 });
    await quarantine({
      dataset: args.dataset,
      table: args.table,
      partitionKey: month.partitionKey,
      runId: args.runId,
      reason: "no rows staged for a month inside the purchased window",
      sample: {
        expectedSessions: month.expected,
        detail: args.quarantineSample,
      },
    });
    log.error(`  ${month.monthKey}: REJECTED — no rows staged`);
    return;
  }

  // PURGE FIRST. A load job is atomic, but the PAIR (load, accept) is not: a
  // crash between them leaves rows in the table and LOADING in the ledger, and
  // the next run would append a second copy. Deleting the range this load is
  // about to write makes a re-run idempotent wherever the last one died, and
  // it also removes a previous parser version's rows — which `decideClaim`
  // deliberately allows back in.
  const purged = await purgePartitionRange({
    projectId: GCP_PROJECT,
    dataset: args.dataset,
    table: args.table,
    market: MARKET,
    source: DATABENTO_SOURCE,
    // BOTH BOUNDS FROM THE PARTITION KEY, through the same helper the planner
    // uses. A second spelling of "the last day of this month" here is free to
    // disagree with the one that decided what the partition CONTAINS, and the
    // rows between the two would survive a reload.
    fromDate: `${month.monthKey}-01`,
    toDate: lastDateOfMonth(month.monthKey),
  });
  if (purged > 0) {
    log.info(`  ${month.monthKey}: purged ${purged} pre-existing row(s)`);
  }

  // WRAPPED, BECAUSE A FAILED LOAD IS AN ANTICIPATED OUTCOME HERE AND NOT A
  // CRASH — MONEY-1515.
  //
  // `loadNdjson` THROWS `LoadJobFailedError` on `status.errorResult`, and that
  // throw used to propagate past `run()`'s catch — which only does
  // `endRun(FAILED)` and rethrows — with NO `rejectPartition`. The job claims
  // every month UP FRONT (`loadBars`, `buildSpread`), and `CLAIM_LEASE_MS` is
  // six hours, so one bad row stranded up to twelve months for six hours. That
  // is the difference between a retry and a wait, and a NUMERIC rejection
  // (MONEY-1512) is exactly this path.
  //
  // Every other failure this function anticipates — no rows staged, an
  // `outputRows` mismatch, `CoverageRefusedError` — already rejects and
  // quarantines. This one now matches them.
  //
  // CAUGHT BROADLY, not narrowed to `LoadJobFailedError`: whatever went wrong,
  // the claim must be released or the NEXT run cannot re-load. And the PURGE
  // above has already run, so the partition is now EMPTY — which makes a
  // prompt retry more important, not less.
  //
  // CONTINUES rather than rethrowing, so each remaining month gets its own
  // verdict instead of inheriting this one's stranded claim. Nothing is
  // silenced: `monthsRejected` feeds `failed`, which sets `process.exitCode`.
  let result: Awaited<ReturnType<typeof loadNdjson>>;
  try {
    result = await loadNdjson({
      projectId: GCP_PROJECT,
      dataset: args.dataset,
      table: args.table,
      sourceUris: [args.sourceUri],
      jobPrefix: "lake_load_databento_",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    args.counters.monthsRejected++;
    await rejectPartition(key, { runId: args.runId, rowCount: 0 });
    await quarantine({
      dataset: args.dataset,
      table: args.table,
      partitionKey: month.partitionKey,
      runId: args.runId,
      reason: `BigQuery load failed: ${detail}`,
      sample: {
        sourceUri: args.sourceUri,
        stagedRows: month.rows,
        stagedObjects: month.objects,
        // The purge ran first, so the range this partition covers is now
        // empty in the table. Said explicitly: an operator reading this row
        // must know the month is MISSING, not merely unrefreshed.
        purgedBeforeLoad: true,
      },
    });
    log.error(`  ${month.monthKey}: REJECTED — load failed: ${detail}`);
    return;
  }

  // WHAT WE STAGED MUST BE WHAT LANDED. `maxBadRecords: 0` already refuses a
  // partial load, so a mismatch here means the wildcard matched something else
  // — which would ACCEPT a partition holding another run's rows.
  if (result.outputRows !== month.rows) {
    args.counters.monthsRejected++;
    await rejectPartition(key, {
      runId: args.runId,
      rowCount: result.outputRows,
    });
    await quarantine({
      dataset: args.dataset,
      table: args.table,
      partitionKey: month.partitionKey,
      runId: args.runId,
      reason: `load wrote ${result.outputRows} rows, staged ${month.rows}`,
      sample: { jobId: result.jobId, inputFiles: result.inputFiles },
    });
    log.error(
      `  ${month.monthKey}: REJECTED — loaded ${result.outputRows} of ${month.rows}`,
    );
    return;
  }

  try {
    await acceptPartition(key, {
      runId: args.runId,
      rowCount: month.rows,
      expectedSessions: month.expected,
      actualSessions: month.sessions.size,
    });
    args.counters.monthsAccepted++;
    log.info(
      `  ${month.monthKey}: ACCEPTED ${month.rows} row(s), ${month.sessions.size}/${month.expected} session(s)`,
    );
  } catch (err) {
    if (!(err instanceof CoverageRefusedError)) throw err;
    args.counters.monthsRejected++;
    await rejectPartition(key, { runId: args.runId, rowCount: month.rows });
    await quarantine({
      dataset: args.dataset,
      table: args.table,
      partitionKey: month.partitionKey,
      runId: args.runId,
      reason: err.message,
      sample: {
        expected: month.expected,
        actual: month.sessions.size,
        rows: month.rows,
      },
    });
    log.error(`  ${month.monthKey}: REJECTED — ${err.message}`);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Spread cost
   ──────────────────────────────────────────────────────────────────────── */

interface SpreadCounters {
  filesRead: number;
  rowsRead: number;
  sampled: number;
  outsideSession: number;
  unusable: number;
  unknownListing: number;
  collisions: number;
  monthsAccepted: number;
  monthsRejected: number;
  monthsSkipped: number;
  /** Of those, held by ANOTHER run's live lease — work that REMAINS. */
  monthsLeased: number;
}

/**
 * Fold one quote file into the session summaries.
 *
 * Cells are summarised and DROPPED as soon as the stream leaves their session,
 * so at most one session's reservoirs are live. A year of live cells would be
 * ~1 GB of floats.
 */
async function foldSpreadFile(args: {
  archiveKey: string;
  objectUri: string;
  kind: "bbo" | "tbbo";
  listings: ReadonlyMap<string, ListingRow[]>;
  out: Map<string, SpreadDaySummary>;
  counters: SpreadCounters;
  env: LakeEnv;
}): Promise<void> {
  const stream = await downloadStream(args.archiveKey);
  if (stream === null) {
    throw new Error(`archived object missing: ${args.archiveKey}`);
  }
  args.counters.filesRead++;

  const isTbbo = args.kind === "tbbo";
  let cols: ReturnType<typeof parseTbboHeader> | null = null;
  let cells = new Map<string, SpreadDayCell>();
  let currentSession: string | null = null;

  const flush = (): void => {
    for (const cell of cells.values()) {
      const summary = summarizeSpreadDay(cell);
      if (summary === null) continue;
      const key = spreadDayKey(summary.listingId, summary.sessionDate);
      const merged = mergeSpreadSummary(args.out.get(key), summary);
      args.counters.collisions += merged.collisions;
      args.out.set(key, merged.summary);
    }
    cells = new Map();
  };

  for await (const line of zstdLines(stream as unknown as Readable)) {
    if (cols === null) {
      cols = isTbbo ? parseTbboHeader(line) : (parseBboHeader(line) as never);
      continue;
    }
    args.counters.rowsRead++;

    const fields = splitCsvLine(line);
    const row = isTbbo
      ? parseTbboRow(line, cols, fields)
      : parseBboRow(line, cols, fields);
    if ("rejected" in row) {
      args.counters.unusable++;
      continue;
    }

    const sample = spreadSampleFor(row, args.kind);
    if ("rejected" in sample) {
      if (sample.rejected === "outside-session") args.counters.outsideSession++;
      else args.counters.unusable++;
      continue;
    }

    if (sample.sessionDate !== currentSession) {
      flush();
      currentSession = sample.sessionDate;
    }

    const symbol = fromDatabentoSymbol(row.symbol);
    const resolution = resolveListingForDate(
      args.listings.get(symbol),
      new Date(row.tsMs),
    );
    if (!resolution.ok) {
      args.counters.unknownListing++;
      continue;
    }

    const key = spreadDayKey(resolution.listing.listingId, sample.sessionDate);
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = newSpreadDayCell(
        resolution.listing.listingId,
        symbol,
        sample.sessionDate,
      );
      cells.set(key, cell);
    }
    // THE LANE IS DECIDED BY `spreadSampleFor`, NEVER HERE. A tbbo record
    // reaches `effective` only; folding its quote into `quoted` would bias the
    // quoted statistic toward the moments people were trading.
    if (sample.lane === "quoted") {
      cell.quoted.add(sample.valueBps);
      // The object the stored median will have come from. See
      // `SpreadDayCell.quotedObjectUri` — a row is folded from many files and
      // the column has to name one.
      cell.quotedObjectUri = args.objectUri;
    } else {
      cell.effective.add(sample.valueBps);
    }
    args.counters.sampled++;
  }

  flush();
  if (cols === null) {
    throw new Error(
      `${args.archiveKey} produced no header line — an empty or truncated ` +
        `archive object is a download failure, not an empty market.`,
    );
  }
}

/**
 * The summary line for a run that selected nothing — MONEY-1516 review.
 *
 * "Nothing to do" and "nothing I am ALLOWED to do" are opposite states and
 * this job reported them identically. A spread load died holding four claims;
 * the next run printed "every spread month is already ACCEPTED — nothing to
 * do" and exited 0 with `wrote 0`, while the table was EMPTY and the lease had
 * six hours left to run. The per-month lines said "another run claimed it 4m
 * ago" the whole time — the SUMMARY is what lied, and a summary is what an
 * operator reads.
 *
 * A leased skip is therefore reported at WARN and names the remedy, because it
 * is the one state where doing nothing leaves work undone.
 */
/**
 * A LEASED month is reported whether or not anything else loaded.
 *
 * `logEmptySelection` below only speaks when NOTHING was selected, and that is
 * the less likely shape: a load dying on a missing GCP_STORAGE_BUCKET strands
 * whichever months it was holding, not necessarily all of them. A run that
 * loads eleven months and leaves the twelfth behind a dead run's lease would
 * otherwise log it at INFO, fold it into `monthsSkipped`, and exit 0 green —
 * collapsing at the outcome line exactly the distinction the verdict's `kind`
 * exists to make. MONEY-1516 review.
 */
function warnIfLeased(
  log: { warn: (m: string) => void },
  what: string,
  leased: number,
): void {
  if (leased === 0) return;
  log.warn(
    `${leased} ${what}(s) were NOT loaded because another run holds the claim, ` +
      `or held it and died. This is not "up to date" — the work REMAINS. A ` +
      `lease expires after ${CLAIM_LEASE_MS / 3600_000}h and is then reclaimed ` +
      `automatically; to retry sooner, clear the stale LOADING rows for this ` +
      `table from bronze.partition_load.`,
  );
}

function logEmptySelection(
  log: { info: (m: string) => void; warn: (m: string) => void },
  what: string,
  kinds: ReadonlyArray<"accepted" | "leased">,
): void {
  const leased = kinds.filter((k) => k === "leased").length;
  if (leased === 0) {
    log.info(`every ${what} is already ACCEPTED — nothing to do`);
    return;
  }
  log.warn(
    `NOTHING SELECTED, and ${leased} of ${kinds.length} ${what}(s) are LEASED, ` +
      `not accepted — another run holds the claim, or held it and died. This ` +
      `run wrote nothing and the work REMAINS. A lease expires after ` +
      `${CLAIM_LEASE_MS / 3600_000}h and is then reclaimed automatically; to ` +
      `retry sooner, clear the stale LOADING rows for this table from ` +
      `bronze.partition_load.`,
  );
}

async function buildSpread(args: Args, runId: string): Promise<SpreadCounters> {
  const counters: SpreadCounters = {
    filesRead: 0,
    rowsRead: 0,
    sampled: 0,
    outsideSession: 0,
    unusable: 0,
    unknownListing: 0,
    collisions: 0,
    monthsAccepted: 0,
    monthsRejected: 0,
    monthsSkipped: 0,
    monthsLeased: 0,
  };

  const dataset = datasetFor("lake_silver", args.env);
  const bucket = bucketForPrefix("lake/stage/", args.env);

  // THE WINDOW COMES FROM bbo-1m, NEVER FROM tbbo. A row requires a QUOTED
  // sample, so the bbo purchase is what defines coverage; `tbbo-top50` is a
  // strict subset bought over a narrower window and would understate it.
  const window = await openRepo().databentoSchemaWindow("bbo-1m", args.env);
  if (window === null) {
    throw new Error(
      `no DOWNLOADED/LOADED bbo-1m jobs for env ${args.env}: there is no ` +
        `quoted-spread source, so spread_cost_daily has no denominator.`,
    );
  }
  // `end` is EXCLUSIVE on the vendor row; a coverage window is inclusive.
  const entryEndDateKey = new Date(window.end.getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);

  // THE WHOLE ARCHIVE, for the same reason as the bar loader: the
  // trailing-12-month bbo harvest sits under path year 2025 and holds 172
  // sessions of 2026, which the path-year filter this replaced never reached.
  const archive = wholeArchive();
  const bbo = await openRepo().listArchivedFilesBySchema(
    "bbo-1m",
    archive.from,
    archive.to,
    args.env,
  );
  const tbbo = await openRepo().listArchivedFilesBySchema(
    "tbbo",
    archive.from,
    archive.to,
    args.env,
  );

  const planned: { file: ArchivedVendorFile; parts: DatabentoArchiveParts }[] =
    [];
  for (const file of bbo) {
    const parts = parseDatabentoArchiveKey(file.archiveKey);
    if (parts !== null) planned.push({ file, parts });
  }
  if (planned.length === 0) {
    throw new Error(
      `no verified bbo-1m files in the ${args.env} inventory — an empty file ` +
        `set is a broken inventory query, not an empty year.`,
    );
  }

  const months = planStages({
    files: planned,
    schema: "bbo-1m",
    year: args.year,
    partitionKeyFor: (m) => spreadCostPartitionKey(MARKET, m),
    allowedMonths: monthsOfYear(args.year),
    entryStartDateKey: window.start.toISOString().slice(0, 10),
    entryEndDateKey,
    todayDateKey: new Date().toISOString().slice(0, 10),
    onlyMonth: args.onlyMonth,
  });

  log.info(
    `spread ${args.year}: ${bbo.length} bbo + ${tbbo.length} tbbo archived ` +
      `file(s) -> ${months.length} month partition(s)`,
  );

  const wanted: PlannedMonth[] = [];
  const skipKinds: Array<"accepted" | "leased"> = [];
  for (const month of months) {
    if (!args.apply) {
      log.info(
        `  ${month.monthKey}: expect ${month.expected} session(s) [DRY RUN]`,
      );
      wanted.push(month);
      continue;
    }
    const verdict = await claimPartition(
      {
        dataset,
        table: SPREAD_TABLE,
        partitionKey: month.partitionKey,
        sourceHash: month.sourceHash,
        parserVersion: SPREAD_COST_PARSER_VERSION,
      },
      { runId },
    );
    if (verdict.action === "skip") {
      counters.monthsSkipped++;
      skipKinds.push(verdict.kind);
      if (verdict.kind === "leased") counters.monthsLeased++;
      log.info(`  ${month.monthKey}: skip — ${verdict.reason}`);
      continue;
    }
    wanted.push(month);
  }
  if (wanted.length === 0) {
    logEmptySelection(log, "spread month", skipKinds);
    return counters;
  }

  const listings = buildListingIndex(
    (await openRepo().fetchListingRows()) as unknown as ListingRow[],
  );
  const out = new Map<string, SpreadDaySummary>();

  // TWO PASSES, bbo FIRST. The order does not change the arithmetic —
  // `mergeSpreadSummary` combines per LANE — but it means a tbbo-only cell is
  // never in `out` to be dropped later, and the counters read in the order an
  // operator reasons about them.
  const seen = new Set<string>();
  for (const file of wanted.flatMap((m) => m.files)) {
    if (seen.has(file.archiveKey)) continue;
    seen.add(file.archiveKey);
    await foldSpreadFile({
      archiveKey: file.archiveKey,
      objectUri: `gs://${bucketForPrefix(file.archiveKey, args.env)}/${file.archiveKey}`,
      kind: "bbo",
      listings,
      out,
      counters,
      env: args.env,
    });
  }
  // tbbo is not planned (it never sets the denominator), so its files are
  // picked by the SAME month rule the planner applies to bbo: fold a file only
  // when a month it can feed is being written.
  const wantedMonths = new Set(wanted.map((m) => m.monthKey));
  const throughMonth = monthKeyOf(entryEndDateKey);
  for (const file of tbbo) {
    const parts = parseDatabentoArchiveKey(file.archiveKey);
    if (parts === null) continue;
    if (
      !monthsForArchiveFile(parts, throughMonth).some((m) =>
        wantedMonths.has(m),
      )
    ) {
      continue;
    }
    await foldSpreadFile({
      archiveKey: file.archiveKey,
      objectUri: `gs://${bucketForPrefix(file.archiveKey, args.env)}/${file.archiveKey}`,
      kind: "tbbo",
      listings,
      out,
      counters,
      env: args.env,
    });
  }

  const stager = new Stager({
    bucket,
    table: SPREAD_TABLE,
    runId,
    apply: args.apply,
  });
  const wantedByMonth = new Map(wanted.map((m) => [m.monthKey, m]));
  const ingestedAtMs = Date.now();
  // The NEWEST contributing acquisition, so `observed_at` is a source clock
  // rather than ours. A summary is folded from many files; the latest of them
  // is the instant by which every input had been asserted.
  const observedAtMs = Math.max(
    ...wanted.flatMap((m) => m.files.map((f) => f.acquiredAt.getTime())),
  );

  for (const summary of out.values()) {
    const stage = wantedByMonth.get(monthKeyOf(summary.sessionDate));
    if (stage === undefined) continue;
    const row: SpreadCostRow = toSpreadCostRow(summary, {
      market: MARKET,
      source: DATABENTO_SOURCE,
      parserVersion: SPREAD_COST_PARSER_VERSION,
      pipelineRunId: runId,
      observedAtMs,
      ingestedAtMs,
    });
    await stager.add(stage, row);
    stage.sessions.add(summary.sessionDate);
  }

  for (const month of wanted) {
    await stager.flush(month);
    await finishMonth({
      month,
      dataset,
      table: SPREAD_TABLE,
      parserVersion: SPREAD_COST_PARSER_VERSION,
      runId,
      apply: args.apply,
      sourceUri: stager.sourceUri(month),
      quarantineSample: { collisions: counters.collisions },
      counters,
    });
  }

  warnIfLeased(log, "spread month", counters.monthsLeased);
  return counters;
}

/* ─────────────────────────────────────────────────────────────────────────
   Entry point
   ──────────────────────────────────────────────────────────────────────── */

async function run(): Promise<void> {
  await initJobTelemetry();
  reportBuildProvenance(log, JOB);

  const args = parseArgs(process.argv.slice(2));

  // PIN, THEN LOAD THE MONGO HALF — MONEY-1514/1515, and the ORDER is the
  // whole fix. `pinJobEnv` resolves `DATABASE_URL` from Secret Manager for
  // THIS `--env` and sets `LAKE_ENV` / `LAKE_PROJECT` / `GCP_PROJECT_ID` to
  // match; `databento-repo` is only then allowed to build its Prisma
  // singleton, from the URI `--env` named rather than from whatever the shell
  // carried. See `openRepo` for why a static import plus a pin does not work.
  //
  // `LAKE_ENV` matters here beyond Mongo, and this job was the ONLY lake job
  // that never set it. Its SILVER dataset comes from `--env`
  // (`datasetFor("lake_silver", args.env)`) while its LEDGER dataset comes
  // from `lakeConfig()` reading the ambient `LAKE_ENV` — so `LAKE_ENV=qa` in
  // the shell plus `--env prod` wrote prod silver rows against a QA bronze
  // ledger, and prod's ledger then said the partition was never loaded,
  // permanently. `pinJobEnv` is the single writer of it; a second
  // `process.env.LAKE_ENV = args.env` beside this would be one fact with two
  // spellings.
  pinJobEnv(args.env);
  repo = await import("@usemoney/core/market-data/databento/databento-repo");

  const startedAt = new Date();
  const runId = buildRunId(JOB, startedAt.getTime());

  log.info(
    `${JOB} env=${args.env} schema=${args.mode} year=${args.year} ` +
      `${args.apply ? "APPLY" : "DRY RUN"} run=${runId}`,
  );

  if (args.apply) {
    await beginRun({
      runId,
      job: JOB,
      gitSha: process.env.DD_VERSION ?? null,
      startedAt,
    });
  }

  let selected = 0;
  let written = 0;
  let failed = 0;
  try {
    if (args.mode === "spread") {
      const c = await buildSpread(args, runId);
      selected = c.monthsAccepted + c.monthsRejected + c.monthsSkipped;
      written = c.monthsAccepted;
      failed = c.monthsRejected;
      log.info(JSON.stringify(c));
    } else {
      const c = await loadBars(args, runId);
      selected = c.monthsAccepted + c.monthsRejected + c.monthsSkipped;
      written = c.monthsAccepted;
      failed = c.monthsRejected;
      log.info(JSON.stringify(c));
    }
    if (args.apply) {
      await endRun({
        runId,
        status: failed > 0 ? "FAILED" : "SUCCESS",
        finishedAt: new Date(),
        rowsOut: written,
        rowsRejected: failed,
      });
    }
  } catch (err) {
    if (args.apply) {
      await endRun({
        runId,
        status: "FAILED",
        finishedAt: new Date(),
        notes: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined);
    }
    throw err;
  }

  // `selected` counts every month the run CONSIDERED, skips included: a run
  // that selected nothing is the defect an absence monitor exists to catch,
  // and folding a fully-loaded year's skips out would make it indistinguishable
  // from a query that matched no files (MONEY-1215).
  reportJobOutcome({ job: JOB, selected, written, failed });

  // MANDATORY: `datadog-metrics` batches on a 15s timer, so a job that reports
  // and exits immediately takes its counters with it (MONEY-1278).
  await flushMetrics();

  if (failed > 0) process.exitCode = 1;
}

guardCompletion(JOB, run()).catch((err) => {
  log.error("FATAL", err);
  process.exit(1);
});
