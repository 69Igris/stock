/**
 * Stock Document Extraction Processor (MONEY-783)
 *
 * NSE / Screener PDFs land in GCS as `StockDocument` rows with
 * `processingStatus: "PENDING"` and `textContent: null`. No extractor existed,
 * so the embed worker (which needs READY + non-null textContent) never saw them.
 * This processor closes that gap:
 *
 *   1. Find PENDING (or PENDING+FAILED, when `force`) PDF StockDocuments, plus
 *      any row STUCK in PROCESSING past `STALE_PROCESSING_MS` — MONEY-1329, 29
 *      such rows on prod that no query in the repo selected.
 *   2. Per doc (never abort the batch on a single failure):
 *      - Mark PROCESSING.
 *      - MONEY-1347: if the MONEY-1314 conversion lane already wrote a COMPLETE
 *        markdown sidecar at `markdownGcsPath`, read THAT and stop — one GCS
 *        read, zero Document AI calls. 32,893 documents already hold one.
 *        An INCOMPLETE sidecar (`sidecarIsPageIncomplete`) falls through: it is
 *        missing pages, and half a document silently becoming the whole
 *        document is not something the RAG corpus can detect downstream.
 *      - Otherwise resolve the source bytes: download the GCS object at `gcsPath`. If the
 *        object is MISSING but the row carries a fetchable `sourceUrl`
 *        (MONEY-798 P3c rag-enqueue discovery rows have a PLACEHOLDER gcsPath +
 *        a real sourceUrl), fetch the bytes (SSRF-safe) and upload them to
 *        `gcsPath` first — so the discovery path actually ingests instead of
 *        always FAILing on the missing object.
 *      - Try Document AI (layout-aware OCR) on the gs:// URI.
 *      - On degrade/empty, fall back to `pdf-parse` over the resolved bytes.
 *      - Too little text (< 50 chars) → mark FAILED, continue. (A missing
 *        object with NO fetchable sourceUrl, or a sourceUrl fetch failure, also
 *        lands here — those ARE genuine failures.)
 *      - Over the DB/RAG cap → upload the FULL text to a derived GCS sidecar and
 *        store only a capped preview in textContent (NO SCHEMA CHANGE).
 *      - Mark READY + isEmbedded:false so the embed worker picks it up.
 *   3. ALWAYS publish a STOCK_DOCUMENT_EMBED job to chain — including when
 *      step 1 found nothing. See `triggerEmbedPass` for why.
 *
 * Document AI's synchronous online API caps at 30 pages IN IMAGELESS MODE (15
 * without it — MONEY-1269, which is why EVERY call was failing until
 * `docai-logic.ts` set the flag). Large annual reports still exceed 30 and
 * still degrade to pdf-parse. The worker WORKS before the processor is
 * provisioned (documentAiReady() false → straight to pdf-parse).
 *
 * ## MONEY-1255 — the queue drained LIFO at 50/day and starved
 *
 * Three things were true at once and only together did they starve the queue:
 * the selection was `fetchedAt: "desc"` with no cursor, the scheduler sent
 * `{"batchSize":50}`, and `stock-document-sync` adds thousands of rows a week.
 * Newest-first over a growing queue does not delay the old rows — it pushes
 * them down on every cycle and never reaches them. Measured on prod
 * 2026-08-26: 36,001 PENDING, 34,790 of them PDFs, which is a ~2-year drain at
 * 50/day even if nothing new ever arrived.
 *
 * Three changes, in the order they matter:
 *
 *   - **Oldest first** (`EXTRACT_ORDER_BY`). A batch needs a rotation marker
 *     ordered ASC or it never advances — MONEY-1211 lost 681 of 781 symbols to
 *     exactly this.
 *   - **A wall-clock budget** (`RUN_TIME_BUDGET_MS`), not a bigger count. The
 *     binding constraint is the 600s Pub/Sub ack deadline, which is a TIME;
 *     overrunning it redelivers the message and starts a SECOND copy of the
 *     job on the same page. MONEY-1201 already tried halving a count here and
 *     wrote down why it only moves the cliff.
 *   - **Self-chaining** (`chainAnotherBatch`), bounded by `MAX_CHAIN_DEPTH`.
 *     That bound is the termination proof and it does not consult the
 *     database, so no queue state can extend it.
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import prisma from "@usemoney/database";
import type { StockDocumentExtractMessage } from "@usemoney/types/pubsub";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types/pubsub";
import { getPubSubClient } from "@usemoney/pubsub/client";
import { downloadFromGCS, uploadToGCS } from "../lib/gcs";
import {
  extractWithDocumentAi,
  extractWithDocumentAiBytes,
  // MONEY-1269 — reported beside `docaiDegraded`, so "the processor is not
  // provisioned" (every call degrades, correctly) can never be read as "the
  // processor is provisioned and refusing every document".
  documentAiReady,
} from "../lib/docai";
import { safeFetch } from "@usemoney/core/import";
import {
  MAX_TEXT_LENGTH,
  capTextContent,
  buildExtractQuery,
  buildGcsUri,
  extractedSidecarPath,
  shouldFetchFromSource,
  // MONEY-1319 — the archive lane. Pure, so the branch below and its unit test
  // execute the same decision.
  resolveExtractionSource,
  type ExtractionSource,
  // MONEY-1347 — the sidecar-first decision. Pure, so this branch and its unit
  // test run the same code.
  decideTextSource,
  // MONEY-1329 — the staleness cutoff that makes abandoned PROCESSING claims
  // selectable again. Named here only for the log line.
  STALE_PROCESSING_MS,
  // MONEY-1255 — the drain controls. All pure and unit-tested; the arithmetic
  // that sizes each one lives on its declaration in the logic module.
  EXTRACT_ORDER_BY,
  DEFAULT_EXTRACT_BATCH_SIZE,
  RUN_TIME_BUDGET_MS,
  MAX_CHAIN_DEPTH,
  isWithinRunBudget,
  normalizeChainDepth,
  shouldChainAnotherBatch,
} from "./stock-document-extract-logic";

const logger = {
  info: (...args: unknown[]) => console.log("[stock-doc-extract]", ...args),
  warn: (...args: unknown[]) => console.warn("[stock-doc-extract]", ...args),
  error: (...args: unknown[]) => console.error("[stock-doc-extract]", ...args),
};

/** Minimum extracted-text length below which we treat extraction as failed. */
const MIN_TEXT_LENGTH = 50;

/** Cap on bytes fetched from a doc's `sourceUrl` (discovery path). 25 MiB. */
const MAX_FETCH_BYTES = 25 * 1024 * 1024;

/**
 * SSRF allow-list (MONEY-779 scan) for a discovered `StockDocument.sourceUrl`.
 * `safeFetch` already blocks internal IPs / cloud-metadata; this also blocks
 * arbitrary PUBLIC hosts so a planted sourceUrl can't turn the worker into an
 * egress fetch-proxy or poison the shared RAG corpus with attacker-hosted
 * content. Subdomains match (e.g. www1.nseindia.com → nseindia.com).
 */
const ALLOWED_DOC_SOURCE_HOSTS = [
  "nseindia.com",
  "bseindia.com",
  "screener.in",
  "tickertape.in",
] as const;

export async function processStockDocumentExtract(
  message: StockDocumentExtractMessage,
): Promise<void> {
  const {
    symbols,
    docTypes,
    force = false,
    batchSize = DEFAULT_EXTRACT_BATCH_SIZE,
  } = message;
  const chainDepth = normalizeChainDepth(message.chainDepth);
  const startedAt = Date.now();

  logger.info(
    `Starting stock document extraction (force: ${force}, batch: ${batchSize}, ` +
      `chainDepth: ${chainDepth}/${MAX_CHAIN_DEPTH}, budget: ${RUN_TIME_BUDGET_MS}ms, ` +
      `symbols: ${symbols?.join(",") || "all"}, docTypes: ${docTypes?.join(",") || "all"})`,
  );

  // MONEY-1329 — the run's clock is passed in rather than read inside the
  // builder, so the staleness cutoff is one deterministic value for the whole
  // page and is testable without a fake timer.
  const where = buildExtractQuery({
    symbols,
    docTypes,
    force,
    now: new Date(startedAt),
  });

  const documents = await prisma.stockDocument.findMany({
    where,
    select: {
      id: true,
      symbol: true,
      gcsPath: true,
      mimeType: true,
      docType: true,
      period: true,
      // MONEY-1347: the conversion lane's output. 32,893 documents already hold
      // a markdown sidecar that nothing read for TEXT, while 34,915 rows queued
      // here for an extractor to produce the same thing at a Document AI call
      // apiece. `decideTextSource` reads exactly these four columns.
      markdownGcsPath: true,
      textPageCount: true,
      scannedPageCount: true,
      convertStatus: true,
      // MONEY-798 P3c: rag-enqueue discovery rows are PENDING with a PLACEHOLDER
      // gcsPath (no object uploaded) + a real sourceUrl. When the object is
      // missing we fetch the bytes from sourceUrl and upload them to gcsPath
      // before extracting, so those discovered filings aren't silently FAILED.
      sourceUrl: true,
    },
    // MONEY-1255 — OLDEST FIRST. It was `desc`, with no cursor, over a queue
    // that grows by thousands on every weekly sync: newest-first does not
    // merely delay the old rows, it pushes them further down on every cycle and
    // never reaches them. Same shape as MONEY-1211, which lost 681 of 781
    // symbols to a batch with no ascending rotation marker.
    orderBy: EXTRACT_ORDER_BY,
    take: batchSize,
  });

  /**
   * Rows this run took on. Named rather than read off `documents.length` at
   * four call sites, because it is also the `selected` half of the zero-write
   * monitor's condition and that number has to mean ONE thing.
   */
  const selected = documents.length;
  let extracted = 0;
  let failed = 0;
  /**
   * Rows that actually LEFT the PENDING set — the PROCESSING flip landed.
   *
   * This, not `extracted + failed`, is the self-chain's progress signal. A row
   * whose very first update throws stays PENDING and would be re-selected by
   * the identical next query; chaining on a run where that happened to EVERY
   * row is the runaway-poll shape. See `shouldChainAnotherBatch`.
   */
  let leftPending = 0;
  /** True when the wall-clock budget, not the page, ended the loop. */
  let stoppedOnBudget = false;

  // ── The per-document CENSUS — MONEY-1347 / MONEY-1269 ─────────────────
  //
  // Every selected row lands in exactly ONE of these five buckets, and the
  // identity `viaSidecar + viaDocumentAi + viaPdfParse + noText + notAttempted
  // === selected` is asserted in the outcome line below. A census that does not
  // add up is how a lane hides work it never did — this repo's standing example
  // is a per-source counter incremented BEFORE the call it counted, so a source
  // that 403s every request still reported a full number (MONEY-1255).
  //
  // `docaiDegraded` is DELIBERATELY OUTSIDE that identity and is not a fifth
  // bucket: it counts Document AI calls that came back empty, and every one of
  // those is ALSO counted as `viaPdfParse` or `noText` by whatever produced the
  // text instead. It is the MONEY-1269 measurement — 59 of 59 calls degraded on
  // prod — and it is the number that says whether `imagelessMode` worked.
  /** Text came from the converted markdown sidecar. Zero Document AI calls. */
  let viaSidecar = 0;
  /** Text came from a Document AI parse. */
  let viaDocumentAi = 0;
  /** Document AI degraded (or was skipped) and `pdf-parse` produced the text. */
  let viaPdfParse = 0;
  /** Document AI was called and returned nothing usable. Overlaps the above. */
  let docaiDegraded = 0;
  /** Attempted and produced no usable text — the FAILED rows. */
  let noText = 0;
  /** Rows the loop actually reached. `selected - attempted` is what the budget cut. */
  let attempted = 0;

  // MONEY-1238: the embed chain is published from a `finally`, so EVERY exit
  // from the block below reaches it — including the zero-documents early return
  // that used to skip it. See `triggerEmbedPass`.
  try {
    if (selected === 0) {
      logger.info("No PENDING PDF documents to extract");
      return;
    }

    logger.info(`Found ${selected} documents to extract (oldest first)`);

    for (const doc of documents) {
      // MONEY-1255 — the 600s Pub/Sub ack deadline is the binding constraint,
      // and it is a TIME, so it is enforced with a clock rather than with a
      // count. Overrunning it does not make the run slow: Pub/Sub redelivers
      // and a SECOND copy starts on the same page. Checked BETWEEN documents,
      // so the true wall is `budget + one document` — the headroom arithmetic
      // on RUN_TIME_BUDGET_MS pays for exactly that.
      if (!isWithinRunBudget(startedAt, Date.now())) {
        stoppedOnBudget = true;
        logger.info(
          `Run budget reached after ${Date.now() - startedAt}ms — stopping at ` +
            `${extracted + failed}/${selected}; the rest stay PENDING ` +
            "and the chained follow-up takes them.",
        );
        break;
      }

      attempted++;
      /**
       * WHERE this document's text came from — MONEY-1347.
       *
       * Set at exactly one point per outcome and tallied in the `finally`
       * below, so the census is a genuine PARTITION of the attempted rows
       * rather than four independent counters that can disagree. "none" is the
       * initial value AND the honest answer for a row that threw before
       * producing anything, which is why it is the default rather than a
       * branch someone has to remember to take.
       */
      let origin: "sidecar" | "documentai" | "pdfparse" | "none" = "none";

      try {
        // 1. Mark as processing. This is the moment the row leaves PENDING, so
        //    it is the moment progress becomes true for the chain decision.
        await prisma.stockDocument.update({
          where: { id: doc.id },
          data: { processingStatus: "PROCESSING" },
        });
        leftPending++;

        // 2. SIDECAR FIRST — MONEY-1347.
        //
        //    32,893 of these documents already hold a converted markdown
        //    sidecar at `markdownGcsPath`, written by the MONEY-1314 conversion
        //    lane and read by nothing for TEXT, while 34,915 rows queue here for
        //    an extractor to produce the same thing at a cross-region Document
        //    AI call apiece. Reading it costs ONE GCS read and zero model calls.
        //
        //    The check sits ABOVE the object download, not merely above the
        //    Document AI call, because on this path the PDF's bytes are needed
        //    by nobody: no container sniff, no `sourceUrl` recovery, no
        //    `pdf-parse`. Skipping the download is most of the saving.
        //
        //    A sidecar that will not download, or that holds too little text,
        //    FALLS THROUGH to the extractor rather than failing the row. A
        //    missing sidecar object is not evidence the document is unreadable,
        //    and the whole point of the extractor is that it reads the PDF.
        let text: string | null = null;
        const sidecarPath = doc.markdownGcsPath;
        if (
          typeof sidecarPath === "string" &&
          decideTextSource(doc) === "sidecar"
        ) {
          try {
            const sidecarText = (await downloadFromGCS(sidecarPath)).toString(
              "utf-8",
            );
            if (sidecarText.trim().length >= MIN_TEXT_LENGTH) {
              text = sidecarText;
              origin = "sidecar";
            } else {
              logger.warn(
                `Sidecar at ${sidecarPath} holds ${sidecarText.trim().length} ` +
                  `chars for ${doc.symbol} (${doc.docType}/${doc.period}) — ` +
                  "falling through to the extractor",
              );
            }
          } catch (sidecarErr) {
            logger.warn(
              `Sidecar read failed for ${doc.symbol} (${doc.docType}/${doc.period}) ` +
                `at ${sidecarPath}: ${sidecarErr instanceof Error ? sidecarErr.message : sidecarErr} — ` +
                "falling through to the extractor",
            );
          }
        }

        // 3. The EXTRACTOR path — skipped ENTIRELY when the sidecar answered.
        //    Everything below costs a GCS read of the PDF, a container sniff, a
        //    metered Document AI call and a pdf-parse over a multi-MB buffer.
        //
        //    Resolve the source bytes. Normally the object already lives at
        //    `gcsPath`. But MONEY-798 P3c discovery rows (rag-enqueue) are PENDING
        //    with a PLACEHOLDER gcsPath (no object) + a real sourceUrl — for those
        //    we fetch the bytes from sourceUrl (SSRF-safe) and upload them to
        //    gcsPath so Document AI can read the object and pdf-parse has the
        //    buffer. A missing object WITHOUT a usable sourceUrl is a genuine
        //    failure (handled by the empty-text branch below); a missing object
        //    WITH a fetchable sourceUrl is NOT.
        if (text === null) {
          let buf: Buffer | null = null;
          try {
            buf = await downloadFromGCS(doc.gcsPath);
          } catch (downloadErr) {
            // The download threw → the GCS object is absent. `shouldFetchFromSource`
            // is the single decision point for "missing object → fetch from
            // sourceUrl?" (false here = object absent), so the production path and
            // its unit test execute the SAME code.
            if (shouldFetchFromSource(false, doc.sourceUrl)) {
              try {
                const { buffer } = await safeFetch(
                  doc.sourceUrl!,
                  {
                    headers: {
                      "User-Agent": "UseMoney/1.0 (Document Fetcher)",
                    },
                  },
                  {
                    maxBytes: MAX_FETCH_BYTES,
                    timeoutMs: 30_000,
                    allowedHosts: ALLOWED_DOC_SOURCE_HOSTS,
                  },
                );
                await uploadToGCS(
                  doc.gcsPath,
                  buffer,
                  doc.mimeType || "application/pdf",
                );
                buf = buffer;
                logger.info(
                  `Fetched ${buffer.length} bytes from sourceUrl for ${doc.symbol} (${doc.docType}/${doc.period}) → uploaded to gcsPath`,
                );
              } catch (fetchErr) {
                logger.warn(
                  `sourceUrl fetch failed for ${doc.symbol} (${doc.docType}/${doc.period}): ${fetchErr instanceof Error ? fetchErr.message : fetchErr}`,
                );
                buf = null;
              }
            } else {
              // No object and no fetchable sourceUrl — nothing to extract.
              logger.warn(
                `GCS object missing and no fetchable sourceUrl for ${doc.symbol} (${doc.docType}/${doc.period}): ${downloadErr instanceof Error ? downloadErr.message : downloadErr}`,
              );
              buf = null;
            }
          }

          // 4. Decide WHAT to read — MONEY-1319. Normally the object at `gcsPath`
          //    IS the document. For the 179 NSE rows whose object is a ZIP it is
          //    not: the document is a member inside, beside an XML sidecar, so
          //    the archive is opened and the member selected here. The decision
          //    is `resolveExtractionSource` (pure), so this branch and its unit
          //    test run the same code.
          let source: ExtractionSource | null = null;
          if (buf) {
            source = resolveExtractionSource({
              body: buf,
              storedMimeType: doc.mimeType,
            });
            if (!source) {
              // An archive we cannot get a document out of. Fail it WITHOUT
              // spending a Document AI call — the whole point of this branch is
              // that those calls were being spent on bytes no processor can read.
              logger.warn(
                `No extractable member in the stored archive for ${doc.symbol} ` +
                  `(${doc.docType}/${doc.period}) — marked FAILED without a parse`,
              );
            } else if (source.memberName) {
              logger.info(
                `${doc.symbol} (${doc.docType}/${doc.period}): ${source.why}`,
              );
            }
          }

          // 5. Try Document AI (degrades gracefully, never throws), then fall
          //    back to pdf-parse over the same bytes.
          //
          //    Which Document AI entry point is NOT a style choice. A recovered
          //    archive member exists only in memory — `gcsPath` still names the
          //    ZIP — so asking the processor to read the OBJECT would repeat the
          //    exact failure that left 126 of these rows `FAILED`.
          if (source) {
            const ai = source.objectIsTheDocument
              ? await extractWithDocumentAi(
                  buildGcsUri(doc.gcsPath),
                  source.mimeType,
                )
              : await extractWithDocumentAiBytes(source.bytes, source.mimeType);
            text = ai.degraded ? null : ai.text;
            if (text) {
              origin = "documentai";
            } else {
              // MONEY-1269 — the number this ticket exists for. It was 100% on
              // prod (59 of 59 calls in one 3-hour window) and nothing showed
              // it, because a degrade is silent by design: the pdf-parse
              // fallback below produced text and the job reported success.
              // Reported beside `docaiReady` so an UNPROVISIONED processor —
              // which degrades every call correctly — cannot be mistaken for
              // the failure imageless mode fixes.
              docaiDegraded++;
              try {
                const pdfParse = (await import("pdf-parse")).default;
                text = (await pdfParse(source.bytes)).text || null;
                if (text) origin = "pdfparse";
              } catch (err) {
                logger.warn(
                  `pdf-parse fallback failed for ${doc.symbol} (${doc.docType}/${doc.period}): ${err instanceof Error ? err.message : err}`,
                );
                text = null;
              }
            }
          }
        }

        // 6. Too little text → FAILED, continue.
        if (!text || text.length < MIN_TEXT_LENGTH) {
          // The census records where USABLE text came from. A 12-character
          // "extraction" is not a source that worked, so it is reset rather
          // than credited — otherwise `viaSidecar` would count rows the run
          // then marked FAILED, and the number would read as a saving.
          origin = "none";
          await prisma.stockDocument.update({
            where: { id: doc.id },
            data: { processingStatus: "FAILED" },
          });
          failed++;
          logger.warn(
            `No usable text for ${doc.symbol} (${doc.docType}/${doc.period}) — marked FAILED`,
          );
          continue;
        }

        // 7. Over the DB/RAG cap → sidecar the full text, store a capped preview.
        //    Otherwise store the full text inline. NO SCHEMA CHANGE.
        let textContent: string;
        if (text.length > MAX_TEXT_LENGTH) {
          await uploadToGCS(
            extractedSidecarPath(doc.gcsPath),
            Buffer.from(text, "utf-8"),
            "text/plain",
          );
          textContent = capTextContent(text);
          logger.info(
            `Sidecar'd full text (${text.length} chars) for ${doc.symbol} (${doc.docType}/${doc.period})`,
          );
        } else {
          textContent = text;
        }

        // 8. Mark READY so the embed worker picks it up.
        await prisma.stockDocument.update({
          where: { id: doc.id },
          data: {
            textContent,
            processingStatus: "READY",
            isEmbedded: false,
          },
        });

        extracted++;
        if (extracted % 10 === 0) {
          logger.info(`Progress: ${extracted}/${selected} extracted`);
        }
      } catch (err) {
        failed++;
        logger.error(
          `Failed to extract ${doc.symbol} (${doc.docType}/${doc.period}): ${err instanceof Error ? err.message : err}`,
        );
        // Best-effort flip to FAILED so a transient PROCESSING row doesn't stick.
        try {
          await prisma.stockDocument.update({
            where: { id: doc.id },
            data: { processingStatus: "FAILED" },
          });
        } catch {
          // ignore — the row stays PROCESSING. MONEY-1329: that is no longer
          // permanent — `buildExtractQuery`'s stale arm reclaims it after
          // STALE_PROCESSING_MS — but it is still a lost cycle for this row.
        }
      } finally {
        // ONE increment per attempted document, on every exit path including a
        // throw. A census assembled from increments scattered through the body
        // is a census that can miss a path; this one cannot.
        if (origin === "sidecar") viaSidecar++;
        else if (origin === "documentai") viaDocumentAi++;
        else if (origin === "pdfparse") viaPdfParse++;
        else noText++;
      }
    }

    logger.info(
      `Extraction complete: ${extracted} extracted, ${failed} failed, ` +
        `${leftPending} left PENDING${stoppedOnBudget ? " (budget-truncated)" : ""}`,
    );
  } finally {
    // MONEY-1255 — the report moved INTO the `finally`, and that is a
    // prerequisite for the freshness monitor rather than tidying.
    //
    // It used to sit below `if (documents.length === 0) return`, so an empty
    // queue emitted NO metric at all. `notify_no_data: true` means a monitor
    // over a job that emits nothing sits in NO DATA — and once this backlog
    // drains, an empty queue is the NORMAL nightly state. The monitor would
    // have gone red the week it started working.
    //
    // Reporting zero/zero is not a weaker signal: the alert is
    // `clamp(selected) - clamp(written) > 0`, which is 0-0=0 for a genuinely
    // idle run and 1-0=1 for a run that found work and produced nothing. The
    // idle case was always meant to be silent; what it was not meant to be is
    // ABSENT.
    // MONEY-1347 / MONEY-1269 — the per-document census rides `skippedReason`.
    //
    // `reportJobOutcome` takes exactly {job, selected, written, failed,
    // transportFailures, skippedReason} — there is no channel for extra
    // counters — so they go in the reason string as `key=value`, the shape
    // `xbrl-ratios` already uses for its `candidates=… exchangeMismatch=…`
    // line. Without it there is no way to tell a run that read 400 sidecars
    // from one that spent 400 Document AI calls: both report the same
    // `written`, and the whole point of this change is the difference.
    const notAttempted = selected - attempted;
    const censusSum =
      viaSidecar + viaDocumentAi + viaPdfParse + noText + notAttempted;
    const census =
      `viaSidecar=${viaSidecar} viaDocumentAi=${viaDocumentAi} ` +
      `viaPdfParse=${viaPdfParse} noText=${noText} ` +
      `notAttempted=${notAttempted} docaiDegraded=${docaiDegraded} ` +
      `docaiReady=${documentAiReady()} staleProcessingMs=${STALE_PROCESSING_MS}`;

    // The census must PARTITION `selected`. `docaiDegraded` is deliberately
    // outside the sum and overlaps `viaPdfParse`/`noText` — it counts calls,
    // not documents, and it is the MONEY-1269 measurement rather than a bucket.
    //
    // THIS CANNOT FIRE ON DATA, and saying so is the point of the comment.
    // `selected` is `documents.length`, `attempted` is incremented once at the
    // top of each iteration, and the `finally` above increments exactly one
    // bucket per attempted row on every exit path including a throw — so
    // `censusSum === selected` is an identity over every possible run. Its
    // silence is therefore NOT evidence that the run was accounted for; it is
    // evidence that the code still has the shape that makes it accounted for.
    //
    // It is kept as a REFACTOR tripwire, because the shape is the fragile
    // part: moving a bucket increment out of the `finally` and into a branch
    // is a one-line edit that reintroduces MONEY-1269's un-measurable lane,
    // and it makes this sum disagree the first time it runs.
    if (censusSum !== selected) {
      logger.error(
        `Census does not partition the page: ${census} sums to ${censusSum} ` +
          `against selected=${selected}. This is a CODE defect, not a data ` +
          "condition — a bucket increment has left the `finally`.",
      );
    }

    reportJobOutcome({
      job: "stock-document-extract",
      selected,
      written: extracted,
      failed,
      skippedReason:
        selected > 0 && extracted === 0
          ? `${failed} extraction(s) failed, 0 succeeded; ${census}`
          : census,
    });

    await chainAnotherBatch({
      message,
      chainDepth,
      selected,
      batchSize,
      leftPending,
      force,
    });

    await triggerEmbedPass(extracted, selected);
  }
}

/**
 * Publish the NEXT link of the drain chain — MONEY-1255.
 *
 * ## Why a chain rather than a bigger batch
 *
 * The queue is 34,790 PDFs and the scheduler fires once a day. A batch cannot
 * be raised to cover that: the run is bounded by a 600s Pub/Sub ack deadline
 * (Pub/Sub's maximum, not a setting), and per-document cost is a Document AI
 * round trip plus a GCS read plus a pdf-parse fallback — two of those three
 * are not ours to hold still. `workers/CLAUDE.md` says it plainly: raising a
 * batch is not the way to catch up, and self-chaining is the preferred lever.
 *
 * ## Why this terminates
 *
 * `shouldChainAnotherBatch` refuses once `chainDepth + 1` reaches
 * MAX_CHAIN_DEPTH, and every published message carries `chainDepth + 1`. That
 * bound holds regardless of what the queue does, so the chain is at most
 * MAX_CHAIN_DEPTH messages long even if every other signal is wrong. The other
 * three conditions (queue drained, nothing left PENDING, `force`) only ever
 * stop it SOONER. `processor-stock-document-extract.test.ts` drives the
 * decision function in a loop against an adversarial "always more work"
 * environment and asserts the loop ends.
 *
 * Never throws: a failed chain must leave a successful extraction run
 * successful. The cost of a dropped link is one delayed batch, and the daily
 * scheduler starts a fresh chain anyway.
 */
async function chainAnotherBatch(opts: {
  message: StockDocumentExtractMessage;
  chainDepth: number;
  selected: number;
  batchSize: number;
  leftPending: number;
  force: boolean;
}): Promise<void> {
  const { message, chainDepth, selected, batchSize, leftPending, force } = opts;

  if (
    !shouldChainAnotherBatch({
      selected,
      batchSize,
      chainDepth,
      leftPending,
      force,
    })
  ) {
    logger.info(
      `Not chaining (depth ${chainDepth}/${MAX_CHAIN_DEPTH}, selected ${selected}/${batchSize}, ` +
        `leftPending ${leftPending}, force ${force})`,
    );
    return;
  }

  try {
    const pubsub = getPubSubClient();
    const topic = pubsub.topic(
      getTopicName(PUBSUB_TOPICS.STOCK_DOCUMENT_EXTRACT),
    );
    // The follow-up inherits the ORIGINAL scope (symbols / docTypes /
    // batchSize) so a targeted run stays targeted. Only the depth moves.
    const next: StockDocumentExtractMessage = {
      ...message,
      batchSize,
      chainDepth: chainDepth + 1,
    };
    await topic.publishMessage({ json: next });
    logger.info(
      `Chained stock-document-extract batch ${chainDepth + 1}/${MAX_CHAIN_DEPTH}`,
    );
  } catch (err) {
    logger.warn(
      `Failed to chain the next extract batch: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Publish the STOCK_DOCUMENT_EMBED chain job. Called from a `finally`, so it
 * runs exactly once per extraction run on EVERY exit path.
 *
 * Always trigger an embed pass — NOT just when this run extracted PDFs
 * (MONEY-779 audit fix). The daily text-only sync (Tickertape/Screener
 * financials, rag-enqueue inline text, YouTube transcripts) marks docs
 * READY + isEmbedded:false WITHOUT going through extract, so gating embed on
 * `extracted > 0` left those un-embedded on weekdays (only the Sunday full
 * sync, which creates real PDFs, chained embed). embed no-ops when nothing is
 * pending, so publishing unconditionally — driven by the daily extract
 * scheduler — keeps the RAG corpus fresh for text-source docs too.
 *
 * MONEY-1238 — that "unconditionally" was FALSE FOR THE COMMONEST CASE. The
 * publish sat 165 lines below `if (documents.length === 0) return`, and
 * `documents` is the extractable containers only (`buildExtractQuery`), so on
 * any day the weekday text-only sync produced READY text docs while the PDF
 * queue happened to be empty, the early return skipped the publish and embed
 * never ran — exactly the regression the comment claims to have closed.
 *
 * It matters more than a missed chain because this publish is the ONLY trigger
 * the embed job has: `scripts/ops/setup-scheduler.sh` schedules
 * `stock-document-sync-*` and `stock-document-extract-daily` and has NO entry
 * for `stock-document-embed`, and the only other publisher in the repo is
 * `stock-document-sync`, which publishes the EXTRACT topic. So a skipped
 * publish is not a delayed embed, it is a day with no embedding at all, and the
 * RAG corpus silently stops ingesting.
 *
 * The `finally` — rather than moving the publish above the early return — keeps
 * the ordering the non-empty path needs: embed must fire AFTER the loop has
 * marked this run's documents READY, or they wait for tomorrow. One call site,
 * one execution, both orderings correct.
 *
 * Never throws: a failed chain must not fail an extraction run that succeeded.
 */
async function triggerEmbedPass(
  extracted: number,
  pending: number,
): Promise<void> {
  try {
    const pubsub = getPubSubClient();
    const topic = pubsub.topic(
      getTopicName(PUBSUB_TOPICS.STOCK_DOCUMENT_EMBED),
    );
    await topic.publishMessage({
      json: {
        batchSize: 500,
      },
    });
    logger.info(
      `Published stock-document-embed job (pendingPdfs=${pending}, extracted=${extracted}; ` +
        "embed picks up ALL READY + unembedded docs, PDF-sourced or not)",
    );
  } catch (err) {
    logger.warn(
      `Failed to trigger embedding: ${err instanceof Error ? err.message : err}`,
    );
  }
}
