/**
 * Every selection MONEY-1324 makes over `us_filing_documents` and
 * `us_filing_insights` — in ONE module, pure, so the null-vs-absent arms can be
 * ASSERTED rather than remembered.
 *
 * ## Why these are not written inline at the call sites
 *
 * Because the two tables in this lane store "no value" DIFFERENTLY, and the
 * difference is invisible at a call site. It was got wrong here first, so the
 * correction is written down rather than assumed:
 *
 * ### `us_filing_documents` stores an EXPLICIT NULL. Measured, on prod.
 *
 * This module previously argued the opposite at length — that `textPath` is
 * ABSENT on a text-less row because `Row.to_doc()` (app/store/models.py:223)
 * drops every `None`, and that `{ textPath: { not: null } }` therefore "selects
 * ZERO". Every clause of that was false for THIS collection, and the arm it
 * justified (`isSet: true`) filters NOTHING.
 *
 * Prod `us_filing_documents`, 2026-09-02, counted with the driver:
 *
 *     rows                      3,509
 *     textPath $exists: true    3,509   ← 100%. NOTHING is absent.
 *     textPath BSON null        1,963
 *     textPath string           1,546
 *     textPath ""                   0
 *
 * and the same shape on its siblings — `textHash` 1,963 null, `textBytes`
 * 1,963 null, `symbol` 769 null. Not one absent key in the table.
 *
 * ### Root cause: the typed row model is not the writer
 *
 * `UsFilingDocumentRow` exists in `models.py` and `to_doc()` really does drop
 * `None` — but nothing calls it. `services/us-fundamentals` writes this
 * collection through `eightk_logic.build_rows`
 * (app/parsers/eightk_logic.py:200), which returns `list[dict[str, Any]]` with
 * a literal `"textPath": text_paths.get(doc.sequence)` — `None` when the
 * exhibit produced no text. `dispatch.py:515` hands those plain dicts to
 * `_Write("filing_documents", …)`, and `MongoRowWriter.upsert_rows` wraps a
 * plain dict in `_DocRow`, whose `to_doc` passes it through UNTOUCHED. So the
 * `None` reaches MongoDB as a BSON null.
 *
 * That service's own suite already says so, in the MONEY-1317 note at
 * `tests/test_store_writers.py:643`: "`upsert_filing_documents`, the typed one,
 * has zero callers." The error made here was citing `models.py` for a
 * collection `models.py` does not write.
 *
 * ### The absent-field class is REAL. It is just not this table.
 *
 * Do not read the correction above as "absent fields were a myth". Measured on
 * the SAME prod database, the same day:
 *
 *     stock_financials.basis             32,359 rows, 32,359 ABSENT (100%)
 *     instrument_mappings.usEodSyncedAt  27,016 rows, 27,016 ABSENT (100%)
 *     stock_documents.documentsSyncedAt  90,213 rows, 90,213 ABSENT (100%)
 *     us_cusip_map.figi                  23,229 rows, 23,229 ABSENT (100%)
 *
 * That last one is written by the SAME Python service as this table, through
 * the typed `UsCusipMapRow` — so one service produces both shapes, and which
 * one you get depends on the code path, never on the language. MONEY-1050,
 * MONEY-1205, MONEY-1234, MONEY-1235 and MONEY-1236 are all still real bugs
 * about still-real data.
 *
 * ### What Prisma actually does, measured rather than reasoned
 *
 * Counted with the generated client against prod, both populations:
 *
 *                                 us_filing_documents   stock_financials
 *     filter                        .textPath (nulls)     .basis (absent)
 *     ─────────────────────────────────────────────────────────────────
 *     { isSet: true }                    3,509  (all)          0
 *     { isSet: false }                       0               32,359
 *     { equals: null }                   1,963                  0
 *     { not: null }                      1,546                  0
 *     { isSet: true, notIn: [""] }       3,509  (all)         —
 *
 * Two facts fall out and both are load-bearing:
 *
 *   1. `{ not: null }` EXCLUDES an absent attribute as well as a null one — it
 *      returned 0 against 32,359 absent rows. So it is the correct and
 *      SUFFICIENT spelling here, and it stays correct if this collection's
 *      writer is ever switched to the typed row.
 *   2. `notIn: [""]` does NOT exclude nulls (`$nin` on Mongo matches a null,
 *      because null is not ""). That is precisely why the old
 *      `{ isSet: true, notIn: [""] }` admitted all 1,963 null rows.
 *
 * `isSet: true` is therefore NOT paired with `not: null` below. It would be a
 * second arm that filters nothing while advertising itself as the one doing the
 * work, which is the error this docblock is a correction of.
 *
 * ### `us_filing_insights` is the OTHER shape, and its arms stay
 *
 * That table is written only by this lane, through Prisma, and both builders in
 * `us-filing-insight-logic.ts` OMIT a key they cannot fill rather than writing
 * null ("ABSENT, NEVER NULL"). So its `{ isSet: false }` arms are the right
 * spelling for it, and they are kept.
 *
 * `us-filing-insight-isset-arms.test.ts` asserts these arms against fixtures
 * copied VERBATIM from prod rows, evaluates the query against them, and carries
 * controls proving its own detector can fail.
 */

/**
 * The `documentClass` vocabulary — IMPORTED, never restated.
 *
 * ONE SHAPE WITH OPTIONAL BLOCKS rather than a table per class, because the
 * cohort is measurably heterogeneous: the EX-99.1 read while designing this
 * (Hornbeck Offshore, 0001193125-26-378529 seq 11) is AUDITED CONSOLIDATED
 * FINANCIAL STATEMENTS attached to a merger 8-K carrying items 1.01/2.01/5.01
 * — not the earnings release an EX-99.1 is usually assumed to be.
 *
 * `FILING_DOCUMENT_CLASSES` is the list the model is CONSTRAINED TO by
 * `FILING_INSIGHT_SCHEMA`'s `responseSchema`, so it is the only list that can
 * be true about what actually lands in this column. A second enumeration
 * beside it would be one rule stated twice — the shape MONEY-1255 paid for,
 * where a job named a GCS object by one rule and selected the row by another.
 *
 * The two DID disagree while this ticket was being built: the sweep had
 * invented TRANSACTION / GUIDANCE / PERSONNEL, and the analyser's schema emits
 * PROXY_OR_MEETING / BUSINESS_DESCRIPTION. Wired together unchanged, the column
 * would have filled with two values no reader here enumerated — and the sweep's
 * own vocabulary test would have stayed green throughout, because it only ever
 * checked its own constant.
 */
import {
  FILING_DOCUMENT_CLASSES,
  type FilingDocumentClass,
} from "@usemoney/core/market-data/filing-insight-logic";

/** Re-exported so a consumer of the sweep needs ONE import, not two. */
export { FILING_DOCUMENT_CLASSES, type FilingDocumentClass };

/**
 * `insightStatus` vocabulary. Mirrors the `UsFilingInsight` schema comment.
 *
 * `SKIPPED` is terminal-BY-CONTENT (the document carries nothing analysable)
 * and is deliberately distinct from `FAILED`, which is transient and
 * re-selectable. Collapsing the two makes a permanent no-op buy a model call on
 * every sweep forever — the shape `stock-document-ingest` names as the reason
 * `UNREADABLE` exists separately from `FAILED`.
 */
export const INSIGHT_STATUS = {
  PENDING: "PENDING",
  READY: "READY",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
} as const;

export type InsightStatus =
  (typeof INSIGHT_STATUS)[keyof typeof INSIGHT_STATUS];

/**
 * The one class the SWEEP owns and the model can never emit.
 *
 * A FAILED or SKIPPED row records an attempt with no reading behind it, so it
 * has no class — and inventing one the model might also have chosen would make
 * "the model said OTHER" indistinguishable from "nothing read this". It is
 * deliberately NOT in `FILING_DOCUMENT_CLASSES`: the analyser's schema must
 * not offer it as an answer.
 */
export const SWEEP_ONLY_DOCUMENT_CLASS = "UNCLASSIFIED" as const;

/** Everything the COLUMN accepts: what a model may say, plus the sentinel. */
export type DocumentClass =
  | FilingDocumentClass
  | typeof SWEEP_ONLY_DOCUMENT_CLASS;

export const DOCUMENT_CLASSES: readonly DocumentClass[] = [
  ...FILING_DOCUMENT_CLASSES,
  SWEEP_ONLY_DOCUMENT_CLASS,
] as const;

/**
 * The forms the cohort spans — FOUNDER DECISION, and the amendments matter.
 *
 * 6-K IS IN, and that is the decision the rest of this module is shaped by. A
 * foreign private issuer files no item numbers at all, so `items` is `[]` on
 * every one of the 1,256 6-K documents. An item-gated cohort therefore excludes
 * all of them SILENTLY — it looks like a narrower filter, not a missing form.
 */
export const INSIGHT_COHORT_FORMS: readonly string[] = [
  "8-K",
  "8-K/A",
  "6-K",
  "6-K/A",
] as const;

/**
 * `EX-99*`, not `EX-99.1`. Measured on prod 2026-09-02: EX-99.1 is 336
 * documents and EX-99.2 is 68, against 481 for the whole `EX-99*` prefix — so
 * pinning the exact type drops a third of the cohort. The prefix also picks up
 * the bare `EX-99` spelling, which real filers use.
 */
export const INSIGHT_COHORT_TYPE_PREFIX = "EX-99";

/**
 * Insight rows that have not been analysed — plus the ABSENT arm, which is
 * right for THIS table.
 *
 * `us_filing_insights` is written only by this lane, through Prisma, and
 * `buildInsightWrite` / `buildInsightFailureWrite` omit a key they cannot fill
 * rather than writing null. So an attribute genuinely can be missing here — the
 * opposite of `us_filing_documents`, whose pymongo writer stores explicit nulls
 * (see the module docblock). The two tables in one lane need two spellings, and
 * that is the whole reason both live in this file.
 *
 * The collection holds 0 rows today, so the arm is not yet load-bearing. It is
 * here because the day it becomes load-bearing is invisible: any column added
 * to this table later is absent on every row written before it.
 */
export const PENDING_OR_ABSENT_INSIGHT_STATUS: readonly Record<
  string,
  unknown
>[] = [
  { insightStatus: INSIGHT_STATUS.PENDING },
  { insightStatus: { isSet: false } },
] as const;

/** The `us_filing_documents` fields every selector and predicate here reads. */
export interface CohortDocument {
  readonly id?: string;
  readonly accession: string;
  readonly sequence: number;
  readonly cik10?: string;
  readonly symbol?: string | null;
  readonly form?: string;
  readonly documentType?: string;
  readonly filedAt?: Date;
  readonly items?: readonly string[];
  /**
   * EXPLICITLY NULL on 1,963 of 3,509 prod rows — present, and holding null.
   * Not absent: `$exists` is true on all 3,509 (module docblock).
   *
   * Still typed `?: string | null` rather than `: string | null`, because the
   * TYPE has to admit both readings — a `select` that omits the column, or a
   * future switch to the typed Python row, both hand back `undefined` — and a
   * predicate that only handled null would then pass an `undefined` through.
   */
  readonly textPath?: string | null;
  readonly textBytes?: number | null;
  readonly textHash?: string | null;
  readonly extractionStatus?: string;
}

/**
 * Does this document have extracted text to read?
 *
 * The predicate half of `textPath: { not: null, notIn: [""] }`, and it is the
 * shape both halves must agree on: a NON-EMPTY STRING. `typeof x === "string"`
 * rejects null and undefined together, which is what makes the same predicate
 * correct against both storage shapes.
 *
 * Empty string is excluded explicitly because it is a real shape in this repo —
 * 6,125 `stock_documents` rows carry `gcsPath: ""` where the upstream stopped
 * serving the attachment — and an empty key would reach GCS as a request for
 * the bucket root. Measured 0 occurrences in `us_filing_documents` today; it is
 * a guard against a shape this codebase has produced, not a described one.
 *
 * NOTE what this does NOT consult: `extractionStatus`. All 3,509 rows are
 * `PENDING` (zero READY, zero FAILED, zero UNSUPPORTED) because the status
 * column was never advanced when the text was written. Gating on `READY` looks
 * defensive and selects zero. The evidence of text is the PATH.
 */
export function hasExtractedText(doc: CohortDocument): boolean {
  return typeof doc.textPath === "string" && doc.textPath.length > 0;
}

/**
 * Is this document in the analysis cohort?
 *
 * MUST stay in exact agreement with `buildInsightCohortWhere()`. A rule stated
 * twice is a rule that drifts — MONEY-1255 paid for one job that named a GCS
 * object with a substring test while selecting the row with an exact match, so
 * the file was right and the row was unreachable for the life of the table.
 *
 * The two DID disagree, on prod, for the life of this ticket's first draft: the
 * WHERE selected 481 cohort documents and this predicate accepted 477. The four
 * were EX-99 exhibits carrying `textPath: null` — WPM, TMQ, WYNN and one more,
 * all `PRINTER FRIENDLY VERSION` PDFs whose extraction produced nothing. The
 * test evaluates the WHERE against verbatim prod row shapes and asserts it
 * agrees with this function on every one, so the two cannot separate silently.
 */
export function isCohortDocument(doc: CohortDocument): boolean {
  if (
    typeof doc.form !== "string" ||
    !INSIGHT_COHORT_FORMS.includes(doc.form)
  ) {
    return false;
  }
  if (
    typeof doc.documentType !== "string" ||
    !doc.documentType.startsWith(INSIGHT_COHORT_TYPE_PREFIX)
  ) {
    return false;
  }
  // DELIBERATELY NO `items` TEST — see INSIGHT_COHORT_FORMS.
  return hasExtractedText(doc);
}

/**
 * The documents the sweep may analyse.
 *
 * `filedAtFrom` is the BACKFILL's window cursor, not a queue position: the
 * queue position is the absence of an insight row, which the planner computes
 * by diffing. Paging by `filedAt` alone would re-read analysed rows forever.
 */
export function buildInsightCohortWhere(opts?: {
  /** Restrict to a filing window. The history backfill walks forward in slices. */
  filedAtFrom?: Date;
  /** Narrow to specific issuers, for a hand-checked pilot. */
  symbols?: readonly string[];
}): Record<string, unknown> {
  return {
    form: { in: [...INSIGHT_COHORT_FORMS] },
    documentType: { startsWith: INSIGHT_COHORT_TYPE_PREFIX },
    // THE LOAD-BEARING ARM, and it is `not: null` — measured, not assumed.
    //
    // This collection's pymongo writer stores an EXPLICIT NULL for a text-less
    // exhibit (1,963 of 3,509 rows), so `isSet: true` matches 100% of the table
    // and filters nothing. Prisma's `not: null` excludes a null AND an absent
    // attribute — verified at 0 hits against 32,359 genuinely-absent
    // `stock_financials.basis` rows — so it is the correct spelling under both
    // storage shapes and needs no `isSet` companion. See the module docblock
    // for the full measurement.
    //
    // `notIn: [""]` cannot carry this on its own: `$nin` matches null, because
    // null is not "". It guards the empty-string shape only.
    textPath: { not: null, notIn: [""] },
    ...(opts?.filedAtFrom ? { filedAt: { gte: opts.filedAtFrom } } : {}),
    ...(opts?.symbols && opts.symbols.length > 0
      ? { symbol: { in: [...opts.symbols] } }
      : {}),
  };
}

/**
 * THE ROTATION MARKER, ASC.
 *
 * `us_filing_documents` GROWS DAILY — 3,054 rows at first measurement and 3,509
 * a day later. Two measured defects bracket this:
 *
 *   MONEY-1211  ordering by a column CONSTANT across the population hands every
 *               run the same head forever. 681 of 781 symbols were never
 *               selected, with no error and no alert.
 *   MONEY-1255  `desc` is the same defect on a GROWING queue: newest-first does
 *               not merely delay the oldest rows, it pushes them further down
 *               every cycle. 36,001 documents, ~2 years to drain.
 *
 * `filedAt` varies across the population and the sweep consumes from the
 * OLDEST. The two tiebreakers make the order TOTAL: one submission's exhibits
 * share a `filedAt`, and a non-total order lets a cursor page skip or repeat
 * rows arbitrarily.
 */
export function buildInsightCohortOrderBy(): readonly Record<string, "asc">[] {
  return [{ filedAt: "asc" }, { accession: "asc" }, { sequence: "asc" }];
}

/**
 * The unique-key lookup for one document's insight.
 *
 * Prisma's compound-unique argument name for `@@unique([accession, sequence])`.
 * This is the SAME key `UsFilingDocument` uses, which is what makes a
 * re-analysis an update rather than a second row.
 */
export function buildInsightByDocumentWhere(doc: {
  accession: string;
  sequence: number;
}): Record<string, unknown> {
  return {
    accession_sequence: {
      accession: doc.accession,
      sequence: doc.sequence,
    },
  };
}

/**
 * Insights the sweep should revisit: never analysed, or left in a transient
 * failure.
 *
 * `SKIPPED` is NOT here — it is terminal by content, and re-selecting it would
 * spend a model call on the same unanalysable document every night. `READY` is
 * not here either; staleness is decided by `sourceTextHash`, not by status.
 */
export const SWEEPABLE_INSIGHT_STATUS: readonly string[] = [
  INSIGHT_STATUS.PENDING,
  INSIGHT_STATUS.FAILED,
] as const;

/** Insight rows a sweep may re-open, including ones written before a later
 *  column existed. */
export function buildSweepableInsightWhere(): Record<string, unknown> {
  return {
    OR: [
      { insightStatus: { in: [...SWEEPABLE_INSIGHT_STATUS] } },
      // A row written by an older revision, or a partial write, has no status
      // attribute at all — and on THIS table that really is absence, because
      // its only writer is Prisma and both builders omit rather than null.
      // Without this arm such a row is stranded in a state no sweep looks at.
      { insightStatus: { isSet: false } },
    ],
  };
}
