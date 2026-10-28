/**
 * ONE DOCUMENT, ONE MESSAGE — MONEY-1314.
 *
 * The lane that replaces `stock-document-parse`. The difference that matters is
 * not the model or the markdown; it is the UNIT.
 *
 * ## Why one document per message removes three mechanisms
 *
 * The old lane processed a PAGE of documents per message, which forced:
 *
 *   - `RUN_TIME_BUDGET_MS`, a wall clock inside the 600s ack deadline, so a
 *     page could stop part-way;
 *   - `MAX_CHAIN_DEPTH`, a self-chain to reach the rest of the queue;
 *   - `PARSE_SCAN_CAP`, a ceiling on how much of the table a single selection
 *     may consider — already breached at 48,322 against 40,000.
 *
 * All three exist because the unit of work was larger than the unit of
 * delivery. With one document per message the 600s deadline bounds ONE
 * document, which needs a fraction of it: the slowest conversion measured is
 * 980 ms for a 311-page annual report, and a model call is bounded by
 * `DOC_PARSE_BUDGET_MS`. There is no page to truncate, no remainder to chain
 * to, and no scan to cap. Pub/Sub's own concurrency replaces all of it.
 *
 * ## The lane transitions, in one message
 *
 *     convert -> markdown -> (gate fails) -> vision
 *
 * A message may do all three. That is deliberate and is what the deadline
 * headroom buys: splitting them would need a state machine across
 * redeliveries, and a redelivery is not a state transition — it is the same
 * message again.
 *
 * ## Retry posture
 *
 * The route ACKs 200 on every path INCLUDING a throw, and this processor never
 * rethrows. Every failure class here is either deterministic (an unreadable
 * document fails identically forever) or expensive to repeat (a model call
 * that already spent tokens). A redelivery would re-run a paid call for a
 * document whose row already records what happened. The freshness monitor, not
 * Pub/Sub's retry, is what notices a dead lane.
 */

import prisma from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { mapDocumentFinancials } from "@usemoney/core/market-data/document-financials-logic";
import { selectPagesForExtraction } from "@usemoney/core/market-data/page-select-logic";
import { normaliseDocumentMarkdown } from "@usemoney/core/market-data/doc-number-normaliser-logic";

import { downloadFromGCS, uploadToGCS } from "../lib/gcs";
import { convertPdfToMarkdown } from "../lib/doc-convert";
import {
  parseMarkdownFinancials,
  parsePdfFinancials,
  resolveDocParseModel,
  type DocParseResult,
} from "../lib/gemini-pdf";
import { buildGcsUri } from "./stock-document-extract-logic";
import {
  buildPromptText,
  type DocRequestContext,
} from "../lib/gemini-doc-request-logic";
import { markParseStatus, upsertExtract } from "./doc-extract-persist";
import {
  decideIngestLane,
  exceedsVisionCeiling,
  TERMINAL_PARSE_STATUSES,
  classifyIngestOutcome,
  type IngestDocState,
  splitPageMarkedMarkdown,
  INGEST_PARSE_STATUS,
  isVisionArmed,
} from "./stock-document-ingest-logic";
import {
  CONVERT_STATUS,
  buildConvertClaimWhere,
} from "./doc-ingest-selectors-logic";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

const logger = {
  info: (m: string) => console.log(`[stock-document-ingest] ${m}`),
  warn: (m: string) => console.warn(`[stock-document-ingest] ${m}`),
};

export interface StockDocumentIngestMessage {
  /** The one document this message is about. Required — there is no batch. */
  documentId: string;
  /** Re-ingest a document that already reached a terminal status. */
  force?: boolean;
  /** Validated against the registry before use; an unknown id is ignored. */
  modelOverride?: string | null;
}

export interface IngestOutcome {
  ok: boolean;
  documentId: string;
  lane: string;
  parseStatus: string | null;
  extractedRows: number;
  invalidRows: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reason: string | null;
}

/** The markdown sidecar for a document, mirroring `.extracted.txt`. */
export function markdownSidecarPath(gcsPath: string): string {
  return `${gcsPath}.md`;
}

/**
 * Entry point for the `doc-ingest` job. The body lives in `runStockDocumentIngest`; this wrapper
 * exists only to tag every model call underneath it with
 * `ml_app: doc-ingest` (MONEY-1380).
 *
 * Tagging here rather than at the call sites works because dd-trace resolves an
 * LLM span's `ml_app` from its nearest LLMObs parent, so calls several packages
 * deep inherit it without knowing this file exists.
 */
export async function processStockDocumentIngest(
  message: StockDocumentIngestMessage,
): Promise<IngestOutcome> {
  return llmWorkflow("doc-ingest", "doc-ingest", () =>
    runStockDocumentIngest(message),
  );
}

async function runStockDocumentIngest(
  message: StockDocumentIngestMessage,
): Promise<IngestOutcome> {
  const startedAt = Date.now();
  let lane = "none";
  let parseStatus: string | null = null;
  let extractedRows = 0;
  let invalidRows = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let reason: string | null = null;
  let transportFailures = 0;
  let ok = true;

  try {
    const doc = await prisma.stockDocument.findUnique({
      where: { id: message.documentId },
      select: {
        id: true,
        instrumentId: true,
        symbol: true,
        exchange: true,
        docType: true,
        period: true,
        title: true,
        gcsPath: true,
        mimeType: true,
        // MONEY-1314 — the column is `fileSize`; `IngestDocState` calls it
        // `fileBytes`. Omitting it typechecks silently and makes
        // `exceedsVisionCeiling` (unknown size = too large, by design)
        // permanently TRUE, which marks every scanned document UNREADABLE and
        // makes the vision lane unreachable.
        fileSize: true,
        parseStatus: true,
        convertStatus: true,
        markdownGcsPath: true,
        scannedPageCount: true,
        textPageCount: true,
      },
    });

    if (!doc) {
      // NOT an error: a document deleted between publish and delivery is an
      // ordinary at-least-once outcome, and a 500 here would redeliver a
      // message that can never succeed until it dead-letters.
      reason = "document not found";
      return finish();
    }

    const label = `${doc.symbol} (${doc.docType}/${doc.period})`;

    // ── already read? ────────────────────────────────────────────────────
    //
    // `parseStatus` was selected and never consulted, and `message.force` —
    // documented as "re-ingest a document that already reached a terminal
    // status" — reached only the CONVERT claim, so the contract was
    // unimplemented for the expensive half.
    //
    // It matters because the announce is not once-per-document. The BSE and
    // NSE writers call `publishDocumentIngest` on EVERY upsert including a
    // no-change re-sync (30,956 quarterly_result rows alone), and Pub/Sub is
    // at-least-once. Without this, each weekly re-sync of an already-read
    // document went straight to a paid model call on an unchanged sidecar.
    // The route's own docblock names the risk and the processor did not check.
    if (
      message.force !== true &&
      TERMINAL_PARSE_STATUSES.includes(doc.parseStatus ?? "")
    ) {
      parseStatus = doc.parseStatus;
      reason = `already ${doc.parseStatus} — pass force:true to re-read`;
      lane = "skip";
      logger.info(`${label}: ${reason}`);
      return finish();
    }

    // ONE mutable view of the row, and every later read goes through it.
    //
    // The bug this replaces: the convert branch wrote the sidecar path into a
    // LOCAL, spread it into the throwaway object handed to `decideIngestLane`,
    // and then passed the ORIGINAL `doc` to `runLane` — whose markdown branch
    // reads `markdownGcsPath`, still null from the database. Every document
    // converted in the same message paid for the conversion, uploaded the
    // sidecar, and then threw on `downloadFromGCS(null)`. That is the entire
    // 48,322-document corpus and every new PDF under realtime.
    let state: IngestDocState & { id: string } = {
      id: doc.id,
      gcsPath: doc.gcsPath,
      mimeType: doc.mimeType,
      fileBytes: doc.fileSize,
      convertStatus: doc.convertStatus,
      markdownGcsPath: doc.markdownGcsPath,
      scannedPageCount: doc.scannedPageCount,
      textPageCount: doc.textPageCount,
    };

    // ── convert, if it has never been converted ──────────────────────────
    let decision = decideIngestLane(state, {
      visionDisabled: !isVisionArmed(),
    });
    lane = decision.lane;

    if (decision.lane === "convert") {
      // `updateMany`, never `update`: `update` THROWS when it matches nothing,
      // while a zero count is an ordinary outcome here.
      //
      // NOT a claim, despite the name — see `buildConvertClaimWhere`. The
      // value written is one the predicate also matches, so two concurrent
      // deliveries both succeed. `count === 0` means the row reached a
      // converted state between the read and here, which is worth skipping;
      // it does NOT mean another worker holds it. Duplicate conversions are
      // possible and harmless: same sidecar, same key, same bytes.
      const claimed = await prisma.stockDocument.updateMany({
        where: buildConvertClaimWhere(doc.id, message.force === true),
        data: { convertStatus: CONVERT_STATUS.PENDING },
      });
      if (claimed.count === 0) {
        reason = "already converted between the read and the claim";
        return finish();
      }

      const bytes = await downloadFromGCS(doc.gcsPath);
      const converted = await convertPdfToMarkdown({ bytes, label });

      let markdownGcsPath: string | null = null;
      if (converted.status === "CONVERTED" && converted.markdown) {
        markdownGcsPath = markdownSidecarPath(doc.gcsPath);
        await uploadToGCS(
          markdownGcsPath,
          Buffer.from(converted.markdown, "utf8"),
          "text/markdown; charset=utf-8",
        );
      }

      // MONEY-1315 — CORRECT `fileSize` WHEN THE STORED OBJECT WAS AN ENVELOPE.
      //
      // `stock_documents.fileSize` records what was STORED, and for a
      // MONEY-1169 object that is the multipart envelope: 212.03 MB for a PDF
      // that is a fraction of it. `feed-repair` fixes the OBJECT and is
      // deliberately GCS-only, so after a repair the row still says the old
      // number — and before one, it always does.
      //
      // That is load-bearing rather than cosmetic. `exceedsVisionCeiling`
      // reads this column and treats large-or-unknown as "refuse", so an
      // enveloped row is barred from the vision lane on a size it does not
      // have; and `estimatePeakRssBytes` sizes the OOM guard from it, so the
      // converter declines documents it could convert.
      //
      // Correcting it here makes the lane SELF-HEALING: the row is fixed as a
      // side effect of the read that had to download the bytes anyway. Only on
      // a peel, and only when the number actually moved — an unconditional
      // write would touch every row for nothing.
      const correctedSize =
        converted.envelopePeeled &&
        converted.payloadBytes > 0 &&
        converted.payloadBytes !== doc.fileSize
          ? converted.payloadBytes
          : null;
      if (correctedSize !== null) {
        logger.info(
          `${label}: fileSize ${doc.fileSize} -> ${correctedSize} ` +
            "(row recorded the MONEY-1169 envelope, not the PDF)",
        );
      }

      await prisma.stockDocument.update({
        where: { id: doc.id },
        data: {
          convertStatus: converted.status,
          markdownGcsPath,
          scannedPageCount: converted.assessment?.scannedPageCount ?? 0,
          textPageCount: converted.assessment?.textPageCount ?? 0,
          convertedAt: new Date(),
          ...(correctedSize !== null ? { fileSize: correctedSize } : {}),
        },
      });

      // ...and keep the in-memory view consistent, or the vision lane would
      // still route on the stale number for the rest of this message.
      if (correctedSize !== null)
        state = { ...state, fileBytes: correctedSize };

      if (converted.status === "UNREADABLE") {
        parseStatus = INGEST_PARSE_STATUS.UNREADABLE;
        reason = converted.error;
        await markParseStatus(doc.id, parseStatus);
        return finish();
      }

      // Re-decide with what the conversion actually found, and carry the
      // normaliser's verdict: an orphan-digit table means other cells in it
      // are silently truncated and STILL PARSE AS VALID NUMBERS, so the
      // markdown must not be read even though it exists.
      state = {
        ...state,
        convertStatus: converted.status,
        markdownGcsPath,
        textPageCount: converted.assessment?.textPageCount ?? 0,
        scannedPageCount: converted.assessment?.scannedPageCount ?? 0,
      };
      // `untrustedMarkdown`, NOT `retryAfterGateFailure`. Nothing has read this
      // document — the normaliser rejected the markdown on its own. Reporting
      // it as a gate failure would attribute a verdict to a model that never
      // ran, and would put the row in the sweep's re-read set for an answer
      // that was never produced.
      decision = decideIngestLane(state, {
        visionDisabled: !isVisionArmed(),
        untrustedMarkdown: converted.failOverToVision,
      });
      lane = decision.lane;
    }

    if (decision.lane === "skip") {
      parseStatus = decision.parseStatus ?? INGEST_PARSE_STATUS.UNREADABLE;
      reason = decision.reason;
      await markParseStatus(doc.id, parseStatus);
      return finish();
    }

    // ── read it ──────────────────────────────────────────────────────────
    const model = resolveDocParseModel(message.modelOverride);
    const ctx = {
      symbol: doc.symbol,
      docType: doc.docType,
      period: doc.period,
      title: doc.title,
    };

    let ran = await runLane(
      decision.lane,
      state,
      ctx,
      label,
      message.modelOverride,
    );
    let result = ran.result;
    // The lane that ACTUALLY ran, not the one that was decided. `runLane` can
    // switch to vision internally when the sidecar re-judge finds the markdown
    // untrustworthy — and reading `decision.lane` instead left `wasRetry`
    // false, so a failed gate bought the SAME whole-PDF call a second time at
    // temperature 0: a deterministically identical answer, paid twice.
    let wasRetry = ran.laneRun === "vision";
    lane = ran.laneRun;
    accumulate(result);

    let verdict = judge(result, wasRetry);

    // ── one vision retry, if the first answer failed the gate ────────────
    if (verdict.classification.retryWithVision) {
      const retry = decideIngestLane(state, {
        retryAfterGateFailure: true,
        visionDisabled: !isVisionArmed(),
      });
      if (retry.lane === "vision") {
        logger.info(`${label}: gate failed on markdown — retrying whole-PDF`);
        lane = "markdown+vision";
        wasRetry = true;
        ran = await runLane("vision", state, ctx, label, message.modelOverride);
        result = ran.result;
        accumulate(result);
        verdict = judge(result, wasRetry);
      } else {
        // No second lane exists (oversized). The verdict stands as terminal.
        verdict.classification = {
          ...verdict.classification,
          retryWithVision: false,
          retryable: false,
        };
      }
    }

    // ── persist ──────────────────────────────────────────────────────────
    //
    // `mapDocumentFinancials` has ALREADY validated: each entry is a
    // `{ row, verdict }` pair and `verdict.status` is EXTRACTED or
    // FAILED_VALIDATION. Rows that could not be dated at all never reach here
    // (`persistable` is false), because `periodEnd` is required and both
    // readers sort on it — an undated row would render in the wrong position,
    // which is worse than absent.
    //
    // Persist EVERY row, valid and invalid alike. A wrong answer that is
    // recorded is a prompt signal; a wrong answer that is dropped is nothing.
    for (const { row, verdict: rowVerdict } of verdict.rows) {
      if (rowVerdict.status === "EXTRACTED") extractedRows++;
      else invalidRows++;
      try {
        await upsertExtract({
          documentId: doc.id,
          instrumentId: doc.instrumentId,
          symbol: doc.symbol,
          exchange: doc.exchange,
          model,
          row,
          verdict: rowVerdict,
        });
      } catch (writeErr) {
        // Per-row, so one failed period does not lose the others in the same
        // document — they are independent readings under independent keys.
        logger.warn(
          `write failed for ${label} ${row.basis} ` +
            `${row.periodEnd.toISOString().slice(0, 10)}: ` +
            (writeErr instanceof Error ? writeErr.message : String(writeErr)),
        );
      }
    }

    parseStatus = verdict.classification.parseStatus;
    reason = verdict.reason;
    ok = parseStatus === INGEST_PARSE_STATUS.EXTRACTED;
    await markParseStatus(doc.id, parseStatus, ok ? new Date() : null);

    logger.info(
      `${label} -> ${parseStatus} lane=${lane} rows=${extractedRows}/${extractedRows + invalidRows} ` +
        `promptTokens=${promptTokens} cachedTokens=${cachedTokens} ` +
        `outputTokens=${outputTokens} elapsedMs=${Date.now() - startedAt}`,
    );
    return finish();
  } catch (err) {
    ok = false;
    reason = err instanceof Error ? err.message : String(err);
    logger.warn(`${message.documentId} threw: ${reason}`);
    return finish();
  }

  // -- helpers, closed over the counters ------------------------------------

  function accumulate(r: DocParseResult): void {
    promptTokens += r.usage.promptTokens;
    cachedTokens += r.usage.cachedTokens;
    outputTokens += r.usage.candidatesTokens;
    // A blocked or unconfigured upstream is NOT a row that failed to persist.
    // It gets its own counter so `selected 1, written 0, failed 0` cannot mean
    // both "the model refused us" and "the document held no figures".
    if (r.failure === "CALL_FAILED" || r.failure === "UNCONFIGURED") {
      transportFailures++;
    }
  }

  function judge(r: DocParseResult, wasRetry: boolean) {
    const mapped = r.ok
      ? mapDocumentFinancials(r.data)
      : { rows: [], dropped: [], periodsReturned: 0 };
    // The GATE: at least one period survived validation. A document that
    // returned only FAILED_VALIDATION rows has been read and disbelieved,
    // which is exactly the case the vision retry exists for.
    const gatePassed =
      r.ok &&
      mapped.rows.length > 0 &&
      mapped.rows.some((x) => x.verdict.status === "EXTRACTED");
    return {
      rows: mapped.rows,
      classification: classifyIngestOutcome({
        failure: r.failure,
        gatePassed,
        periodsReturned: mapped.periodsReturned,
        wasRetry,
        // Every reason the gate gave, across all rejected periods — MONEY-1348.
        // The classifier needs them to tell "declined for a currency we cannot
        // store" from "read and disbelieved", which take opposite dispositions.
        rejectionReasons: mapped.rows
          .filter((r) => r.verdict.status !== "EXTRACTED")
          .flatMap((r) => r.verdict.reasons),
      }),
      reason: r.error,
    };
  }

  function finish(): IngestOutcome {
    // In a `finally`-equivalent position on EVERY path, so an idle or
    // not-found run still emits a metric. `notify_no_data` is true on this
    // job's monitor, and a monitor that has never been green is a monitor
    // somebody mutes.
    reportJobOutcome({
      job: "stock-document-ingest",
      selected: 1,
      written: extractedRows,
      failed: invalidRows,
      transportFailures,
      // Required reading when selected > 0 and written === 0 — "0 written"
      // with no reason is exactly the silence this metric replaces.
      skippedReason: reason ?? undefined,
    });
    return {
      ok,
      documentId: message.documentId,
      lane,
      parseStatus,
      extractedRows,
      invalidRows,
      promptTokens,
      cachedTokens,
      outputTokens,
      reason,
    };
  }
}

/** Run one lane. Split out so the retry path cannot diverge from the first try. */
async function runLane(
  lane: string,
  state: IngestDocState,
  ctx: DocRequestContext,
  label: string,
  modelOverride?: string | null,
): Promise<{ result: DocParseResult; laneRun: string }> {
  if (lane === "markdown") {
    const raw = (await downloadFromGCS(state.markdownGcsPath!)).toString(
      "utf8",
    );

    // RE-JUDGE THE SIDECAR, every read.
    //
    // The converter already ran the normaliser and already knew whether this
    // document's tables were trustworthy — and then THREW THE VERDICT AWAY.
    // The sidecar stores the repaired markdown; it stores nothing about
    // whether the repair was sufficient. So any later pass (the sweep, a
    // forced re-ingest, a second delivery) would read it with no idea that
    // digits migrated across its column boundaries.
    //
    // That is the D4 defect reintroduced one lane over, and it is the worst
    // possible place for it: the damaged cells are neighbours like `196.82`
    // that are silently truncated AND individually valid, so a markdown read
    // of an untrusted table can pass the arithmetic gate and be written as
    // fact.
    //
    // Re-deriving is a pure string pass over text we have already fetched. The
    // alternative — persisting the verdict — would be a schema field that can
    // fall out of step with the bytes it describes.
    const rejudged = normaliseDocumentMarkdown(raw);
    if (rejudged.failOverToVision) {
      logger.info(
        `${label}: sidecar re-judged UNTRUSTWORTHY (${rejudged.reason}) — ` +
          "taking the vision lane instead of reading it",
      );
      return runLane("vision", state, ctx, label, modelOverride);
    }
    // Split on the page markers the converter wrote, so the selector sees
    // PAGES rather than one undifferentiated blob.
    const pages = splitPageMarkedMarkdown(rejudged.markdown);
    const selection = selectPagesForExtraction(pages);
    const markdown = selection.pages
      .map((p) => `<!-- page ${p.pageNumber} -->\n${p.markdown}`)
      .join("\n\n");
    logger.info(
      `${label}: selected ${selection.pages.length}/${pages.length} pages ` +
        `(${selection.totalChars} chars, ${selection.droppedForBudget} dropped, ${selection.reason})`,
    );
    return {
      result: await parseMarkdownFinancials({
        markdown,
        ctx,
        label,
        modelOverride,
      }),
      laneRun: "markdown",
    };
  }

  // REFUSE BEFORE DOWNLOADING. `parsePdfFinancials` returns TOO_LARGE only
  // after the bytes are in memory, so an oversized document would materialise
  // a 222 MB Buffer purely to be rejected — and this path is reachable
  // recursively from the markdown branch, which does not re-consult the
  // ceiling.
  if (exceedsVisionCeiling(state.fileBytes)) {
    return {
      result: {
        ok: false,
        data: null,
        model: resolveDocParseModel(modelOverride),
        transport: "none",
        usage: {
          promptTokens: 0,
          candidatesTokens: 0,
          totalTokens: 0,
          cachedTokens: 0,
          thinkingTokens: 0,
        },
        failure: "TOO_LARGE",
        error: `document is ${state.fileBytes ?? "an unknown number of"} bytes, above the vision ceiling`,
        elapsedMs: 0,
      },
      laneRun: "vision",
    };
  }

  const bytes = await downloadFromGCS(state.gcsPath!);
  let gcsUri: string | null = null;
  try {
    gcsUri = buildGcsUri(state.gcsPath!);
  } catch {
    gcsUri = null;
  }
  return {
    // CACHE-ORDERED, like the markdown lane. The legacy
    // `buildDocumentFinancialsPrompt` puts the symbol on its fourth line, so
    // every request has a different prefix and caching never engages — and it
    // omits the whole worked-example block, on the RETRY lane taken precisely
    // because the first answer failed the gate. `buildOnlineRequest` already
    // had a cache-ordered `file` branch with no production caller.
    result: await parsePdfFinancials({
      bytes,
      gcsUri,
      mimeType: state.mimeType || "application/pdf",
      prompt: buildPromptText(ctx),
      label,
      modelOverride,
    }),
    laneRun: "vision",
  };
}
