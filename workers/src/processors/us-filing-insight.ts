/**
 * ONE FILING DOCUMENT, ONE MESSAGE — MONEY-1324 (P17).
 *
 * Reads the text `services/us-fundamentals` already extracted to GCS, hands it
 * to the analysis seam, and upserts one `us_filing_insights` row.
 *
 * ## Why the unit is one document
 *
 * MONEY-1314's lesson, applied before the mistake rather than after it. A
 * page-per-message lane needs three mechanisms — a wall clock inside the ack
 * deadline (`RUN_TIME_BUDGET_MS`), a self-chain to reach the rest of the queue
 * (`MAX_CHAIN_DEPTH`), and a cap on how much of the table one selection may
 * consider (`PARSE_SCAN_CAP`) — and it needs all three ONLY BECAUSE the unit of
 * work is larger than the unit of delivery.
 *
 * With one document per message the 600s Pub/Sub ack deadline (Pub/Sub's
 * MAXIMUM; Cloud Run's 3600s never binds) bounds ONE document: a GCS read of a
 * text file that is tens of KB, plus one model call. There is no page to
 * truncate, no remainder to chain to, and no scan to cap. Pub/Sub's own
 * concurrency replaces all three. The constraint is DISSOLVED rather than
 * tuned against.
 *
 * ## Retry posture
 *
 * The processor never rethrows and its route should ACK 200 on every path.
 * A model call that already spent tokens must not be re-run by a redelivery,
 * and a document with no text fails identically forever. What DOES bring a
 * document back is `insightStatus: FAILED`, which the sweep re-selects — the
 * status column is the retry channel, not Pub/Sub.
 *
 * ## The seam
 *
 * `FilingTextAnalyser` is injected. The default is the STUB, which throws:
 * an unwired deployment must fail loudly rather than stamp READY across the
 * cohort. The prompt and the section selection live behind that interface and
 * nothing here reaches around it.
 */

import prisma from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";

// MONEY-1507 (C1 item 4) — the UPDATE event. Imported rather than restated:
// the event id is `sha1(SEC_EDGAR, accession)` and `buildEventId` is the one
// place that is decided.
import { SEC_SOURCE, buildEventId } from "@usemoney/core/events/event-types";
import { enrichEvent } from "@usemoney/services/events";
import { downloadFromGCS } from "../lib/gcs";
import {
  buildInsightByDocumentWhere,
  INSIGHT_STATUS,
  type CohortDocument,
} from "./us-filing-insight-selectors-logic";
import {
  buildInsightFailureUpdate,
  buildInsightFailureWrite,
  buildInsightWrite,
  decideInsightAction,
  filingTextPath,
  isUpstreamSeamFailure,
  notImplementedFilingAnalyser,
  readSeamUsage,
  type ExistingInsight,
  type FilingTextAnalyser,
} from "./us-filing-insight-logic";

/**
 * The metric's job id. DISTINCT from the sweep's `us-filing-insight-sweep`:
 * one job fans out messages and this one reads documents, so folding them
 * into one series would average a publisher's health with a reader's and
 * neither could be alarmed on.
 */
export const US_FILING_INSIGHT_JOB = "us-filing-insight";

const logger = {
  info: (m: string) => console.log(`[us-filing-insight] ${m}`),
  warn: (m: string) => console.warn(`[us-filing-insight] ${m}`),
};

export interface UsFilingInsightMessage {
  /** The one document this message is about. Required — there is no batch. */
  documentId: string;
  /** Re-read a document whose text has not changed. Compared to LITERAL true. */
  force?: boolean;
}

export interface UsFilingInsightOutcome {
  ok: boolean;
  documentId: string;
  /** "analysed" | "skipped" | "failed" */
  action: string;
  reason: string;
  documentClass: string | null;
  insightStatus: string | null;
  /** 1 when a row was written, 0 otherwise. The honest "written" number: a
   *  skip writes nothing and must not be counted as work. */
  written: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /**
   * The UPSTREAM would not answer — a GCS read that failed, or an analyser
   * that named its own transport. Counted separately from `failed` because a
   * blocked upstream is not a row we could not persist, and reporting it as
   * one makes an outage look like a night of unreadable filings
   * (MONEY-1250/1255).
   */
  transportFailures: number;
}

export interface UsFilingInsightDeps {
  /**
   * The `InstrumentEvent` enricher (MONEY-1507). Injected for the same reason
   * `analyser` is: without it a test of this processor would reach real Mongo
   * to prove the enrichment happens at all.
   */
  enrichEvent?: typeof enrichEvent;
  /**
   * The analysis. Injected so the sweep's cohort, idempotency and provenance
   * behaviour are testable without a model, and stay testable when the prompt
   * is rewritten.
   */
  analyser?: FilingTextAnalyser;
  /** Overridable for tests. Real GCS by default. */
  readText?: (path: string) => Promise<string>;
  now?: () => Date;
}

async function defaultReadText(path: string): Promise<string> {
  const buf = await downloadFromGCS(path);
  return buf.toString("utf8");
}

export async function processUsFilingInsight(
  message: UsFilingInsightMessage,
  deps: UsFilingInsightDeps = {},
): Promise<UsFilingInsightOutcome> {
  const analyser = deps.analyser ?? notImplementedFilingAnalyser;
  const readText = deps.readText ?? defaultReadText;
  const now = deps.now ?? (() => new Date());

  const outcome: UsFilingInsightOutcome = {
    ok: true,
    documentId: message.documentId,
    action: "skipped",
    reason: "not-started",
    documentClass: null,
    insightStatus: null,
    written: 0,
    promptTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    transportFailures: 0,
  };

  try {
    const doc = (await prisma.usFilingDocument.findUnique({
      where: { id: message.documentId },
    })) as CohortDocument | null;

    const existing =
      doc === null
        ? null
        : ((await prisma.usFilingInsight.findUnique({
            // The NATURAL key, not the ObjectId — the same key the document
            // uses, which is what makes a re-analysis an update.
            where: buildInsightByDocumentWhere(doc) as never,
          })) as ExistingInsight | null);

    const decision = decideInsightAction(doc, existing, {
      force: message.force === true,
    });
    outcome.reason = decision.reason;

    if (decision.action === "skip" || doc === null) {
      // A SKIP WRITES NOTHING. Not "unless the decision names a status" — the
      // decision has no way to name one, and that is now enforced by the type
      // (`InsightDecision` has no `insightStatus` field; see its comment). This
      // branch used to guard a write on `decision.insightStatus !== undefined`,
      // which no code path ever made true.
      //
      // The rule it was reaching for is still the rule: an out-of-cohort or
      // text-less document must not get a row, or the table stops meaning
      // "documents we read" and its count stops being coverage. The one skip
      // that DOES record a row is `empty-text`, decided below from the bytes
      // this run actually read — which is the only place that fact exists.
      logger.info(`${message.documentId} skip: ${decision.reason}`);
      return outcome;
    }

    const path = filingTextPath(doc);
    if (path === null) {
      // Unreachable given the decision above; kept because "the decision said
      // analyse" and "there is a path" are two statements and only one of them
      // is checked by the type system.
      outcome.reason = "no-extracted-text";
      return outcome;
    }

    let text: string;
    try {
      text = await readText(path);
    } catch (err) {
      // A transient GCS failure. FAILED, so the sweep brings it back — and
      // deliberately WITHOUT the source hash, or the next pass would read
      // "same bytes, already handled" and never retry.
      outcome.transportFailures = 1;
      return await recordFailure(
        doc,
        message.documentId,
        `gcs-read-failed: ${errText(err)}`,
        now(),
        outcome,
      );
    }

    if (text.trim().length === 0) {
      // The object exists and is empty. Terminal by CONTENT: re-reading the
      // same bytes cannot produce a reading, so SKIPPED rather than FAILED,
      // and the hash IS stamped so the finding is durable.
      const row = buildInsightFailureWrite({
        doc,
        documentId: message.documentId,
        status: INSIGHT_STATUS.SKIPPED,
        reason: "empty-text",
        attemptedAt: now(),
      });
      await upsertInsight(doc, row, buildInsightFailureUpdate(row));
      outcome.action = "skipped";
      outcome.reason = "empty-text";
      outcome.insightStatus = INSIGHT_STATUS.SKIPPED;
      outcome.written = 1;
      return outcome;
    }

    let analysis;
    try {
      analysis = await analyser({
        accession: doc.accession,
        sequence: doc.sequence,
        cik10: doc.cik10 ?? "",
        symbol: doc.symbol ?? null,
        form: doc.form ?? "",
        documentType: doc.documentType ?? "",
        filedAt: doc.filedAt ?? now(),
        // `[]` for every 6-K. Passed through as-is; an analyser must not read
        // an empty list as "unknown".
        items: doc.items ?? [],
        text,
        textHash: doc.textHash ?? null,
      });
    } catch (err) {
      // The analyser tags a throw it blames on ITS upstream. Read through the
      // seam's own duck-type, never by importing the model lane — an
      // unclassified throw reads false and is counted as a row failure, which
      // is the safe direction.
      if (isUpstreamSeamFailure(err)) outcome.transportFailures = 1;
      // A REFUSED reading is a completed, BILLED model call. Recording its
      // usage on the failure path is what stops a prompt regression that
      // refuses everything from reading as free — the throw carries the
      // numbers, read through the seam's own duck-type.
      const spent = readSeamUsage(err);
      if (spent !== null) {
        outcome.promptTokens = spent.promptTokens ?? 0;
        outcome.cachedTokens = spent.cachedTokens ?? 0;
        outcome.outputTokens = spent.outputTokens ?? 0;
      }
      return await recordFailure(
        doc,
        message.documentId,
        `analysis-failed: ${errText(err)}`,
        now(),
        outcome,
      );
    }

    const row = buildInsightWrite({
      doc,
      documentId: message.documentId,
      analysis,
      analysedAt: now(),
    });
    await upsertInsight(doc, row);

    // MONEY-1507 (C1 item 4) — the UPDATE event, keyed on the SAME event id the
    // detector produced, which is `sha1(SEC_EDGAR, accession)` and therefore
    // derivable from the accession alone.
    //
    // A PARTIAL update. This processor reads `us_filing_documents`, which
    // carries no `acceptedAt`, so rebuilding the whole event would downgrade
    // `publishedAt` from SEC's acceptance INSTANT to the filing DATE — a clock
    // this repo has already documented as running a business day ahead — on a
    // row that already held the better value.
    //
    // A MISSING event is not a failure: the filing may predate C1, the
    // detector's fail-soft emission may have dropped it, or the 30-day TTL may
    // have reaped it. Counted as `action: "analysed"` either way, because the
    // INSIGHT is this job's product and the event is a projection of it.
    //
    // AFTER `upsertInsight` and in its own try: a throw here must not lose the
    // insight row this job exists to write, and must not re-spend a model call
    // on a redelivery.
    try {
      const enrichment = await (deps.enrichEvent ?? enrichEvent)(
        buildEventId(SEC_SOURCE, doc.accession),
        { summary: analysis.insight.summary, enrichedAt: now() },
      );
      if (!enrichment.enriched) {
        logger.info(
          `${message.documentId} no InstrumentEvent to enrich (${enrichment.reason})`,
        );
      }
    } catch (err) {
      logger.warn(
        `${message.documentId} event enrichment failed: ${errText(err)}`,
      );
    }

    outcome.action = "analysed";
    outcome.documentClass = analysis.insight.documentClass;
    outcome.insightStatus = INSIGHT_STATUS.READY;
    outcome.written = 1;
    outcome.promptTokens = analysis.usage?.promptTokens ?? 0;
    outcome.cachedTokens = analysis.usage?.cachedTokens ?? 0;
    outcome.outputTokens = analysis.usage?.outputTokens ?? 0;
    logger.info(
      `${message.documentId} analysed class=${analysis.insight.documentClass}/` +
        `${analysis.insight.classConfidence} facts=${analysis.insight.facts.length} ` +
        `totals=${analysis.insight.statementTotals.length} ` +
        `events=${analysis.insight.events.length} model=${analysis.modelId} ` +
        `prompt=${analysis.promptVersion} analysedBytes=${analysis.analysedBytes ?? 0}`,
    );
    return outcome;
  } catch (err) {
    // Never rethrow: the route ACKs on every path, and a redelivery would
    // re-spend a model call for a document whose row already records what
    // happened.
    outcome.ok = false;
    outcome.reason = `unhandled: ${errText(err)}`;
    logger.warn(`${message.documentId} ${outcome.reason}`);
    return outcome;
  } finally {
    // In a `finally`, so EVERY exit emits — the success path, the four skip
    // paths, the two failure paths and the unhandled catch. `notify_no_data`
    // is the default posture for these monitors, and a monitor that has never
    // been green is a monitor somebody mutes. `stock-document-extract` put
    // this below an early return and emitted nothing on an idle night, which
    // is the same defect one placement over (MONEY-1238).
    //
    // `written` IS NOT `outcome.written`, deliberately. That field counts ROWS
    // PERSISTED and a FAILED/SKIPPED attempt persists one; this metric counts
    // READINGS. Reporting the attempt row as written would make a night in
    // which every document was refused by the grounding check emit a perfect
    // `selected 1, written 1` — the exact silence this module exists to break.
    const storedAReading =
      outcome.insightStatus === INSIGHT_STATUS.READY ? 1 : 0;
    reportJobOutcome({
      job: US_FILING_INSIGHT_JOB,
      // One document per message: the unit of work IS the unit of delivery.
      selected: 1,
      written: storedAReading,
      // `failed` AND `transportFailures` are DIFFERENT UNITS and a single
      // event is exactly one of them. This used to set both on every upstream
      // failure, which is the conflation the field's own docstring above
      // forbids and `circulars-sync` / `institutional-flow-sync` get right in
      // this same branch: a blocked upstream is not a row we could not
      // persist, it is a call that did not answer (MONEY-1250/1255). Reported
      // as both, a dead Gemini is indistinguishable from a night of filings
      // the model read and disbelieved — and only the second is our data's
      // fault.
      //
      // A REFUSED reading still counts as `failed`: the call answered, we
      // disbelieved it, and no transport was involved.
      failed:
        outcome.action === "failed" && outcome.transportFailures === 0 ? 1 : 0,
      transportFailures: outcome.transportFailures,
      // Required reading whenever selected > 0 and written === 0 — "0 written"
      // with no reason is the silence this metric replaces. A skip is the
      // ORDINARY case here (an unchanged document is most of every sweep), so
      // it must say which kind of nothing it did.
      skippedReason: storedAReading === 0 ? outcome.reason : undefined,
    });
  }
}

async function recordFailure(
  doc: CohortDocument,
  documentId: string,
  reason: string,
  at: Date,
  outcome: UsFilingInsightOutcome,
): Promise<UsFilingInsightOutcome> {
  const row = buildInsightFailureWrite({
    doc,
    documentId,
    status: INSIGHT_STATUS.FAILED,
    reason,
    attemptedAt: at,
  });
  await upsertInsight(doc, row, buildInsightFailureUpdate(row));
  outcome.ok = false;
  outcome.action = "failed";
  outcome.reason = reason;
  outcome.insightStatus = INSIGHT_STATUS.FAILED;
  outcome.written = 1;
  return outcome;
}

/**
 * Upsert on the natural key.
 *
 * The unique index is what makes this atomic: two concurrent deliveries both
 * miss, MongoDB serialises them on the index, and one update wins rather than
 * two rows appearing that no reader can tell apart.
 *
 * `ingestedAt` / `updatedAt` are PRISMA-APPLIED (`@default(now())` /
 * `@updatedAt`), and this is the only writer, so neither can ever be absent —
 * the P2032 failure MONEY-1317 measured at 785,352 rows across seven
 * collections comes from a pymongo writer, which this table does not have.
 */
async function upsertInsight(
  doc: CohortDocument,
  create: Record<string, unknown>,
  update: Record<string, unknown> = create,
): Promise<void> {
  await prisma.usFilingInsight.upsert({
    where: buildInsightByDocumentWhere(doc) as never,
    create: create as never,
    // DEFAULTS TO `create`, and the two differ for exactly one caller. A
    // reading's payload sets every column it owns, so create and update agree.
    // A FAILURE's payload OMITS the reading columns — correct on a create,
    // and on an update an omitted key is simply not written, so re-failing a
    // previously-READY row left the old `facts`/`summary` sitting under
    // `UNCLASSIFIED`/`FAILED`. `buildInsightFailureUpdate` turns those
    // omissions into `unset`, which retracts them.
    update: update as never,
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
