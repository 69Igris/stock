/**
 * Pure logic for the secure content-streaming route.
 *
 * Extracted from `./route.ts` (which imports Clerk / Prisma / GCS and so can't
 * be imported by a unit test) so the security-critical bits — content-path
 * allowlist + traversal guard, document-ownership parsing, content-type
 * detection, redirect-vs-proxy routing, and Range parsing — are tested against
 * the REAL exported symbols the route calls, not inline copies.
 *
 * `hasFeatureAccess` is re-exported from `@usemoney/core/subscription` so the
 * learning-content subscription gate is exercised through the real function.
 *
 * @see apps/web/__tests__/api/storage-stream.test.ts
 */

export { hasFeatureAccess } from "@usemoney/core/subscription";

// Content type mapping for streaming
export const CONTENT_TYPES: Record<string, string> = {
  // Video
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".mp4": "video/mp4",
  // Audio
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  // Documents
  ".pdf": "application/pdf",
  // Images
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

// Paths that should redirect (short-lived, handled by client)
export const REDIRECT_EXTENSIONS = [".m3u8", ".ts"];

// Paths that should be proxied (keep URLs hidden)
export const PROXY_EXTENSIONS = [
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".svg",
  ".mp4",
];

/**
 * Validate that the path is a valid content path.
 * Must start with lessons/, generated/, or documents/, and contain no path
 * traversal (`..`) or empty segments (`//`).
 */
export function isValidContentPath(path: string): boolean {
  // Must start with lessons/, generated/, or documents/
  if (
    !path.startsWith("lessons/") &&
    !path.startsWith("generated/") &&
    !path.startsWith("documents/")
  ) {
    return false;
  }

  // Prevent path traversal
  if (path.includes("..") || path.includes("//")) {
    return false;
  }

  return true;
}

/**
 * Check if path is a user document (ownership-based auth, no subscription
 * needed).
 */
export function isDocumentPath(path: string): boolean {
  return path.startsWith("documents/");
}

/**
 * Extract userId from document path: documents/{userId}/...
 */
export function extractDocumentUserId(path: string): string | null {
  const parts = path.split("/");
  return parts.length >= 2 ? parts[1] || null : null;
}

/**
 * Get content type from file extension.
 */
export function getContentType(path: string): string {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

/**
 * Check if content should be redirected (vs proxied).
 */
export function shouldRedirect(path: string): boolean {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return REDIRECT_EXTENSIONS.includes(ext);
}

/**
 * Check if content should be proxied.
 */
export function shouldProxy(path: string): boolean {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
  return PROXY_EXTENSIONS.includes(ext);
}

/**
 * Parse an HTTP `Range: bytes=start-end` header into byte bounds. Returns null
 * when there's no header or it isn't a byte range. An open-ended range
 * (`bytes=500-`) clamps to `contentLength - 1`.
 */
export function parseRangeHeader(
  rangeHeader: string | null,
  contentLength: number
): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : contentLength - 1;
  return { start, end };
}
