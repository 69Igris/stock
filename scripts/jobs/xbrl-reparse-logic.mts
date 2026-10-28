/**
 * The decisions `scripts/jobs/xbrl-reparse.ts` makes — MONEY-1252.
 *
 * Pure. No Prisma, no GCS, no clock, no console. The job file calls `main()` at
 * module top level (the Cloud Run entry-point convention shared with
 * `xbrl-backfill.ts` and `xbrl-projection-drain.ts`), so importing it from a
 * test would run it against a real database and a real bucket. Everything that
 * can be decided without I/O therefore lives here, and the loop takes its
 * pager, its row worker and its clock as dependencies.
 *
 * ## What the tests in here actually protect
 *
 * Two properties, both of which have already cost this repo a release:
 *
 *  1. **The page must ADVANCE.** MONEY-1211: a batch ordered by a column that
 *     is constant across the population hands every run the same first N rows
 *     forever — they get rewritten every night while the rest are never
 *     selected, with no error, no alert and no data (681 of 781 symbols). The
 *     cursor here is `XbrlFiling.id`, a Mongo ObjectId, which is unique and
 *     ascending — but "the cursor is unique" is a claim about a query somebody
 *     can change, so the loop measures it: a page whose last id is not STRICTLY
 *     greater than the previous page's stops the run as `no-advance` instead of
 *     spinning to the 24 h task timeout.
 *
 *  2. **A partial run must SAY SO.** `xbrl-backfill.ts` reports a count that
 *     stopped early as a FLOOR, because a completeness number asserted at the
 *     wrong granularity is the MONEY-1189 defect restated. Every stop reason
 *     other than `drained` prints the resume cursor and exits non-zero.
 */

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Rows per keyset page. 200, not the backfill's 500.
 *
 * The page is not the cost centre — each row costs one GCS `get` of a ~50 KB
 * document plus a parse — but the page IS the memory footprint, and a smaller
 * page shortens the window in which a killed task loses un-flushed progress.
 * There is no ack deadline here (this is a Cloud Run JOB, not a Pub/Sub push
 * handler), so nothing about 600 s applies; see the "Job throughput" note in
 * CLAUDE.md for why that constraint is so easy to import by accident.
 */
export const DEFAULT_PAGE = 200;

/** Above this a page stops being a page. */
export const MAX_PAGE = 1000;

/**
 * Wall-clock budget, in ms. 20 hours, inside the 24 h Cloud Run task timeout.
 *
 * The gap is deliberate: a run that ends on its OWN budget prints its resume
 * cursor and exits 1, while a run killed by the platform timeout prints
 * nothing and the next operator has to reconstruct where it got to.
 */
export const DEFAULT_BUDGET_MS = 20 * 60 * 60 * 1000;

/**
 * The `--from` / `--to` SANITY range. NOT a default scope — see `ReparseArgs`.
 *
 * A four-digit year outside this is a typo, and a typo that silently selects
 * nothing is indistinguishable from a completed shard in this job's own
 * vocabulary (`selected 0` = "nothing to do"). Measured on prod 2026-08-25:
 * `xbrl_filings` holds 96,056 rows with `periodEnd` from 2017-06-30 to
 * 2026-06-30, and the archive carries `2016/` and `2017/` prefixes.
 */
export const MIN_PERIOD_YEAR = 2000;

/** A far-future ceiling, so a typo cannot silently select nothing. */
export const MAX_PERIOD_YEAR = 2100;

/** Example lines kept from the whole run. The counters carry the volume. */
export const MAX_REPARSE_EXAMPLES = 20;

export interface ReparseArgs {
  /** `--apply`. Without it the write path runs against a no-op upsert. */
  apply: boolean;
  /** `--dry-run`, accepted explicitly so the wrapper contract is expressible. */
  dryRun: boolean;
  /**
   * Inclusive PERIOD-year floor from `--from`, or undefined for NO floor.
   *
   * UNDEFINED rather than a hard-coded 2016 default, and that is the safe
   * direction: a default floor silently excludes any row below it, and "the
   * job reported DRAINED but skipped 2017" is exactly the wrong-granularity
   * completeness report MONEY-1189 catalogued five times. With no flag the
   * scope is every stored filing; a shard is something the operator asks for
   * out loud.
   */
  fromYear: number | undefined;
  /** Inclusive PERIOD-year ceiling from `--to`, or undefined for NO ceiling. */
  toYear: number | undefined;
  /** `--symbols=A,B`, or undefined for every symbol. */
  symbols: string[] | undefined;
  /** `--after-id=<ObjectId>` — the resume cursor a previous run printed. */
  afterId: string | undefined;
  /**
   * `--limit=N` ROWS for this run. 0 = no cap.
   *
   * ROWS, not documents. `xbrl_filings` averages 1.34 rows per distinct
   * `sourceUrl` (a March-quarter document is stored as both its quarter and its
   * year), so `--limit=500` covers roughly 372 distinct documents. Stated
   * because MONEY-1207 is exactly this: a `take` counted in ROWS over a table
   * where one logical unit occupies several silently returns fewer distinct
   * units than asked for.
   */
  limit: number;
  /** `--page=N` rows per keyset page. */
  page: number;
  /** `--budget-sec=N`, held as ms. */
  budgetMs: number;
}

export interface ReparseArgParse {
  args: ReparseArgs;
  errors: string[];
}

const KNOWN_BOOLEAN_FLAGS = new Set(["--apply", "--dry-run"]);
const KNOWN_VALUE_FLAGS = new Set([
  "from",
  "to",
  "symbols",
  "after-id",
  "limit",
  "page",
  "budget-sec",
]);

function parseCount(
  raw: string | undefined,
  fallback: number,
  name: string,
  errors: string[],
  opts?: { min?: number; max?: number },
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  const min = opts?.min ?? 1;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    errors.push(`--${name}=${raw} is not an integer >= ${min}`);
    return fallback;
  }
  if (opts?.max !== undefined && n > opts.max) {
    errors.push(`--${name}=${n} exceeds the maximum of ${opts.max}`);
    return fallback;
  }
  return n;
}

/**
 * A bare four-digit PERIOD year, or an error naming the sibling it is not.
 *
 * `xbrl-backfill.ts` takes `--from=YYYY-MM` and walks NSE's index by BROADCAST
 * month. This job takes `--from=YYYY` and scopes by the filing's PERIOD year,
 * because that is the axis the archive coverage was measured on (100% for
 * 2017-2025, 70% for 2026) and the axis a re-parse shard is worth cutting on.
 * Two jobs, one flag name, two meanings — so `--from=2024-05` is rejected here
 * with the difference spelled out rather than silently parsed as the number
 * 2024 or as NaN.
 */
function parseYear(
  raw: string | undefined,
  name: string,
  errors: string[],
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d{4}$/.test(trimmed)) {
    errors.push(
      `--${name}=${raw} is not a four-digit year. This job scopes by PERIOD ` +
        `YEAR (--${name}=2024), unlike xbrl-backfill.ts which scopes by ` +
        `BROADCAST MONTH (--${name}=2024-05).`,
    );
    return undefined;
  }
  const n = Number(trimmed);
  if (n < MIN_PERIOD_YEAR || n > MAX_PERIOD_YEAR) {
    errors.push(
      `--${name}=${n} is outside ${MIN_PERIOD_YEAR}..${MAX_PERIOD_YEAR}`,
    );
    return undefined;
  }
  return n;
}

/**
 * A 24-character lowercase hex ObjectId, or an error.
 *
 * Validated rather than passed through because the cursor is the ONLY resume
 * state this job has. A malformed one does not fail loudly at Prisma — it can
 * select nothing, and a run that selects nothing prints `selected 0`, which is
 * this job's own vocabulary for "there was nothing to do". A shard silently
 * reported as complete is exactly the shape MONEY-1220 spent a release on.
 */
function parseObjectId(
  raw: string | undefined,
  name: string,
  errors: string[],
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^[0-9a-f]{24}$/i.test(trimmed)) {
    errors.push(
      `--${name}=${raw} is not a 24-character hex ObjectId. It is the resume ` +
        `cursor the previous run printed; a malformed one selects nothing and ` +
        `the run reports "selected 0", which reads as "already done".`,
    );
    return undefined;
  }
  return trimmed.toLowerCase();
}

/**
 * argv -> `ReparseArgs`, with every default on the SAFE side.
 *
 * An unknown flag is a HARD ERROR, for the reason `parseDrainArgs` states and
 * this job shares: `--apply` is what makes the job do anything, so `--aply`
 * would parse as "no flags given", run a rehearsal, and exit 0 looking exactly
 * like a successful one. `gcloud run jobs execute --args` splits on COMMAS,
 * which makes a stray comma inside a flag a routine mistake rather than a rare
 * one.
 */
export function parseReparseArgs(argv: readonly string[]): ReparseArgParse {
  const errors: string[] = [];

  const value = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };

  for (const token of argv) {
    if (KNOWN_BOOLEAN_FLAGS.has(token)) continue;
    const named = /^--([\w-]+)=/.exec(token);
    if (named && KNOWN_VALUE_FLAGS.has(named[1]!)) continue;
    errors.push(
      `unknown argument "${token}" — refusing to run rather than silently ` +
        `treating it as a dry run (a mistyped --apply is indistinguishable ` +
        `from a deliberate rehearsal)`,
    );
  }

  const fromYear = parseYear(value("from"), "from", errors);
  const toYear = parseYear(value("to"), "to", errors);
  if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) {
    errors.push(
      `--from=${fromYear} is after --to=${toYear}: that window selects ` +
        `nothing, which this job would otherwise report as "nothing to do"`,
    );
  }

  const rawSymbols = value("symbols");
  const symbols =
    rawSymbols === undefined
      ? undefined
      : rawSymbols
          .split(",")
          .map((t) => t.trim().toUpperCase())
          .filter(Boolean);
  if (symbols !== undefined && symbols.length === 0) {
    errors.push(
      `--symbols=${rawSymbols} parsed to zero symbols. An empty filter is ` +
        `not "every symbol" here — it selects nothing.`,
    );
  }

  return {
    args: {
      apply: argv.includes("--apply"),
      dryRun: argv.includes("--dry-run"),
      fromYear,
      toYear,
      symbols,
      afterId: parseObjectId(value("after-id"), "after-id", errors),
      limit: parseCount(value("limit"), 0, "limit", errors, { min: 0 }),
      page: parseCount(value("page"), DEFAULT_PAGE, "page", errors, {
        max: MAX_PAGE,
      }),
      budgetMs:
        parseCount(
          value("budget-sec"),
          DEFAULT_BUDGET_MS / 1000,
          "budget-sec",
          errors,
        ) * 1000,
    },
    errors,
  };
}

/**
 * `--apply` AND NOT `--dry-run`.
 *
 * `--dry-run` WINS when both are present, and that is the only safe polarity:
 * `run-market-data-job.sh` appends `--dry-run` unless the operator passed
 * `--apply`, so the two arriving together means somebody asked for both, and
 * the answer to an ambiguous instruction about a 96,000-row rewrite is the
 * one that writes nothing.
 */
export function resolveReparseApply(args: ReparseArgs): boolean {
  return args.apply && !args.dryRun;
}

/**
 * The inclusive `periodEnd` window for a PERIOD-year scope, or `undefined`.
 *
 * `undefined` when NEITHER bound was given — and the caller must then omit the
 * `periodEnd` key from its `where` entirely rather than passing an open range.
 * A half-open range is expressed by omitting that HALF, not by substituting a
 * sentinel date: a sentinel is a silent floor, and this job's whole failure
 * mode is a silent exclusion that reports DRAINED.
 */
export function periodYearWindow(
  fromYear: number | undefined,
  toYear: number | undefined,
): { gte?: Date; lte?: Date } | undefined {
  if (fromYear === undefined && toYear === undefined) return undefined;
  return {
    ...(fromYear !== undefined
      ? { gte: new Date(Date.UTC(fromYear, 0, 1, 0, 0, 0, 0)) }
      : {}),
    ...(toYear !== undefined
      ? { lte: new Date(Date.UTC(toYear, 11, 31, 23, 59, 59, 999)) }
      : {}),
  };
}

/**
 * Are these archived bytes a document we should hand to the parser?
 *
 * The SAME guard `fetchXml` keeps on the ingest side, and it is here for the
 * same reason rather than for symmetry: a challenge page or an error page
 * archived under an `.xml` key parses as `not-xbrl`, which
 * `bucketForOutcome` counts as `unparseable` — and `unparseable` sends the next
 * investigation to the CONCEPT TABLE when the fault is in the ARCHIVE. Two
 * different repairs, and the counter is the only thing that says which.
 *
 * `<!` catches `<!DOCTYPE html>` and an HTML comment banner. A real XBRL
 * instance opens with `<?xml` or with the root element, never with `<!` — the
 * XML declaration is required to be first when present, and a DOCTYPE is not
 * something NSE's instances carry.
 *
 * Deliberately NOT a parse: this decides which BUCKET a failure lands in, and
 * asking the parser first would be circular.
 */
export function isUsableArchivedXml(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) return false;
  return !trimmed.startsWith("<!");
}

/* -------------------------------------------------------------------------- */
/* Counters                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One row's result, in the vocabulary the job counts in.
 *
 * Every arm is its OWN bucket and they are never added together. MONEY-1220's
 * `bucketForOutcome` exists for exactly this: route a governance filing into
 * `unparseable` and every healthy run reads as broken; route a taxonomy failure
 * into `nonFinancial` and a total parse outage reads as a quiet week.
 */
export type ReparseRowResult =
  /** No archived object under any candidate key. Counted, SKIPPED, no fetch. */
  | { kind: "archive-missing" }
  /** The archive read THREW. Not evidence of absence — see the counter. */
  | { kind: "archive-read-failed" }
  /** Bytes arrived and are not a document (empty, or an HTML challenge page). */
  | { kind: "archive-unusable" }
  /** The document was read. `bucket` is `bucketForOutcome`'s verdict. */
  | {
      kind: "parsed";
      bucket: string;
      /** `storeFiling`'s refusal for the primary period, or null. */
      refusal: string | null;
      /** The ANNUAL companion verdict for the same bytes. */
      annual: "written" | "none" | "ambiguous" | "unreadable";
      /**
       * The upsert cleared `projectedAt` — i.e. this row's facts MOVED.
       *
       * Observed at the Prisma seam rather than re-derived, so it is the write
       * path's own decision (`projectionInputChanged`) and not a second copy of
       * it that can disagree.
       */
      projectionReset: boolean;
    };

export interface ReparseTotals {
  /** Rows this run took on. The `selected` half of the job-outcome contract. */
  selected: number;
  /** Rows with no archived object. A KNOWN gap, never in the failure numerator. */
  archiveMissing: number;
  /** Rows whose archive read threw. Reported as `transportFailures`. */
  archiveReadFailed: number;
  /** Bytes that were not a usable document. */
  archiveUnusable: number;
  /** Per `bucketForOutcome` verdict, including `financials`. */
  buckets: Record<string, number>;
  /** Per `storeFiling` refusal reason. */
  refusals: Record<string, number>;
  /** PRIMARY rows the write path persisted (or, dry, WOULD have). */
  stored: number;
  /** ANNUAL companion rows persisted (or, dry, WOULD have). */
  storedAnnual: number;
  annualAmbiguous: number;
  annualUnreadable: number;
  /** Rows whose facts actually CHANGED — the number this job exists to move. */
  projectionReset: number;
  /** The highest row id processed. The resume cursor. */
  lastId: string | null;
  examples: string[];
}

export function emptyReparseTotals(): ReparseTotals {
  return {
    selected: 0,
    archiveMissing: 0,
    archiveReadFailed: 0,
    archiveUnusable: 0,
    buckets: {},
    refusals: {},
    stored: 0,
    storedAnnual: 0,
    annualAmbiguous: 0,
    annualUnreadable: 0,
    projectionReset: 0,
    lastId: null,
    examples: [],
  };
}

/** Fold one row's result into the running totals. Mutates and returns it. */
export function accumulateRow(
  totals: ReparseTotals,
  result: ReparseRowResult,
): ReparseTotals {
  totals.selected++;
  switch (result.kind) {
    case "archive-missing":
      totals.archiveMissing++;
      return totals;
    case "archive-read-failed":
      totals.archiveReadFailed++;
      return totals;
    case "archive-unusable":
      totals.archiveUnusable++;
      return totals;
    case "parsed":
      break;
  }
  totals.buckets[result.bucket] = (totals.buckets[result.bucket] ?? 0) + 1;
  if (result.refusal !== null) {
    totals.refusals[result.refusal] =
      (totals.refusals[result.refusal] ?? 0) + 1;
  } else if (result.bucket === "financials") {
    totals.stored++;
    if (result.projectionReset) totals.projectionReset++;
  }
  if (result.annual === "written") totals.storedAnnual++;
  else if (result.annual === "ambiguous") totals.annualAmbiguous++;
  else if (result.annual === "unreadable") totals.annualUnreadable++;
  return totals;
}

/**
 * Rows this run READ and could not turn into a stored row.
 *
 * `archiveMissing` is deliberately NOT here, and neither are `nonFinancial` or
 * `unmappedFamily`. All three are KNOWN, measured, permanent-until-something-
 * else-changes populations: ~2.1% of stored rows have no archived object, a
 * governance filing carries no financials by design, and an unmapped statement
 * family is a recorded decision in `ENTRY_POINT_KINDS`. Counting any of them as
 * a failure puts a permanent floor under this number and makes the REAL
 * failures unreadable — the mistake `bucketForOutcome` and
 * `judgeXbrlParseHealth` both already avoid.
 */
export function reparseFailedCount(totals: ReparseTotals): number {
  const bucket = (k: string) => totals.buckets[k] ?? 0;
  const refusals = Object.values(totals.refusals).reduce((a, b) => a + b, 0);
  return (
    totals.archiveUnusable +
    bucket("unparseable") +
    bucket("unknownTaxonomy") +
    bucket("noPeriod") +
    refusals +
    totals.annualUnreadable +
    totals.annualAmbiguous
  );
}

/* -------------------------------------------------------------------------- */
/* Termination                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Why the loop stopped. Every member is REACHABLE — an unreachable stop reason
 * is a stop condition nobody can test.
 */
export type ReparseStop =
  /** A page came back empty: the scoped population is exhausted. */
  | "drained"
  /** The cursor did not strictly advance. MONEY-1211's guard, made terminal. */
  | "no-advance"
  /** `--limit` reached. */
  | "limit"
  /** The wall-clock budget, checked between pages. */
  | "budget";

export interface PageProgress {
  /** Rows the page returned. */
  rowsRead: number;
  /** The cursor BEFORE this page — undefined on the first page. */
  cursorBefore: string | undefined;
  /** The cursor AFTER this page: the id of its last row. */
  cursorAfter: string | undefined;
}

export interface ReparseLoopState {
  /** Rows processed so far, including this page. */
  selected: number;
  /** `--limit`; 0 means no cap. */
  limit: number;
  elapsedMs: number;
  budgetMs: number;
}

/**
 * The one decision that makes this loop provably terminate.
 *
 * The ORDER is the design, and it mirrors `decideAfterBatch`'s:
 *
 *  1. `drained` first. An empty page is the success case and outranks a
 *     simultaneous budget or limit, which would report a PARTIAL run over
 *     finished work and send someone back to re-run a completed shard.
 *  2. `no-advance` next. It is TERMINAL and DIAGNOSTIC — it means the query
 *     handed back rows whose cursor did not move, which is MONEY-1211's defect
 *     exactly and cannot be fixed by waiting. Reporting `budget` instead would
 *     hide a live bug behind "come back later", and the run would be re-queued
 *     forever.
 *  3. The caps last. Both mean "come back later" and both print a resume
 *     cursor.
 *
 * `cursorAfter <= cursorBefore` rather than `!==`: an ObjectId cursor must
 * INCREASE, and a page that went BACKWARDS is not merely stalled, it is
 * re-reading rows this run already wrote. A non-strict comparison would let a
 * repeated last-id spin one extra page per iteration forever.
 */
export function decideAfterPage(
  state: ReparseLoopState,
  progress: PageProgress,
): ReparseStop | null {
  if (progress.rowsRead === 0) return "drained";
  if (
    progress.cursorAfter === undefined ||
    (progress.cursorBefore !== undefined &&
      progress.cursorAfter <= progress.cursorBefore)
  ) {
    return "no-advance";
  }
  if (state.limit > 0 && state.selected >= state.limit) return "limit";
  if (state.elapsedMs >= state.budgetMs) return "budget";
  return null;
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                    */
/* -------------------------------------------------------------------------- */

/** The minimum a page row must carry for the loop to do its job. */
export interface ReparsePageRow {
  id: string;
}

export interface ReparseDeps<TRow extends ReparsePageRow> {
  /**
   * One keyset page STRICTLY after `cursor`, ordered by id ascending.
   *
   * `take` is passed rather than closed over so a test can prove the limit
   * shortens the LAST page instead of over-reading it.
   */
  fetchPage: (cursor: string | undefined, take: number) => Promise<TRow[]>;
  /** Re-parse one row. Injected, so the loop is testable with no I/O at all. */
  processRow: (row: TRow) => Promise<ReparseRowResult>;
  /** Injectable clock — `Date.now` in production. */
  now: () => number;
  /** Per-page progress line. */
  onPage?: (
    pageIndex: number,
    progress: PageProgress,
    totals: ReparseTotals,
  ) => void;
  /** One line per interesting row, capped by `MAX_REPARSE_EXAMPLES`. */
  describeRow?: (row: TRow, result: ReparseRowResult) => string | null;
}

export interface ReparseOutcomeSummary {
  stop: ReparseStop;
  apply: boolean;
  totals: ReparseTotals;
  pages: number;
  elapsedMs: number;
}

/**
 * Page through the scoped rows until they are exhausted, or until the run
 * provably cannot make progress, or until a cap says stop.
 *
 * Fully injected — no Prisma, no GCS, no `Date.now`, no console — so all four
 * stop reasons are reachable from a test in milliseconds instead of only after
 * hours against a 96,000-row table. That matters more here than usual: two of
 * the four only occur at the end of a very long run, and "we will notice it in
 * prod" is how a job spins to a 24 h timeout writing nothing.
 *
 * ## The budget is checked BETWEEN pages, not mid-page
 *
 * A page is at most `MAX_PAGE` rows of read-parse-write with no external
 * pacing, so the overshoot is bounded and small. Checking mid-page would let
 * the loop stop with a cursor that points into the middle of a page, and the
 * resume cursor would then have to be a row id rather than a page boundary —
 * which it is: `totals.lastId` is updated per ROW, so a mid-page stop resumes
 * exactly where it stopped. The between-pages check is simply where the
 * DECISION is made.
 */
export async function runReparseLoop<TRow extends ReparsePageRow>(
  plan: { apply: boolean; limit: number; page: number; budgetMs: number },
  deps: ReparseDeps<TRow>,
  startCursor?: string,
): Promise<ReparseOutcomeSummary> {
  const startedAt = deps.now();
  const totals = emptyReparseTotals();
  let cursor = startCursor;
  let pages = 0;

  for (;;) {
    // Never over-read past `--limit`: a row fetched and not processed is a row
    // the resume cursor would skip.
    // A page size of 0 must never read as "limit reached" — that would report
    // a PARTIAL run over untouched work with a stop reason that names the
    // wrong cause. Clamped to at least one row.
    const pageSize = Math.max(1, plan.page);
    const remaining = plan.limit > 0 ? plan.limit - totals.selected : pageSize;
    const take = Math.max(0, Math.min(pageSize, remaining));
    if (take === 0) {
      return {
        stop: "limit",
        apply: plan.apply,
        totals,
        pages,
        elapsedMs: deps.now() - startedAt,
      };
    }

    const cursorBefore = cursor;
    const rows = await deps.fetchPage(cursorBefore, take);
    pages++;

    for (const row of rows) {
      const result = await deps.processRow(row);
      accumulateRow(totals, result);
      // Per ROW, so a mid-page stop resumes exactly where it stopped rather
      // than re-reading (and re-writing) the whole page.
      totals.lastId = row.id;
      const line = deps.describeRow?.(row, result);
      if (line && totals.examples.length < MAX_REPARSE_EXAMPLES) {
        totals.examples.push(line);
      }
    }

    const cursorAfter = rows.length > 0 ? rows[rows.length - 1]!.id : undefined;
    const progress: PageProgress = {
      rowsRead: rows.length,
      cursorBefore,
      cursorAfter,
    };
    deps.onPage?.(pages - 1, progress, totals);

    const stop = decideAfterPage(
      {
        selected: totals.selected,
        limit: plan.limit,
        elapsedMs: deps.now() - startedAt,
        budgetMs: plan.budgetMs,
      },
      progress,
    );
    if (stop) {
      return {
        stop,
        apply: plan.apply,
        totals,
        pages,
        elapsedMs: deps.now() - startedAt,
      };
    }
    cursor = cursorAfter;
  }
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

/** The shape `reportJobOutcome` is called with. Pure, so it can be asserted. */
export interface ReparseJobOutcome {
  job: string;
  selected: number;
  written: number;
  failed: number;
  transportFailures: number;
  skippedReason: string;
}

/**
 * The job-outcome payload — MONEY-1250's contract, restated for this job.
 *
 * `selected` counts rows this run TOOK ON, so it is zero exactly when the scope
 * held nothing left to re-parse. That is the property the whole zero-write
 * monitor rests on: a job that found work and produced nothing is never normal,
 * while a job that found nothing is the ordinary end of a completed shard.
 *
 * `written` is ZERO on a dry run, unconditionally, even though the rehearsal
 * runs the real write path against a no-op upsert and therefore KNOWS how many
 * rows it would have persisted. Reporting that number would put "rows written"
 * on a metric series for a run that wrote nothing — the precise lie this module
 * exists to make impossible. The rehearsal's count goes in the reason string,
 * where it is a plan rather than a measurement.
 *
 * `transportFailures` carries archive READ errors, in rows. It is separate from
 * `failed` because a storage outage is not a row that failed to persist; it is
 * a reason no decision could be made about the row at all.
 */
export function reparseJobOutcome(
  outcome: ReparseOutcomeSummary,
): ReparseJobOutcome {
  const t = outcome.totals;
  const written = outcome.apply ? t.stored + t.storedAnnual : 0;
  const measurements =
    `stop=${outcome.stop} apply=${outcome.apply} pages=${outcome.pages} ` +
    `selected=${t.selected} stored=${t.stored} storedAnnual=${t.storedAnnual} ` +
    `projectionReset=${t.projectionReset} ` +
    `archiveMissing=${t.archiveMissing} ` +
    `archiveReadFailed=${t.archiveReadFailed} ` +
    `archiveUnusable=${t.archiveUnusable} ` +
    `buckets=${JSON.stringify(t.buckets)} ` +
    `refusals=${JSON.stringify(t.refusals)} ` +
    `annualAmbiguous=${t.annualAmbiguous} ` +
    `annualUnreadable=${t.annualUnreadable} ` +
    `lastId=${t.lastId ?? "-"}`;
  return {
    job: "xbrl-reparse",
    selected: t.selected,
    written,
    failed: reparseFailedCount(t),
    transportFailures: t.archiveReadFailed,
    skippedReason: outcome.apply
      ? measurements
      : `DRY RUN — nothing was written; ${t.stored + t.storedAnnual} row(s) ` +
        `would have been. ${measurements}`,
  };
}

/** The identity a sample line needs: which row, in a form an operator can act on. */
export interface ReparseRowIdentity {
  symbol: string;
  periodType: string;
  periodEnd: Date;
  sourceUrl: string;
}

/**
 * A sample line for a row that did NOT end in two clean writes, or null.
 *
 * The counters carry the VOLUME; these carry the ADDRESS. Every branch that
 * reaches `failed` or `archiveMissing` names a row, because the remedy for each
 * is different and none of them is derivable from a number: an
 * `unknownTaxonomy` is a table entry in `xbrl-financials-logic.ts`, an
 * `archive-missing` is a prod-only `xbrl-backfill --archive-existing` fetch, an
 * `archive-unusable` is a poisoned object in GCS.
 *
 * Pure, and here rather than inline in the job, because the first version
 * returned null for EVERY parse bucket — so a run could report a non-zero
 * `failed` with an empty examples list and nowhere to start. That is a
 * one-line omission with no other symptom, which is exactly the kind that
 * belongs behind a test.
 */
export function describeReparseRow(
  row: ReparseRowIdentity,
  result: ReparseRowResult,
): string | null {
  const at = `${row.symbol} ${row.periodType} ${row.periodEnd
    .toISOString()
    .slice(0, 10)}`;
  switch (result.kind) {
    case "archive-missing":
      return `${at} — no archived XML (${row.sourceUrl})`;
    case "archive-read-failed":
      return `${at} — archive read FAILED (not evidence of absence)`;
    case "archive-unusable":
      return `${at} — archived object is not a document (${row.sourceUrl})`;
    case "parsed":
      break;
  }
  if (result.refusal !== null) {
    return `${at} — parsed, store refused: ${result.refusal}`;
  }
  if (result.bucket !== "financials") {
    return `${at} — ${result.bucket} (${row.sourceUrl})`;
  }
  if (result.annual === "ambiguous" || result.annual === "unreadable") {
    return `${at} — primary written, ANNUAL companion ${result.annual}`;
  }
  // Two clean writes (or a document that legitimately has no annual
  // companion). Nothing to report.
  return null;
}

/** One human summary line. */
export function describeReparseOutcome(outcome: ReparseOutcomeSummary): string {
  const t = outcome.totals;
  const verb = outcome.apply ? "wrote" : "WOULD write";
  return (
    `stop=${outcome.stop} apply=${outcome.apply} pages=${outcome.pages} ` +
    `selected ${t.selected}, ${verb} ${t.stored} primary + ${t.storedAnnual} ` +
    `annual, facts CHANGED on ${t.projectionReset}, ` +
    `archive-missing ${t.archiveMissing}, ` +
    `archive-read-failed ${t.archiveReadFailed}, ` +
    `archive-unusable ${t.archiveUnusable}, failed ${reparseFailedCount(t)}, ` +
    `elapsed ${Math.round(outcome.elapsedMs / 1000)}s`
  );
}

/**
 * What the operator has to do next, in the stop reason's own vocabulary.
 *
 * A partial run that does not print its resume cursor is a partial run somebody
 * restarts from the beginning — re-reading and re-writing everything it already
 * did. Every non-`drained` reason therefore names `--after-id`.
 */
export function describeReparseStop(outcome: ReparseOutcomeSummary): string {
  const t = outcome.totals;
  const resume =
    t.lastId === null
      ? "Nothing was processed, so there is no cursor to resume from."
      : `Resume with --after-id=${t.lastId}.`;
  switch (outcome.stop) {
    case "drained":
      return t.selected === 0
        ? "DRAINED — the scope held no rows. Nothing to do."
        : `DRAINED — every row in scope was re-parsed. ${
            outcome.apply
              ? "Re-run the projection so the corrected facts reach " +
                "stock_financials: the write path cleared projectedAt on the " +
                `${t.projectionReset} row(s) whose facts changed.`
              : "This was a DRY RUN — nothing was written."
          }`;
    case "limit":
      // Says "exits 0" out loud — MONEY-1250. This is the ONE stop reason whose
      // task goes green while the scope is still full, so the line has to carry
      // the whole claim: bounded BY REQUEST, not drained, and here is the
      // cursor. A reader who sees only the green tick must still be told.
      return (
        `PARTIAL — stopped on --limit after ${t.selected} row(s), which is ` +
        `exactly what --limit asked for. The scope is NOT drained; this is a ` +
        `bounded rehearsal, so the task exits 0. ${resume}`
      );
    case "budget":
      return (
        `PARTIAL — stopped on the wall-clock budget, which nobody asked for: ` +
        `the scope needs more runs than planned, so the task exits NON-ZERO. ` +
        `${resume}`
      );
    case "no-advance":
      return (
        `NO-ADVANCE — a page returned rows whose cursor did not increase, so ` +
        `the next page would repeat this one (MONEY-1211). This is a DEFECT ` +
        `in the page query, not a "come back later". ${resume}`
      );
  }
}

/**
 * 0 for a run that did what it was ASKED to do with nothing unexplained.
 *
 * `archiveMissing` deliberately does NOT fail the run. It is a measured 2.1% of
 * stored rows (94,012 of 96,056 archived, 2026-08-25) that this job cannot
 * close by design — closing it needs NSE traffic, which is `xbrl-backfill.ts
 * --archive-existing`'s job, on prod. A red exit on a permanent, known,
 * un-actionable condition is how people stop reading task status; the WARN line
 * names the remedy instead.
 *
 * ## `--limit` is a REQUESTED bound, and requested bounds are not failures
 *
 * MONEY-1250. `stop !== "drained"` used to be an unconditional 1, so every
 * `--limit` rehearsal — the path `setup-xbrl-reparse-job.sh` documents as the
 * FIRST thing an operator runs, twice, before applying anything — exited
 * non-zero. Measured on prod 2026-08-26: **7 of the day's 9 executions read as
 * FAILED**, all of them healthy bounded runs. That is the same self-inflicted
 * wound as the paragraph above, one level up: a status that is red on the
 * normal path is a status nobody reads, and it takes the REAL failures down
 * with it.
 *
 * ## Why 0 and not a distinct PARTIAL code
 *
 * A "PARTIAL exit 2" was the obvious answer and it does not work, because the
 * consumer is Cloud Run Jobs: a task succeeds on exit 0 and FAILS on every
 * other code. 2 is indistinguishable from 1 to the platform — same red task,
 * same `failedCount` tick, same alert — so it would rename the problem inside
 * the container log and change nothing an operator or a monitor can see.
 *
 * The exit code answers "did the run do what it was asked to do?", not "is the
 * scope drained?". `--limit=N` is an explicit argument; a run that processed N
 * rows honoured it exactly. Completeness is a DIFFERENT question, and it is
 * answered where it can carry detail: `describeReparseStop` says PARTIAL and
 * names the resume cursor, and `stop=` rides in the job-outcome's own
 * `skippedReason`.
 *
 * Every genuine failure stays red REGARDLESS of the stop reason — the three
 * checks below are evaluated for a `--limit` run exactly as for a drained one,
 * so a bounded run that hit read errors, store failures, or a totally
 * unreadable archive still exits 1.
 *
 * `budget` and `no-advance` also stay red, and the distinction is deliberate:
 * nobody REQUESTED them. A budget stop means the scope needs more runs than the
 * operator planned; `no-advance` is an outright defect in the page query
 * (MONEY-1211). Both need a human; `--limit` does not.
 */
export function reparseExitCode(outcome: ReparseOutcomeSummary): 0 | 1 {
  if (outcome.stop !== "drained" && outcome.stop !== "limit") return 1;
  if (outcome.totals.archiveReadFailed > 0) return 1;
  if (reparseFailedCount(outcome.totals) > 0) return 1;
  // TOTAL miss is not a data condition — it is a BROKEN ARCHIVE.
  //
  // The paragraph above is right that a permanent 2.1% must not paint the run
  // red. But "archiveMissing never fails" leaves the run exiting 0 when EVERY
  // row missed, which is what a wrong `GCP_STORAGE_BUCKET`, a moved prefix or a
  // revoked read grant look like — a config-explained zero reporting success,
  // the exact class MONEY-1250 spent itself removing from the F3 gate.
  //
  // The ceiling is ALL-OF-A-NON-EMPTY-SCOPE rather than a percentage, and that
  // is deliberate: the known gap is not uniform (100% archived for period-years
  // 2017-2025, ~70% for 2026), so any percentage threshold either false-fails a
  // legitimately-2026-scoped run or sits too high to catch anything. "Not one
  // object of N was readable" cannot be a property of the data.
  if (
    outcome.totals.selected > 0 &&
    outcome.totals.archiveMissing === outcome.totals.selected
  ) {
    return 1;
  }
  return 0;
}
