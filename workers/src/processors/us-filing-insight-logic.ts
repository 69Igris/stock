/**
 * What the filing-insight sweep DECIDES, and the SEAM it hands the analysis to.
 * MONEY-1324 (P17).
 *
 * PURE. No Prisma, no GCS, no model client, no clock. The orchestrator does I/O
 * and asks this module every question that has a right answer.
 *
 * ## The seam, and what is deliberately NOT here
 *
 * `FilingTextAnalyser` is the whole contract between this sweep and the
 * analysis: TEXT IN, STRUCTURED INSIGHT OUT. The prompt, the model call and the
 * SECTION SELECTION that decides which part of a 300 KB exhibit is worth
 * sending are all behind it and are owned elsewhere. Nothing in this file or in
 * the processor may reach around it.
 *
 * That boundary is not bookkeeping. The sweep's correctness — cohort,
 * idempotency, rotation, provenance — is testable with a two-line fake, and
 * stays testable when the prompt is rewritten. `notImplementedFilingAnalyser`
 * is the default so an unwired deployment FAILS LOUDLY at the seam rather than
 * writing thousands of empty insights that look analysed.
 *
 * ## The shape of the answer, and why one shape
 *
 * The cohort is measurably heterogeneous. The EX-99.1 read while designing this
 * (Hornbeck Offshore, 0001193125-26-378529 seq 11) opens "Exhibit 99.1 …
 * CONSOLIDATED FINANCIAL STATEMENTS" and contains an audit opinion — it is
 * attached to a MERGER 8-K carrying items 1.01/2.01/5.01, and it is not an
 * earnings release at all. An earnings-shaped schema would have had to either
 * reject it or record it wrongly.
 *
 * So: ONE shape, a `documentClass` discriminator, and every field below it
 * optional. A new class costs a new enum value and no migration; a
 * MISCLASSIFIED document degrades to fewer fields rather than failing.
 */

import type { FilingInsight } from "@usemoney/core/market-data/filing-insight-logic";

import {
  SWEEP_ONLY_DOCUMENT_CLASS,
  INSIGHT_STATUS,
  hasExtractedText,
  isCohortDocument,
  type CohortDocument,
} from "./us-filing-insight-selectors-logic";

/* ─────────────────────────────────────────────────────────────────────────
   THE READING

   THERE ARE NO BLOCK INTERFACES HERE ANY MORE, AND THAT IS THE POINT.

   This module used to declare `EarningsBlock` / `GuidanceBlock` /
   `StatementsBlock` / `TransactionBlock` and call them "the contract". They
   were a contract with nobody: the analyser produces `facts`,
   `statementTotals` and `events`, and — decisively — its two validators read
   those. `checkFactsGrounded` walks `facts` and every total's `components`
   and requires each figure to appear in the text the model was SHOWN;
   `checkTotalsCrossFoot` walks `statementTotals` and adds the components up.

   Re-shaping the reading into typed blocks on the way to the database would
   have meant the stored row is not the object either check ever looked at. A
   reader would trust a row that had been validated in a different shape, and
   nothing on either side would say so. That is worse than skipping validation,
   because it is invisible from both ends.

   So the seam carries `FilingInsight` ITSELF — the exact object
   `validateFilingInsight` was handed — and `buildInsightWrite` stores its
   fields one for one. The alignment is now structural: a future change to the
   analyser's shape breaks this file at compile time instead of quietly
   un-validating the table.
   ──────────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────────
   THE SEAM
   ──────────────────────────────────────────────────────────────────────── */

/** What the analyser is handed. */
export interface FilingTextAnalysisRequest {
  readonly accession: string;
  readonly sequence: number;
  readonly cik10: string;
  readonly symbol: string | null;
  readonly form: string;
  readonly documentType: string;
  readonly filedAt: Date;
  /** `[]` for every 6-K — foreign private issuers file no item numbers. An
   *  analyser must not treat an empty list as "unknown". */
  readonly items: readonly string[];
  /**
   * The FULL extracted text from GCS. Section selection is the ANALYSER's job:
   * it is the half that knows the token budget and the prompt, and doing it
   * here would put a model-shaped decision in a database-shaped module.
   */
  readonly text: string;
  /** For the analyser's own caching. The sweep's idempotency does not rely on
   *  the analyser honouring it. */
  readonly textHash: string | null;
}

export interface TokenUsage {
  readonly promptTokens?: number;
  readonly cachedTokens?: number;
  readonly outputTokens?: number;
}

/**
 * What the analyser must return: THE VALIDATED READING, plus the provenance
 * only the caller of the model can know.
 *
 * `insight` is the object `validateFilingInsight` was handed, unaltered —
 * never a re-shaped copy of it. See THE READING above for why that is the
 * whole design and not a convenience.
 *
 * A DEGRADED reading is a legal one: `normaliseFilingInsight` answers
 * `documentClass: "OTHER"`, `classConfidence: "LOW"` and three empty lists
 * for a response it could barely read, and that IS the required failure mode
 * — fewer fields, never an exception. The analyser's own contract is that it
 * degrades rather than throwing; the SEAM's contract is that it throws rather
 * than returning a reading it does not stand behind. Those are different
 * statements and the adapter between them is where they meet.
 */
export interface FilingTextAnalysis {
  /** EXACTLY the object the validators inspected. Stored field for field. */
  readonly insight: FilingInsight;
  /** The model id that produced this. Recorded as provenance, never as key. */
  readonly modelId: string;
  /** Prompt + parser revision, so a prompt change is a detectable cause of a
   *  changed reading. */
  readonly promptVersion: string;
  /** Bytes actually SENT, which is not `textBytes` once sections are selected
   *  — so spend is attributable to what was sent, not to what was stored. */
  readonly analysedBytes?: number;
  readonly usage?: TokenUsage;
}

export type FilingTextAnalyser = (
  request: FilingTextAnalysisRequest,
) => Promise<FilingTextAnalysis>;

/**
 * A tag an analyser MAY put on its throw: "this was the UPSTREAM, not the
 * document".
 *
 * Declared HERE, in the seam, so it is one rule in one place. The processor
 * needs the distinction to report `transportFailures` honestly — a Gemini
 * outage that counts as `failed` is indistinguishable from a night of
 * documents the model read and disbelieved, and only one of those is worth
 * waking somebody for (MONEY-1250/1255). But the processor must NOT import the
 * model lane to learn it, or the seam stops buying the thing it exists for.
 *
 * So: a duck-type, not a base class. The adapter sets it; anything else
 * throwing a plain `Error` simply reads false, which is the safe answer —
 * an unclassified failure is counted as a row failure, never as a free pass.
 */
export interface UpstreamSeamFailure {
  readonly upstreamFailure?: boolean;
  /**
   * Tokens the refused call ALREADY SPENT.
   *
   * A REJECTION is a completed model call whose answer the checks refused, so
   * it costs exactly what a stored reading costs. Without this the failure path
   * reported `promptTokens: 0` and the FAILED row recorded no spend at all —
   * so a prompt regression that refuses every reading looked FREE on the one
   * dashboard that would have shown it, while billing carried on.
   *
   * Optional, and read through the same duck-type as `upstreamFailure`: a
   * transport throw never got an answer and correctly carries no usage.
   */
  readonly usage?: TokenUsage;
}

/** Is this throw the analyser telling us its UPSTREAM would not answer? */
export function isUpstreamSeamFailure(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as UpstreamSeamFailure).upstreamFailure === true
  );
}

/**
 * Tokens a THROWN analyser call already spent, if it says so.
 *
 * Same duck-type discipline as `isUpstreamSeamFailure` — the processor must not
 * import the model lane to learn this. A throw carrying no usage, or a
 * non-numeric one, reads as `null`, and the caller records nothing rather than
 * a fabricated zero: "the call spent nothing" and "we do not know what the call
 * spent" are different claims and only one of them is ever true here.
 */
export function readSeamUsage(err: unknown): TokenUsage | null {
  if (typeof err !== "object" || err === null) return null;
  const usage = (err as UpstreamSeamFailure).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const out: TokenUsage = {
    promptTokens: num(usage.promptTokens),
    cachedTokens: num(usage.cachedTokens),
    outputTokens: num(usage.outputTokens),
  };
  return out.promptTokens === undefined &&
    out.cachedTokens === undefined &&
    out.outputTokens === undefined
    ? null
    : out;
}

/** Thrown by the stub. Named so an unwired deployment is unmistakable in logs. */
export class FilingAnalyserNotWiredError extends Error {
  constructor() {
    super(
      "MONEY-1324: no FilingTextAnalyser is wired. The sweep resolved its " +
        "analysis seam to the stub, which never returns a reading. Inject the " +
        "real analyser at the call site.",
    );
    this.name = "FilingAnalyserNotWiredError";
  }
}

/**
 * THE STUB. Throws; it never returns a plausible-looking empty insight.
 *
 * Returning `{documentClass: UNCLASSIFIED}` would be the friendlier default and
 * is the wrong one: the sweep would stamp READY on every document in the
 * cohort, the queue would drain, the counters would look healthy, and the
 * table would fill with rows that had never been read. A job that writes
 * nothing and says why is recoverable; a job that writes empty rows over a
 * one-shot queue is not.
 */
export const notImplementedFilingAnalyser: FilingTextAnalyser = () => {
  throw new FilingAnalyserNotWiredError();
};

/* ─────────────────────────────────────────────────────────────────────────
   THE DECISION
   ──────────────────────────────────────────────────────────────────────── */

/** The `us_filing_insights` fields the decision reads. */
export interface ExistingInsight {
  readonly insightStatus?: string | null;
  readonly sourceTextHash?: string | null;
  readonly promptVersion?: string | null;
}

export type InsightAction = "analyse" | "skip";

export interface InsightDecision {
  readonly action: InsightAction;
  /** Operator-facing, always populated — including on the happy path. */
  readonly reason: string;
  /*
   * THERE IS DELIBERATELY NO `insightStatus` HERE, and its absence is the
   * contract rather than an omission.
   *
   * It used to be declared, as "the status to record when the skip is a fact
   * worth storing" — and NO code path ever set it. Every one of the five skips
   * below is a reason NOT to write: `document-not-found` has no row to write
   * against, `no-extracted-text` and `out-of-cohort` must not get a row or the
   * table stops meaning "documents we read", and `unchanged-text` /
   * `terminal-skipped` already have the row they would write.
   *
   * So the processor's `if (decision.insightStatus !== undefined)` branch was
   * unreachable code guarding a capability nothing wanted. Removing the field
   * makes "a skip writes nothing" a property of the TYPE instead of a claim in
   * a comment — the caller can no longer ask for a write on this path even by
   * mistake. The one skip that DOES record a row (`empty-text`) is decided in
   * the processor from the bytes it read, which is the only place that fact
   * exists.
   */
}

/**
 * Are these two text hashes the SAME KNOWN value?
 *
 * The idempotency test, and the one place a convenience default would silently
 * destroy it. Two ABSENT hashes are not equal — they are two unknowns, and
 * treating `undefined === undefined` as "unchanged" would make every
 * hash-less document permanently skipped after one pass, with a READY row and
 * no reading behind it.
 *
 * `textHash` is `str | None` on the Python row, and on prod it is an EXPLICIT
 * NULL on 1,963 of 3,509 rows — not an absent key. (`Row.to_doc()` would have
 * dropped the None, but nothing calls it for this collection; see the selectors
 * module docblock.) The `typeof !== "string"` test covers null and undefined
 * together, so this predicate is correct under either storage shape — which is
 * the only reason the mistaken premise never reached this function.
 */
export function isSameKnownHash(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (typeof a !== "string" || a.length === 0) return false;
  if (typeof b !== "string" || b.length === 0) return false;
  return a === b;
}

/**
 * Should this document be analysed?
 *
 * ORDER IS LOAD-BEARING. Cohort membership is checked before staleness, so a
 * document that leaves the cohort (its text was cleared, say) is not re-read
 * on the strength of a changed hash.
 */
export function decideInsightAction(
  doc: CohortDocument | null,
  existing: ExistingInsight | null,
  opts?: { readonly force?: boolean },
): InsightDecision {
  if (doc === null) {
    // A message naming a row that is gone. Nothing to record it against — the
    // insight key is the DOCUMENT's key, so there is no row to write.
    return { action: "skip", reason: "document-not-found" };
  }

  if (!hasExtractedText(doc)) {
    // The 1,963 rows whose `textPath` is NULL, 1,956 GRAPHIC among them
    // (measured on prod 2026-09-02). Not an error and not a row: there is
    // nothing to read and never will be until extraction runs.
    return { action: "skip", reason: "no-extracted-text" };
  }

  if (!isCohortDocument(doc)) {
    return {
      action: "skip",
      reason: `out-of-cohort form=${doc.form ?? "?"} type=${doc.documentType ?? "?"}`,
    };
  }

  // `force` is deliberately AFTER the cohort gates and BEFORE the staleness
  // one: a manual re-run may re-read an unchanged document, but it may not
  // conjure text that does not exist.
  if (opts?.force === true) {
    return { action: "analyse", reason: "forced" };
  }

  if (existing !== null) {
    const unchanged = isSameKnownHash(existing.sourceTextHash, doc.textHash);

    if (unchanged && existing.insightStatus === INSIGHT_STATUS.READY) {
      // THE IDEMPOTENCY RULE. Same bytes, already read: writing again would
      // spend a model call to produce the row that is already there.
      return { action: "skip", reason: "unchanged-text" };
    }

    if (unchanged && existing.insightStatus === INSIGHT_STATUS.SKIPPED) {
      // Terminal by CONTENT. Re-selecting it buys the same non-answer on every
      // sweep forever — the reason SKIPPED is not spelled FAILED.
      return { action: "skip", reason: "terminal-skipped" };
    }
  }

  return {
    action: "analyse",
    reason: existing === null ? "never-analysed" : "text-changed-or-retry",
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   THE WRITE PAYLOAD
   ──────────────────────────────────────────────────────────────────────── */

export interface InsightWriteInput {
  readonly doc: CohortDocument;
  readonly documentId: string;
  readonly analysis: FilingTextAnalysis;
  readonly analysedAt: Date;
}

/**
 * The column set for a create/update.
 *
 * ABSENT, NEVER NULL. Every optional key is omitted when the analysis did not
 * produce it, rather than written as `null`. On Mongo a null is unqueryable in
 * BOTH directions — `{f: null}` and `{f: {not: null}}` each return zero — so an
 * explicitly-null block is strictly worse than a missing one, and it also
 * overwrites whatever a previous, better reading stored.
 */
export function buildInsightWrite(
  input: InsightWriteInput,
): Record<string, unknown> {
  const { doc, documentId, analysis, analysedAt } = input;
  const insight = analysis.insight;

  const row: Record<string, unknown> = {
    accession: doc.accession,
    sequence: doc.sequence,
    documentId,
    cik10: doc.cik10 ?? "",
    form: doc.form ?? "",
    documentType: doc.documentType ?? "",
    documentClass: insight.documentClass,
    classConfidence: insight.classConfidence,
    // ALWAYS written, and the reason is arithmetic rather than tidiness:
    // figures are stored AS PRINTED, so a `facts` array without its scale is a
    // column of numbers that may be off by 1,000x with nothing on the row to
    // say so. `normaliseFilingInsight` guarantees a value — "UNKNOWN" when the
    // document states no units header, which is a claim we can make honestly.
    unitScale: insight.unitScale,
    insightStatus: INSIGHT_STATUS.READY,
    model: analysis.modelId,
    promptVersion: analysis.promptVersion,
    analysedAt,
    summary: insight.summary,
    // Lists have a natural zero and `[]` is queryable, so they are always set.
    keyPoints: [...insight.keyPoints],
    // THE VALIDATED OBJECTS, copied out and stored as the checks saw them. A
    // READY row always carries all three; `[]` is a real answer (a proxy
    // circular prints no statement totals) and is queryable, where a missing
    // key would be indistinguishable from a row written before the column
    // existed.
    facts: [...insight.facts],
    statementTotals: [...insight.statementTotals],
    events: [...insight.events],
  };

  if (doc.filedAt) row.filedAt = doc.filedAt;
  if (typeof doc.symbol === "string" && doc.symbol.length > 0)
    row.symbol = doc.symbol;

  // The idempotency key. Written only when the document HAS one — a fabricated
  // empty string would make every hash-less document look unchanged forever.
  //
  // It is the DOCUMENT's `textHash`, not a hash of the bytes this run read,
  // and that is deliberate: `decideInsightAction` compares this column against
  // `doc.textHash`, so any other value — however more honest about the bytes —
  // would never compare equal and the next sweep would re-analyse forever.
  if (typeof doc.textHash === "string" && doc.textHash.length > 0) {
    row.sourceTextHash = doc.textHash;
  }

  // ABSENT, NEVER NULL. `normaliseFilingInsight` returns null for a field the
  // document did not state, and a null here is unqueryable in BOTH directions
  // on Mongo — so "the filing named no registrant" is written by leaving the
  // key off, which is the same shape every other absent attribute has.
  if (typeof insight.registrant === "string" && insight.registrant.length > 0) {
    row.registrant = insight.registrant;
  }
  if (
    typeof insight.periodLabel === "string" &&
    insight.periodLabel.length > 0
  ) {
    row.periodLabel = insight.periodLabel;
  }
  if (
    typeof insight.periodEndDate === "string" &&
    insight.periodEndDate.length > 0
  ) {
    row.periodEndDate = insight.periodEndDate;
  }
  if (
    typeof insight.reportingCurrency === "string" &&
    insight.reportingCurrency.length > 0
  ) {
    row.reportingCurrency = insight.reportingCurrency;
  }

  if (typeof analysis.analysedBytes === "number") {
    row.analysedBytes = analysis.analysedBytes;
  }

  const usage = analysis.usage;
  if (typeof usage?.promptTokens === "number")
    row.promptTokens = usage.promptTokens;
  if (typeof usage?.cachedTokens === "number")
    row.cachedTokens = usage.cachedTokens;
  if (typeof usage?.outputTokens === "number")
    row.outputTokens = usage.outputTokens;

  return row;
}

/**
 * Every column a READING sets and a failure row does not.
 *
 * Derived, never hand-maintained in two places: `us-filing-insight-logic.test.ts`
 * runs `buildInsightWrite` against a maximal analysis, diffs its keys against
 * `buildInsightFailureWrite`'s, and asserts this list is exactly the
 * difference. So a new column added to the reading cannot quietly escape the
 * clear below — the test goes red on the day it is added, not a quarter later
 * when somebody notices a FAILED row carrying facts.
 *
 * `keyPoints` is NOT here: it is a required scalar list, and both builders
 * already SET it (`[]` on a failure), so it is cleared by assignment.
 */
export const INSIGHT_READING_FIELDS: readonly string[] = [
  "analysedBytes",
  "cachedTokens",
  "classConfidence",
  "events",
  "facts",
  "model",
  "outputTokens",
  "periodEndDate",
  "periodLabel",
  "promptTokens",
  "promptVersion",
  "registrant",
  "reportingCurrency",
  "sourceTextHash",
  "statementTotals",
  "summary",
  "unitScale",
] as const;

/**
 * Turn a failure/skip CREATE payload into the UPDATE payload for the same row.
 *
 * THE CREATE AND THE UPDATE CANNOT BE THE SAME OBJECT, and that is the defect
 * this function exists for. `buildInsightFailureWrite` documents that a failure
 * row carries "no facts/totals/events at all" — true of a CREATE, and false of
 * an UPDATE. Handed to `upsert({create: row, update: row})`, an omitted key is
 * simply not written, so re-failing a previously-READY document left
 * `insightStatus: FAILED` and `documentClass: UNCLASSIFIED` sitting beside the
 * PREVIOUS reading's `facts`, `summary` and token counts. The row then claims
 * nothing while carrying everything, and a reader that trusts `facts` without
 * re-checking the status gets a reading attributed to an attempt that failed.
 *
 * `unset` is Prisma's MongoDB operator for REMOVING a field, so the cleared row
 * has the same ABSENT shape a freshly-created failure row has — not a null,
 * which on Mongo is unqueryable in both directions and is exactly what
 * `buildInsightWrite` goes out of its way never to store.
 *
 * Only keys the create payload does NOT carry are cleared, so a SKIPPED row's
 * legitimately-stamped `sourceTextHash` survives while a FAILED row's stale one
 * is removed — the same rule, applied from the payload rather than restated.
 */
export function buildInsightFailureUpdate(
  createRow: Record<string, unknown>,
): Record<string, unknown> {
  const update: Record<string, unknown> = { ...createRow };
  for (const field of INSIGHT_READING_FIELDS) {
    if (!(field in createRow)) update[field] = { unset: true };
  }
  return update;
}

/**
 * The column set for a FAILED or SKIPPED outcome — the CREATE payload.
 *
 * Records the attempt without claiming a reading: no `documentClass` beyond
 * `UNCLASSIFIED`, and NO `facts` / `statementTotals` / `events` at all — those
 * three are ABSENT here rather than `[]`, because an empty list is a reading
 * that found nothing and this row is not a reading. Critically, also NO
 * `sourceTextHash` on a
 * FAILURE. Stamping the hash on a failed attempt would make the next sweep read
 * "same bytes, already handled" and never retry, which is how a transient model
 * error becomes permanent. A SKIPPED row DOES carry it, because that outcome is
 * terminal by content and re-reading the same bytes cannot change it.
 *
 * FOR AN UPDATE, PASS THIS THROUGH `buildInsightFailureUpdate` — omitting a key
 * writes nothing, so on a row that was previously READY the omission preserves
 * the old reading instead of retracting it. See that function.
 */
export function buildInsightFailureWrite(input: {
  readonly doc: CohortDocument;
  readonly documentId: string;
  readonly status: typeof INSIGHT_STATUS.FAILED | typeof INSIGHT_STATUS.SKIPPED;
  readonly reason: string;
  readonly attemptedAt: Date;
}): Record<string, unknown> {
  const { doc, documentId, status, reason, attemptedAt } = input;

  const row: Record<string, unknown> = {
    accession: doc.accession,
    sequence: doc.sequence,
    documentId,
    cik10: doc.cik10 ?? "",
    form: doc.form ?? "",
    documentType: doc.documentType ?? "",
    documentClass: SWEEP_ONLY_DOCUMENT_CLASS,
    insightStatus: status,
    failureReason: reason.slice(0, 500),
    analysedAt: attemptedAt,
    keyPoints: [],
  };

  if (doc.filedAt) row.filedAt = doc.filedAt;
  if (typeof doc.symbol === "string" && doc.symbol.length > 0)
    row.symbol = doc.symbol;

  if (
    status === INSIGHT_STATUS.SKIPPED &&
    typeof doc.textHash === "string" &&
    doc.textHash.length > 0
  ) {
    row.sourceTextHash = doc.textHash;
  }

  return row;
}

/** The GCS object holding a document's extracted text. */
export function filingTextPath(doc: CohortDocument): string | null {
  return hasExtractedText(doc) ? (doc.textPath as string) : null;
}
