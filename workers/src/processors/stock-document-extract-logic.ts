/**
 * Stock-document-extract processor — PURE helpers (no Prisma / GCS / Document AI).
 *
 * Side-effect-free query/path builders extracted out of
 * `stock-document-extract.ts` so they can be unit-tested by importing the REAL
 * symbol (no shadow copies) without booting Prisma, the GCS client, or the
 * Document AI client at module load. `stock-document-extract.ts` imports and
 * CALLS these exports, so the production code path and the tests run the SAME
 * code. Mirrors `stock-document-embed-logic.ts` / `document-process-logic.ts`.
 *
 * @see workers/src/processors/stock-document-extract.ts (caller)
 * @see apps/web/__tests__/workers/processor-stock-document-extract.test.ts
 */

// MAX_TEXT_LENGTH / capTextContent are the single source of truth in
// document-process-logic — re-export them so the extract worker and tests share
// the exact same DB/RAG text cap instead of redefining a drifting copy.
export { MAX_TEXT_LENGTH, capTextContent } from "./document-process-logic";

// ---------------------------------------------------------------------------
// MIME TYPES — MONEY-1255
//
// `mimeType` is stored from the raw `content-type` RESPONSE HEADER, which is a
// media type PLUS PARAMETERS: Screener answers `application/pdf;charset=UTF-8`
// for some documents, and the query below matches EXACTLY, so that row was
// stored, never selected, and sat PENDING forever. Measured on prod
// 2026-08-26: 1 such PDF, plus 1,192 `text/html` in four spellings, 13
// `audio/mpeg` and 5 `application/zip` — 1,211 rows the extractor could never
// take.
//
// The rule lives in `@usemoney/core/market-data/doc-mime` (a zero-import pure
// leaf) rather than here, because there are TWO writers of this column from a
// raw header and they sit in packages that cannot import each other. It is
// RE-EXPORTED so worker call sites and their tests reach the real symbol
// through one path, exactly as MAX_TEXT_LENGTH is re-exported above.
// ---------------------------------------------------------------------------

export {
  CANONICAL_PDF_MIME_TYPE,
  EXTRACTABLE_DOC_MIME_TYPES,
  normalizeDocMimeType,
  isExtractableDocMimeType,
  initialProcessingStatus,
} from "@usemoney/core/market-data/doc-mime";

// The query builder needs the VALUE, so it is imported as well as re-exported.
import { EXTRACTABLE_DOC_MIME_TYPES } from "@usemoney/core/market-data/doc-mime";

// ---------------------------------------------------------------------------
// ARCHIVES — MONEY-1319
//
// 179 objects under `stocks/` are ZIPs from `nsearchives.nseindia.com` stored
// under a `.pdf` key, and every one holds a real document. 172 of them carried
// our own hardcoded `application/pdf`, so they PASSED the query above, were
// selected every cycle and failed — 126 are already `FAILED`. Correcting the
// column stops the waste; it does not recover the document. This does.
// ---------------------------------------------------------------------------

import {
  sniffDocumentContainer,
  resolveStoredMimeType,
} from "@usemoney/core/market-data/doc-container";
import { openDocumentZip } from "@usemoney/core/market-data/doc-zip";
// MONEY-1347 — the sidecar-completeness judgement, reached by its own subpath.
// It OWNS `SCANNED_SHARE_VISION_THRESHOLD`; re-implementing the 0.2 here would
// give the RAG lane and the financials lane two spellings of one rule, which is
// the drift class this repo has paid for repeatedly.
import { sidecarIsPageIncomplete } from "@usemoney/core/market-data/doc-convert-logic";

/** The bytes the extractor should actually read, and how to address them. */
export interface ExtractionSource {
  /** The document's bytes — the object's, or a member recovered from inside it. */
  bytes: Buffer;
  /** The media type to tell the extractor about {@link bytes}. */
  mimeType: string;
  /**
   * May Document AI read the STORED OBJECT directly?
   *
   * True for a normal document, where `gcsPath` names the PDF and the gs:// URI
   * saves us shipping the bytes. FALSE when the bytes were recovered from an
   * archive: the object at `gcsPath` is the ZIP, so pointing the processor at
   * it re-runs the exact failure this branch exists to fix.
   */
  objectIsTheDocument: boolean;
  /** The archive member selected, or `null` when the object was not an archive. */
  memberName: string | null;
  /** For the log line and the census. */
  why: string;
}

/**
 * Decide what the extractor should read, given the object's bytes.
 *
 * `null` means there is nothing extractable here and the caller should fail the
 * row WITHOUT spending a Document AI call — the only case today is an archive
 * whose members are all sidecars (or which the walker cannot open).
 *
 * ## Why the container is re-derived from the BYTES rather than read off the row
 *
 * `storedMimeType` is exactly the column this ticket found lying: 172 ZIPs
 * were recorded as `application/pdf` by four writers that stamped a literal.
 * Branching on it would open an archive only for rows a repair pass had already
 * corrected, which is the wrong way round — the repair is the one-off and the
 * lane is what has to be right for every row that arrives after it. The column
 * is still used, as the fallback media type for bytes the sniffer declines to
 * identify, which is precisely what it is good for.
 *
 * ## A ZIP inside a ZIP is not unwrapped
 *
 * `openDocumentZip` selects a member whose BYTES are a PDF, so a nested archive
 * is simply not eligible and the row fails honestly. Recursing would need a
 * depth bound and a cycle argument for a population of zero.
 */
export function resolveExtractionSource(args: {
  body: Buffer;
  storedMimeType: string | null | undefined;
}): ExtractionSource | null {
  const container = sniffDocumentContainer(args.body);

  if (container === "zip") {
    const member = openDocumentZip(args.body);
    if (!member) return null;
    return {
      bytes: member.bytes,
      mimeType: member.mimeType,
      objectIsTheDocument: false,
      memberName: member.name,
      why:
        `opened ZIP (${member.memberCount} member(s)) and selected ` +
        `${member.name} (${member.bytes.length} bytes)`,
    };
  }

  return {
    bytes: args.body,
    mimeType: resolveStoredMimeType({
      body: args.body,
      contentType: args.storedMimeType,
    }),
    objectIsTheDocument: true,
    memberName: null,
    why: `object is a ${container}`,
  };
}

/**
 * Build the `StockDocument.findMany` WHERE for the extract query.
 *
 * Selects PENDING PDFs (the embed worker needs READY + non-null textContent, so
 * the extractor is the missing link). `force` widens to also re-run FAILED docs.
 * Symbols are upper-cased to match how they're stored; doc-type filter is
 * applied verbatim. Only `application/pdf` rows are eligible — text docs
 * (Tickertape / Screener financials) are stored READY at sync time and never
 * need extraction.
 *
 * MONEY-1255 — the mimeType arm reads `EXTRACTABLE_DOC_MIME_TYPES` rather than
 * a literal. It is an EXACT match against a column written from a raw
 * `content-type` header, which is why `application/pdf;charset=UTF-8` was
 * unreachable; `normalizeDocMimeType` at the write site is the other half of
 * that fix and both now read the same array.
 *
 * ## THIS IS THE ONE QUERY IN THE REPO ALLOWED TO NAME THAT ARRAY
 *
 * `EXTRACTABLE_DOC_MIME_TYPES` is DIRECT + CONTAINER, and a lane may only
 * select a container it can open. This one can: {@link resolveExtractionSource}
 * above sniffs the body and, for an archive, opens it and selects the member
 * before any Document AI call is made. The other three selections over
 * `mimeType` (`buildParseQuery`, `buildConvertQuery`, `buildSweepQuery`) read
 * `DIRECT_DOC_MIME_TYPES`, because none of them unwraps.
 *
 * That split is the MONEY-1319 review finding: the constant was ONE array with
 * four readers and only this reader was taught, so adding `application/zip`
 * pointed three untaught lanes at 13 existing prod rows whose bytes no model can
 * read — the exact waste this ticket measured, recreated by the fix.
 * `money1319-container-lane-invariant.test.ts` asserts the property rather than
 * the four lists: a container in the set that ANY selecting lane cannot open is
 * a failure.
 *
 * ## MONEY-1329 — a claim taken and never released
 *
 * The status arm is an OR, and the second arm is not defensive tidying. The
 * loop marks a row `PROCESSING` before it does any work, so that flip is a
 * CLAIM; every terminal path (READY, FAILED, and the best-effort FAILED in the
 * `catch`) releases it. What does not release it is the run ENDING between the
 * two — a Cloud Run instance recycled mid-document, an OOM kill, a process the
 * wall-clock budget stopped after the flip. Measured on prod: **29 rows** sit
 * `PROCESSING` in this lane, and BEFORE this change no query in the repo
 * selected them. Not this job (PENDING, or PENDING+FAILED under `force`), not
 * the repair script — `repair-doc-containers.ts` records the same finding from
 * the other side, five of its six all-NUL rows unreachable for exactly this
 * reason.
 *
 * That is a permanent leak, not a delay: the population only grows, every row
 * in it is a document nothing will ever read, and it is silent because the
 * counters all look healthy — the row was selected once, it just never came
 * back.
 *
 * The threshold is {@link STALE_PROCESSING_MS}. `updatedAt` is `@updatedAt` on
 * the model, so it is written on the `PROCESSING` flip itself and is present on
 * every row — no `isSet: false` arm is needed here, which is the exception
 * rather than the rule in this file (see `convertStatus` / `parseStatus`, whose
 * attributes are genuinely ABSENT on the pre-existing corpus).
 */
export function buildExtractQuery(opts: {
  symbols?: string[];
  docTypes?: string[];
  force?: boolean;
  /**
   * The run's clock, passed in rather than read here, so the staleness cutoff
   * is deterministic in a test and the module stays pure.
   */
  now: Date;
}): Record<string, unknown> {
  return {
    OR: [
      {
        processingStatus: opts.force
          ? { in: ["PENDING", "FAILED"] }
          : "PENDING",
      },
      // MONEY-1329 — reclaim an abandoned claim. Scoped to PROCESSING and to a
      // cutoff comfortably past any legitimate run, so a document currently
      // being worked on by a live instance can never be selected twice.
      {
        processingStatus: "PROCESSING",
        updatedAt: { lt: new Date(opts.now.getTime() - STALE_PROCESSING_MS) },
      },
    ],
    mimeType: { in: [...EXTRACTABLE_DOC_MIME_TYPES] },
    ...(opts.symbols && opts.symbols.length > 0
      ? { symbol: { in: opts.symbols.map((s) => s.toUpperCase()) } }
      : {}),
    ...(opts.docTypes && opts.docTypes.length > 0
      ? { docType: { in: opts.docTypes } }
      : {}),
  };
}

/**
 * How old a `PROCESSING` row must be before this job may take it back.
 *
 * **6 hours**, and the sizing is against the ONE thing that can legitimately
 * hold a claim open: a single run of this job. Its wall is
 * `RUN_TIME_BUDGET_MS` (420s) plus one in-flight document, inside a 600s
 * Pub/Sub ack deadline it must not exceed — so no honest claim survives ten
 * minutes. Six hours is ~36x that ceiling, and it clears the whole 20-link
 * chain (~2h20m) with room over.
 *
 * Deliberately generous in the direction that costs nothing. Being too LOW
 * means two runs extract the same document concurrently and race on the final
 * `update` — wasted Document AI calls on a row that was already being handled.
 * Being too HIGH only delays reclaiming a row that has already been stuck since
 * before this ticket existed. So the error is taken on the side that is merely
 * slow.
 */
export const STALE_PROCESSING_MS = 6 * 60 * 60 * 1000;

/**
 * Where should this document's RAG text come from?
 *
 * ## MONEY-1347 — 32,893 documents already hold the text this lane is queuing to produce
 *
 * Measured on prod: `stock_documents` holds **34,915** rows PENDING in this
 * lane, while **32,893** documents already carry a converted markdown sidecar
 * at `markdownGcsPath` — written by the MONEY-1314 conversion lane, and read by
 * NOBODY for text. Reading it costs ONE GCS read and ZERO Document AI calls,
 * against a per-document cost of a cross-region Document AI round trip plus a
 * GCS read plus a `pdf-parse` fallback over a multi-MB buffer. It is the same
 * bytes, already paid for.
 *
 * ## An INCOMPLETE sidecar must go to the extractor
 *
 * The one way this is worse than the slow path: a sidecar produced from a
 * partially-scanned PDF is MISSING PAGES, and nothing about the resulting text
 * says so. BONLON FY2025 lost pages 92-135 — exactly the statement block — and
 * the sidecar reads as a clean, complete, shorter document. Half a document
 * silently becoming the whole document is not a degradation the RAG corpus can
 * detect downstream, so incompleteness routes to the extractor, which reads the
 * PDF itself.
 *
 * The threshold is NOT restated here. {@link sidecarIsPageIncomplete} owns
 * `SCANNED_SHARE_VISION_THRESHOLD` (0.2) and is the same judgement the
 * financials lane makes; a second copy of that number is the drift this repo
 * has paid for repeatedly. Note its documented behaviour on UNKNOWN counters:
 * `null` returns `incomplete: false` — an absent measurement is not evidence of
 * incompleteness. That is safe here only because the `textPageCount > 0` test
 * below independently rejects those rows, so a pre-MONEY-1314 document with no
 * counters can never reach the sidecar path on the strength of a shrug.
 */
export type ExtractTextSource = "sidecar" | "extractor";

export function decideTextSource(row: {
  markdownGcsPath: string | null | undefined;
  textPageCount: number | null | undefined;
  scannedPageCount: number | null | undefined;
  convertStatus: string | null | undefined;
}): ExtractTextSource {
  // Only a COMPLETED conversion has a sidecar worth reading. SCANNED_ONLY and
  // FAILED wrote none; PENDING (and the absent attribute on the pre-existing
  // corpus) has not run yet.
  if (row.convertStatus !== "CONVERTED") return "extractor";

  // A conversion that produced zero text pages produced no text. This is also
  // what keeps the `null`-counter shrug in `sidecarIsPageIncomplete` from
  // admitting an unmeasured row.
  if (typeof row.textPageCount !== "number" || row.textPageCount <= 0) {
    return "extractor";
  }

  // The path is what we would DOWNLOAD. An empty string is the same absence as
  // a null and has bitten this codebase before (`gcsPath: ""` on 6,125 rows).
  if (
    typeof row.markdownGcsPath !== "string" ||
    row.markdownGcsPath.trim().length === 0
  ) {
    return "extractor";
  }

  const { incomplete } = sidecarIsPageIncomplete({
    scannedPageCount: row.scannedPageCount ?? null,
    textPageCount: row.textPageCount,
  });
  return incomplete ? "extractor" : "sidecar";
}

/**
 * Build the gs:// URI for a stored document's GCS path.
 *
 * Throws when `GCP_STORAGE_BUCKET` is unset (so the caller fails the doc loudly
 * rather than handing Document AI a "gs:///path" with an empty bucket) and when
 * `gcsPath` is not a safe object key.
 *
 * SSRF / object-confusion hardening: Document AI reads whatever object this URI
 * names. The bucket is ALWAYS pinned to the env var, so a path can never
 * redirect the read to another bucket — but we still reject a path that is
 * empty, that carries its OWN scheme (`gs://…`, `https://…`), that is
 * absolute (`/…`), that contains a `..` traversal segment, or that hides a
 * control char (incl. newline — a CRLF could otherwise smuggle a second token
 * into a logged/serialised request). The legitimate `buildFullDocPath` output
 * (`stocks/<SYM>/<docType>/<file>`) always passes.
 */
export function buildGcsUri(gcsPath: string): string {
  const bucket = process.env.GCP_STORAGE_BUCKET;
  if (!bucket) {
    throw new Error("GCP_STORAGE_BUCKET environment variable is required");
  }
  assertSafeObjectKey(gcsPath);
  return `gs://${bucket}/${gcsPath}`;
}

/**
 * Reject a GCS object key that could redirect, traverse, or smuggle. A valid
 * stock-document key is a non-empty relative path of one or more
 * `[A-Za-z0-9._&\-]`-ish segments separated by `/`, with no scheme, no leading
 * slash, no `..` segment, and no control characters. Throws on a violation.
 */
export function assertSafeObjectKey(gcsPath: string): void {
  if (typeof gcsPath !== "string" || gcsPath.trim().length === 0) {
    throw new Error("GCS path is empty");
  }
  // No control characters (incl. CR/LF/tab/NUL/DEL) — block CRLF smuggling.
  for (let i = 0; i < gcsPath.length; i++) {
    const code = gcsPath.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new Error("GCS path contains control characters");
    }
  }
  // No embedded scheme (gs://, http://, file://, …) — can't repoint the read.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(gcsPath) || gcsPath.includes("://")) {
    throw new Error(`GCS path must be a relative object key: ${gcsPath}`);
  }
  // No absolute path and no parent-directory traversal segments.
  if (gcsPath.startsWith("/")) {
    throw new Error(`GCS path must not be absolute: ${gcsPath}`);
  }
  if (gcsPath.split("/").some((seg) => seg === "..")) {
    throw new Error(`GCS path must not contain '..' segments: ${gcsPath}`);
  }
}

/**
 * Derived GCS sidecar path for the FULL extracted text of an over-cap document.
 *
 * NO SCHEMA CHANGE: `StockDocument.textContent` is capped at MAX_TEXT_LENGTH for
 * the DB/RAG preview, but the embed worker wants the whole document. We persist
 * the full text alongside the source PDF at this derived path and the embed
 * worker probes for it. Deterministic from the source path, so no new column.
 */
export function extractedSidecarPath(gcsPath: string): string {
  return `${gcsPath}.extracted.txt`;
}

/**
 * Decide whether a doc whose GCS object is MISSING should instead be fetched
 * from its `sourceUrl` (MONEY-798 P3c discovery path).
 *
 * `enqueueDocumentForRag` creates PENDING `StockDocument` rows with a
 * deterministic PLACEHOLDER `gcsPath` (no object was ever uploaded) and a real
 * `sourceUrl`. The extract worker normally reads the object at `gcsPath`, so
 * those rows would always fail to download → text:null → FAILED, silently
 * dropping every discovered filing. When the object is absent but a usable
 * `sourceUrl` is present, the worker should fetch the bytes from `sourceUrl`,
 * upload them to `gcsPath`, then extract — so this is NOT a genuine extract
 * failure and must not be marked FAILED.
 *
 * Pure: takes the result of probing GCS (object present?) and the doc's
 * `sourceUrl`, returns the boolean decision so it can be unit-tested without
 * touching GCS. A `sourceUrl` is "usable" only when it's a non-empty http(s)
 * URL — a placeholder/empty/relative value is not fetchable.
 */
export function shouldFetchFromSource(
  gcsObjectPresent: boolean,
  sourceUrl: string | null | undefined,
): boolean {
  if (gcsObjectPresent) return false;
  return isFetchableSourceUrl(sourceUrl);
}

/** True when `sourceUrl` is a non-empty absolute http(s) URL we can fetch. */
export function isFetchableSourceUrl(
  sourceUrl: string | null | undefined,
): boolean {
  if (typeof sourceUrl !== "string") return false;
  const trimmed = sourceUrl.trim();
  if (trimmed.length === 0) return false;
  return /^https?:\/\//i.test(trimmed);
}

// ---------------------------------------------------------------------------
// QUEUE DRAIN — MONEY-1255
//
// The queue was selected NEWEST-FIRST (`fetchedAt: "desc"`) with no cursor, 50
// rows a night, against a population that grows by thousands on every weekly
// sync. Newest-first over a growing queue is not "slow": the oldest rows are
// pushed further down on every cycle and are never reached at all. Measured on
// prod 2026-08-26: 36,001 PENDING, 34,790 of them PDFs. At 50/day that is a
// ~2-year drain even if nothing new ever arrived — and something does.
//
// This is MONEY-1211 restated (681 of 781 symbols selected once and skipped
// nightly thereafter): a batch needs a rotation marker ordered ASC, or it
// never advances.
// ---------------------------------------------------------------------------

/**
 * OLDEST FIRST. `fetchedAt` ascending is the rotation marker.
 *
 * It works as one because the loop makes every row it touches leave the
 * selected set (PENDING → PROCESSING → READY|FAILED), so the next page starts
 * where this one stopped without a cursor to carry. `desc` had the opposite
 * property: new arrivals landed at the head of the queue and displaced work
 * that had never been reached.
 */
export const EXTRACT_ORDER_BY = { fetchedAt: "asc" } as const;

/**
 * Documents pulled per run when the message names no `batchSize`.
 *
 * This is a PAGE SIZE and a runaway guard, NOT the throughput control — the
 * wall clock below is. Raising a COUNT to catch up is the lever MONEY-1201
 * explicitly rejected: per-document cost here is a Document AI round trip plus
 * a GCS read plus a pdf-parse fallback, and only the last of those three is
 * ours, so a count holds only while the other two stay put.
 */
export const DEFAULT_EXTRACT_BATCH_SIZE = 500;

/**
 * Wall-clock budget after which the loop stops taking NEW documents.
 *
 * ## The arithmetic, against the 600s Pub/Sub ack deadline
 *
 * Every worker job arrives on a push subscription with `--ack-deadline=600`,
 * which is Pub/Sub's MAXIMUM and cannot be raised. Cloud Run's 3600s request
 * timeout is never the binding constraint. Overrunning 600s does not make the
 * run slow — Pub/Sub redelivers, so a SECOND copy of the job starts while the
 * first is still running, and both then extract the same page.
 *
 *   600s   ack deadline (hard ceiling)
 *  -420s   RUN_TIME_BUDGET_MS — no new document is started past this
 *  ------
 *   180s   headroom, which has to absorb, in order:
 *
 *   ~60s   the ONE document already in flight when the budget expires. The
 *          check is BETWEEN documents, so the true wall is `budget + 1 doc`.
 *          The worst single document is a ~30-page Document AI online call
 *          (cross-region: the processor lives in `us`, the workers in
 *          asia-south1) that degrades, plus a pdf-parse fallback over a
 *          multi-MB buffer, plus a sidecar upload.
 *    ~1s   the findMany at the top (indexed on processingStatus + fetchedAt).
 *    ~1s   reportJobOutcome + the chain publish in the `finally`.
 *   ----
 *   ~62s   used, ~118s spare. Deliberately generous: being wrong here does not
 *          cost a slow run, it DUPLICATES the run.
 *
 * 420s is not a new number — `mf-nav-backfill` stops on the same 420s wall for
 * the same reason. It is lower than `xbrl-sync`'s 480s on purpose: that job's
 * per-item cost is a fixed 600ms delay plus one download, so its overshoot is
 * bounded and small. Here a single Document AI call carries no client-side
 * timeout at all, so the overshoot is the lumpy term and the headroom pays for
 * it.
 */
export const RUN_TIME_BUDGET_MS = 420_000;

/**
 * Hard ceiling on how many times one trigger may re-publish itself.
 *
 * THE TERMINATION PROOF LIVES HERE, and it deliberately does not depend on the
 * database. Every chained publish carries `chainDepth + 1`, and
 * `shouldChainAnotherBatch` refuses once the NEXT depth would reach this
 * value. So a chain is at most `MAX_CHAIN_DEPTH` messages long no matter what
 * the queue does, what `force` is set to, or whether any row moved. The other
 * conditions in that function can only stop it SOONER, so none of them can
 * break the bound.
 *
 * Sizing: 20 links x 420s ≈ 2h20m of work from the 22:00 IST trigger, landing
 * before 00:45. At the pessimistic ~6s/document that is ~1,400 documents a
 * night and the 34,790-PDF backlog clears in ~25 nights; at the optimistic
 * ~1s/document (Document AI unprovisioned, straight to pdf-parse) it is one
 * week. Against ~2 years at the old 50/day, either is the fix.
 */
export const MAX_CHAIN_DEPTH = 20;

/**
 * Sanitise the `chainDepth` carried on an inbound message.
 *
 * The value comes off a Pub/Sub payload, so it is `unknown` until proven
 * otherwise: a missing, negative, fractional, NaN or absurd value must not be
 * able to buy extra links. Anything that is not a finite non-negative number
 * reads as depth 0, and anything above the ceiling is clamped to it (so a
 * forged large value ENDS the chain rather than wrapping it).
 */
export function normalizeChainDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(Math.floor(value), MAX_CHAIN_DEPTH);
}

/** Inputs to the self-chain decision. All observed, none inferred. */
export interface ChainDecisionInput {
  /** Rows this run pulled from the queue. */
  selected: number;
  /** The `take` this run used. `selected < batchSize` means the queue ran dry. */
  batchSize: number;
  /** This run's depth (0 for a scheduler trigger). */
  chainDepth: number;
  /**
   * Rows that actually LEFT the PENDING set this run (the PROCESSING flip
   * landed). Zero means the queue is unchanged and re-running would re-select
   * the same page — the runaway shape.
   */
  leftPending: number;
  /** `force` re-selects FAILED rows, so a failing row is a fixpoint. */
  force: boolean;
}

/**
 * Should this run publish a follow-up message?
 *
 * Four independent reasons to stop, ANY of which ends the chain:
 *
 *  1. **Depth.** The next link would reach `MAX_CHAIN_DEPTH`. This one alone
 *     bounds the chain; the rest are optimisations that stop it sooner.
 *  2. **Drained.** The run got fewer rows than it asked for, so there is no
 *     next page.
 *  3. **No progress.** Not one row left PENDING — e.g. every `update` threw.
 *     Chaining here re-selects the identical page forever, which is the exact
 *     runaway-poll shape this repo already has an incident for.
 *  4. **Forced.** `force` widens the selection to PENDING+FAILED, so a
 *     document that fails deterministically is selected again on the next
 *     link and the chain has no fixpoint to reach. Forced runs are manual and
 *     scoped; they do one batch and stop.
 */
export function shouldChainAnotherBatch(input: ChainDecisionInput): boolean {
  const { selected, batchSize, chainDepth, leftPending, force } = input;
  if (force) return false;
  if (chainDepth + 1 >= MAX_CHAIN_DEPTH) return false;
  if (batchSize <= 0) return false;
  if (selected < batchSize) return false;
  if (leftPending <= 0) return false;
  return true;
}

/**
 * True while the run may start ANOTHER document.
 *
 * Pure so the budget is testable without a clock: the caller passes
 * `Date.now()` and the run's start. Checked BETWEEN documents — see the
 * headroom arithmetic on `RUN_TIME_BUDGET_MS` for why that is safe.
 */
export function isWithinRunBudget(
  startedAtMs: number,
  nowMs: number,
  budgetMs: number = RUN_TIME_BUDGET_MS,
): boolean {
  return nowMs - startedAtMs < budgetMs;
}
