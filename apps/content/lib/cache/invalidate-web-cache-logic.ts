/**
 * Pure, Redis-free helpers for web-content cache invalidation
 * (`invalidate-web-cache.ts`).
 *
 * The cache-key pattern maps and the pattern-selection logic were previously
 * inlined inside the `invalidateWebContentCache` function body (which requires
 * a live Redis connection), so they could only be unit-tested via an inline
 * re-implementation. They are extracted here as pure exported functions so the
 * REAL pattern logic can be tested directly. `invalidate-web-cache.ts` imports
 * and calls these.
 *
 * @see apps/content/__tests__/cache/invalidation.test.ts
 */

/**
 * Per-content-type listing cache key patterns (the listing/index pages that
 * must be purged whenever ANY item of that type changes).
 */
export const TYPE_LISTING_PATTERNS: Record<string, string[]> = {
  BLOG: [
    "content:public:blog-posts:*",
    "content:public:featured-blog-*",
    "content:public:latest-blog-*",
  ],
  GLOSSARY: ["content:public:glossary-*", "content:public:help-glossary:*"],
  NEWSLETTER: ["content:public:newsletters:*"],
  DOCS: ["content:public:docs:*"],
};

/**
 * Cross-type listing patterns appended to every listing invalidation (tags and
 * the public content-search index are shared across all content types).
 */
export const COMMON_LISTING_PATTERNS: string[] = [
  "content:public:tags:*",
  "content-search:public:*",
];

/**
 * Every listing pattern across all content types plus the common ones. Used
 * when the content type is unknown so nothing is missed.
 */
export const ALL_LISTING_PATTERNS: string[] = [
  ...Object.values(TYPE_LISTING_PATTERNS).flat(),
  ...COMMON_LISTING_PATTERNS,
];

/**
 * Per-content-type single-item cache key templates. `{slug}` is replaced with
 * the actual slug at call time.
 */
export const SLUG_PATTERNS: Record<string, string> = {
  BLOG: "content:public:blog-post-{slug}:*",
  GLOSSARY: "content:public:glossary-term-{slug}:*",
  NEWSLETTER: "content:public:newsletter-{slug}:*",
  DOCS: "content:public:doc-{slug}:*",
};

/**
 * Select the listing patterns to purge for a mutation. When the content type is
 * known and recognised, returns that type's listing patterns plus the common
 * ones; otherwise returns the full set across all types.
 */
export function getListingPatterns(contentType?: string): string[] {
  if (contentType && TYPE_LISTING_PATTERNS[contentType]) {
    return [...TYPE_LISTING_PATTERNS[contentType], ...COMMON_LISTING_PATTERNS];
  }
  return ALL_LISTING_PATTERNS;
}

/**
 * Resolve the single-item cache key pattern for a known content type by
 * substituting the slug. Returns `""` for unknown content types (no specific
 * key to purge).
 */
export function getSlugPattern(contentType: string, slug: string): string {
  return SLUG_PATTERNS[contentType]?.replace("{slug}", slug) ?? "";
}

/**
 * Resolve the single-item cache key pattern for every content type when the
 * type is unknown — substitutes the slug into each template.
 */
export function getAllSlugPatterns(slug: string): string[] {
  return Object.values(SLUG_PATTERNS).map((p) => p.replace("{slug}", slug));
}
