/**
 * "Are these bytes actually a document?" — the BODY sniff (MONEY-1315 part B).
 *
 * ## The finding
 *
 * Under the `stocks/` prefix there are objects whose content is a SEBI landing
 * page stored where a document was expected. Verbatim, from prod
 * 2026-08-31:
 *
 *     KEY   stocks/AAATECH/drhp/AAATECH-drhp-IPO.txt
 *     meta  {"cacheControl":"private, max-age=3600",
 *            "contentType":"text/html; charset=UTF-8"}
 *     body  <!DOCTYPE html><html lang="en">…
 *           <title>SEBI | AAA Technologies Limited - Prospectus</title>
 *
 * A full body scan of all 88,607 rows on 2026-09-01 found 1,573 like it —
 * `credit_rating` 832, `drhp` 608, `concall_ppt` 64, `annual_report` 39,
 * `concall_transcript` 30 — and EVERY ONE is `sourceType: "SCREENER"`, so the
 * whole population came through one function. Screener's Documents section
 * links a
 * DRHP to SEBI's HTML *landing page* for the issue, not to the prospectus PDF,
 * and the rating-agency links behave the same way. The fetch succeeds, 200,
 * with an entirely honest `text/html` header — there is no transport failure
 * anywhere for anything to notice.
 *
 * ## Why the existing guard did not stop it, and why this one sniffs the BODY
 *
 * `initialProcessingStatus` (MONEY-1255) already maps `text/html` to a terminal
 * `UNSUPPORTED`, and it fired correctly: all 1,580 rows ARE `UNSUPPORTED`. What
 * it never did was stop the WRITE. The object was uploaded anyway, `gcsPath`
 * was set, and the row goes on claiming a document that does not exist — which
 * is worse than an absent row, because `gcsPath` is the column every reader
 * takes as proof the bytes are there.
 *
 * That guard classifies by the DECLARED RESPONSE HEADER, and the header is the
 * one thing here that cannot be trusted. It is right about SEBI (`text/html`,
 * honestly declared) and it is blind to the case where an upstream serves an
 * error page under `application/pdf` — NSE and BSE both answer a throttled or
 * cookieless request with a 200 carrying HTML, and three writers in this repo
 * (`storeNSEFiling`, `annual-reports-sync`, `nse-announcements-sync`) HARDCODE
 * `application/pdf` at the upload, so for them the header is not even the
 * upstream's claim, it is ours. A header-based rule cannot see a lie it wrote
 * itself.
 *
 * ## One predicate, not two
 *
 * The HTML test is NOT restated here. It is `classifyArchivedObject` from
 * `@usemoney/storage`, whose own header explains why: "two copies of a
 * predicate that decides whether data is corrupt is exactly the drift this repo
 * has been bitten by before: the copies agree until the day they don't, and the
 * disagreement surfaces as an audit that reports 'clean'". This module adds
 * exactly one thing that module cannot do on its own — look INSIDE a
 * MONEY-1169 multipart envelope — and it does that by calling the same
 * classifier a second time on the recovered payload.
 *
 * ## Where it lives
 *
 * Beside `stock-document-paths.ts`, for the same reason that file is here: this
 * package is already the shared home for `stock_documents` storage concerns,
 * and it is the only one BOTH writers can reach. `workers` depends on
 * `@usemoney/research`, `@usemoney/research` depends on `@usemoney/storage`,
 * and `stock-document-fetcher.ts` — the second writer of this table from a raw
 * header — is already in this directory. Putting it in `workers` would leave
 * that writer unable to import it; putting it in `@usemoney/core` would need a
 * new dependency edge core deliberately does not have.
 *
 * PURE: no I/O, no clock, no randomness. Both imports are zero-I/O leaves
 * reached by SUBPATH, so nothing here loads the GCS SDK.
 */

import {
  classifyArchivedObject,
  isEnvelopeVerdictKind,
  ARCHIVE_AUDIT_HEAD_BYTES,
  type ArchiveVerdict,
} from "@usemoney/storage/archive-audit";
import { stripMultipartEnvelope } from "@usemoney/storage/multipart-envelope";
// MONEY-1321 — the quarantine must not destroy the 520 rows whose HTML IS the
// document. One host list, read by the recovery router and by the classifier
// below, so the two cannot disagree about which pages are safe to clear.
import {
  isHtmlTheDocumentHost,
  recoverDocumentUrl,
  recoveryHostKind,
  recoveryUrlHost,
} from "./document-link-recovery";

/**
 * How many leading bytes {@link sniffDocumentBody} wants.
 *
 * `ARCHIVE_AUDIT_HEAD_BYTES` (1,024) is the window the CLASSIFIER needs, and
 * MONEY-1315 part A measured why it is that: the envelope preamble a payload
 * sniff has to skip is `191 + 2 × len(contentType)` bytes for the writer's
 * metadata shape — min 209, p50/p95/max 239 across 121 envelope-bearing
 * objects under `stocks/` on prod.
 *
 * This is DOUBLE that, deliberately, because this module reads the head ONCE
 * and asks the classifier TWICE: once about the outer bytes, then again about
 * the recovered payload. The second call should get a full classifier window
 * rather than the remainder of one, and the preamble is not structurally
 * bounded — it grows linearly with the declared content type (an OOXML type is
 * 65 chars → 321 bytes) and `uploadFile` splices arbitrary caller-supplied
 * `metadata` into the same JSON part, so a future writer can push the payload
 * offset out with no code change here.
 *
 * The extra kilobyte costs nothing: this is a single ranged GET either way and
 * GCS bills the OPERATION, so the scan is latency-bound on round trips.
 */
export const DOCUMENT_SNIFF_HEAD_BYTES = 2 * ARCHIVE_AUDIT_HEAD_BYTES;

/**
 * The terminal `processingStatus` for a row whose bytes turned out to be HTML.
 *
 * `UNSUPPORTED`, deliberately, and shared by the WRITER and the QUARANTINE
 * MIGRATION so the two can never disagree about what state they leave a row in:
 *
 *  - it is already what `initialProcessingStatus` returns for `text/html`, so
 *    all 1,580 existing rows are there and the migration is a no-op on that
 *    column for them;
 *  - it is TERMINAL, so the row stops overstating the extraction backlog;
 *  - it is not `FAILED`, which means "we tried and it did not work" and which
 *    `force: true` re-runs — putting a guaranteed no-op into every forced pass.
 */
export const HTML_QUARANTINE_STATUS = "UNSUPPORTED";

/**
 * The `gcsPath` a row carries once we know the bytes are not a document.
 *
 * The empty string is this repo's established "the bytes are not there"
 * convention rather than a new one: **7,234** rows already carry it (BSE stops
 * serving corpfiling attachments below ~2018), and every reader skips it BY
 * NAME — `gcsPath: { notIn: [""] }` in `doc-ingest-selectors-logic.ts:129`
 * and `:180`, and again in `doc-ingest-backfill.ts:1314`. A null or a deleted
 * column would need each of those readers changed; this one is already
 * understood everywhere it matters.
 *
 * ## THE NUMBER, AND WHICH ONE TO QUOTE
 *
 * This is the SINGLE SPELLING for callers; three were live in this branch and
 * they are not interchangeable:
 *
 *   7,234   measured 2026-09-01 over the 79,884 PDF rows
 *           (`docs/reference/doc-ingest-population.md`). **Use this one.**
 *   6,125   measured 2026-08-29 (CLAUDE.md). SUPERSEDED, not contradicted —
 *           the population grew, and that doc says so explicitly.
 *   6,996   the quarantine migration's own dry-run `alreadyQuarantined`, same
 *           day as 7,234 and over a LARGER population (all 88,607 rows), which
 *           cannot hold fewer of them than its own PDF subset. That scan's
 *           short-page `break` could end the walk early against a 16 MB
 *           `firstBatch` cap, so it is a floor rather than a census; the break
 *           is gone and the run wants repeating. Do not quote it.
 */
export const ABSENT_GCS_PATH = "";

/** What {@link sniffDocumentBody} concluded about a document's bytes. */
export interface DocumentBodySniff {
  /** True when these bytes are an HTML page, bare or inside an envelope. */
  html: boolean;
  /** True when the bytes carry a MONEY-1169 multipart envelope. */
  enveloped: boolean;
  /** The underlying classifier's verdict kind, for per-class reporting. */
  kind: string;
  /** Human-readable reason, for a log line or a census row. */
  why: string;
}

/**
 * Classify a document's bytes, seeing THROUGH a multipart envelope.
 *
 * `classifyArchivedObject` checks for the envelope BEFORE anything else, and it
 * has to: an enveloped object's head is the boundary, so every type check below
 * it would misfire. The consequence is that it answers one of the `envelope-*`
 * kinds and never `html` for the enveloped majority of this population —
 * measured, 1,046 of the 1,573 HTML-bodied rows are enveloped. So an envelope
 * is peeled and the SAME classifier is asked again about the payload.
 *
 * The envelope branch tests `isEnvelopeVerdictKind`, part A's own exported
 * membership function, rather than a `startsWith("envelope")` string
 * convention. Both work today; only one FAILS THE BUILD if the family is ever
 * renamed. A prefix test would keep compiling and quietly stop peeling, which
 * is the same silence this whole module exists to remove — 100% of the
 * population is enveloped, so a disarmed peel reports a completely clean scan.
 *
 * Re-classifying the payload is not a duplicate of part A's own
 * `envelope-html` verdict, and is not made redundant by it: `envelope-unknown`
 * means "the payload did not begin within the classifier's window", and this
 * module reads a LARGER head, so the second call can settle keys the first
 * could not. It also keeps working if the family is ever collapsed back.
 *
 * `head` may be shorter than {@link DOCUMENT_SNIFF_HEAD_BYTES} — a genuinely
 * small object — which is not itself a fault. It may also be the WHOLE body,
 * which is what the write-time caller passes.
 */
export function sniffDocumentBody(args: {
  key: string;
  size: number;
  head: Buffer;
}): DocumentBodySniff {
  const verdict: ArchiveVerdict = classifyArchivedObject(args);

  if (verdict.kind === "html") {
    return {
      html: true,
      enveloped: false,
      kind: verdict.kind,
      why: verdict.why,
    };
  }

  if (isEnvelopeVerdictKind(verdict.kind)) {
    const stripped = stripMultipartEnvelope(args.head);
    if (!stripped) {
      // The envelope is malformed within the window we read, so the payload
      // cannot be recovered byte-exactly. Report the envelope and claim
      // NOTHING about what is inside it: guessing "probably HTML" here would
      // quarantine a repairable data object, which is the one outcome this is
      // not allowed to produce.
      return {
        html: false,
        enveloped: true,
        kind: verdict.kind,
        why: `${verdict.why} — payload not recoverable from the head`,
      };
    }
    const inner = classifyArchivedObject({
      key: args.key,
      size: stripped.payload.length,
      head: stripped.payload,
    });
    return {
      html: inner.kind === "html",
      enveloped: true,
      kind: `envelope:${inner.kind}`,
      why:
        inner.kind === "html"
          ? `enveloped HTML — ${inner.why}`
          : `${verdict.why} (payload: ${inner.kind})`,
    };
  }

  return {
    html: false,
    enveloped: false,
    kind: verdict.kind,
    why: verdict.why,
  };
}

/**
 * What the quarantine migration decides about ONE existing row.
 *
 *   alreadyQuarantined  no `gcsPath` — nothing is claimed, nothing to do
 *   objectMissing       a `gcsPath` naming an object the bucket does not hold
 *   htmlIsTheDocument   the bytes are HTML and the HTML *is* the document —
 *                       KEEP. See {@link classifyDocumentRow}.
 *   html                the bytes are an HTML page — QUARANTINE
 *   ok                  a real document
 */
export type DocumentRowClass =
  | "alreadyQuarantined"
  | "objectMissing"
  | "htmlIsTheDocument"
  | "html"
  | "ok";

/**
 * Classify one row for the quarantine migration.
 *
 * Lives here rather than inside `scripts/migrations/` for the reason
 * `planDocQueueRepair` lives in `@usemoney/core/market-data/doc-mime`: a pure
 * decision inside a `scripts/` file is a decision no test can reach without
 * executing the script, and the script's `main()` wants a DATABASE_URL and a
 * bucket. Keeping it beside {@link mayStoreDocumentBody} also means the
 * migration and the writer share one definition of "there is no document
 * here".
 *
 * ## The absent-field arm
 *
 * `gcsPath` is typed `string | null`, and `null` is how an ABSENT attribute
 * arrives — the migration's aggregate projects `{ $ifNull: ["$gcsPath", null] }`
 * rather than filtering on the field, precisely so a row whose attribute was
 * never created is still SELECTED and reaches this function. It must therefore
 * accept null and classify it, never assume a string.
 *
 * A Mongo `prisma db push` creates INDEXES, never FIELDS, so a Prisma equality
 * or `{ not: … }` on an absent attribute matches ZERO rows in BOTH directions.
 * A migration that selected `gcsPath: { not: "" }` would silently skip every
 * such row and report a confident, complete-looking census over a population it
 * could not see. That class has caused MONEY-1050, 1205, 1234, 1235 and 1236.
 */
export function classifyDocumentRow(args: {
  /** The row's `gcsPath`; `null` when the attribute is absent. */
  gcsPath: string | null;
  /**
   * The row's `sourceUrl`. REQUIRED, and `null` when the attribute is absent.
   *
   * Not optional, and that is the point — MONEY-1321. An optional argument
   * defaulting to "not a rating-agency page" would mean a caller that forgot it
   * gets the DESTRUCTIVE answer silently, which is the failure this parameter
   * was added to prevent. Requiring it makes the omission a compile error.
   */
  sourceUrl: string | null;
  /** Does the bucket hold an object at that key? */
  objectExists: boolean;
  /** Did {@link sniffDocumentBody} say the bytes are HTML? */
  bodyIsHtml: boolean;
}): DocumentRowClass {
  if (!args.gcsPath || args.gcsPath === ABSENT_GCS_PATH) {
    return "alreadyQuarantined";
  }
  if (!args.objectExists) return "objectMissing";
  if (!args.bodyIsHtml) return "ok";

  // MONEY-1321 — HTML IS NOT ALWAYS THE WRONG BYTES.
  //
  // Measured on prod 2026-09-02 across all 1,580 HTML-bodied rows: 520 of them
  // (CRISIL 442, Brickwork 69, Acuité 9) are credit-rating rationales published
  // AS the page — median 17,177 / 13,201 / 18,288 characters of extracted text,
  // against 455 for a SEBI landing page and 86 for an India Ratings JS shell.
  // CRISIL's own `sourceUrl` ends in `.html`; there is no PDF to have fetched
  // instead. Blanking their `gcsPath` would delete content we hold, and nothing
  // revisits a cleared row.
  //
  // This arm sits between `bodyIsHtml` and the quarantine rather than beside
  // it, so the ONLY way to reach `html` is to fail it. The host list is
  // `isHtmlTheDocumentHost`'s, imported rather than restated.
  if (isHtmlTheDocumentHost(args.sourceUrl)) return "htmlIsTheDocument";

  return "html";
}

/**
 * Would the RECOVERY still turn this row into a document, from these bytes?
 * — MONEY-1321 H2.
 *
 * ## The order the two migrations have to run in, expressed as a GUARD
 *
 * `recover-html-stock-documents.ts` and `quarantine-html-stock-documents.ts`
 * both claimed in their headers that running order does not matter, "because
 * the recovery RE-FETCHES `sourceUrl` when `gcsPath` has been blanked". No such
 * branch existed. The recovery's only fetch derives its URL FROM THE PAGE, so
 * for a SEBI row the stored bytes are the ONLY copy of the link to the
 * prospectus — quarantine-first blanks `gcsPath`, every row then classifies
 * `noBytes`, the census reads clean, the run exits 0, and 604 prospectuses are
 * unrecoverable.
 *
 * A corrected sentence would not have stopped that. A comment is not a guard,
 * and this repo has been bitten by exactly that ("Naming a bug is not
 * protection from it"). So the quarantine asks this question about every row it
 * is about to clear, and REFUSES `--apply` while the answer is yes for any of
 * them.
 *
 * ## Why it asks the ROUTER rather than testing a host list
 *
 * A host list here would be a fourth copy of the taxonomy `document-link-
 * recovery.ts` owns, and the failure mode of a drifted copy is that the
 * destructive job stops seeing rows the constructive one would have saved. So
 * the test is the recovery's OWN verdict over the row's OWN bytes:
 *
 *   - `document-url` on the SAME host  the recovery would fetch and store a
 *                                      real document. These bytes are load-
 *                                      bearing. TRUE.
 *   - anything else                    the recovery has nothing to do here
 *                                      (`unrecoverable`, an unmeasured host, or
 *                                      a cross-host link it refuses). FALSE.
 *
 * `html-is-the-document` is FALSE for a different reason and never reaches this
 * function in practice: those rows are excluded from the quarantine by
 * {@link classifyDocumentRow} several steps earlier.
 *
 * ## It CONVERGES, which a "did you run the other one?" flag would not
 *
 * Once the recovery has run, a recovered row's bytes are a PDF — so it is `ok`,
 * not `html`, and never reaches here. A row whose fetch failed still answers
 * TRUE, and that is correct: it is still recoverable, and the remedy is to
 * re-run the recovery (which is additive and idempotent), not to destroy it.
 * The guard therefore lifts itself when the work is genuinely done, and cannot
 * be lifted by an operator's belief that it is.
 *
 * PURE: the caller supplies the bytes. Reading them is the script's job.
 */
export function recoveryStillNeedsTheseBytes(args: {
  /** The row's `sourceUrl`; `null` when the attribute is absent. */
  sourceUrl: string | null;
  /** The stored page, decoded. `""` when the caller did not read it. */
  html: string;
}): boolean {
  if (!args.sourceUrl) return false;
  const rec = recoverDocumentUrl({
    sourceUrl: args.sourceUrl,
    html: args.html,
  });
  if (rec.kind !== "document-url") return false;
  // The recovery refuses a cross-host recovery, so a cross-host link is not
  // something these bytes can still buy. Same rule, asked the same way.
  return recoveryUrlHost(rec.url) === recoveryUrlHost(args.sourceUrl);
}

/**
 * Is this row's host one the recovery would look at at all?
 *
 * A re-export of the router's own answer, so the quarantine can skip the FULL
 * object read for the ~780 rows on hosts that have no one-hop rule — without
 * writing down a second list of which those are.
 */
export function recoveryLaneNeedsTheBody(sourceUrl: string | null): boolean {
  return recoveryHostKind(sourceUrl) === "one-hop";
}

/** The write-time decision: may these bytes be stored under this key? */
export interface DocumentStoreDecision {
  /** True when the bytes may be uploaded. */
  store: boolean;
  /** Why not. Empty when `store` is true. */
  reason: string;
}

/**
 * WRITE-TIME GUARD — refuse to store an HTML page under a document key.
 *
 * Called with the freshly-downloaded body, BEFORE the upload, by every
 * download-and-store path in `stock-document-sync.ts`. It is deliberately
 * narrow: it refuses HTML and NOTHING ELSE.
 *
 * In particular it does NOT refuse the classifier's `invalid` verdict (a `.pdf`
 * key whose bytes lack `%PDF`). That would be a precise rule with no catch-all
 * — the shape that shrinks coverage — and its false positives are real
 * documents we would then never store, with no path back. HTML is the measured
 * failure with a measured population; `invalid` is a hypothesis.
 *
 * Nor does it refuse an `empty` body: the callers already reject anything below
 * `MIN_DOC_BUFFER_BYTES` (500), and a zero-byte response is a transport
 * question, not a "this is the wrong document" question.
 */
export function mayStoreDocumentBody(args: {
  gcsPath: string;
  body: Buffer;
}): DocumentStoreDecision {
  const sniff = sniffDocumentBody({
    key: args.gcsPath,
    size: args.body.length,
    head: args.body.subarray(0, DOCUMENT_SNIFF_HEAD_BYTES),
  });
  return sniff.html
    ? { store: false, reason: sniff.why }
    : { store: true, reason: "" };
}
