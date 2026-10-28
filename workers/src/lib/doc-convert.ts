/**
 * PDF -> markdown, the I/O half — MONEY-1314.
 *
 * All decisions live in `@usemoney/core/market-data/doc-convert-logic` and
 * `.../doc-number-normaliser-logic`, which are pure. This module does four
 * things that are not decisions: it peels, it checks, it calls the library,
 * and it limits concurrency.
 *
 * NEVER THROWS. Every path returns a `ConvertResult` whose `status` says what
 * to record. A conversion is not worth failing a message over — the document
 * is still there and the sidecar is idempotent.
 *
 * ## Why the concurrency limit is not optional
 *
 * MEASURED: peak RSS is 2.3-4.8x file size — 618 MB for a 129.81 MB PDF —
 * and 109 archive objects exceed 40 MB. The ingest service runs with 2 GiB.
 * The arithmetic that sizes `DEFAULT_MAX_CONCURRENCY`:
 *
 *     2048 MiB  container
 *     - 68 MiB  Node's own floor
 *     ---------
 *     1980 MiB  available
 *     / 618 MiB worst single conversion measured
 *     ---------
 *          3.2  concurrent worst-case conversions
 *
 * and it ships at ONE, not three, because the worst case measured is not the
 * worst case possible: the largest object in the corpus is 222.3 MB, which at
 * the same multiplier is ~1.1 GiB on its own. Two of those concurrently is an
 * OOM kill, which on Cloud Run takes the whole container — including every
 * other in-flight message — not just the offending conversion.
 *
 * The semaphore is PROCESS-WIDE, so it also has to survive the service's
 * `containerConcurrency`: an ingest instance accepting 10 simultaneous pushes
 * would otherwise start 10 conversions. The limit here is the second guard;
 * the first is the service's own concurrency setting.
 *
 * ## Async only
 *
 * `classifyPdf` / `extractPagesMarkdown` (the SYNC variants) block the event
 * loop for the whole parse — 12 seconds on the worst document measured — which
 * on a Hono server means every other request, the health check included,
 * stalls behind it. Only the `…Async` variants are imported, and a test
 * asserts the sync names appear nowhere in this file.
 */

// The barrel, deliberately. `@usemoney/storage` publishes exactly one export
// (`"." -> ./src/index.ts`) and every consumer in the repo reaches these two
// helpers through it — the subpath-over-barrel rule is a `@usemoney/core`
// convention, and inventing a subpath here would make this the only importer
// that does.
import { isMultipartEnvelope, stripMultipartEnvelope } from "@usemoney/storage";
import {
  assessExtraction,
  joinPagesToMarkdown,
  looksLikePdf,
  describeNonPdf,
  estimatePeakRssBytes,
  type ExtractedPage,
  type ConvertAssessment,
} from "@usemoney/core/market-data/doc-convert-logic";
import { normaliseDocumentMarkdown } from "@usemoney/core/market-data/doc-number-normaliser-logic";

const logger = {
  info: (m: string) => console.log(`[doc-convert] ${m}`),
  warn: (m: string) => console.warn(`[doc-convert] ${m}`),
};

/** See the arithmetic in the module docblock. */
export const DEFAULT_MAX_CONCURRENCY = 1;

/**
 * The container's memory limit, in MiB — DECLARED, not guessed.
 *
 * MONEY-1314 review. The ceiling below was derived against "2048 MiB
 * container", which is what the backfill JOB gets. The workers SERVICE ships
 * `memory: 1Gi` at `containerConcurrency: 10` (cloudbuild.{prod,qa}.yaml), so
 * the refusal ceiling was 1.6x the real limit and admitted any file up to
 * ~319 MB — the corpus maximum is 222.3 MB and 109 objects exceed 40 MB. A
 * ~200 MB annual report estimated ~1.0 GB, passed, and OOM-killed the
 * container.
 *
 * So it is read from the environment and SET EXPLICITLY in both specs beside
 * the memory limit it describes, and `doc-convert-memory.test.ts` asserts the
 * two agree. An OOM kill takes the whole container — every other in-flight
 * message with it, each possibly mid-Gemini-call — so this number being wrong
 * is not a per-document failure.
 *
 * MONEY-1373 raised the service from 1Gi to 4Gi — for the candle-eviction
 * leaves, not for this lane — so the DEFAULT moves with it. The default and
 * the declared value must never be a third number: absence and presence have
 * to mean the same thing, which is the MONEY-1214 discipline, and here it is
 * load-bearing in the dangerous direction. A default BELOW the real limit only
 * refuses work; a default ABOVE it admits a document that OOM-kills the
 * container, which is exactly the defect this constant was extracted for.
 */
export const DEFAULT_CONTAINER_MEMORY_MI = 4096;
export const NODE_FLOOR_MI = 68;

/**
 * How much of the container ONE conversion may be estimated to need.
 *
 * Not the whole free space. `containerConcurrency: 10` means up to nine other
 * requests are alive alongside the conversion — and the caller downloads the
 * object BEFORE acquiring the convert semaphore, so their Buffers are resident
 * too. Half of what is left after Node's floor is the share this lane claims.
 *
 * The consequence used to be stated as "at 1 GiB the worker refuses documents
 * it could convert at 2 GiB", with the deferral going to the
 * `doc-ingest-backfill` Cloud Run JOB. MONEY-1373 raised the SERVICE to 4Gi
 * for the candle-eviction leaves, so this lane's share went with it: usable is
 * now (4096 - 68) x 0.5 = 2,014 MiB, which admits the 222.3 MB corpus maximum
 * with room over. The deferral path is unchanged and still correct for
 * anything larger.
 *
 * The share stays at HALF rather than rising, because the reason for it did
 * not change: `containerConcurrency: 10` means up to nine other requests are
 * alive alongside the conversion, and after MONEY-1373 some of them may be
 * eviction leaves holding a 250 MB decoded shard each.
 */
export const CONVERT_MEMORY_SHARE = 0.5;

export function containerMemoryMi(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env["DOC_CONVERT_CONTAINER_MI"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONTAINER_MEMORY_MI;
}

export function maxEstimatedRssBytes(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = Number(env["DOC_CONVERT_MAX_RSS_MI"]);
  if (Number.isFinite(explicit) && explicit > 0) return explicit * 1024 * 1024;
  const usable = Math.max(containerMemoryMi(env) - NODE_FLOOR_MI, 0);
  return Math.floor(usable * CONVERT_MEMORY_SHARE) * 1024 * 1024;
}

export type ConvertStatus =
  | "CONVERTED"
  | "SCANNED_ONLY"
  | "FAILED"
  /** Not a PDF, or too large to attempt. Deterministic — never retry as-is. */
  | "UNREADABLE";

export interface ConvertResult {
  status: ConvertStatus;
  /** Normalised, page-marked markdown. Empty unless status is CONVERTED. */
  markdown: string;
  assessment: ConvertAssessment | null;
  /** The normaliser wants this document read by vision instead. */
  failOverToVision: boolean;
  /** Was a MONEY-1169 multipart envelope peeled off first? */
  envelopePeeled: boolean;
  /**
   * The size of the bytes actually parsed — AFTER peeling.
   *
   * MONEY-1315. `stock_documents.fileSize` records what was STORED, which for
   * an enveloped object is the envelope: 212.03 MB for a PDF that is a
   * fraction of that. `feed-repair` fixes the object and is deliberately
   * GCS-only, so it leaves the row saying the old number.
   *
   * That is not cosmetic here. `exceedsVisionCeiling` reads `fileSize`, and
   * unknown-or-large means "refuse", so an enveloped row is barred from the
   * vision lane on a size it does not have; and the converter's own RSS
   * estimate is derived from it. Reporting the true size lets the caller
   * correct the row as a side effect of reading it.
   */
  payloadBytes: number;
  error: string | null;
  elapsedMs: number;
}

function emptyResult(
  status: ConvertStatus,
  error: string | null,
  elapsedMs = 0,
  envelopePeeled = false,
  payloadBytes = 0,
): ConvertResult {
  return {
    status,
    markdown: "",
    assessment: null,
    failOverToVision: false,
    envelopePeeled,
    payloadBytes,
    error,
    elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// SEMAPHORE
// ---------------------------------------------------------------------------

let inFlight = 0;
const waiters: (() => void)[] = [];

function maxConcurrency(): number {
  const raw = Number(process.env.DOC_CONVERT_MAX_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_CONCURRENCY;
}

/**
 * THE SLOT IS HANDED OVER, NOT RE-TAKEN.
 *
 * MONEY-1314 review. The first version decremented in `release()` and then
 * resolved a waiter, while the waiter incremented on resume. Those are
 * separated by a microtask, and a NEW `acquire()` arriving in between sees
 * `inFlight < max`, takes the slot, and increments too — so both run and the
 * limit is exceeded. At concurrency 10 on a request-driven service that is not
 * a rare interleaving; it is the ordinary one.
 *
 * Now `release()` passes the slot directly when someone is waiting and only
 * decrements when nobody is, and the waiter does NOT increment on resume
 * because it inherits the count it was handed. The invariant is that
 * `inFlight` changes exactly once per acquire/release pair.
 */
async function acquire(): Promise<void> {
  if (inFlight < maxConcurrency()) {
    inFlight++;
    return;
  }
  // No increment on resume — the slot is inherited from `release()`.
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    // Hand the slot straight over. `inFlight` is deliberately unchanged: the
    // waiter is taking the permit this caller is giving up, and any window in
    // which the count dips is a window a new arrival can exploit.
    next();
    return;
  }
  inFlight--;
}

/**
 * Test seams for the semaphore itself.
 *
 * The race this guards cannot be reproduced through `convertPdfToMarkdown`:
 * the window is one microtask between `release()` returning and a waiter
 * resuming, and nothing in the public API can be scheduled into it on purpose.
 * A behavioural test that starts N conversions and checks the peak is
 * timing-dependent and passes against the broken version — measured, it did.
 *
 * So the primitives are exported and driven directly, which makes the
 * interleaving deterministic instead of hopeful.
 */
export const __semaphoreForTests = {
  acquire: () => acquire(),
  release: () => release(),
  inFlight: () => inFlight,
  waiting: () => waiters.length,
};

/** Test seam — the queue is module state and a leaked permit deadlocks it. */
export function __resetConvertSemaphoreForTests(): void {
  inFlight = 0;
  waiters.length = 0;
}

// ---------------------------------------------------------------------------
// THE LIBRARY
// ---------------------------------------------------------------------------

type ExtractFn = (bytes: Buffer) => Promise<{ pages: ExtractedPage[] }>;

/**
 * TRI-STATE, and the third state is the point.
 *
 *   undefined  not attempted yet
 *   null       attempted and UNAVAILABLE
 *   function   loaded
 *
 * A two-state `ExtractFn | null` cannot tell "not tried" from "tried and
 * failed", so a permanently missing native binding re-attempts the dynamic
 * import once per document — and a test cannot force the unavailable branch at
 * all, because setting null just means "load it again".
 *
 * Caching the FAILURE is correct here and is not the fail-open default this
 * repo forbids caching. A napi binding that did not load will not start
 * loading: the outcome is deterministic for the lifetime of the process, and a
 * new revision is a new process. What must never be cached is a "couldn't
 * determine" masquerading as an answer; this is a determinate answer.
 */
let extractFn: ExtractFn | null | undefined = undefined;

/**
 * Load the napi binding lazily.
 *
 * Never at module scope: this file is imported by the worker's route graph and
 * by a backfill script, and a native module that fails to load must degrade to
 * a counted FAILED rather than take down the process at import — which is the
 * one failure mode a health check cannot report, because the server never
 * starts.
 */
async function getExtractFn(): Promise<ExtractFn | null> {
  if (extractFn !== undefined) return extractFn;
  try {
    const mod = (await import("@firecrawl/pdf-inspector")) as unknown as {
      extractPagesMarkdownAsync: ExtractFn;
    };
    if (typeof mod.extractPagesMarkdownAsync !== "function") {
      logger.warn("pdf-inspector loaded but extractPagesMarkdownAsync is absent");
      extractFn = null;
      return null;
    }
    extractFn = mod.extractPagesMarkdownAsync;
    return extractFn;
  } catch (err) {
    logger.warn(
      `pdf-inspector failed to load: ${err instanceof Error ? err.message : String(err)}`,
    );
    extractFn = null;
    return null;
  }
}

/** Test seam. `null` forces the UNAVAILABLE branch; it does not mean "reload". */
export function __setExtractFnForTests(fn: ExtractFn | null): void {
  extractFn = fn;
}

/** Test seam. Restores the "not attempted" state so the real import runs. */
export function __resetExtractFnForTests(): void {
  extractFn = undefined;
}

// ---------------------------------------------------------------------------
// THE CONVERSION
// ---------------------------------------------------------------------------

export interface ConvertInput {
  /** The object's stored bytes, exactly as GCS returned them. */
  bytes: Buffer;
  /** For logging. */
  label: string;
  maxEstimatedRssBytes?: number;
}

export async function convertPdfToMarkdown(
  input: ConvertInput,
): Promise<ConvertResult> {
  const startedAt = Date.now();

  if (!input.bytes || input.bytes.length === 0) {
    return emptyResult("UNREADABLE", "empty object");
  }

  // ── peel MONEY-1169 first ────────────────────────────────────────────────
  //
  // Before any magic-byte test. A stored multipart envelope has an INTACT PDF
  // inside it, so testing the envelope's own first bytes would reject a
  // perfectly good 212 MB annual report as "not a PDF". Two of the six largest
  // objects sampled are exactly this.
  let bytes = input.bytes;
  let envelopePeeled = false;
  if (isMultipartEnvelope(bytes)) {
    const stripped = stripMultipartEnvelope(bytes);
    if (stripped) {
      bytes = stripped.payload;
      envelopePeeled = true;
      logger.info(
        `${input.label}: peeled a MONEY-1169 envelope, ` +
          `${input.bytes.length} -> ${bytes.length} bytes`,
      );
    } else {
      return emptyResult(
        "UNREADABLE",
        "looks like a multipart envelope but could not be unwrapped",
        Date.now() - startedAt,
      );
    }
  }

  if (!looksLikePdf(bytes)) {
    return emptyResult(
      "UNREADABLE",
      describeNonPdf(bytes),
      Date.now() - startedAt,
      envelopePeeled,
      bytes.length,
    );
  }

  // ── refuse before the OOM, not after ─────────────────────────────────────
  const ceiling = input.maxEstimatedRssBytes ?? maxEstimatedRssBytes();
  const estimate = estimatePeakRssBytes(bytes.length);
  if (estimate > ceiling) {
    return emptyResult(
      "UNREADABLE",
      `estimated peak ${Math.round(estimate / 1e6)} MB for a ` +
        `${Math.round(bytes.length / 1e6)} MB document exceeds the ` +
        `${Math.round(ceiling / 1e6)} MB ceiling — declining rather than ` +
        "risking an OOM kill, which would take every other in-flight message",
      Date.now() - startedAt,
      envelopePeeled,
      bytes.length,
    );
  }

  const extract = await getExtractFn();
  if (!extract) {
    // TRANSIENT, not UNREADABLE: the document is fine, our binding is not.
    return emptyResult(
      "FAILED",
      "pdf-inspector is unavailable in this runtime",
      Date.now() - startedAt,
      envelopePeeled,
      bytes.length,
    );
  }

  await acquire();
  try {
    const out = await extract(bytes);
    const pages = Array.isArray(out?.pages) ? out.pages : [];
    const assessment = assessExtraction(pages);
    const elapsedMs = Date.now() - startedAt;

    if (assessment.status !== "CONVERTED") {
      logger.info(
        `${input.label}: ${assessment.status} ` +
          `(${assessment.scannedPageCount}/${assessment.totalPageCount} need OCR) ` +
          `elapsedMs=${elapsedMs}`,
      );
      return {
        ...emptyResult(
          assessment.status,
          null,
          elapsedMs,
          envelopePeeled,
          bytes.length,
        ),
        assessment,
      };
    }

    const joined = joinPagesToMarkdown(pages);
    const normalised = normaliseDocumentMarkdown(joined);

    logger.info(
      `${input.label}: CONVERTED ${assessment.textPageCount}/${assessment.totalPageCount} pages, ` +
        `${normalised.markdown.length} chars, ` +
        `orphanCells=${normalised.findings.orphanDigitCells} ` +
        `mergedCells=${normalised.findings.mergedColumnCells} ` +
        `raggedRows=${normalised.findings.raggedRows} ` +
        `failOver=${normalised.failOverToVision} elapsedMs=${elapsedMs}`,
    );

    return {
      status: "CONVERTED",
      markdown: normalised.markdown,
      assessment,
      failOverToVision: normalised.failOverToVision,
      envelopePeeled,
      payloadBytes: bytes.length,
      error: normalised.reason,
      elapsedMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const elapsedMs = Date.now() - startedAt;
    logger.warn(`${input.label}: conversion threw after ${elapsedMs}ms: ${message}`);
    // The library's own rejections ("Invalid PDF structure", "Not a PDF: …")
    // are DETERMINISTIC — a truncated file is truncated on every attempt — so
    // they are UNREADABLE rather than FAILED. Anything else is transient.
    const deterministic =
      /not a pdf|invalid pdf|encrypted|password/i.test(message);
    return emptyResult(
      deterministic ? "UNREADABLE" : "FAILED",
      message,
      elapsedMs,
      envelopePeeled,
      bytes.length,
    );
  } finally {
    release();
  }
}
