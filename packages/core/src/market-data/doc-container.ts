/**
 * What container do these document bytes actually hold? — MONEY-1319.
 *
 * ## The defect this file exists to close
 *
 * `doc-mime.ts` closed the case where the stored `mimeType` was an HONEST
 * header we could not match (`application/pdf;charset=UTF-8`). This is the
 * other half: the case where the stored `mimeType` is a header WE WROTE, and
 * it is false.
 *
 * Measured on prod 2026-09-02, over all 74,373 `.pdf` keys under `stocks/`:
 *
 *     %PDF at offset 0        74,164
 *     ZIP (PK)                   179   <- annual_report 172, announcement 7
 *     multipart envelope          27
 *     HTML ("Access Denied")       3
 *
 * Every one of the 179 came from ONE upstream — `nsearchives.nseindia.com`,
 * 100% — and every one is a REAL document: `ACCELYA-annual_report-FY2023.pdf`
 * is a ZIP holding `AR_23907_ACCELYA_2022_2023_22092023182015.pdf`
 * (1,752,887 bytes), and `AERON-announcement-2026.pdf` is a ZIP holding
 * `RESIGNATION_LETTER_CCP_1.pdf` plus NSE's XML sidecar. NSE serves these
 * bundled; the writer names the object `.pdf` and stamps
 * `mimeType: "application/pdf"` regardless.
 *
 * The consequence is not that they are unreachable — it is the opposite, and
 * that is what makes it expensive. 172 of them carry the hardcoded
 * `application/pdf`, so they PASS `buildExtractQuery`'s filter, get selected
 * every cycle, and fail: 126 of the 179 are already `FAILED`, 46 `PENDING`.
 * The extract lane has been spending Document AI round trips on ZIP bytes.
 *
 * ## Why a BYTE test rather than another header rule
 *
 * `document-body-guard.ts` states the principle for the HTML case: "A
 * header-based rule cannot see a lie it wrote itself." The same three writers
 * that hardcode `application/pdf` (`storeNSEFiling`, `annual-reports-sync`,
 * `nse-announcements-sync`) are the ones that produced this population, so no
 * refinement of the header rule can reach it. The bytes are the only witness.
 *
 * ## The boundary with `classifyArchivedObject`
 *
 * This is NOT a second copy of that predicate, and must not become one.
 * `@usemoney/storage`'s classifier answers **"is this archived object
 * corrupt?"** and folds everything that is not a recognised payload into one
 * `invalid` verdict. This module answers a different, finer question for a
 * different consumer — **"which container is this document in, so the pipeline
 * can route it?"** — and deliberately makes no corruption claim. A ZIP is not
 * corrupt; it is a container we have not yet taught the extractor to open.
 *
 * Where the two overlap (HTML), this defers: {@link sniffDocumentContainer}
 * reports `html` for routing, and the decision to QUARANTINE an HTML body
 * stays with `mayStoreDocumentBody`, which owns it.
 *
 * ## Two traps, both measured, both encoded below
 *
 *   1. `%PDF` IS NOT ALWAYS AT OFFSET 0. `ANIKINDS-annual_report-FY2011.pdf`
 *      begins with a newline and carries `%PDF-1.6` at offset 1. A strict
 *      offset-0 magic test calls a perfectly readable annual report invalid,
 *      and a "not a document" verdict clears the row with no path back. The
 *      PDF specification itself only requires the header near the start, and
 *      every reader scans a leading window; so do we.
 *   2. AN ALL-ZERO OBJECT IS NOT AN UNKNOWN FORMAT. Six annual reports
 *      (ADVANIHOTR, AMRUTANJAN, INDOTHAI, SKYGOLD, SURYALAXMI, TECHM) are
 *      11–20 MB of NUL: no `%PDF` in the first megabyte, no `%%EOF` in the
 *      last 2 KB, 98% NUL at the tail. They are allocated-but-never-written,
 *      and they are the one class here that CANNOT be recovered from the bytes
 *      we hold — they have to be re-fetched. Folding them into `unknown` would
 *      hide a re-fetch behind a shrug.
 *
 * ## What MONEY-1319 added on top of the detection
 *
 * The detection above shipped without either half of the fix. Both are here now:
 *
 *   - {@link resolveStoredMimeType} is what the WRITERS call, so a ZIP is no
 *     longer recorded as a PDF at the source. The header lies in BOTH
 *     directions on 13 measured prod rows, which is why only the BYTES may
 *     decide — and why a byte pattern the sniffer DECLINES to identify falls
 *     back to the header rather than to `application/octet-stream`. How far
 *     that fallback may go is {@link UndecidableBytesPolicy}: by default an
 *     uncorroborated header may refine the type but may NOT park the row in a
 *     terminal status the writer would not previously have reached.
 *   - {@link planContainerRepair} now also re-queues. A re-type that leaves a
 *     `FAILED` row `FAILED` has stopped the waste and not recovered the
 *     document; 126 of the 179 are already there.
 *
 * The lane that OPENS an archive is `doc-zip.ts`, beside this file.
 *
 * PURE LEAF: the only import is `doc-mime`, itself a zero-import leaf. No I/O,
 * no clock. Import by SUBPATH (`@usemoney/core/market-data/doc-container`),
 * never through the market-data barrel.
 */

import {
  CANONICAL_PDF_MIME_TYPE,
  isExtractableDocMimeType,
  normalizeDocMimeType,
} from "./doc-mime";

/**
 * How far in we look for `%PDF`.
 *
 * 1,024 bytes is the window PDF readers conventionally scan, and it is the
 * same `ARCHIVE_AUDIT_HEAD_BYTES` the archive audit reads — so a caller that
 * already has an audit head has enough bytes for this without a second GET.
 */
export const PDF_HEADER_SCAN_BYTES = 1024;

/** The container a document's bytes are actually in. */
export type DocumentContainer =
  /** A PDF — `%PDF` within {@link PDF_HEADER_SCAN_BYTES}. */
  | "pdf"
  /** A ZIP archive. The real document is INSIDE; nothing here is lost. */
  | "zip"
  /** MPEG audio (an ID3 tag or a frame sync). A concall recording. */
  | "audio"
  /** An HTML page. The quarantine decision stays with the body guard. */
  | "html"
  /** Allocated but never written — every byte we looked at is NUL. */
  | "zeroed"
  /** Nothing recognised. Deliberately distinct from `zeroed`. */
  | "unknown"
  /** No bytes at all. */
  | "empty";

const ZIP_MAGICS: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04], // local file header
  [0x50, 0x4b, 0x05, 0x06], // end of central directory (empty archive)
  [0x50, 0x4b, 0x07, 0x08], // spanned archive
];

function startsWith(head: Buffer, magic: readonly number[]): boolean {
  if (head.length < magic.length) return false;
  return magic.every((b, i) => head[i] === b);
}

/** Drop a leading UTF-8 / UTF-16 byte-order mark, if present. */
function stripLeadingBom(head: Buffer): Buffer {
  if (startsWith(head, [0xef, 0xbb, 0xbf])) return head.subarray(3);
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff]))
    return head.subarray(2);
  return head;
}

/**
 * Classify the container from a document's leading bytes.
 *
 * ## ORDERING IS LOAD-BEARING, and this is the case that proves it
 *
 * The offset-0 magics (ZIP, ID3) are tested BEFORE the PDF window scan, and
 * that order was not chosen on principle — it was forced by a wrong answer on
 * real data.
 *
 * `stocks/AERON/announcement/AERON-announcement-2026.pdf` is a ZIP holding
 * `RESIGNATION_LETTER_CCP_1.pdf`. Its first entry is STORED rather than
 * deflated, so the contained PDF's own `%PDF-1.x` header sits verbatim about
 * 40 bytes into the object — inside the scan window. With the PDF scan first,
 * that ZIP is reported as a PDF, and the repair script proposed re-typing an
 * honestly-labelled `application/zip` row to `application/pdf`: a correct
 * value being overwritten with a wrong one, in the direction no reader could
 * detect.
 *
 * A magic at offset 0 is an unambiguous statement about the whole object; a
 * token found somewhere in a window is not. So the unambiguous tests go first
 * and the window scan only decides bytes they declined.
 *
 * The MPEG frame-sync test (`0xFF` then a byte whose top three bits are set)
 * is the loosest rule here and stays last for the same reason.
 *
 * Also load-bearing, and pinned: `zeroed` is decided before `unknown`, because
 * "never written" is actionable and "unrecognised" is not.
 *
 * ## The cost of scanning a window for the PDF header
 *
 * Widening the PDF test from offset 0 to a 1 KB scan is what makes ANIKINDS
 * readable, and it buys a false-positive risk in exchange: four ASCII bytes
 * can appear by chance inside any binary — or, as above, entirely on purpose
 * inside a container. So the scan requires the FULL header token `%PDF-` plus
 * a version digit, which the PDF specification mandates (`%PDF-1.x` /
 * `%PDF-2.x`), rather than the bare four characters — and it runs only after
 * the container magics.
 *
 * `head` may be short — a genuinely small object — which is not a fault. It may
 * also be the whole body.
 */
export function sniffDocumentContainer(head: Buffer): DocumentContainer {
  if (head.length === 0) return "empty";

  const window = head.subarray(0, PDF_HEADER_SCAN_BYTES);

  // Offset-0 magics FIRST — see "ORDERING IS LOAD-BEARING" above. A stored ZIP
  // entry carries its contained file's header inside our scan window.
  for (const magic of ZIP_MAGICS) if (startsWith(head, magic)) return "zip";

  // ID3v2-tagged MP3.
  if (startsWith(head, [0x49, 0x44, 0x33])) return "audio";

  // A PDF header need not sit at offset 0 (measured: ANIKINDS at offset 1).
  if (/%PDF-\d/.test(window.toString("latin1"))) return "pdf";

  // Decoded as latin1 (lossy, which is fine for a magic test), a UTF-8 BOM
  // renders as the three chars `ï»¿` rather than as U+FEFF — so a regex written
  // with a literal BOM strips nothing and the page falls through to `unknown`.
  // Skip the BOM at the BYTE level, before any decoding, then trim whitespace.
  const text = stripLeadingBom(window).toString("latin1").trimStart();
  if (/^<(!doctype\s+html|html|head|body|script|meta|title)\b/i.test(text))
    return "html";

  // Every byte we can see is NUL. Checked LAST among the positive tests but
  // BEFORE `unknown`, because "never written" is an actionable finding and
  // "unrecognised" is not.
  if (window.every((b) => b === 0)) return "zeroed";

  // Bare MPEG audio frame sync. Loosest rule — deliberately last.
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0)
    return "audio";

  return "unknown";
}

/** Media type for a container, for callers that must store one. */
export function mimeTypeForContainer(container: DocumentContainer): string {
  switch (container) {
    case "pdf":
      return CANONICAL_PDF_MIME_TYPE;
    case "zip":
      return "application/zip";
    case "audio":
      return "audio/mpeg";
    case "html":
      return "text/html";
    default:
      return "application/octet-stream";
  }
}

/**
 * Whose claim decides when {@link sniffDocumentContainer} DECLINES the bytes
 * (`unknown` / `zeroed` / `empty`) — MONEY-1319 review, finding M8.
 *
 * On a POSITIVE identification this is not consulted at all: the bytes win, in
 * both directions, which is the whole point of the function.
 */
export type UndecidableBytesPolicy =
  /**
   * The upstream's `content-type` decides, whatever it says.
   *
   * A non-extractable header therefore parks the row in the TERMINAL
   * `UNSUPPORTED` status via `initialProcessingStatus`. That is correct — and
   * pre-existing — for `storeScreenerDoc`, the leg MONEY-1255 built the rule
   * for: Screener answers an honest `text/html` for a SEBI landing page and an
   * honest `audio/mpeg` for a concall recording, and `PENDING` about either was
   * a claim about a future that could not arrive. 1,210 rows.
   *
   * OPT IN. A writer choosing this is choosing to let a header condemn a
   * document, which is only defensible where the header has earned it.
   */
  | "trust-header"
  /**
   * The header may REFINE but never CONDEMN — the default, and the safe one.
   *
   * When the sniffer declines and the header names something OUTSIDE
   * `EXTRACTABLE_DOC_MIME_TYPES`, the canonical PDF type is stored and the row
   * stays queued. That is EXACTLY what the three NSE legs
   * (`storeNSEFiling`, `storeAnnualReport`, `fetchAndStoreNSEFilings`) wrote
   * before MONEY-1319, when they hardcoded `application/pdf` and `PENDING`.
   *
   * ## The behaviour change this bounds
   *
   * `resolveStoredMimeType` claimed to be "a no-op on today's behaviour" for
   * bytes nobody can identify. That was true only with NO header — and three of
   * the four converted writers pass a real one. Under a plain header fallback,
   * `nsearchives` answering `application/octet-stream` (or anything else
   * non-PDF) over a body the 1 KB sniff cannot classify moved a row those legs
   * would have queued into a status NOTHING re-selects: `UNSUPPORTED` is
   * terminal by design, `planContainerRepair` returns `none` for `unknown`
   * bytes, and `force: true` only re-opens `FAILED`. Prod holds 4,367
   * `text/plain`, 1,666 `text/html` and 1,622 `application/json` rows, so
   * non-PDF headers demonstrably occur on this table.
   *
   * The cost of the other direction is ONE metered attempt that then fails
   * recoverably, against a document lost with no path back. A terminal verdict
   * should rest on a POSITIVE identification, which is the same asymmetry this
   * module already argues for one level up.
   */
  | "stay-queued";

/**
 * The `mimeType` a WRITER should store for a freshly-downloaded body.
 *
 * ## The defect this closes — the other half of MONEY-1319
 *
 * `doc-container.ts` above explains that four writers stamp a literal
 * `application/pdf` on every object they store, so 179 NSE ZIPs are recorded as
 * PDFs. Re-typing the existing rows is a one-off; those writers still run
 * weekly, so without this the repair has to be re-run forever.
 *
 * ## THE HEADER LIES IN BOTH DIRECTIONS — that is why bytes decide
 *
 * The MONEY-1315 scan measured 13 prod rows where the stored media type and the
 * bytes disagree, and they disagree BOTH WAYS: 3 rows say `application/pdf` and
 * hold an HTML page, 10 say `text/html` and hold something that is not HTML.
 * A rule that trusted the header would get every one of them wrong, and in
 * opposite directions — one class silently unreadable, the other silently
 * condemned. So a POSITIVE identification from the bytes always wins.
 *
 * ## …but only a POSITIVE one, and this asymmetry is deliberate
 *
 * `unknown`, `zeroed` and `empty` are NOT identifications; they are the sniffer
 * declining. Letting them override the header would turn a document whose
 * header is honest and whose leading kilobyte we simply could not classify into
 * `application/octet-stream` — which `EXTRACTABLE_DOC_MIME_TYPES` does not
 * contain, so the row would silently leave the extraction queue with nothing
 * said about it. Narrowing a loose rule without a catch-all is how coverage
 * shrinks; the catch-all here is `undecidable`.
 *
 * ## …and the catch-all is a CHOICE, because the header is not free either
 *
 * This docblock used to say "for bytes nobody can identify this function is a
 * no-op on today's behaviour". That holds only with NO header, and THREE of the
 * four converted writers pass a real one — so the sentence was false exactly
 * where it mattered. See {@link UndecidableBytesPolicy}: the default
 * `"stay-queued"` makes it true again for those three (an uncorroborated header
 * may refine the type but may not condemn the row to a terminal status), and
 * `storeScreenerDoc` opts in to `"trust-header"`, which is what it already did
 * before MONEY-1319 and what MONEY-1255 built the rule for.
 *
 * With no header at all BOTH policies return `normalizeDocMimeType("")` =
 * `application/pdf`, which is EXACTLY the literal the four writers used, so a
 * caller that passes no header cannot be affected by the choice.
 *
 * The value is always one `normalizeDocMimeType` could have produced, so it is
 * a value `buildExtractQuery`'s `mimeType: { in: EXTRACTABLE_DOC_MIME_TYPES }`
 * can actually match — the MONEY-1255 lesson (an exact match against a column
 * written from a raw header missed every `application/pdf;charset=UTF-8` row).
 */
export function resolveStoredMimeType(args: {
  /** The bytes about to be stored. The head is enough; the whole body is fine. */
  body: Buffer;
  /** The upstream's `content-type`, when there is one. Raw, unnormalised. */
  contentType?: string | null;
  /**
   * What decides when the sniffer DECLINES. Default `"stay-queued"`.
   *
   * The default is the conservative one on purpose: a new writer that forgets
   * this argument cannot silently condemn a document on a header alone.
   */
  undecidable?: UndecidableBytesPolicy;
}): string {
  const container = sniffDocumentContainer(args.body);
  switch (container) {
    case "pdf":
    case "zip":
    case "audio":
    case "html":
      return mimeTypeForContainer(container);
    default: {
      // `unknown` / `zeroed` / `empty` — the sniffer declined, so it does not
      // get a vote. See the asymmetry note above.
      const fromHeader = normalizeDocMimeType(args.contentType);
      if ((args.undecidable ?? "stay-queued") === "trust-header") {
        return fromHeader;
      }
      // REFINE, NEVER CONDEMN. An extractable header is kept (it agrees with
      // what the writer would have stored anyway, and `application/zip` from an
      // upstream that says so is a real refinement); anything else would move
      // the row to a terminal status on the strength of a claim the bytes did
      // not corroborate, so the canonical default stands and the row gets its
      // fair attempt.
      return isExtractableDocMimeType(fromHeader)
        ? fromHeader
        : CANONICAL_PDF_MIME_TYPE;
    }
  }
}

/** What a repair pass should do with one row. */
export type ContainerRepairAction =
  /** The stored type already matches the bytes. */
  | "none"
  /** The bytes are a real document in a container the column misnames. */
  | "retype"
  /**
   * The column is RIGHT and the row is parked in a terminal status the lane can
   * now leave behind — MONEY-1319.
   *
   * 13 prod rows are honestly typed `application/zip` and sit `UNSUPPORTED`,
   * because that WAS the correct verdict: `initialProcessingStatus` mapped a
   * ZIP to a terminal status precisely while no extractor could open one. The
   * container repair's dry run reported them as "0 changes — those are already
   * honestly `application/zip`; their fix is unzip support, not a re-type",
   * which was true and incomplete: unzip support alone does not move a row out
   * of a terminal status, and no query selects it, so the capability arrives
   * and the rows stay where they are forever.
   */
  | "requeue"
  /** The bytes are not a document and cannot be recovered — fetch again. */
  | "refetch";

export interface ContainerRepairPlan {
  action: ContainerRepairAction;
  /** The `mimeType` the row should carry. Unchanged when `action` is not `retype`. */
  mimeType: string;
  /**
   * The `processingStatus` the row should be moved to, or `null` to leave it.
   *
   * A RE-TYPE ALONE LOSES THE DOCUMENT, and that is the whole reason this field
   * exists. 126 of the 179 ZIP rows are already `FAILED` — the extract lane took
   * them, could not read them, and gave up — and `FAILED` is only re-selected
   * under `force: true`. Correcting `mimeType` to `application/zip` while
   * leaving the row `FAILED` takes it out of the wasteful loop and out of the
   * useful one at the same time: it stops burning Document AI calls and it
   * never produces text either.
   *
   * So a re-type onto an EXTRACTABLE type re-queues the row, and a re-type onto
   * one the lane cannot read does not. `READY` and `PROCESSING` are never
   * touched: `READY` already has its text (re-queueing it would discard work
   * and re-spend a Document AI call), and `PROCESSING` belongs to a run that is
   * still in flight.
   */
  processingStatus: "PENDING" | null;
  /** Why, for the dry-run census and the log line. */
  reason: string;
}

/**
 * Statuses a re-type must not disturb.
 *
 * `READY` has text. `PROCESSING` is a row another run has already claimed —
 * moving it back to `PENDING` invites a second worker onto the same document.
 * `PENDING` is already queued, so moving it there is a write that changes
 * nothing and inflates the run's report.
 */
const REQUEUE_FORBIDDEN_STATUSES: ReadonlySet<string> = new Set([
  "READY",
  "PROCESSING",
  "PENDING",
]);

/**
 * Containers the extract lane learned to read IN THIS CHANGE.
 *
 * ## Why a correctly-typed row is re-queued ONLY for these
 *
 * A dry run against prod caught the first version of this rule proposing
 * **5,356** re-queues over `--doc-type annual_report` alone: every correctly
 * typed `application/pdf` row sitting `FAILED`. Those rows failed on their own
 * merits — a scanned image, an encrypted PDF, a truncated download — and
 * NOTHING about them changed, so re-queueing them feeds the lane 5,356
 * guaranteed failures per cycle. That is the defect `initialProcessingStatus`
 * already names from the other side: `UNSUPPORTED` is deliberately not
 * `FAILED` because `force: true` re-runs FAILED and would put a pile of
 * certain no-ops into every forced pass.
 *
 * A re-queue is only honest when the row's READABILITY changed. It changed for
 * exactly one container: an archive, which nothing could open before
 * `doc-zip.ts`. Removing that capability means removing this entry — which is
 * also the whole rollback.
 *
 * A RE-TYPE is a different argument and does not consult this set: there the
 * COLUMN was wrong, so the row was never selected under the type it actually
 * is, and it has never had a fair attempt.
 */
const NEWLY_READABLE_CONTAINERS: ReadonlySet<DocumentContainer> = new Set([
  "zip",
]);

/**
 * Decide what to do with ONE row whose bytes have been sniffed.
 *
 * The rule this encodes, and the reason it is a `retype` rather than a
 * quarantine: **a container is not a verdict about content.** 179 of these are
 * NSE annual reports and announcements that exist, in full, inside a ZIP. The
 * expensive mistake available here is to treat "the extractor cannot read it"
 * as "it is not a document" — that clears the row, and the enrichment pipeline
 * never revisits a cleared row, so 172 real annual reports would be gone with
 * no path back.
 *
 * `refetch` is reserved for the ONE class where the bytes carry nothing at all
 * (`zeroed`) — there is no document to preserve, so re-fetching is the only
 * move and saying so is strictly better than a shrug.
 *
 * `html` deliberately returns `none` here: that decision belongs to
 * `mayStoreDocumentBody` / the MONEY-1315 quarantine, and two modules issuing
 * verdicts on the same bytes is the drift this repo keeps paying for.
 */
export function planContainerRepair(args: {
  storedMimeType: string | null | undefined;
  container: DocumentContainer;
  /**
   * The row's current `processingStatus`, when the caller has it.
   *
   * OPTIONAL, and absent means "do not re-queue". A repair that does not know
   * where a row currently is must not move it — the one status it could
   * silently destroy by guessing is `READY`.
   */
  storedProcessingStatus?: string | null;
}): ContainerRepairPlan {
  const stored = normalizeDocMimeType(args.storedMimeType);
  const actual = mimeTypeForContainer(args.container);

  if (args.container === "zeroed") {
    return {
      action: "refetch",
      mimeType: stored,
      processingStatus: null,
      reason: "object is all NUL — allocated but never written",
    };
  }

  if (args.container === "html" || args.container === "unknown") {
    return {
      action: "none",
      mimeType: stored,
      processingStatus: null,
      reason: `${args.container} — not this pass's decision`,
    };
  }

  if (args.container === "empty") {
    return {
      action: "refetch",
      mimeType: stored,
      processingStatus: null,
      reason: "zero-length object",
    };
  }

  if (stored === actual) {
    // The column is right, so the only thing that could have changed is what
    // the LANE can do — and it changed for archives only. See
    // NEWLY_READABLE_CONTAINERS for the 5,356-row dry run that proved a
    // broader rule wrong.
    return NEWLY_READABLE_CONTAINERS.has(args.container) &&
      requeueIfStranded(args.storedProcessingStatus, actual)
      ? {
          action: "requeue",
          mimeType: stored,
          processingStatus: "PENDING",
          reason: `column is correct (${stored}) but the row is ${String(
            args.storedProcessingStatus,
          )} and the lane can read this container now`,
        }
      : {
          action: "none",
          mimeType: stored,
          processingStatus: null,
          reason: "stored type matches the bytes",
        };
  }

  // A re-type that leaves a FAILED row FAILED has only stopped the waste; it
  // has not recovered the document. See `ContainerRepairPlan.processingStatus`.
  return {
    action: "retype",
    mimeType: actual,
    processingStatus: requeueIfStranded(args.storedProcessingStatus, actual)
      ? "PENDING"
      : null,
    reason: `bytes are ${args.container}, column says ${stored}`,
  };
}

/**
 * Is this row parked in a status the lane can now leave behind?
 *
 * TRUE only when all three hold: the corrected media type is one the extract
 * lane can read, the caller actually KNOWS the row's current status, and that
 * status is neither `READY` (it already has its text — re-queueing discards
 * work and re-spends a Document AI call) nor `PROCESSING` (another run has
 * claimed it).
 *
 * An ABSENT status is deliberately false rather than "probably fine". The one
 * value a guess could silently destroy is `READY`.
 */
function requeueIfStranded(
  storedProcessingStatus: string | null | undefined,
  correctedMimeType: string,
): boolean {
  const current = String(storedProcessingStatus ?? "");
  return (
    isExtractableDocMimeType(correctedMimeType) &&
    current.length > 0 &&
    !REQUEUE_FORBIDDEN_STATUSES.has(current)
  );
}
