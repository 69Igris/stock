/**
 * Shared Open Graph / social-card image resolution for content pages
 * (blog, newsletter, glossary, docs detail pages).
 *
 * OG and Twitter image URLs MUST be absolute — relative paths are not
 * reliably resolved by crawlers (Slack, WhatsApp, X, LinkedIn, etc.), even
 * though Next.js `metadataBase` resolves them for first-party rendering.
 * This helper always returns an absolute URL.
 */

// Site base URL (no trailing slash). Mirrors the root layout `metadataBase`.
const SITE_URL = (
  process.env.NEXT_PUBLIC_APP_URL || "https://usemoney.ai"
).replace(/\/+$/, "");

// The site-wide default OG card, shipped at apps/web/public/og-website.png and
// used by the root layout. Final fallback when a post has no image of its own.
export const DEFAULT_OG_IMAGE = "/og-website.png";

/** Standard OG image dimensions (1.91:1) used across all content cards. */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/**
 * Turn a relative or absolute path into an absolute URL.
 * Already-absolute (http/https or protocol-relative) URLs pass through
 * unchanged; everything else is joined onto the site base URL.
 */
export function toAbsoluteUrl(url: string): string {
  const trimmed = url.trim();
  if (/^(https?:)?\/\//i.test(trimmed)) return trimmed;
  return `${SITE_URL}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
}

/** Minimal shape needed to resolve a content image — structurally satisfied
 * by `Post` and by the glossary term detail. */
export interface OgImageSource {
  metadataImageUrl?: string | null;
  featureImage?: string | null;
}

/**
 * Resolve the OG/meta image for a content post using the fallback chain:
 *   (a) the post's explicit SEO image (`metadataImageUrl`) if non-empty, else
 *   (b) the post's `featureImage`, else
 *   (c) the site default OG image.
 * Always returns an absolute URL.
 */
export function resolveOgImage(post: OgImageSource): string {
  const explicit = post.metadataImageUrl?.trim();
  if (explicit) return toAbsoluteUrl(explicit);

  const feature = post.featureImage?.trim();
  if (feature) return toAbsoluteUrl(feature);

  return toAbsoluteUrl(DEFAULT_OG_IMAGE);
}

/**
 * Build the OpenGraph `images` array entry for a content post.
 * Convenience wrapper around {@link resolveOgImage} that returns the full
 * object shape Next.js expects.
 */
export function resolveOgImageObject(
  post: OgImageSource,
  alt: string
): { url: string; width: number; height: number; alt: string } {
  return {
    url: resolveOgImage(post),
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    alt,
  };
}
