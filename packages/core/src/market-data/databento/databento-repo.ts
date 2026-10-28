/**
 * The Databento inventory and candle writes, over Prisma — MONEY-1373.
 *
 * The seam between the pure decision modules and the database. It lives in
 * `packages/core` rather than in either job script because BOTH scripts need
 * all of it: the harvest buys history and the append extends it, and the two
 * differ in which windows they ask for, not in how a purchase is recorded or
 * how a session is written. Two copies of the ledger deps would be two places
 * for the month's spend to be summed differently.
 *
 * `candle-repository.ts` already imports Prisma in this package, so this
 * introduces no new dependency direction.
 */

import { prisma } from "@usemoney/database";

import {
  candleRepository,
  readColdShard,
  writeColdShard,
  type CandleWriteRow,
} from "../candles";
import { fileSessionDate } from "./databento-logic";
import { bucketForPrefix, type LakeEnv } from "../../ops/lake-layout";
import type { DatabentoJob } from "./databento-logic";
import type {
  BudgetKey,
  DatabentoBudgetDeps,
  DatabentoJobRow,
} from "./databento-budget";
import type { SessionWriterDeps } from "./databento-session-writer";
// MONEY-1470 (A5) — the intraday ring buffer the chart reads.
import { appendBars } from "../intraday/intraday-store";

/* ─────────────────────────────────────────────────────────────────────────
   The per-file inventory
   ──────────────────────────────────────────────────────────────────────── */

/**
 * One entry of `DatabentoBatchJob.files`.
 *
 * `verified` and `loadedAt` are SEPARATE facts. A file whose checksum matched
 * is downloaded; a file that produced rows is loaded. A run that conflated them
 * would re-download every file it had merely not finished loading — paying the
 * vendor again for bytes already sitting in the archive.
 */
export interface DatabentoFileRecord {
  filename: string;
  size: number;
  sha256: string;
  archiveKey: string;
  kind: "data" | "support";
  verified: boolean;
  loadedRows?: number;
  loadedAt?: string;
  detail?: string;
}

/** The `files` column, which is `Json` and therefore `unknown` at the type level. */
export function readFileRecords(raw: unknown): DatabentoFileRecord[] {
  return Array.isArray(raw) ? (raw as DatabentoFileRecord[]) : [];
}

/* ─────────────────────────────────────────────────────────────────────────
   The budget ledger
   ──────────────────────────────────────────────────────────────────────── */

function budgetWhere(key: BudgetKey) {
  return {
    purpose: key.purpose,
    entryId: key.entryId,
    schema: key.schema,
    symbolsHash: key.symbolsHash,
    start: key.start,
    end: key.end,
  };
}

const JOB_ROW_SELECT = {
  id: true,
  jobId: true,
  state: true,
  costUsd: true,
  costUsdQuoted: true,
} as const;

/**
 * The ledger the budget guard reads and writes.
 *
 * `symbolSetLabel` is a getter rather than a field: the label belongs to the
 * CHUNK being created and changes on every call, while the guard's `deps` are
 * built once. The identity of a purchase is `symbolsHash`; this is only what an
 * operator reads.
 */
export function createBudgetDeps(args: {
  env: string;
  symbolSetLabel: () => string;
  now?: () => Date;
}): DatabentoBudgetDeps {
  return {
    async findExistingJob(key: BudgetKey): Promise<DatabentoJobRow | null> {
      const row = await prisma.databentoBatchJob.findFirst({
        where: budgetWhere(key),
        select: JOB_ROW_SELECT,
      });
      return row ?? null;
    },

    /**
     * The same purchase IGNORING the window bounds.
     *
     * Scoped to this environment, unlike the exact-window lookup: after a
     * prod->QA sync QA's ledger IS prod's, and a QA re-run must not reuse a
     * prod purchase whose archived bytes QA cannot read.
     */
    async findEntryPurchase(
      key: Omit<BudgetKey, "start" | "end">,
    ): Promise<DatabentoJobRow | null> {
      const row = await prisma.databentoBatchJob.findFirst({
        where: {
          purpose: key.purpose,
          entryId: key.entryId,
          schema: key.schema,
          symbolsHash: key.symbolsHash,
          env: args.env,
        },
        orderBy: { createdAt: "asc" },
        select: JOB_ROW_SELECT,
      });
      return row ?? null;
    },

    /**
     * Σ over the month, preferring the ACTUAL cost and falling back to the
     * quote.
     *
     * `costUsd` is NULL until the vendor has processed a job, so summing the
     * actual column alone would read ZERO for a month whose jobs are all still
     * queued — and a budget that reads zero authorises everything. The quote is
     * the conservative stand-in until the real number lands. FAILED rows are
     * excluded because a submission that threw bought nothing.
     */
    async sumMonthSpendUsd(window: { fromMs: number; toMs: number }) {
      const rows = await prisma.databentoBatchJob.findMany({
        where: {
          submittedAt: {
            gte: new Date(window.fromMs),
            lt: new Date(window.toMs),
          },
          state: { not: "FAILED" },
          // SCOPED TO THIS ENVIRONMENT. `databento_batch_jobs` is a
          // REFERENCE_COLLECTION, so after a prod->QA sync QA's ledger IS
          // prod's — and without this filter a QA probe sums prod's month and
          // is refused with a message quoting prod's numbers. `env` is written
          // on every row by `createQuotedJob` and the docs already claimed this
          // filter existed ("so one ledger can hold both environments'
          // purchases without them summing together"); it did not.
          env: args.env,
        },
        select: { costUsd: true, costUsdQuoted: true },
      });
      return rows.reduce((sum, r) => sum + (r.costUsd ?? r.costUsdQuoted), 0);
    },

    async createQuotedJob(
      spec: BudgetKey & {
        dataset: string;
        symbolCount: number;
        costUsdQuoted: number;
        splitSymbols: boolean;
        splitDuration: string;
        reclaimRowId: string | null;
      },
    ): Promise<DatabentoJobRow> {
      const data = {
        ...budgetWhere(spec),
        dataset: spec.dataset,
        symbolSet: args.symbolSetLabel(),
        symbolCount: spec.symbolCount,
        costUsdQuoted: spec.costUsdQuoted,
        // Recorded at PURCHASE time. See the schema comment: this is the
        // only place the shape is knowable for certain, and a later manifest
        // correction must not change the answer for a row already bought.
        splitSymbols: spec.splitSymbols,
        splitDuration: spec.splitDuration,
        state: "QUOTED",
        env: args.env,
      };
      // A stale QUOTED/FAILED row for this purchase is RE-ARMED in place — an
      // insert beside it violates the window's @@unique (MONEY-1539).
      if (spec.reclaimRowId !== null) {
        return prisma.databentoBatchJob.update({
          where: { id: spec.reclaimRowId },
          data: { ...data, detail: null },
          select: JOB_ROW_SELECT,
        });
      }
      return prisma.databentoBatchJob.create({
        data: { ...data, files: [] },
        select: JOB_ROW_SELECT,
      });
    },

    async markSubmitted(rowId: string, job: DatabentoJob) {
      await prisma.databentoBatchJob.update({
        where: { id: rowId },
        data: {
          jobId: job.id,
          state: "SUBMITTED",
          // The VENDOR's receipt time when it gave one. Expiry counts 30 days
          // from submission, so an inaccurate stamp here shortens or lengthens
          // a deadline that cannot be renegotiated.
          submittedAt: job.tsReceived ? new Date(job.tsReceived) : new Date(),
          tsExpiration: job.tsExpiration ? new Date(job.tsExpiration) : null,
          costUsd: job.costUsd,
        },
      });
    },

    async markFailed(rowId: string, detail: string) {
      await prisma.databentoBatchJob.update({
        where: { id: rowId },
        data: { state: "FAILED", detail: detail.slice(0, 2000) },
      });
    },

    now: args.now ?? (() => new Date()),
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   The candle writer
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The session writer's database half.
 *
 * `deleteSessionRows` is the DISPLACEMENT half and must never widen: it is
 * handed exactly the sources `decideSessionWrite` judged weaker, and the same
 * query without that `in` clause would delete the incoming source's own earlier
 * rows alongside the ones being replaced. An empty source list deletes nothing
 * rather than everything — the direction that matters.
 */
export function createSessionWriterDeps(
  now: () => Date = () => new Date(),
): SessionWriterDeps {
  return {
    /**
     * MONEY-1470 (A5) — mirror M1 bars into the intraday ring buffer.
     *
     * `appendBars` swallows its own Redis errors and returns false, so a
     * buffer outage costs a slow chart and never a warehouse row — the
     * warehouse write has already happened by the time this is called.
     */
    async appendIntradayBuffer(args: {
      listingId: string;
      bars: readonly {
        tsSeconds: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }[];
    }) {
      return appendBars(
        "US",
        args.listingId,
        args.bars.map((b) => ({
          bar: [b.tsSeconds, b.open, b.high, b.low, b.close, b.volume] as const,
          basis: "trade" as const,
        })),
      );
    },

    async findExistingSources(args: {
      symbol: string;
      timeframe: string;
      startMs: number;
      endMs: number;
    }) {
      const rows = await prisma.candle.findMany({
        where: {
          symbol: args.symbol,
          timeframe: args.timeframe,
          ts: { gte: new Date(args.startMs), lt: new Date(args.endMs) },
        },
        select: { source: true },
        distinct: ["source"],
      });
      return rows.map((r) => r.source);
    },

    async deleteSessionRows(args: {
      symbol: string;
      timeframe: string;
      startMs: number;
      endMs: number;
      sources: readonly string[];
    }) {
      if (args.sources.length === 0) return 0;
      const res = await prisma.candle.deleteMany({
        where: {
          symbol: args.symbol,
          timeframe: args.timeframe,
          ts: { gte: new Date(args.startMs), lt: new Date(args.endMs) },
          source: { in: [...args.sources] },
        },
      });
      return res.count;
    },

    putCandles: (rows: readonly CandleWriteRow[]) =>
      candleRepository.putCandles(rows),
    readColdShard,
    writeColdShard,
    now,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Symbol and listing populations
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The `MASTER` symbol set: ACTIVE equities and ETFs.
 *
 * Mutual funds (venue NMFQS) are excluded because a fund carries a NAV, not an
 * intraday bar — a fund in a Databento request buys nothing. There are ~27,000
 * of them against ~14,000 equities and ETFs, so including them would not merely
 * waste a slot, it would dominate the chunking and roughly triple the number of
 * jobs submitted.
 */
export async function fetchMasterSymbols(): Promise<string[]> {
  const rows = await prisma.usInstrument.findMany({
    where: { listingStatus: "ACTIVE", assetType: { in: ["Stock", "ETF"] } },
    select: { symbol: true },
  });
  return rows.map((r) => r.symbol);
}

/**
 * Every equity/ETF listing, ACTIVE and DELISTED.
 *
 * Both statuses, deliberately. A 2023 bar belongs to whoever held the ticker in
 * 2023, and `resolveListingForDate` picks by occupancy window — narrowing to
 * ACTIVE here would hand a delisted predecessor's bars to its successor, which
 * is the `DOW` case (Dow Chemical 1972-2017, Dow Inc. 2019-) that the whole
 * `listingId` design exists for.
 */
export async function fetchListingRows() {
  return prisma.usInstrument.findMany({
    where: { assetType: { in: ["Stock", "ETF"] } },
    select: {
      symbol: true,
      exchange: true,
      listingId: true,
      listingStartDate: true,
      listingEndDate: true,
      listingStatus: true,
    },
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   ET session coverage
   ──────────────────────────────────────────────────────────────────────── */

/**
 * `$dateToString` in America/New_York, never a UTC slice.
 *
 * Under EST the post-market runs to 20:00 ET, which is the NEXT UTC day and
 * also the UTC day of the following session's pre-market. A UTC slice therefore
 * spans the tail of one session and the head of the next and OVER-counts
 * distinct days — in exactly the direction that hides a gap.
 */
const ET_DAY = {
  $dateToString: {
    date: "$ts",
    format: "%Y-%m-%d",
    timezone: "America/New_York",
  },
} as const;

/**
 * REFUSES `D1`, and the refusal is the point.
 *
 * A daily bar is stamped at UTC MIDNIGHT of its session, so converting it to
 * America/New_York lands it at 19:00 or 20:00 the PREVIOUS evening and files
 * every bar one session early. Measured on QA: `NGIF`'s D1 rows bucket to
 * 2026-08-04 for the 2026-08-05 session.
 *
 * Nothing calls it with D1 today — the coverage step runs only on the loadable
 * intraday schemas — but the shift produces a plausible, complete-looking
 * report that is uniformly off by one, which is exactly the class of wrongness
 * a number cannot reveal.
 */
function assertIntradayTimeframe(timeframe: string): void {
  if (timeframe === "D1") {
    throw new RangeError(
      "Databento coverage is an INTRADAY measurement and cannot be taken over " +
        "D1. A daily bar is stamped at UTC midnight, so the ET bucketing this " +
        "uses would file every bar one session early — a report that looks " +
        "complete and is uniformly wrong.",
    );
  }
}

function coverageMatch(args: {
  timeframe: string;
  source: string;
  startMs: number;
  endMs: number;
  symbol?: string;
}) {
  assertIntradayTimeframe(args.timeframe);
  return {
    ...(args.symbol === undefined ? {} : { symbol: args.symbol }),
    timeframe: args.timeframe,
    source: args.source,
    // ISO STRINGS, not `{ $date: <millis> }`. Prisma's `$runCommandRaw`
    // serialises through Extended JSON RELAXED mode, where `$date` takes a
    // string; a number reaches the driver as "Failed to convert 'JSON' to
    // 'BSON'" — an error that names neither the field nor the shape, and that
    // only appears once a real database is attached.
    ts: {
      $gte: { $date: new Date(args.startMs).toISOString() },
      $lt: { $date: new Date(args.endMs).toISOString() },
    },
  };
}

interface RawCursorReply<T> {
  cursor?: { firstBatch?: T[]; id?: unknown };
}

/**
 * How many documents one aggregation may return.
 *
 * Sized against the real populations with headroom: ~14,000 distinct US
 * listings, ~850 sessions in the harvest range. The number is a REFUSAL
 * threshold, not a page size — see below.
 */
export const AGGREGATE_MAX_DOCS = 200_000;

/**
 * Run an aggregation and REFUSE a partial answer.
 *
 * `$runCommandRaw` returns the server's FIRST BATCH — 101 documents by default
 * — plus a non-zero cursor id, and nothing warns. Every aggregation in this
 * file read `cursor.firstBatch` and stopped there. Measured on QA: 101 of
 * 14,098 distinct symbols, and 101 of a symbol's ~850 session dates.
 *
 * That is the MONEY-1189 shape at its purest, because the truncation is SILENT
 * and SELF-CONSISTENT: the coverage report's denominator shrank to match its
 * numerator, so a 507-symbol entry rendered as "101 symbol(s), 0 incomplete"
 * and read as perfect coverage. One of the two callers even documented itself
 * as "bounded by construction" — it was bounded to 101.
 *
 * WHY A BIG BATCH RATHER THAN PAGING. Two paging routes were tried and both
 * are worse here:
 *   - `getMore` is unusable through Prisma. A cursor id is a 64-bit long and
 *     JS mangles it above 2^53 — `7216085886256287000` came back as
 *     `CursorNotFound` on the very first continuation, measured.
 *   - `$skip`/`$limit` pages re-run the whole `$group` for every page, which
 *     for a group over millions of candle rows costs more than the query it
 *     is paging.
 * So one batch, sized past the real populations, and a THROW when the server
 * still has more. A loud failure telling the caller to narrow the window is
 * the one outcome that cannot be mistaken for complete coverage.
 */
async function aggregateAll<T>(
  collection: string,
  pipeline: unknown[],
  opts: { allowDiskUse?: boolean } = {},
): Promise<T[]> {
  const reply = (await prisma.$runCommandRaw({
    aggregate: collection,
    pipeline,
    cursor: { batchSize: AGGREGATE_MAX_DOCS },
    ...(opts.allowDiskUse ? { allowDiskUse: true } : {}),
  } as never)) as RawCursorReply<T>;

  const rows = reply.cursor?.firstBatch ?? [];
  const cursorId = String(reply.cursor?.id ?? "0");
  if (cursorId !== "0") {
    throw new Error(
      `aggregateAll(${collection}): the server returned ${rows.length} ` +
        `document(s) and kept the cursor open, so this result is PARTIAL. ` +
        "Refusing to return it — a short answer here reads as complete " +
        "coverage, which is exactly the failure this function exists to " +
        "prevent. Narrow the window and run again.",
    );
  }
  return rows;
}

/**
 * DISTINCT ET session COUNT per symbol, computed in the database.
 *
 * Counts rather than collects. Collecting the date arrays for every symbol in
 * one aggregation is ~90 MB at MASTER scale against a 16 MB BSON ceiling, and
 * it would not fail cleanly — it would fail at whichever symbol crossed the
 * line, having already done most of the work.
 */
export async function countSessionsPerSymbol(args: {
  timeframe: string;
  source: string;
  startMs: number;
  endMs: number;
}): Promise<Map<string, number>> {
  const rows = await aggregateAll<{ _id: string; present: number }>(
    "candles",
    [
      { $match: coverageMatch(args) },
      { $group: { _id: { symbol: "$symbol", day: ET_DAY } } },
      { $group: { _id: "$_id.symbol", present: { $sum: 1 } } },
    ],
    { allowDiskUse: true },
  );
  const out = new Map<string, number>();
  for (const row of rows) out.set(row._id, row.present);
  return out;
}

/** Every ET session date ONE symbol has, with the cursor fully drained. */
export async function listSessionsForSymbol(args: {
  symbol: string;
  timeframe: string;
  source: string;
  startMs: number;
  endMs: number;
}): Promise<string[]> {
  const rows = await aggregateAll<{ _id: string }>("candles", [
    { $match: coverageMatch(args) },
    { $group: { _id: ET_DAY } },
  ]);
  return rows.map((r) => r._id);
}

/* ─────────────────────────────────────────────────────────────────────────
   The cost model's database half
   ──────────────────────────────────────────────────────────────────────── */

/** The latest model version, for `shouldRebuildCostModel`. */
export async function latestCostModelVersion(): Promise<{
  modelVersion: number;
  builtAt: Date;
  status: string;
} | null> {
  return prisma.usCostModelVersion.findFirst({
    orderBy: { modelVersion: "desc" },
    select: { modelVersion: true, builtAt: true, status: true },
  });
}

/**
 * The archived `bbo-1m` files inside a window, oldest first.
 *
 * `DOWNLOADED` and `LOADED` both qualify. `bbo-1m` is archive-only — it never
 * becomes a candle — so its rows normally stop at `DOWNLOADED`; accepting
 * `LOADED` too costs nothing and stops a future state change from silently
 * emptying this query, which would have the builder refuse with "no archived
 * files" on a warehouse that has them.
 */
export async function listArchivedFilesBySchema(
  schema: string,
  from: Date,
  to: Date,
  env?: string,
): Promise<ArchivedVendorFile[]> {
  const rows = await prisma.databentoBatchJob.findMany({
    where: {
      schema,
      ...(env === undefined ? {} : { env }),
      state: { in: ["DOWNLOADED", "LOADED"] },
      start: { lt: to },
      end: { gt: from },
    },
    orderBy: { start: "asc" },
    // `downloadedAt` and `end` are the two SOURCE clocks available for a
    // silver row's `observed_at` (MONEY-1505). Without one of them a loader
    // stamps `Date.now()`, which collapses observed into ingested and
    // back-dates every backfill to today — lake-layout.md §6.
    select: { jobId: true, files: true, downloadedAt: true, end: true },
  });
  // FILTERED PER FILE, not only per row.
  //
  // The `where` above selects any JOB the window touches, and a job is not a
  // day: `tbbo-top50` is one 12-month row carrying ~250 daily files. Returning
  // every file of a matched row made the caller's window inert — a 92-day
  // request folded 12 months, which is four times the work the sizing was
  // done against and hours past the append's task timeout.
  //
  // A file whose name carries no date is INCLUDED: "we cannot tell" must not
  // become "drop it". Today that is only a single-file, unsplit job.
  const fromKey = from.toISOString().slice(0, 10);
  const toKey = to.toISOString().slice(0, 10);
  const out: ArchivedVendorFile[] = [];
  for (const row of rows) {
    if (row.jobId === null) continue;
    for (const file of readFileRecords(row.files)) {
      if (file.kind !== "data" || !file.verified) continue;
      const day = fileSessionDate(file.filename);
      if (day !== null && (day < fromKey || day >= toKey)) continue;
      out.push({
        jobId: row.jobId,
        archiveKey: file.archiveKey,
        // WHEN THE SOURCE ASSERTED IT. `downloadedAt` is when the vendor's
        // completed file reached us; `end` is the exclusive end of the window
        // it covers, which is the earliest instant the whole file could have
        // existed. Never `now` — see the select above.
        acquiredAt: row.downloadedAt ?? row.end,
        // MONEY-1505 — the lake loader's ledger key needs WHICH BYTES, not
        // merely which name. `sha256` is the vendor's own manifest checksum,
        // already verified on download, so a re-issued file with corrected
        // data produces a different source hash and re-loads rather than
        // skipping. Additive: the cost model destructures only the first two.
        filename: file.filename,
        sha256: file.sha256,
        size: file.size,
      });
    }
  }
  return out;
}

/** One archived vendor file, as the inventory records it. */
export interface ArchivedVendorFile {
  jobId: string;
  archiveKey: string;
  /** When the SOURCE asserted it — never our own clock. */
  acquiredAt: Date;
  filename: string;
  sha256: string;
  size: number;
}

/**
 * The window a SCHEMA was actually bought over — the coverage denominator's
 * outer bound. MONEY-1505.
 *
 * `null` when nothing was bought, and the caller must treat that as a refusal
 * rather than as an empty range: a loader that computed "expect 0 sessions"
 * would ACCEPT an empty partition for ever, which is the one thing
 * `decideCoverage` exists to prevent.
 *
 * It asks the VENDOR ROWS rather than the data, because a denominator derived
 * from what arrived can only ever report 100% coverage — the
 * wrong-granularity-completeness defect this repo has shipped five times.
 *
 * `end` is EXCLUSIVE, matching `DatabentoBatchJob.end` and Databento's own
 * convention.
 */
export async function databentoSchemaWindow(
  schema: string,
  env: string,
): Promise<{ start: Date; end: Date } | null> {
  const rows = await prisma.databentoBatchJob.findMany({
    where: { schema, env, state: { in: ["DOWNLOADED", "LOADED"] } },
    select: { start: true, end: true },
  });
  if (rows.length === 0) return null;
  let start = rows[0]!.start;
  let end = rows[0]!.end;
  for (const r of rows) {
    if (r.start < start) start = r.start;
    if (r.end > end) end = r.end;
  }
  return { start, end };
}

/** `bbo-1m` files. The original name, now one caller of the general form. */
export async function listArchivedBboFiles(
  from: Date,
  to: Date,
): Promise<ArchivedVendorFile[]> {
  return listArchivedFilesBySchema("bbo-1m", from, to);
}

/**
 * The exclusive END of the newest archived `tbbo` window, or `null`.
 *
 * The tbbo fold is anchored HERE, not at `now`. `tbbo-top50` is `append:
 * false` — bought once and never topped up — so a `now - 92d` window goes
 * silently empty about three months after the harvest and every rebuild after
 * that drops `effectiveSpreadBps` from every row while still reporting READY.
 * Anchoring at the archive means the same 92 days are folded in year three as
 * in month one.
 */
export async function latestArchivedTbboEnd(env: string): Promise<Date | null> {
  const row = await prisma.databentoBatchJob.findFirst({
    // SCOPED to the HARVEST and to this environment.
    //
    // `purpose`: the probe writes into the same inventory and accepts
    // `--schema=tbbo`, so a one-symbol, one-day probe run after the harvest
    // would become the newest row, drag the fold window to the probe's date,
    // and put its single file in the version's `sourceJobIds`.
    // `env`: `databento_batch_jobs` is a REFERENCE_COLLECTION, so after a sync
    // QA's ledger IS prod's — while `databento/` sits outside the mirrored
    // `feeds/` prefix, so QA holds the rows and not the bytes. Every other
    // ledger read is env-scoped for the same reason.
    where: {
      schema: "tbbo",
      purpose: "HARVEST",
      env,
      state: { in: ["DOWNLOADED", "LOADED"] },
    },
    orderBy: { end: "desc" },
    select: { end: true },
  });
  return row?.end ?? null;
}

/**
 * Trailing median daily dollar volume per listing, from our OWN H1 bars.
 *
 * Computed in the database, per (listing, ET session): Σ(volume × close) is
 * the day's dollar volume, and the MEDIAN of those daily totals is the tier
 * input. A median rather than a mean, because one index-rebalance day can be
 * twenty times a normal one and would drag a mean across a tier boundary for a
 * listing that is otherwise thin.
 *
 * `H1` and not `M1`: the sums agree to rounding and there are 6.5 buckets a day
 * instead of 390.
 */
export async function listingDollarVolume(
  from: Date,
  to: Date,
): Promise<Array<{ listingId: string; medianDollarVolume: number }>> {
  const rows = await aggregateAll<{
    _id: string | null;
    medianDollarVolume: number | null;
  }>(
    "candles",
    [
      {
        $match: {
          timeframe: "H1",
          ts: {
            $gte: { $date: from.toISOString() },
            $lt: { $date: to.toISOString() },
          },
        },
      },
      {
        $group: {
          _id: { listingId: "$listingId", day: ET_DAY },
          dollars: {
            $sum: { $multiply: ["$close", { $toDouble: "$volume" }] },
          },
        },
      },
      {
        $group: {
          _id: "$_id.listingId",
          // `$median` is available from MongoDB 7.0. Atlas runs 7+ and the
          // alternative — pulling every daily total into this process — is
          // hundreds of thousands of numbers for one statistic.
          medianDollarVolume: {
            $median: { input: "$dollars", method: "approximate" },
          },
        },
      },
    ],
    { allowDiskUse: true },
  );
  return rows
    .filter(
      (r): r is { _id: string; medianDollarVolume: number } =>
        typeof r._id === "string" && typeof r.medianDollarVolume === "number",
    )
    .map((r) => ({
      listingId: r._id,
      medianDollarVolume: r.medianDollarVolume,
    }));
}

/** Create the version row in `BUILDING`, before any model row exists. */
export async function createCostModelVersion(args: {
  modelVersion: number;
  builtFrom: Date;
  builtTo: Date;
  builtAt: Date;
  trigger: string;
  sourceJobIds: string[];
  /** The trade leg's own window — see the schema comment. */
  effectiveFrom?: Date;
  effectiveTo?: Date;
  effectiveFileCount?: number;
}): Promise<void> {
  await prisma.usCostModelVersion.create({
    data: {
      ...args,
      rowCount: 0,
      symbolCount: 0,
      status: "BUILDING",
    },
  });
}

export async function writeCostModelRows(
  modelVersion: number,
  rows: ReadonlyArray<{
    listingId: string;
    symbol: string;
    liquidityTier: string;
    todBucket: string;
    medianSpreadBps: number;
    p75SpreadBps: number;
    sampleCount: number;
    medianQuotedSizeShares?: number;
    effectiveSpreadBps?: number;
    effectiveSampleCount?: number;
  }>,
): Promise<void> {
  await prisma.usCostModelRow.createMany({
    data: rows.map((r) => ({ ...r, modelVersion })),
  });
}

export async function finishCostModelVersion(args: {
  modelVersion: number;
  status: "READY" | "FAILED";
  rowCount: number;
  symbolCount: number;
  detail?: string;
}): Promise<void> {
  await prisma.usCostModelVersion.update({
    where: { modelVersion: args.modelVersion },
    data: {
      status: args.status,
      rowCount: args.rowCount,
      symbolCount: args.symbolCount,
      ...(args.detail ? { detail: args.detail.slice(0, 2000) } : {}),
    },
  });
}

/**
 * The next version number.
 *
 * `max + 1`, read at write time rather than reserved earlier. Versions are
 * IMMUTABLE once a backtest pins one, so the only thing that must never happen
 * is reuse — and a single builder, triggered monthly from one Cloud Run job,
 * has no concurrent writer to race with. `@@unique([modelVersion])` is the
 * backstop if that ever stops being true.
 */
export async function nextCostModelVersion(): Promise<number> {
  const latest = await prisma.usCostModelVersion.findFirst({
    orderBy: { modelVersion: "desc" },
    select: { modelVersion: true },
  });
  return (latest?.modelVersion ?? 0) + 1;
}

/* ─────────────────────────────────────────────────────────────────────────
   Per-FILE updates, for a sharded load
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Stamp ONE file's load result, atomically.
 *
 * A whole-array write-back cannot be used here and the reason is a lost-write
 * race, not style. The harvest's loadable entries carry `splitSymbols: true`
 * with a yearly split, so a 503-symbol three-year job produces on the order of
 * 1,500 files — which is exactly why the load is shardable across Cloud Run
 * tasks. But every task would then read the same `files` JSON, stamp its own
 * entries, and write the whole array back: last writer wins, and three
 * quarters of the load records vanish while every task reports success.
 *
 * MongoDB's positional operator updates the matched element in place, so N
 * tasks stamping N different files never touch each other's. Prisma's Mongo
 * connector has no expression for it, hence the raw command.
 *
 * Returns the number of documents modified — 0 means the filename was not
 * found in the array, which is a bug in the caller rather than a no-op worth
 * swallowing.
 */
export async function stampFileLoaded(args: {
  rowId: string;
  filename: string;
  loadedRows: number;
  loadedAt: Date;
}): Promise<number> {
  const result = (await prisma.$runCommandRaw({
    update: "databento_batch_jobs",
    updates: [
      {
        q: {
          _id: { $oid: args.rowId },
          "files.filename": args.filename,
        },
        u: {
          $set: {
            "files.$.loadedRows": args.loadedRows,
            "files.$.loadedAt": args.loadedAt.toISOString(),
          },
        },
      },
    ],
  } as never)) as { n?: number; nModified?: number };
  return result.nModified ?? 0;
}

/** Stamp ONE file's download result, atomically. Same race, same reason. */
export async function stampFileVerified(args: {
  rowId: string;
  filename: string;
  verified: boolean;
  size?: number;
  detail?: string;
}): Promise<number> {
  const set: Record<string, unknown> = { "files.$.verified": args.verified };
  if (args.size !== undefined) set["files.$.size"] = args.size;
  const update: Record<string, unknown> = { $set: set };
  if (args.detail === undefined) update["$unset"] = { "files.$.detail": "" };
  else set["files.$.detail"] = args.detail;

  const result = (await prisma.$runCommandRaw({
    update: "databento_batch_jobs",
    updates: [
      {
        q: { _id: { $oid: args.rowId }, "files.filename": args.filename },
        u: update,
      },
    ],
  } as never)) as { nModified?: number };
  return result.nModified ?? 0;
}

/**
 * Advance a row's state if every file has reached the terminal mark.
 *
 * Re-READS the row rather than trusting what this task stamped, which is the
 * whole point under sharding: no single task knows whether the others have
 * finished, so each one checks after its own last file and whichever finds the
 * set complete performs the transition. Idempotent — a second task finding the
 * same thing writes the same state.
 */
export async function advanceJobStateIfComplete(args: {
  rowId: string;
  requireLoaded: boolean;
}): Promise<string | null> {
  const row = await prisma.databentoBatchJob.findUnique({
    where: { id: args.rowId },
    select: { files: true, state: true },
  });
  if (row === null) return null;
  const records = readFileRecords(row.files);
  if (records.length === 0) return null;

  const allVerified = records.every((r) => r.verified);
  if (!allVerified) return null;

  const dataFiles = records.filter((r) => r.kind === "data");
  const allLoaded =
    dataFiles.length > 0 && dataFiles.every((r) => r.loadedAt !== undefined);

  if (args.requireLoaded && allLoaded) {
    await prisma.databentoBatchJob.update({
      where: { id: args.rowId },
      data: {
        state: "LOADED",
        loadedAt: new Date(),
        loadedRows: records.reduce((n, r) => n + (r.loadedRows ?? 0), 0),
      },
    });
    return "LOADED";
  }
  if (!args.requireLoaded || !allLoaded) {
    if (row.state === "DONE") {
      await prisma.databentoBatchJob.update({
        where: { id: args.rowId },
        data: { state: "DOWNLOADED", downloadedAt: new Date() },
      });
      return "DOWNLOADED";
    }
  }
  return null;
}

/**
 * The row shape the lake ledger expects, restated here rather than imported.
 *
 * `packages/core` must NOT depend on `@usemoney/lake`: that package carries
 * `@google-cloud/bigquery`, and core is imported by `apps/web`, `apps/api` and
 * every worker — a BigQuery client in a Next.js bundle's dependency graph is a
 * large price for a type. The JOB owns both halves and wires them.
 */
export interface LedgerSourceObject {
  dataset: string;
  source: string;
  objectUri: string;
  /**
   * GCS generation — which VERSION of the object was read.
   *
   * Half the ledger's MERGE key. Filled by a HEAD in the backfill; NULL from
   * the manifest alone, which is why `ledger-backfill-databento` HEADs by
   * default. With it always NULL the key degenerates to `object_uri`, and the
   * first row that ever does carry one becomes a second row for the same
   * object whose `state` can disagree.
   */
  generation?: number | null;
  contentType?: string | null;
  bytes?: number | null;
  sha256?: string | null;
  acquiredAt: Date;
  vendorJobId?: string | null;
  vendorFileName?: string | null;
  costUsd?: number | null;
  state: "PRESENT" | "VERIFIED" | "MISSING" | "EXPIRED";
  verifiedAt?: Date | null;
}

/**
 * Map a job's file inventory to ledger rows. PURE — the caller writes them.
 *
 * ## THE BUCKET IS RESOLVED, NEVER NAMED
 *
 * The first cut hardcoded `stockbook-lake-{env}` and was WRONG for every row:
 * `databento/` is in `CONTENT_PREFIXES`, so `bucketForPrefix` resolves it to
 * `stockbook-content-{env}` — which is also what `setup-databento-jobs.sh`
 * passes as `GCP_STORAGE_BUCKET`. Every `object_uri` would have named a bucket
 * the object is not in, so the one question this table exists to answer — "do
 * we still have this file?" — would answer NO for all ~56,220 objects that are
 * in fact present. And the test asserted the wrong value, so it was green.
 *
 * `bucketForPrefix` is the machine-checked statement of this fact; naming a
 * bucket beside it is the one-fact-two-spellings defect.
 *
 * ## PRESENT AND VERIFIED ARE DIFFERENT FACTS
 *
 * `PRESENT` means bytes exist at that key. `VERIFIED` means the vendor's
 * checksum MATCHED. The repo's own header draws this line for `verified` vs
 * `loadedAt`, and conflating them would let a corrupt download read as checked.
 *
 * ## THE HASH IS THE VENDOR'S, NEVER ONE WE COMPUTED
 *
 * Hashing the archive ourselves would mean pulling terabytes to learn what the
 * manifest already states, against files that expire 30 days after submission.
 * A record with no `sha256` stores NULL — absent, not an empty string, so a
 * later "which objects are unhashed?" query can find them.
 *
 * ## `acquiredAt` IS WHEN THE FILE ARRIVED, NOT WHEN WE WROTE THE ROW
 *
 * It is the PARTITION column. Stamping it `now()` during a backfill of two
 * years of purchases puts every row in ONE date partition — the day the
 * backfill ran — so "what did we buy in 2024?" returns nothing and partition
 * pruning buys nothing for any query.
 */
export function toLedgerSourceObjects(
  row: {
    jobId: string | null;
    dataset: string;
    costUsd?: number | null;
    /** The pre-submission quote. The only figure that exists in flight. */
    costUsdQuoted?: number | null;
    /** When the vendor's files actually landed. Falls back to `opts.now`. */
    downloadedAt?: Date | null;
    submittedAt?: Date | null;
  },
  records: readonly DatabentoFileRecord[],
  opts: { env: LakeEnv; now: Date },
): LedgerSourceObject[] {
  // The real acquisition instant, in order of preference. `now` is the last
  // resort and means "we genuinely do not know when this arrived".
  const acquiredAt = row.downloadedAt ?? row.submittedAt ?? opts.now;

  // COST IS PER FILE, NOT PER JOB.
  //
  // This used to stamp the whole job's cost onto every row, so a $199 purchase
  // of 42,084 files wrote $199 into 42,084 rows and `SELECT SUM(cost_usd)` —
  // the one query the column exists for, and the reason the DDL declares it
  // NUMERIC rather than FLOAT64 — reported ~$8.4M against ~$199 paid. Each row
  // now carries its SHARE, so the obvious query is the correct one and
  // `GROUP BY vendor_job_id` still recovers the job total.
  //
  // `costUsd ?? costUsdQuoted` is what schema.prisma:7257 mandates: `costUsd`
  // is NULL until Databento has processed the job, so reading it alone writes
  // NULL for every in-flight purchase — and with the MERGE now updating
  // `cost_usd`, a later pass overwrites a real figure with NULL.
  const jobCost = row.costUsd ?? row.costUsdQuoted ?? null;
  const perFile =
    jobCost === null || records.length === 0 ? null : jobCost / records.length;

  return records.map((f) => ({
    dataset: row.dataset,
    source: "DATABENTO",
    // RESOLVED from the key, never named. See the header.
    objectUri: `gs://${bucketForPrefix(f.archiveKey, opts.env)}/${f.archiveKey.replace(/^\/+/, "")}`,
    bytes: f.size,
    sha256: f.sha256 ? f.sha256 : null,
    acquiredAt,
    vendorJobId: row.jobId,
    vendorFileName: f.filename,
    // The job's cost, carried so the ledger can answer "what did this cost?"
    // without joining back to Mongo. `entitlement` is NOT carried: the model
    // has no such field, so the first cut read `undefined` on every row and a
    // test asserted a value no production row can produce. Dropping the column
    // from the claim beats building machinery to fake it.
    costUsd: perFile,
    // MISSING IS REACHABLE, AND IT HAS TO BE.
    //
    // `verified: false` covered three different facts: not yet checked, the
    // vendor never delivered it ("not present in batch.list_files"), and a
    // download or checksum failure where `downloadToArchive` DELETES the object
    // before throwing. All three landed as PRESENT, which this table defines as
    // "bytes exist at that key" — so the one question it exists to answer said
    // YES for every file we do not have, permanently: nothing re-checks a row,
    // and Databento files expire 30 days after submission.
    //
    // A `detail` is only written when an attempt FAILED, so it is the signal
    // that separates "not checked yet" from "we went looking and it is gone".
    state: f.verified ? "VERIFIED" : f.detail ? "MISSING" : "PRESENT",
    verifiedAt: f.verified ? opts.now : null,
  }));
}

/**
 * Re-read one job's file records and cost. MONEY-1472 (B1).
 *
 * The harvest's download loop stamps `verified` in MONGO, not in the array it
 * holds, so mirroring the in-memory copy would write every row `PRESENT` —
 * making `VERIFIED` unreachable in a table clustered on `state`.
 */
export async function readJobForLedger(rowId: string): Promise<{
  id: string;
  jobId: string | null;
  dataset: string;
  costUsd: number | null;
  costUsdQuoted: number | null;
  downloadedAt: Date | null;
  submittedAt: Date | null;
  state: string;
  /** READ by the harvest mirror, which used to re-MERGE a whole inventory
   *  every pass because nothing told it the row was already backed. */
  ledgerBacked: boolean | null;
  records: DatabentoFileRecord[];
} | null> {
  const row = await prisma.databentoBatchJob.findUnique({
    where: { id: rowId },
    select: {
      id: true,
      jobId: true,
      dataset: true,
      costUsd: true,
      // The only cost figure that exists before the vendor processes the job.
      costUsdQuoted: true,
      downloadedAt: true,
      submittedAt: true,
      state: true,
      ledgerBacked: true,
      files: true,
    },
  });
  if (!row) return null;
  return { ...row, records: readFileRecords(row.files) };
}

/**
 * Mark a job's inventory as present in the ledger.
 *
 * Set ONLY after the ledger write succeeded, which is what makes the transition
 * self-healing: the harvest has already PAID the vendor by the time files
 * exist, so a BigQuery blip must not throw away a bought inventory — but it
 * must not be silently forgotten either. `ledger-backfill-databento` selects
 * rows where this is not true and retries them.
 */
export async function markLedgerBacked(rowId: string): Promise<void> {
  await prisma.databentoBatchJob.update({
    where: { id: rowId },
    data: { ledgerBacked: true },
  });
}

/** Replace a row's whole `files` array. Safe ONLY on an unsharded path. */
export async function replaceFileRecords(
  rowId: string,
  records: readonly DatabentoFileRecord[],
): Promise<void> {
  await prisma.databentoBatchJob.update({
    where: { id: rowId },
    data: { files: records as unknown as object[] },
  });
}
