/**
 * Signed URL Generation for Secure Content Delivery
 *
 * Generates time-limited signed URLs for accessing protected content.
 * URLs expire after a configurable TTL to prevent sharing/downloading.
 */

import { getBucket } from "./gcp-client";
import { geminiLogger as logger } from "@usemoney/logger";

/**
 * Signed URL configuration options
 */
export interface SignedUrlOptions {
  /** Time-to-live in seconds (default: 15 minutes) */
  expiresIn?: number;
  /** Content type for the response */
  contentType?: string;
  /** Content disposition (inline or attachment) */
  contentDisposition?: "inline" | "attachment";
  /**
   * Filename the browser should save the download as (MONEY-1074). Defaults to
   * the storage-key leaf, which for user uploads is the "{timestamp}-{random}-…"
   * GCS key — a cross-origin signed URL ignores the client's `a.download`, so
   * without this the download is named after the key (and re-uploading that file
   * poisons the doc title). Pass the human `fileName` here.
   */
  downloadFilename?: string;
  /** Custom response headers */
  responseHeaders?: Record<string, string>;
}

/**
 * Build a safe Content-Disposition header value (RFC 6266). The ASCII `filename`
 * fallback is sanitised (quotes/backslashes/CR/LF and non-ASCII stripped) so it
 * can never break the header, and a `filename*=UTF-8''…` param carries the exact
 * (possibly non-ASCII) name for modern browsers. Pure + exported for tests.
 */
export function buildContentDisposition(
  disposition: "inline" | "attachment",
  filename: string
): string {
  const raw = (filename || "file").replace(/[\r\n]+/g, " ").trim() || "file";
  const asciiFallback =
    raw
      .replace(/["\\]/g, "")
      // Strip anything outside printable ASCII (incl. control chars).
      // eslint-disable-next-line no-control-regex
      .replace(/[^\x20-\x7E]/g, "_")
      .trim() || "file";
  const encoded = encodeURIComponent(raw);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Default TTL values for different content types
 */
export const DEFAULT_TTL = {
  video: 15 * 60, // 15 minutes
  audio: 30 * 60, // 30 minutes
  document: 10 * 60, // 10 minutes
  image: 60 * 60, // 1 hour
  default: 15 * 60, // 15 minutes
} as const;

/**
 * Generate a signed URL for secure content access
 *
 * @param filePath - Path within the bucket
 * @param options - Signed URL options
 * @returns Signed URL with expiration
 */
export async function generateSignedUrl(
  filePath: string,
  options: SignedUrlOptions = {}
): Promise<string> {
  const bucket = getBucket();
  const file = bucket.file(filePath);

  const {
    expiresIn = DEFAULT_TTL.default,
    contentDisposition = "inline",
    downloadFilename,
  } = options;

  try {
    const [signedUrl] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + expiresIn * 1000,
      // Prefer the caller-supplied human filename; fall back to the storage-key
      // leaf. Safely encoded so a key/odd name can't break the header.
      responseDisposition: buildContentDisposition(
        contentDisposition,
        downloadFilename ?? getFilename(filePath)
      ),
    });

    logger.debug(
      { filePath, expiresIn, contentDisposition },
      "Generated signed URL"
    );

    return signedUrl;
  } catch (error) {
    logger.error({ error, filePath }, "Failed to generate signed URL");
    throw new Error("Failed to generate secure link - please try again");
  }
}

/**
 * Generate signed URLs for video streaming (HLS segments)
 *
 * @param videoPath - Base path of the video (e.g., "lessons/123/video")
 * @param userId - User ID for watermarking/tracking
 * @returns Object with signed URLs for manifest and segments
 */
export async function generateVideoStreamingUrls(
  videoPath: string,
  userId: string
): Promise<{
  manifestUrl: string;
  segmentBaseUrl: string;
  expiresAt: Date;
}> {
  const expiresIn = DEFAULT_TTL.video;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  // Generate signed URL for HLS manifest
  const manifestUrl = await generateSignedUrl(`${videoPath}/playlist.m3u8`, {
    expiresIn,
    contentType: "application/vnd.apple.mpegurl",
  });

  // For HLS segments, we'll use a proxy endpoint that generates
  // signed URLs on-demand to prevent URL harvesting
  const segmentBaseUrl = `/api/storage/stream/${encodeURIComponent(videoPath)}?user=${userId}`;

  logger.info(
    { videoPath, userId, expiresAt },
    "Generated video streaming URLs"
  );

  return {
    manifestUrl,
    segmentBaseUrl,
    expiresAt,
  };
}

/**
 * Generate a signed URL for audio streaming
 *
 * @param audioPath - Path to the audio file
 * @param userId - User ID for tracking
 * @returns Signed URL with expiration info
 */
export async function generateAudioStreamingUrl(
  audioPath: string,
  userId: string
): Promise<{
  url: string;
  expiresAt: Date;
}> {
  const expiresIn = DEFAULT_TTL.audio;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  const url = await generateSignedUrl(audioPath, {
    expiresIn,
    contentType: "audio/mpeg",
  });

  logger.info(
    { audioPath, userId, expiresAt },
    "Generated audio streaming URL"
  );

  return { url, expiresAt };
}

/**
 * Generate a signed URL for document viewing
 *
 * @param documentPath - Path to the document
 * @param userId - User ID for tracking
 * @returns Signed URL with expiration info
 */
export async function generateDocumentUrl(
  documentPath: string,
  userId: string
): Promise<{
  url: string;
  expiresAt: Date;
}> {
  const expiresIn = DEFAULT_TTL.document;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  // Determine content type from extension
  const ext = documentPath.split(".").pop()?.toLowerCase();
  const contentTypeMap: Record<string, string> = {
    pdf: "application/pdf",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ppt: "application/vnd.ms-powerpoint",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
  };

  const contentType = contentTypeMap[ext || ""] || "application/octet-stream";

  const url = await generateSignedUrl(documentPath, {
    expiresIn,
    contentType,
    // Force inline display to prevent download dialog
    contentDisposition: "inline",
  });

  logger.info(
    { documentPath, userId, expiresAt, contentType },
    "Generated document URL"
  );

  return { url, expiresAt };
}

/**
 * Generate upload URL for admin content uploads
 *
 * @param filePath - Destination path in bucket
 * @param contentType - MIME type of the file
 * @param maxSize - Maximum file size in bytes (default: 100MB)
 * @returns Signed upload URL
 */
export async function generateUploadUrl(
  filePath: string,
  contentType: string,
  maxSize: number = 100 * 1024 * 1024
): Promise<{
  uploadUrl: string;
  expiresAt: Date;
}> {
  const bucket = getBucket();
  const file = bucket.file(filePath);

  const expiresIn = 30 * 60; // 30 minutes for upload
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  try {
    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + expiresIn * 1000,
      contentType,
      extensionHeaders: {
        "x-goog-content-length-range": `0,${maxSize}`,
      },
    });

    logger.info(
      { filePath, contentType, maxSize, expiresAt },
      "Generated upload URL"
    );

    return { uploadUrl, expiresAt };
  } catch (error) {
    logger.error({ error, filePath }, "Failed to generate upload URL");
    throw new Error("Failed to prepare upload - please try again");
  }
}

/**
 * Validate a signed URL hasn't expired
 *
 * @param url - The signed URL to validate
 * @returns True if URL is still valid
 */
export function isSignedUrlValid(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const expiresParam = urlObj.searchParams.get("X-Goog-Expires");
    const dateParam = urlObj.searchParams.get("X-Goog-Date");

    if (!expiresParam || !dateParam) {
      return false;
    }

    // Parse the date from YYYYMMDDTHHMMSSZ format
    const year = parseInt(dateParam.substring(0, 4));
    const month = parseInt(dateParam.substring(4, 6)) - 1;
    const day = parseInt(dateParam.substring(6, 8));
    const hour = parseInt(dateParam.substring(9, 11));
    const minute = parseInt(dateParam.substring(11, 13));
    const second = parseInt(dateParam.substring(13, 15));

    const signedDate = new Date(
      Date.UTC(year, month, day, hour, minute, second)
    );
    const expiresInSeconds = parseInt(expiresParam);
    const expiresAt = new Date(signedDate.getTime() + expiresInSeconds * 1000);

    return expiresAt.getTime() > Date.now();
  } catch {
    return false;
  }
}

/**
 * Extract filename from path. Exported for unit tests (used internally by
 * generateSignedUrl's content-disposition filename).
 */
export function getFilename(filePath: string): string {
  return filePath.split("/").pop() || "file";
}

/**
 * Get content type TTL based on file extension
 */
export function getTTLForContentType(filePath: string): number {
  const ext = filePath.split(".").pop()?.toLowerCase();

  switch (ext) {
    case "mp4":
    case "webm":
    case "m3u8":
    case "ts":
      return DEFAULT_TTL.video;
    case "mp3":
    case "wav":
    case "m4a":
      return DEFAULT_TTL.audio;
    case "pdf":
    case "pptx":
    case "ppt":
      return DEFAULT_TTL.document;
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
      return DEFAULT_TTL.image;
    default:
      return DEFAULT_TTL.default;
  }
}
