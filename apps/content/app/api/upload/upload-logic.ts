/**
 * Pure, Next/GCS-free helpers for the file-upload route (`route.ts`).
 *
 * The MIME/size constants and the category / max-size / folder / filename /
 * allowed-type helpers were previously inlined in the route handler module
 * (which also pulls in Clerk `auth()` and `@usemoney/storage`), so they could
 * only be unit-tested via inline copies. They are extracted here so the REAL
 * validation helpers can be tested directly. `route.ts` imports and calls
 * these.
 *
 * @see apps/content/__tests__/api/ai-routes.test.ts
 */

export type FileCategory = "image" | "video" | "audio";

/** Maximum file sizes by category (bytes). */
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
export const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB
export const MAX_AUDIO_SIZE = 50 * 1024 * 1024; // 50MB

/** Allowed upload MIME types. */
export const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
] as const;

export type AllowedType = (typeof ALLOWED_TYPES)[number];

/** Map MIME types to file extensions. */
export const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
};

/** Derive the storage category from a MIME type (defaults to image). */
export function getFileCategory(mimeType: string): FileCategory {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "image";
}

/** Maximum allowed size (bytes) for a given category. */
export function getMaxSize(category: FileCategory): number {
  if (category === "video") return MAX_VIDEO_SIZE;
  if (category === "audio") return MAX_AUDIO_SIZE;
  return MAX_IMAGE_SIZE;
}

/** Destination GCS folder for a given category. */
export function getFolder(category: FileCategory): string {
  if (category === "video") return "content/videos";
  if (category === "audio") return "content/audio";
  return "content/images";
}

/** Whether a MIME type is in the allow-list. */
export function isAllowedType(mimeType: string): boolean {
  return ALLOWED_TYPES.includes(mimeType as AllowedType);
}

/**
 * Generate a unique filename with a timestamp + random suffix. The extension is
 * resolved from the MIME map, falling back to the original name's extension,
 * then `jpg`.
 */
export function generateUniqueFilename(
  originalName: string,
  mimeType: string,
): string {
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 10);
  const extension =
    MIME_TO_EXTENSION[mimeType] || originalName.split(".").pop() || "jpg";
  return `${timestamp}-${randomString}.${extension}`;
}
