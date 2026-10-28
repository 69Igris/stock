/**
 * The US fundamentals repository — Prisma I/O over `repository-logic.ts`
 * (MONEY-979, T10).
 *
 * READ-ONLY. Nothing here writes, and nothing here fetches: every row was
 * written by `services/us-fundamentals/` from our own archive of SEC bytes.
 *
 * ## The one rule this file exists to enforce
 *
 * **A query is never issued with an `undefined` identifier.** In Prisma over
 * MongoDB, `where: { cik10: undefined }` is not "match nothing" and it is not an
 * error — the key is DROPPED from the filter, and the query matches EVERYTHING.
 * A symbol that resolves to no US filer would therefore return another
 * company's income statement, attributed to the symbol the caller asked about.
 * So identity is resolved FIRST, and a failure to resolve returns an empty
 * result carrying a named reason WITHOUT touching the data collection at all.
 * `repository.test.ts` asserts both halves: the named reason, and that Prisma
 * was called with a concrete `cik10` or not called.
 *
 * The second rule, from the same family: rotation/optional markers are read in
 * `orderBy` only, never in `where`. A Mongo `db push` creates INDEXES, not
 * FIELDS, so an attribute added later is ABSENT on pre-existing rows and both
 * `{f: null}` and `{f: {not: null}}` return ZERO (MONEY-1050 / 1234 / 1235).
 * Where this file needs "has a value", it selects the column and filters in
 * TypeScript.
 */

import { prisma } from "@usemoney/database";

import {
  isoOrNull,
  judgeCoverage,
  mapStandardizedToStatement,
  newestFiledAt,
  normalizeSymbolForUs,
  padCik10,
  pickPointInTime,
  resolveQoQ,
  selectThirteenFAccessions,
  summarizeInsiderActivity,
  type ThirteenFFilingRef,
  type UsMappedStatement,
} from "./repository-logic";
import { getUsColdStore, readThirteenFColdShard } from "./cold-holdings";
import type {
  UsBeneficialOwnerRow,
  UsCoverageJudgement,
  UsFilingRow,
  UsHolderDelta,
  UsHoldingRow,
  UsInsiderActivitySummary,
  UsInsiderRow,
  UsPeriodType,
  UsReadResult,
  UsStatementRow,
  UsStatementType,
} from "./types";

/* ─────────────────────────────────────────────────────────────────────────
   Named reasons — an empty result always says WHICH empty it is
   ──────────────────────────────────────────────────────────────────────── */

/** The caller gave neither a symbol nor a cik10. */
export const REASON_NO_IDENTIFIER = "NO_IDENTIFIER_SUPPLIED";
/** The symbol matches no ACTIVE row in `us_instruments`. */
export const REASON_SYMBOL_NOT_IN_UNIVERSE = "SYMBOL_NOT_IN_US_UNIVERSE";
/** The symbol is a US listing, but no SEC CIK has been joined onto it yet. */
export const REASON_SYMBOL_HAS_NO_CIK = "SYMBOL_HAS_NO_SEC_CIK";
/** A cik10 was supplied but is not 1-10 digits. */
export const REASON_CIK_MALFORMED = "CIK10_MALFORMED";
/** The query ran and matched nothing. */
export const REASON_NO_ROWS = "NO_ROWS_FOR_QUERY";
/** No 13F filing exists for that (manager, period). */
export const REASON_NO_THIRTEENF_FILING = "NO_13F_FILING_FOR_PERIOD";
/** There is no earlier 13F period, so no QoQ delta could be computed. */
export const REASON_NO_PRIOR_PERIOD = "NO_PRIOR_13F_PERIOD";

/**
 * The requested period holds no rows while a PRIOR period does.
 *
 * Distinct from `NO_ROWS_FOR_QUERY` because the two need opposite handling and
 * produce opposite-looking answers. With no rows at all the honest reply is
 * "nothing here". With a populated prior and an empty current, a naive diff
 * says every holder liquidated its entire position — the single most alarming
 * thing this repository can say.
 *
 * ## The name states the SHAPE, never the CAUSE
 *
 * It was `PERIOD_HAS_NO_ROWS_YET` / `REASON_PERIOD_NOT_INGESTED`, and that
 * "YET" was a diagnosis this branch cannot make. TWO different things reach it
 * and only one is ingestion lag:
 *
 *   1. **Lag.** 13Fs are due 45 days after quarter end, so between the quarter
 *      closing and the filings landing, `current` is legitimately empty. Fixes
 *      itself; nobody need do anything.
 *   2. **A caller-format bug.** `periodOfReport` is matched by EXACT DateTime
 *      equality, so a caller passing an offset-bearing or time-bearing
 *      timestamp misses `current` while still finding `prior` — for a period
 *      that is fully ingested and sitting right there. Never fixes itself.
 *
 * Reporting (2) as "not ingested yet" is a confident, wrong and REASSURING
 * claim: it reads as ordinary lag, so nobody investigates and the caller keeps
 * asking the same malformed question forever. So this reason asserts only what
 * was observed, and the sentence the research tools attach to it
 * (`US_GAP_EXPLANATIONS` in `fetch-us-financials.ts`) enumerates BOTH causes
 * and tells the reader to re-ask with a plain date before concluding anything.
 */
export const REASON_REQUESTED_PERIOD_EMPTY = "REQUESTED_PERIOD_HAS_NO_ROWS";
/** A COLD shard read failed. The rows present are a SUBSET, not the answer. */
export const REASON_COLD_READ_FAILED = "COLD_SHARD_READ_FAILED";
/** A filing says COLD but no cold store is registered in this process. */
export const REASON_COLD_STORE_UNREGISTERED = "COLD_STORE_NOT_REGISTERED";
/**
 * The store answered 404 for a shard the evictor claims to have written.
 *
 * A DIFFERENT fact from a read that threw, and worth its own name: the most
 * likely cause is a key the writer and this reader spell differently — the
 * Python evictor builds `edgar/13f/{manager}/{period}` on its side and
 * `buildThirteenFColdKey` builds it here, and a disagreement about the date
 * segment 404s on every quarter, silently, forever.
 */
export const REASON_COLD_SHARD_ABSENT = "COLD_SHARD_ABSENT";
/** The newest 13F filing amends with an unreadable amendment type. */
export const REASON_AMBIGUOUS_AMENDMENT = "AMBIGUOUS_13F_AMENDMENT_TYPE";
/**
 * The QoQ diff could not load a whole period. Every `isNew` / `isExited` flag
 * in the result is then unsafe — see `US_FULL_SCAN_MAX`.
 */
export const REASON_HOLDER_SET_TRUNCATED = "HOLDER_SET_TRUNCATED";
/**
 * The insider-activity window held more rows than one read may load, so the
 * summary is over a SUBSET of the window rather than the window.
 */
export const REASON_INSIDER_WINDOW_TRUNCATED = "INSIDER_WINDOW_TRUNCATED";

/* ─────────────────────────────────────────────────────────────────────────
   Tuning
   ──────────────────────────────────────────────────────────────────────── */

export const US_DEFAULT_LIMIT = 20;
export const US_MAX_LIMIT = 500;

/**
 * The ceiling on a read whose ARITHMETIC — not merely its presentation —
 * depends on having every row.
 *
 * ## Why a presentation limit cannot serve as one
 *
 * `US_MAX_LIMIT` is how many rows a caller is SHOWN. Two reads here derive an
 * answer from the rows rather than displaying them, and for those a `take` is
 * not a limit, it is a silent change of population:
 *
 *   - **`getTopHolders`.** Both periods used to load `take: US_MAX_LIMIT`
 *     ordered by `valueUsd desc`. A manager ranked inside the top 500 last
 *     quarter and outside it this quarter is present in `previous` and absent
 *     from `current`, and `resolveQoQ` — correctly, given what it was handed —
 *     reports a FULL LIQUIDATION. The mirror case invents a new position. AAPL
 *     is held by thousands of 13F filers and the boundary around rank 500
 *     churns every quarter on ordinary price moves, so this fired constantly
 *     and produced the most confident-looking output in the file: a named
 *     manager, an exact share count, and a sale that never happened.
 *   - **`getInsiderActivity`.** The summary was computed over the newest
 *     `limit` rows of the window and presented as the window's total. Wrong
 *     LOW, which reads as quiet insider activity rather than as an error.
 *
 * ## Why a ceiling at all, and why exceeding it is DEGRADED and not silent
 *
 * Unbounded is not an option — one pathological issuer would pull an unbounded
 * result set into a request. When the ceiling IS reached the result says so with
 * a named reason instead of quietly becoming the same defect at a bigger number:
 * raising a constant moves a silent failure further out, it does not remove it.
 *
 * ## The ceiling counts ROWS; the population is measured in FILERS
 *
 * This constant was first written as a flat 20,000 justified as "~3.5x the
 * largest real 13F holder count (a mega-cap draws roughly 5-6k filers)". The
 * `take` counts ROWS, and one filer's position in one security occupies
 * SEVERAL rows — SEC lets a manager file the same CUSIP once per
 * `otherManagers` combination. Measured on this repo's own fixtures: 3.07 and
 * 3.65 rows per position, worst single position 12. So 20,000 rows was ~5,500
 * filers — roughly 1.1x, not 3.5x — and the most-queried US ticker sat at the
 * boundary, where `HOLDER_SET_TRUNCATED` would have become its permanent state.
 *
 * That is exactly the rule `PIT_ROWS_PER_PERIOD` states fourteen lines below,
 * and MONEY-1207 before it: a `take` counted in ROWS over a table where one
 * logical unit occupies several rows silently returns fewer units than asked
 * for. It is now expressed in the same units it is reasoned about.
 *
 * The row cost is paid down by an explicit `select` — the query projects the
 * fourteen columns `toHoldingRow` reads and leaves `otherManagers`,
 * `investmentDiscretion` and the voting-authority columns in the database.
 *
 * MEASURED, because "the projection pays for the higher ceiling" is exactly the
 * kind of claim that is comfortable to assert and easy to get backwards
 * (heapUsed, both shapes constructed directly, two periods each):
 *
 *   20,001 x2 FULL row        28.7 MB     0.73 KB/row   <- before
 *   32,001 x2 PROJECTED row   25.9 MB     0.41 KB/row   <- now
 *   32,001 x2 FULL row        45.9 MB
 *
 * So a 60% larger row budget costs 10% LESS memory. Build the projected shape
 * directly when re-measuring: taking the full object and `delete`-ing keys puts
 * V8 into dictionary mode and reports the projected row as LARGER than the full
 * one, which inverted this answer on the first attempt.
 *
 * The real fix, when it is worth the change, is to aggregate in the DATABASE —
 * group by `(managerCik10, cusip, putCall, sharesType)` server-side so the read
 * returns POSITIONS and the row multiplier disappears from the budget entirely.
 * That has to carry the amendment rule (newest accession supersedes wholesale)
 * into the pipeline, which is why it is not done here.
 *
 * Read as `take: US_FULL_SCAN_MAX + 1` — one row past the ceiling is how a
 * query learns it was truncated. Asking for exactly the ceiling cannot
 * distinguish "the population is exactly this big" from "there is more".
 */

/** Filers a mega-cap draws (roughly 5-6k), with headroom. */
export const US_MAX_13F_FILERS_PER_ISSUER = 8_000;

/**
 * Rows one 13F POSITION occupies. Measured 3.07 / 3.65 across two real filings;
 * 4 carries the worse of the two. A single position can be far higher
 * (Berkshire files 12 rows for Apple), which is why this is an AVERAGE applied
 * to a filer count and not a per-position bound.
 */
export const ROWS_PER_13F_POSITION = 4;

export const US_FULL_SCAN_MAX =
  US_MAX_13F_FILERS_PER_ISSUER * ROWS_PER_13F_POSITION;

/**
 * The insider-transaction ceiling, which is NOT the 13F one.
 *
 * It was sharing `US_FULL_SCAN_MAX`, justified as "far above any issuer's Form 4
 * volume in a 180-day window" — but `fetch-us-insider-trades` clamps
 * `windowDays` to 1825, ten times that window. A ceiling argued for one window
 * and applied to another is a ceiling nobody verified.
 *
 * Sized for the window the API actually exposes: a heavily-traded large-cap
 * files on the order of a few hundred Form 4 transaction rows a year, so five
 * years is low thousands; 40,000 is an order of magnitude above that. One row
 * per transaction here — unlike 13F there is no per-row multiplier.
 */
export const US_INSIDER_SCAN_MAX = 40_000;

/**
 * Exactly the columns `toHoldingRow` reads.
 *
 * Derived from the mapper rather than hand-listed beside it: a projection that
 * drifts from the code consuming it is how "we never asked for the column"
 * prints as "the vendor has no value" (the F3 reconcile, MONEY-1234).
 *
 * It leaves `otherManagers`, `investmentDiscretion` and the voting-authority
 * columns in the database. They are real data and no reader on this path uses
 * them, and at up to 32,001 rows per period, twice per request, an unused
 * string array is the difference between a comfortable read and an OOM on a
 * 1Gi worker running ten concurrent Pub/Sub handlers.
 */
const HOLDING_COLUMNS = {
  accession: true,
  rowIndex: true,
  managerCik10: true,
  periodOfReport: true,
  filedAt: true,
  cusip: true,
  figi: true,
  issuerName: true,
  titleOfClass: true,
  valueUsd: true,
  shares: true,
  sharesType: true,
  putCall: true,
  symbol: true,
} as const;

/**
 * How many ROWS to read per requested PERIOD in a point-in-time query.
 *
 * A `take` counted in ROWS over a table where one logical unit occupies several
 * rows silently returns fewer distinct units than asked for — MONEY-1207, where
 * a quarter both exchanges filed occupied two rows and a batch of N returned
 * N/2 quarters. Here one `periodEnd` legitimately holds the original filing, a
 * 10-K that restates the same quarter, and any number of amendments, so a
 * `take: limit` would return one period's amendment history instead of `limit`
 * periods. 6 covers an original plus five restatements; a period amended more
 * than that returns fewer periods than asked for, which is visible in the count
 * rather than silently wrong in the values.
 */
export const PIT_ROWS_PER_PERIOD = 6;

function clampLimit(
  limit: number | undefined,
  fallback = US_DEFAULT_LIMIT,
): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), US_MAX_LIMIT);
}

function empty<T>(reason: string, degraded = false): UsReadResult<T> {
  return {
    rows: [],
    asOf: null,
    currency: "USD",
    origin: "NONE",
    reason,
    degraded,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Identity resolution — the guard
   ──────────────────────────────────────────────────────────────────────── */

export interface UsIdentity {
  cik10: string;
  /** The normalised symbol, when the caller supplied one that resolved. */
  symbol: string | null;
}

type Resolution =
  | { ok: true; identity: UsIdentity }
  | { ok: false; reason: string };

/**
 * `symbol` → `cik10`, through ACTIVE `us_instruments` rows.
 *
 * `cik` is filtered in TYPESCRIPT, not in the `where`. `{ cik: { not: null } }`
 * over Mongo matches only rows where the attribute EXISTS, and `cik` was added
 * by a later `db push` — so on the 41,352 pre-existing active rows it is ABSENT
 * and the predicate returns zero. Selecting the column and testing it here
 * cannot have that failure mode.
 *
 * Measured on prod 2026-08-29: 7,111 of 8,307 active US stock listings carry a
 * CIK (85.6%), collapsing to 5,695 distinct filers. So `SYMBOL_HAS_NO_SEC_CIK`
 * is a real, common and DIFFERENT answer from "we do not know this symbol", and
 * the two are reported separately.
 */
export async function resolveUsFiler(args: {
  symbol?: string | null;
  cik10?: string | null;
}): Promise<Resolution> {
  if (
    args.cik10 !== undefined &&
    args.cik10 !== null &&
    String(args.cik10) !== ""
  ) {
    const padded = padCik10(args.cik10);
    if (padded === null) return { ok: false, reason: REASON_CIK_MALFORMED };
    return {
      ok: true,
      identity: {
        cik10: padded,
        symbol: args.symbol ? normalizeSymbolForUs(args.symbol) : null,
      },
    };
  }

  const symbol = normalizeSymbolForUs(args.symbol);
  if (symbol === "") return { ok: false, reason: REASON_NO_IDENTIFIER };

  const listings = await prisma.usInstrument.findMany({
    where: { symbol, listingStatus: "ACTIVE" },
    select: { cik: true, symbol: true, listingStartDate: true },
    orderBy: { listingStartDate: "desc" },
    take: 25,
  });
  if (listings.length === 0) {
    return { ok: false, reason: REASON_SYMBOL_NOT_IN_UNIVERSE };
  }
  for (const listing of listings) {
    const padded = padCik10(listing.cik);
    if (padded !== null)
      return { ok: true, identity: { cik10: padded, symbol } };
  }
  return { ok: false, reason: REASON_SYMBOL_HAS_NO_CIK };
}

/**
 * Does an ACTIVE `us_instruments` row exist for this symbol?
 *
 * 13F holdings key on SYMBOL, not on the issuer's CIK, so this read does not
 * need the CIK join and must not fail for the 14.4% of listings that lack one.
 */
async function resolveUsListingSymbol(
  symbol: string | null | undefined,
): Promise<{ ok: true; symbol: string } | { ok: false; reason: string }> {
  const normalized = normalizeSymbolForUs(symbol);
  if (normalized === "") return { ok: false, reason: REASON_NO_IDENTIFIER };
  const hit = await prisma.usInstrument.findFirst({
    where: { symbol: normalized, listingStatus: "ACTIVE" },
    select: { symbol: true },
  });
  if (!hit) return { ok: false, reason: REASON_SYMBOL_NOT_IN_UNIVERSE };
  return { ok: true, symbol: normalized };
}

/* ─────────────────────────────────────────────────────────────────────────
   1. Statements — the point-in-time read
   ──────────────────────────────────────────────────────────────────────── */

export interface GetStatementsArgs {
  cik10?: string | null;
  symbol?: string | null;
  statementType: UsStatementType;
  periodType: UsPeriodType;
  /**
   * "As it was known on this date". Applies `filedAt <= asOf` and then picks the
   * row that would have been current then. Omit for "as it is now" (`isLatest`).
   */
  asOf?: Date | string | null;
  limit?: number;
}

export async function getStatements(
  args: GetStatementsArgs,
): Promise<UsReadResult<UsStatementRow>> {
  const resolved = await resolveUsFiler(args);
  if (!resolved.ok) return empty(resolved.reason);
  const { cik10 } = resolved.identity;

  const limit = clampLimit(args.limit);
  const asOf =
    args.asOf === undefined || args.asOf === null
      ? null
      : args.asOf instanceof Date
        ? args.asOf
        : new Date(args.asOf);
  if (asOf !== null && Number.isNaN(asOf.getTime())) {
    return empty(REASON_NO_IDENTIFIER);
  }

  const rows = await prisma.usFundamentals.findMany({
    where: {
      cik10,
      statementType: args.statementType,
      periodType: args.periodType,
      ...(asOf ? { filedAt: { lte: asOf } } : { isLatest: true }),
    },
    orderBy: [{ periodEnd: "desc" }, { filedAt: "desc" }],
    take: limit * PIT_ROWS_PER_PERIOD,
  });

  const picked = pickPointInTime(
    rows.map(toStatementRow),
    asOf ?? undefined,
  ).slice(0, limit);

  if (picked.length === 0) return empty(REASON_NO_ROWS);
  return {
    rows: picked,
    asOf: newestFiledAt(picked),
    currency: "USD",
    origin: "DB",
    reason: null,
    degraded: false,
  };
}

/**
 * The same read, mapped into the shape `packages/research`'s compute tools
 * already bind to. Kept here so the concept translation has ONE definition.
 */
export async function getStatementsAsFinancialStatements(
  args: GetStatementsArgs,
): Promise<UsReadResult<UsMappedStatement>> {
  const out = await getStatements(args);
  return { ...out, rows: out.rows.map((r) => mapStandardizedToStatement(r)) };
}

interface RawStatement {
  cik10: string;
  symbol: string | null;
  statementType: string;
  periodType: string;
  periodStart: Date | null;
  periodEnd: Date;
  fiscalYear: number;
  fiscalPeriod: string;
  accession: string;
  form: string;
  filedAt: Date;
  isAmendment: boolean;
  isLatest: boolean;
  standardized: unknown;
  asReported: unknown;
  mappingSource: string;
  mappingVersion: string;
  parserVersion: string;
}

function toStatementRow(r: RawStatement): UsStatementRow {
  return {
    cik10: r.cik10,
    symbol: r.symbol,
    statementType: r.statementType as UsStatementType,
    periodType: r.periodType as UsPeriodType,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    fiscalYear: r.fiscalYear,
    fiscalPeriod: r.fiscalPeriod,
    accession: r.accession,
    form: r.form,
    filedAt: r.filedAt,
    isAmendment: r.isAmendment,
    isLatest: r.isLatest,
    currency: "USD",
    standardized: (r.standardized ?? {}) as Record<string, unknown>,
    asReported: r.asReported,
    mappingSource: r.mappingSource,
    mappingVersion: r.mappingVersion,
    parserVersion: r.parserVersion,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   2. Insider transactions
   ──────────────────────────────────────────────────────────────────────── */

export interface GetInsiderArgs {
  symbol?: string | null;
  cik10?: string | null;
  from?: Date | string | null;
  to?: Date | string | null;
  /** SEC transaction codes to keep, e.g. `["P", "S"]`. Omit for all. */
  codes?: readonly string[];
  limit?: number;
}

/**
 * The `where` for both insider reads, built once.
 *
 * `cik10` is passed in already resolved and concrete — see the file header for
 * why an `undefined` identifier here would match every issuer.
 */
function buildInsiderWhere(
  cik10: string,
  args: Pick<GetInsiderArgs, "from" | "to" | "codes">,
): Record<string, unknown> {
  const from = args.from ? new Date(args.from) : null;
  const to = args.to ? new Date(args.to) : null;
  const codes = (args.codes ?? [])
    .map((c) => String(c).trim().toUpperCase())
    .filter((c) => c !== "");

  const range: Record<string, Date> = {};
  if (from && !Number.isNaN(from.getTime())) range.gte = from;
  if (to && !Number.isNaN(to.getTime())) range.lte = to;

  return {
    issuerCik10: cik10,
    ...(Object.keys(range).length > 0 ? { transactionDate: range } : {}),
    ...(codes.length > 0 ? { transactionCode: { in: codes } } : {}),
  };
}

/** Newest by transaction date, falling back to the newest filing. */
function insiderAsOf(rows: readonly UsInsiderRow[]): string | null {
  return (
    isoOrNull(
      rows.reduce<Date | null>(
        (best, r) =>
          r.transactionDate && (!best || r.transactionDate > best)
            ? r.transactionDate
            : best,
        null,
      ),
    ) ?? newestFiledAt(rows)
  );
}

const INSIDER_ORDER = [
  { transactionDate: "desc" },
  { filedAt: "desc" },
] as const;

export async function getInsiderTransactions(
  args: GetInsiderArgs,
): Promise<UsReadResult<UsInsiderRow>> {
  const resolved = await resolveUsFiler(args);
  if (!resolved.ok) return empty(resolved.reason);

  // The cap here is the CONTRACT — the caller asked for N transactions and gets
  // N rows and nothing derived from them, so stopping at N is an answer rather
  // than a silent change of population. `getInsiderActivity` is the one that
  // cannot use a cap this way, because it computes a total.
  const limit = clampLimit(args.limit, 100);
  const rows = await prisma.usInsiderTransaction.findMany({
    where: buildInsiderWhere(resolved.identity.cik10, args),
    orderBy: [...INSIDER_ORDER],
    take: limit,
  });

  const mapped = rows.map(toInsiderRow);
  if (mapped.length === 0) return empty(REASON_NO_ROWS);
  return {
    rows: mapped,
    asOf: insiderAsOf(mapped),
    currency: "USD",
    origin: "DB",
    reason: null,
    degraded: false,
  };
}

/**
 * Insider activity summarised BY CODE CLASS over a trailing window.
 *
 * The window is applied in the QUERY (`transactionDate >= now - windowDays`) —
 * that is where the clock lives. `summarizeInsiderActivity` is pure and anchors
 * on the newest row it is handed, so the two agree without the logic ever
 * reading a clock.
 *
 * ## `limit` caps the ROWS, never the ARITHMETIC
 *
 * This used to delegate to `getInsiderTransactions` with `take: limit` and then
 * summarise whatever came back, so the "180-day totals" for any issuer with
 * more than `limit` transactions in the window were the totals of the newest
 * `limit` of them. Wrong LOW — which does not read as an error, it reads as an
 * insider desk that has gone quiet.
 *
 * So the window is read WHOLE (up to `US_INSIDER_SCAN_MAX`) and summarised whole;
 * `limit` slices only the rows that are handed back. The classification stays
 * in `summarizeInsiderActivity` rather than being re-expressed as a Mongo
 * aggregation: an `F` that is not an `S` is one rule, and two copies of it in
 * two languages is how the two stop agreeing.
 *
 * At the ceiling the result is DEGRADED with a named reason. It is not a cap
 * with a larger number: the summary would be wrong in exactly the same way,
 * only for fewer issuers.
 */
export async function getInsiderActivity(args: {
  symbol?: string | null;
  cik10?: string | null;
  windowDays?: number;
  limit?: number;
  /** Injectable clock. Defaults to `new Date()`. */
  now?: Date;
}): Promise<
  UsReadResult<UsInsiderRow> & { summary: UsInsiderActivitySummary }
> {
  const windowDays =
    Number.isFinite(args.windowDays) && (args.windowDays as number) > 0
      ? Math.floor(args.windowDays as number)
      : 180;
  const now = args.now ?? new Date();
  const from = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  // An unresolved identity still owes the caller a summary object — a shape
  // that is sometimes absent forces every consumer to guard, and one that
  // forgets to is a TypeError instead of an empty result.
  const emptySummary = () => summarizeInsiderActivity([], windowDays);

  const resolved = await resolveUsFiler(args);
  if (!resolved.ok) {
    return {
      ...empty<UsInsiderRow>(resolved.reason),
      summary: emptySummary(),
    };
  }

  const limit = clampLimit(args.limit, US_MAX_LIMIT);
  const page = await prisma.usInsiderTransaction.findMany({
    where: buildInsiderWhere(resolved.identity.cik10, { from, to: now }),
    orderBy: [...INSIDER_ORDER],
    take: US_INSIDER_SCAN_MAX + 1,
  });

  const truncated = page.length > US_INSIDER_SCAN_MAX;
  const window = (truncated ? page.slice(0, US_INSIDER_SCAN_MAX) : page).map(
    toInsiderRow,
  );
  if (window.length === 0) {
    return { ...empty<UsInsiderRow>(REASON_NO_ROWS), summary: emptySummary() };
  }

  return {
    // Capped for PRESENTATION only. The summary below saw all of `window`.
    rows: window.slice(0, limit),
    asOf: insiderAsOf(window),
    currency: "USD",
    origin: "DB",
    reason: truncated ? REASON_INSIDER_WINDOW_TRUNCATED : null,
    degraded: truncated,
    summary: summarizeInsiderActivity(window, windowDays),
  };
}

interface RawInsider {
  accession: string;
  rowIndex: number;
  issuerCik10: string;
  issuerName: string;
  symbol: string | null;
  ownerCik10: string;
  ownerName: string;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPctOwner: boolean;
  officerTitle: string | null;
  form: string;
  transactionDate: Date | null;
  filedAt: Date;
  securityTitle: string;
  isDerivative: boolean;
  isHolding: boolean;
  transactionCode: string | null;
  codeMeaning: string | null;
  equitySwap: boolean;
  acquiredDisposed: string | null;
  shares: number | null;
  price: number | null;
  value: number | null;
  sharesOwnedAfter: number | null;
  directIndirect: string | null;
  isAmendment: boolean;
}

function toInsiderRow(r: RawInsider): UsInsiderRow {
  return {
    accession: r.accession,
    rowIndex: r.rowIndex,
    issuerCik10: r.issuerCik10,
    issuerName: r.issuerName,
    symbol: r.symbol,
    ownerCik10: r.ownerCik10,
    ownerName: r.ownerName,
    isDirector: r.isDirector,
    isOfficer: r.isOfficer,
    isTenPctOwner: r.isTenPctOwner,
    officerTitle: r.officerTitle,
    form: r.form,
    transactionDate: r.transactionDate,
    filedAt: r.filedAt,
    securityTitle: r.securityTitle,
    isDerivative: r.isDerivative,
    isHolding: r.isHolding,
    transactionCode: r.transactionCode,
    codeMeaning: r.codeMeaning,
    equitySwap: r.equitySwap,
    acquiredDisposed: r.acquiredDisposed,
    shares: r.shares,
    price: r.price,
    value: r.value,
    sharesOwnedAfter: r.sharesOwnedAfter,
    directIndirect: r.directIndirect,
    currency: "USD",
    isAmendment: r.isAmendment,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   3. 13F — top holders of one issuer, with QoQ
   ──────────────────────────────────────────────────────────────────────── */

export interface GetTopHoldersArgs {
  symbol: string;
  /** The report period. Omit for the newest we hold for this symbol. */
  period?: Date | string | null;
  limit?: number;
}

/**
 * Managers holding one issuer, with the change since the previous period.
 *
 * ## The limit is applied PER BUCKET, and only to what is SHOWN
 *
 * `limit` caps the HELD holders and, separately, the EXITED ones. A single
 * ranked list truncated at `limit` would drop every exit — an exited holder has
 * a zero position and sorts last by construction — which is exactly the failure
 * `resolveQoQ` exists to prevent, reintroduced one layer up. The seller is the
 * holder a reader most wants to see.
 *
 * The same argument applies one layer DOWN, and used not to: both periods are
 * now read WHOLE and the cap is applied after the diff. A `take` on the QUERY
 * decides which managers exist, and a manager who crosses the take boundary
 * between two quarters is reported as having liquidated. See `US_FULL_SCAN_MAX`
 * for the measured shape of that and for what happens at the ceiling.
 */
export async function getTopHolders(
  args: GetTopHoldersArgs,
): Promise<UsReadResult<UsHolderDelta>> {
  const listing = await resolveUsListingSymbol(args.symbol);
  if (!listing.ok) return empty(listing.reason);
  const symbol = listing.symbol;
  const limit = clampLimit(args.limit);

  let period: Date | null = null;
  if (args.period !== undefined && args.period !== null) {
    const d = new Date(args.period);
    if (!Number.isNaN(d.getTime())) period = d;
  }
  if (period === null) {
    const newest = await prisma.usThirteenFHolding.findFirst({
      where: { symbol },
      orderBy: { periodOfReport: "desc" },
      select: { periodOfReport: true },
    });
    if (!newest) return empty(REASON_NO_ROWS);
    period = newest.periodOfReport;
  }

  const prior = await prisma.usThirteenFHolding.findFirst({
    where: { symbol, periodOfReport: { lt: period } },
    orderBy: { periodOfReport: "desc" },
    select: { periodOfReport: true },
  });

  // BOTH periods are loaded WHOLE. A diff over a truncated population is not a
  // diff: the truncated tail is missing from one side and present in the other,
  // and `resolveQoQ` has no way to tell that from a manager who sold. The cap
  // that used to live here (`take: US_MAX_LIMIT`) is now applied to the
  // PRESENTED rows only, at the bottom of this function. See US_FULL_SCAN_MAX.
  const currentPage = await prisma.usThirteenFHolding.findMany({
    where: { symbol, periodOfReport: period },
    orderBy: { valueUsd: "desc" },
    take: US_FULL_SCAN_MAX + 1,
    select: HOLDING_COLUMNS,
  });
  const previousPage = prior
    ? await prisma.usThirteenFHolding.findMany({
        where: { symbol, periodOfReport: prior.periodOfReport },
        orderBy: { valueUsd: "desc" },
        take: US_FULL_SCAN_MAX + 1,
        select: HOLDING_COLUMNS,
      })
    : [];

  const truncated =
    currentPage.length > US_FULL_SCAN_MAX ||
    previousPage.length > US_FULL_SCAN_MAX;
  const current = truncated
    ? currentPage.slice(0, US_FULL_SCAN_MAX)
    : currentPage;
  const previous = truncated
    ? previousPage.slice(0, US_FULL_SCAN_MAX)
    : previousPage;

  if (current.length === 0 && previous.length === 0) {
    return empty(REASON_NO_ROWS);
  }

  // An EMPTY current period with a populated prior one is not a quarter in
  // which everyone sold. What it IS cannot be decided here — see the two causes
  // below and the reason's docblock.
  //
  // The previous guard required BOTH sides to be empty, so this case fell
  // through to `resolveQoQ([], previous)`, which by construction marks every
  // prior holder `isExited` with its whole position as a negative delta, and
  // returned it with `reason: null, degraded: false`. Measured: asking for
  // 2026-06-30 before those filings land reported Vanguard, BlackRock and
  // Berkshire as having each liquidated their entire Apple stake — a
  // confident, specific, catastrophic claim assembled from ordinary lag.
  //
  // Two ordinary ways to reach it: 13Fs are due 45 days after quarter end, so
  // the window between a quarter closing and its filings arriving is weeks
  // long; and `periodOfReport` is matched by EXACT DateTime equality, so a
  // caller passing an offset-bearing timestamp misses `current` while still
  // finding `prior`. The reason names NEITHER — see its docblock — because a
  // branch that cannot tell them apart must not pick one, and picking the lag
  // is the reassuring pick that stops anyone looking at the second.
  //
  // DEGRADED, like the `NO_PRIOR_13F_PERIOD` sibling below and for the same
  // reason: this is not a clean "nothing here". A comparison the data would
  // otherwise support was REFUSED, so the caller has an unanswered question
  // rather than an answered one, and `degraded` is the flag every consumer
  // already checks before quoting a result.
  if (current.length === 0) {
    return empty(REASON_REQUESTED_PERIOD_EMPTY, true);
  }

  const deltas = resolveQoQ(
    current.map((r) => toHoldingRow(r)),
    previous.map((r) => toHoldingRow(r)),
  );
  const held = deltas.filter((d) => !d.isExited).slice(0, limit);
  const exited = deltas.filter((d) => d.isExited).slice(0, limit);
  const rows = await attachManagerNames([...held, ...exited]);

  return {
    rows,
    asOf: isoOrNull(period),
    currency: "USD",
    origin: "DB",
    // Two things can be wrong with this diff and only one name fits, so the
    // stronger claim wins: TRUNCATED invalidates every `isNew` AND every
    // `isExited` (either side may be missing rows), which strictly contains
    // what NO_PRIOR_PERIOD invalidates (`isNew` only, and for a reason that is
    // not a defect — the first quarter we hold has no predecessor). `degraded`
    // is true for either.
    reason: truncated
      ? REASON_HOLDER_SET_TRUNCATED
      : prior
        ? null
        : REASON_NO_PRIOR_PERIOD,
    degraded: truncated || !prior,
  };
}

/**
 * Stamp `managerName` onto the rows `getTopHolders` is about to RETURN.
 *
 * ## Why this needs a second read at all
 *
 * `us_13f_holdings` carries no manager NAME — only `managerCik10`. The name is
 * on the FILING (`us_13f_filings.managerName`), which `getManagerHoldings`
 * reads anyway and this issuer-side view never did, so every institutional
 * holder came back `managerName: null` — a CIK string from a tool whose
 * description promises "institutional holders", rendering as a blank column.
 *
 * ## Why this is not the N+1 it looks like
 *
 * It runs ONCE, over the PRESENTED rows only — `held` and `exited` are already
 * sliced to `limit` each, so this is at most `2 * US_MAX_LIMIT` = 1,000 rows
 * and, after de-duplication, far fewer accessions. Deliberately NOT run before
 * the diff: the pre-diff population is capped at `US_FULL_SCAN_MAX` rows, and a
 * `$in` of that size to name fifty managers is the wrong trade.
 *
 * Keyed on `accession` (`@@unique([accession])`, so indexed) rather than on
 * `managerCik10`, because that is the column `UsHolderDelta` already carries
 * for exactly this purpose: "the newest accession that evidences this row
 * (current, or the PRIOR one for an exit)". A CIK-keyed join would have to know
 * which period each row came from, and would silently pick a manager's name as
 * of the wrong quarter for every exit.
 *
 * ## An unknown name stays NULL
 *
 * Never the CIK, never "". A filing row that is absent is a fact about our
 * store, and dressing it up as a value is how a caller stops being able to tell
 * "we do not know who this is" from "this manager is called 0001067983".
 */
async function attachManagerNames(
  rows: UsHolderDelta[],
): Promise<UsHolderDelta[]> {
  const accessions = [
    ...new Set(rows.map((r) => r.accession).filter((a): a is string => !!a)),
  ];
  if (accessions.length === 0) return rows;

  const filings = await prisma.usThirteenFFiling.findMany({
    where: { accession: { in: accessions } },
    select: { accession: true, managerName: true },
  });
  const nameFor = new Map<string, string>();
  for (const f of filings) {
    if (f.managerName) nameFor.set(f.accession, f.managerName);
  }

  return rows.map((r) =>
    r.managerName ? r : { ...r, managerName: nameFor.get(r.accession) ?? null },
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   4. 13F — one manager's portfolio for one period (HOT or COLD)
   ──────────────────────────────────────────────────────────────────────── */

export interface GetManagerHoldingsArgs {
  managerCik10: string;
  period: Date | string;
  limit?: number;
}

/**
 * One manager's 13F portfolio.
 *
 * HOT rows come from Mongo. When `us_13f_filings.tier` is COLD the rows were
 * evicted to a gz-JSONL shard on GCS and come through `cold-holdings.ts`, whose
 * read is THREE-STATE. A `failed` cold read is reported as a DEGRADED result
 * with `COLD_SHARD_READ_FAILED`, never as an empty portfolio: a storage blip
 * that reads as "this manager sold everything" is not visibly wrong, and that
 * is exactly the MONEY-941 shape.
 */
export async function getManagerHoldings(
  args: GetManagerHoldingsArgs,
): Promise<UsReadResult<UsHoldingRow>> {
  const cik10 = padCik10(args.managerCik10);
  if (cik10 === null) return empty(REASON_CIK_MALFORMED);
  const period = new Date(args.period);
  if (Number.isNaN(period.getTime())) return empty(REASON_NO_IDENTIFIER);
  const limit = clampLimit(args.limit, US_MAX_LIMIT);

  const filings = await prisma.usThirteenFFiling.findMany({
    where: { managerCik10: cik10, periodOfReport: period },
    orderBy: { filedAt: "asc" },
    select: {
      accession: true,
      filedAt: true,
      isAmendment: true,
      amendmentType: true,
      tier: true,
      coldPath: true,
      managerName: true,
    },
  });
  if (filings.length === 0) return empty(REASON_NO_THIRTEENF_FILING);

  const plan = selectThirteenFAccessions(filings as ThirteenFFilingRef[]);
  const managerName = filings[filings.length - 1]?.managerName ?? null;

  const hot = await prisma.usThirteenFHolding.findMany({
    where: { accession: { in: plan.accessions } },
    orderBy: { valueUsd: "desc" },
    take: US_MAX_LIMIT,
  });
  let rows = hot.map((r) => toHoldingRow(r, managerName));
  let origin: UsReadResult<UsHoldingRow>["origin"] = "DB";
  let reason: string | null = null;
  let degraded = false;

  if (plan.hasCold) {
    const cold = await readThirteenFColdShard({
      managerCik10: cik10,
      periodOfReport: period,
      coldPath: plan.coldPaths[0] ?? null,
    });
    if (cold.status === "failed") {
      // The rows we DO have are correct; they are not all of them. This must
      // fire whether or not the hot half returned anything — a partial answer
      // that does not say it is partial is the silent-truncation shape, and it
      // is WORSE than an empty one because nothing about it looks wrong.
      reason = REASON_COLD_READ_FAILED;
      degraded = true;
    } else if (cold.status === "present") {
      const seen = new Set(rows.map((r) => `${r.accession}|${r.rowIndex}`));
      for (const row of cold.rows) {
        const key = `${row.accession}|${row.rowIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row.managerName ? row : { ...row, managerName });
      }
      origin = hot.length > 0 ? "DB+COLD" : "COLD";
    } else {
      // A filing marked COLD whose shard is ABSENT is not "an empty portfolio".
      // Two different facts, reported as two: no store is registered in this
      // process (local dev, an unwired worker), or a store answered 404 for a
      // shard the evictor claims to have written — most likely a key the
      // writer and this reader spell differently.
      reason =
        getUsColdStore() === null
          ? REASON_COLD_STORE_UNREGISTERED
          : REASON_COLD_SHARD_ABSENT;
      degraded = true;
    }
  }

  if (plan.ambiguous.length > 0 && reason === null) {
    reason = REASON_AMBIGUOUS_AMENDMENT;
    degraded = true;
  }

  rows = rows.sort((a, b) => b.valueUsd - a.valueUsd).slice(0, limit);
  if (rows.length === 0) {
    return empty(reason ?? REASON_NO_ROWS, degraded);
  }
  return {
    rows,
    asOf: isoOrNull(period),
    currency: "USD",
    origin,
    reason,
    degraded,
  };
}

interface RawHolding {
  accession: string;
  rowIndex: number;
  managerCik10: string;
  periodOfReport: Date;
  filedAt: Date;
  cusip: string;
  figi: string | null;
  issuerName: string;
  titleOfClass: string;
  valueUsd: number;
  shares: number;
  sharesType: string;
  putCall: string | null;
  symbol: string | null;
}

function toHoldingRow(
  r: RawHolding,
  managerName: string | null = null,
): UsHoldingRow {
  return {
    accession: r.accession,
    rowIndex: r.rowIndex,
    managerCik10: r.managerCik10,
    managerName,
    periodOfReport: r.periodOfReport,
    filedAt: r.filedAt,
    cusip: r.cusip,
    figi: r.figi,
    issuerName: r.issuerName,
    titleOfClass: r.titleOfClass,
    valueUsd: r.valueUsd,
    shares: r.shares,
    sharesType: r.sharesType,
    putCall: r.putCall,
    symbol: r.symbol,
    currency: "USD",
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   5. Schedules 13D / 13G
   ──────────────────────────────────────────────────────────────────────── */

export async function getBeneficialOwners(args: {
  symbol?: string | null;
  cik10?: string | null;
  limit?: number;
}): Promise<UsReadResult<UsBeneficialOwnerRow>> {
  const resolved = await resolveUsFiler(args);
  if (!resolved.ok) return empty(resolved.reason);
  const limit = clampLimit(args.limit);

  const rows = await prisma.usBeneficialOwnership.findMany({
    where: { subjectCik10: resolved.identity.cik10 },
    orderBy: { filedAt: "desc" },
    take: limit,
  });
  const mapped = rows.map(toBeneficialOwnerRow);
  if (mapped.length === 0) return empty(REASON_NO_ROWS);
  return {
    rows: mapped,
    asOf: newestFiledAt(mapped),
    currency: "USD",
    origin: "DB",
    reason: null,
    degraded: false,
  };
}

interface RawBeneficial {
  accession: string;
  rowIndex: number;
  schedule: string;
  form: string;
  isAmendment: boolean;
  subjectCik10: string;
  subjectName: string;
  cusip: string | null;
  symbol: string | null;
  filerCik10: string | null;
  filerName: string;
  percentOfClass: number | null;
  sharesOwned: number | null;
  typeOfReportingPerson: string | null;
  eventDate: Date | null;
  filedAt: Date;
  purposeText: string | null;
  hasStructuredData: boolean;
}

function toBeneficialOwnerRow(r: RawBeneficial): UsBeneficialOwnerRow {
  return {
    accession: r.accession,
    rowIndex: r.rowIndex,
    schedule: r.schedule,
    form: r.form,
    isAmendment: r.isAmendment,
    subjectCik10: r.subjectCik10,
    subjectName: r.subjectName,
    cusip: r.cusip,
    symbol: r.symbol,
    filerCik10: r.filerCik10,
    filerName: r.filerName,
    percentOfClass: r.percentOfClass,
    sharesOwned: r.sharesOwned,
    typeOfReportingPerson: r.typeOfReportingPerson,
    eventDate: r.eventDate,
    filedAt: r.filedAt,
    purposeText: r.purposeText,
    hasStructuredData: r.hasStructuredData,
    currency: "USD",
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   6. The filing ledger
   ──────────────────────────────────────────────────────────────────────── */

export async function getFilings(args: {
  cik10?: string | null;
  symbol?: string | null;
  forms?: readonly string[];
  from?: Date | string | null;
  to?: Date | string | null;
  limit?: number;
}): Promise<UsReadResult<UsFilingRow>> {
  const resolved = await resolveUsFiler(args);
  if (!resolved.ok) return empty(resolved.reason);
  const limit = clampLimit(args.limit, 50);

  const forms = (args.forms ?? [])
    .map((f) => String(f).trim().toUpperCase())
    .filter((f) => f !== "");
  const range: Record<string, Date> = {};
  const from = args.from ? new Date(args.from) : null;
  const to = args.to ? new Date(args.to) : null;
  if (from && !Number.isNaN(from.getTime())) range.gte = from;
  if (to && !Number.isNaN(to.getTime())) range.lte = to;

  const rows = await prisma.usFiling.findMany({
    where: {
      cik10: resolved.identity.cik10,
      ...(forms.length > 0 ? { form: { in: forms } } : {}),
      ...(Object.keys(range).length > 0 ? { filedAt: range } : {}),
    },
    orderBy: [{ filedAt: "desc" }, { accession: "desc" }],
    take: limit,
  });
  const mapped = rows.map(toFilingRow);
  if (mapped.length === 0) return empty(REASON_NO_ROWS);
  return {
    rows: mapped,
    asOf: newestFiledAt(mapped),
    currency: "USD",
    origin: "DB",
    reason: null,
    degraded: false,
  };
}

interface RawFiling {
  accession: string;
  cik10: string;
  form: string;
  filedAt: Date;
  acceptedAt: Date | null;
  periodOfReport: Date | null;
  items: string[];
  primaryDocument: string | null;
  isXbrl: boolean;
  parseClass: string;
  status: string;
}

function toFilingRow(r: RawFiling): UsFilingRow {
  return {
    accession: r.accession,
    cik10: r.cik10,
    form: r.form,
    filedAt: r.filedAt,
    acceptedAt: r.acceptedAt,
    periodOfReport: r.periodOfReport,
    items: r.items,
    primaryDocument: r.primaryDocument,
    isXbrl: r.isXbrl,
    parseClass: r.parseClass,
    status: r.status,
    currency: "USD",
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   7. Coverage — the release gate's input
   ──────────────────────────────────────────────────────────────────────── */

/**
 * How much of the universe we actually hold statements for.
 *
 * `statementYears` is the count of DISTINCT `fiscalYear`s with an ANNUAL income
 * statement, per filer. It is computed by grouping `us_fundamentals`, not by
 * counting rows: a fiscal year legitimately occupies several rows (the original
 * plus every restatement), so a row count would report a heavily-amended filer
 * as having more years than it has.
 */
export async function getFilerCoverage(): Promise<UsCoverageJudgement> {
  const filers = await prisma.usFiler.findMany({
    where: { inUniverse: true },
    select: { cik10: true, eligibleForCoverage: true, fiscalYearsOnFile: true },
  });
  if (filers.length === 0) return judgeCoverage([]);

  const groups = await prisma.usFundamentals.groupBy({
    by: ["cik10", "fiscalYear"],
    where: { statementType: "INCOME", periodType: "ANNUAL" },
  });
  const years = new Map<string, number>();
  for (const g of groups as Array<{ cik10: string; fiscalYear: number }>) {
    years.set(g.cik10, (years.get(g.cik10) ?? 0) + 1);
  }

  return judgeCoverage(
    filers.map((f) => ({
      eligibleForCoverage: f.eligibleForCoverage,
      fiscalYearsOnFile: f.fiscalYearsOnFile,
      statementYears: years.get(f.cik10) ?? 0,
    })),
  );
}
