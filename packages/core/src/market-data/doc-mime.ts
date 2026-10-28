/**
 * `StockDocument.mimeType` — one normalizer, one eligibility rule (MONEY-1255).
 *
 * ## The defect this file exists to close
 *
 * `mimeType` is written from the raw `content-type` RESPONSE HEADER, and a
 * response header is a media type PLUS PARAMETERS. Screener answers
 * `application/pdf;charset=UTF-8` for some documents. The extract worker's
 * query filters `mimeType: { in: ["application/pdf"] }` — an EXACT match — so
 * the parameterised spelling was stored, never selected, and the row sat
 * `PENDING` forever.
 *
 * Nothing looked broken, and that is the interesting part: `inferExtension`
 * decided the GCS object name with a SUBSTRING test (`.includes("pdf")`), so
 * the file was correctly named `.pdf` while the column that decides
 * eligibility said something the query could not match. A correct filename
 * beside an unreachable row.
 *
 * Measured on prod 2026-08-26 over 36,001 PENDING `stock_documents`:
 *
 *     application/pdf                34,790   selectable
 *     text/html; charset=UTF-8          863   never extractable
 *     text/html; charset=utf-8          228   never extractable
 *     text/html                          99   never extractable
 *     audio/mpeg                         13   never extractable
 *     application/zip                     5   never extractable
 *     text/html;charset=UTF-8             1   never extractable
 *     text/html;charset=utf-8             1   never extractable
 *     application/pdf;charset=UTF-8       1   IS a PDF, unreachable
 *
 * 1,211 rows the extractor could never take, in nine spellings of four media
 * types.
 *
 * ## Why it lives in `@usemoney/core` rather than in the worker
 *
 * There are TWO writers of this column from a raw header —
 * `workers/src/processors/stock-document-sync.ts` (the weekly Screener leg,
 * which produced the rows above) and
 * `packages/research/src/data-sources/stock-document-fetcher.ts` (reached today
 * only by `scripts/seed/seed-stock-documents.ts`, but writing the same table
 * with the same shape). Neither package can import the other. A rule restated
 * in two places is a rule that drifts, and this one already drifted once —
 * between the filename and the column, inside a single function.
 *
 * PURE LEAF: no imports, no I/O. Import it by SUBPATH
 * (`@usemoney/core/market-data/doc-mime`), never through the market-data
 * barrel.
 */

/** The canonical PDF media type. The only mimeType the extract job can read. */
export const CANONICAL_PDF_MIME_TYPE = "application/pdf";

/** The media type of a ZIP archive holding a document. */
export const ZIP_MIME_TYPE = "application/zip";

/**
 * Media types whose STORED BYTES a reader consumes directly.
 *
 * "Direct" is the property that matters to a consumer: download the object at
 * `gcsPath`, hand those exact bytes (or that exact `gs://` URI) to Document AI,
 * to the Gemini Files API, to Vertex, to pdf-inspector — and it can read them.
 * No unwrapping step, so no capability is assumed of the caller.
 *
 * THIS IS THE SET A LANE SELECTS UNLESS IT CAN OPEN A CONTAINER. Four query
 * builders select over `mimeType` and only ONE of them can open an archive; see
 * {@link EXTRACTABLE_DOC_MIME_TYPES} for why that made a single shared array
 * the wrong shape.
 */
export const DIRECT_DOC_MIME_TYPES: readonly string[] = [
  CANONICAL_PDF_MIME_TYPE,
];

/**
 * Media types that are CONTAINERS: the document is INSIDE, not at `gcsPath`.
 *
 * ## Why this is a SEPARATE array and not one more entry in the old one
 *
 * MONEY-1319 taught `stock-document-extract` to open a ZIP
 * (`@usemoney/core/market-data/doc-zip`) and added `application/zip` to the one
 * shared `EXTRACTABLE_DOC_MIME_TYPES` array. That array had FOUR readers, not
 * one, and only the extract lane was taught:
 *
 *   workers/src/processors/stock-document-extract-logic.ts   opens archives
 *   workers/src/processors/stock-document-parse-logic.ts     does NOT
 *   workers/src/processors/doc-ingest-selectors-logic.ts x2  does NOT
 *
 * `PARSEABLE_DOC_TYPES` includes `annual_report`, which is exactly the 172-row
 * ZIP class, so the moment a row carried `application/zip` the parse lane would
 * download it and hand raw archive bytes to the Gemini Files API or a Vertex
 * `gs://` URI, and the convert lane would hand them to pdf-inspector. That is
 * MONEY-1319's OWN measured defect — metered calls spent on ZIP bytes — rebuilt
 * against three more lanes by the change that fixed it. Prod already holds 13
 * honestly-typed `application/zip` rows, so the three untaught lanes would have
 * selected them on merge, with no flag in front.
 *
 * A single constant that four readers interpret differently is the defect. So
 * the CAPABILITY is now in the type: a lane selects {@link
 * DIRECT_DOC_MIME_TYPES} unless it can unwrap, and only a lane that can unwrap
 * names {@link EXTRACTABLE_DOC_MIME_TYPES}.
 *
 * ## The three untaught lanes were NOT taught, deliberately
 *
 *   - `stock-document-parse` offers TWO transports and the Vertex one reads the
 *     `gs://` object directly. An archive-aware parse lane could unwrap the
 *     downloaded bytes but could not hand Vertex a member, so it would silently
 *     lose its fallback transport for exactly the rows it just gained.
 *   - `doc-ingest`'s convert lane writes a `${gcsPath}.md` sidecar keyed on the
 *     OBJECT. A member's markdown under the archive's key is a sidecar that
 *     describes something the key does not name.
 *
 * Both are reachable later — the extract lane already produces text from these
 * archives, which is what the 172 annual reports actually needed. Neither is
 * reachable by accident, which is the point.
 *
 * Adding a member here is only honest when a lane can open it: see
 * `money1319-container-lane-invariant.test.ts`, which refuses a container type
 * nothing is shown to unwrap.
 */
export const CONTAINER_DOC_MIME_TYPES: readonly string[] = [ZIP_MIME_TYPE];

/**
 * Every media type the pipeline can EVENTUALLY turn into text — direct plus
 * container.
 *
 * ONLY an archive-aware consumer may select over this. Today that is exactly
 * `buildExtractQuery`. Everything else — every other query builder, and the
 * realtime ingest publish gate — selects {@link DIRECT_DOC_MIME_TYPES}.
 *
 * It is also the right set for the STATUS questions below, and that asymmetry
 * is deliberate rather than sloppy: `initialProcessingStatus` asks "will
 * anything in this repo ever read these bytes", and for an archive the answer
 * is yes, so a ZIP is `PENDING` and not terminal `UNSUPPORTED`. `is this
 * selectable by lane L` and `is this readable at all` are different questions
 * and now have different constants.
 *
 * If the ZIP lane is ever removed, emptying {@link CONTAINER_DOC_MIME_TYPES} is
 * the whole rollback.
 */
export const EXTRACTABLE_DOC_MIME_TYPES: readonly string[] = [
  ...DIRECT_DOC_MIME_TYPES,
  ...CONTAINER_DOC_MIME_TYPES,
];

/**
 * Reduce a raw `content-type` header to the value stored in `mimeType`.
 *
 * Drops parameters (`;charset=…`), lower-cases, trims, and collapses every PDF
 * spelling (`application/pdf;charset=UTF-8`, `application/x-pdf`) onto
 * `application/pdf`. An empty or absent header yields the schema default,
 * which is what the call sites' own `|| "application/pdf"` already did.
 *
 * Parameters are DROPPED rather than preserved, because there is nowhere to
 * preserve them: `StockDocument` has no raw-header column, and adding one to
 * carry a charset that nothing reads would be a schema change for a value with
 * no reader. The bytes keep the header they were served under — the GCS upload
 * still passes the RAW string as the object's content type.
 */
export function normalizeDocMimeType(
  contentType: string | null | undefined,
): string {
  const essence = String(contentType ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (essence.length === 0) return CANONICAL_PDF_MIME_TYPE;
  // Substring, deliberately — the same test `inferExtension` uses to name the
  // GCS object, so the file name and the row's eligibility are ONE decision.
  if (essence.includes("pdf")) return CANONICAL_PDF_MIME_TYPE;
  return essence;
}

/**
 * True when SOME lane in this repo can produce text from this (raw or stored)
 * type — including one that must open a container first.
 *
 * This is the READABILITY question, not the "may lane L select it" question.
 * Use {@link isContainerDocMimeType} to tell the two apart, and select over
 * {@link DIRECT_DOC_MIME_TYPES} in any lane that cannot unwrap.
 */
export function isExtractableDocMimeType(
  contentType: string | null | undefined,
): boolean {
  return EXTRACTABLE_DOC_MIME_TYPES.includes(normalizeDocMimeType(contentType));
}

/**
 * True when this type is a CONTAINER — the document is inside, and a consumer
 * that hands these bytes straight to a reader is paying for an archive no model
 * can read.
 */
export function isContainerDocMimeType(
  contentType: string | null | undefined,
): boolean {
  return CONTAINER_DOC_MIME_TYPES.includes(normalizeDocMimeType(contentType));
}

/**
 * True when a reader can consume these bytes AS THEY ARE — no unwrapping.
 *
 * The predicate a consumer that cannot open a container should ask. It
 * normalises first, so `application/pdf;charset=UTF-8` answers true — which is
 * the whole MONEY-1255 fix, and the reason a hand-rolled
 * `mime.includes("pdf")` was a reasonable thing to write and is still worth
 * replacing: a substring test is a rule restated, and it cannot know that
 * `application/zip` is a container.
 */
export function isDirectDocMimeType(
  contentType: string | null | undefined,
): boolean {
  return DIRECT_DOC_MIME_TYPES.includes(normalizeDocMimeType(contentType));
}

/**
 * The `processingStatus` a freshly-stored document should be created with.
 *
 * `PENDING` means "queued for extraction". A `text/html` error page or an MP3
 * is not queued for anything — no extractor in this repo will ever read one —
 * so storing it PENDING makes the backlog permanently overstate itself and
 * hides how deep the real queue is. `UNSUPPORTED` is terminal and says so.
 *
 * MONEY-1319 moved `application/zip` from the first group to the second: this
 * sentence listed it beside HTML and MP3 for exactly as long as that was true,
 * and it stopped being true when the extract lane learned to open an archive.
 * The claim is not restated here — it is read off
 * {@link EXTRACTABLE_DOC_MIME_TYPES}, so there is one list and it cannot drift
 * from the prose.
 *
 * That is the ARCHIVE-INCLUSIVE set on purpose, and it is NOT the set a lane
 * selects with. The question here is "will anything in this repo ever read
 * these bytes" — for a container the answer is yes, so a ZIP is `PENDING`
 * rather than terminally condemned. Which lane may SELECT it is a different
 * question, answered by {@link DIRECT_DOC_MIME_TYPES} /
 * {@link CONTAINER_DOC_MIME_TYPES}.
 *
 * Applied at the WRITE, and not only in the one-off repair, because the writers
 * that produced the 1,210 non-PDF rows still run every week: a repair without
 * this is a repair that has to be re-run.
 *
 * The return type is narrowed to the two literals rather than to
 * `DocProcessingStatus` so this file stays a zero-import leaf.
 * `docs-section-logic.ts` carries the full union and
 * `docs-section-logic.test.ts` pins that both of these round-trip through
 * `normalizeProcessingStatus` — which is the invariant that actually matters
 * and a type alias could not have enforced.
 */
export function initialProcessingStatus(
  contentType: string | null | undefined,
): "PENDING" | "UNSUPPORTED" {
  return isExtractableDocMimeType(contentType) ? "PENDING" : "UNSUPPORTED";
}

/** What the one-off queue repair decides to do with one existing row. */
export type DocQueueRepairAction = "normalize" | "unsupported" | "unchanged";

export interface DocQueueRepairPlan {
  action: DocQueueRepairAction;
  /** The mimeType the row should carry. */
  mimeType: string;
  /** The processingStatus the row should carry. */
  processingStatus: "PENDING" | "UNSUPPORTED";
}

/**
 * The whole decision of `scripts/data/repair-stock-document-queue.ts`, over one
 * row's STORED `mimeType` (MONEY-1255).
 *
 * It lives here rather than in the script for the reason
 * `instrument-name-repair.ts` does: a pure decision inside a `scripts/` file is
 * a decision no test can reach without executing the script, and the script's
 * `main()` wants a DATABASE_URL. It also has to call the same two helpers the
 * two WRITERS call, or the repair and the writers can disagree about what a PDF
 * is — which is the defect, one layer up.
 *
 * Three outcomes, and the split between the first two is the point:
 *
 *   normalize    a real PDF stored under a parameterised spelling. It becomes
 *                selectable and STAYS `PENDING` — there is text in it and we
 *                want it. (1 row on prod 2026-08-26.)
 *   unsupported  an HTML page or an MP3. No extractor in this repo will ever
 *                read one, so `PENDING` was a claim about a future that could
 *                not arrive; it also made the backlog overstate itself by 1,210
 *                and hid how deep the real PDF queue was. A ZIP was in this
 *                group until MONEY-1319 and is NOT any more — the extract lane
 *                opens one, so this returns `unchanged` for it and the row
 *                stays queued. The list is read off
 *                {@link EXTRACTABLE_DOC_MIME_TYPES} rather than restated, which
 *                is why that move needed no edit here.
 *   unchanged    already canonical.
 *
 * IDEMPOTENT: feeding any plan's own `mimeType` back in yields `unchanged`, so
 * an interrupted run can be re-run and a completed one reports nothing to do.
 */
export function planDocQueueRepair(
  storedMimeType: string | null | undefined,
): DocQueueRepairPlan {
  const mimeType = normalizeDocMimeType(storedMimeType);
  if (!isExtractableDocMimeType(storedMimeType)) {
    return { action: "unsupported", mimeType, processingStatus: "UNSUPPORTED" };
  }
  return {
    action: mimeType === storedMimeType ? "unchanged" : "normalize",
    mimeType,
    processingStatus: "PENDING",
  };
}
