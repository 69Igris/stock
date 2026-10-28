/**
 * Stock-document-PARSE processor — PURE helpers (no Prisma, no GCS, no Gemini).
 *
 * Side-effect-free selection/decision helpers lifted out of
 * `stock-document-parse.ts` so they can be unit-tested by importing the REAL
 * symbol — no shadow copies — without booting Prisma or a model client at
 * module load. The processor imports and CALLS every export here, so the
 * production path and the tests run the SAME code. Mirrors
 * `stock-document-extract-logic.ts`.
 *
 * @see workers/src/processors/stock-document-parse.ts (caller)
 * @see workers/__tests__/processors/stock-document-parse-logic.test.ts
 */

// MONEY-1319 review — DIRECT, not the archive-inclusive set. This lane cannot
// open a container; see the `mimeType` arm of `buildParseQuery` below.
import { DIRECT_DOC_MIME_TYPES } from "@usemoney/core/market-data/doc-mime";
import { PUBSUB_TOPICS } from "@usemoney/types/pubsub";

// ---------------------------------------------------------------------------
// TOPIC + MESSAGE
// ---------------------------------------------------------------------------

/**
 * Base topic name, suffixed at publish time by `getTopicName`.
 *
 * Read from `PUBSUB_TOPICS`, never spelled as a literal. A topic name written
 * out by hand at a publish site is a name that can drift from the one
 * `setup-pubsub.sh` created, and a publish to a non-existent topic is a caught
 * warning rather than a failure — so the drift would be silent.
 */
export const STOCK_DOCUMENT_PARSE_TOPIC = PUBSUB_TOPICS.STOCK_DOCUMENT_PARSE;

export interface StockDocumentParseMessage {
  /** Restrict to these symbols (upper-cased at query time). */
  symbols?: string[];
  /** Restrict to these docTypes. Defaults to {@link PARSEABLE_DOC_TYPES}. */
  docTypes?: string[];
  /**
   * Re-parse documents already in a terminal state.
   *
   * Widens the selection to FAILED and FAILED_VALIDATION as well as
   * PENDING/absent. A forced run NEVER self-chains — see
   * {@link shouldChainAnotherBatch}.
   */
  force?: boolean;
  /** Page size. See {@link DEFAULT_PARSE_BATCH_SIZE}. */
  batchSize?: number;
  /** Self-chain depth. 0 for a scheduler trigger. */
  chainDepth?: number;
  /** Model id override, validated against the registry before use. */
  model?: string;
}

// ---------------------------------------------------------------------------
// SELECTION
// ---------------------------------------------------------------------------

/**
 * Doc types whose PDFs actually contain statements.
 *
 * `annual_report` and `quarterly_result` are the two the financials live in.
 * `financial_statement` is included because the sync writes statement content
 * under it — most of those rows are text and are filtered out by the mimeType
 * arm, so including the type costs nothing and including it is what makes a
 * PDF-shaped one reachable.
 *
 * Deliberately EXCLUDED, and each for a reason: `concall_transcript` /
 * `concall_ppt` / `investor_presentation` carry MANAGEMENT-CHOSEN figures with
 * no Schedule III discipline (adjusted EBITDA, like-for-like revenue) that
 * would be indistinguishable from filed ones once stored; `drhp` states
 * pre-IPO restated accounts against periods that do not line up with the
 * post-listing series; `credit_rating` / `press_release` / `announcement` /
 * `corporate_filing` are prose. Paying for a model call on any of them buys a
 * confident reading of the wrong number.
 */
export const PARSEABLE_DOC_TYPES: readonly string[] = [
  "annual_report",
  "quarterly_result",
  "financial_statement",
];

/**
 * Terminal parse states a `force` run re-opens.
 *
 * FAILED_VALIDATION is in the list ONLY for a forced run and that is the whole
 * distinction the status carries: the model answered and OUR arithmetic
 * rejected it, so re-running the identical (model, prompt) pair produces the
 * identical rejection at the identical cost. It is re-parseable after a prompt
 * change — which is a deliberate, operator-triggered act — and never
 * automatically.
 */
export const FORCE_REPARSE_STATUSES: readonly string[] = [
  "FAILED",
  "FAILED_VALIDATION",
];

/**
 * The `parseStatus` arm of the selection — THE TRAP THIS FILE EXISTS FOR.
 *
 * ## `parseStatus` is ABSENT, not "PENDING", on every pre-existing row
 *
 * A Mongo `prisma db push` creates INDEXES, never FIELDS. `@default("PENDING")`
 * is applied by PRISMA at create time, so it reaches rows Prisma itself writes
 * and no others. All ~43,105 `stock_documents` rows that existed before the
 * column was declared carry NO such attribute at all, and Prisma's Mongo
 * connector does not treat absent as null.
 *
 * So `where: { parseStatus: "PENDING" }` matches **ZERO** of them — and the
 * failure is INVISIBLE, because "there are no documents to parse" and "the
 * entire backlog is unreachable" print the identical log line and emit the
 * identical `selected: 0` metric. The `{ isSet: false }` arm is what reaches
 * them.
 *
 * This class has now caused MONEY-1050, MONEY-1205, MONEY-1234 and MONEY-1236.
 * A fifth would be free to happen because nothing about it looks wrong.
 */
export const PENDING_OR_ABSENT_PARSE_STATUS = [
  { parseStatus: "PENDING" },
  { parseStatus: { isSet: false } },
] as const;

/**
 * OLDEST FIRST. `fetchedAt` ascending is the rotation marker.
 *
 * A batch needs a rotation marker ordered ASC or it never advances. MONEY-1211
 * ordered by a column that was CONSTANT across the population and handed every
 * run the same first N rows forever — 681 of 781 symbols were never selected,
 * with no error and no alert. `stock-document-extract` re-learned the same
 * lesson from the other direction: `desc` over a queue that grows on every sync
 * pushes the oldest rows further down every cycle and never reaches them.
 *
 * Ascending works as a marker here because every row this loop touches LEAVES
 * the selected set (PENDING → PROCESSING → PARSED | FAILED | …), so the next
 * page starts where this one stopped with no cursor to carry.
 */
export const PARSE_ORDER_BY = { fetchedAt: "asc" } as const;

/**
 * Build the `StockDocument.findMany` WHERE for the parse query.
 *
 * Three arms, and each one has already been a defect somewhere in this repo:
 *   - `parseStatus` — see {@link PENDING_OR_ABSENT_PARSE_STATUS}.
 *   - `mimeType` — an EXACT match against a column written from a raw
 *     `content-type` header. `DIRECT_DOC_MIME_TYPES` is the shared list that
 *     made `application/pdf;charset=UTF-8` reachable (MONEY-1255); reading a
 *     shared array here means the lanes cannot disagree about what a PDF is.
 *
 *     DIRECT, not `EXTRACTABLE_DOC_MIME_TYPES`, and that distinction is the
 *     MONEY-1319 review finding. This lane CANNOT open a container. It selected
 *     the archive-inclusive array for as long as that array had one member
 *     beyond PDF, and `PARSEABLE_DOC_TYPES` includes `annual_report` — exactly
 *     the 172-row NSE ZIP class. So every one of those rows would have been
 *     downloaded and its raw archive bytes handed to the Gemini Files API, or
 *     its `gs://` URI handed to Vertex: a metered call per row for bytes no
 *     model can read, which is the waste MONEY-1319 exists to stop, recreated
 *     one lane over. 13 prod rows are already honestly typed `application/zip`.
 *
 *     Teaching this lane to unwrap was considered and rejected: it offers TWO
 *     transports and the Vertex one reads the `gs://` OBJECT, which cannot be
 *     handed a member — so an archive-aware parse lane would silently lose its
 *     fallback transport for exactly the rows it just gained. The extract lane
 *     already produces text from these archives.
 *   - `docType` — see {@link PARSEABLE_DOC_TYPES}.
 */
/**
 * The `where` that CLAIMS one document for this run — MONEY-1259.
 *
 * ## Why a claim needs a guard at all
 *
 * The claim used to be a bare `update({ where: { id } })`, which always
 * succeeds. That is correct for ONE runner and wrong for two: overlapping runs
 * select the same page, and each duplicated document is a duplicated MODEL
 * CALL. `document_financial_extracts` is `@@unique([documentId, periodEnd,
 * periodType, basis])`, so the WRITES are idempotent — the SPEND is not, and
 * the spend is the expensive half.
 *
 * Four triggers a day (MONEY-1259) makes overlap possible where one trigger
 * never could, so the guard ships in the same change as the triggers.
 *
 * ## Why this is NOT `notIn: ["PROCESSING", "PARSED"]`
 *
 * That is the obvious guard and it is the fifth instance of this repo's most
 * expensive bug. `parseStatus` is ABSENT — not null, not "PENDING" — on the
 * ~43,155 documents written before the column existed, because a Mongo
 * `db push` creates INDEXES and never FIELDS. A `notIn` does not match an
 * absent field, so the guard would silently refuse to claim every legacy row
 * and the queue would drain only the rows Prisma itself created.
 *
 * It would look like it worked. The job would run, claim the handful of modern
 * rows, report a healthy count, and never touch the backlog it exists for.
 * MONEY-1050, 1205, 1234, 1236 and 1256 are the same shape.
 *
 * ## Why it is DERIVED from the selection arms
 *
 * The claim must accept exactly what the selection offers. Restating the arms
 * would let the two drift — the selection widens under `force`, and a claim
 * that did not would silently drop every re-parse on the floor. So both read
 * {@link PENDING_OR_ABSENT_PARSE_STATUS}, and `force` composes here the same
 * way it composes in {@link buildParseQuery}.
 *
 * A caller applies this with `updateMany`, never `update`: `update` throws when
 * it matches nothing, while `updateMany` reports `count: 0`, which is the
 * ordinary "another run took it" outcome and not an error.
 */
export function buildClaimWhere(
  id: string,
  force = false,
): Record<string, unknown> {
  return {
    id,
    OR: force
      ? [
          ...PENDING_OR_ABSENT_PARSE_STATUS,
          { parseStatus: { in: [...FORCE_REPARSE_STATUSES] } },
        ]
      : [...PENDING_OR_ABSENT_PARSE_STATUS],
  };
}

export function buildParseQuery(opts: {
  symbols?: string[];
  docTypes?: string[];
  force?: boolean;
}): Record<string, unknown> {
  const statusArm = opts.force
    ? {
        OR: [
          ...PENDING_OR_ABSENT_PARSE_STATUS,
          { parseStatus: { in: [...FORCE_REPARSE_STATUSES] } },
        ],
      }
    : { OR: [...PENDING_OR_ABSENT_PARSE_STATUS] };

  const docTypes =
    opts.docTypes && opts.docTypes.length > 0
      ? opts.docTypes
      : [...PARSEABLE_DOC_TYPES];

  return {
    ...statusArm,
    mimeType: { in: [...DIRECT_DOC_MIME_TYPES] },
    docType: { in: docTypes },
    ...(opts.symbols && opts.symbols.length > 0
      ? { symbol: { in: opts.symbols.map((s) => s.toUpperCase()) } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// COHORT ORDERING — which company gets read first
// ---------------------------------------------------------------------------

/**
 * The two cohorts, IN THE ORDER THEY DRAIN.
 *
 * ## Why the queue is not plain FIFO
 *
 * Measured against `stock_financials` on prod, the 15,705 eligible PDFs split
 * unevenly:
 *
 *   1,373 symbols already have financials -> 12,255 PDFs  (a SECOND OPINION)
 *     298 symbols have none at all        ->  3,450 PDFs  (the ONLY source)
 *
 * For the 1,373, a parse is a cross-check on numbers already on screen. For the
 * 298 it is the difference between an empty Financials tab and a populated one.
 * At ~120 documents a night the ordering decides when that second group is
 * served: **29 nights** if their documents go first, or up to **131** if they
 * sit scattered through a queue that is 78% companies we can already show.
 * Same total work, same total cost, ~4.5x earlier delivery for the only cohort
 * that has nothing today.
 *
 * ## Why this does NOT break the rotation-marker rule
 *
 * Phase is an ORDERING key, never an eligibility filter. Three properties hold,
 * and the tests assert each one:
 *
 *   - **Partition.** Phase 1 and phase 2 are complements over the SAME eligible
 *     set: their union is every eligible document and their intersection is
 *     empty. No document is unreachable, which is the failure mode a filter
 *     would introduce.
 *   - **Consumption.** `parseStatus` still advances monotonically per document
 *     (PENDING/absent -> PROCESSING -> terminal), so each is consumed exactly
 *     once regardless of which phase it sat in.
 *   - **No starvation.** Phase 1 is finite and shrinking, so phase 2 begins on
 *     its own. A run tops up from phase 2 the moment phase 1 cannot fill the
 *     page, so phase 2 starts draining before phase 1 is fully empty.
 *
 * `fetchedAt ASC` still orders WITHIN each phase — the marker that made
 * MONEY-1211 advance is untouched, it now runs twice instead of once.
 *
 * A symbol that later GAINS financials (once the projection is armed) moves to
 * phase 2 mid-drain. That is correct rather than hazardous: the marginal value
 * of its fifth annual report really is lower once it is covered.
 */
/**
 * Ceiling on the per-phase id scan — MONEY-1259.
 *
 * The breadth-first pick cannot be expressed as an `orderBy`. `period` is a
 * free-text string carrying at least "2024", "FY2024-25" and "Q1-2026" in the
 * same column, so a DB-side sort on it does not order fiscal years; the pick
 * has to happen in JavaScript over a scan. The scan takes the four narrow
 * fields {@link ParseScanRow} names — not the full row — so ~15,700 eligible
 * documents cost roughly a megabyte, once per phase per run, against a run that
 * then spends minutes in model calls.
 *
 * 40,000 is a runaway guard and NOT a working limit: the whole eligible set is
 * ~15,700 and the whole `stock_documents` table is ~45,600. Reaching this
 * number means the eligible set grew past anything we have measured, and the
 * safe response is to select from the oldest 40,000 — which is still correct,
 * just less broad — rather than to stream the table.
 */
export const PARSE_SCAN_CAP = 40_000;

/** The narrow projection the breadth-first pick reads. */
export interface ParseScanRow {
  id: string;
  symbol: string;
  period: string | null;
  fetchedAt: Date | string;
}

/**
 * The fiscal year a `period` string refers to, or 0 when it names none.
 *
 * Deliberately the MAX of every 4-digit run rather than the first: "FY2024-25"
 * yields 2024 (the `-25` is two digits and does not match), while "FY2024-2025"
 * yields 2025. Both order correctly against other periods of the same company,
 * which is all this is used for — it is a SORT key, never a stored value, so
 * the two spellings disagreeing by one is harmless here and would not be if it
 * were persisted.
 *
 * 0 for an unparseable period sorts it last among a symbol's documents, which
 * is the right default: a document whose period we cannot read is the one we
 * least want to spend the symbol's single first turn on.
 */
export function fiscalYearOf(period: string | null | undefined): number {
  const runs = String(period ?? "").match(/\d{4}/g);
  if (!runs) return 0;
  return Math.max(...runs.map(Number));
}

/** Milliseconds for a Date or an ISO string; 0 when unreadable. */
function timeOf(v: Date | string): number {
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

/**
 * BREADTH FIRST — one latest-period document for every unserved symbol before
 * any symbol receives a second. MONEY-1259.
 *
 * ## The problem it fixes
 *
 * Ordering the eligible set by `fetchedAt` alone is depth-first by accident:
 * the queue holds a median of 12 documents per symbol, so the first symbol
 * receives twelve fiscal years before the two-hundredth receives one. Measured
 * on prod: 15,702 eligible documents across 1,681 symbols, and the latest
 * document for EVERY one of them is only 1,681 documents — roughly a tenth of
 * the work for the reading that unlocks most of the ratio panel, since ~19 of
 * the 26 owned `StockRatios` columns need a single annual period.
 *
 * ## Why it does not starve the tail
 *
 * This is an ORDERING, not a filter — the same distinction {@link PARSE_PHASES}
 * turns on. Every eligible document remains selectable: once each unserved
 * symbol holds its one pick, the remainder of the page is filled from the same
 * candidate list in `fetchedAt` order, which is exactly the previous behaviour.
 * Depth therefore back-fills behind breadth instead of being dropped, and the
 * Financials tab — the consumer that genuinely needs history — still gets it.
 *
 * ## Why "served" is ANY extract row, including a failed one
 *
 * A symbol counts as served once it has an extract row of any status.
 * `FAILED_VALIDATION` counts deliberately: the document consumed the symbol's
 * turn, and re-picking that symbol ahead of a symbol with nothing would spend
 * the scarce breadth pass on a company we have already read.
 *
 * The converse is what makes it self-correcting. A run that returns NO periods
 * writes no extract row at all, so the symbol stays unserved and its next-best
 * document is picked next time — the retry is a consequence of the definition
 * rather than a separate mechanism. And because `parseStatus` still advances
 * per document, the document just attempted is no longer eligible, so the retry
 * cannot loop on it.
 *
 * `limit <= 0` returns empty rather than everything — a page with no room is a
 * real state at the end of a batch, and returning the whole scan there would
 * silently ignore `batchSize`.
 */
export function selectBreadthFirst(
  rows: readonly ParseScanRow[],
  servedSymbols: ReadonlySet<string>,
  limit: number,
): string[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];

  /** Best remaining document per UNSERVED symbol, in first-seen order. */
  const best = new Map<string, ParseScanRow>();
  for (const row of rows) {
    if (servedSymbols.has(row.symbol)) continue;
    const incumbent = best.get(row.symbol);
    if (!incumbent) {
      best.set(row.symbol, row);
      continue;
    }
    const dy = fiscalYearOf(row.period) - fiscalYearOf(incumbent.period);
    // Newer fiscal year wins; on a tie the more recently FETCHED copy wins,
    // which prefers the freshest upload of a period filed twice.
    if (
      dy > 0 ||
      (dy === 0 && timeOf(row.fetchedAt) > timeOf(incumbent.fetchedAt))
    ) {
      best.set(row.symbol, row);
    }
  }

  const picked: string[] = [];
  const taken = new Set<string>();
  for (const row of best.values()) {
    if (picked.length >= limit) break;
    picked.push(row.id);
    taken.add(row.id);
  }

  // Fill the rest in the caller's order (fetchedAt ASC) — the previous
  // behaviour, reached only once breadth is satisfied.
  for (const row of rows) {
    if (picked.length >= limit) break;
    if (taken.has(row.id)) continue;
    picked.push(row.id);
    taken.add(row.id);
  }

  return picked;
}

export const PARSE_PHASES = ["NO_FINANCIALS", "HAS_FINANCIALS"] as const;

export type ParsePhase = (typeof PARSE_PHASES)[number];

/**
 * Ceiling on the covered-symbol list before phasing is abandoned.
 *
 * `$nin` carries every value in the query document, and the query has to fit in
 * Mongo's 16 MB BSON limit. 25,000 short symbols is ~400 KB — comfortably
 * inside it, and far ABOVE the whole active instrument universe (~10,444). So
 * exceeding this does not mean "a big market", it means the distinct returned
 * something we did not expect, and the safe response is to stop shaping the
 * query on it rather than to send it anyway.
 */
export const MAX_COVERED_SYMBOLS_FOR_PHASING = 25_000;

/**
 * Which phases a run should walk, given how many symbols are covered.
 *
 * With NOTHING covered, phase 1 IS the whole queue and phase 2 is provably
 * empty — so the second query is skipped rather than issued as a `symbol: { in:
 * [] }` that scans to find nothing. This is also the shape a FAILED
 * covered-symbol lookup degrades to: plain FIFO over everything, which is
 * slower to deliver but still complete and still correct.
 */
export function phasesToRun(coveredCount: number): ParsePhase[] {
  if (!Number.isFinite(coveredCount) || coveredCount <= 0) {
    return ["NO_FINANCIALS"];
  }
  return [...PARSE_PHASES];
}

/**
 * True when the covered-symbol list can safely shape the query.
 *
 * Separated from {@link phasesToRun} so the DEGRADED path is a decision with a
 * name rather than an empty array that happens to behave correctly.
 */
export function canPhaseOnCoveredSymbols(
  coveredSymbols: readonly string[],
): boolean {
  return (
    coveredSymbols.length > 0 &&
    coveredSymbols.length <= MAX_COVERED_SYMBOLS_FOR_PHASING
  );
}

/**
 * Add the cohort arm to a base selection.
 *
 * The arm goes under `AND` rather than onto a top-level `symbol` key, because
 * `buildParseQuery` may ALREADY have written `symbol: { in: [...] }` for an
 * operator-scoped run. Overwriting it would silently widen a targeted run back
 * to the whole market — the opposite of what was asked for, and invisible.
 */
export function buildPhaseQuery(
  base: Record<string, unknown>,
  coveredSymbols: readonly string[],
  phase: ParsePhase,
): Record<string, unknown> {
  if (!canPhaseOnCoveredSymbols(coveredSymbols)) {
    // Nothing to partition on: phase 1 is the whole eligible set.
    return { ...base };
  }
  const arm =
    phase === "NO_FINANCIALS"
      ? { symbol: { notIn: [...coveredSymbols] } }
      : { symbol: { in: [...coveredSymbols] } };
  const existingAnd = Array.isArray(base["AND"])
    ? (base["AND"] as unknown[])
    : [];
  return { ...base, AND: [...existingAnd, arm] };
}

/** Per-phase tallies for the run summary. Remaining is null when not counted. */
export interface PhaseProgress {
  phase: ParsePhase;
  selected: number;
  parsed: number;
  /** Documents still eligible in this phase, or null when the count failed. */
  remaining: number | null;
}

/**
 * The cohort line that rides on the job-outcome reason.
 *
 * Always emitted, not only on a zero-write run: which cohort is draining is the
 * question an operator would otherwise have to open a database to answer, and
 * "phase 1 selected 0" is precisely the moment they most want to know — it is
 * the handover from the no-data cohort to the validation cohort, and it looks
 * identical to a stalled job in every other signal.
 */
export function describeCohortProgress(input: {
  phases: PhaseProgress[];
  coveredSymbolCount: number;
  /** True when the covered-symbol lookup failed and the run fell back to FIFO. */
  degraded: boolean;
}): string {
  const { phases, coveredSymbolCount, degraded } = input;
  const parts = phases.map((p) => {
    const remaining = p.remaining === null ? "?" : String(p.remaining);
    return `${p.phase} sel=${p.selected} parsed=${p.parsed} left=${remaining}`;
  });
  const head = degraded
    ? "cohort ordering DEGRADED to plain FIFO (covered-symbol lookup failed)"
    : `cohort ordering on ${coveredSymbolCount} covered symbol(s)`;
  return `${head}; ${parts.join(" | ")}`;
}

// ---------------------------------------------------------------------------
// THROUGHPUT — the 600s Pub/Sub ack deadline
// ---------------------------------------------------------------------------

/**
 * Wall-clock budget after which the loop stops taking NEW documents.
 *
 * ## The arithmetic
 *
 * Every worker job arrives on a push subscription with `--ack-deadline=600`,
 * which is Pub/Sub's MAXIMUM and cannot be raised. Cloud Run's 3600s request
 * timeout is never the binding constraint. Overrunning 600s does not make the
 * run slow — Pub/Sub REDELIVERS, so a second copy of the job starts while the
 * first is still running and both parse the same page, at double the model
 * cost.
 *
 * The population has a LONG TAIL and the tail is what sizes this: of 15,705
 * financial-statement PDFs with a recorded size, the average is 5.7 MiB but
 * 22.1% are over 8 MiB, 3.7% over 20 MiB, and 34 are over 50 MiB (max 212 MiB).
 * A budget sized on the average would be overrun by one in five documents.
 *
 *   600s   ack deadline (hard ceiling)
 *  -210s   RUN_TIME_BUDGET_MS — no new document is STARTED past this
 *  ------
 *   390s   headroom, which has to absorb, in order:
 *
 *   240s   the ONE document already in flight when the budget expires. The
 *          budget is checked BETWEEN documents, so the true wall is
 *          `budget + one document`. That term is BOUNDED rather than assumed:
 *          `gemini-pdf.ts` runs upload + activation + generation against ONE
 *          shared deadline (`DEFAULT_DOC_PARSE_BUDGET_MS`, 240s), so the three
 *          stages cannot each contribute their own worst case.
 *   ~30s   the GCS download of that document — up to `MAX_PDF_BYTES` (50 MiB),
 *          costed cross-region rather than same-region.
 *   ~10s   the best-effort Files API delete, which runs OUTSIDE the parse
 *          budget and is therefore bounded separately
 *          (`FILE_DELETE_TIMEOUT_MS`).
 *    ~5s   its Prisma writes: up to ~4 extract upserts plus the status flip.
 *   ~15s   the run's own bookkeeping, which cohort ordering made non-trivial:
 *          the `distinct` over `stock_financials.symbol` (index-served by
 *          `@@index([symbol, exchange])`, ~1s), up to TWO phase findManys
 *          (`@@index([parseStatus, fetchedAt])` serves the sort; the `$nin`
 *          arm is a residual filter), and the two best-effort remaining
 *          counts. The costliest case is a DRAINED phase 1, where the phase-1
 *          query walks the eligible set and matches nothing — bounded by the
 *          queue size, incurred ONCE per run rather than per document, and
 *          self-extinguishing as the queue shrinks.
 *    ~1s   reportJobOutcome + the chain publish in the `finally`.
 *   ----
 *   300s   used, ~90s spare. Deliberately generous: being wrong here does not
 *          cost a slow run, it DUPLICATES the run — and duplicating this run
 *          means paying twice for every model call in it.
 *
 * 210s is LOWER than `stock-document-extract`'s 420s on purpose, and for the
 * opposite reason to what a first reading suggests: this job does LESS work per
 * run, because its single worst item costs ~4x more. That job's worst item is a
 * ~30-page Document AI call; this one's is a whole-PDF model read plus a
 * 50 MiB round trip, so the in-flight term eats the headroom the budget would
 * otherwise get.
 *
 * `stock-document-parse-logic.test.ts` asserts
 * `RUN_TIME_BUDGET_MS + worst-in-flight < 600_000`, so raising either constant
 * without redoing this arithmetic fails a test rather than a production run.
 */
export const RUN_TIME_BUDGET_MS = 210_000;

/**
 * Documents pulled per run when the message names no `batchSize`.
 *
 * A PAGE SIZE and a runaway guard, NOT the throughput control — the wall clock
 * above is. Sized to stay comfortably ABOVE what one budget can consume: at the
 * bounded worst of 240s/document the budget affords 1, at a typical ~35s it
 * affords ~6, so 25 means `selected < batchSize` reliably signals "the QUEUE
 * ran dry" rather than "the PAGE ran out". That distinction is what
 * {@link shouldChainAnotherBatch} reads to decide whether to continue; a batch
 * sized at the throughput would make the two indistinguishable and stop the
 * chain a link early every night.
 *
 * Raising it is not the way to catch up (`workers/CLAUDE.md`): the run is
 * time-bounded, so a bigger page only enlarges a findMany whose extra rows are
 * never reached.
 */
export const DEFAULT_PARSE_BATCH_SIZE = 25;

/**
 * Hard ceiling on how many times one trigger may re-publish itself.
 *
 * THE TERMINATION PROOF LIVES HERE, and it deliberately does not consult the
 * database. Every chained publish carries `chainDepth + 1`, and
 * {@link shouldChainAnotherBatch} refuses once the NEXT depth would reach this
 * value, so a chain is at most `MAX_CHAIN_DEPTH` messages long no matter what
 * the queue does, what `force` is set to, or whether any row moved. The other
 * conditions can only stop it SOONER, so none of them can break the bound.
 *
 * Sizing: unlike the extract lane, this bound is a COST ceiling as much as a
 * time one — every document is a paid model call, and a chain that runs until
 * the queue is empty would bill the whole backlog in one night with no chance
 * to look at the first night's output.
 *
 *   20 links x 210s ≈ 70 minutes of work from one trigger
 *   ~6 documents per link at a typical ~35s each  ≈ 120 documents a night
 *
 * Against ~15,700 financial-statement PDFs that is a ~130-night drain, which is
 * a deliberate trade rather than an oversight: the lever for going faster is a
 * SECOND daily trigger, whose cost is visible in the scheduler, not a longer
 * chain, whose cost is visible only on the bill. Raise this only with a
 * measured per-document token cost in hand.
 */
export const MAX_CHAIN_DEPTH = 20;

/**
 * Sanitise the `chainDepth` carried on an inbound message.
 *
 * The value comes off a Pub/Sub payload, so it is `unknown` until proven
 * otherwise: a missing, negative, fractional, NaN or absurd value must not be
 * able to buy extra links. Anything that is not a finite non-negative number
 * reads as depth 0, and anything above the ceiling is CLAMPED to it — so a
 * forged large value ENDS the chain rather than wrapping it.
 */
export function normalizeChainDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(Math.floor(value), MAX_CHAIN_DEPTH);
}

/**
 * True while the run may start ANOTHER document.
 *
 * Pure so the budget is testable without a clock: the caller passes
 * `Date.now()` and the run's start.
 */
export function isWithinRunBudget(
  startedAtMs: number,
  nowMs: number,
  budgetMs: number = RUN_TIME_BUDGET_MS,
): boolean {
  return nowMs - startedAtMs < budgetMs;
}

/** Inputs to the self-chain decision. All observed, none inferred. */
export interface ChainDecisionInput {
  /** Rows this run pulled from the queue. */
  selected: number;
  /** The `take` this run used. `selected < batchSize` means the queue ran dry. */
  batchSize: number;
  /** This run's depth (0 for a scheduler trigger). */
  chainDepth: number;
  /**
   * Rows that actually LEFT the pending set this run — the PROCESSING flip
   * landed. Zero means the queue is unchanged and re-running would re-select
   * the identical page.
   */
  leftPending: number;
  /** `force` re-selects terminal rows, so a failing row is a fixpoint. */
  force: boolean;
}

/**
 * Should this run publish a follow-up message?
 *
 * Four independent reasons to stop, ANY of which ends the chain:
 *
 *  1. **Depth.** The next link would reach {@link MAX_CHAIN_DEPTH}. This one
 *     ALONE bounds the chain; the rest only stop it sooner. It is a pure
 *     function of a number carried on the message, so no queue state, no
 *     database and no clock can extend it.
 *  2. **Drained.** The run got fewer rows than it asked for, so there is no
 *     next page.
 *  3. **No progress.** Not one row left the pending set — e.g. every `update`
 *     threw. Chaining here re-selects the identical page forever, which is the
 *     exact runaway-poll shape this repo already has an incident for.
 *  4. **Forced.** `force` widens the selection to include terminal rows, so a
 *     document that fails deterministically is selected again on the next link
 *     and the chain has no fixpoint to reach. Forced runs are manual and
 *     scoped: one batch, then stop.
 */
export function shouldChainAnotherBatch(input: ChainDecisionInput): boolean {
  const { selected, batchSize, chainDepth, leftPending, force } = input;
  if (force) return false;
  if (chainDepth + 1 >= MAX_CHAIN_DEPTH) return false;
  if (batchSize <= 0) return false;
  if (selected < batchSize) return false;
  if (leftPending <= 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// PER-DOCUMENT OUTCOME
// ---------------------------------------------------------------------------

/**
 * Terminal `StockDocument.parseStatus` values.
 *
 * Deliberately parallel to `processingStatus` but SEPARATE from it: the two
 * lanes have different costs, different failure modes and different consumers,
 * and a document routinely succeeds at one while failing the other (a scanned
 * annual report yields fine RAG text and no reliable statement table).
 */
export type ParseStatus =
  | "PENDING"
  | "PROCESSING"
  | "PARSED"
  | "FAILED"
  | "FAILED_VALIDATION"
  | "UNSUPPORTED";

/** What one document's parse produced. */
export interface DocumentParseOutcome {
  status: ParseStatus;
  /** Rows that will be written for it. */
  rowsWritten: number;
  /** Short operator-facing reason. Null on a clean PARSED. */
  reason: string | null;
}

/**
 * Decide a document's terminal `parseStatus` from what the parse produced.
 *
 * The two FAILED flavours are the point of this function and must not collapse:
 *
 *   - **FAILED** — the CALL failed (unconfigured, network, 5xx, timeout).
 *     Nothing about the document is known to be wrong, so a later run should
 *     try again.
 *   - **FAILED_VALIDATION** — the model ANSWERED and the answer failed OUR
 *     arithmetic (the balance sheet did not balance, the scale was
 *     unreadable, the total income did not cross-foot). Re-running the same
 *     (model, prompt) pair produces the same answer and the same rejection at
 *     the same cost. It is re-parseable only behind an explicit `force`.
 *
 * `UNSUPPORTED` is neither: the document cannot be sent at all (over the inline
 * ceiling), which is a capability gap rather than a failure, and it is COUNTED
 * so the gap is a number rather than an anecdote.
 */
export function resolveDocumentParseStatus(input: {
  /** Non-null when the model call itself failed. */
  callFailure:
    | "UNCONFIGURED"
    | "TOO_LARGE"
    | "CALL_FAILED"
    | "UNPARSEABLE"
    // MONEY-1334. This lane is RETIRED (all four crons deleted) and survives
    // only to drain in-flight chain messages, so it needs to RECOGNISE the new
    // failure rather than treat it well: an unhandled variant would fall
    // through to the extractedRows checks below and be reported as a clean
    // "no periods returned", which is the causeless-FAILED shape the whole
    // ticket exists to remove.
    | "TRUNCATED"
    | null;
  /** Periods the model returned, before validation. */
  periodsReturned: number;
  /** Rows that passed validation with status EXTRACTED. */
  extractedRows: number;
  /** Rows persisted with status FAILED_VALIDATION. */
  invalidRows: number;
  /** Validation reasons for periods that could not be persisted at all. */
  droppedReasons: string[];
}): DocumentParseOutcome {
  const {
    callFailure,
    periodsReturned,
    extractedRows,
    invalidRows,
    droppedReasons,
  } = input;

  if (callFailure === "TOO_LARGE") {
    return {
      status: "UNSUPPORTED",
      rowsWritten: 0,
      reason: "document exceeds the inline request ceiling",
    };
  }
  if (callFailure === "UNCONFIGURED" || callFailure === "CALL_FAILED") {
    return { status: "FAILED", rowsWritten: 0, reason: callFailure };
  }
  if (callFailure === "TRUNCATED") {
    // OUR ceiling, not the document's fault and not the model's. Terminal here
    // because this lane is retired and cannot re-run at a larger budget; the
    // live lanes treat it as sweepable.
    return {
      status: "FAILED_VALIDATION",
      rowsWritten: 0,
      reason: "model ran out of output budget (finishReason=MAX_TOKENS)",
    };
  }
  if (callFailure === "UNPARSEABLE") {
    // The call SUCCEEDED and the answer was not schema-shaped. That is a
    // prompt/parser signal, not a transport one, so it must not be
    // blind-retried — same classification as a failed arithmetic check.
    return {
      status: "FAILED_VALIDATION",
      rowsWritten: 0,
      reason: "model response was not schema-shaped JSON",
    };
  }

  if (extractedRows > 0) {
    return {
      status: "PARSED",
      rowsWritten: extractedRows + invalidRows,
      reason:
        invalidRows > 0
          ? `${invalidRows} of ${extractedRows + invalidRows} readings failed validation`
          : null,
    };
  }

  if (periodsReturned === 0) {
    // The model read the document and found no statements in it. Common and
    // legitimate — a "quarterly result" attachment that is a covering letter.
    return {
      status: "FAILED_VALIDATION",
      rowsWritten: 0,
      reason: "model returned no periods",
    };
  }

  return {
    status: "FAILED_VALIDATION",
    rowsWritten: invalidRows,
    reason:
      droppedReasons.length > 0
        ? `no valid readings: ${tallyReasons(droppedReasons)}`
        : "no valid readings",
  };
}

/** `A x2, B x1` — a stable, countable reason summary for a log line. */
export function tallyReasons(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([r, n]) => `${r} x${n}`)
    .join(", ");
}
