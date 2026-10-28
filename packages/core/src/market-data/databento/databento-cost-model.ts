/**
 * The US transaction-cost model BUILDER — MONEY-1373.
 *
 * Streams a year of archived `bbo-1m` quotes, and the last 92 days of archived
 * `tbbo` trades where they are present, into one row per
 * `(listing, time-of-day)`, then writes a versioned, immutable model that
 * backtests pin to.
 *
 * That sentence was false for two releases: nothing folded `tbbo` at all, so
 * `effectiveSpreadBps` and `effectiveSampleCount` were null on every row while
 * the header promised them.
 *
 * The arithmetic lives in `databento-cost-model-logic.ts`; this file is the
 * I/O. What it owns is the ORDER of the writes, which is the part that decides
 * what a reader sees when a build dies half-way.
 *
 * ## The write order, and why BUILDING is a real state
 *
 *   1. `UsCostModelVersion { status: "BUILDING" }` — BEFORE any row.
 *   2. rows, in chunks.
 *   3. `status: "READY"` with the final counts.
 *
 * A build killed between 1 and 3 leaves a version that is visibly incomplete.
 * The inverse order — rows first, version last — leaves rows belonging to a
 * version that does not exist, which a `modelVersion`-scoped read simply cannot
 * see, so the failure renders as "the build did nothing" instead of "the build
 * stopped here". `shouldRebuildCostModel` treats any non-READY latest version
 * as a reason to rebuild, so a half-written table is never the thing a backtest
 * pins to.
 */

import type { Readable } from "node:stream";

import type { LiquidityTier, TodBucket } from "@usemoney/types/us-cost-model";

import { splitCsvLine } from "../csv-line";
import { zstdLines } from "./databento-stream";
import {
  parseBboHeader,
  parseBboRow,
  isTbboRow,
  parseTbboHeader,
  parseTbboRow,
  fromDatabentoSymbol,
  type BboColumns,
  type TbboColumns,
} from "./databento-logic";
import {
  buildListingIndex,
  resolveListingForDate,
  type ListingRow,
} from "./databento-symbology";
import {
  assignTiers,
  cellKey,
  effectiveSpreadBps,
  newCell,
  quoteSample,
  summarizeCell,
  todBucketFor,
  type CostCell,
  type CostCellSummary,
  type ListingLiquidity,
} from "./databento-cost-model-logic";

export interface CostModelCounters {
  filesRead: number;
  rowsRead: number;
  rowsSampled: number;
  /**
   * Rows `parseBboRow` accepted and `quoteSample` then rejected. MUST STAY 0.
   *
   * It was three counters — `skippedEmpty`, `skippedNonPositive`,
   * `skippedCrossedOrLocked` — and all three were DEAD: `parseBboRow` already
   * rejects a non-finite price, a non-positive one and a crossed book, so a
   * row reaching `quoteSample` has passed every test `quoteSample` applies and
   * lands in `parseRejected` instead. Three counters permanently reading 0
   * read as "this never happens", which is the MONEY-1238 shape — a number
   * that cannot move is indistinguishable from a healthy one.
   *
   * Collapsed to one, and kept rather than deleted, because a NON-ZERO value
   * is real information: it means the two validators have drifted apart and
   * one of them is now wrong about what a usable quote is.
   */
  sampleRejected: number;
  /** `tbbo` files folded. Zero is legitimate — see {@link CostModelBuildDeps}. */
  tbboFilesRead: number;
  /** Chosen `tbbo` files the wall-clock budget stopped us reaching. */
  tbboFilesSkippedForTime: number;
  /** `tbbo` rows read, whether or not they became a sample. */
  tradesRead: number;
  /** Trades that reached a cell's `effective` reservoir. */
  tradesSampled: number;
  /**
   * `tbbo` rows whose `action` was not `T`. MUST STAY 0 — the schema is
   * trade-only by definition, so a non-zero value means the vendor changed
   * what it sends and the fold is quietly costing something that is not a
   * trade.
   */
  skippedNotTrade: number;
  skippedOutsideSession: number;
  skippedUnknownListing: number;
  parseRejected: number;
  cells: number;
}

export function emptyCostModelCounters(): CostModelCounters {
  return {
    filesRead: 0,
    rowsRead: 0,
    rowsSampled: 0,
    sampleRejected: 0,
    tbboFilesRead: 0,
    tbboFilesSkippedForTime: 0,
    tradesRead: 0,
    tradesSampled: 0,
    skippedNotTrade: 0,
    skippedOutsideSession: 0,
    skippedUnknownListing: 0,
    parseRejected: 0,
    cells: 0,
  };
}

/**
 * Fold one archived quote file into the cell map — `bbo-1m` or `tbbo`.
 *
 * The cells are passed IN rather than returned, because a year of quotes is
 * many files and every one of them contributes to the same reservoirs. One
 * file in flight at a time; the reservoirs are the only thing that grows, and
 * they are bounded by construction (4,096 samples x 3 statistics x cells).
 *
 * Rejections are COUNTED BY REASON, not totalled. "2.1 million rows skipped"
 * cannot be acted on; "2.1 million crossed books" is a data-quality finding
 * and "2.1 million outside the session" is a clock bug, and the two need
 * opposite responses.
 *
 * ## The two kinds are NOT interchangeable, and the difference is the point
 *
 * `bbo-1m` is a TIME-UNIFORM sample: one record per minute per symbol whether
 * or not anything traded. `tbbo` is ACTIVITY-WEIGHTED: one record per trade,
 * so a busy minute contributes hundreds of records and a quiet one none.
 *
 * So a tbbo row folds into `effective` ONLY. Folding its quote into `spread`
 * as well would silently re-weight the quoted-spread statistic toward the
 * moments when people were trading — which is exactly when spreads are
 * tightest — and the resulting number would look like a quoted spread, sit in
 * a column called `quotedSpreadBps`, and be biased low with nothing in the row
 * to say so. `quotedSize` is left alone for the same reason.
 *
 * The TIMESTAMP also differs and is easy to get backwards. On `bbo-1m`,
 * `ts_recv` is the interval END, so one millisecond back puts a 16:00:00.000
 * record in the session it belongs to rather than the one that follows. On
 * `tbbo` it is the EVENT stamp of an individual print, so it is used as-is —
 * shifting it back a millisecond would move a trade at a bucket boundary into
 * the previous bucket for no reason.
 */
export async function foldQuoteFile(args: {
  stream: Readable;
  kind: "bbo" | "tbbo";
  listings: ReadonlyMap<string, ListingRow[]>;
  cells: Map<string, CostCell>;
  counters: CostModelCounters;
}): Promise<void> {
  const { listings, cells, counters, kind } = args;
  const isTbbo = kind === "tbbo";
  // A DISCRIMINATED UNION, not `BboColumns | TbboColumns` plus a cast. The two
  // header shapes differ by one required column, `TbboColumns extends
  // BboColumns`, and handing a bbo header to `parseTbboRow` is the unsound
  // direction — it would read `price` at index -1 and reject every print. The
  // discriminant makes that a compile error instead of a comment.
  let parsed:
    | { kind: "bbo"; cols: BboColumns }
    | { kind: "tbbo"; cols: TbboColumns }
    | null = null;
  if (isTbbo) counters.tbboFilesRead++;
  else counters.filesRead++;

  for await (const line of zstdLines(args.stream)) {
    if (line === "") continue;
    if (parsed === null) {
      // BY NAME, never by position. This vendor's sibling CSV is documented
      // `date,open,...` and is really `date,close,high,low,open`; a positional
      // parser written from the docs swaps two columns on every row and the
      // numbers stay plausible.
      parsed = isTbbo
        ? { kind: "tbbo", cols: parseTbboHeader(line) }
        : { kind: "bbo", cols: parseBboHeader(line) };
      continue;
    }

    if (isTbbo) counters.tradesRead++;
    else counters.rowsRead++;

    // ONE RFC-4180 scan per row, shared with whichever parser runs. `cells` is
    // already the cell MAP in this scope, hence `fields`.
    const fields = splitCsvLine(line);
    const row =
      parsed.kind === "tbbo"
        ? parseTbboRow(line, parsed.cols, fields)
        : parseBboRow(line, parsed.cols, fields);
    if ("rejected" in row) {
      if (row.rejected === "notTrade") counters.skippedNotTrade++;
      else counters.parseRejected++;
      continue;
    }

    // See the header: the bbo stamp is an interval END, the tbbo stamp is an
    // event.
    const at = new Date(isTbbo ? row.tsMs : row.tsMs - 1);
    const bucket = todBucketFor(at);
    if (bucket === null) {
      counters.skippedOutsideSession++;
      continue;
    }

    const symbol = fromDatabentoSymbol(row.symbol);
    const resolution = resolveListingForDate(listings.get(symbol), at);
    if (!resolution.ok) {
      counters.skippedUnknownListing++;
      continue;
    }

    // ONE validation per row, not two. `effectiveSpreadBps` runs `quoteSample`
    // itself, so calling both on the trade path would re-validate every one of
    // ~250-500M rows for nothing. Each branch computes exactly what it stores.
    //
    // Either returning "rejected" is UNREACHABLE while the parsers and the
    // sampler agree — `parseBboRow` already refuses a non-finite, non-positive
    // or crossed book, and `parseTbboRow` refuses an unusable print. Counted
    // rather than assumed away: a non-zero `sampleRejected` means the two have
    // drifted apart and one of them is now wrong about what a usable quote is.
    // Narrowed on the DATA through a type predicate, not on `isTbbo` — the
    // compiler cannot relate that boolean to `row`'s type, and the one
    // assertion this needs lives inside `isTbboRow` rather than here.
    const value = isTbboRow(row)
      ? effectiveSpreadBps(row.price, row.bid, row.ask)
      : quoteSample(row.bid, row.ask, row.bidSize, row.askSize);
    if (value === null || (typeof value === "object" && "rejected" in value)) {
      counters.sampleRejected++;
      continue;
    }

    const key = cellKey(resolution.listing.listingId, bucket);
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = newCell(resolution.listing.listingId, symbol, bucket);
      cells.set(key, cell);
      counters.cells = cells.size;
    }

    if (typeof value === "number") {
      cell.effective.add(value);
      counters.tradesSampled++;
    } else {
      cell.spread.add(value.spreadBps);
      cell.quotedSize.add(value.quotedSizeShares);
      counters.rowsSampled++;
    }
  }

  if (parsed === null) {
    // A file with no header line is empty or truncated. Throwing beats
    // returning quietly: an empty archive object means the download or the
    // decompression is broken, and a build that folded ten such files would
    // report a model with a thousandth of the samples and no error.
    throw new Error(
      `foldQuoteFile(${kind}): the stream produced no header line. An empty ` +
        "or truncated archive object is a download failure, not an empty " +
        "market.",
    );
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Assembly
   ──────────────────────────────────────────────────────────────────────── */

export interface CostModelRowOut extends CostCellSummary {
  liquidityTier: LiquidityTier;
}

/**
 * Cells plus tiers into rows, dropping the cells that measured nothing.
 *
 * A cell with no usable quotes yields no row at all — see `summarizeCell` for
 * why a zero-spread row is worse than an absent one.
 */
export function buildRows(
  cells: ReadonlyMap<string, CostCell>,
  liquidity: readonly ListingLiquidity[],
): CostModelRowOut[] {
  const tiers = assignTiers(liquidity);
  const out: CostModelRowOut[] = [];
  for (const cell of cells.values()) {
    const summary = summarizeCell(cell);
    if (summary === null) continue;
    out.push({
      ...summary,
      // T3 for a listing the liquidity pass never saw — the most conservative
      // tier. Defaulting to T1 would cost an unmeasurable listing as if it
      // were the most liquid thing in the universe.
      liquidityTier: tiers.get(cell.listingId) ?? "T3",
    });
  }
  return out.sort(
    (a, b) =>
      (a.listingId < b.listingId ? -1 : a.listingId > b.listingId ? 1 : 0) ||
      BUCKET_ORDER.indexOf(a.todBucket) - BUCKET_ORDER.indexOf(b.todBucket),
  );
}

const BUCKET_ORDER: readonly TodBucket[] = [
  "PRE",
  "OPEN30",
  "MID",
  "CLOSE30",
  "POST",
];

/** Distinct listings across the rows — the version's `symbolCount`. */
export function countListings(rows: readonly CostModelRowOut[]): number {
  return new Set(rows.map((r) => r.listingId)).size;
}

/** The listing index the fold needs, from raw master rows. */
export function costModelListingIndex(
  rows: readonly ListingRow[],
): Map<string, ListingRow[]> {
  return buildListingIndex(rows);
}

/* ─────────────────────────────────────────────────────────────────────────
   The build
   ──────────────────────────────────────────────────────────────────────── */

/** One archived BBO file the build should fold in. */
export interface CostModelSourceFile {
  jobId: string;
  archiveKey: string;
}

/**
 * The trade leg: its files AND the window they came from.
 *
 * One dependency rather than two, and it returns the window rather than
 * taking one. The builder's `[from, to)` is the QUOTE window and has nothing
 * to say about the trade sample — the caller used to be handed it and ignore
 * both arguments, which is a signature that lies. The window comes back so it
 * can be stamped on the version row: a reader cannot otherwise tell a fresh
 * effective column from one sampled two years earlier.
 *
 * `null` means there is nothing archived to fold, which is a normal state
 * before the entry is harvested.
 */
export interface TbboLeg {
  from: Date;
  to: Date;
  files: CostModelSourceFile[];
}

export interface CostModelBuildDeps {
  /**
   * `DOWNLOADED`/`LOADED` bbo-1m files inside `[from, to)`, oldest first.
   *
   * The builder never touches the vendor. Everything it reads was already
   * bought and archived — so a rebuild costs GCS reads and nothing at
   * Databento, which is what makes a monthly cadence affordable.
   */
  listBboFiles(from: Date, to: Date): Promise<CostModelSourceFile[]>;
  /**
   * Archived `tbbo` files inside `[from, to)`, oldest first. OPTIONAL.
   *
   * The trade leg is a one-way purchase: `tbbo-top50` is bought once, inside
   * the live Standard month, and is `append: false` — nothing tops it up. So
   * the window it is folded over is anchored at the LATEST ARCHIVED TBBO FILE
   * minus {@link TBBO_FOLD_DAYS}, never at `now`. A `now - 92d` window goes
   * silently empty about three months after the harvest, and every rebuild
   * after that would drop `effectiveSpreadBps` from every row while reporting
   * a healthy READY model.
   *
   * Absent, or answering zero files, is LEGITIMATE and not an error: the
   * effective column is documented as "where we have them". A tbbo object the
   * store cannot open is logged and skipped and does NOT count toward
   * {@link MIN_READABLE_RATIO}, which grades the bbo sample the model is
   * actually costed on.
   */
  listTbboFiles?(): Promise<TbboLeg | null>;
  openArchive(key: string): Promise<Readable | null>;
  listingRows(): Promise<ListingRow[]>;
  /** Trailing median daily dollar volume per listing, for the tiers. */
  listingLiquidity(from: Date, to: Date): Promise<ListingLiquidity[]>;
  createVersion(args: {
    modelVersion: number;
    builtFrom: Date;
    builtTo: Date;
    builtAt: Date;
    trigger: string;
    sourceJobIds: string[];
    effectiveFrom?: Date;
    effectiveTo?: Date;
    effectiveFileCount?: number;
  }): Promise<void>;
  writeRows(
    modelVersion: number,
    rows: readonly CostModelRowOut[],
  ): Promise<void>;
  finishVersion(args: {
    modelVersion: number;
    status: "READY" | "FAILED";
    rowCount: number;
    symbolCount: number;
    detail?: string;
  }): Promise<void>;
  nextVersion(): Promise<number>;
  /** Injectable clock, for the trade leg's wall-clock budget. */
  now?(): number;
  log(...a: unknown[]): void;
}

export interface CostModelBuildResult {
  modelVersion: number;
  rowCount: number;
  symbolCount: number;
  counters: CostModelCounters;
  /** True when `apply` was false: nothing was written. */
  dryRun: boolean;
}

/** Rows per `createMany`. Mongo's 16 MB command limit, with room to spare. */
export const COST_MODEL_WRITE_CHUNK = 1_000;

/**
 * How much of the sample must actually be readable for a build to proceed.
 *
 * 95%. A handful of objects lost to a transient is tolerable; a third of them
 * is a permission or lifecycle problem, and a model built on the remainder is
 * worse than no model because it is version-pinned and looks authoritative.
 */
export const MIN_READABLE_RATIO = 0.95;

/**
 * How much archived `tbbo` history one build folds: 92 days.
 *
 * NOT the twelve months that are BOUGHT. The purchase is 12 months because it
 * is a one-way buy at $0 inside the subscription; the FOLD is three months
 * because the file count is the binding constraint, not the money. Sized from
 * the measurement: top-50 megacaps are ~20-25% of a ~60-80M-trade US tape, and
 * EQUS.MINI is one venue-blend publisher at ~25-50% of that, so ~4-8M rows a
 * day. Ninety-two days is ~250-500M lines through `zstdLines` — 10-30 minutes
 * in Node, inside the append's 2 h task timeout. Twelve months would not be,
 * and that is the real reason the sample is three months rather than a
 * statistical one.
 */
export const TBBO_FOLD_DAYS = 92;

/**
 * How many archived `tbbo` DAILY FILES one build folds, at most: 20.
 *
 * NOT a shortcut — a sizing decision, and the arithmetic is the argument.
 *
 * A cell's statistics come out of a {@link RESERVOIR_SIZE}-sample reservoir.
 * `tbbo-top50` is 50 listings x 6 time-of-day buckets = 300 cells, so the
 * whole model can hold at most 300 x 4,096 = ~1.2M samples however many rows
 * it reads. Twenty sessions at the manifest's own ~4-8M rows/day is 80-160M
 * rows — already 60-130x more than the reservoirs can keep.
 *
 * The binding constraint is the CLOCK. Measured 2026-09-07 on node 22, after
 * memoising the time-of-day bucket and sharing one CSV scan: `foldQuoteFile`
 * runs at ~0.055M rows/s, so 92 days of trades is 76-150 MINUTES on top of the
 * bbo leg's ~23, against `databento-append`'s 2 h task timeout. Cloud Run kills
 * the task at the ceiling, `createCostModelVersion` has not run yet so no
 * BUILDING row survives to explain it, `shouldRebuildCostModel` sees no READY
 * version and tries again on the next execution — and because the kill lands
 * after the bar-writing loop, `reportJobOutcome` never runs and the append's
 * monitors read NO DATA. Every append for the rest of the month would burn its
 * full 2 h and be killed.
 *
 * EVENLY SPREAD ACROSS THE WINDOW, never the first or the last 20. A prefix is
 * a biased sample of a 92-day window; a stride keeps the sample uniform over
 * the calendar, which is what a time-of-day statistic needs.
 */
export const TBBO_MAX_FILES = 20;

/**
 * The wall clock the trade leg may spend, after which it stops and SAYS SO.
 *
 * A backstop under {@link TBBO_MAX_FILES}, not a substitute for it. The
 * per-day row count is an ESTIMATE (~4-8M) and nobody has measured the real
 * one; if a session turns out to be 30M rows the file cap alone would still
 * walk past the task timeout. The repo's own idiom — `RUN_TIME_BUDGET_MS` in
 * `stock-document-extract` and `mf-nav-backfill` — checked BETWEEN files, so
 * the true wall is the budget plus one file.
 *
 * Stopping early degrades the OPTIONAL column and is reported in the log and
 * on the counters. Being killed loses the whole build and the monitors with it.
 */
export const TBBO_FOLD_BUDGET_MS = 45 * 60_000;

/**
 * The `tbbo` files to fold, at most {@link TBBO_MAX_FILES}, evenly spread.
 *
 * A stride rather than a slice: `files` arrives oldest-first, so taking the
 * first N samples the oldest sessions and taking the last N samples the
 * newest, and either is a biased sample of the window. The stride always
 * includes the first file, so a window with fewer files than the cap is
 * returned unchanged and in order.
 */
export function spreadSample<T>(files: readonly T[], max: number): T[] {
  if (max < 1) throw new RangeError("spreadSample: max must be >= 1");
  if (files.length <= max) return [...files];
  const stride = files.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(files[Math.floor(i * stride)]!);
  return out;
}

/**
 * The window the trade leg is folded over, ANCHORED AT THE ARCHIVE.
 *
 * `archiveEnd` is the exclusive end of the newest archived `tbbo` job, NOT
 * `now`. `tbbo-top50` is `append: false` — bought once inside the live
 * Standard month and never topped up — so a `now - 92d` window would go
 * silently empty about three months after the harvest and every rebuild after
 * that would drop `effectiveSpreadBps` from every row while still reporting a
 * READY model. Anchoring here means the same 92 days are folded in year three
 * as in month one.
 *
 * `null` in, `null` out: nothing archived yet, so there is nothing to fold.
 * Extracted as a function rather than inlined at the one call site because a
 * source scan cannot tell `archiveEnd` from `now` — the two differ by one
 * identifier and by three months of silence.
 */
export function tbboFoldWindow(
  archiveEnd: Date | null,
): { from: Date; to: Date } | null {
  if (archiveEnd === null) return null;
  return {
    from: new Date(archiveEnd.getTime() - TBBO_FOLD_DAYS * 86_400_000),
    to: archiveEnd,
  };
}

/**
 * Build one version of the model.
 *
 * `apply: false` folds every file and reports what it WOULD write. That is not
 * a courtesy — it is the only way to see the rejection counters and the cell
 * count before committing a version number, and a version number is the one
 * thing a build cannot take back: a backtest may already have pinned it.
 */
export async function buildCostModel(args: {
  from: Date;
  to: Date;
  trigger: string;
  apply: boolean;
  deps: CostModelBuildDeps;
}): Promise<CostModelBuildResult> {
  const { deps } = args;
  const counters = emptyCostModelCounters();
  const cells = new Map<string, CostCell>();

  let missing = 0;
  const files = await deps.listBboFiles(args.from, args.to);
  if (files.length === 0) {
    // ZERO files is not an empty market — it means the harvest has not bought
    // the BBO entry yet, or the archive keys moved. Building a version from
    // nothing would write a READY model with no rows that a backtest could
    // legitimately pin to and cost every trade at zero.
    throw new Error(
      "buildCostModel: no archived bbo-1m files in " +
        `[${args.from.toISOString().slice(0, 10)}, ${args.to.toISOString().slice(0, 10)}). ` +
        "Refusing to build an empty model — a READY version with no rows " +
        "costs every trade at zero and looks like a working cost basis.",
    );
  }
  deps.log(`cost model: folding ${files.length} bbo-1m file(s)`);

  const listings = costModelListingIndex(await deps.listingRows());
  for (const file of files) {
    const stream = await deps.openArchive(file.archiveKey);
    if (stream === null) {
      missing++;
      deps.log(`  MISSING ${file.archiveKey} — skipped`);
      continue;
    }
    await foldQuoteFile({ stream, kind: "bbo", listings, cells, counters });
  }

  // ── the trade leg, where we have it ────────────────────────────────────
  //
  // Folded AFTER the quotes and into `effective` only. Zero files is a normal
  // state (the entry may not be harvested yet), so it logs and continues
  // rather than throwing the way an empty bbo list does — the model is costed
  // on the quoted spread and the effective column is documented as optional.
  const tbboJobIds = new Set<string>();
  let tbboWindow: { from: Date; to: Date } | null = null;
  if (deps.listTbboFiles !== undefined) {
    const leg = await deps.listTbboFiles();
    const tbboFiles = leg?.files ?? [];
    tbboWindow = leg === null ? null : { from: leg.from, to: leg.to };
    if (tbboFiles.length === 0) {
      deps.log(
        "cost model: no archived tbbo file in the window — effectiveSpreadBps " +
          "will be absent. Expected until tbbo-top50 has been harvested.",
      );
    } else {
      const chosen = spreadSample(tbboFiles, TBBO_MAX_FILES);
      deps.log(
        `cost model: folding ${chosen.length} of ${tbboFiles.length} tbbo ` +
          `file(s), evenly spread (cap ${TBBO_MAX_FILES}, budget ` +
          `${TBBO_FOLD_BUDGET_MS / 60_000} min)`,
      );
      const clock = deps.now ?? Date.now;
      const startedAt = clock();
      for (const file of chosen) {
        // BETWEEN files, so the true wall is the budget plus one file.
        // Stopping here degrades an OPTIONAL column and says so; being killed
        // by Cloud Run loses the whole build and takes the monitors with it.
        if (clock() - startedAt > TBBO_FOLD_BUDGET_MS) {
          counters.tbboFilesSkippedForTime =
            chosen.length - counters.tbboFilesRead;
          deps.log(
            `cost model: the tbbo fold hit its ` +
              `${TBBO_FOLD_BUDGET_MS / 60_000} min budget after ` +
              `${counters.tbboFilesRead} file(s); ` +
              `${counters.tbboFilesSkippedForTime} not folded. ` +
              "effectiveSpreadBps is built from a smaller sample than planned.",
          );
          break;
        }
        const stream = await deps.openArchive(file.archiveKey);
        if (stream === null) {
          // NOT counted toward MIN_READABLE_RATIO: that floor grades the bbo
          // sample the model is costed on. An unreadable tbbo object costs an
          // optional column, not the model.
          deps.log(`  MISSING (tbbo) ${file.archiveKey} — skipped`);
          continue;
        }
        await foldQuoteFile({
          stream,
          kind: "tbbo",
          listings,
          cells,
          counters,
        });
        tbboJobIds.add(file.jobId);
      }
    }
  }

  // A VERSION MUST NOT BE BUILT FROM A FRACTION OF ITS SAMPLE.
  //
  // Unreadable objects were counted and skipped, and the build then wrote
  // READY with `sourceJobIds` naming every job INCLUDING the ones whose bytes
  // were never opened. A permission change that made 340 of 365 objects
  // unreadable would produce a model costed on 7% of the sample, with nothing
  // on the version row to say so, and every backtest pinned to it inherits
  // that silently. `foldQuoteFile` already THROWS on a header-less file — a
  // stricter check on a rarer failure.
  if (missing > 0) {
    const readable = files.length - missing;
    const ratio = readable / files.length;
    deps.log(
      `cost model: ${missing} of ${files.length} archive object(s) unreadable`,
    );
    if (ratio < MIN_READABLE_RATIO) {
      throw new Error(
        `buildCostModel: only ${readable} of ${files.length} archive ` +
          `object(s) could be opened (${(ratio * 100).toFixed(1)}%, floor ` +
          `${(MIN_READABLE_RATIO * 100).toFixed(0)}%). Refusing to write a ` +
          "version built from a fraction of its sample — the row would read " +
          "READY and every backtest pinned to it would inherit the gap.",
      );
    }
  }

  const rows = buildRows(
    cells,
    await deps.listingLiquidity(args.from, args.to),
  );
  const symbolCount = countListings(rows);

  deps.log(
    `cost model: ${counters.rowsRead} row(s) read, ${counters.rowsSampled} sampled, ` +
      `${cells.size} cell(s) -> ${rows.length} row(s) over ${symbolCount} listing(s)`,
  );
  deps.log(
    `  trades: ${counters.tradesRead} read from ${counters.tbboFilesRead} file(s), ` +
      `${counters.tradesSampled} sampled, notTrade=${counters.skippedNotTrade}` +
      (counters.tbboFilesSkippedForTime > 0
        ? `, ${counters.tbboFilesSkippedForTime} file(s) SKIPPED FOR TIME`
        : ""),
  );
  deps.log(
    `  rejected: parse=${counters.parseRejected} sample=${counters.sampleRejected} ` +
      `outsideSession=${counters.skippedOutsideSession} unknownListing=${counters.skippedUnknownListing}`,
  );

  if (!args.apply) {
    return {
      modelVersion: -1,
      rowCount: rows.length,
      symbolCount,
      counters,
      dryRun: true,
    };
  }
  if (rows.length === 0) {
    throw new Error(
      "buildCostModel: every cell was empty after folding " +
        `${counters.rowsRead} row(s). Refusing to write a model with no rows.`,
    );
  }

  const modelVersion = await deps.nextVersion();
  // BUILDING first, and before any row. A build killed mid-way then leaves a
  // visibly incomplete version rather than orphan rows under a version that
  // does not exist — which a version-scoped read cannot see at all, so the
  // failure would render as "the build did nothing".
  await deps.createVersion({
    modelVersion,
    builtFrom: args.from,
    builtTo: args.to,
    builtAt: new Date(),
    trigger: args.trigger,
    // BOTH legs. A version that named only the bbo jobs would make the trade
    // sample unprovenanced — and provenance is the entire reason this row
    // exists, since a backtest pins the version and can never ask again.
    sourceJobIds: [...new Set([...files.map((f) => f.jobId), ...tbboJobIds])],
    // The trade leg's OWN window, which is not `[from, to)`. See the schema
    // comment: a reader cannot otherwise tell a fresh effective column from
    // one sampled two years earlier, and the reader is Python.
    ...(tbboWindow === null
      ? {}
      : {
          effectiveFrom: tbboWindow.from,
          effectiveTo: tbboWindow.to,
          effectiveFileCount: counters.tbboFilesRead,
        }),
  });

  try {
    for (let i = 0; i < rows.length; i += COST_MODEL_WRITE_CHUNK) {
      await deps.writeRows(
        modelVersion,
        rows.slice(i, i + COST_MODEL_WRITE_CHUNK),
      );
    }
  } catch (err) {
    await deps
      .finishVersion({
        modelVersion,
        status: "FAILED",
        rowCount: 0,
        symbolCount: 0,
        detail: err instanceof Error ? err.message : String(err),
      })
      .catch(() => {});
    throw err;
  }

  await deps.finishVersion({
    modelVersion,
    status: "READY",
    rowCount: rows.length,
    symbolCount,
  });
  deps.log(`cost model v${modelVersion} READY: ${rows.length} row(s)`);
  return {
    modelVersion,
    rowCount: rows.length,
    symbolCount,
    counters,
    dryRun: false,
  };
}
