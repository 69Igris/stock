/**
 * Cache key generation for the web app.
 *
 * This module is a thin re-export of the single source of truth in
 * `@usemoney/cache` (packages/cache/src/keys.ts). Previously the web app kept
 * its OWN copy of these functions, and that copy never received the
 * cache-key delimiter-collision fix (MONEY-620, task 139): a bare ":" join
 * with no per-segment escaping meant generateCacheKey("m","a:b","c") and
 * generateCacheKey("m","a","b:c") both produced "m:a:b:c:default" — two
 * distinct logical entries aliased to the SAME Redis key (cross-entry data
 * bleed). The web copy is on the LIVE path (lib/cache/wrapper.ts → getCached/
 * setCached → lib/actions/content.ts), so the divergence was a real,
 * shippable bug.
 *
 * Re-exporting the package implementation (which reversibly escapes ":" → "%3A"
 * and "%" → "%25" in every segment) eliminates the divergence permanently:
 * there is now exactly one generateCacheKey/parseCacheKey/generateCachePattern
 * implementation across web + core, and the live content-cache path is
 * collision-safe.
 */

export {
  generateVersionHash,
  generateCacheKey,
  parseCacheKey,
  generateCachePattern,
  sanitizeUserId,
} from "@usemoney/cache";
