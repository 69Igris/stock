/**
 * Replay the US price warehouse into `lake_silver`. MONEY-1513 (B2-US).
 *
 * A Cloud Run JOB, run as a script. Writes two silver tables from data we
 * already hold — no vendor traffic, no Mongo write, nothing a user can see:
 *
 *   price_bar_d1 (market='US')   Mongo `candles` D1 + the GCS cold shards
 *   fund_nav_d1                  Mongo `us_fund_nav`
 *
 * ## Usage
 *
 *     npx tsx scripts/jobs/lake-replay-us.ts --env qa --from 2024-03-01 --to 2024-03-31
 *     npx tsx scripts/jobs/lake-replay-us.ts --env prod --from 2024-03-01 --to 2024-03-31 --apply
 *     npx tsx scripts/jobs/lake-replay-us.ts --env prod --from 1962-01-01 --to 2026-09-30 \
 *         --tables=price_bar_d1 --apply
 *     npx tsx scripts/jobs/lake-replay-us.ts --env prod --from 2024-03-01 --to 2024-03-31 \
 *         --symbols=AAPL,DOW          # a cheap, real dry run
 *
 * DRY RUN BY DEFAULT. Without `--apply` it reads, resolves, maps, classifies and
 * reports — which is the useful half for sizing a shard — and writes no object,
 * no row and no ledger entry.
 *
 * ## B2 SHIPPED THE MAPPING AND NOT THE JOB
 *
 * MONEY-1496 is Done and `packages/lake/src/price-bar-logic.ts` is real and
 * correct. What never existed is the loader that drives it: measured on prod
 * 2026-09-22, `price_bar_d1` held ONE group — `market=IN`,
 * `source=BHAVCOPY_HIST`, 13,185,397 rows — and zero US rows;
 * `priceBarSourceHash` and `priceBarPartitionKey` had zero non-test callers;
 * `fund_nav_d1` had no writer anywhere in the repo. This is that job.
 *
 * ## TWO WALKS, BECAUSE THE TWO SOURCES ARE SHAPED DIFFERENTLY
 *
 * `price_bar_d1` is walked SYMBOL-MAJOR. The cold tier is keyed
 * `candles/US/D1/{symbol}/{year}`, so a month-major walk would re-read every
 * year shard twelve times: over the 231,861 symbol-years this universe spans,
 * that is ~5.5M GETs instead of ~464k. Symbol-major also makes the hot/cold
 * de-duplication trivially correct — `dedupeBySession` runs over ONE listing's
 * bars, not over a global key set the size of a year.
 *
 * `fund_nav_d1` is walked MONTH-MAJOR. `us_fund_nav` is pure Mongo with no cold
 * tier, indexed on `date`, and a month is ~42,500 rows — so a month is one
 * cursor-paged query and the partition is filled in one pass.
 *
 * ## WHY NOT `CandleRepository.getCandles`
 *
 * It is the right reader for a chart and the wrong one here, for two reasons
 * that are properties of the job rather than of the repository:
 *
 * 1. **It cannot return a shard's GENERATION**, and `priceBarSourceHash` is
 *    specified over generations rather than names — precisely so a shard
 *    rewritten in place produces a new month hash instead of being invisible to
 *    the ledger forever. `CandleReadMeta` reports `coldYearsPresent` and not
 *    which bytes they were.
 * 2. **Its write-back would pull sixty years into a ten-year hot window.**
 *    `writeBack` defaults true and promotes every cold hit to `tier: "LOADED"`;
 *    `CandleQuery` names this case in its own doc ("a one-shot deep-history
 *    export whose 46 years would otherwise be pulled into a hot window sized
 *    for 10"). A replay must not change what the store holds.
 *
 * So the two tiers are read directly — `prisma.candle` and
 * `getFileMetadata` + `downloadFile` + `decodeColdShard` — through the SAME
 * `buildCandleColdKey` the repository and the eviction job use. Nothing here
 * contacts Tiingo: it is a paid metered API and these bytes are already bought.
 *
 * ## THE COLD KEYS ARE COMPUTED, NEVER LISTED
 *
 * `listFiles` fails open to `[]`, so an empty prefix and a storage failure are
 * the same answer and a loader driven by one silently loads nothing and reports
 * success. Every key comes from `planShardYears` + `buildCandleColdKey` and is
 * fetched; a `null` from `getFileMetadata` is a real absence.
 *
 * `UsInstrument.coldYearsFrom/To` is deliberately NOT used to narrow that plan.
 * It would cut the walk from 231,861 shard-years to 130,494 — and it is a STAMP
 * written by the backfill, which only ever widens, so a shard written by
 * `candle-evict` after the stamp sits outside it. A narrowing that can be stale
 * drops a year of history silently; the GETs it saves are cheap by comparison.
 */
import { PrismaClient } from "@prisma/client";

import {
  buildCandleColdKey,
  decodeColdShard,
  type CandleBar,
} from "@usemoney/core/market-data/candles/candle-logic";
import {
  buildListingIndex,
  isPhantomWindow,
  resolveListingForDate,
  windowCoversDate,
  type ListingRow,
} from "@usemoney/core/market-data/databento/databento-symbology";
import { mapWithConcurrency } from "@usemoney/core/market-data/databento/databento-harvest-logic";
import { usMarketDayBoundsUtc } from "@usemoney/core/market-data/us-market-hours";
import { pinJobEnv } from "@usemoney/core/ops/gcp-secrets";
import { guardCompletion } from "@usemoney/core/ops/job-completion";
import { isTransientError } from "@usemoney/core/ops/transient-error";
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { bucketForPrefix } from "@usemoney/core/ops/lake-layout";
import { monthDeleteBounds } from "@usemoney/lake/india-sink-logic";
import {
  acceptPartition,
  beginRun,
  claimPartition,
  endRun,
  quarantine,
  rejectPartition,
} from "@usemoney/lake/ledger";
import {
  acceptOrRefuse,
  formatRefusal,
  missingSessions,
  objectUri,
  runId,
  throwIfRefused,
  type PartitionRefusal,
} from "@usemoney/lake/ledger-logic";
import { replaceMonth } from "@usemoney/lake/load";
import {
  priceBarPartitionKey,
  priceBarSourceHash,
  planShardYears,
  toPriceBarRow,
  type PriceBarRow,
  type RawBar,
} from "@usemoney/lake/price-bar-logic";
import {
  dedupeBySession,
  encodeNdjson,
  stageKey,
  stageShardPrefix,
  STAGE_UPLOAD_POLICY,
} from "@usemoney/lake/stage-logic";
import {
  US_MARKET,
  US_TABLES,
  classifyFundNavRow,
  classifyUsPriceBarRow,
  createSymbolFailureTracker,
  d1SessionDate,
  decideUsMonth,
  hasStitchedHistory,
  isUsTable,
  latestOccupantOf,
  mongoSourceUri,
  snapWindowToMonths,
  stagePartForSource,
  toFundNavRow,
  usDeleteScope,
  usParserVersion,
  type FundNavRow,
  type UsTable,
} from "@usemoney/lake/us-sink-logic";
import {
  downloadFile,
  getFileMetadata,
  retryDelayMs,
  uploadFile,
} from "@usemoney/storage";

import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const JOB = "lake-replay-us";

/** The one timeframe `price_bar_d1` holds. Never `"1d"` — the repo's literal is `D1`. */
const TIMEFRAME = "D1";

/**
 * Cold shards read in parallel. Each symbol-year costs a metadata GET plus a
 * download, and the walk is ~232k symbol-years at full range; serial that is
 * over ten hours of pure latency. Sixteen keeps a Cloud Run job's egress busy
 * without making the Mongo hot query (one per symbol, on the same worker) the
 * new bottleneck.
 */
const SYMBOL_CONCURRENCY = 16;

/**
 * Rows held for one (partition, source) before a stage object is written.
 *
 * The walk is symbol-major and the partitions are months, so a full-range run
 * has ~780 open buffers. A per-buffer threshold alone bounds nothing —
 * 780 x 25,000 is 19.5M rows in memory — so {@link MAX_BUFFERED_ROWS} is the
 * real ceiling and this is only the preferred object size.
 */
const FLUSH_ROWS = 25_000;

/** Total rows buffered across every partition before EVERYTHING is flushed. */
const MAX_BUFFERED_ROWS = 200_000;

/** Mongo page size for the `us_fund_nav` walk. */
const NAV_PAGE = 20_000;

let prisma: PrismaClient;

// `unknown`, not `string`: `reportBuildProvenance` takes a logger whose
// methods accept anything, and a narrower parameter is not assignable to it.
const log = {
  info: (m: unknown) => console.log(m),
  warn: (m: unknown) => console.warn(`WARN  ${String(m)}`),
  err: (m: unknown) => console.error(`ERROR ${String(m)}`),
  error: (m: unknown) => console.error(`ERROR ${String(m)}`),
};

interface Args {
  env: "qa" | "prod";
  from: string;
  to: string;
  tables: UsTable[];
  symbols: string[] | null;
  apply: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i >= 0) return argv[i + 1];
    const inline = argv.find((a) => a.startsWith(`${flag}=`));
    return inline?.slice(flag.length + 1);
  };

  const env = val("--env");
  if (env !== "qa" && env !== "prod")
    throw new Error("--env must be qa or prod");

  const from = val("--from") ?? "";
  const to = val("--to") ?? "";
  if (!from || !to) {
    // NO DEFAULT WINDOW, for `lake-replay-in`'s reason: a replay that defaults
    // to "everything" is a sixty-year walk somebody started by accident, and
    // one that defaults to "today" silently does nothing when the operator
    // meant the backfill.
    throw new Error("--from and --to are required (YYYY-MM-DD)");
  }

  const rawTables = val("--tables");
  const tables = rawTables
    ? rawTables
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...US_TABLES];
  for (const t of tables) {
    if (!isUsTable(t)) {
      throw new Error(
        `--tables: "${t}" is not one of ${US_TABLES.join(" | ")}`,
      );
    }
  }

  const rawSymbols = val("--symbols");
  const symbols = rawSymbols
    ? rawSymbols
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : null;

  // `--symbols` is a DRY-RUN narrowing, never a write scope — MONEY-1538 review.
  // `replaceMonth` deletes the whole (market, month, source) before loading, and
  // since MONEY-1538 that DELETE really deletes. `--symbols=AAPL --apply` would
  // remove every US listing's month and put back only AAPL — and the coverage
  // gate counts SESSIONS, which one listing fills, so it would pass. Before the
  // fix the NULL-bound delete hid this by matching nothing.
  const apply = argv.includes("--apply");
  if (apply && symbols) {
    throw new Error(
      "--symbols cannot be combined with --apply: each month is REPLACED " +
        "whole (market, month, source), so a narrowed walk would delete every " +
        "other listing's rows for that month. Use --symbols for dry runs only.",
    );
  }

  return {
    env,
    from,
    to,
    tables: tables as UsTable[],
    symbols,
    apply,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Partition accumulation
   ──────────────────────────────────────────────────────────────────────── */

interface PartitionState {
  /** Session dates OBSERVED, before quarantine. The coverage DENOMINATOR. */
  sessionsSeen: Set<string>;
  /** Session dates present in rows that survived. The numerator. */
  sessionsWritten: Set<string>;
  rowsKept: number;
  /** GCS generations of every cold shard that contributed a row to this month. */
  shardGenerations: Set<string>;
  /** Max `ts` of a HOT row in this month — the other half of the source hash. */
  hotMaxTsMs: number | null;
  quarantined: Record<string, number>;
  samples: { reason: string; sample: Record<string, unknown> }[];
  /** source -> rows waiting to be staged. */
  buffers: Map<string, object[]>;
  /** source -> next stage part sequence. */
  nextPart: Map<string, number>;
  /** Every source that produced a kept row. One `replaceMonth` per source. */
  sources: Set<string>;
}

function newPartitionState(): PartitionState {
  return {
    sessionsSeen: new Set(),
    sessionsWritten: new Set(),
    rowsKept: 0,
    shardGenerations: new Set(),
    hotMaxTsMs: null,
    quarantined: {},
    samples: [],
    buffers: new Map(),
    nextPart: new Map(),
    sources: new Set(),
  };
}

/** The shared, mutable state of one table's walk. */
interface Walk {
  table: UsTable;
  env: "qa" | "prod";
  apply: boolean;
  runIdent: string;
  /** `stockbook-lake-{env}` — where stage objects are WRITTEN. */
  stageBucket: string;
  /** `stockbook-content-{env}` — where the cold shards are READ from. */
  contentBucket: string;
  partitions: Map<string, PartitionState>;
  bufferedRows: number;
  /**
   * Rows reaching the classifier — for bars, hot + cold AFTER
   * `dedupeBySession` and BEFORE any quarantine; for NAVs, rows paged out of
   * Mongo. Not a raw read count: the shards hold whole years and most of what
   * they decode is outside the window (see {@link Walk.rowsOutOfWindow}).
   */
  rowsSeen: number;
  /** Rows excluded because their session fell outside the snapped window. */
  rowsOutOfWindow: number;
  shardsRead: number;
  shardsAbsent: number;
  shardsUnreadable: number;
  stageObjects: number;
  /**
   * Symbols whose cold KEY cannot be built, named rather than counted.
   *
   * A documented FLOOR, not a failure: `buildCandleColdKey` refuses a `/` or a
   * control character because such a key files the object one level deeper,
   * where the reader that computed it would still find it and a prefix listing
   * would not — an invisible reshape of the hierarchy. A symbol it refuses
   * therefore HAS no cold tier under our scheme, so there is nothing to read
   * and the hot leg still runs for it.
   *
   * Measured on prod 2026-09-22: exactly THREE — `BC/PA`, `BC/PB`, `BC/PC`,
   * all DELISTED NYSE stocks, and NONE of them has a single D1 candle. The
   * cost of the refusal is zero rows; the cost of not catching it was the whole
   * run, which is how this was found.
   */
  symbolsNoColdKey: string[];
  /**
   * Symbols whose walk THREW for any other reason.
   *
   * `mapWithConcurrency` deliberately does not catch — its own doc says a
   * caller needing per-item isolation must catch inside its task — so without
   * this one bad symbol abandons the other ten thousand. Isolated, but NEVER
   * swallowed: a symbol missing from the walk is missing from `sessionsSeen`
   * too, so the coverage gate cannot see the gap and would ACCEPT the month
   * over it. The walk throws at the end instead, with the names.
   */
  symbolsFailed: string[];
  /** Rows admitted by the `LATEST_OCCUPANT` arm (MONEY-1616). */
  rowsLatestOccupant: number;
  /** Symbols withdrawn from that arm by `hasStitchedHistory`, by name. */
  symbolsStitched: string[];
}

function partitionOf(walk: Walk, key: string): PartitionState {
  const existing = walk.partitions.get(key);
  if (existing) return existing;
  const created = newPartitionState();
  walk.partitions.set(key, created);
  return created;
}

function countQuarantine(
  state: PartitionState,
  reason: string,
  sample: Record<string, unknown>,
): void {
  state.quarantined[reason] = (state.quarantined[reason] ?? 0) + 1;
  // The cap is on the SAMPLE, never on the count — an under-reported refusal
  // count is the number an operator would act on (`siftRows` makes the same
  // split, and this walk cannot call it because its reasons are US ones).
  if (state.samples.filter((s) => s.reason === reason).length < 3) {
    state.samples.push({ reason, sample });
  }
}

/**
 * Push a mapped row into its partition's buffer, flushing when full.
 *
 * `flushAll` is the ceiling that actually holds: a per-buffer threshold over
 * ~780 open months bounds nothing.
 */
async function emit(
  walk: Walk,
  partitionKey: string,
  source: string,
  sessionDate: string,
  row: object,
): Promise<void> {
  const state = partitionOf(walk, partitionKey);
  state.rowsKept++;
  state.sessionsWritten.add(sessionDate);
  state.sources.add(source);
  const buffer: object[] = state.buffers.get(source) ?? [];
  buffer.push(row);
  state.buffers.set(source, buffer);
  walk.bufferedRows++;

  if (buffer.length >= FLUSH_ROWS) {
    await flushOne(walk, partitionKey, state, source);
  } else if (walk.bufferedRows >= MAX_BUFFERED_ROWS) {
    await flushAll(walk);
  }
}

async function flushOne(
  walk: Walk,
  partitionKey: string,
  state: PartitionState,
  source: string,
): Promise<void> {
  // TAKEN OUT OF THE MAP BEFORE THE AWAIT. `mapWithConcurrency` keeps sixteen
  // symbol tasks in flight, and although none of them runs between two
  // statements, every one of them CAN run while this upload is awaited. Leaving
  // the array in place would let a concurrent `emit` push into a batch that is
  // already being written, and those rows would be counted and then dropped.
  const rows = state.buffers.get(source);
  if (!rows || rows.length === 0) return;
  state.buffers.set(source, []);
  walk.bufferedRows -= rows.length;

  const sequence = state.nextPart.get(source) ?? 0;
  state.nextPart.set(source, sequence + 1);
  if (!walk.apply) {
    // A dry run still DROPS the rows rather than accumulating them: the counts
    // are already recorded, and holding sixty years of bars to report a number
    // is the one way a dry run can fail where the real run would not.
    walk.stageObjects++;
    return;
  }
  await uploadFile({
    file: Buffer.from(encodeNdjson(rows), "utf8"),
    fileName: stageKey({
      table: walk.table,
      partitionKey,
      runId: walk.runIdent,
      part: stagePartForSource(source, sequence),
    }),
    contentType: "application/x-ndjson",
    isPublic: false,
    bucketName: walk.stageBucket,
    ...STAGE_UPLOAD_POLICY,
  });
  walk.stageObjects++;
}

async function flushAll(walk: Walk): Promise<void> {
  for (const [partitionKey, state] of walk.partitions) {
    for (const source of [...state.buffers.keys()]) {
      await flushOne(walk, partitionKey, state, source);
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   price_bar_d1
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The instant a session date is RESOLVED at — 04:00 ET of that session, not
 * UTC midnight.
 *
 * `windowCoversDate` compares against `usMarketDayBoundsUtc` of the listing's
 * own bounds, so its start bound is 04:00 ET of the listing's first day. A D1
 * bar's timestamp is UTC MIDNIGHT of the session, which under both EST and EDT
 * is EARLIER than that — so resolving at the raw timestamp puts every listing's
 * FIRST SESSION before its own window and quarantines it as unresolved. Using
 * the session's own open instant puts both sides on one clock.
 */
function resolutionInstant(sessionDate: string): Date {
  return new Date(usMarketDayBoundsUtc(sessionDate).startMs);
}

/** A cold `CandleBar` or a hot Prisma row, as `toPriceBarRow` wants it. */
function toRawBar(bar: {
  symbol: string;
  exchange: string;
  listingId: string;
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | bigint;
  divCash: number;
  splitFactor: number;
  source: string;
}): RawBar & { sessionDate: string } {
  return {
    market: US_MARKET,
    listingId: bar.listingId,
    symbol: bar.symbol,
    exchange: bar.exchange,
    sessionDate: d1SessionDate(bar.ts),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    divCash: bar.divCash,
    splitFactor: bar.splitFactor,
    source: bar.source,
  };
}

/**
 * A symbol's reads, re-attempted up to {@link READ_RETRIES} times — but only
 * on a TRANSIENT failure (MONEY-1608 review). A 403, a missing bucket or a
 * Prisma validation error is permanent, and retrying it across 23,389 symbols
 * at 15 + 60 + 240 s each would be ~128 h of silence.
 */
const READ_RETRIES = 3;
async function withReadRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (err) {
      if (attempt > READ_RETRIES || !isTransientError(err)) throw err;
      await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
    }
  }
}

/** One symbol's contribution: cold shards, then the hot window, de-duplicated. */
async function replaySymbol(args: {
  walk: Walk;
  symbol: string;
  windows: readonly ListingRow[];
  from: string;
  to: string;
  currentYear: number;
}): Promise<void> {
  const { walk, symbol, windows, from, to, currentYear } = args;
  const fromYear = Number(from.slice(0, 4));
  const toYear = Number(to.slice(0, 4));

  // MONEY-1616. A recycled ticker with a unique current occupant may have that
  // occupant's AMBIGUOUS bars admitted — but only if `hasStitchedHistory` finds
  // none of its bars before its own window, and those bars PREDATE the overlap
  // by construction. A run sharded by date (1962-1999 / 2000-2014 / 2015-) would
  // never see them from the shard that admits, so these symbols (~1k of ~23k,
  // ~2.4k shards) are read WHOLE; rows outside the window are still skipped
  // below, and their shards never enter a partition's source hash.
  const occupant = latestOccupantOf(windows);
  const wholeHistory = occupant !== null;

  /* ── cold ───────────────────────────────────────────────────────────── */

  const years = new Set<number>();
  for (const w of windows) {
    for (const year of planShardYears({
      listingStartYear: w.listingStartDate?.getUTCFullYear() ?? 0,
      listingEndYear: w.listingEndDate?.getUTCFullYear() ?? null,
      currentYear,
    })) {
      if (wholeHistory || (year >= fromYear && year <= toYear)) years.add(year);
    }
  }

  // EVERY KEY IS BUILT BEFORE THE FIRST FETCH, so a symbol the key builder
  // refuses is answered ONCE and named, rather than throwing on its first year
  // and taking the whole `mapWithConcurrency` down with it. The hot leg below
  // still runs: a symbol with no reachable cold tier can still have Mongo rows.
  let coldKeys: { year: number; key: string }[] = [];
  try {
    coldKeys = [...years]
      .sort((a, b) => a - b)
      .map((year) => ({
        year,
        key: buildCandleColdKey({
          market: US_MARKET,
          timeframe: TIMEFRAME,
          symbol,
          year,
        }),
      }));
  } catch {
    walk.symbolsNoColdKey.push(symbol);
  }

  // THE READS ARE RETRIED, THE EMITS ARE NOT — MONEY-1608. Nothing below is
  // emitted until every read for this symbol has succeeded, so re-running the
  // reads re-reads and never double-counts or double-emits; the shard counters
  // are therefore kept per ATTEMPT and folded in only on success. The GCS
  // client gives up on a GET within seconds, and a symbol that throws fails the
  // WHOLE run at the end (see `symbolsFailed`) — so on 2026-09-23 the four
  // minutes of DNS outage (07:25-07:29Z) would have sunk an eight-hour walk on
  // their own. The same 15 s / 60 s / 240 s ladder as the stage upload.
  const { cold, hot, counts } = await withReadRetry(async () => {
    const counts = { read: 0, absent: 0, unreadable: 0 };
    const cold: (RawBar & {
      sessionDate: string;
      generation: string;
      shardYear: number;
    })[] = [];
    for (const { year, key } of coldKeys) {
      // METADATA FIRST, and this is the whole no-listing design in two calls.
      // `getFileMetadata` returns null for an absent object and THROWS for an
      // absent bucket, so a 404 is a real gap rather than `listFiles`'s fail-open
      // `[]`. It also supplies the GENERATION, which `downloadFile` cannot — and
      // the generation is what makes a rewritten shard produce a new month hash
      // instead of being invisible to the ledger for ever.
      const meta = await getFileMetadata(key);
      if (!meta) {
        counts.absent++;
        continue;
      }
      const body = await downloadFile(key);
      if (!body) {
        counts.absent++;
        continue;
      }
      let bars: CandleBar[];
      try {
        bars = await decodeColdShard(body);
      } catch (err) {
        // An UNREADABLE shard is not an ABSENT one, and the split is the point:
        // `decodeColdShard` throws on bytes it cannot sniff rather than returning
        // an empty year, so a corrupt object is counted here and the months it
        // covers are NOT accepted over it.
        counts.unreadable++;
        log.warn(`${key}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      counts.read++;
      const generation = String(meta.generation ?? "");
      for (const bar of bars) {
        // A SHARD IS KEYED BY SYMBOL AND YEAR, so it can hold bars for two
        // different occupancy windows of a recycled ticker across its lifetime —
        // and `listing_id` is what keeps them apart. The per-bar id is kept and
        // checked below rather than assumed from the shard's name.
        // `shardYear` is the year of the OBJECT, not of the bar. A shard can hold
        // a stray bar from an adjacent year, and deriving the provenance uri from
        // the bar's own date would then name a shard this row did not come out
        // of — a trace that leads to the wrong bytes, or to none.
        cold.push({ ...toRawBar(bar), generation, shardYear: year });
      }
    }

    /* ── hot ────────────────────────────────────────────────────────────── */

    const hotRows = await prisma.candle.findMany({
      where: {
        symbol,
        timeframe: TIMEFRAME,
        // `lte`, not `lt`: a D1 `ts` is UTC MIDNIGHT of its session, so the last
        // session of the window is exactly `to` at 00:00Z. Unbounded for a
        // whole-history symbol (see `wholeHistory`).
        ...(wholeHistory
          ? {}
          : {
              ts: {
                gte: new Date(`${from}T00:00:00.000Z`),
                lte: new Date(`${to}T00:00:00.000Z`),
              },
            }),
      },
      select: {
        symbol: true,
        exchange: true,
        listingId: true,
        ts: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        divCash: true,
        splitFactor: true,
        source: true,
      },
    });
    const hot = hotRows.map((r) => toRawBar(r));
    return { cold, hot, counts };
  });
  walk.shardsRead += counts.read;
  walk.shardsAbsent += counts.absent;
  walk.shardsUnreadable += counts.unreadable;

  /* ── merge, classify, emit ──────────────────────────────────────────── */

  // THE HOT ROW WINS on a (listing, session) collision. Both describe the same
  // session, but the hot row is the one a later correction would have been
  // written to — `putCandles` updates OHLC in place on an upgrade, while a cold
  // shard is a point-in-time archive — so preferring the shard would silently
  // revert a corrected bar. Overlap is EXPECTED: `planShardYears` deliberately
  // does not subtract the hot window, because the current year's shard exists
  // once `candle-evict` has archived part of it.
  const merged = dedupeBySession(hot, cold);
  const stitched =
    occupant !== null &&
    hasStitchedHistory({ occupant, windows, bars: merged });
  if (stitched) walk.symbolsStitched.push(symbol);

  for (const bar of merged) {
    walk.rowsSeen++;
    if (bar.sessionDate < from || bar.sessionDate > to) {
      // A cold shard is a whole YEAR and the window is days. Not a quarantine:
      // the bar is fine, it is simply outside what this run replaces.
      walk.rowsOutOfWindow++;
      continue;
    }
    const partitionKey = priceBarPartitionKey(US_MARKET, bar.sessionDate);
    const state = partitionOf(walk, partitionKey);
    state.sessionsSeen.add(bar.sessionDate);

    const cold = bar as { generation?: string; shardYear?: number };
    const generation = cold.generation;

    // THE SOURCE HASH IS "WHAT THIS PARTITION WAS BUILT FROM", which includes
    // inputs the classifier then REFUSED. Recorded before the verdict, not
    // after: a shard whose rows were all quarantined still contributed to the
    // decision, and leaving its generation out means a REPAIRED shard produces
    // an unchanged month hash, `decideClaim` says ALREADY ACCEPTED, and the
    // corrected bars never land — the exact invisibility hashing generations
    // rather than names exists to prevent. Measured: a March-2015 run over
    // VR/ESCR/AAPL recorded ONE generation for three shards read.
    if (generation) state.shardGenerations.add(generation);
    else {
      const ms = Date.parse(`${bar.sessionDate}T00:00:00.000Z`);
      // PER MONTH, never the run's global max. One hash per partition is what
      // makes a new session reload only the month it landed in; a global max
      // would change every month's hash on every new day.
      if (state.hotMaxTsMs === null || ms > state.hotMaxTsMs) {
        state.hotMaxTsMs = ms;
      }
    }

    const prov = {
      // A hot bar has no object behind it; a cold one does, and the two have
      // genuinely different failure modes. `mongoSourceUri` says "Mongo held
      // this and no shard did", which is the only way to tell after the fact
      // that a month was loaded before `candle-evict` archived it.
      sourceObjectUri: generation
        ? objectUri(
            // The CONTENT bucket, never the stage one: `candles/` and
            // `lake/stage/` are routed to different buckets by the lake
            // contract, and a provenance uri naming the wrong one traces back
            // to an object that does not exist.
            walk.contentBucket,
            buildCandleColdKey({
              market: US_MARKET,
              timeframe: TIMEFRAME,
              symbol,
              year: cold.shardYear ?? Number(bar.sessionDate.slice(0, 4)),
            }),
          )
        : mongoSourceUri("candles", `${bar.listingId}:${TIMEFRAME}`),
      sourceRecordKey: `${bar.listingId}:${bar.sessionDate}`,
      pipelineRunId: walk.runIdent,
      // OBSERVED is the SESSION the bar describes, never `now`. Point-in-time
      // correctness is observed_at (lake-layout.md §6); stamping the replay's
      // clock would back-date sixty years of history to today.
      observedAtMs: Date.parse(`${bar.sessionDate}T00:00:00.000Z`),
      ingestedAtMs: Date.now(),
      parserVersion: usParserVersion("price_bar_d1"),
    };

    const at = resolutionInstant(bar.sessionDate);
    const resolution = resolveListingForDate(windows, at);
    const row: PriceBarRow = toPriceBarRow(bar, prov);
    const verdict = classifyUsPriceBarRow({
      row,
      resolution,
      // The candidates by ID, which the resolver reports only as a count.
      // Same predicate, same instant, same phantom drop (MONEY-1617), so they
      // are the windows it saw — and a phantom that happens to end last can
      // never be admitted through this arm after losing the resolver's tie.
      occupancy:
        !resolution.ok && resolution.reason === "ambiguous"
          ? {
              candidateIds: windows
                .filter(
                  (w) =>
                    windowCoversDate(w, at) && !isPhantomWindow(w, windows),
                )
                .map((w) => w.listingId),
              latestOccupantId: occupant?.listingId ?? null,
              stitched,
            }
          : undefined,
    });
    if (!verdict.keep) {
      countQuarantine(state, verdict.reason, {
        symbol,
        listing_id: row.listing_id,
        session_date: row.session_date,
        source: row.source,
      });
      continue;
    }
    row.resolution_method = verdict.method;
    if (verdict.method === "LATEST_OCCUPANT") walk.rowsLatestOccupant++;

    await emit(walk, partitionKey, row.source, row.session_date, row);
  }
}

async function replayPriceBars(args: {
  walk: Walk;
  from: string;
  to: string;
  symbolFilter: string[] | null;
}): Promise<void> {
  const { walk, from, to, symbolFilter } = args;

  // THE WHOLE MASTER FEEDS THE INDEX, and only the WALK LIST is narrowed.
  // `resolveListingForDate` decides "ambiguous" by looking at every window that
  // covers a date, so dropping one of a recycled ticker's two rows would turn a
  // genuine ambiguity into a confident wrong answer — the DOW hazard arriving
  // through the filter meant to make the walk cheaper.
  //
  // Mutual funds are excluded because they have no candles at all: their NAVs
  // live in `us_fund_nav` (`HOT_WINDOW_YEARS` records why — 72% of a ten-year
  // window would have been funds), and measured on prod 2026-09-22 not one of
  // the 49,860 fund rows carries a `coldYearsFrom`. Including them would spend
  // ~1.6M GETs to 404.
  const master = await prisma.usInstrument.findMany({
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
  const index = buildListingIndex(master);

  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T00:00:00.000Z`);
  let symbols = [...index.keys()].filter((symbol) =>
    (index.get(symbol) ?? []).some(
      (w) =>
        (w.listingStartDate === null || w.listingStartDate <= toDate) &&
        (w.listingEndDate === null || w.listingEndDate >= fromDate),
    ),
  );
  if (symbolFilter) {
    const wanted = new Set(symbolFilter);
    symbols = symbols.filter((s) => wanted.has(s));
    const missing = symbolFilter.filter((s) => !index.has(s));
    if (missing.length > 0) {
      // NAMED, never silent. A symbol the master does not hold is a real fact
      // about the request, and a silent omission is how a targeted run reports
      // a clean pass over something it never looked at.
      log.warn(`--symbols not in the master: ${missing.join(", ")}`);
    }
  }

  log.info(
    `price_bar_d1 — master ${master.length} listings / ${index.size} symbols; ` +
      `walking ${symbols.length}`,
  );

  const currentYear = new Date().getUTCFullYear();
  const failures = createSymbolFailureTracker();
  await mapWithConcurrency(symbols, SYMBOL_CONCURRENCY, async (symbol) => {
    // PER-SYMBOL ISOLATION. `mapWithConcurrency` does not catch, so one throw
    // rejects the whole call and abandons the other ten thousand symbols —
    // which is exactly what a single `BC/PB` did on the first full prod dry run.
    try {
      await replaySymbol({
        walk,
        symbol,
        windows: index.get(symbol) ?? [],
        from,
        to,
        currentYear,
      });
      failures.ok();
    } catch (err) {
      walk.symbolsFailed.push(
        `${symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // LOGGED NOW, not after the walk; and a run of failures ends the walk
      // with a named error rather than walking every symbol into a broken
      // dependency (MONEY-1608 review).
      log.err(failures.fail(symbol, err));
    }
  });
  await flushAll(walk);

  log.info(
    `  LATEST_OCCUPANT rows=${walk.rowsLatestOccupant}; stitched (withheld) ` +
      `${walk.symbolsStitched.length}: ${walk.symbolsStitched.sort().join(", ")}`,
  );

  if (walk.symbolsNoColdKey.length > 0) {
    log.info(
      `  no cold key (hot leg only): ${walk.symbolsNoColdKey.length} — ` +
        `${walk.symbolsNoColdKey.slice(0, 10).join(", ")}`,
    );
  }

  // RECONCILE AGAINST THE SOURCE'S OWN COUNT. The walk is driven by the MASTER,
  // so a `candles` row whose symbol is not in it — an orphan, a fund that
  // somehow acquired bars, a listing the master has since dropped — would be
  // silently absent from every counter above. One query says whether that
  // happened; 0-counts are red flags and so is an unexplained gap.
  const hotInWindow = await prisma.candle.count({
    where: {
      timeframe: TIMEFRAME,
      ts: {
        gte: new Date(`${from}T00:00:00.000Z`),
        lte: new Date(`${to}T00:00:00.000Z`),
      },
    },
  });
  const inWindow = walk.rowsSeen - walk.rowsOutOfWindow;
  log.info(
    `price_bar_d1 — hot rows in window: ${hotInWindow} (Mongo) vs ` +
      `${inWindow} merged rows reached (hot + cold, de-duplicated). ` +
      (symbolFilter
        ? "--symbols narrows the walk, so a gap here is expected."
        : "merged >= hot is normal wherever a cold shard covers the window; " +
          "merged < hot means the master-driven walk missed symbols Mongo holds bars for."),
  );

  // REFUSE, do not trim. A symbol whose walk threw contributed no bars, so it
  // contributed no `sessionsSeen` either — the coverage gate compares what was
  // READ against what SURVIVED and cannot see a symbol that was never read. An
  // ACCEPTED month is skipped by every future run, so accepting one over an
  // incomplete walk freezes the gap permanently. Throwing here means
  // `finishPartitions` never runs and `endRun` records FAILED.
  if (walk.symbolsFailed.length > 0) {
    throw new Error(
      `${walk.symbolsFailed.length} symbol(s) failed and no partition may be ` +
        `accepted over an incomplete walk: ` +
        walk.symbolsFailed.slice(0, 10).join(" | ") +
        (walk.symbolsFailed.length > 10 ? " | …" : ""),
    );
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   fund_nav_d1
   ──────────────────────────────────────────────────────────────────────── */

/** Every `YYYY-MM` the snapped window covers, ascending. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

async function replayFundNavs(
  walk: Walk,
  from: string,
  to: string,
): Promise<void> {
  const months = monthsBetween(from, to);
  log.info(`fund_nav_d1 — ${months.length} month(s)`);

  for (const month of months) {
    // The QUERY BOUND and the PARTITION KEY are derived from the same month by
    // the same two functions the loader uses, so the rows selected and the rows
    // deleted are the same month by construction. `classifyFundNavRow` still
    // re-checks each row against the key — they are two spellings, and
    // `finishPartitions` will delete this whole month whatever landed here.
    const partitionKey = priceBarPartitionKey(US_MARKET, `${month}-01`);
    const bounds = monthDeleteBounds(partitionKey);
    const state = partitionOf(walk, partitionKey);
    const monthStart = new Date(`${bounds.fromInclusive}T00:00:00.000Z`);
    const monthEnd = new Date(`${bounds.toExclusive}T00:00:00.000Z`);

    let cursor: string | null = null;
    for (;;) {
      // ANNOTATED, because `cursor` is assigned FROM `page` and read back INTO
      // the query — a self-reference TypeScript cannot infer through, which it
      // reports as an implicit `any` and which would silently unType every
      // field read below.
      const page: {
        id: string;
        permaTicker: string;
        symbol: string;
        date: Date;
        nav: number;
        source: string;
      }[] = await prisma.usFundNav.findMany({
        where: { date: { gte: monthStart, lt: monthEnd } },
        select: {
          id: true,
          permaTicker: true,
          symbol: true,
          date: true,
          nav: true,
          source: true,
        },
        orderBy: { id: "asc" },
        take: NAV_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1]!.id;

      for (const nav of page) {
        walk.rowsSeen++;
        const navDate = d1SessionDate(nav.date);
        state.sessionsSeen.add(navDate);
        // `fund_nav_d1` HAS NO COLD TIER, so `hotMaxTsMs` is the ONLY input to
        // this partition's source hash. Left unset it stays `null`, every month
        // hashes to the same constant, and the CURRENT month — the one that
        // grows every night — is ACCEPTED on its first partial run and skipped
        // for ever after. Tracked over the rows actually read, not over the
        // query bound, so a month that stops mid-way rehashes when it resumes.
        // It inherits B2's own limitation and does not widen it: a row
        // backfilled INTO an already-loaded month does not move the max, so
        // that month is not reloaded. Bump `us-fund-nav-v1` to force it —
        // that is what `parser_version` is in the ledger key for.
        const ms = nav.date.getTime();
        if (state.hotMaxTsMs === null || ms > state.hotMaxTsMs) {
          state.hotMaxTsMs = ms;
        }
        const row: FundNavRow = toFundNavRow(
          {
            permaTicker: nav.permaTicker,
            symbol: nav.symbol,
            navDate,
            nav: nav.nav,
            source: nav.source,
          },
          {
            sourceObjectUri: mongoSourceUri("us_fund_nav", nav.permaTicker),
            sourceRecordKey: `${nav.permaTicker}:${navDate}`,
            pipelineRunId: walk.runIdent,
            observedAtMs: nav.date.getTime(),
            ingestedAtMs: Date.now(),
            parserVersion: usParserVersion("fund_nav_d1"),
          },
        );
        const reason = classifyFundNavRow({ row, partitionKey });
        if (reason) {
          countQuarantine(state, reason, {
            perma_ticker: row.perma_ticker,
            nav_date: row.nav_date,
          });
          continue;
        }
        await emit(walk, partitionKey, row.source, row.nav_date, row);
      }
      if (page.length < NAV_PAGE) break;
    }
  }
  await flushAll(walk);
}

/* ─────────────────────────────────────────────────────────────────────────
   Load
   ──────────────────────────────────────────────────────────────────────── */

async function finishPartitions(walk: Walk): Promise<PartitionRefusal[]> {
  const refused: PartitionRefusal[] = [];
  const dataset = `lake_silver_${walk.env}`;
  const parserVersion = usParserVersion(walk.table);
  // The market predicate and the partition column, both decided in the PURE
  // module and tested there — a `null` market on `price_bar_d1` would delete
  // thirteen million India rows that this load does not replace.
  const scope = usDeleteScope(walk.table);

  for (const [partitionKey, state] of [...walk.partitions].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const head =
      `${walk.table} ${partitionKey}  seen=${state.sessionsSeen.size}d ` +
      `written=${state.sessionsWritten.size}d rows=${state.rowsKept} ` +
      `shards=${state.shardGenerations.size} ` +
      `sources=${[...state.sources].join("+") || "-"}` +
      (Object.keys(state.quarantined).length
        ? ` quarantined=${JSON.stringify(state.quarantined)}`
        : "");

    const verdict = decideUsMonth({
      sessionsSeen: state.sessionsSeen,
      sessionsWritten: state.sessionsWritten,
      rowCount: state.rowsKept,
    });
    if (verdict.action === "skip") {
      log.info(`  SKIP   ${head} — ${verdict.reason}`);
      continue;
    }
    if (!walk.apply) {
      log.info(`  DRY    ${head}`);
      // ONE SAMPLE PER REASON, dry run only. On `--apply` these go to the
      // ledger's quarantine table; without them here an operator sizing a
      // sixty-year run reads a refusal COUNT with nothing to tell the DOW
      // hazard apart from a defect in the resolution, which is the one
      // question the count cannot answer.
      const shown = new Set<string>();
      for (const s of state.samples) {
        if (shown.has(s.reason)) continue;
        shown.add(s.reason);
        log.info(`         ${s.reason}: ${JSON.stringify(s.sample)}`);
      }
      continue;
    }

    const key = {
      dataset,
      table: walk.table,
      partitionKey,
      sourceHash: priceBarSourceHash({
        shardGenerations: [...state.shardGenerations],
        hotMaxTsMs: state.hotMaxTsMs,
      }),
      parserVersion,
    };
    const claim = await claimPartition(key, { runId: walk.runIdent });
    if (claim.action === "skip") {
      log.info(`  SKIP   ${head} — ledger: ${claim.reason}`);
      continue;
    }

    const bounds = monthDeleteBounds(partitionKey);
    const prefix = stageShardPrefix({
      table: walk.table,
      partitionKey,
      runId: walk.runIdent,
    });
    const stageUri = (source: string): string =>
      `gs://${walk.stageBucket}/${prefix}${source}-*`;
    // ONE DELETE-AND-LOAD PER SOURCE. `replaceMonth` scopes its DELETE by
    // `source`, so a month holding two sources loaded as one unit would have
    // the second load delete the first's rows. The stage part carries the
    // source, which is what makes a per-source wildcard possible at all.
    let deleted = 0;
    let loaded = 0;
    for (const source of [...state.sources].sort()) {
      const result = await replaceMonth({
        table: walk.table,
        market: scope.market,
        fromInclusive: bounds.fromInclusive,
        toExclusive: bounds.toExclusive,
        source,
        dateColumn: scope.dateColumn,
        sourceUris: [stageUri(source)],
      });
      deleted += result.deleted;
      loaded += result.loaded;
    }

    if (Object.keys(state.quarantined).length > 0) {
      await quarantine({
        dataset,
        table: walk.table,
        partitionKey,
        runId: walk.runIdent,
        reason: Object.entries(state.quarantined)
          .map(([r, n]) => `${r}=${n}`)
          .join(","),
        sample: state.samples.slice(0, 5),
      });
    }

    // ACCEPT LAST, and only with real counts. `acceptPartition` runs
    // `decideCoverage` inside itself and THROWS rather than returning a verdict
    // a caller could ignore — ACCEPTED is what makes every future run skip, so
    // a partial month accepted here is a gap frozen permanently.
    //
    // A refusal is THIS month's verdict, not the run's — MONEY-1612, the same
    // change as `lake-replay-in`: REJECTED, logged with its missing sessions,
    // the walk continues and `main` fails the run at the end. Any other error
    // still aborts.
    const refusal = await acceptOrRefuse(
      key,
      {
        runId: walk.runIdent,
        rowCount: loaded,
        expectedSessions: verdict.expectedSessions,
        actualSessions: verdict.actualSessions,
        missingSessions: missingSessions(
          state.sessionsSeen,
          state.sessionsWritten,
        ),
      },
      { accept: acceptPartition, reject: rejectPartition, quarantine },
    );
    if (refusal) {
      log.err(
        `${formatRefusal(refusal)}  (deleted=${deleted} loaded=${loaded})`,
      );
      refused.push(refusal);
      continue;
    }
    log.info(`  LOAD   ${head} deleted=${deleted} loaded=${loaded}`);
  }
  return refused;
}

/* ─────────────────────────────────────────────────────────────────────────
   main
   ──────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const args = parseArgs();
  await initJobTelemetry();
  reportBuildProvenance(log, JOB);

  // PINNED FROM `--env`, BEFORE ANY CLIENT IS CONSTRUCTED — MONEY-1514.
  // `@usemoney/database` exports a Prisma singleton built from `DATABASE_URL`
  // AT IMPORT, and `.env` is QA, so importing it would read QA Mongo while
  // every log line said `env=prod`. An explicit datasource removes the
  // import-order trap instead of relying on it being unreachable.
  const { databaseUrl } = pinJobEnv(args.env);
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  // The COLD SHARDS live under `candles/`, which the lake contract routes to
  // the CONTENT bucket. `getFileMetadata` has no bucket override and reads
  // `GCP_STORAGE_BUCKET`, so without this a `--env prod` run would read
  // whatever bucket the shell happened to export — QA's, in a dev shell —
  // and report the whole universe as having no shards.
  process.env.GCP_STORAGE_BUCKET = bucketForPrefix("candles/", args.env);

  const window = snapWindowToMonths(args.from, args.to);
  const startedAt = new Date();
  const runIdent = runId(JOB, startedAt.getTime());
  const stageBucket = bucketForPrefix("lake/stage/", args.env);

  log.info(
    `\n${JOB} — ${args.env}  ${window.from}..${window.to}` +
      (window.from !== args.from || window.to !== args.to
        ? `  (SNAPPED from ${args.from}..${args.to} — both tables are ` +
          `MONTH-partitioned and replaceMonth deletes a whole month)`
        : "") +
      `  tables=${args.tables.join(",")}` +
      (args.symbols ? `  symbols=${args.symbols.join(",")}` : "") +
      `  ${args.apply ? "APPLY" : "DRY RUN"}\n`,
  );

  if (args.apply) {
    await beginRun({ runId: runIdent, job: JOB, startedAt });
  }

  let failed = false;
  const refused: PartitionRefusal[] = [];
  try {
    for (const table of args.tables) {
      const walk: Walk = {
        table,
        env: args.env,
        apply: args.apply,
        runIdent,
        stageBucket,
        contentBucket: bucketForPrefix("candles/", args.env),
        partitions: new Map(),
        bufferedRows: 0,
        rowsSeen: 0,
        rowsOutOfWindow: 0,
        shardsRead: 0,
        shardsAbsent: 0,
        shardsUnreadable: 0,
        stageObjects: 0,
        symbolsNoColdKey: [],
        symbolsFailed: [],
        rowsLatestOccupant: 0,
        symbolsStitched: [],
      };
      log.info(`\n${table}`);
      if (table === "price_bar_d1") {
        await replayPriceBars({
          walk,
          from: window.from,
          to: window.to,
          symbolFilter: args.symbols,
        });
        log.info(
          `  shards read=${walk.shardsRead} absent=${walk.shardsAbsent} ` +
            `unreadable=${walk.shardsUnreadable}  rows seen=${walk.rowsSeen} ` +
            `outOfWindow=${walk.rowsOutOfWindow}  stageObjects=${walk.stageObjects}`,
        );
      } else {
        if (args.symbols) {
          // `--symbols` narrows the CANDLE walk. `us_fund_nav` keys on
          // permaTicker, which is a different identifier space, so silently
          // applying the flag here would report a filtered run as a full one.
          log.warn(`--symbols does not apply to ${table}; walking all rows`);
        }
        await replayFundNavs(walk, window.from, window.to);
        log.info(
          `  rows seen=${walk.rowsSeen}  stageObjects=${walk.stageObjects}`,
        );
      }
      refused.push(...(await finishPartitions(walk)));
    }
    // After every table and month has had its turn — a run that refused any
    // exits non-zero with each refusal listed.
    throwIfRefused(refused);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (args.apply) {
      await endRun({
        runId: runIdent,
        status: failed ? "FAILED" : "SUCCESS",
        finishedAt: new Date(),
        notes: refused.length ? refused.map(formatRefusal).join("\n") : null,
      }).catch((e) => log.err(`endRun failed: ${String(e)}`));
    }
    await prisma.$disconnect().catch(() => {});
  }
}

guardCompletion(JOB, main()).catch((err) => {
  log.err(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
