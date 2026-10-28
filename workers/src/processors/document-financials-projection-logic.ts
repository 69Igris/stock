/**
 * `document_financial_extracts` → `StockFinancials`, the WRITE side —
 * MONEY-1255.
 *
 * The extraction job stores one model's reading of one PDF.
 * `document-financials-projection.ts` (core) turns a reading into the flat
 * reader shape and decides who outranks whom.
 * `scripts/data/doc-financials-reconcile.ts` produces the evidence. This file
 * is the one that actually moves product data, and it is the only irreversible
 * step in the pipeline.
 *
 * ## The constraint that shapes every decision below
 *
 * `StockFinancials` is `@@unique([symbol, exchange, statementType, periodType,
 * period])` — **no `source` in the key**. Two sources describing one period are
 * one row. So the moment this job writes a period, whatever was there is gone
 * and there is nothing left to reconcile against. Four defaulted-off interlocks
 * follow from that, and each is a switch rather than a comment asking the next
 * person to be careful:
 *
 *  1. **`apply` defaults to FALSE**, and only the ENVIRONMENT can arm it. The
 *     job plans, counts and reports; it writes nothing.
 *  2. **`requireGraded` is TRUE and is not overridable from a message.** An
 *     extract the reconcile has not graded cannot be written, because the
 *     comparison cannot be made afterwards.
 *  3. **`createMissing` defaults to FALSE.** Creates are the POINT of this
 *     pipeline — ~821 symbols hold zero rows, so for that cohort every write is
 *     a create — and that is exactly why the default does not change: a
 *     100%-create run is ALSO the precise signature of a `periodLabel` join
 *     bug, where our derivation of the incumbent's period label is wrong and
 *     every period looks like new ground. Coverage gain is a deliberate,
 *     scoped, opt-in step; the reconcile's CEILING check is what tells the two
 *     apart before it is taken.
 *  4. **Everything displaced is preserved in the row that displaced it**,
 *     written exactly once.
 *
 * ## The cursor, and the bug it must not reproduce
 *
 * Selection takes only extracts this job has not yet DECIDED about
 * (`UNPROJECTED_EXTRACT_WHERE`) and stamping `projectedAt` is what removes a
 * row from the next run's population. Without that filter this job is
 * MONEY-1211 again: a constant ordering over a table that only grows at the end
 * hands every run the same first N rows forever — written once, then skipped
 * nightly, while 681 of 781 symbols are never selected at all. No error, no
 * alert, no data.
 *
 * **The stamp is computed AFTER the write outcome is known.** The XBRL writer
 * filled its decided-set for a whole symbol group BEFORE any statement was
 * written, and its CREATE branch returned without recording a failure — so a
 * create-suppressed filing was recorded as decided having produced nothing.
 * Armed, that burns a page per night into stamped-never-created, and the later
 * deliberate pilot then selects none of them, recoverable only by a hand
 * `$unset`. Here `DECIDED`/`NOT_DECIDED` is a RETURNED VALUE from the function
 * that performed (or declined) the write, so a branch added later cannot
 * silently inherit "decided" — the compiler asks.
 *
 * ## Why the read is SYMBOL-MAJOR and not `projectedAt`-major
 *
 * A period legitimately has SEVERAL extract rows — both bases, plus one per
 * document that mentioned the period — and `StockFinancials` has room for one.
 * `selectExtractForPeriod` is only correct over the rows a run can SEE: with
 * half a period's extracts, a STANDALONE reading can win a period whose
 * CONSOLIDATED sibling was simply not read, and a holding company's standalone
 * numbers differ from its consolidated ones by a MULTIPLE.
 *
 * Ordering by `periodEnd` would not fix that — both bases of one period share a
 * `periodEnd`, and so do hundreds of other symbols with the same March year
 * end, so a page cut would fall inside a date block spanning the whole
 * universe. Symbol-major means a cut can only fall inside ONE symbol, which
 * {@link dropPartialTrailingSymbol} then defers. The `projectedAt` FILTER is
 * what advances the batch; the ordering only has to keep periods whole.
 */

import prisma, { Prisma } from "@usemoney/database";
import { periodLabel } from "@usemoney/core/market-data";
import {
  docOwnedFields,
  planDocumentFinancialsWrite,
  projectDocumentExtract,
  selectExtractForPeriod,
  DOC_ALL_FIELDS,
  DOC_SOURCE,
  type DocIncumbentRow,
  type DocProjectedStatement,
  type DocSkipReason,
  type DocStatementType,
  type DocumentExtractReading,
} from "@usemoney/core/market-data/document-financials-projection";

const logger = {
  info: (data: unknown, msg: string) =>
    console.log(`[document-financials-projection] ${msg}`, data),
  warn: (data: unknown, msg: string) =>
    console.warn(`[document-financials-projection] ${msg}`, data),
  error: (data: unknown, msg: string) =>
    console.error(`[document-financials-projection] ${msg}`, data),
};

type Db = typeof prisma;

/**
 * Extracts this job has not yet decided about.
 *
 * `{ projectedAt: null }` ALONE MATCHES NOTHING ON MONGO for a column added
 * after rows were written: a `prisma db push` creates INDEXES, never FIELDS, so
 * the attribute is ABSENT rather than null and Prisma's Mongo connector does
 * not treat the two as the same. Both `{f: null}` and `{f: {not: null}}` return
 * ZERO. This class has caused MONEY-1050, MONEY-1205, MONEY-1234 and
 * MONEY-1236; the `isSet: false` arm is what stops it causing a fifth, and it
 * is the difference between this job selecting its whole backlog and selecting
 * nothing at all while reporting a clean run.
 */
export const UNPROJECTED_EXTRACT_WHERE = {
  OR: [{ projectedAt: null }, { projectedAt: { isSet: false } }],
} as const;

/** Extract rows read per PAGE. Pure DB + arithmetic; the ack deadline is 600s. */
export const DEFAULT_PAGE_SIZE = 500;

/** Pages one run will read before handing the rest to the next run. */
export const DEFAULT_MAX_PAGES = 20;

/**
 * Wall-clock budget for one run, well under the 600s Pub/Sub ack deadline.
 *
 * A handler that runs past 600s is not merely slow: Pub/Sub treats the message
 * as unacked and REDELIVERS it, so a second copy of the same job starts
 * concurrently — doubling the work and potentially looping, since
 * `minimumBackoff` is 10s. 420s leaves 3 minutes of headroom for the final
 * stamp and the outcome report.
 */
export const DEFAULT_BUDGET_MS = 420_000;

/** Examples kept in the result. A capped list must say it is capped. */
const MAX_EXAMPLES = 40;

/**
 * The `document_financial_extracts` columns this job reads.
 *
 * The value columns are DERIVED from `DOC_ALL_FIELDS` — the same constant
 * `docOwnedFields()` gives the planner and the reconcile derives its own select
 * from. A column missing from a hand-maintained select comes back `undefined`,
 * which reads as "the extract has no value" and is written as an explicit NULL
 * over whatever was there. That is the MONEY-1250 shape, one layer down.
 */
const EXTRACT_SELECT = {
  id: true,
  documentId: true,
  instrumentId: true,
  symbol: true,
  exchange: true,
  fiscalYear: true,
  periodEnd: true,
  periodType: true,
  basis: true,
  status: true,
  reconcileVerdict: true,
  model: true,
  promptVersion: true,
  confidence: true,
  scaleLabel: true,
  scaleFactor: true,
  extractedAt: true,
  ...Object.fromEntries(DOC_ALL_FIELDS.map((f) => [f, true])),
} as const;

/**
 * The `StockFinancials` columns the planner reads.
 *
 * `source`, `fetchedAt`, `rawData` and `basis` feed the authority and basis
 * guards; the value columns are what a displacement record must capture and
 * what the UNCHANGED check compares. Omitting one makes `incumbentValues` read
 * `undefined`, the UNCHANGED check see a difference that is not there, and the
 * row be rewritten on every nightly pass forever.
 */
const INCUMBENT_SELECT = {
  symbol: true,
  exchange: true,
  statementType: true,
  periodType: true,
  period: true,
  source: true,
  fetchedAt: true,
  rawData: true,
  basis: true,
  ...Object.fromEntries(DOC_ALL_FIELDS.map((f) => [f, true])),
} as const;

const STATEMENTS: readonly DocStatementType[] = [
  "INCOME",
  "BALANCE_SHEET",
  "CASH_FLOW",
];

export interface DocProjectionWriteOptions {
  symbols?: string[];
  periodTypes?: Array<"ANNUAL" | "QUARTERLY">;
  /** Rows per page. */
  limit?: number;
  /** Pages one run will read. */
  maxPages?: number;
  /** Wall-clock budget, ms. */
  budgetMs?: number;
  /**
   * WRITE. Defaults to false: the run plans, counts, reports and touches
   * nothing. Only the environment can set this true — see the job wrapper.
   */
  apply?: boolean;
  /** Also create rows that have no incumbent. Defaults to FALSE — see header. */
  createMissing?: boolean;
  /**
   * Consider only extracts this job has not already decided about. The job
   * wrapper always passes true; a value of false exists for a scoped operator
   * re-run over rows that are already stamped.
   */
  unprojectedOnly?: boolean;
  /** Keyset cursor — resume after this symbol. Intra-run paging uses it too. */
  afterSymbol?: string;
  /** Injectable clock, so `displacedAt` and `projectedAt` are deterministic. */
  now?: Date;
}

export interface DocProjectionWriteResult {
  ok: boolean;
  apply: boolean;
  createMissing: boolean;
  /** Extract rows read, across every page of this run. */
  extractsRead: number;
  pagesRead: number;
  /** True when the run stopped on its page/time budget rather than the data. */
  drained: boolean;
  /** Resume point for the next run. Null when the run drained. */
  nextAfterSymbol: string | null;
  /** Ran out of wall-clock budget rather than pages. */
  budgetExhausted: boolean;
  /**
   * Rows held back because a page ended mid-symbol. Processing them would let a
   * STANDALONE reading win a period whose CONSOLIDATED sibling fell outside the
   * page — a wrong number, silently, from a paging artefact.
   */
  deferredByPagination: number;
  /** Distinct (symbol, exchange, periodType, period) rows addressed. */
  periods: number;
  /** Extracts that lost their period to a sibling. */
  supersededSiblings: number;
  /** Statements with at least one sourced value. */
  statementsProjected: number;
  /** Extracts that sourced NO owned column at all — nothing to write. */
  emptyExtracts: number;
  created: number;
  updated: number;
  /** Updates that replaced a DIFFERENT source and recorded what they replaced. */
  displaced: number;
  /** Per-reason skips, straight from the planner's own vocabulary. */
  skipped: Record<DocSkipReason, number>;
  /** Would have created, but the extract has no resolved instrument. */
  skippedNoInstrument: number;
  /** Would have created, but `createMissing` is off. */
  skippedCreateSuppressed: number;
  failed: number;
  /** Extracts this run would advance the `projectedAt` cursor for. */
  stampAttempted: number;
  /** Extracts the cursor actually advanced for — read back, never assumed. */
  stamped: number;
  stampFailed: boolean;
  examples: string[];
  examplesTruncated: boolean;
}

function emptySkips(): Record<DocSkipReason, number> {
  return {
    AUTHORITY: 0,
    UNCHANGED: 0,
    BASIS_DOWNGRADE: 0,
    STANDALONE_NO_DISPLACE: 0,
    NOT_EXTRACTED: 0,
    NOT_GRADED: 0,
    VERDICT_BLOCKS: 0,
    NO_VALUES: 0,
  };
}

/**
 * Drop the trailing symbol when a page hit its limit.
 *
 * Rows are read `symbol asc`, so a truncated page can only cut INSIDE the last
 * symbol. Every other symbol in the page is complete, and completeness per
 * symbol is what `selectExtractForPeriod` needs to be correct: with half a
 * symbol's extracts a STANDALONE reading can win a period whose CONSOLIDATED
 * sibling was simply not read. Deferring the partial symbol costs one run's
 * coverage; keeping it costs a wrong number that looks fine.
 *
 * Generic twin of `dropPartialTrailingSymbol` in `xbrl-projection-writer.ts`,
 * which is typed to that file's own `FilingRow`. The INVARIANT is identical and
 * so is the escape hatch below; if either changes, both must.
 */
export function dropPartialTrailingSymbol<T extends { symbol: string }>(
  rows: readonly T[],
): { kept: T[]; deferred: number } {
  if (rows.length === 0) return { kept: [], deferred: 0 };
  const lastSymbol = rows[rows.length - 1]!.symbol;
  const kept = rows.filter((r) => r.symbol !== lastSymbol);
  // Every row belongs to ONE symbol: keeping nothing would stall this cursor
  // forever, so the page is used as-is and the caller widens the limit instead.
  if (kept.length === 0) return { kept: [...rows], deferred: 0 };
  return { kept, deferred: rows.length - kept.length };
}

/** The row key an extract projects into. */
function groupKey(
  symbol: string,
  exchange: string,
  periodType: string,
  period: string,
): string {
  return `${symbol}|${exchange}|${periodType}|${period}`;
}

function incumbentKey(
  symbol: string,
  exchange: string,
  statementType: string,
  periodType: string,
  period: string,
): string {
  return `${symbol}|${exchange}|${statementType}|${periodType}|${period}`;
}

/**
 * Whether one statement's outcome is a PERMANENT decision about its extract.
 *
 * A RETURNED VALUE rather than something the caller infers, because the caller
 * cannot see which branch ran: a create-suppressed statement and a
 * skipped-unchanged one both leave the store untouched and both increment a
 * counter, and only one of them is a decision. Making it a value also means a
 * branch added below cannot silently inherit "decided" — the compiler asks.
 */
type StatementDecision = "DECIDED" | "NOT_DECIDED" | "FAILED";

export async function processDocumentFinancialsProjectionWrite(
  opts: DocProjectionWriteOptions = {},
  deps: { prisma?: Db } = {},
): Promise<DocProjectionWriteResult> {
  const db = deps.prisma ?? prisma;
  const now = opts.now ?? new Date();
  const apply = opts.apply === true;
  const createMissing = opts.createMissing === true;
  const pageSize = Math.max(1, Math.min(5000, opts.limit ?? DEFAULT_PAGE_SIZE));
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
  const budgetMs = Math.max(1_000, opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const startedAt = Date.now();

  const out: DocProjectionWriteResult = {
    ok: true,
    apply,
    createMissing,
    extractsRead: 0,
    pagesRead: 0,
    drained: false,
    nextAfterSymbol: null,
    budgetExhausted: false,
    deferredByPagination: 0,
    periods: 0,
    supersededSiblings: 0,
    statementsProjected: 0,
    emptyExtracts: 0,
    created: 0,
    updated: 0,
    displaced: 0,
    skipped: emptySkips(),
    skippedNoInstrument: 0,
    skippedCreateSuppressed: 0,
    failed: 0,
    stampAttempted: 0,
    stamped: 0,
    stampFailed: false,
    examples: [],
    examplesTruncated: false,
  };

  const note = (line: string): void => {
    if (out.examples.length < MAX_EXAMPLES) out.examples.push(line);
    else out.examplesTruncated = true;
  };

  const baseWhere: Record<string, unknown> = {
    // FAILED and FAILED_VALIDATION are not readings. The planner refuses them
    // too (`NOT_EXTRACTED`); filtering here as well keeps them out of the page
    // budget entirely rather than spending a page proving they are unusable.
    status: "EXTRACTED",
    ...(opts.symbols?.length ? { symbol: { in: opts.symbols } } : {}),
    ...(opts.periodTypes?.length
      ? { periodType: { in: opts.periodTypes } }
      : {}),
    ...(opts.unprojectedOnly === false ? {} : UNPROJECTED_EXTRACT_WHERE),
  };

  let cursorSymbol = opts.afterSymbol ?? null;

  for (let page = 0; page < maxPages; page++) {
    if (Date.now() - startedAt > budgetMs) {
      out.budgetExhausted = true;
      break;
    }

    const rows = (await db.documentFinancialExtract.findMany({
      where: {
        ...baseWhere,
        ...(cursorSymbol ? { symbol: { gt: cursorSymbol } } : {}),
      } as never,
      // SYMBOL-MAJOR — see the file header. `basis` and `id` complete a TOTAL
      // order so a page boundary is a function of the data and not of whatever
      // order the store happened to return.
      orderBy: [
        { symbol: "asc" },
        { periodEnd: "desc" },
        { basis: "asc" },
        { id: "asc" },
      ],
      take: pageSize,
      select: EXTRACT_SELECT,
    })) as unknown as DocumentExtractReading[];

    if (rows.length === 0) {
      out.drained = true;
      break;
    }
    out.pagesRead++;

    const truncated = rows.length === pageSize;
    const { kept, deferred } = truncated
      ? dropPartialTrailingSymbol(rows)
      : { kept: [...rows], deferred: 0 };
    out.deferredByPagination += deferred;
    out.extractsRead += kept.length;

    // The cursor advances to the last KEPT symbol. The deferred trailing symbol
    // is therefore re-read by the NEXT page of this same run (or the next run),
    // whole — which is the entire point of deferring it.
    const lastKept = kept[kept.length - 1];
    cursorSymbol = lastKept ? lastKept.symbol : cursorSymbol;

    await processPage({
      db,
      rows: kept,
      apply,
      createMissing,
      now,
      out,
      note,
    });

    // A page that was NOT truncated has reached the end of the population under
    // the current cursor. Anything after it would be an empty read.
    if (!truncated) {
      out.drained = true;
      break;
    }
  }

  out.nextAfterSymbol = out.drained ? null : cursorSymbol;
  // `ok` is the WRITER's judgement and nothing above it may hardcode it. A
  // completeness signal computed at the wrong granularity, or overwritten one
  // layer up, is the defect this repo has now shipped six times (MONEY-1189 /
  // MONEY-1238).
  out.ok = out.failed === 0;

  if (!out.drained) {
    logger.warn(
      {
        pagesRead: out.pagesRead,
        nextAfterSymbol: out.nextAfterSymbol,
        budgetExhausted: out.budgetExhausted,
      },
      "run did NOT drain — the rest of the population was not read. It is not " +
        "lost: unstamped rows are re-selected, and `nextAfterSymbol` resumes " +
        "this run's page order. But a run that never drains is a run whose tail " +
        "is only ever reached by the cursor filter, so watch this alongside " +
        "`stamped`.",
    );
  }
  if (!apply) {
    logger.warn(
      { wouldCreate: out.created, wouldUpdate: out.updated },
      "DRY RUN — nothing was written and nothing was stamped. Pass apply only " +
        "with a reconcile report whose CEILING check passed.",
    );
  }
  logger.info(out, "done");
  return out;
}

async function processPage(args: {
  db: Db;
  rows: readonly DocumentExtractReading[];
  apply: boolean;
  createMissing: boolean;
  now: Date;
  out: DocProjectionWriteResult;
  note: (line: string) => void;
}): Promise<void> {
  const { db, rows, apply, createMissing, now, out, note } = args;

  // ── Group into periods ─────────────────────────────────────────────
  //
  // `periodLabel` is IMPORTED, never redefined. This job performs the WRITE and
  // `doc-financials-reconcile.ts` produced the EVIDENCE, and both address a
  // `StockFinancials` row by the same derived label. Two copies means a fix to
  // one silently changes which rows the other looks at — the evidence would
  // then describe a different set of rows than the write touches, and nothing
  // would error.
  const groups = new Map<
    string,
    {
      target: { periodType: "ANNUAL" | "QUARTERLY"; period: string };
      rows: DocumentExtractReading[];
    }
  >();
  for (const r of rows) {
    const periodType = r.periodType === "QUARTERLY" ? "QUARTERLY" : "ANNUAL";
    const period = periodLabel(r.periodEnd, periodType);
    const key = groupKey(r.symbol, r.exchange, periodType, period);
    const g = groups.get(key);
    if (g) g.rows.push(r);
    else groups.set(key, { target: { periodType, period }, rows: [r] });
  }
  out.periods += groups.size;

  // ── One batched incumbent read for the whole page ──────────────────
  //
  // NOT a `findUnique` per statement. Three lookups per period is the N+1 that
  // made the XBRL gate un-runnable — measured at 6h20m elapsed, 0.0% CPU,
  // killed unfinished.
  const symbols = [...new Set(rows.map((r) => r.symbol))];
  const incumbents = new Map<string, DocIncumbentRow>();
  const CHUNK = 200;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const found = await db.stockFinancials.findMany({
      where: {
        symbol: { in: symbols.slice(i, i + CHUNK) },
        statementType: { in: [...STATEMENTS] },
      },
      select: INCUMBENT_SELECT,
    });
    for (const f of found) {
      incumbents.set(
        incumbentKey(
          f.symbol,
          f.exchange,
          f.statementType,
          f.periodType,
          f.period,
        ),
        f as unknown as DocIncumbentRow,
      );
    }
  }

  /** Extracts this page reached a DECISION about. Filled AFTER the writes. */
  const decidedIds = new Set<string>();

  for (const [key, group] of groups) {
    const winner = selectExtractForPeriod(group.rows);
    if (!winner) continue;
    out.supersededSiblings += group.rows.length - 1;

    const statements = projectDocumentExtract(winner);
    out.statementsProjected += statements.length;
    if (statements.length === 0) {
      // Nothing sourced anywhere in the extract. That is a permanent property
      // of the ROW — the extract is never rewritten — so it IS a decision, and
      // leaving it unstamped would re-read it nightly forever.
      out.emptyExtracts++;
      out.skipped.NO_VALUES++;
      note(`NO-VALUES ${key} (extract ${winner.id})`);
      for (const r of group.rows) decidedIds.add(r.id);
      continue;
    }

    let groupDecision: StatementDecision = "DECIDED";
    for (const statement of statements) {
      let decision: StatementDecision;
      try {
        decision = await writeOneStatement({
          db,
          apply,
          createMissing,
          now,
          winner,
          statement,
          target: group.target,
          incumbent:
            incumbents.get(
              incumbentKey(
                winner.symbol,
                winner.exchange,
                statement.statementType,
                group.target.periodType,
                group.target.period,
              ),
            ) ?? null,
          out,
          note,
        });
      } catch (error) {
        // One bad row never aborts the run. It also never advances the cursor:
        // a per-row failure is the one outcome that might succeed next time
        // with no new bytes.
        out.failed++;
        decision = "FAILED";
        logger.warn({ error, key }, "statement write failed");
      }
      // WORST WINS. A single NOT_DECIDED or FAILED statement holds the whole
      // extract back, because stamping it would record the extract as decided
      // having produced only part of what it should.
      if (decision === "FAILED") groupDecision = "FAILED";
      else if (decision === "NOT_DECIDED" && groupDecision !== "FAILED") {
        groupDecision = "NOT_DECIDED";
      }
    }

    // STAMPED ONLY NOW, and only on a clean decision — the whole point of the
    // schema's warning. The whole GROUP is stamped together: a sibling that
    // LOST its period will lose it again on every future run, and stamping the
    // winner alone would leave a STANDALONE loser to form a group of ONE on the
    // next run and win it trivially. (The planner's BASIS_DOWNGRADE guard is
    // defence in depth for the same case arriving late.)
    if (groupDecision === "DECIDED") {
      for (const r of group.rows) decidedIds.add(r.id);
    }
  }

  // ── Advance the cursor ─────────────────────────────────────────────
  //
  // Only when `apply` — a dry run must leave no trace, or the first armed run
  // would skip everything a rehearsal had already "decided".
  if (apply && decidedIds.size > 0) {
    const ids = [...decidedIds];
    out.stampAttempted += ids.length;
    try {
      // THE RESULT IS READ. A stamp that silently matched zero rows is
      // otherwise indistinguishable from one that moved the whole page: the run
      // reports written/failed/ok identically either way, and the next night
      // re-reads and re-writes this exact page. Forever.
      const res = await db.documentFinancialExtract.updateMany({
        where: { id: { in: ids } },
        data: { projectedAt: now },
      });
      out.stamped += res.count;
      if (res.count < ids.length) {
        logger.warn(
          { attempted: ids.length, stamped: res.count },
          "projectedAt stamp matched FEWER rows than it named — the cursor did " +
            "not fully advance and those extracts return on the next run",
        );
      }
    } catch (error) {
      // A cursor that fails to advance costs a repeated read, never a wrong
      // number, so it must not fail a run that has already written correct
      // rows. It is COUNTED rather than living only in a warning nobody queries.
      out.stampFailed = true;
      logger.warn({ error, count: ids.length }, "projectedAt stamp failed");
    }
  }
}

async function writeOneStatement(args: {
  db: Db;
  apply: boolean;
  createMissing: boolean;
  now: Date;
  winner: DocumentExtractReading;
  statement: DocProjectedStatement;
  target: { periodType: "ANNUAL" | "QUARTERLY"; period: string };
  incumbent: DocIncumbentRow | null;
  out: DocProjectionWriteResult;
  note: (line: string) => void;
}): Promise<StatementDecision> {
  const { db, winner, statement, target, incumbent, out, note } = args;

  const where = {
    symbol: winner.symbol,
    exchange: winner.exchange,
    statementType: statement.statementType,
    periodType: target.periodType,
    period: target.period,
  };
  const label =
    `${winner.symbol} ${target.periodType} ${target.period} ` +
    `${statement.statementType}`;

  const plan = planDocumentFinancialsWrite({
    reading: winner,
    statement,
    incumbent,
    now: args.now,
    // NOT overridable from a message. Loosening the interlock that makes the
    // reconcile a precondition is a deploy, which is a review.
    requireGraded: true,
  });

  if (plan.action === "SKIP") {
    // On the VALUE, never on the prose. Matching `reason` text would silently
    // reclassify every skip the day somebody rewords a message, into whichever
    // bucket the match falls through to.
    const reason = plan.skipReason;
    if (reason) out.skipped[reason]++;
    if (reason === "VERDICT_BLOCKS" || reason === "NOT_EXTRACTED") {
      note(`SKIP-${reason} ${label}: ${plan.reason}`);
    }
    // NOT_GRADED is the ONLY skip that is not a decision. Every other one is a
    // property of the extract or of a row that outranks it, and will return the
    // same verdict for as long as both stand. `NOT_GRADED` flips the moment the
    // reconcile runs, with nothing new arriving from the extractor — stamping
    // it would burn the row on a verdict about the RUN's configuration rather
    // than about the data, which is precisely the create-suppression shape.
    return reason === "NOT_GRADED" ? "NOT_DECIDED" : "DECIDED";
  }

  if (plan.action === "CREATE") {
    if (!args.createMissing) {
      // NOT a decision. `createMissing` is a switch on the message, so this
      // verdict describes the RUN and not the extract. Stamping it burns a page
      // per night into stamped-never-created, and the later deliberate pilot
      // then selects none of them — recoverable only by a hand `$unset`.
      out.skippedCreateSuppressed++;
      return "NOT_DECIDED";
    }
    if (!winner.instrumentId) {
      // `StockFinancials.instrumentId` is a required FK. Counted on its own
      // line because folding it into a general "skipped" would hide a mapping
      // gap behind a number that also means "deliberately not created". Also
      // NOT a decision: `instrument-sync` fills that gap on its own schedule.
      out.skippedNoInstrument++;
      note(`NO-INSTRUMENT ${label} (extract ${winner.id})`);
      return "NOT_DECIDED";
    }
    note(`CREATE ${label}`);
    // COUNTED AFTER THE WRITE RESOLVES. The increment above an `await` makes a
    // statement whose call REJECTED count as written AND as failed — an
    // arithmetically impossible outcome that inflates `job.written`, which is
    // the exact series a zero-write monitor keys on. The dry run still counts,
    // because it performs no write and therefore cannot fail: what it reports
    // is what WOULD land.
    if (args.apply) {
      await db.stockFinancials.create({
        data: {
          instrumentId: winner.instrumentId,
          ...where,
          // Owned columns the extract did not source arrive here as explicit
          // NULLs — "not disclosed", never 0.
          ...(plan.values ?? {}),
          // The REAL date, not just the label. `periodEnd` is nullable and a
          // writer that leaves it null makes the
          // `[symbol, exchange, statementType, periodType, periodEnd desc]`
          // index cover nothing for exactly the rows it created, and leaves
          // chronology resting entirely on a free-text label that does not sort.
          periodEnd: winner.periodEnd,
          // CONSOLIDATED or STANDALONE on the row itself, for READERS. It is
          // already in `rawData.doc.extract.basis`, which is what the guards
          // read; this column exists so the Financials tab and the research
          // tools can tell the group from the parent without parsing JSON.
          basis: winner.basis,
          source: plan.source ?? DOC_SOURCE,
          rawData: plan.rawData as unknown as Prisma.InputJsonValue,
          fetchedAt: args.now,
        } as Prisma.StockFinancialsUncheckedCreateInput,
      });
    }
    out.created++;
    return "DECIDED";
  }

  if (plan.displaced) {
    note(`DISPLACE ${label}: ${plan.displaced.displacedSource} → ${DOC_SOURCE}`);
  }
  if (args.apply) {
    await db.stockFinancials.update({
      where: { symbol_exchange_statementType_periodType_period: where },
      data: {
        ...(plan.values ?? {}),
        // Set on UPDATE too. A displaced Yahoo row carries no `periodEnd` and
        // no `basis` either, so an update that left them alone would keep both
        // broken on exactly the rows we just took ownership of.
        periodEnd: winner.periodEnd,
        basis: winner.basis,
        source: plan.source ?? DOC_SOURCE,
        rawData: plan.rawData as unknown as Prisma.InputJsonValue,
        fetchedAt: args.now,
      } as Prisma.StockFinancialsUncheckedUpdateInput,
    });
  }
  out.updated++;
  if (plan.displaced) out.displaced++;
  return "DECIDED";
}

/**
 * Writes this run deliberately WITHHELD.
 *
 * Not `skipped.AUTHORITY` alone, which is structurally near-zero: `DOC_PDF` is
 * at the bottom of the order, so AUTHORITY is the EXPECTED outcome for any
 * period a vendor already covers and is not a "door" in the interesting sense.
 * The doors that actually close on this pipeline are the create suppression
 * (the majority path for the zero-coverage cohort), the ungraded interlock and
 * the blocking verdicts.
 */
export function countWithheldWrites(r: DocProjectionWriteResult): number {
  return (
    r.skippedCreateSuppressed +
    r.skippedNoInstrument +
    r.skipped.NOT_GRADED +
    r.skipped.VERDICT_BLOCKS +
    r.skipped.BASIS_DOWNGRADE +
    r.skipped.STANDALONE_NO_DISPLACE +
    r.skipped.AUTHORITY
  );
}

/**
 * Why a run that SELECTED rows wrote none.
 *
 * A job reporting `selected=500 written=0` is indistinguishable at a glance
 * from a broken selector, and manufacturing that signal is what MONEY-1220 and
 * MONEY-1234 exist to stop. The reason is assembled from the writer's OWN
 * counters, so a renamed field is a type error rather than a silently-zero
 * metric.
 */
export function describeNoWriteReason(r: DocProjectionWriteResult): string {
  const all: Array<[string, number]> = [
    ["createSuppressed", r.skippedCreateSuppressed],
    ["noInstrument", r.skippedNoInstrument],
    ["notGraded", r.skipped.NOT_GRADED],
    ["verdictBlocks", r.skipped.VERDICT_BLOCKS],
    ["authority", r.skipped.AUTHORITY],
    ["unchanged", r.skipped.UNCHANGED],
    ["basisDowngrade", r.skipped.BASIS_DOWNGRADE],
    ["standaloneNoDisplace", r.skipped.STANDALONE_NO_DISPLACE],
    ["noValues", r.skipped.NO_VALUES],
    ["notExtracted", r.skipped.NOT_EXTRACTED],
  ];
  const doors = all.filter(([, n]) => n > 0);
  if (doors.length === 0) {
    return `selected ${r.extractsRead} and wrote none, with EVERY door at zero — that is a selector or grouping defect, not a policy outcome`;
  }
  return `no write: ${doors.map(([k, n]) => `${k}=${n}`).join(" ")}`;
}

/** One line naming every door, for the outcome report. */
export function summariseWriteDoors(r: DocProjectionWriteResult): string {
  return [
    `createSuppressed=${r.skippedCreateSuppressed}`,
    `noInstrument=${r.skippedNoInstrument}`,
    ...Object.entries(r.skipped).map(([k, n]) => `${k}=${n}`),
  ].join(" ");
}

/** Extracts still awaiting a projection decision. Read-only. */
export async function countUnprojectedExtracts(
  deps: { prisma?: Db } = {},
): Promise<number> {
  const db = deps.prisma ?? prisma;
  return db.documentFinancialExtract.count({
    where: { status: "EXTRACTED", ...UNPROJECTED_EXTRACT_WHERE } as never,
  });
}

/** Re-exported so a caller does not have to reach into core for the field list. */
export { docOwnedFields };
