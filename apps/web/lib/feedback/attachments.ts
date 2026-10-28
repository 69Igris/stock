/**
 * Feedback attachment rules — pure, shared by the upload server action AND
 * the composer UI (client-side pre-validation), so both enforce the same
 * contract (MONEY-764: the schema always had `images: String[]` "GCS paths",
 * but no upload path or UI ever existed).
 *
 * Security note: `filterOwnedImagePaths` is the IDOR guard. The submit/reply
 * actions accept caller-supplied GCS paths and the thread view MINTS SIGNED
 * URLS for whatever was stored — so a forged path (another user's upload, or
 * any bucket object like learning content) must never reach the DB. Only
 * paths under the caller's own `feedback/{userId}/` prefix survive.
 */

/** Allowed upload MIME types → stored extension. Screenshots, basically. */
export const FEEDBACK_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export const FEEDBACK_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const FEEDBACK_MAX_IMAGES = 3;

export type FeedbackImageCheck =
  | { ok: true; ext: string }
  | { ok: false; error: string };

/** Validate a candidate file's type + size (works on File metadata). */
export function validateFeedbackImage(file: {
  type: string;
  size: number;
}): FeedbackImageCheck {
  const ext = FEEDBACK_IMAGE_TYPES[file.type];
  if (!ext) {
    return { ok: false, error: "Only PNG, JPG or WebP images are supported" };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, error: "That file looks empty" };
  }
  if (file.size > FEEDBACK_IMAGE_MAX_BYTES) {
    return { ok: false, error: "Images must be 5 MB or smaller" };
  }
  return { ok: true, ext };
}

/** The single place the storage layout is defined. */
export function feedbackImagePath(
  userId: string,
  ext: string,
  uuid: string
): string {
  return `feedback/${userId}/${uuid}.${ext}`;
}

/**
 * Keep only attachment paths the caller actually owns (their own
 * `feedback/{userId}/` uploads), drop junk/duplicates, cap the count.
 * Forged or foreign paths are silently dropped — the ticket still submits.
 */
export function filterOwnedImagePaths(
  paths: unknown,
  userId: string
): string[] {
  if (!Array.isArray(paths) || !userId) return [];
  const prefix = `feedback/${userId}/`;
  const seen = new Set<string>();
  const owned: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string") continue;
    if (!p.startsWith(prefix)) continue;
    // No path traversal / nested tricks past the owned prefix.
    if (p.includes("..") || p.length > 256) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    owned.push(p);
    if (owned.length >= FEEDBACK_MAX_IMAGES) break;
  }
  return owned;
}
