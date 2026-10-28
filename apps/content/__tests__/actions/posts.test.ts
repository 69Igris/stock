/**
 * Posts Action Tests
 *
 * Exercises the REAL exported helpers from
 * `apps/content/lib/actions/posts-logic.ts` (which `posts.ts` imports and
 * calls) — NOT inline copies.
 * - canModifyPost / writerCanViewPost (SECURITY)
 * - Post status transitions + publishPost scheduling (future → SCHEDULED)
 * - canPublish / canUnpublish DELETED gating
 * - buildPostListWhere filter building
 * - shouldSendBroadcast / shouldSendIndividualEmails newsletter conditions
 * - validateResend validation
 * - buildPostUpdateData partial update
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canModifyPost,
  determinePublishStatus,
  canPublish,
  canUnpublish,
  shouldSendBroadcast,
  shouldSendIndividualEmails,
  buildPostListWhere,
  canArchive,
  writerCanViewPost,
  validateResend,
  publishMessage,
  buildPostUpdateData,
} from "@/lib/actions/posts-logic";

// ── Tests ────────────────────────────────────────────────

describe("canModifyPost", () => {
  it("should allow ADMIN to modify any post", () => {
    assert.strictEqual(canModifyPost("ADMIN", "a1", "a2"), true);
  });

  it("should allow OWNER to modify any post", () => {
    assert.strictEqual(canModifyPost("OWNER", "a1", "a2"), true);
  });

  it("should allow WRITER to modify own post", () => {
    assert.strictEqual(canModifyPost("WRITER", "a1", "a1"), true);
  });

  it("should deny WRITER from modifying other's post", () => {
    assert.strictEqual(canModifyPost("WRITER", "a1", "a2"), false);
  });
});

describe("determinePublishStatus", () => {
  it("should return PUBLISHED when no date provided", () => {
    assert.strictEqual(determinePublishStatus(), "PUBLISHED");
  });

  it("should return PUBLISHED when date is in the past", () => {
    const past = new Date("2020-01-01T00:00:00Z");
    assert.strictEqual(determinePublishStatus(past), "PUBLISHED");
  });

  it("should return SCHEDULED when date is in the future", () => {
    const future = new Date(Date.now() + 86400000); // +1 day
    assert.strictEqual(determinePublishStatus(future), "SCHEDULED");
  });
});

describe("canPublish", () => {
  it("should allow publishing DRAFT", () => {
    assert.strictEqual(canPublish("DRAFT").allowed, true);
  });

  it("should allow publishing SCHEDULED", () => {
    assert.strictEqual(canPublish("SCHEDULED").allowed, true);
  });

  it("should allow publishing already PUBLISHED", () => {
    assert.strictEqual(canPublish("PUBLISHED").allowed, true);
  });

  it("should deny publishing DELETED post", () => {
    const result = canPublish("DELETED");
    assert.strictEqual(result.allowed, false);
    assert.ok(result.error?.includes("deleted"));
  });
});

describe("canUnpublish", () => {
  it("should allow unpublishing PUBLISHED", () => {
    assert.strictEqual(canUnpublish("PUBLISHED").allowed, true);
  });

  it("should allow unpublishing SCHEDULED", () => {
    assert.strictEqual(canUnpublish("SCHEDULED").allowed, true);
  });

  it("should deny unpublishing DELETED post", () => {
    const result = canUnpublish("DELETED");
    assert.strictEqual(result.allowed, false);
    assert.ok(result.error?.includes("deleted"));
  });
});

describe("canArchive", () => {
  it("should allow archiving DRAFT / PUBLISHED / SCHEDULED / ARCHIVED", () => {
    assert.strictEqual(canArchive("DRAFT").allowed, true);
    assert.strictEqual(canArchive("PUBLISHED").allowed, true);
    assert.strictEqual(canArchive("SCHEDULED").allowed, true);
    assert.strictEqual(canArchive("ARCHIVED").allowed, true);
  });

  it("should deny archiving a DELETED (trashed) post", () => {
    const result = canArchive("DELETED");
    assert.strictEqual(result.allowed, false);
    assert.ok(result.error?.includes("deleted"));
  });
});

describe("shouldSendBroadcast", () => {
  it("should send when NEWSLETTER is PUBLISHED with segments", () => {
    assert.strictEqual(
      shouldSendBroadcast("NEWSLETTER", "PUBLISHED", ["free"]),
      true,
    );
  });

  it("should not send when content type is BLOG", () => {
    assert.strictEqual(
      shouldSendBroadcast("BLOG", "PUBLISHED", ["free"]),
      false,
    );
  });

  it("should not send when status is SCHEDULED", () => {
    assert.strictEqual(
      shouldSendBroadcast("NEWSLETTER", "SCHEDULED", ["free"]),
      false,
    );
  });

  it("should not send when no segments", () => {
    assert.strictEqual(
      shouldSendBroadcast("NEWSLETTER", "PUBLISHED", []),
      false,
    );
  });

  it("should not send when segments is undefined", () => {
    assert.strictEqual(
      shouldSendBroadcast("NEWSLETTER", "PUBLISHED", undefined),
      false,
    );
  });
});

describe("shouldSendIndividualEmails", () => {
  it("should send when NEWSLETTER is PUBLISHED with emails", () => {
    assert.strictEqual(
      shouldSendIndividualEmails("NEWSLETTER", "PUBLISHED", ["a@b.com"]),
      true,
    );
  });

  it("should not send when emails array is empty", () => {
    assert.strictEqual(
      shouldSendIndividualEmails("NEWSLETTER", "PUBLISHED", []),
      false,
    );
  });

  it("should not send for BLOG content type", () => {
    assert.strictEqual(
      shouldSendIndividualEmails("BLOG", "PUBLISHED", ["a@b.com"]),
      false,
    );
  });
});

describe("buildPostListWhere", () => {
  it("should exclude ARCHIVED + DELETED posts by default", () => {
    const where = buildPostListWhere("ADMIN", "a1", {});
    assert.deepStrictEqual(where.status, { notIn: ["ARCHIVED", "DELETED"] });
  });

  it("surfaces ARCHIVED posts when explicitly filtered", () => {
    const where = buildPostListWhere("ADMIN", "a1", { status: "ARCHIVED" });
    assert.strictEqual(where.status, "ARCHIVED");
  });

  it("should use explicit status filter when provided", () => {
    const where = buildPostListWhere("ADMIN", "a1", { status: "PUBLISHED" });
    assert.strictEqual(where.status, "PUBLISHED");
  });

  it("should filter by contentType", () => {
    const where = buildPostListWhere("ADMIN", "a1", { contentType: "BLOG" });
    assert.strictEqual(where.contentType, "BLOG");
  });

  it("should filter by authorId", () => {
    const where = buildPostListWhere("ADMIN", "a1", { authorId: "a2" });
    assert.strictEqual(where.authorId, "a2");
  });

  it("should filter by isFeatured", () => {
    const where = buildPostListWhere("ADMIN", "a1", { isFeatured: true });
    assert.strictEqual(where.isFeatured, true);
  });

  it("should filter by isPremium false", () => {
    const where = buildPostListWhere("ADMIN", "a1", { isPremium: false });
    assert.strictEqual(where.isPremium, false);
  });

  it("should filter by tag slug", () => {
    const where = buildPostListWhere("ADMIN", "a1", { tagSlug: "investing" });
    assert.deepStrictEqual(where.tags, {
      some: { tag: { slug: "investing" } },
    });
  });

  it("should filter by search term (case insensitive)", () => {
    const where = buildPostListWhere("ADMIN", "a1", { search: "NIFTY" });
    assert.deepStrictEqual(where.title, {
      contains: "NIFTY",
      mode: "insensitive",
    });
  });

  it("should add OR clause for WRITER role", () => {
    const where = buildPostListWhere("WRITER", "a1", {});
    assert.deepStrictEqual(where.OR, [
      { authorId: "a1" },
      { status: "PUBLISHED" },
    ]);
  });

  it("should not add OR clause for ADMIN role", () => {
    const where = buildPostListWhere("ADMIN", "a1", {});
    assert.strictEqual(where.OR, undefined);
  });
});

describe("writerCanViewPost", () => {
  it("should allow WRITER to view own unpublished post", () => {
    assert.strictEqual(writerCanViewPost("WRITER", "a1", "a1", "DRAFT"), true);
  });

  it("should allow WRITER to view any published post", () => {
    assert.strictEqual(
      writerCanViewPost("WRITER", "a2", "a1", "PUBLISHED"),
      true,
    );
  });

  it("should deny WRITER from viewing other's draft", () => {
    assert.strictEqual(writerCanViewPost("WRITER", "a2", "a1", "DRAFT"), false);
  });

  it("should allow ADMIN to view any post", () => {
    assert.strictEqual(writerCanViewPost("ADMIN", "a2", "a1", "DRAFT"), true);
  });

  it("should allow OWNER to view any post", () => {
    assert.strictEqual(writerCanViewPost("OWNER", "a2", "a1", "DRAFT"), true);
  });
});

describe("validateResend", () => {
  it("should pass for NEWSLETTER + PUBLISHED with segments", () => {
    const result = validateResend("NEWSLETTER", "PUBLISHED", ["free"]);
    assert.strictEqual(result.valid, true);
  });

  it("should pass for NEWSLETTER + PUBLISHED with individual emails", () => {
    const result = validateResend("NEWSLETTER", "PUBLISHED", [], ["a@b.com"]);
    assert.strictEqual(result.valid, true);
  });

  it("should fail for non-newsletter", () => {
    const result = validateResend("BLOG", "PUBLISHED", ["free"]);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("not a newsletter"));
  });

  it("should fail for unpublished newsletter", () => {
    const result = validateResend("NEWSLETTER", "DRAFT", ["free"]);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("published first"));
  });

  it("should fail when no audience selected", () => {
    const result = validateResend("NEWSLETTER", "PUBLISHED", [], []);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("at least one"));
  });
});

describe("publishMessage", () => {
  it("should return scheduled message for SCHEDULED status", () => {
    assert.strictEqual(
      publishMessage("SCHEDULED"),
      "Post scheduled successfully!",
    );
  });

  it("should return published message for PUBLISHED status", () => {
    assert.strictEqual(
      publishMessage("PUBLISHED"),
      "Post published successfully!",
    );
  });
});

describe("buildPostUpdateData", () => {
  it("should include only truthy title", () => {
    const data = buildPostUpdateData({ title: "New Title" });
    assert.strictEqual(data.title, "New Title");
  });

  it("should not include empty title", () => {
    const data = buildPostUpdateData({ title: "" });
    assert.strictEqual(data.title, undefined);
  });

  it("should include featureImage null to clear it", () => {
    const data = buildPostUpdateData({ featureImage: null });
    assert.strictEqual(data.featureImage, null);
  });

  it("should include excerpt null to clear it", () => {
    const data = buildPostUpdateData({ excerpt: null });
    assert.strictEqual(data.excerpt, null);
  });

  it("should include boolean isFeatured false", () => {
    const data = buildPostUpdateData({ isFeatured: false });
    assert.strictEqual(data.isFeatured, false);
  });

  it("should include boolean isPremium true", () => {
    const data = buildPostUpdateData({ isPremium: true });
    assert.strictEqual(data.isPremium, true);
  });

  it("should build data with multiple fields", () => {
    const data = buildPostUpdateData({
      title: "Updated",
      content: "New content",
      status: "PUBLISHED",
    });
    assert.strictEqual(data.title, "Updated");
    assert.strictEqual(data.content, "New content");
    assert.strictEqual(data.status, "PUBLISHED");
  });

  it("should return empty object when no fields", () => {
    const data = buildPostUpdateData({});
    assert.deepStrictEqual(data, {});
  });
});
