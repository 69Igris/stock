/* =====================================================================
   Sector slug canonicalisation  (MONEY-1092)
   ---------------------------------------------------------------------
   The sector view is deep-linkable as `/discover/markets?sector=<slug>`,
   so a sector name has to survive a round trip through a URL.

   The rule this module enforces is: NORMALIZE on write, RESOLVE BY
   LOOKUP on read. Never reverse-transform a slug back into a name.

   That distinction is the whole point. The old route did

       decodeURIComponent(params.sector).replace(/-/g, " ")

   (`app/discover/sectors/[sector]/page.tsx`), which is lossy the moment a
   sector legitimately contains a hyphen: "Consumer Non-Durables" slugs to
   `consumer-non-durables` and reverses to "consumer non durables", a
   sector that does not exist. Any scheme that tries to invert the
   transform has this bug for some input. Looking the slug up against the
   live bucket list does not: the canonical display name comes back from
   the data, so casing, ampersands, slashes and hyphens are all preserved
   exactly as stored.

   The one correct half of the old code was `resolveSector`'s comparison
   (`lib/actions/sectors.ts`), which normalised BOTH sides before matching.
   This module is that idea, extracted and made the only path.
   ===================================================================== */

/**
 * Fold a sector name into its URL form.
 *
 * Lowercase, trimmed, whitespace runs collapsed to single hyphens. It is
 * deliberately NOT injective — "Media & Entertainment" and
 * "media-&-entertainment" normalise to the same thing — because it is only
 * ever used as a comparison key, never as something to invert.
 *
 * `encodeURIComponent` is the caller's job (URLSearchParams does it), so
 * "&" and "/" are left intact here: `n/a` percent-encodes to `n%2Fa` in a
 * query VALUE and round-trips fine.
 */
export function normalizeSectorSlug(sector: string): string {
  return sector.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Resolve a slug from the URL back to a canonical sector name, by looking
 * it up among the sectors that actually exist right now.
 *
 * Returns null when nothing matches — an unknown `?sector=` is treated as
 * "no selection", not as an error page. A stale bookmark for a sector that
 * has since been reclassified should quietly show the full heatmap, not a
 * dead end.
 */
export function resolveSectorSlug(
  slug: string | null | undefined,
  available: readonly string[]
): string | null {
  if (!slug) return null;
  const target = normalizeSectorSlug(slug);
  if (!target) return null;
  return available.find((name) => normalizeSectorSlug(name) === target) ?? null;
}

/**
 * True when two sector identifiers refer to the same sector, regardless of
 * which side is a slug and which is a display name.
 */
export function isSameSector(a: string, b: string): boolean {
  return normalizeSectorSlug(a) === normalizeSectorSlug(b);
}
