/**
 * Naming and content hints for a document imported from a URL (MONEY-1166).
 *
 * This lives outside `lib/actions/documents.ts` because that file is
 * `"use server"`, where every export must be an async function — a pure helper
 * cannot be exported from it, and this logic is worth unit-testing directly.
 *
 * The bug this replaces: the import action named every URL document after its
 * HOSTNAME and hard-coded a `.html` extension with a `text/html` mime, so
 *
 *   https://www.tcs.com/.../annual-report-2025-2026.pdf
 *
 * became a row titled `www.tcs.com`, file name `www.tcs.com.html`. Two
 * consequences: every document fetched from one host collided on a single
 * name, and the row contradicted itself from creation — `documentType: PDF`
 * alongside a `.html` file name and a `text/html` mime.
 *
 * The final path segment is the closest thing a URL offers to a file name, so
 * that is the title. The hostname survives only as the fallback for URLs with
 * no path (`https://example.com/`), which is the one case it was ever right.
 *
 * These are HINTS, derived before anything is fetched. The worker still
 * overwrites `mimeType` and `documentType` from the response's real
 * content-type once the bytes arrive — the point here is that the row is
 * self-consistent and recognisable in the meantime, rather than actively wrong.
 */

/** The subset of `DocumentFileType` a URL extension can imply. */
export type UrlFileType = "PDF" | "IMAGE" | "CSV" | "SPREADSHEET";

export interface UrlDocumentIdentity {
  /** Human-facing name, shown on the document card. */
  title: string;
  /** Stored file name, always carrying an extension. */
  fileName: string;
  /** Best-guess mime, corrected by the worker after the fetch. */
  mimeType: string;
  /** Best-guess `DocumentFileType`, corrected by the worker after the fetch. */
  fileType: UrlFileType;
}

/**
 * Extension → content hints. Keys are lowercase and carry no leading dot.
 * Deliberately mirrors the upload path's ALLOWED_MIME_TYPES so a document
 * imported by URL and the same file uploaded by hand end up typed identically.
 */
const EXTENSION_HINTS: Record<
  string,
  { mimeType: string; fileType: UrlFileType }
> = {
  pdf: { mimeType: "application/pdf", fileType: "PDF" },
  csv: { mimeType: "text/csv", fileType: "CSV" },
  png: { mimeType: "image/png", fileType: "IMAGE" },
  jpg: { mimeType: "image/jpeg", fileType: "IMAGE" },
  jpeg: { mimeType: "image/jpeg", fileType: "IMAGE" },
  webp: { mimeType: "image/webp", fileType: "IMAGE" },
  xls: { mimeType: "application/vnd.ms-excel", fileType: "SPREADSHEET" },
  xlsx: {
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileType: "SPREADSHEET",
  },
};

/**
 * An unrecognised extension (or none at all) means we are most likely fetching
 * a web page. `DocumentFileType` has no HTML member — PDF remains the fallback,
 * as before, and the worker corrects it once it sees the content-type.
 */
const HTML_FALLBACK = {
  mimeType: "text/html",
  fileType: "PDF" as UrlFileType,
};

export function deriveUrlDocumentIdentity(rawUrl: string): UrlDocumentIdentity {
  let lastSegment = "";
  let hostname = "";

  try {
    const url = new URL(rawUrl);
    hostname = url.hostname;
    const segments = url.pathname.split("/").filter(Boolean);
    const raw = segments.length > 0 ? segments[segments.length - 1] : "";
    // A percent-encoded segment ("Annual%20Report.pdf") should read as the name
    // a human would recognise. Malformed encoding must not sink the import.
    try {
      lastSegment = decodeURIComponent(raw);
    } catch {
      lastSegment = raw;
    }
  } catch {
    // The action validates the URL before calling this, so a parse failure here
    // means a caller skipped validation. Degrade rather than throw.
    return {
      title: "document",
      fileName: "document.html",
      ...HTML_FALLBACK,
    };
  }

  const dotIndex = lastSegment.lastIndexOf(".");
  const extension =
    dotIndex > 0 ? lastSegment.slice(dotIndex + 1).toLowerCase() : "";
  const hint = EXTENSION_HINTS[extension];

  // Path-less URLs are the only case where the hostname is the best name.
  const title = lastSegment || hostname || "document";

  return {
    title,
    // Only append `.html` when the name does not already carry an extension,
    // so `report.pdf` never becomes `report.pdf.html`.
    fileName: extension ? title : `${title}.html`,
    mimeType: hint ? hint.mimeType : HTML_FALLBACK.mimeType,
    fileType: hint ? hint.fileType : HTML_FALLBACK.fileType,
  };
}
