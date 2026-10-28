/**
 * SEO Metadata and Structured Data Tests
 *
 * Exercises the REAL SEO utilities exported from
 * packages/core/src/content/seo.ts (re-exported through the `@usemoney/core`
 * package root), driving them with a `Post` typed against the REAL
 * `@usemoney/types` `Post` interface. No inline reimplementation:
 * `getContentPath`, `generateSEOMetadata`, and `generateStructuredData` run the
 * source code asserted here.
 *
 * Divergence the old shadow hid: its inline `ContentType` had only 4 values
 * (BLOG | GLOSSARY | NEWSLETTER | LEGAL) and its inline `getContentPath`
 * omitted the real `DOCS -> "docs"` branch. The real `ContentType` has 5
 * values; the `DOCS` path is now covered below.
 *
 * Source: packages/core/src/content/seo.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  generateSEOMetadata,
  getContentPath,
  generateStructuredData,
} from "@usemoney/core";
import type { Post, ContentType, ContentAuthor } from "@usemoney/types";

// ============== HELPERS ==============

const BASE_AUTHOR: ContentAuthor = {
  id: "author-1",
  clerkId: "clerk-1",
  name: "Test Author",
  username: "testuser",
  email: "author@example.com",
  role: "WRITER",
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

function createMockPost(
  overrides: Partial<Omit<Post, "author">> & {
    author?: Partial<ContentAuthor>;
  } = {}
): Post {
  const { author: authorOverride, ...rest } = overrides;
  return {
    id: "post-1",
    contentPlatform: "STOCKBOOK",
    contentType: "BLOG",
    title: "Test Post",
    content: "[]",
    featureImage: "/images/test.png",
    postUrl: "test-post",
    excerpt: "Test excerpt",
    publishDate: new Date("2024-01-01"),
    status: "PUBLISHED",
    isFeatured: false,
    isPremium: false,
    authorId: BASE_AUTHOR.id,
    tags: [],
    viewCount: 0,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-02-01"),
    ...rest,
    author: { ...BASE_AUTHOR, ...(authorOverride ?? {}) },
  };
}

const BASE_URL = "https://usemoney.ai";

// ============== TESTS ==============

describe("SEO Utilities (real @usemoney/core exports)", () => {
  // ---- getContentPath ----

  describe("getContentPath", () => {
    it("should return 'blog' for BLOG content type", () => {
      assert.equal(getContentPath("BLOG"), "blog");
    });

    it("should return 'glossary' for GLOSSARY content type", () => {
      assert.equal(getContentPath("GLOSSARY"), "glossary");
    });

    it("should return 'newsletter' for NEWSLETTER content type", () => {
      assert.equal(getContentPath("NEWSLETTER"), "newsletter");
    });

    it("should return 'legal' for LEGAL content type", () => {
      assert.equal(getContentPath("LEGAL"), "legal");
    });

    it("should return 'docs' for DOCS content type (the 5th type the shadow omitted)", () => {
      assert.equal(getContentPath("DOCS"), "docs");
    });

    it("should return 'content' for unknown content type", () => {
      assert.equal(getContentPath("UNKNOWN" as ContentType), "content");
    });
  });

  // ---- generateSEOMetadata ----

  describe("generateSEOMetadata", () => {
    it("should generate metadata with default post values", () => {
      const post = createMockPost();
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.title, "Test Post | UseMoney");
      assert.equal(meta.description, "Test excerpt");
      assert.equal(meta.type, "article");
    });

    it("should use metadataTitle over title when provided", () => {
      const post = createMockPost({ metadataTitle: "SEO Title" });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.title, "SEO Title | UseMoney");
    });

    it("should fallback to title when metadataTitle is null", () => {
      const post = createMockPost({ metadataTitle: null });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.title, "Test Post | UseMoney");
    });

    it("should use metadataDescription over excerpt when provided", () => {
      const post = createMockPost({ metadataDescription: "SEO description" });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.description, "SEO description");
    });

    it("should fallback to excerpt when metadataDescription is null", () => {
      const post = createMockPost({
        metadataDescription: null,
        excerpt: "Excerpt text",
      });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.description, "Excerpt text");
    });

    it("should fallback to empty string when both metadataDescription and excerpt are null", () => {
      const post = createMockPost({
        metadataDescription: null,
        excerpt: null,
      });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.description, "");
    });

    it("should truncate description to 160 characters", () => {
      const longDesc = "a".repeat(200);
      const post = createMockPost({ metadataDescription: longDesc });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.description.length, 160);
    });

    it("should not truncate description under 160 characters", () => {
      const shortDesc = "a".repeat(100);
      const post = createMockPost({ metadataDescription: shortDesc });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.description.length, 100);
    });

    it("should parse comma-separated keywords", () => {
      const post = createMockPost({
        metadataKeywords: "stocks, investing, India",
      });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.deepEqual(meta.keywords, ["stocks", "investing", "India"]);
    });

    it("should trim whitespace from keywords", () => {
      const post = createMockPost({
        metadataKeywords: " stocks , investing , India ",
      });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.deepEqual(meta.keywords, ["stocks", "investing", "India"]);
    });

    it("should filter out empty keywords", () => {
      const post = createMockPost({ metadataKeywords: "stocks,,investing,," });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.deepEqual(meta.keywords, ["stocks", "investing"]);
    });

    it("should leave keywords undefined when metadataKeywords is null", () => {
      const post = createMockPost({ metadataKeywords: null });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.keywords, undefined);
    });

    it("should use metadataImageUrl as image when provided", () => {
      const post = createMockPost({ metadataImageUrl: "/images/seo.png" });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.image, "/images/seo.png");
    });

    it("should fallback to featureImage when metadataImageUrl is null", () => {
      const post = createMockPost({
        metadataImageUrl: null,
        featureImage: "/images/feature.png",
      });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.image, "/images/feature.png");
    });

    it("should fallback to default og-image when both image fields are null", () => {
      const post = createMockPost({
        metadataImageUrl: null,
        featureImage: null,
      });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.image, `${BASE_URL}/og-image.png`);
    });

    it("should use canonicalUrl when provided", () => {
      const post = createMockPost({ canonicalUrl: "https://example.com/post" });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.canonical, "https://example.com/post");
    });

    it("should construct canonical URL when canonicalUrl is null", () => {
      const post = createMockPost({
        canonicalUrl: null,
        contentType: "BLOG",
        postUrl: "my-post",
      });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.canonical, `${BASE_URL}/blog/my-post`);
    });

    it("should construct correct canonical for GLOSSARY type", () => {
      const post = createMockPost({
        canonicalUrl: null,
        contentType: "GLOSSARY",
        postUrl: "stock-term",
      });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.canonical, `${BASE_URL}/glossary/stock-term`);
    });

    it("should construct correct canonical for NEWSLETTER type", () => {
      const post = createMockPost({
        canonicalUrl: null,
        contentType: "NEWSLETTER",
        postUrl: "weekly-update",
      });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.canonical, `${BASE_URL}/newsletter/weekly-update`);
    });

    it("should include publishedTime from publishDate", () => {
      const date = new Date("2024-06-15T10:00:00Z");
      const post = createMockPost({ publishDate: date });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.publishedTime, date.toISOString());
    });

    it("should leave publishedTime undefined when publishDate is null", () => {
      const post = createMockPost({ publishDate: null });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.publishedTime, undefined);
    });

    it("should include modifiedTime from updatedAt", () => {
      const date = new Date("2024-07-01T12:00:00Z");
      const post = createMockPost({ updatedAt: date });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.modifiedTime, date.toISOString());
    });

    it("should use author name as author field", () => {
      const post = createMockPost({
        author: { name: "John Doe", username: "johndoe" },
      });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.author, "John Doe");
    });

    it("should fallback to username when author name is null", () => {
      const post = createMockPost({
        author: { name: null, username: "johndoe" },
      });
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.author, "johndoe");
    });

    it("should always set type to article", () => {
      const post = createMockPost();
      const meta = generateSEOMetadata(post, BASE_URL);

      assert.equal(meta.type, "article");
    });
  });

  // ---- generateStructuredData ----

  describe("generateStructuredData", () => {
    it("should return BlogPosting type for BLOG content", () => {
      const post = createMockPost({ contentType: "BLOG" });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;

      assert.equal(data["@type"], "BlogPosting");
    });

    it("should return DefinedTerm type for GLOSSARY content", () => {
      const post = createMockPost({ contentType: "GLOSSARY" });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;

      assert.equal(data["@type"], "DefinedTerm");
    });

    it("should return BlogPosting type for NEWSLETTER content", () => {
      const post = createMockPost({ contentType: "NEWSLETTER" });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;

      assert.equal(data["@type"], "BlogPosting");
    });

    it("should return BlogPosting type for LEGAL content", () => {
      const post = createMockPost({ contentType: "LEGAL" });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;

      assert.equal(data["@type"], "BlogPosting");
    });

    it("should include schema.org context", () => {
      const post = createMockPost();
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;

      assert.equal(data["@context"], "https://schema.org");
    });

    it("should include headline from title", () => {
      const post = createMockPost({ title: "My Great Post" });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;

      assert.equal(data["headline"], "My Great Post");
    });

    it("should include description from excerpt", () => {
      const post = createMockPost({ excerpt: "Post excerpt" });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;

      assert.equal(data["description"], "Post excerpt");
    });

    it("should include image from featureImage", () => {
      const post = createMockPost({ featureImage: "/images/hero.png" });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;

      assert.equal(data["image"], "/images/hero.png");
    });

    it("should include datePublished from publishDate", () => {
      const date = new Date("2024-03-15T08:00:00Z");
      const post = createMockPost({ publishDate: date });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;

      assert.equal(data["datePublished"], date.toISOString());
    });

    it("should have undefined datePublished when publishDate is null", () => {
      const post = createMockPost({ publishDate: null });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;

      assert.equal(data["datePublished"], undefined);
    });

    it("should include dateModified from updatedAt", () => {
      const date = new Date("2024-04-01T10:00:00Z");
      const post = createMockPost({ updatedAt: date });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;

      assert.equal(data["dateModified"], date.toISOString());
    });

    it("should include author with name", () => {
      const post = createMockPost({
        author: { name: "Jane Smith", username: "janesmith" },
      });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;
      const author = data["author"] as Record<string, unknown>;

      assert.equal(author["@type"], "Person");
      assert.equal(author["name"], "Jane Smith");
    });

    it("should fallback to username for author when name is null", () => {
      const post = createMockPost({
        author: { name: null, username: "janesmith" },
      });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;
      const author = data["author"] as Record<string, unknown>;

      assert.equal(author["name"], "janesmith");
    });

    it("should include publisher organization", () => {
      const post = createMockPost();
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;
      const publisher = data["publisher"] as Record<string, unknown>;

      assert.equal(publisher["@type"], "Organization");
      assert.equal(publisher["name"], "UseMoney");
    });

    it("should include publisher logo", () => {
      const post = createMockPost();
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;
      const publisher = data["publisher"] as Record<string, unknown>;
      const logo = publisher["logo"] as Record<string, unknown>;

      assert.equal(logo["@type"], "ImageObject");
      assert.equal(logo["url"], `${BASE_URL}/logo.png`);
    });

    it("should include mainEntityOfPage with correct URL", () => {
      const post = createMockPost({
        contentType: "BLOG",
        postUrl: "awesome-post",
      });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;
      const mainEntity = data["mainEntityOfPage"] as Record<string, unknown>;

      assert.equal(mainEntity["@type"], "WebPage");
      assert.equal(mainEntity["@id"], `${BASE_URL}/blog/awesome-post`);
    });

    it("should construct correct mainEntityOfPage for GLOSSARY", () => {
      const post = createMockPost({
        contentType: "GLOSSARY",
        postUrl: "market-cap",
      });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;
      const mainEntity = data["mainEntityOfPage"] as Record<string, unknown>;

      assert.equal(mainEntity["@id"], `${BASE_URL}/glossary/market-cap`);
    });

    it("should handle null excerpt in description", () => {
      const post = createMockPost({ excerpt: null });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;

      assert.equal(data["description"], null);
    });

    it("should handle null featureImage", () => {
      const post = createMockPost({ featureImage: null });
      const data = generateStructuredData(post, BASE_URL) as Record<
        string,
        unknown
      >;

      assert.equal(data["image"], null);
    });
  });
});
