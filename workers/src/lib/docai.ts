/**
 * Google Document AI integration (MONEY-783) — layout-aware PDF text extraction.
 *
 * Lazy + graceful, mirroring the GCS client in this package (`lib/gcs.ts`):
 *   - The client is constructed on first use and never throws at import time.
 *   - `extractWithDocumentAi` degrades to `{ text: null, degraded: true }` (with
 *     a clear warning) whenever the project, the processor env, or the
 *     credentials are missing, or when the call fails. It NEVER throws.
 *
 * Configuration (read from process.env):
 *   - DOCUMENT_AI_PROCESSOR_ID  — the processor id (REQUIRED to run a real parse).
 *   - DOCUMENT_AI_LOCATION      — processor region; defaults to "us".
 *   - GCP_PROJECT_ID            — the GCP project (shared with gcs.ts).
 *   - credentials               — resolved via `googleCredentials()`
 *     (GCP_SERVICE_ACCOUNT_KEY_BASE64 → GOOGLE_APPLICATION_CREDENTIALS_JSON →
 *     GOOGLE_APPLICATION_CREDENTIALS file → ADC on Cloud Run).
 *
 * The processor name resolves to:
 *   projects/{project}/locations/{location}/processors/{processorId}
 *
 * Create a "Document OCR" processor in the console / via the Document AI API,
 * then drop its id into DOCUMENT_AI_PROCESSOR_ID.
 *
 * NOTE: the synchronous `processDocument` online API caps at 30 pages IN
 * IMAGELESS MODE (15 without it — see `docai-logic.ts`, MONEY-1269). Documents
 * over 30 pages still exceed it, still degrade, and still land on the caller's
 * `pdf-parse` fallback. That is the EXPECTED outcome for them and is not fixed
 * here; moving them would mean `batchProcessDocuments` (async, GCS-output).
 */

import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { googleCredentials } from "@usemoney/core/gemini/credentials";
// MONEY-1269 — the request shape, including `imagelessMode`, lives in ONE pure
// builder so the flag cannot be set on one entry point and missed on the other.
import { buildProcessRequest } from "./docai-logic";

let cachedClient: DocumentProcessorServiceClient | null = null;
let initialized = false;

/** Default Document AI processor region. Document AI runs in us / eu / regional. */
export const DEFAULT_DOCUMENT_AI_LOCATION = "us";

/** The configured Document AI processor location (DOCUMENT_AI_LOCATION or "us"). */
export function documentAiLocation(): string {
  return (
    process.env.DOCUMENT_AI_LOCATION?.trim() || DEFAULT_DOCUMENT_AI_LOCATION
  );
}

/** The configured Document AI processor id, or "" when unset. */
export function documentAiProcessorId(): string {
  return process.env.DOCUMENT_AI_PROCESSOR_ID?.trim() || "";
}

/**
 * True when Document AI can actually run: the project is set AND a processor id
 * is configured. Callers use this to decide whether to attempt a parse — when
 * false, the extract worker goes straight to the pdf-parse fallback, so it WORKS
 * even before the processor is provisioned.
 */
export function documentAiReady(): boolean {
  return !!process.env.GCP_PROJECT_ID && documentAiProcessorId().length > 0;
}

/** Build the fully-qualified processor resource name, or null when unconfigured. */
export function processorName(): string | null {
  const project = process.env.GCP_PROJECT_ID;
  const processorId = documentAiProcessorId();
  if (!project || !processorId) return null;
  return `projects/${project}/locations/${documentAiLocation()}/processors/${processorId}`;
}

/**
 * Returns a memoised DocumentProcessorServiceClient, or null when unconfigured.
 *
 * The client must talk to the regional Document AI endpoint matching the
 * processor location (e.g. us-documentai.googleapis.com). Construction is
 * wrapped so placeholder creds can't throw at import/build time. Credentials
 * resolve via the shared `googleCredentials()` resolver (base64 → JSON-var →
 * key-file → ADC), the same path as the Storage / Pub/Sub clients.
 */
export function getDocumentAiClient(): DocumentProcessorServiceClient | null {
  if (initialized) return cachedClient;
  initialized = true;

  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    console.warn(
      "[docai] GCP_PROJECT_ID not set — Document AI disabled, running degraded",
    );
    cachedClient = null;
    return cachedClient;
  }

  try {
    const apiEndpoint = `${documentAiLocation()}-documentai.googleapis.com`;
    // Spread the resolver first; pin apiEndpoint + the explicit GCP_PROJECT_ID
    // last so the resolver's derived projectId never overrides it.
    cachedClient = new DocumentProcessorServiceClient({
      ...googleCredentials(),
      apiEndpoint,
      projectId,
    });
  } catch (err) {
    console.warn(
      `[docai] client construction failed; running degraded: ${err instanceof Error ? err.message : err}`,
    );
    cachedClient = null;
  }

  return cachedClient;
}

export interface ExtractDocumentResult {
  /** The extracted plain text, or null when extraction degraded. */
  text: string | null;
  /** Number of pages Document AI reported (0 when unknown / degraded). */
  pageCount: number;
  /** True when no real extraction happened (unconfigured / empty / failed). */
  degraded: boolean;
}

/**
 * Ceiling on the bytes handed to {@link extractWithDocumentAiBytes}.
 *
 * Document AI's synchronous `processDocument` refuses an inline `rawDocument`
 * over 20 MB. Refusing it here rather than letting the API do it is the
 * difference between a degrade (the pdf-parse fallback runs over the same
 * bytes) and an exception inside the vendor client on a document we can still
 * read — and it saves a pointless cross-region round trip carrying 20 MB.
 */
export const DOCUMENT_AI_INLINE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Extract text from bytes we HOLD, rather than from an object in GCS.
 *
 * ## Why a second entry point exists — MONEY-1319
 *
 * {@link extractWithDocumentAi} hands Document AI a `gcsUri` and the processor
 * reads the object itself. That is right for every normal document and WRONG
 * for the 179 rows whose stored object is a ZIP: the document is a member
 * INSIDE the archive, so the object at `gcsPath` is not the thing to parse.
 * Pointing the processor at it is exactly the waste this ticket measured — 126
 * of those rows are already `FAILED` after Document AI was asked to read ZIP
 * bytes.
 *
 * The recovered member is never written back to GCS, deliberately. Uploading it
 * beside the archive would create a second object claiming to be the same
 * document, under a key nothing else derives, and the row's `gcsPath` would
 * still name the archive — provenance split across two objects to save one
 * decompression that costs milliseconds.
 *
 * Same contract as its sibling: it NEVER throws, and every failure — no
 * processor, no client, over the size ceiling, no text, an exception — comes
 * back as `{ text: null, degraded: true }` so the caller's pdf-parse fallback
 * runs over the identical bytes.
 */
export async function extractWithDocumentAiBytes(
  bytes: Buffer,
  mimeType: string = "application/pdf",
): Promise<ExtractDocumentResult> {
  const processor = processorName();
  if (!processor) {
    console.warn(
      "[docai] DOCUMENT_AI_PROCESSOR_ID not set — skipping Document AI parse",
    );
    return { text: null, pageCount: 0, degraded: true };
  }

  if (bytes.length === 0 || bytes.length > DOCUMENT_AI_INLINE_MAX_BYTES) {
    console.warn(
      `[docai] inline document is ${bytes.length} bytes (limit ` +
        `${DOCUMENT_AI_INLINE_MAX_BYTES}) — degrading to the caller's fallback`,
    );
    return { text: null, pageCount: 0, degraded: true };
  }

  const client = getDocumentAiClient();
  if (!client) {
    return { text: null, pageCount: 0, degraded: true };
  }

  try {
    const [result] = await client.processDocument(
      buildProcessRequest(processor, { source: "bytes", content: bytes }, mimeType),
    );

    const doc = result.document;
    const text = typeof doc?.text === "string" ? doc.text : "";
    const pageCount = doc?.pages?.length ?? 0;

    if (!text) {
      console.warn(
        "[docai] processDocument (inline) returned no text; treating as degraded",
      );
      return { text: null, pageCount, degraded: true };
    }

    return { text, pageCount, degraded: false };
  } catch (err) {
    console.warn(
      `[docai] processDocument (inline) failed: ${err instanceof Error ? err.message : err}`,
    );
    return { text: null, pageCount: 0, degraded: true };
  }
}

/**
 * Extract layout-aware plain text from a PDF already in GCS via Document AI.
 *
 * The processor reads the object directly via `gcsDocument`. Returns
 * `{ text, pageCount }` on success; degrades to `{ text: null, degraded: true }`
 * — with a clear warning — when the project, processor env, or credentials are
 * missing, when the call returns no text, or when the call throws. NEVER throws.
 */
export async function extractWithDocumentAi(
  gcsUri: string,
  mimeType: string = "application/pdf",
): Promise<ExtractDocumentResult> {
  const processor = processorName();
  if (!processor) {
    console.warn(
      "[docai] DOCUMENT_AI_PROCESSOR_ID not set — skipping Document AI parse",
    );
    return { text: null, pageCount: 0, degraded: true };
  }

  const client = getDocumentAiClient();
  if (!client) {
    return { text: null, pageCount: 0, degraded: true };
  }

  try {
    const [result] = await client.processDocument(
      buildProcessRequest(processor, { source: "gcs", gcsUri }, mimeType),
    );

    const doc = result.document;
    const text = typeof doc?.text === "string" ? doc.text : "";
    const pageCount = doc?.pages?.length ?? 0;

    if (!text) {
      console.warn(
        "[docai] processDocument returned no text; treating as degraded",
      );
      return { text: null, pageCount, degraded: true };
    }

    return { text, pageCount, degraded: false };
  } catch (err) {
    console.warn(
      `[docai] processDocument failed: ${err instanceof Error ? err.message : err}`,
    );
    return { text: null, pageCount: 0, degraded: true };
  }
}
