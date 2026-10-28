/**
 * Which lane a document takes, and what its outcome means — MONEY-1314.
 *
 * PURE. No Prisma, no GCS, no client, no clock. The orchestrator does I/O and
 * asks this module every question that has a right answer.
 *
 * ## The lanes
 *
 *   CONVERT   the PDF has never been through pdf-inspector. Convert first;
 *             the markdown is a `${gcsPath}.md` sidecar reused by every later
 *             pass, so this cost is paid once per document, not once per parse.
 *   MARKDOWN  page-selected text to Gemini. The primary lane: ~10k input
 *             tokens against a whole-PDF's 258 tokens PER PAGE, a cacheable
 *             prefix, and no 50 MB ceiling.
 *   VISION    the whole PDF. The RETRY, and the only lane for a scanned
 *             document — but it is capped at Gemini's 50 MB document limit.
 *   SKIP      nothing can read this. Always with a reason and a status.
 *
 * ## The asymmetry that shapes everything here
 *
 * The two lanes do NOT cover each other. A 222 MB annual report — and we hold
 * documents that large — is markdown-or-nothing, because vision refuses it on
 * size. A purely scanned document is vision-or-nothing, because there is no
 * text layer to select pages from. So a document that is BOTH scanned AND over
 * 50 MB has no lane at all, and saying so out loud is better than discovering
 * it as a mysterious per-document failure: it is a NAMED terminal outcome with
 * its own status, countable in the outcome report.
 */

import { MAX_PDF_BYTES } from "../lib/gemini-pdf";
import { CONVERT_STATUS } from "./doc-ingest-selectors-logic";

export type IngestLane = "convert" | "markdown" | "vision" | "skip";

/**
 * Terminal statuses this lane can write, beyond the ones
 * `stock-document-parse-logic` already defines.
 */
export const INGEST_PARSE_STATUS = {
  /** Read and mapped. */
  EXTRACTED: "EXTRACTED",
  /** The model answered; OUR arithmetic rejected the answer. */
  FAILED_VALIDATION: "FAILED_VALIDATION",
  /** A transient failure. Re-selectable. */
  FAILED: "FAILED",
  /**
   * No lane can read this document, and none ever will without new capability.
   * DISTINCT from FAILED on purpose: FAILED is re-selected by a forced run and
   * would burn the same document on every pass forever.
   */
  UNREADABLE: "UNREADABLE",
  /**
   * The document is readable and we decline to store it — MONEY-1348.
   *
   * Today that means a non-rupee statement: every figure in this lane is
   * normalised to CRORE and the table has no currency column, so there is no
   * correct row to write. DISTINCT from UNREADABLE, which says nothing could
   * read the bytes, and distinct from FAILED_VALIDATION, which the sweep
   * re-opens with a vision retry — vision would read the same dollars.
   *
   * The value already exists in `StockDocument.parseStatus`'s documented
   * vocabulary; this lane simply never had a way to write it.
   */
  UNSUPPORTED: "UNSUPPORTED",
} as const;

/**
 * Statuses that mean "this document has been read; do not pay again".
 *
 * MONEY-1314 review. Deliberately EXCLUDES the sweepable ones
 * (FAILED, FAILED_VALIDATION, FAILED_BATCH): those are documents the lane
 * intends to revisit, and treating them as terminal here would make the sweep
 * a no-op. It also excludes BATCHED — a batch in flight is not an answer.
 */
export const TERMINAL_PARSE_STATUSES: readonly string[] = [
  INGEST_PARSE_STATUS.EXTRACTED,
  INGEST_PARSE_STATUS.UNREADABLE,
  // A currency we cannot store does not become storable on a retry, and the
  // document is not going to be re-denominated.
  INGEST_PARSE_STATUS.UNSUPPORTED,
] as const;

export interface IngestDocState {
  /** `""` for the ~7,234 BSE rows whose attachment is gone upstream. */
  gcsPath?: string | null;
  mimeType?: string | null;
  /** Object size. Null when unknown — treated as "might be large". */
  fileBytes?: number | null;
  convertStatus?: string | null;
  markdownGcsPath?: string | null;
  /** Pages the converter judged to need OCR. */
  scannedPageCount?: number | null;
  /** Pages that yielded a text layer. */
  textPageCount?: number | null;
}

export interface LaneDecision {
  lane: IngestLane;
  /** Operator-facing. Always populated, including on the happy paths. */
  reason: string;
  /** Only meaningful when `lane === "skip"`. */
  parseStatus?: string;
}

/**
 * Is this document large enough that the vision lane cannot accept it?
 *
 * UNKNOWN SIZE COUNTS AS TOO LARGE — the conservative direction. A null here
 * means the orchestrator did not stat the object, and guessing "small" sends a
 * 222 MB upload at a 50 MB endpoint, which fails after paying the upload. The
 * cost of guessing "large" is that the document takes the markdown lane, which
 * is the lane we wanted anyway.
 */
export function exceedsVisionCeiling(
  fileBytes: number | null | undefined,
): boolean {
  if (fileBytes == null || !Number.isFinite(fileBytes)) return true;
  return fileBytes > MAX_PDF_BYTES;
}

/**
 * Did the conversion find a usable text layer?
 *
 * `textPageCount > 0` and NOT `scannedPageCount === 0`. The distinction
 * matters for the mixed document, which is the common case in Indian filings:
 * a born-digital annual report with three scanned signature pages is still
 * fully readable through markdown, and treating any scanned page as
 * disqualifying would push a large, perfectly good document onto a lane that
 * refuses it on size.
 *
 * This is the rule that disqualified `anydoc` as a converter: it rejects a
 * whole 341-page document because ONE page is scanned.
 */
export function hasUsableTextLayer(doc: IngestDocState): boolean {
  return typeof doc.textPageCount === "number" && doc.textPageCount > 0;
}

/** MONEY-1511. Ships PRESENT and "false"; see `isVisionArmed`. */
export const DOC_VISION_APPLY_ENV = "DOC_VISION_APPLY";

/**
 * Is the whole-PDF vision lane armed?
 *
 * Compared to the LITERAL string, never `Boolean()` — `Boolean("false")` is
 * true, which would arm the one configuration meant to keep it off. Read PER
 * CALL rather than captured in a module const: a module-level read freezes at
 * import, and on a warm Cloud Run container that turns a redeployed switch
 * into no switch at all.
 *
 * It ships PRESENT and "false" in both specs. Absent and explicitly-false must
 * not be the same state — that is how MF_METADATA_PROVIDER disabled its job
 * silently for months (MONEY-1214).
 */
export function isVisionArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DOC_VISION_APPLY_ENV] === "true";
}

/**
 * Route one document.
 *
 * `retryAfterGateFailure` is the second call for the same document: the
 * markdown lane produced an answer and the arithmetic gate rejected it. That
 * is the ONE case where spending vision tokens on a document we can already
 * read is worth it — a gate failure often means a table the converter
 * flattened wrongly, which vision sees correctly.
 */
export function decideIngestLane(
  doc: IngestDocState,
  opts: {
    /** The markdown was READ and its answer failed the arithmetic gate. */
    retryAfterGateFailure?: boolean;
    /**
     * The markdown was judged UNTRUSTWORTHY before any model saw it.
     *
     * MONEY-1314 review. Both cases used to arrive as
     * `retryAfterGateFailure`, and both therefore ended in
     * `FAILED_VALIDATION` when no second lane existed — a status that means
     * "the model answered and our arithmetic rejected it". For a document the
     * NORMALISER rejected, nothing answered. Recording it as a validation
     * failure attributes a verdict to a model that never ran, and puts the row
     * in the sweep's re-read set for an answer that was never produced.
     *
     * Same routing, different terminal status: UNREADABLE, because no lane can
     * produce a trustworthy reading of this document.
     */
    untrustedMarkdown?: boolean;
    /**
     * Whole-PDF vision is TURNED OFF — MONEY-1511, founder decision.
     *
     * The vision lane uploads the whole PDF to the Gemini Files API
     * (`ai.files.upload` -> activate -> generate -> delete, ~4 billed calls a
     * document) and it is the RETRY, so it fires on exactly the documents the
     * cheap lane could not read. Draining ~48,000 of them on 4 sharded tasks
     * produced 130,799 calls in three days — more than the whole algo
     * reviewer's 14-day steady state.
     *
     * Turning it off is NOT a new outcome. Both vision returns already have a
     * `skip` twin for the oversized case, each carrying the right terminal
     * status, so this is a second CAUSE of a state the caller already handles:
     * FAILED_VALIDATION where a model answered and the arithmetic rejected it,
     * UNREADABLE where nothing could read the document at all.
     *
     * The refusal stays NAMED. A document we deliberately decline to read is
     * fine; a document that vanishes is the defect this repo keeps paying for.
     */
    visionDisabled?: boolean;
  } = {},
): LaneDecision {
  if (!doc.gcsPath || doc.gcsPath.trim() === "") {
    return {
      lane: "skip",
      reason:
        "no stored object — BSE stopped serving this attachment upstream; the " +
        "metadata is still useful but there is no PDF to read",
      parseStatus: INGEST_PARSE_STATUS.UNREADABLE,
    };
  }

  if (doc.mimeType && !doc.mimeType.toLowerCase().includes("pdf")) {
    return {
      lane: "skip",
      reason: `mimeType ${doc.mimeType} is not a PDF`,
      parseStatus: INGEST_PARSE_STATUS.UNREADABLE,
    };
  }

  const tooBigForVision = exceedsVisionCeiling(doc.fileBytes);

  // ── vision is the only remaining lane ──────────────────────────────────
  //
  // Two ways to get here, and they differ in what the ROW should say:
  //   retryAfterGateFailure  a model READ the markdown and we rejected the
  //                          answer -> FAILED_VALIDATION
  //   untrustedMarkdown      the normaliser rejected the markdown before any
  //                          model saw it -> UNREADABLE, because nothing
  //                          answered and no lane can answer
  if (opts.retryAfterGateFailure || opts.untrustedMarkdown) {
    if (tooBigForVision) {
      const size =
        `${doc.fileBytes ?? "an unknown number of"} bytes, above the ` +
        `${MAX_PDF_BYTES}-byte vision ceiling`;
      return opts.untrustedMarkdown
        ? {
            lane: "skip",
            reason:
              `the markdown carries digits that migrated across column ` +
              `boundaries, and the document is ${size} — no lane can read it ` +
              "trustworthily, and no model has been asked",
            parseStatus: INGEST_PARSE_STATUS.UNREADABLE,
          }
        : {
            lane: "skip",
            reason:
              `the markdown answer failed the arithmetic gate and the document ` +
              `is ${size} — there is no second lane`,
            parseStatus: INGEST_PARSE_STATUS.FAILED_VALIDATION,
          };
    }
    if (opts.visionDisabled) {
      // Same terminal statuses as the oversized branch above: the cause
      // differs, the outcome does not.
      return opts.untrustedMarkdown
        ? {
            lane: "skip",
            reason:
              "the markdown could not be trusted and whole-PDF vision is " +
              "DISABLED (DOC_VISION_APPLY) — no model has been asked",
            parseStatus: INGEST_PARSE_STATUS.UNREADABLE,
          }
        : {
            lane: "skip",
            reason:
              "the markdown answer failed the arithmetic gate and whole-PDF " +
              "vision is DISABLED (DOC_VISION_APPLY) — there is no second lane",
            parseStatus: INGEST_PARSE_STATUS.FAILED_VALIDATION,
          };
    }
    return {
      lane: "vision",
      reason: opts.untrustedMarkdown
        ? "markdown is untrustworthy — reading the whole PDF instead"
        : "markdown answer failed the arithmetic gate — retrying whole-PDF",
    };
  }

  // ── never converted ────────────────────────────────────────────────────
  const converted = doc.convertStatus === CONVERT_STATUS.CONVERTED;
  const scannedOnly = doc.convertStatus === CONVERT_STATUS.SCANNED_ONLY;

  if (!converted && !scannedOnly) {
    // Includes PENDING, FAILED, and — the whole existing corpus — ABSENT.
    return {
      lane: "convert",
      reason: `convertStatus=${doc.convertStatus ?? "(absent)"} — needs conversion first`,
    };
  }

  // ── scanned: vision is the only reader ─────────────────────────────────
  if (scannedOnly || !hasUsableTextLayer(doc)) {
    if (tooBigForVision) {
      return {
        lane: "skip",
        reason:
          "every page needs OCR and the document is above the vision ceiling — " +
          "no lane can read it (scanned AND oversized)",
        parseStatus: INGEST_PARSE_STATUS.UNREADABLE,
      };
    }
    if (opts.visionDisabled) {
      return {
        lane: "skip",
        reason:
          "every page needs OCR and whole-PDF vision is DISABLED " +
          "(DOC_VISION_APPLY) — no lane can read a scanned document",
        parseStatus: INGEST_PARSE_STATUS.UNREADABLE,
      };
    }
    return {
      lane: "vision",
      reason: "no text layer — whole-PDF vision is the only reader",
    };
  }

  // ── the ordinary case ──────────────────────────────────────────────────
  if (!doc.markdownGcsPath) {
    // CONVERTED with a text layer but no sidecar recorded: the two writes
    // disagree. Re-convert rather than trust the status — the sidecar is the
    // artifact, the status is only a claim about it.
    return {
      lane: "convert",
      reason:
        "convertStatus=CONVERTED but no markdownGcsPath — the status and the " +
        "artifact disagree, so the artifact wins",
    };
  }

  return {
    lane: "markdown",
    reason: `${doc.textPageCount} text pages available`,
  };
}

/**
 * What to write for a parse outcome, and whether it is worth trying again.
 *
 * The distinction the whole queue depends on: a status that a forced run
 * re-selects must be one where a retry could plausibly differ. Marking a
 * deterministic failure retryable puts the same document into every subsequent
 * pass forever, which is how a queue stops draining without anything looking
 * wrong.
 */
export function classifyIngestOutcome(input: {
  /** From `DocParseResult.failure`. Null when the call itself succeeded. */
  failure: string | null;
  /** Did at least one mapped period survive validation? */
  gatePassed: boolean;
  /**
   * How many periods the model returned, BEFORE validation.
   *
   * Load-bearing, and it is the difference between two failures that look
   * identical from `gatePassed` alone:
   *
   *   periodsReturned > 0, none valid  ->  the model READ statements and our
   *                                        arithmetic rejected them. Usually a
   *                                        table the converter flattened
   *                                        wrongly, which is exactly what the
   *                                        vision lane sees correctly. RETRY.
   *   periodsReturned === 0            ->  the model read the document and
   *                                        found no statements. The lane this
   *                                        replaces recorded that this is
   *                                        "common and legitimate — a
   *                                        'quarterly result' attachment that
   *                                        is a covering letter". DO NOT
   *                                        RETRY: a whole-PDF vision call
   *                                        (~20,500 input tokens) would spend
   *                                        real money to re-confirm that a
   *                                        covering letter is a covering
   *                                        letter, once per such document
   *                                        across a 48,322-document corpus.
   */
  periodsReturned: number;
  /** Was this already the vision retry? */
  wasRetry: boolean;
  /**
   * Every reason the gate gave, across all rejected periods — MONEY-1348.
   *
   * Optional so existing callers compile, and ABSENT is not the same as empty:
   * absent means the caller did not supply them, empty means the gate gave
   * none. Neither can satisfy the all-NON_INR test, which is the safe
   * direction — a caller that forgets to pass them gets the old behaviour.
   */
  rejectionReasons?: readonly string[];
}): { parseStatus: string; retryable: boolean; retryWithVision: boolean } {
  // Transient — the call never produced an answer.
  if (input.failure === "CALL_FAILED" || input.failure === "UNCONFIGURED") {
    return {
      parseStatus: INGEST_PARSE_STATUS.FAILED,
      retryable: true,
      retryWithVision: false,
    };
  }

  // DECLINED, not failed — MONEY-1348.
  //
  // Checked BEFORE the gate arm below, because the model DID answer and our
  // arithmetic DID reject it, so it would otherwise land as FAILED_VALIDATION
  // and buy a whole-PDF vision retry. Vision reads the same dollars, at ~3x the
  // input tokens, once per such document.
  //
  // Only when EVERY rejection is this one. A document rejected for a currency
  // AND a broken balance sheet is still a parse problem worth re-reading.
  if (
    !input.gatePassed &&
    input.periodsReturned > 0 &&
    (input.rejectionReasons?.length ?? 0) > 0 &&
    input.rejectionReasons!.every((r) => r === "NON_INR_CURRENCY")
  ) {
    return {
      parseStatus: INGEST_PARSE_STATUS.UNSUPPORTED,
      retryable: false,
      retryWithVision: false,
    };
  }

  // Deterministic — the document itself is the problem.
  if (input.failure === "TOO_LARGE") {
    return {
      parseStatus: INGEST_PARSE_STATUS.UNREADABLE,
      retryable: false,
      retryWithVision: false,
    };
  }

  // OUR CEILING ran out, not the model's ability — MONEY-1334.
  //
  // This must be checked BEFORE the UNPARSEABLE arm below, because a truncated
  // answer is also unreadable and would otherwise inherit its disposition:
  // `retryWithVision: true`. Vision cannot help. It runs under the SAME output
  // ceiling, so the retry buys a GCS download of up to 50 MiB, a Files API
  // upload and a second paid generation to hit the identical wall — and the
  // logs then attribute our configuration to the model.
  //
  // Retryable but NOT re-transportable: raising the ceiling and re-sweeping is
  // the fix, so it lands as FAILED, which `buildSweepQuery` re-opens.
  if (input.failure === "TRUNCATED") {
    return {
      parseStatus: INGEST_PARSE_STATUS.FAILED,
      retryable: true,
      retryWithVision: false,
    };
  }

  // The model answered with something we could not read. On the markdown lane
  // that is worth one vision attempt; on the vision lane there is nothing left.
  if (input.failure === "UNPARSEABLE") {
    return {
      parseStatus: input.wasRetry
        ? INGEST_PARSE_STATUS.FAILED_VALIDATION
        : INGEST_PARSE_STATUS.FAILED,
      retryable: !input.wasRetry,
      retryWithVision: !input.wasRetry,
    };
  }

  if (!input.gatePassed) {
    // Nothing to re-read. See `periodsReturned` above.
    if (input.periodsReturned === 0) {
      return {
        parseStatus: INGEST_PARSE_STATUS.FAILED_VALIDATION,
        retryable: false,
        retryWithVision: false,
      };
    }
    return {
      parseStatus: INGEST_PARSE_STATUS.FAILED_VALIDATION,
      retryable: !input.wasRetry,
      retryWithVision: !input.wasRetry,
    };
  }

  return {
    parseStatus: INGEST_PARSE_STATUS.EXTRACTED,
    retryable: false,
    retryWithVision: false,
  };
}

/**
 * Split a stored sidecar back into PAGES, on the markers the converter wrote.
 *
 * `joinPagesToMarkdown` emits `<!-- page N -->` before each readable page, so
 * this is its inverse. It is here rather than inline in the orchestrator
 * because it has a real failure mode that nothing else would notice: a sidecar
 * written before the markers existed, or by a different writer, splits into
 * ZERO pages — and a zero-page selection sends empty markdown to the model,
 * which correctly calls it UNPARSEABLE. That reads as a model problem and is a
 * storage-format problem.
 *
 * So an unmarked sidecar returns ONE page numbered 1, carrying the whole text.
 * The page selector then has something to work with (it will report `all-fit`
 * or score the single page), and the document is read rather than silently
 * failed. The cost is that page citations for such a document are all "1",
 * which is honest — we do not know where anything came from.
 */
export function splitPageMarkedMarkdown(
  raw: string,
): { pageNumber: number; markdown: string }[] {
  if (!raw || raw.trim().length === 0) return [];

  const parts = raw.split(/<!-- page (\d+) -->/);
  // `split` with a capture group yields [before, n1, body1, n2, body2, …].
  // `parts[0]` is whatever preceded the first marker — normally empty.
  if (parts.length < 3) {
    return [{ pageNumber: 1, markdown: raw.trim() }];
  }

  const pages: { pageNumber: number; markdown: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const n = Number(parts[i]);
    const body = (parts[i + 1] ?? "").trim();
    // A marker with no body is a page that converted to nothing. Dropping it
    // keeps the selector's density arithmetic honest — an empty page would
    // otherwise count toward the denominator and dilute every real page.
    if (Number.isFinite(n) && body.length > 0) {
      pages.push({ pageNumber: n, markdown: body });
    }
  }
  return pages.length > 0 ? pages : [{ pageNumber: 1, markdown: raw.trim() }];
}
