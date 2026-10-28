/**
 * Client-safe href builder for `/discover/indices/[slug]` — MONEY-1204
 * (P14 / 14d.6).
 *
 * ## Why this is not `normalizeIndexSlug` from `@usemoney/core/market-data`
 *
 * That is the source of truth and it lives in a barrel that also re-exports the
 * Yahoo API clients, the XLSX-based feed parsers and the whole instrument
 * pipeline. Importing it from a `"use client"` component to slugify a string
 * pulls that graph into the browser bundle. This module is the bundle boundary:
 * seven lines, no imports, and the ONE transformation the route needs.
 *
 * The transformation itself is not invented here — it mirrors `toIndexSlug` in
 * `workers/src/processors/bhavcopy-sync-logic.ts`, which WRITES
 * `IndexClose.indexSlug`, and `normalizeIndexSlug` in
 * `packages/core/src/market-data/discover-section-logic.ts`, which reads it.
 * Three copies of a lowercase-and-hyphenate is a drift risk, so the route test
 * (`__tests__/proxy/discover-routes.test.ts`) pins the writer's own documented
 * examples against THIS copy. The route also resolves aliases server-side, so a
 * near-miss here degrades to a working page rather than a 404.
 */

/** "Nifty 50" / "NIFTY BANK" → "nifty-50" / "nifty-bank". */
export function toIndexRouteSlug(name: string): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Href for an index's detail page, or null when the name yields no slug.
 *
 * Null rather than `/discover/indices/` — a link to a route that cannot resolve
 * is worse than no link, and the caller renders the card unwrapped.
 */
export function indexDetailHref(name: string): string | null {
  const slug = toIndexRouteSlug(name);
  return slug === "" ? null : `/discover/indices/${slug}`;
}
