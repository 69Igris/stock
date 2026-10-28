/**
 * Negative / edge-case coverage for the REAL exported content Zod schemas.
 *
 * Source: packages/validation/src/content/index.ts
 *
 * Imports & exercises the actual schemas (no shadow). Covers the slug/url regex
 * gates (postUrl, tag slug, hex color, username), URL-format fields, the meta
 * length caps, the coerced+bounded PostPagination, and the Idea create/update
 * schemas (topics array cap, coerced dates).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CreatePostSchema,
  UpdatePostSchema,
  CreateTagSchema,
  CreateAuthorSchema,
  PostPaginationSchema,
  PublishPostSchema,
  CreateIdeaSchema,
  UpdateIdeaSchema,
} from "../src/content/index.ts";

describe("CreatePostSchema (real export)", () => {
  const valid = {
    title: "Understanding SIPs",
    content: "Body content here.",
    postUrl: "understanding-sips",
  };

  it("accepts a valid post and applies defaults", () => {
    const r = CreatePostSchema.safeParse(valid);
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.contentType, "BLOG");
    assert.equal(r.data.status, "DRAFT");
    assert.equal(r.data.isFeatured, false);
    assert.equal(r.data.isPremium, false);
  });

  it("rejects a title below the 3-char floor", () => {
    assert.equal(
      CreatePostSchema.safeParse({ ...valid, title: "ab" }).success,
      false,
    );
  });

  it("rejects a title above the 200-char cap", () => {
    assert.equal(
      CreatePostSchema.safeParse({ ...valid, title: "A".repeat(201) }).success,
      false,
    );
  });

  it("rejects empty content (required)", () => {
    assert.equal(
      CreatePostSchema.safeParse({ ...valid, content: "" }).success,
      false,
    );
  });

  it("rejects a postUrl with uppercase / underscores (slug regex)", () => {
    assert.equal(
      CreatePostSchema.safeParse({ ...valid, postUrl: "Bad_Slug" }).success,
      false,
    );
  });

  it("rejects a postUrl with a leading hyphen (slug regex)", () => {
    assert.equal(
      CreatePostSchema.safeParse({ ...valid, postUrl: "-leading" }).success,
      false,
    );
  });

  it("rejects a postUrl below the 3-char floor", () => {
    assert.equal(
      CreatePostSchema.safeParse({ ...valid, postUrl: "ab" }).success,
      false,
    );
  });

  it("rejects a non-URL featureImage", () => {
    assert.equal(
      CreatePostSchema.safeParse({ ...valid, featureImage: "not-a-url" })
        .success,
      false,
    );
  });

  it("rejects a metadataTitle above the 70-char cap", () => {
    assert.equal(
      CreatePostSchema.safeParse({ ...valid, metadataTitle: "A".repeat(71) })
        .success,
      false,
    );
  });

  it("rejects a metadataDescription above the 160-char cap", () => {
    assert.equal(
      CreatePostSchema.safeParse({
        ...valid,
        metadataDescription: "A".repeat(161),
      }).success,
      false,
    );
  });

  it("rejects an unparseable publishDate (coerce.date invalid)", () => {
    assert.equal(
      CreatePostSchema.safeParse({ ...valid, publishDate: "garbage-date" })
        .success,
      false,
    );
  });

  it("rejects an out-of-enum status", () => {
    assert.equal(
      CreatePostSchema.safeParse({ ...valid, status: "NOT_A_STATUS" }).success,
      false,
    );
  });
});

describe("UpdatePostSchema (real export)", () => {
  it("accepts an empty patch (all fields optional)", () => {
    assert.equal(UpdatePostSchema.safeParse({}).success, true);
  });

  it("accepts an explicit null featureImage (nullable)", () => {
    assert.equal(
      UpdatePostSchema.safeParse({ featureImage: null }).success,
      true,
    );
  });

  it("still rejects an invalid postUrl when provided", () => {
    assert.equal(
      UpdatePostSchema.safeParse({ postUrl: "BAD URL" }).success,
      false,
    );
  });
});

describe("CreateTagSchema (real export)", () => {
  const valid = { slug: "stock-market", name: "Stock Market" };

  it("accepts a valid tag", () => {
    assert.equal(CreateTagSchema.safeParse(valid).success, true);
  });

  it("rejects a slug below the 2-char floor", () => {
    assert.equal(
      CreateTagSchema.safeParse({ ...valid, slug: "a" }).success,
      false,
    );
  });

  it("rejects an invalid slug format", () => {
    assert.equal(
      CreateTagSchema.safeParse({ ...valid, slug: "Stock_Market" }).success,
      false,
    );
  });

  it("rejects an invalid hex color", () => {
    assert.equal(
      CreateTagSchema.safeParse({ ...valid, color: "red" }).success,
      false,
    );
  });

  it("accepts a valid 6-digit hex color", () => {
    assert.equal(
      CreateTagSchema.safeParse({ ...valid, color: "#FF5733" }).success,
      true,
    );
  });

  it("rejects a 3-digit hex color (regex requires 6)", () => {
    assert.equal(
      CreateTagSchema.safeParse({ ...valid, color: "#F53" }).success,
      false,
    );
  });

  it("rejects a non-URL imageUrl", () => {
    assert.equal(
      CreateTagSchema.safeParse({ ...valid, imageUrl: "x" }).success,
      false,
    );
  });
});

describe("CreateAuthorSchema (real export)", () => {
  const valid = {
    clerkId: "user_123",
    username: "jane_doe",
    email: "jane@example.com",
  };

  it("accepts a valid author and defaults role to WRITER", () => {
    const r = CreateAuthorSchema.safeParse(valid);
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.role, "WRITER");
  });

  it("rejects empty clerkId", () => {
    assert.equal(
      CreateAuthorSchema.safeParse({ ...valid, clerkId: "" }).success,
      false,
    );
  });

  it("rejects an invalid email", () => {
    assert.equal(
      CreateAuthorSchema.safeParse({ ...valid, email: "not-an-email" }).success,
      false,
    );
  });

  it("rejects a username with uppercase/special chars (regex)", () => {
    assert.equal(
      CreateAuthorSchema.safeParse({ ...valid, username: "Jane.Doe" }).success,
      false,
    );
  });

  it("rejects a username below the 3-char floor", () => {
    assert.equal(
      CreateAuthorSchema.safeParse({ ...valid, username: "ab" }).success,
      false,
    );
  });

  it("rejects an out-of-enum role", () => {
    assert.equal(
      CreateAuthorSchema.safeParse({ ...valid, role: "SUPERADMIN" }).success,
      false,
    );
  });
});

describe("PostPaginationSchema (real export)", () => {
  it("applies defaults on empty input", () => {
    const r = PostPaginationSchema.safeParse({});
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.page, 1);
    assert.equal(r.data.limit, 10);
    assert.equal(r.data.sortBy, "createdAt");
    assert.equal(r.data.sortOrder, "desc");
  });

  it("coerces a numeric-string page", () => {
    const r = PostPaginationSchema.safeParse({ page: "3" });
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.page, 3);
  });

  it("rejects page 0 (must be positive)", () => {
    assert.equal(PostPaginationSchema.safeParse({ page: 0 }).success, false);
  });

  it("rejects limit above 100", () => {
    assert.equal(PostPaginationSchema.safeParse({ limit: 101 }).success, false);
  });

  it("rejects an out-of-enum sortBy", () => {
    assert.equal(
      PostPaginationSchema.safeParse({ sortBy: "random" }).success,
      false,
    );
  });
});

describe("PublishPostSchema (real export)", () => {
  it("accepts a postId without publishDate (publish immediately)", () => {
    assert.equal(PublishPostSchema.safeParse({ postId: "p1" }).success, true);
  });

  it("rejects empty postId", () => {
    assert.equal(PublishPostSchema.safeParse({ postId: "" }).success, false);
  });

  it("rejects an unparseable publishDate", () => {
    assert.equal(
      PublishPostSchema.safeParse({ postId: "p1", publishDate: "nope" })
        .success,
      false,
    );
  });
});

describe("CreateIdeaSchema / UpdateIdeaSchema (real exports)", () => {
  it("accepts a valid idea", () => {
    assert.equal(
      CreateIdeaSchema.safeParse({ title: "New series" }).success,
      true,
    );
  });

  it("rejects a title below the 3-char floor", () => {
    assert.equal(CreateIdeaSchema.safeParse({ title: "ab" }).success, false);
  });

  it("rejects more than 10 topics", () => {
    assert.equal(
      CreateIdeaSchema.safeParse({
        title: "Series",
        topics: Array.from({ length: 11 }, (_v, i) => `t${i}`),
      }).success,
      false,
    );
  });

  it("rejects a topic above the 50-char cap", () => {
    assert.equal(
      CreateIdeaSchema.safeParse({ title: "Series", topics: ["A".repeat(51)] })
        .success,
      false,
    );
  });

  it("accepts a null targetDate (nullable)", () => {
    assert.equal(
      CreateIdeaSchema.safeParse({ title: "Series", targetDate: null }).success,
      true,
    );
  });

  it("rejects an out-of-enum status on update", () => {
    assert.equal(
      UpdateIdeaSchema.safeParse({ status: "PUBLISHED" }).success,
      false,
    );
  });

  it("rejects an out-of-enum currentStage on update", () => {
    assert.equal(
      UpdateIdeaSchema.safeParse({ currentStage: "FINAL" }).success,
      false,
    );
  });
});
