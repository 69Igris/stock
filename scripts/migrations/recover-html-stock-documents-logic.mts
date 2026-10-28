/**
 * The whole DECISION of `recover-html-stock-documents.ts`, with no I/O —
 * MONEY-1321.
 *
 * It lives beside the script rather than inside it for the reason
 * `xbrl-projection-drain-logic.mts` does, and the reason `planDocQueueRepair`
 * lives in `@usemoney/core/market-data/doc-mime`: a decision inside a
 * `scripts/` file is a decision no test can reach without EXECUTING the script,
 * and this one's module scope calls `run()`. Importing it from a test would
 * start a corpus walk against whatever `DATABASE_URL` happened to be ambient.
 *
 * Everything here is a function of the row plus its stored bytes. The script
 * supplies the bytes and performs whatever the plan names; nothing in this file
 * reads GCS, touches Prisma, or reaches a third-party host.
 *
 * ## The routing is NOT restated here
 *
 * `recoverDocumentUrl` owns which host means what, and it is called rather than
 * paraphrased. That matters more than usual: the difference between the two
 * lanes is the difference between fetching a document and DESTROYING one — on a
 * CRISIL page the `.pdf` links are methodology boilerplate and the rationale is
 * the page itself, so a second copy of the rule that drifted would swap 442
 * company rationales for a generic criteria PDF, confidently, with nothing in
 * the row to reveal it.
 */

import {
  recoverDocumentUrl,
  recoveryHostKind,
  recoveryUrlHost,
  type DocumentRecovery,
} from "@usemoney/research/data-sources/document-link-recovery";
// THE TWO HTML PREDICATES, AND WHY THIS FILE ASKS BOTH — MONEY-1321 H4.
//
// `sniffDocumentContainer`'s question is "which container is this, so the
// pipeline can ROUTE it?" — this file's question. `sniffDocumentBody` wraps
// `classifyArchivedObject`, whose question is "is this archived object
// CORRUPT?" — and that one is what the QUARANTINE destroys rows on.
//
// The two are NOT the same rule, and this comment used to claim the divergence
// was "exactly TEN, all in ONE direction". Only one direction had ever been
// looked at. Both were then measured over every object under `stocks/` on prod
// (123,131 objects, 2026-09-02) — see {@link bodyIsAWebPage} for the counts.
// The direction that had never been measured is the DANGEROUS one:
//
//   routing says html, corruption says ok      SAFE. The quarantine keeps a row
//                                              it calls `ok`; the recovery still
//                                              extracts it. (The 9 Acuité pages
//                                              opening `<title>Press Release`
//                                              and the 1 BOM-prefixed knrcl.com
//                                              page live here.)
//   corruption says html, routing says not     LETHAL. The quarantine blanks
//                                              `gcsPath` — and a recovery that
//                                              asked only `sniffDocumentContainer`
//                                              answers `notHtml` and walks past
//                                              the row it was written to save.
//                                              `<?xml-stylesheet` (NSE's own
//                                              filing sidecar shape, MONEY-1319)
//                                              is exactly this: `html` to
//                                              `archive-audit`'s anchored
//                                              64-byte rule, `unknown` to
//                                              `doc-container`'s.
//
// Neither module may be edited from here (`packages/storage` owns one,
// `doc-container.ts` the other, and both are deliberately different questions),
// so the reconciliation lives on the MIGRATION side and runs in one direction
// only: the recovery's HTML set is a SUPERSET of the quarantine's. Whatever the
// quarantine is willing to destroy, this job is willing to look at.
import {
  sniffDocumentContainer,
  type DocumentContainer,
} from "@usemoney/core/market-data/doc-container";
import { sniffDocumentBody } from "@usemoney/research/data-sources/document-body-guard";
// Peeled here as well as by the caller. `stripMultipartEnvelope` returns null
// on bytes that carry no envelope, so a second peel is a no-op — and it makes
// this function correct for ANY caller instead of correct-by-convention.
import { stripMultipartEnvelope } from "@usemoney/storage/multipart-envelope";
// The SAME stripper the document-process worker RAG-indexes with, imported
// rather than restated: a second HTML-to-text rule would drift from the one the
// rest of the corpus was built with, and the text this job writes lands in the
// identical `textContent` column feeding the identical embed lane.
import { stripHtmlTags } from "../../workers/src/processors/document-process-logic.js";

/** Which lane a row belongs to. `all` is a CLI selector, never a verdict. */
export type RecoveryLane = "one-hop" | "text";

/**
 * What happened to ONE row.
 *
 * `noBytes` and `fetchFailed` are deliberately NOT folded into
 * `unrecoverable`: the first two are MOMENTS (a blanked path, a transient
 * upstream) and the third is a FACT about the page. Marking a moment terminal
 * is how a blip becomes a permanent skip.
 *
 * `readFailed` is separated from `noBytes` for the opposite reason — MONEY-1321
 * M13. `noBytes` is a FINDING about the row ("the object is not there, and the
 * quarantine may have blanked the path"); a GCS auth failure, a wrong bucket or
 * a transport error is a finding about the RUN. Folding the second into the
 * first is what lets a run that read nothing at all print a clean census and
 * exit 0 — the exact shape the sibling quarantine refuses when its listing
 * comes back empty.
 */
export type RecoveryOutcome =
  | "alreadyRecovered"
  | "notHtml"
  | "noBytes"
  | "readFailed"
  | "oneHopPlanned"
  | "oneHopWritten"
  | "textPlanned"
  | "textWritten"
  | "textTooShort"
  | "crossHostRefused"
  | "fetchFailed"
  | "fetchedNotADocument"
  | "unrecoverable";

export const RECOVERY_OUTCOMES: readonly RecoveryOutcome[] = [
  "alreadyRecovered",
  "notHtml",
  "noBytes",
  "readFailed",
  "oneHopPlanned",
  "oneHopWritten",
  "textPlanned",
  "textWritten",
  "textTooShort",
  "crossHostRefused",
  "fetchFailed",
  "fetchedNotADocument",
  "unrecoverable",
];

/**
 * Outcomes that mean THE RUN is degraded, not that a row had nothing to give.
 *
 * The script exits non-zero when any of these is non-empty, so a wrapper's `&&`
 * cannot read "we could not open the bucket" as "there was nothing to do".
 */
export const RECOVERY_RUN_FAULTS: readonly RecoveryOutcome[] = ["readFailed"];

/**
 * Is this GCS error "the object is not there" rather than "we could not read"?
 *
 * The distinction is the whole of M13, and it cannot be made from the fact that
 * an exception was thrown. `@google-cloud/storage` raises an `ApiError` with a
 * numeric `code`, and 404 is the ONE value that means the key is absent — which
 * is a fact about the row. 401/403 (credentials, IAM), 5xx and every network
 * error are facts about the RUN.
 *
 * Classified on the CODE, with a message fallback, because a bare `catch`
 * returning `null` made all of them indistinguishable from an already-blanked
 * `gcsPath` — and 604 SEBI + 186 ICRA rows legitimately carry one, so the
 * cover story was always available.
 */
export function isMissingObjectError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "number") return code === 404;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /\bNo such object\b|\b404\b/i.test(message);
}

/**
 * Below this, the extracted text is not a document.
 *
 * The same 50 the extract worker uses, and the same meaning: a row that yields
 * less is left ALONE — not written, not quarantined — because "we could not
 * read it" is a finding, while `READY` over forty characters of navigation
 * chrome is a lie no reader can detect.
 */
export const MIN_RECOVERED_TEXT = 50;

/** What the script should DO. `null` means: nothing, leave the row alone. */
export type RecoveryWritePlan =
  | { kind: "one-hop"; url: string; why: string }
  | { kind: "text"; text: string; why: string };

export interface RecoveryPlan {
  outcome: RecoveryOutcome;
  write: RecoveryWritePlan | null;
}

/**
 * Host of a URL, lower-cased. `""` when there is nothing parseable.
 *
 * Delegates to `recoveryUrlHost` rather than restating the parse. "Same host"
 * is the rule that stops a page naming an arbitrary absolute URL from being
 * fetched and stored under our symbol, and a second copy of it would agree
 * until the day it did not.
 */
export function recoveryHostOf(url: string | null | undefined): string {
  return recoveryUrlHost(url);
}

/**
 * Which lane a `sourceUrl` routes to, from the HOST alone.
 *
 * Delegates to `recoveryHostKind`, which is the point: the host decides the
 * LANE and the body decides the URL. Asking `recoverDocumentUrl` with an empty
 * body instead — the obvious shortcut, and the first thing this file did —
 * returns `unrecoverable` for every SEBI and ICRA row, because for those hosts
 * the BODY is what carries the viewer link. The narrowing would then drop all
 * 790 one-hop rows while the 520 text rows kept routing perfectly, which is a
 * broken filter that passes every check anyone would think to run on it.
 */
export function recoveryLaneFor(
  sourceUrl: string | null | undefined,
): RecoveryLane | null {
  const kind = recoveryHostKind(sourceUrl);
  if (kind === "one-hop") return "one-hop";
  if (kind === "html-is-the-document") return "text";
  return null;
}

/** The lane a verdict belongs to, or `null` when there is no recovery. */
export function laneOfRecovery(rec: DocumentRecovery): RecoveryLane | null {
  if (rec.kind === "document-url") return "one-hop";
  if (rec.kind === "html-is-the-document") return "text";
  return null;
}

/**
 * Decide what to do with ONE row.
 *
 * ORDER IS LOAD-BEARING and each step is a cheaper refusal than the next:
 *
 *   1. **Already recovered** — checked before the bytes are even needed, so a
 *      completed pass costs nothing to re-run. This is the idempotence.
 *   2. **The read failed** — a fact about the RUN, never about the row. Kept
 *      ahead of `noBytes` so an auth or bucket failure cannot wear the costume
 *      of a legitimately blanked path (MONEY-1321 M13).
 *   3. **No bytes** — the quarantine may already have blanked `gcsPath`. A
 *      MOMENT, reported, never a verdict about the page. **And no longer a dead
 *      end**: a row whose document is derivable from `sourceUrl` ALONE is
 *      recovered from here (MONEY-1321 H2 — ICRA's rationale id is in the URL).
 *   4. **Still a web page?** — decided from the BYTES, not from `mimeType`, and
 *      by the UNION of both predicates (see {@link bodyIsAWebPage}). A row a
 *      previous run fixed, or one whose upstream started serving a real
 *      document, is `notHtml` and is left alone. This is what makes a second
 *      run a no-op rather than a second write.
 *   5. **The routing**, from `recoverDocumentUrl`.
 *   6. **Same host** — the viewer's `file=` is absolutised against `sourceUrl`,
 *      so an absolute value in the page could name any host. The document must
 *      live where the page does, and a refusal is COUNTED rather than silently
 *      skipped.
 */
export function planRecovery(args: {
  /** The row's `sourceUrl`; `null` when the attribute is absent. */
  sourceUrl: string | null;
  /** The row's `gcsPath`, for the sniff's key argument only. */
  gcsPath: string | null;
  /** The row's `processingStatus`; `null` when absent. */
  processingStatus: string | null;
  /** Does the row already hold extracted text? */
  hasText: boolean;
  /**
   * The stored object's bytes. A MONEY-1169 multipart envelope is peeled here
   * if the caller has not already done it, so either form is accepted.
   * `null` means there are no bytes to look at.
   */
  body: Buffer | null;
  /**
   * Did the object read FAIL, as opposed to finding nothing? — MONEY-1321 M13.
   *
   * REQUIRED, and not optional, for the reason `classifyDocumentRow.sourceUrl`
   * is: an optional flag defaulting to `false` means a caller that forgets it
   * silently reports every auth failure as `noBytes`, which is the defect. A
   * compile error is the only version of this that cannot be forgotten.
   */
  readFailed: boolean;
}): RecoveryPlan {
  if (args.processingStatus === "READY" && args.hasText) {
    return { outcome: "alreadyRecovered", write: null };
  }
  if (args.readFailed) {
    return { outcome: "readFailed", write: null };
  }
  if (!args.body || args.body.length === 0) {
    // MONEY-1321 H2 — THE RE-FETCH PATH THE HEADERS CLAIMED AND DID NOT HAVE.
    //
    // Both migration headers stated that running order does not matter because
    // the recovery "re-fetches `sourceUrl`" once the quarantine has blanked
    // `gcsPath`. No such branch existed: this returned `noBytes` and the only
    // fetch in the script derives its URL FROM THE BODY, so with no body there
    // was nothing to fetch and 604 SEBI + 186 ICRA rows would have classified
    // `noBytes` against a census that looked clean.
    //
    // ICRA is the half that genuinely needs no bytes: the rationale id is the
    // `Id` query parameter of `sourceUrl` itself, and
    // `/Rating/ShowRationalReportFilePdf/<Id>` is derived from it. SEBI is NOT
    // — its viewer link lives in the page — so an empty body correctly still
    // yields `unrecoverable` there, and the ORDER guard on the quarantine is
    // what protects those rows. Asking the same router rather than a private
    // rule is the point: one host taxonomy, and a host that later becomes
    // URL-derivable is covered here the day it is added.
    const fromUrlAlone = recoverDocumentUrl({
      sourceUrl: args.sourceUrl ?? "",
      html: "",
    });
    if (
      fromUrlAlone.kind === "document-url" &&
      recoveryHostOf(fromUrlAlone.url) === recoveryHostOf(args.sourceUrl)
    ) {
      return {
        outcome: "oneHopPlanned",
        write: {
          kind: "one-hop",
          url: fromUrlAlone.url,
          why: `${fromUrlAlone.why} (no stored bytes — recovered from sourceUrl alone)`,
        },
      };
    }
    return { outcome: "noBytes", write: null };
  }

  const peeled = peelEnvelope(args.body);
  if (!bodyIsAWebPage(args.gcsPath, peeled)) {
    return { outcome: "notHtml", write: null };
  }

  const rec = recoverDocumentUrl({
    sourceUrl: args.sourceUrl ?? "",
    html: peeled.toString("utf-8"),
  });

  if (rec.kind === "unrecoverable") {
    return { outcome: "unrecoverable", write: null };
  }

  if (rec.kind === "document-url") {
    if (recoveryHostOf(rec.url) !== recoveryHostOf(args.sourceUrl)) {
      return { outcome: "crossHostRefused", write: null };
    }
    return {
      outcome: "oneHopPlanned",
      write: { kind: "one-hop", url: rec.url, why: rec.why },
    };
  }

  const text = stripHtmlTags(peeled.toString("utf-8"));
  if (text.length < MIN_RECOVERED_TEXT) {
    return { outcome: "textTooShort", write: null };
  }
  return {
    outcome: "textPlanned",
    write: { kind: "text", text, why: rec.why },
  };
}

/** Peel a MONEY-1169 multipart envelope if there is one. Idempotent. */
function peelEnvelope(body: Buffer): Buffer {
  const stripped = stripMultipartEnvelope(body);
  return stripped ? Buffer.from(stripped.payload) : body;
}

/**
 * Are these bytes a web page — by EITHER predicate? — MONEY-1321 H4.
 *
 * ## The measurement, in the direction nobody had looked
 *
 * Both predicates were run over EVERY object under `stocks/` on prod —
 * 123,131 objects, 2026-09-02, 0 read errors — not over the HTML-bodied cohort,
 * because a cohort selected by one of the two predicates cannot show what the
 * other one sees outside it:
 *
 *     both say html                                     1,573
 *     neither                                         121,548
 *     routing only   (container html, corruption ok)       10   SAFE
 *     corruption only (corruption html, container not)      0   LETHAL — today
 *
 * The 10 are the ones the old comment named and they are all safe: 9
 * `connect.acuite.in` pages opening on a bare `<title>Press Release</title>`,
 * and 1 `knrcl.com` transcript with a UTF-8 BOM before `<!DOCTYPE html>`. The
 * quarantine calls those `ok` and KEEPS them.
 *
 * The lethal column is ZERO **today**, and that is a fact about the corpus, not
 * a property of the code. It is one `<?xml-stylesheet` object away from being
 * non-zero: `archive-audit`'s rule matches that prefix and `doc-container`'s
 * does not, and NSE ships exactly that shape as the XML sidecar inside its
 * filing ZIPs (MONEY-1319). The moment one is stored bare, the quarantine calls
 * it `html` and blanks `gcsPath` while a container-only recovery calls it
 * `notHtml` and walks past it. `<!doctype` followed by anything other than
 * whitespace-plus-`html` is the same hole (`<!DOCTYPE svg`, `<!DOCTYPE plist`).
 *
 * ## Why the fix is a UNION and not a shared predicate
 *
 * The two modules answer deliberately different questions and neither may be
 * edited to serve the other: `packages/storage`'s classifier grades CORRUPTION
 * for the feed archive, `doc-container`'s ROUTES containers for the document
 * pipeline, and each one's header names the other as the boundary it must not
 * cross. So the reconciliation is one-directional and lives here, where both
 * are already in scope:
 *
 *     recovery-acts-on  ⊇  quarantine-destroys
 *
 * A superset is the only safe direction. This job is ADDITIVE — the worst a
 * false positive costs is one refused row (`unrecoverable`, or `textTooShort`),
 * because `recoverDocumentUrl` still refuses every host it has not measured.
 * A false NEGATIVE costs a document, permanently.
 *
 * Pinned by `money1321-recovery-backfill.test.ts`, which asserts the inclusion
 * over a corpus of head shapes rather than over the two constants — the
 * constants live in packages this file cannot change, so the guard has to be
 * about the RELATIONSHIP.
 */
export function bodyIsAWebPage(
  gcsPath: string | null,
  peeled: Buffer,
): boolean {
  // The ROUTING predicate first: it is the one that catches the 9 Acuité pages
  // opening on a bare `<title>` and the BOM-prefixed knrcl.com page.
  const container: DocumentContainer = sniffDocumentContainer(peeled);
  if (container === "html") return true;

  // Then the QUARANTINE's own predicate, so nothing it is willing to destroy is
  // invisible here. The buffer is already peeled; `sniffDocumentBody` peels
  // again, which `stripMultipartEnvelope` makes a no-op.
  return sniffDocumentBody({
    key: gcsPath ?? "",
    size: peeled.length,
    head: peeled,
  }).html;
}
