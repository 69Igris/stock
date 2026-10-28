/**
 * Deciding whether an uploaded file is acceptable, and what its mime is
 * (MONEY-1167).
 *
 * The bug: `/documents` accepted a file only when the BROWSER-REPORTED
 * `file.type` appeared in a hard-coded allowlist —
 *
 *   files.filter((f) => ACCEPTED_TYPES.includes(f.type))
 *   if (valid.length === 0) return;      // silent
 *
 * — and the server's own gate keyed off the same `file.type`. Browsers do not
 * agree on that value: `.csv` reports `text/csv` on some platforms, an empty
 * string on macOS, and `application/vnd.ms-excel` on Windows. An empty string
 * misses the allowlist, so the file was dropped on the client with NO error at
 * all, and would have been rejected by the server too.
 *
 * The file extension is the fallback the browser cannot get wrong, because it
 * comes from the name the user chose. This module is the single place that
 * decision lives, so the client and the server action cannot disagree about
 * what is uploadable.
 *
 * Lives outside `lib/actions/documents.ts` because that file is `"use server"`,
 * where every export must be an async function.
 */

/** Canonical mime types the vault stores, and the file family each maps to. */
export const ACCEPTED_MIME_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "IMAGE",
  "image/jpeg": "IMAGE",
  "image/webp": "IMAGE",
  "text/csv": "CSV",
  "application/vnd.ms-excel": "SPREADSHEET",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    "SPREADSHEET",
};

/**
 * Extension → canonical mime. The escape hatch for browsers that report an
 * empty or platform-specific `file.type`.
 */
export const EXTENSION_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  csv: "text/csv",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Extensions listed on the file picker, so the dialog shows what we accept. */
export const ACCEPT_ATTRIBUTE = [
  ...Object.keys(ACCEPTED_MIME_TYPES),
  ...Object.keys(EXTENSION_TO_MIME).map((e) => `.${e}`),
].join(",");

/** Lowercase extension of a file name, without the dot. "" when there is none. */
export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

/**
 * The mime we should treat this file as, or `null` when it is genuinely not a
 * supported type.
 *
 * Trusts a recognised `file.type` first, then falls back to the extension.
 * A file whose reported type is unrecognised but whose extension IS known
 * resolves to the extension's mime — that is the whole point: `report.csv`
 * with `type: ""` is still a CSV.
 */
export function resolveUploadMimeType(file: {
  name: string;
  type: string;
}): string | null {
  if (file.type && ACCEPTED_MIME_TYPES[file.type]) return file.type;
  const byExtension = EXTENSION_TO_MIME[fileExtension(file.name)];
  return byExtension ?? null;
}

export interface AcceptedUpload<F> {
  file: F;
  /** The mime to send to the server — may differ from the browser's guess. */
  mimeType: string;
}

export interface RejectedUpload {
  name: string;
  reason: string;
}

export interface UploadPartition<F> {
  accepted: AcceptedUpload<F>[];
  rejected: RejectedUpload[];
}

/**
 * Split a selection into what we will upload and what we will not, WITH a
 * reason for each rejection.
 *
 * Returning the rejections is the point. The previous code discarded them and
 * returned early, so a user whose file was dropped saw nothing happen at all —
 * indistinguishable from a broken button.
 */
export function partitionUploadFiles<F extends { name: string; type: string }>(
  files: F[],
  maxFiles: number
): UploadPartition<F> {
  const accepted: AcceptedUpload<F>[] = [];
  const rejected: RejectedUpload[] = [];

  for (const file of files) {
    const mimeType = resolveUploadMimeType(file);
    if (!mimeType) {
      const ext = fileExtension(file.name);
      rejected.push({
        name: file.name,
        reason: ext
          ? `.${ext} files are not supported`
          : "unrecognised file type",
      });
      continue;
    }
    if (accepted.length >= maxFiles) {
      rejected.push({
        name: file.name,
        reason: `only ${maxFiles} files can be uploaded at once`,
      });
      continue;
    }
    accepted.push({ file, mimeType });
  }

  return { accepted, rejected };
}

/** One human-readable line summarising why files were dropped. */
export function describeRejections(rejected: RejectedUpload[]): string {
  if (rejected.length === 0) return "";
  if (rejected.length === 1) {
    return `${rejected[0].name} was not uploaded — ${rejected[0].reason}.`;
  }
  return `${rejected.length} files were not uploaded — ${rejected
    .map((r) => `${r.name} (${r.reason})`)
    .join(", ")}.`;
}
