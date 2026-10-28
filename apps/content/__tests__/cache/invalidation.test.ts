/**
 * Cache Invalidation Pattern Tests
 *
 * Exercises the REAL pattern logic exported from
 * apps/content/lib/cache/invalidate-web-cache-logic.ts (imported and used by
 * invalidate-web-cache.ts):
 * - TYPE_LISTING_PATTERNS mapping
 * - SLUG_PATTERNS template replacement
 * - ALL_LISTING_PATTERNS aggregation
 * - getListingPatterns / getSlugPattern / getAllSlugPatterns
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_LISTING_PATTERNS,
  getAllSlugPatterns,
  getListingPatterns,
  getSlugPattern,
  SLUG_PATTERNS,
  TYPE_LISTING_PATTERNS,
} from "@/lib/cache/invalidate-web-cache-logic";
// The REAL key builder the web app caches with — not a replica, so a change to
// the key format surfaces here rather than silently unhooking the purge.
import { generateCacheKey } from "@usemoney/core/cache";

// ── Tests ────────────────────────────────────────────────

describe("TYPE_LISTING_PATTERNS", () => {
  it("should have 3 patterns for BLOG", () => {
    assert.strictEqual(TYPE_LISTING_PATTERNS.BLOG.length, 3);
  });

  it("should have 2 patterns for GLOSSARY", () => {
    assert.strictEqual(TYPE_LISTING_PATTERNS.GLOSSARY.length, 2);
  });

  it("should have 1 pattern for NEWSLETTER", () => {
    assert.strictEqual(TYPE_LISTING_PATTERNS.NEWSLETTER.length, 1);
  });

  it("should have 1 pattern for DOCS", () => {
    assert.strictEqual(TYPE_LISTING_PATTERNS.DOCS.length, 1);
  });

  it("should cover 4 content types", () => {
    assert.strictEqual(Object.keys(TYPE_LISTING_PATTERNS).length, 4);
  });

  it("should all contain wildcard patterns", () => {
    for (const patterns of Object.values(TYPE_LISTING_PATTERNS)) {
      for (const p of patterns) {
        assert.ok(p.includes("*"), `Pattern "${p}" should contain wildcard`);
      }
    }
  });

  it("should all start with content: prefix", () => {
    for (const patterns of Object.values(TYPE_LISTING_PATTERNS)) {
      for (const p of patterns) {
        assert.ok(
          p.startsWith("content:"),
          `Pattern "${p}" should start with content:`,
        );
      }
    }
  });
});

describe("ALL_LISTING_PATTERNS", () => {
  it("should include all type-specific patterns", () => {
    const typePatterns = Object.values(TYPE_LISTING_PATTERNS).flat();
    for (const p of typePatterns) {
      assert.ok(ALL_LISTING_PATTERNS.includes(p), `Missing pattern: ${p}`);
    }
  });

  it("should include tags pattern", () => {
    assert.ok(ALL_LISTING_PATTERNS.includes("content:public:tags:*"));
  });

  it("should include search pattern", () => {
    assert.ok(ALL_LISTING_PATTERNS.includes("content-search:public:*"));
  });

  it("should have correct total count", () => {
    // 3 blog + 2 glossary + 1 newsletter + 1 docs + 2 extra = 9
    assert.strictEqual(ALL_LISTING_PATTERNS.length, 9);
  });
});

describe("SLUG_PATTERNS", () => {
  it("should have templates for all 4 content types", () => {
    assert.strictEqual(Object.keys(SLUG_PATTERNS).length, 4);
    assert.ok("BLOG" in SLUG_PATTERNS);
    assert.ok("GLOSSARY" in SLUG_PATTERNS);
    assert.ok("NEWSLETTER" in SLUG_PATTERNS);
    assert.ok("DOCS" in SLUG_PATTERNS);
  });

  it("should all contain {slug} placeholder", () => {
    for (const [type, pattern] of Object.entries(SLUG_PATTERNS)) {
      assert.ok(pattern.includes("{slug}"), `${type} pattern missing {slug}`);
    }
  });

  it("should all end with :*", () => {
    for (const [type, pattern] of Object.entries(SLUG_PATTERNS)) {
      assert.ok(pattern.endsWith(":*"), `${type} pattern should end with :*`);
    }
  });
});

describe("getSlugPattern", () => {
  it("should replace {slug} for BLOG", () => {
    assert.strictEqual(
      getSlugPattern("BLOG", "my-post"),
      "content:public:blog-post-my-post:*",
    );
  });

  it("should replace {slug} for GLOSSARY", () => {
    assert.strictEqual(
      getSlugPattern("GLOSSARY", "stock-market"),
      "content:public:glossary-term-stock-market:*",
    );
  });

  it("should replace {slug} for NEWSLETTER", () => {
    assert.strictEqual(
      getSlugPattern("NEWSLETTER", "weekly-update"),
      "content:public:newsletter-weekly-update:*",
    );
  });

  it("should replace {slug} for DOCS", () => {
    assert.strictEqual(
      getSlugPattern("DOCS", "getting-started"),
      "content:public:doc-getting-started:*",
    );
  });

  it("should return empty string for unknown type", () => {
    assert.strictEqual(getSlugPattern("UNKNOWN", "test"), "");
  });
});

describe("getAllSlugPatterns", () => {
  it("should return 4 patterns for any slug", () => {
    const patterns = getAllSlugPatterns("test");
    assert.strictEqual(patterns.length, 4);
  });

  it("should replace slug in all patterns", () => {
    const patterns = getAllSlugPatterns("my-slug");
    for (const p of patterns) {
      assert.ok(
        p.includes("my-slug"),
        `Pattern "${p}" should contain "my-slug"`,
      );
      assert.ok(
        !p.includes("{slug}"),
        `Pattern "${p}" should not contain {slug}`,
      );
    }
  });
});

describe("getListingPatterns", () => {
  it("should return type-specific patterns + common for known type", () => {
    const patterns = getListingPatterns("BLOG");
    assert.strictEqual(patterns.length, 5); // 3 blog + tags + search
    assert.ok(patterns.includes("content:public:blog-posts:*"));
    assert.ok(patterns.includes("content:public:tags:*"));
  });

  it("should return ALL_LISTING_PATTERNS for unknown type", () => {
    const patterns = getListingPatterns("UNKNOWN");
    assert.deepStrictEqual(patterns, ALL_LISTING_PATTERNS);
  });

  it("should return ALL_LISTING_PATTERNS when no type specified", () => {
    const patterns = getListingPatterns();
    assert.deepStrictEqual(patterns, ALL_LISTING_PATTERNS);
  });

  it("should return fewer patterns for NEWSLETTER vs all", () => {
    const specific = getListingPatterns("NEWSLETTER");
    const all = getListingPatterns();
    assert.ok(specific.length < all.length);
  });
});

/**
 * The patterns above are only correct relative to the keys the WEB app writes,
 * and nothing else in this suite looks at a real key — every other case
 * compares strings to strings.
 *
 * That gap matters now that /help's glossary is cached for 30 days instead of
 * 10 minutes. A TTL that long is only safe because a publish purges the entry;
 * if the pattern misses, the purge is a no-op and /help serves a month-old
 * glossary. Nothing errors, so the failure is invisible until someone notices
 * a term they added never appeared.
 *
 * These build the key with the REAL `generateCacheKey` rather than a literal,
 * so a change to the key format fails here instead of silently unhooking the
 * purge.
 */
describe("GLOSSARY patterns actually match the key the web app writes", () => {
  /** Redis glob → RegExp. Only `*` appears in these patterns. */
  const matches = (pattern: string, key: string) =>
    new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`).test(key);

  function escapeRe(s: string) {
    return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }

  // getGlossaryTermsForHelp caches with NO filters, so the version segment is
  // the literal "default".
  const helpKey = generateCacheKey("content", "public", "help-glossary");

  it("the real key carries a trailing version segment", () => {
    assert.equal(helpKey, "content:public:help-glossary:default");
  });

  it("[regression] a GLOSSARY mutation purges the help-glossary key", () => {
    const patterns = getListingPatterns("GLOSSARY");
    assert.ok(
      patterns.some((p) => matches(p, helpKey)),
      `no GLOSSARY listing pattern matches ${helpKey} — /help would keep serving a stale glossary for the full 30-day TTL. Patterns: ${patterns.join(", ")}`,
    );
  });

  it("[regression] an unknown contentType still purges it", () => {
    // Mutations that cannot resolve a type fall back to ALL_LISTING_PATTERNS.
    assert.ok(ALL_LISTING_PATTERNS.some((p) => matches(p, helpKey)));
  });

  it("pins WHY the pattern needs its trailing ':*'", () => {
    // Reads like a typo; it is what spans the version segment. Without it the
    // pattern matches nothing at all.
    assert.equal(matches("content:public:help-glossary", helpKey), false);
    assert.equal(matches("content:public:help-glossary:*", helpKey), true);
  });

  it("the glossary-* pattern does NOT cover it on its own", () => {
    // "help-glossary" does not start with "glossary-", so the sibling pattern
    // is not a fallback — the dedicated entry is doing real work.
    assert.equal(matches("content:public:glossary-*", helpKey), false);
  });
});
