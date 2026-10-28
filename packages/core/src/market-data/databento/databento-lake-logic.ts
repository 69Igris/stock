/**
 * Pure decisions for the Databento -> BigQuery bar loader. MONEY-1505 (B5).
 *
 * No GCS, no BigQuery, no Mongo, no clock. `scripts/jobs/lake-load-databento.ts`
 * is the I/O shell; everything that can be silently wrong lives here.
 *
 * ## WHAT THIS BYPASSES, AND WHY THAT IS THE POINT
 *
 * The existing loader (`databento-candle-loader.ts` -> `databento-session-writer.ts`)
 * buffers a whole symbol so the cold-shard writer can read, merge and REWRITE a
 * whole symbol-year object per flush. That seam exists to keep `candles`
 * consistent, and it is exactly what makes a 151.5M-row replay unaffordable:
 * the wrong split once produced 439,569 whole-object rewrites.
 *
 * Nothing here buffers a symbol. A row is parsed, mapped, and appended to a
 * staged NDJSON object which `bq load` reads once and the 14-day lifecycle
 * rule deletes. So the PARSERS are reused verbatim (`parseOhlcvHeader`,
 * `parseOhlcvRow`, `resolveListingForDate`) and only the SINK is different.
 *
 * ## THE TIMEFRAME LITERALS ARE `M1` / `H1`, NEVER `"1m"`
 *
 * `SCHEMA_TIMEFRAME` is the one place a vendor schema name becomes a repo
 * timeframe, and it is imported here rather than re-spelled.
 */

import { createHash } from "node:crypto";

import {
  EQUS_MINI_HISTORY_FLOOR,
  SCHEMA_TIMEFRAME,
  expectedSessions,
  type DatabentoSchema,
} from "./databento-logic";

/* ─────────────────────────────────────────────────────────────────────────
   Which schemas may reach a table at all
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Schema -> silver table. CLOSED, and `ohlcv-1s` is deliberately absent.
 *
 * `ohlcv-1s` is ARCHIVE-ONLY by founder decision (2026-09-06): 8.5 GiB of
 * second bars bought at the included price, TB-scale if the window widens, and
 * no strategy reads it. It is the LAST entry in the harvest manifest's submit
 * order for the same reason.
 *
 * It is not enough to leave it out of this map and let a lookup return
 * `undefined` — `undefined` as a table name produces `lake_silver_prod.undefined`,
 * which BigQuery answers with "not found" and an operator reads as a missing
 * DDL migration. `tradeBarTableFor` THROWS with the schema named instead, and
 * `databento-lake-logic.test.ts` pins that it does.
 *
 * `bbo-1m` and `tbbo` are absent for a different reason and it is worth stating
 * separately: they are quote and trade RECORDS, not bars. They feed
 * `spread_cost_daily` through `databento-spread-logic.ts` and never become rows
 * in a bar table.
 */
export const LAKE_TRADE_BAR_TABLES: Readonly<
  Partial<Record<DatabentoSchema, string>>
> = Object.freeze({
  "ohlcv-1m": "trade_bar_m1",
  "ohlcv-1h": "trade_bar_h1",
});

/** The schemas this loader will load. Pinned BY VALUE in the test. */
export const LAKE_LOADABLE_SCHEMAS: readonly DatabentoSchema[] = Object.freeze([
  "ohlcv-1m",
  "ohlcv-1h",
]);

export class SchemaNotLoadableError extends Error {
  constructor(schema: string, reason: string) {
    super(
      `schema "${schema}" is not loaded into a lake bar table: ${reason}. ` +
        `Loadable schemas are ${LAKE_LOADABLE_SCHEMAS.join(", ")}.`,
    );
    this.name = "SchemaNotLoadableError";
  }
}

/** The silver table for a schema, or a throw naming why there is none. */
export function tradeBarTableFor(schema: string): string {
  const table = LAKE_TRADE_BAR_TABLES[schema as DatabentoSchema];
  if (table !== undefined) return table;
  if (schema === "ohlcv-1s") {
    throw new SchemaNotLoadableError(
      schema,
      "ohlcv-1s is ARCHIVE-ONLY by founder decision (2026-09-06) — it is " +
        "TB-scale and no consumer reads it. Loading it is a sizing decision " +
        "and a new DDL file, not a one-line addition here",
    );
  }
  if (schema === "bbo-1m" || schema === "tbbo") {
    throw new SchemaNotLoadableError(
      schema,
      "it is a quote/trade record, not a bar — it feeds spread_cost_daily " +
        "through databento-spread-logic.ts",
    );
  }
  throw new SchemaNotLoadableError(schema, "it produces no bars");
}

/** The repo timeframe (`M1` / `H1`) for a loadable schema. */
export function tradeBarTimeframeFor(schema: string): string {
  tradeBarTableFor(schema); // refuses first, so the message names the schema
  const tf = SCHEMA_TIMEFRAME[schema as DatabentoSchema];
  if (tf === undefined) {
    throw new SchemaNotLoadableError(schema, "no timeframe mapping");
  }
  return tf;
}

/* ─────────────────────────────────────────────────────────────────────────
   The ledger key
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Bump when the mapping below changes in a way that alters stored VALUES.
 *
 * It is one of the ledger's five key parts, so a bump makes every partition
 * re-loadable without deleting anything: the new
 * (dataset, table, key, hash, parser_version) tuple simply has no ACCEPTED row.
 * That is why the version belongs in the key rather than in a comment.
 */
export const TRADE_BAR_PARSER_VERSION = "trade-bar-v1";
export const SPREAD_COST_PARSER_VERSION = "spread-cost-v1";

/** `US/M1/2024-03`. */
export function tradeBarPartitionKey(
  market: string,
  timeframe: string,
  monthKey: string,
): string {
  assertMonthKey(monthKey);
  if (!market.trim() || !timeframe.trim()) {
    throw new RangeError(
      `tradeBarPartitionKey needs a market and a timeframe, got ` +
        `${JSON.stringify(market)} / ${JSON.stringify(timeframe)} — an empty ` +
        `component collapses two partitions onto one ledger identity, which ` +
        `reads as ALREADY LOADED and silently skips a real load`,
    );
  }
  return `${market}/${timeframe}/${monthKey}`;
}

/** `US/2024-03` — spread_cost_daily has one grain, so no timeframe segment. */
export function spreadCostPartitionKey(
  market: string,
  monthKey: string,
): string {
  assertMonthKey(monthKey);
  if (!market.trim())
    throw new RangeError("spreadCostPartitionKey needs a market");
  return `${market}/${monthKey}`;
}

/**
 * The hash separator. `String.fromCharCode(0)`, matching `ledger-logic.ts`'s
 * `KEY_SEP`, and NOT a `"\u0000"` literal: prettier normalises that escape
 * into a RAW NUL BYTE in the source, which makes the file binary to grep and
 * to every source-scanning test in this repo.
 */
const NUL = String.fromCharCode(0);

/**
 * What this partition was built FROM: the GCS generations of every contributing
 * object.
 *
 * GENERATIONS, not object names. A vendor file re-downloaded after a corrupt
 * write keeps its name and changes its generation; hashing names would make the
 * repaired object invisible to the ledger and the partition would never reload.
 *
 * SORTED before hashing, because the ledger's own listing order is incidental
 * and an unsorted hash would differ run to run over identical bytes — turning
 * every claim into a reload.
 *
 * AN EMPTY INPUT THROWS. A hash over nothing is a stable, well-formed string,
 * so an empty file set would claim a partition, load zero rows, and then be
 * refused by `decideCoverage` — but only because of that second guard. Refusing
 * here names the real problem (the ledger query matched nothing) instead of
 * reporting it as a coverage failure.
 */
export function tradeBarSourceHash(generations: readonly string[]): string {
  if (generations.length === 0) {
    throw new RangeError(
      "tradeBarSourceHash: no source objects. A hash over an empty set is a " +
        "valid-looking identity for a partition built from nothing — the " +
        "ledger query matched no files, which is the thing to fix",
    );
  }
  const h = createHash("sha256");
  // LENGTH-PREFIXED, not merely separated. A bare `value + NUL` per element
  // makes `["a\0b"]` and `["a", "b"]` hash identically — measured, the test
  // for it failed on the first draft of this function. The fallback identity
  // is `${archiveKey}:${size}`, and an archive key is caller-shaped, so the
  // collision is reachable rather than theoretical: two different file sets
  // that hash the same make one partition's ACCEPTED row skip the other's
  // load, permanently and silently.
  for (const g of [...generations].sort()) {
    h.update(String(g.length)).update(":").update(g).update(NUL);
  }
  return h.digest("hex");
}

/* ─────────────────────────────────────────────────────────────────────────
   Archive keys
   ──────────────────────────────────────────────────────────────────────── */

export interface DatabentoArchiveParts {
  dataset: string;
  schema: string;
  year: number;
  jobId: string;
  filename: string;
}

/**
 * The inverse of `databentoArchiveKey`.
 *
 * The loader is driven by the LEDGER, which stores a `gs://` uri and not the
 * parts. It needs the schema (which table?) and the filename (which months
 * could this file cover?), and both are in the key. The `year` segment is the
 * JOB's start year, not the data's — `monthsForArchiveFile` uses it only as a
 * floor, never as the months.
 *
 * Returns `null` rather than throwing: the ledger holds every source we
 * archive, and a Tiingo or NSE key reaching this function is a filter that has
 * not been applied yet, not corruption. The caller counts them.
 *
 * `databento-lake-logic.test.ts` round-trips this against `databentoArchiveKey`
 * so the two cannot drift — the forward function is the only writer of these
 * keys and a rename there must fail here.
 */
export function parseDatabentoArchiveKey(
  key: string,
): DatabentoArchiveParts | null {
  const k = key.replace(/^gs:\/\/[^/]+\//, "").replace(/^\/+/, "");
  const parts = k.split("/");
  // databento / {dataset} / {schema} / {yyyy} / {jobId} / {filename}
  if (parts.length !== 6 || parts[0] !== "databento") return null;
  const [, dataset, schema, yearRaw, jobId, filename] = parts;
  if (!dataset || !schema || !jobId || !filename) return null;
  if (!/^\d{4}$/.test(yearRaw ?? "")) return null;
  return {
    dataset,
    schema,
    year: Number(yearRaw),
    jobId,
    filename,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Which months a file can contribute to
   ──────────────────────────────────────────────────────────────────────── */

export function assertMonthKey(monthKey: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
    throw new RangeError(
      `month key must be YYYY-MM, got ${JSON.stringify(monthKey)} — a ` +
        `malformed key produces a ledger identity the next run does not ` +
        `compute, so every run reloads the partition`,
    );
  }
}

/** `2024-03-15` -> `2024-03`. */
export function monthKeyOf(dateKey: string): string {
  const m = /^(\d{4}-\d{2})-\d{2}$/.exec(dateKey);
  if (!m)
    throw new RangeError(`monthKeyOf: bad date key ${JSON.stringify(dateKey)}`);
  assertMonthKey(m[1]!);
  return m[1]!;
}

/** The twelve month keys of a year, ascending. */
export function monthsOfYear(year: number): string[] {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new RangeError(`monthsOfYear: implausible year ${year}`);
  }
  return Array.from(
    { length: 12 },
    (_v, i) => `${year}-${String(i + 1).padStart(2, "0")}`,
  );
}

/** Every month key from `first` to `last`, both INCLUSIVE, ascending. */
export function monthsBetween(first: string, last: string): string[] {
  assertMonthKey(first);
  assertMonthKey(last);
  const out: string[] = [];
  let y = Number(first.slice(0, 4));
  let m = Number(first.slice(5, 7));
  for (let k = first; k <= last; k = `${y}-${String(m).padStart(2, "0")}`) {
    out.push(k);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** A vendor file's UTC date range, both ends INCLUSIVE `YYYY-MM-DD`. */
export interface VendorDateRange {
  first: string;
  last: string;
}

/**
 * `20240315` -> `2024-03-15`, or null for anything that is not a real date.
 *
 * ROUND-TRIPPED rather than merely `Number.isFinite(Date.parse(...))`: V8
 * parses `2024-02-30` as March 1st, so a finiteness test accepts it and files
 * the object under a month its name never said.
 */
function dateKeyOfDigits(digits: string): string | null {
  const key = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  const ms = Date.parse(`${key}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === key
    ? key
    : null;
}

/**
 * The UTC date range the VENDOR says a file covers, read from its own name.
 *
 *   equs-mini-20240101-20241231.ohlcv-1h.AAPL.csv.zst   2024-01-01..2024-12-31
 *   equs-mini-20260909-20260921.ohlcv-1h.csv.zst        2026-09-09..2026-09-21
 *   equs-mini-20260909.ohlcv-1h.csv.zst                 2026-09-09..2026-09-09
 *
 * Both ends are the vendor's UTC DATES, the second INCLUSIVE: a split-year
 * file ends `…1231` and a one-session append in EDT carries one date.
 *
 * `null` for a name with no date, an impossible date, or a reversed range —
 * "cannot tell", which the callers answer by over-assigning.
 */
export function archiveFileDateRange(filename: string): VendorDateRange | null {
  const m = /(?:^|[-_.])(\d{8})(?:-(\d{8}))?(?=[-_.]|$)/.exec(filename);
  if (m === null) return null;
  const first = dateKeyOfDigits(m[1]!);
  const last = m[2] === undefined ? first : dateKeyOfDigits(m[2]);
  if (first === null || last === null || first > last) return null;
  return { first, last };
}

/**
 * The ONE symbol a `split_symbols=true` file holds, or null for a file that
 * holds many (an append, a day split, anything unsplit).
 *
 * The vendor names a symbol split `{dataset}-{dates}.{schema}.{SYMBOL}.csv.zst`
 * and an unsplit file `{dataset}-{dates}.{schema}.csv.zst`. A symbol may carry
 * a dot (`BRK.B`), so the encoding suffix is stripped from the END rather than
 * the name being split on dots.
 *
 * `null` is the SAFE answer: it tells `filesMayOverlap` "this file can hold
 * any symbol", which can only switch de-duplication ON.
 */
export function archiveFileSymbol(parts: DatabentoArchiveParts): string | null {
  const marker = `.${parts.schema}.`;
  const at = parts.filename.indexOf(marker);
  if (at < 0) return null;
  const m = /^(.+)\.(?:csv|dbn|json)(?:\.zst)?$/.exec(
    parts.filename.slice(at + marker.length),
  );
  return m === null ? null : m[1]!;
}

/** `2024-01-01` -> `2023-12-31`. */
function previousDateKey(dateKey: string): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Which month partitions one archived file can put rows into — MONEY-1515.
 *
 * ## FROM THE VENDOR'S OWN RANGE, NEVER FROM THE PATH YEAR
 *
 * The path segment `databento/{dataset}/{schema}/{yyyy}/` is the JOB's start
 * year (`databentoArchiveKey` is called with `start.getUTCFullYear()`), not the
 * year the rows cover. The whole `ohlcv-1h-master` harvest sits under `2023/`
 * and holds 2023-03-28 through 2026-09-08; the trailing-12-month `bbo-1m`
 * harvest sits under `2025/` and holds 172 sessions of 2026. This function
 * used to give a year file the PATH year's months, so every file whose range
 * was 2024, 2025 or 2026 fed 2023's months and its rows were parsed and
 * dropped — 2024-01..2026-08, 32 of the 43 bought months, reachable by no
 * `--year` at all. And `20230328-20231231` read its START date as a session
 * date and fed ONE month, so 2023-04..12 all carried the same hash, built from
 * the 2024 files: nine months whose ledger identity described none of their
 * rows (measured in the prod ledger: one hash, `3eeebcd5…`, on all nine).
 *
 * THREE SHAPES, read by `archiveFileDateRange`:
 *
 *   RANGE  `…-{first}-{last}.…` — a harvest split or a multi-session append.
 *          Every month from the day BEFORE `first` through `last` (below).
 *   DAY    `…-{date}.…` — one session. EXACTLY one month, and this is what
 *          keeps a nightly append from dirtying more than its own month's hash;
 *          a day file assigned wider would re-load months of 43M-row minute
 *          bars to store one session.
 *   NONE   no readable date — the fallback below.
 *
 * ## THE RANGE ALSO FEEDS THE DAY BEFORE IT OPENS
 *
 * The vendor's dates are UTC and our partition key is the ET SESSION date.
 * Under EST, `{Y}-01-01T00:00Z` is 19:00 on `{Y-1}-12-31` — so a file whose
 * window opens at UTC midnight opens inside the previous session's post-market
 * hour, and those bars belong to that session's month. For a split-year file
 * that is the PREVIOUS DECEMBER: one hour of one session a year, missing for
 * ever without it, because the `{Y-1}` file ends at `{Y-1}-12-31T23:59Z` =
 * 18:59 ET and no other file holds them.
 *
 * An append's window opens at 04:00 ET instead, so for it the extra day is
 * over-assignment — the safe direction, and it only reaches a second month
 * when the range opens on the 1st.
 *
 * ## THE FALLBACK OVER-ASSIGNS, NEVER UNDER-ASSIGNS
 *
 * No readable date, an impossible one, or a first date before the path year's
 * January (a job cannot hold rows from before its own start year, so a date
 * there is a digit run in some other token, not the vendor's range): every
 * month from `{pathYear-1}-12` through `throughMonth`, the last month the
 * vendor sold. Over-assigning costs a reload; under-assigning drops rows from a
 * month nothing else will ever write. It used to stop at the path year's
 * December, which WAS the under-assigning direction once a job's files could
 * run years past it.
 */
export function monthsForArchiveFile(
  parts: DatabentoArchiveParts,
  /** The last month the vendor sold — the fallback's upper bound. */
  throughMonth: string,
): string[] {
  assertMonthKey(throughMonth);
  const range = archiveFileDateRange(parts.filename);
  if (range !== null && range.first >= `${parts.year}-01-01`) {
    if (range.first === range.last) return [monthKeyOf(range.first)];
    return monthsBetween(
      monthKeyOf(previousDateKey(range.first)),
      monthKeyOf(range.last),
    );
  }
  const pathYearEnd = `${parts.year}-12`;
  return monthsBetween(
    `${parts.year - 1}-12`,
    throughMonth > pathYearEnd ? throughMonth : pathYearEnd,
  );
}

/**
 * Can two of these files hold the SAME (symbol, bar)? — MONEY-1515.
 *
 * `true` means the loader must de-duplicate the month's rows, because nothing
 * downstream will: `trade_bar_*` has no unique key, `bq load` appends, and the
 * coverage gate counts SESSIONS, so a month loaded twice over accepts exactly
 * like a clean one.
 *
 * MEASURED, not hypothetical. `ohlcv-1h-master`'s nightly append re-buys from
 * 2026-09-09 every night (its high-water mark has not moved), one file per
 * symbol chunk: `…-20260909-20260910`, `…-20260909-20260911`, … through
 * `…-20260909-20260921` — nine runs of 7-8 chunks, so the 09-09 session is
 * held nine times over. Deriving months from the vendor range is what makes
 * 2026-09 loadable at all, and without this it would load with every bar
 * repeated up to nine times.
 *
 * Two files CANNOT share a row when their UTC ranges are disjoint (a row's
 * instant lies inside its file's range), or when both are per-symbol splits of
 * DIFFERENT symbols. Anything else might — including two same-range files from
 * different append chunks, which really hold disjoint symbols but whose names
 * cannot say so. A false `true` costs memory for one month; a false `false`
 * loads duplicates. So "cannot tell" is `true`.
 */
export function filesMayOverlap(
  files: readonly DatabentoArchiveParts[],
): boolean {
  const all: { range: VendorDateRange; symbol: string | null }[] = [];
  const bySymbol = new Map<string, VendorDateRange[]>();
  for (const parts of files) {
    const range = archiveFileDateRange(parts.filename);
    if (range === null) return files.length > 1;
    const symbol = archiveFileSymbol(parts);
    all.push({ range, symbol });
    if (symbol !== null) {
      const list = bySymbol.get(symbol);
      if (list) list.push(range);
      else bySymbol.set(symbol, [range]);
    }
  }
  const meet = (a: VendorDateRange, b: VendorDateRange): boolean =>
    a.first <= b.last && b.first <= a.last;

  // One symbol, two files: overlapping ranges repeat that symbol's bars.
  for (const ranges of bySymbol.values()) {
    if (ranges.length < 2) continue;
    ranges.sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
    for (let i = 1; i < ranges.length; i++) {
      if (meet(ranges[i - 1]!, ranges[i]!)) return true;
    }
  }
  // A many-symbol file against every other file. ponytail: O(multi x all) —
  // the multi-symbol files are the appends, tens per month against thousands
  // of year splits; sweep by `first` if that ratio ever inverts.
  for (let i = 0; i < all.length; i++) {
    if (all[i]!.symbol !== null) continue;
    for (let j = 0; j < all.length; j++) {
      if (j !== i && meet(all[i]!.range, all[j]!.range)) return true;
    }
  }
  return false;
}

/* ─────────────────────────────────────────────────────────────────────────
   The coverage window
   ──────────────────────────────────────────────────────────────────────── */

export interface MonthWindow {
  from: string;
  to: string;
}

/**
 * The ET session range a month partition should contain — the coverage
 * DENOMINATOR's input.
 *
 * Clamped on three sides, and each clamp is a real failure without it:
 *
 *   HISTORY FLOOR  EQUS.MINI begins 2023-03-28. March 2023 is 21 sessions, not
 *                  23, and counting the two before inception would report a
 *                  permanent gap that no reload can close.
 *   ENTRY WINDOW   the vendor sold us a range. A month only half inside it is
 *                  half a month, and expecting the whole one would refuse the
 *                  partition for ever.
 *   TODAY          the current month is not over. Expecting its remaining
 *                  sessions makes every nightly run REJECT, which is the
 *                  not-measured-is-not-passed defect wearing the opposite hat.
 *
 * Returns `null` when the intersection is EMPTY — a month entirely outside what
 * was bought. `null` is a distinct answer from a zero-length window, because
 * the caller must SKIP such a month rather than claim it and fail its coverage.
 */
export function tradeBarMonthWindow(args: {
  monthKey: string;
  entryStartDateKey: string;
  /** INCLUSIVE last date the vendor window covers. */
  entryEndDateKey: string;
  todayDateKey: string;
  /** Overridable for tests; defaults to EQUS.MINI's inception. */
  historyFloorDateKey?: string;
}): MonthWindow | null {
  assertMonthKey(args.monthKey);
  const floor = args.historyFloorDateKey ?? EQUS_MINI_HISTORY_FLOOR;

  const monthStart = `${args.monthKey}-01`;
  const monthEnd = lastDateOfMonth(args.monthKey);

  const from = maxDateKey(
    monthStart,
    maxDateKey(floor, args.entryStartDateKey),
  );
  const to = minDateKey(
    monthEnd,
    minDateKey(args.entryEndDateKey, args.todayDateKey),
  );

  return from > to ? null : { from, to };
}

/** `2024-02` -> `2024-02-29`. */
export function lastDateOfMonth(monthKey: string): string {
  assertMonthKey(monthKey);
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  // Day 0 of the NEXT month is the last day of this one, and it gets February
  // and leap years right without a table.
  const d = new Date(Date.UTC(year, month, 0));
  return d.toISOString().slice(0, 10);
}

function assertDateKey(k: string, what: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) {
    throw new RangeError(
      `${what} must be YYYY-MM-DD, got ${JSON.stringify(k)}`,
    );
  }
}

/** Lexicographic comparison is date order for `YYYY-MM-DD`, and only for it. */
function maxDateKey(a: string, b: string): string {
  assertDateKey(a, "date");
  assertDateKey(b, "date");
  return a > b ? a : b;
}

function minDateKey(a: string, b: string): string {
  assertDateKey(a, "date");
  assertDateKey(b, "date");
  return a < b ? a : b;
}

/* ─────────────────────────────────────────────────────────────────────────
   Planning a run's month partitions
   ──────────────────────────────────────────────────────────────────────── */

/** What the planner needs of an archived vendor file. */
export interface PlannableFile {
  archiveKey: string;
  /** The vendor manifest's checksum. Empty when the record predates it. */
  sha256: string;
  size: number;
}

/**
 * GENERIC over the file type, so a caller's richer record survives the plan.
 * The planner reads only `PlannableFile`'s three fields; the loader's rows
 * additionally need each file's acquisition instant for `observed_at`, and
 * widening `PlannableFile` to carry it would state a dependency the planner
 * does not have.
 */
export interface MonthPlan<F extends PlannableFile = PlannableFile> {
  monthKey: string;
  partitionKey: string;
  sourceHash: string;
  /** The coverage DENOMINATOR: ET sessions the partition should contain. */
  expectedSessionCount: number;
  files: F[];
  /** Two of `files` can hold the same bar — see `filesMayOverlap`. */
  filesMayOverlap: boolean;
}

export type MonthSkipReason = "not-this-run" | "outside-purchase" | "filtered";

export interface MonthPlanResult<F extends PlannableFile = PlannableFile> {
  plans: MonthPlan<F>[];
  skipped: { monthKey: string; reason: MonthSkipReason }[];
}

/**
 * Which month partitions a run may claim, and what each is built FROM.
 *
 * Pure so the two rules below can be tested; the job owns the I/O around it.
 *
 * `files` is the WHOLE archive for the schema, whatever path year each file
 * sits under: `monthsForArchiveFile` decides from the vendor's own range which
 * months each can feed, and a month's hash is built from exactly those files.
 *
 * ## `allowedMonths` IS NARROWER THAN WHAT THE FILES CAN FEED, DELIBERATELY
 *
 * A year file opens inside the PREVIOUS December's post-market
 * (`monthsForArchiveFile`), so a run over year Y reads `{Y+1}`'s files to pick
 * up `{Y}-12`'s last hour — and those same files also touch `{Y}-12`'s
 * successor months. Claiming one of those here would be destructive rather
 * than merely wasteful: the loader PURGES a partition's date range before it
 * writes, so a month claimed with only its spill hour would delete a fully
 * loaded month and replace it with one hour.
 *
 * The rule is therefore "a run claims only the months of its own year", and it
 * is a parameter rather than a derived value so the caller states it once and a
 * test can assert both directions.
 *
 * ## A MONTH WITH NO WINDOW IS SKIPPED, NOT CLAIMED
 *
 * `tradeBarMonthWindow` returns null for a month entirely outside what the
 * vendor sold. Claiming it would give `expectedSessions` zero, and the ledger's
 * coverage gate is then the only thing between us and an ACCEPTED empty month.
 * Skipping names it instead.
 */
export function planMonthPartitions<F extends PlannableFile>(args: {
  files: readonly { file: F; parts: DatabentoArchiveParts }[];
  partitionKeyFor: (monthKey: string) => string;
  allowedMonths: readonly string[];
  entryStartDateKey: string;
  entryEndDateKey: string;
  todayDateKey: string;
  /** Narrow to ONE month, for a nightly top-up. */
  onlyMonth?: string | null;
}): MonthPlanResult<F> {
  const allowed = new Set(args.allowedMonths);
  const throughMonth = monthKeyOf(args.entryEndDateKey);
  const byMonth = new Map<
    string,
    { file: F; parts: DatabentoArchiveParts }[]
  >();
  for (const entry of args.files) {
    for (const monthKey of monthsForArchiveFile(entry.parts, throughMonth)) {
      const list = byMonth.get(monthKey);
      if (list) list.push(entry);
      else byMonth.set(monthKey, [entry]);
    }
  }

  const plans: MonthPlan<F>[] = [];
  const skipped: { monthKey: string; reason: MonthSkipReason }[] = [];

  for (const monthKey of [...byMonth.keys()].sort()) {
    if (!allowed.has(monthKey)) {
      skipped.push({ monthKey, reason: "not-this-run" });
      continue;
    }
    if (args.onlyMonth != null && monthKey !== args.onlyMonth) {
      skipped.push({ monthKey, reason: "filtered" });
      continue;
    }
    const window = tradeBarMonthWindow({
      monthKey,
      entryStartDateKey: args.entryStartDateKey,
      entryEndDateKey: args.entryEndDateKey,
      todayDateKey: args.todayDateKey,
    });
    if (window === null) {
      skipped.push({ monthKey, reason: "outside-purchase" });
      continue;
    }
    const entries = byMonth.get(monthKey)!;
    const files = entries.map((e) => e.file);
    plans.push({
      monthKey,
      partitionKey: args.partitionKeyFor(monthKey),
      // The vendor's OWN checksum identifies the bytes. `archiveKey:size` is
      // the fallback for a record written before checksums were stored — it
      // still changes when the file does.
      sourceHash: tradeBarSourceHash(
        files.map((f) => f.sha256 || `${f.archiveKey}:${f.size}`),
      ),
      expectedSessionCount: expectedSessions(window.from, window.to).length,
      files,
      filesMayOverlap: filesMayOverlap(entries.map((e) => e.parts)),
    });
  }

  return { plans, skipped };
}

/** A selection that matched files and planned no month. See `assertPlannedMonths`. */
export class EmptyPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyPlanError";
  }
}

/**
 * A selection that plans NO month is a REFUSAL, never a quiet exit — MONEY-1515.
 *
 * ## THE MEASURED NO-OP IT WAS WRITTEN FOR
 *
 * When `--year` addressed the ARCHIVE PATH year, `--year 2025` matched only the
 * day-split appends under `…/ohlcv-1m/2026/`, filed them under `2026-09`,
 * skipped that month `not-this-run`, and exited 0 having loaded nothing — which
 * is indistinguishable from a fully-loaded year, the one outcome the ledger
 * exists to prevent. It is the sibling of the `files.length === 0` throw one
 * step earlier: an empty FILE set already refused; an empty PLAN did not.
 *
 * `--year` is the DATA year now and reads the whole archive, so that exact
 * shape is gone. The refusal stays, because an empty plan still has causes
 * that must not read as success: a `--month` outside the purchase (2023-01),
 * an archive with no file covering the year, or a vendor window that ends
 * before it.
 */
export function assertPlannedMonths<F extends PlannableFile>(
  result: MonthPlanResult<F>,
  context: { schema: string; year: number; fileCount: number },
): MonthPlan<F>[] {
  if (result.plans.length > 0) return result.plans;

  const tally = new Map<MonthSkipReason, number>();
  for (const s of result.skipped) {
    tally.set(s.reason, (tally.get(s.reason) ?? 0) + 1);
  }
  const reasons =
    [...tally]
      .sort()
      .map(([reason, n]) => `${reason}=${n}`)
      .join(" ") || "nothing was skipped either — no file mapped to any month";

  throw new EmptyPlanError(
    `${context.schema} --year ${context.year}: ${context.fileCount} archived ` +
      `file(s) considered and NONE of them plans a month inside ` +
      `${context.year} (${reasons}). Refusing rather than exiting 0 with ` +
      `nothing loaded — a run that loaded no rows and reported success is ` +
      `indistinguishable from a fully-loaded year. --year is the DATA year ` +
      `(the ET session year of the rows), read across every archive path ` +
      `year; outside-purchase means the vendor sold nothing for that month, ` +
      `filtered means --month excluded it.`,
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   The row
   ──────────────────────────────────────────────────────────────────────── */

/** A parsed bar plus the identity the symbology resolved for it. */
export interface ResolvedBar {
  market: string;
  listingId: string;
  symbol: string;
  exchange: string;
  sourceInstrumentId: number | null;
  publisherId: number | null;
  /** Bar OPEN, epoch ms. */
  tsMs: number;
  /** The ET session date from `usMarketDateKey` — NEVER a UTC slice. */
  sessionDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
}

/** The six mandatory silver columns, minus the parser version this owns. */
export interface BarProvenance {
  sourceObjectUri: string;
  pipelineRunId: string;
  /** When the SOURCE asserted it — the archived object's acquisition time. */
  observedAtMs: number;
  ingestedAtMs: number;
}

export interface TradeBarRow {
  market: string;
  listing_id: string;
  symbol: string;
  exchange: string;
  source_instrument_id: number | null;
  publisher_id: number | null;
  ts: string;
  session_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: string | null;
  source: string;
  source_object_uri: string;
  source_record_key: string;
  parser_version: string;
  pipeline_run_id: string;
  observed_at: string;
  ingested_at: string;
}

function finite(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * `null` for anything not finite, ROUNDED to a BigQuery `NUMERIC(_, scale)`
 * column's scale. MONEY-1512.
 *
 * BigQuery REFUSES a NUMERIC value carrying more decimal places than the
 * column declares, and the JSON load path runs `maxBadRecords: 0`
 * (`@usemoney/lake/load`), so ONE bad row fails the whole load job. That is
 * not hypothetical: it is why `derivatives_eod_in` could not load a single
 * row, for any window, from the day it shipped.
 *
 * Every lake NUMERIC is scale 6. It is armed on every QUOTIENT we store, and
 * `spread_cost_daily` is the sharpest case in this package — the spread
 * columns are `((ask - bid) / mid) * 10_000`, so an ordinary 1-cent book
 * yields `0.9999500025003866`, sixteen places. Two of those columns are
 * `NOT NULL`, so there is no null escape either.
 *
 * `toFixed` rounds in DECIMAL-STRING space, which is the point.
 * `Math.round(v * 10 ** scale) / 10 ** scale` is NOT a safe substitute:
 * `NUMERIC(18, 6)` admits twelve integer digits and `1e12 * 1e6` is past
 * `Number.MAX_SAFE_INTEGER`.
 *
 * SCALE ONLY, NEVER PRECISION — a 13-integer-digit value is still refused.
 * INT64 counts must not come through here; they go through
 * `volumeToInt64String`.
 *
 * DELIBERATELY A SECOND COPY of `@usemoney/lake`'s `numeric()`. `packages/core`
 * and `packages/lake` have no dependency edge in either direction, and adding
 * one to share six lines would be the larger change. The two are pinned in
 * agreement by `databento-lake-logic.test.ts` so they cannot drift silently —
 * a rule stated twice is a rule that can disagree with itself.
 */
export function numeric(
  n: number | null | undefined,
  scale = 6,
): number | null {
  const v = finite(n);
  return v === null ? null : Number(v.toFixed(scale));
}

/**
 * The same rounding for a NOT NULL NUMERIC column. MONEY-1512.
 *
 * `spread_cost_daily.median_spread_bps` and `.p90_spread_bps` are
 * `NUMERIC(18, 6) NOT NULL` (`ddl/007_silver_trade_bars.sql`), so there is no
 * null to fall back to and `numeric()`'s `number | null` does not type-check
 * against them — which is the type system stating the column's contract.
 *
 * A non-finite value reaching here is a REAL defect upstream (`summarizeCell`
 * drops a cell with no quoted sample rather than emitting one), so it THROWS
 * rather than coercing. Writing a 0 would put a fabricated tightest-possible
 * spread into the transaction-cost model every backtest is priced against,
 * and nothing on the row would say so.
 */
export function numericRequired(n: number, scale = 6): number {
  if (!Number.isFinite(n)) {
    throw new Error(
      `numericRequired: ${String(n)} is not finite, and the column is NOT NULL`,
    );
  }
  return Number(n.toFixed(scale));
}

/**
 * Map one resolved bar onto its silver row.
 *
 * ## VOLUME IS A STRING
 *
 * BigQuery INT64 over the JSON load path is written as a decimal string. A JS
 * number loses precision above 2^53 and a `bigint` does not survive
 * `JSON.stringify` at all — it THROWS, which on a 151M-row stream would kill
 * the run at whichever row first exceeded the boundary. The decimal string is
 * the only form that round-trips both. `price-bar-logic.ts` makes the same
 * call for the same reason.
 *
 * ## NON-FINITE PRICES BECOME NULL, NEVER 0
 *
 * A NaN close written as 0 is a bar that renders, charts and back-adjusts —
 * producing a -100% return on the day before and an infinite one on the day
 * after. NULL is queryable as "we do not have this" and cannot be mistaken for
 * a price. `parseOhlcvRow` already refuses those rows upstream and counts them,
 * so this is a floor rather than the main guard.
 */
export function toTradeBarRow(
  bar: ResolvedBar,
  prov: BarProvenance,
): TradeBarRow {
  const ts = new Date(bar.tsMs).toISOString();
  return {
    market: bar.market,
    listing_id: bar.listingId,
    symbol: bar.symbol,
    exchange: bar.exchange,
    source_instrument_id: intOrNull(bar.sourceInstrumentId),
    publisher_id: intOrNull(bar.publisherId),
    ts,
    session_date: bar.sessionDate,
    open: numeric(bar.open),
    high: numeric(bar.high),
    low: numeric(bar.low),
    close: numeric(bar.close),
    volume: volumeToInt64String(bar.volume),
    source: bar.source,
    source_object_uri: prov.sourceObjectUri,
    // WHICH RECORD within the object. The vendor file has no row id, and
    // (symbol, bar open) is the only thing that identifies one — it is also
    // the table's own natural key, so a duplicated row is findable.
    source_record_key: `${bar.symbol}|${ts}`,
    parser_version: TRADE_BAR_PARSER_VERSION,
    pipeline_run_id: prov.pipelineRunId,
    observed_at: new Date(prov.observedAtMs).toISOString(),
    ingested_at: new Date(prov.ingestedAtMs).toISOString(),
  };
}

/** Exported for its own test — the bigint path is the one that throws. */
export function volumeToInt64String(
  volume: number | bigint | null | undefined,
): string | null {
  if (volume === null || volume === undefined) return null;
  if (typeof volume === "bigint") return volume.toString();
  if (!Number.isFinite(volume)) return null;
  return Math.trunc(volume).toString();
}

function intOrNull(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}
