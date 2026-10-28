/**
 * Pure helpers for "paste sideloading" — detecting media blocks whose URL points
 * somewhere OTHER than our GCS bucket (external http(s) host or inline base64
 * data URL), so the editor can re-upload them to GCS. Kept dependency-free so
 * the detection is unit-tested without the BlockNote editor.
 */

const GCS_PREFIX = "https://storage.googleapis.com/";
const MEDIA_BLOCK_TYPES = new Set(["image", "video", "audio", "file"]);

/**
 * True when a media URL should be re-uploaded to GCS: it is an external
 * `http(s)://` URL (not already on our GCS bucket) or an inline `data:` URL.
 * Our own GCS URLs and relative/blob/empty URLs return false.
 */
export function isExternalMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (url.startsWith(GCS_PREFIX)) return false; // already in our bucket
  return /^https?:\/\//i.test(url) || url.startsWith("data:");
}

export interface MediaBlockLike {
  id: string;
  type: string;
  props?: { url?: string } | Record<string, unknown>;
  children?: MediaBlockLike[];
}

/**
 * Walk a BlockNote document (incl. nested children) and collect every media
 * block whose URL is external — the set the editor must re-upload to GCS.
 */
export function collectExternalMedia(
  blocks: MediaBlockLike[] | null | undefined,
): { id: string; url: string }[] {
  const out: { id: string; url: string }[] = [];
  if (!Array.isArray(blocks)) return out;

  const walk = (bs: MediaBlockLike[]): void => {
    for (const b of bs) {
      const url = (b.props as { url?: string } | undefined)?.url;
      if (MEDIA_BLOCK_TYPES.has(b.type) && isExternalMediaUrl(url)) {
        out.push({ id: b.id, url: url as string });
      }
      if (Array.isArray(b.children) && b.children.length > 0) {
        walk(b.children);
      }
    }
  };
  walk(blocks);
  return out;
}
