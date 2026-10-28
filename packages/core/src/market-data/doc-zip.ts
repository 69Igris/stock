/**
 * "The stored object is a ZIP — which member is the DOCUMENT?" — MONEY-1319.
 *
 * ## Why this exists
 *
 * `doc-container.ts` answers *what container are these bytes in*. It found 179
 * `stock_documents` objects on prod that are ZIPs from
 * `nsearchives.nseindia.com` stored under a `.pdf` key, every one holding a
 * real document. Re-typing their `mimeType` stops the extract lane wasting
 * Document AI round trips on them, but re-typing alone LOSES them: a row typed
 * `application/zip` that nothing can open is a row that will never produce
 * text. This module is the other half — the lane opens the ZIP and extracts
 * what is inside.
 *
 * ## THE SIDECAR IS THE REASON THIS IS NOT `entries[0]`
 *
 * Two prod objects were opened by hand on 2026-09-02:
 *
 *     ACCELYA-annual_report-FY2023.pdf   ->  AR_23907_ACCELYA_2022_2023_…pdf   1,752,887 B
 *     AERON-announcement-2026.pdf        ->  RESIGNATION_LETTER_CCP_1.pdf         88,706 B
 *                                            ROID_…_WebXMLFile_….xml           (NSE sidecar)
 *
 * NSE bundles an XML sidecar beside the filing. "Open the ZIP and take the
 * first entry" therefore returns an XML metadata file for announcements — which
 * an extractor cannot read, so the row fails exactly as it does today while
 * looking like it was handled. `bhavcopy.ts#unzipSingleEntry` documents the
 * same trap from the other side ("the NSE file is always exactly one entry" —
 * true of the bhavcopy, false here), and `parseNcdexArchive` already selects
 * BY NAME for it.
 *
 * ## Selection is by BYTES, not by the member's name
 *
 * A name-keyed rule (`/\.pdf$/i`) would work on both objects above and is the
 * obvious thing to write. It is also the rule this whole ticket exists to
 * punish: the OUTER object is named `.pdf` and is a ZIP. An upstream that names
 * its sidecar `.pdf`, or its report `.PDF.tmp`, or omits the extension, breaks
 * a name rule silently and in the direction that stores the wrong document.
 *
 * So every candidate member is sniffed with {@link sniffDocumentContainer} —
 * the SAME predicate that decided the outer object — and only a member whose
 * bytes are a PDF is eligible. The NSE sidecar begins `<?xml`, which sniffs
 * `unknown` (the HTML rule requires an html/head/body/script/meta/title tag),
 * so it is excluded by the bytes rather than by a list of names to avoid.
 *
 * ## Nothing eligible is `null`, never a guess
 *
 * When no member's bytes are a PDF this returns `null` and the caller reports
 * it. Handing the largest remaining member to a PDF extractor instead would
 * turn "we do not know what is in here" into a FAILED row indistinguishable
 * from a corrupt PDF — and this repo has already paid for a precise rule with
 * no honest catch-all.
 *
 * PURE: no I/O, no clock. Imports two sibling leaves. Import by SUBPATH
 * (`@usemoney/core/market-data/doc-zip`), never through the market-data barrel.
 */

import { unzipEntries, type ZipEntry } from "./zip-entries";
import {
  sniffDocumentContainer,
  mimeTypeForContainer,
  type DocumentContainer,
} from "./doc-container";

/** The member of a ZIP that carries the document. */
export interface ZipDocumentMember {
  /** The member's name inside the archive, for the log line and the census. */
  name: string;
  /** The member's DECOMPRESSED bytes. */
  bytes: Buffer;
  /** What {@link sniffDocumentContainer} said about those bytes. Always `pdf` today. */
  container: DocumentContainer;
  /** The media type the extractor should be told, derived from `container`. */
  mimeType: string;
  /** How many members the archive held, incl. the ones ruled out. */
  memberCount: number;
}

/**
 * Members that are not candidates at all, before anything is sniffed.
 *
 * Directory entries and zero-length members carry no bytes to judge.
 * `__MACOSX/` and dot-prefixed basenames are resource forks a macOS-authored
 * archive carries beside every real file — they are small, they are NOT
 * documents, and on some archives there is one per member, which would double
 * the sniffing for nothing.
 */
function isCandidate(entry: ZipEntry): boolean {
  if (entry.name.endsWith("/")) return false;
  if (entry.bytes.length === 0) return false;
  if (entry.name.startsWith("__MACOSX/")) return false;
  const base = entry.name.split("/").pop() ?? entry.name;
  if (base.startsWith(".")) return false;
  return true;
}

/**
 * Pick the document out of an archive's already-decompressed members.
 *
 * Eligibility is "these bytes are a PDF". Among the eligible, the LARGEST wins,
 * with the member name as a deterministic tie-break so two identically-sized
 * members cannot make the choice depend on archive ordering.
 *
 * Largest-wins is a real decision and not a shrug: where an NSE bundle carries
 * more than one PDF the extra ones are cover letters and acknowledgement
 * slips — the filing is the big one. The tie-break matters more than the size
 * rule does, because a non-deterministic selection is a row that extracts
 * different text on a re-run.
 *
 * Separated from {@link openDocumentZip} so the rule is testable against a
 * synthetic member list without building a real archive.
 */
export function selectZipDocumentMember(
  entries: readonly ZipEntry[],
): ZipDocumentMember | null {
  let best: { entry: ZipEntry; container: DocumentContainer } | null = null;

  for (const entry of entries) {
    if (!isCandidate(entry)) continue;
    const container = sniffDocumentContainer(entry.bytes);
    if (container !== "pdf") continue;
    if (
      best === null ||
      entry.bytes.length > best.entry.bytes.length ||
      (entry.bytes.length === best.entry.bytes.length &&
        entry.name < best.entry.name)
    ) {
      best = { entry, container };
    }
  }

  if (!best) return null;
  return {
    name: best.entry.name,
    bytes: best.entry.bytes,
    container: best.container,
    mimeType: mimeTypeForContainer(best.container),
    memberCount: entries.length,
  };
}

/**
 * Open a stored object that {@link sniffDocumentContainer} called a `zip` and
 * return the member carrying the document.
 *
 * `null` for three distinct situations, all of which mean the same thing to the
 * caller — there is nothing here to extract:
 *
 *   - the bytes are not a ZIP at all (the caller sniffed first, so this is a
 *     belt-and-braces re-check rather than the expected path);
 *   - the archive uses a compression method the walker does not implement, or
 *     is truncated (`unzipEntries` returns `null`);
 *   - no member's bytes are a PDF.
 *
 * They are deliberately NOT distinguished in the return type. A caller that
 * could tell them apart would have to decide something different for each, and
 * there is nothing different to decide: every one of them leaves the row with
 * no text.
 */
export function openDocumentZip(body: Buffer): ZipDocumentMember | null {
  if (!Buffer.isBuffer(body) || body.length === 0) return null;
  if (sniffDocumentContainer(body) !== "zip") return null;
  const entries = unzipEntries(body);
  if (!entries) return null;
  return selectZipDocumentMember(entries);
}
