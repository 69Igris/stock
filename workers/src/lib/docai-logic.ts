/**
 * Document AI request shaping — PURE (no client, no env, no I/O).
 *
 * Extracted out of `lib/docai.ts` so the ONE flag that decides whether a call
 * succeeds at all is written down once, in a module that can be unit-tested
 * without constructing a `DocumentProcessorServiceClient` or resolving
 * credentials at import time. `docai.ts` imports and CALLS this, so the
 * production path and the tests execute the same builder.
 *
 * ## MONEY-1269 — every Document AI call in this repo was failing
 *
 * Measured on prod: **59 of 59** calls in one 3-hour window on 2026-08-29
 * failed, and it was still failing on 2026-09-05. The error names its own fix:
 *
 *   3 INVALID_ARGUMENT: Document pages in non-imageless mode exceed the limit:
 *   15 got 16. Try using imageless mode to increase the limit to 30.
 *
 * It was INVISIBLE because `docai.ts` is deliberately never-throwing: every
 * failure degrades to `{ text: null, degraded: true }` and the caller silently
 * falls back to `pdf-parse`. So `stock-document-extract` reported success every
 * night while the layout-aware OCR it was chosen for had never once run. The
 * fallback did not mask a slow path — it masked a path that did not exist.
 *
 * `imagelessMode` drops the page IMAGES from the response, which is the whole
 * reason the page ceiling triples: we consume `document.text` and never the
 * rendered page bitmaps, so nothing downstream loses anything. The field is
 * real on this client — `@google-cloud/documentai` 9.6.2 declares
 * `ProcessRequest.imagelessMode?: (boolean|null)`
 * (`build/protos/protos.d.ts:9651`).
 *
 * ## The 30-page ceiling is still a ceiling
 *
 * Imageless mode raises the synchronous `processDocument` limit from 15 pages
 * to 30. It does not remove it. A 300-page annual report still fails, still
 * degrades, and still lands on the `pdf-parse` fallback — that is the EXPECTED
 * outcome for those documents and is deliberately not addressed here. Moving
 * them would mean `batchProcessDocuments` (async, GCS-output, a different
 * result-collection shape and a different failure model), which is its own
 * piece of work.
 *
 * @see workers/src/lib/docai.ts (the only caller)
 * @see workers/__tests__/lib/docai-logic.test.ts
 */

// TYPE-ONLY: erased at build time, so this module still loads nothing from the
// vendor package at runtime and stays safe to import from a test.
import type { protos } from "@google-cloud/documentai";

/** The request shape `DocumentProcessorServiceClient.processDocument` takes. */
export type DocumentAiProcessRequest =
  protos.google.cloud.documentai.v1.IProcessRequest;

/**
 * Where the bytes come from.
 *
 * A TAGGED union rather than "whichever field is present", because the two
 * shapes are mutually exclusive in the API and an object carrying both is
 * accepted by the type system while being rejected by the service. The tag
 * makes the caller state which one it means.
 *
 *   "gcs"   — the processor reads the object itself. Right for a normal
 *             document, where `gcsPath` names the PDF.
 *   "bytes" — we ship the content inline. Required when the bytes exist only
 *             in memory: a member recovered from a ZIP (MONEY-1319), where the
 *             object at `gcsPath` is the ARCHIVE and pointing the processor at
 *             it repeats the failure that branch exists to fix.
 */
export type DocumentAiInput =
  | { readonly source: "gcs"; readonly gcsUri: string }
  | { readonly source: "bytes"; readonly content: Buffer };

/**
 * Build the `processDocument` request for either source shape.
 *
 * BOTH entry points in `docai.ts` route through this, and that is the point of
 * the function rather than a stylistic preference: `imagelessMode` set in one
 * call site and missed in the other reproduces MONEY-1269 for exactly one of
 * the two lanes, which is strictly harder to see than the whole-job version
 * was — the inline lane serves the 179 archive rows and the GCS lane serves
 * everything else, so a half-fix would look like a partial recovery.
 */
export function buildProcessRequest(
  processorName: string,
  input: DocumentAiInput,
  mimeType: string,
): DocumentAiProcessRequest {
  return {
    name: processorName,
    // MONEY-1269. Never conditional, never an env flag: the non-imageless
    // ceiling of 15 pages is below the size of an ordinary results filing, so
    // "off" is not a configuration anyone would choose — it is the state the
    // job spent months in without knowing.
    imagelessMode: true,
    ...(input.source === "gcs"
      ? { gcsDocument: { gcsUri: input.gcsUri, mimeType } }
      : { rawDocument: { content: input.content, mimeType } }),
  };
}
