/**
 * Analytics Action Tests
 *
 * Exercises the REAL exported helpers from
 * `apps/content/lib/actions/analytics-logic.ts` (which `analytics.ts` imports
 * and calls) — NOT inline copies.
 * - requireAdminAuthor role gating (SECURITY)
 * - Subscriber growth map building
 * - clampLimit limit clamping
 * - serialisePostAnalytics date serialisation
 * - serialiseSubscriberActivity date/null serialisation
 * - buildOverviewResult assembly
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  requireAdminAuthor,
  buildSubscriberGrowth,
  clampLimit,
  serialisePostAnalytics,
  serialiseSubscriberActivity,
  buildOverviewResult,
} from "@/lib/actions/analytics-logic";

// ── Tests ────────────────────────────────────────────────

describe("requireAdminAuthor", () => {
  it("should return null for null author", () => {
    assert.strictEqual(requireAdminAuthor(null), null);
  });

  it("should return null for WRITER role", () => {
    assert.strictEqual(requireAdminAuthor({ id: "a1", role: "WRITER" }), null);
  });

  it("should return author for ADMIN role", () => {
    const author = { id: "a1", role: "ADMIN" };
    assert.deepStrictEqual(requireAdminAuthor(author), author);
  });

  it("should return author for OWNER role", () => {
    const author = { id: "a2", role: "OWNER" };
    assert.deepStrictEqual(requireAdminAuthor(author), author);
  });

  it("should return author for EDITOR role", () => {
    const author = { id: "a3", role: "EDITOR" };
    assert.deepStrictEqual(requireAdminAuthor(author), author);
  });
});

describe("buildSubscriberGrowth", () => {
  it("should return empty array when no subscribers", () => {
    assert.deepStrictEqual(buildSubscriberGrowth([]), []);
  });

  it("should skip subscribers with null subscribedAt", () => {
    const result = buildSubscriberGrowth([
      { subscribedAt: null },
      { subscribedAt: null },
    ]);
    assert.deepStrictEqual(result, []);
  });

  it("should accumulate counts cumulatively", () => {
    const result = buildSubscriberGrowth([
      { subscribedAt: new Date("2025-01-01T10:00:00Z") },
      { subscribedAt: new Date("2025-01-02T10:00:00Z") },
      { subscribedAt: new Date("2025-01-03T10:00:00Z") },
    ]);
    assert.deepStrictEqual(result, [
      { date: "2025-01-01", count: 1 },
      { date: "2025-01-02", count: 2 },
      { date: "2025-01-03", count: 3 },
    ]);
  });

  it("should group multiple subscribers on same day with last cumulative", () => {
    const result = buildSubscriberGrowth([
      { subscribedAt: new Date("2025-01-01T08:00:00Z") },
      { subscribedAt: new Date("2025-01-01T12:00:00Z") },
      { subscribedAt: new Date("2025-01-02T10:00:00Z") },
    ]);
    assert.deepStrictEqual(result, [
      { date: "2025-01-01", count: 2 },
      { date: "2025-01-02", count: 3 },
    ]);
  });

  it("should handle mix of null and valid dates", () => {
    const result = buildSubscriberGrowth([
      { subscribedAt: null },
      { subscribedAt: new Date("2025-03-01T00:00:00Z") },
      { subscribedAt: null },
      { subscribedAt: new Date("2025-03-02T00:00:00Z") },
    ]);
    assert.deepStrictEqual(result, [
      { date: "2025-03-01", count: 1 },
      { date: "2025-03-02", count: 2 },
    ]);
  });

  it("should handle single subscriber", () => {
    const result = buildSubscriberGrowth([
      { subscribedAt: new Date("2025-06-15T09:30:00Z") },
    ]);
    assert.deepStrictEqual(result, [{ date: "2025-06-15", count: 1 }]);
  });
});

describe("clampLimit", () => {
  it("should return input when within range", () => {
    assert.strictEqual(clampLimit(10), 10);
  });

  it("should clamp to 1 when input is 0", () => {
    assert.strictEqual(clampLimit(0), 1);
  });

  it("should clamp to 1 when input is negative", () => {
    assert.strictEqual(clampLimit(-5), 1);
  });

  it("should clamp to 50 when input exceeds max", () => {
    assert.strictEqual(clampLimit(100), 50);
  });

  it("should allow 50 exactly", () => {
    assert.strictEqual(clampLimit(50), 50);
  });

  it("should allow 1 exactly", () => {
    assert.strictEqual(clampLimit(1), 1);
  });
});

describe("serialisePostAnalytics", () => {
  it("should convert dates to ISO strings", () => {
    const result = serialisePostAnalytics({
      id: "p1",
      title: "Test",
      postUrl: "test-post",
      contentType: "BLOG",
      viewCount: 42,
      publishDate: new Date("2025-06-01T12:00:00Z"),
      createdAt: new Date("2025-05-01T08:00:00Z"),
    });
    assert.strictEqual(result.publishDate, "2025-06-01T12:00:00.000Z");
    assert.strictEqual(result.createdAt, "2025-05-01T08:00:00.000Z");
  });

  it("should set publishDate to null when not published", () => {
    const result = serialisePostAnalytics({
      id: "p2",
      title: "Draft",
      postUrl: "draft-post",
      contentType: "NEWSLETTER",
      viewCount: 0,
      publishDate: null,
      createdAt: new Date("2025-05-01T08:00:00Z"),
    });
    assert.strictEqual(result.publishDate, null);
  });

  it("should preserve all scalar fields", () => {
    const result = serialisePostAnalytics({
      id: "p3",
      title: "SIP Guide",
      postUrl: "sip-guide",
      contentType: "BLOG",
      viewCount: 1500,
      publishDate: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });
    assert.strictEqual(result.id, "p3");
    assert.strictEqual(result.title, "SIP Guide");
    assert.strictEqual(result.postUrl, "sip-guide");
    assert.strictEqual(result.contentType, "BLOG");
    assert.strictEqual(result.viewCount, 1500);
  });
});

describe("serialiseSubscriberActivity", () => {
  it("should convert all dates to ISO strings", () => {
    const result = serialiseSubscriberActivity({
      id: "s1",
      email: "test@example.com",
      name: "Test User",
      status: "ACTIVE",
      source: "website",
      segments: ["free"],
      subscribedAt: new Date("2025-01-15T10:00:00Z"),
      unsubscribedAt: null,
      createdAt: new Date("2025-01-15T10:00:00Z"),
    });
    assert.strictEqual(result.subscribedAt, "2025-01-15T10:00:00.000Z");
    assert.strictEqual(result.unsubscribedAt, null);
    assert.strictEqual(result.createdAt, "2025-01-15T10:00:00.000Z");
  });

  it("should handle unsubscribed user with unsubscribedAt date", () => {
    const result = serialiseSubscriberActivity({
      id: "s2",
      email: "gone@example.com",
      name: null,
      status: "UNSUBSCRIBED",
      source: null,
      segments: [],
      subscribedAt: new Date("2025-01-01T00:00:00Z"),
      unsubscribedAt: new Date("2025-02-01T00:00:00Z"),
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });
    assert.strictEqual(result.unsubscribedAt, "2025-02-01T00:00:00.000Z");
    assert.strictEqual(result.name, null);
    assert.strictEqual(result.source, null);
  });

  it("should handle null subscribedAt", () => {
    const result = serialiseSubscriberActivity({
      id: "s3",
      email: "pending@example.com",
      name: "Pending",
      status: "PENDING",
      source: "api",
      segments: ["paid"],
      subscribedAt: null,
      unsubscribedAt: null,
      createdAt: new Date("2025-03-01T00:00:00Z"),
    });
    assert.strictEqual(result.subscribedAt, null);
  });

  it("should preserve segments array", () => {
    const result = serialiseSubscriberActivity({
      id: "s4",
      email: "multi@example.com",
      name: "Multi",
      status: "ACTIVE",
      source: "import",
      segments: ["free", "paid", "security"],
      subscribedAt: new Date("2025-05-01T00:00:00Z"),
      unsubscribedAt: null,
      createdAt: new Date("2025-05-01T00:00:00Z"),
    });
    assert.deepStrictEqual(result.segments, ["free", "paid", "security"]);
  });
});

describe("buildOverviewResult", () => {
  it("should assemble complete overview with all stats", () => {
    const result = buildOverviewResult({
      totalSubs: 100,
      activeSubs: 80,
      pendingSubs: 10,
      unsubSubs: 10,
      totalPosts: 50,
      publishedPosts: 30,
      viewsSum: 5000,
      broadcasts: [
        {
          id: "b1",
          name: "Weekly",
          status: "sent",
          audience_id: "aud_1",
          created_at: "2025-01-01T00:00:00Z",
        },
      ],
      subscriberGrowth: [{ date: "2025-01-01", count: 5 }],
    });
    assert.strictEqual(result.success, true);
    if (!result.success) throw new Error("Expected success");
    assert.strictEqual(result.data.subscribers.total, 100);
    assert.strictEqual(result.data.subscribers.active, 80);
    assert.strictEqual(result.data.subscribers.pending, 10);
    assert.strictEqual(result.data.subscribers.unsubscribed, 10);
    assert.strictEqual(result.data.posts.total, 50);
    assert.strictEqual(result.data.posts.published, 30);
    assert.strictEqual(result.data.posts.totalViews, 5000);
    assert.strictEqual(result.data.broadcasts.length, 1);
    assert.strictEqual(result.data.subscriberGrowth.length, 1);
  });

  it("should default totalViews to 0 when viewsSum is null", () => {
    const result = buildOverviewResult({
      totalSubs: 0,
      activeSubs: 0,
      pendingSubs: 0,
      unsubSubs: 0,
      totalPosts: 0,
      publishedPosts: 0,
      viewsSum: null,
      broadcasts: [],
      subscriberGrowth: [],
    });
    assert.strictEqual(result.success, true);
    if (!result.success) throw new Error("Expected success");
    assert.strictEqual(result.data.posts.totalViews, 0);
  });

  it("should default totalViews to 0 when viewsSum is 0", () => {
    const result = buildOverviewResult({
      totalSubs: 5,
      activeSubs: 5,
      pendingSubs: 0,
      unsubSubs: 0,
      totalPosts: 3,
      publishedPosts: 1,
      viewsSum: 0,
      broadcasts: [],
      subscriberGrowth: [],
    });
    assert.strictEqual(result.success, true);
    if (!result.success) throw new Error("Expected success");
    assert.strictEqual(result.data.posts.totalViews, 0);
  });

  it("should pass through empty broadcasts array", () => {
    const result = buildOverviewResult({
      totalSubs: 1,
      activeSubs: 1,
      pendingSubs: 0,
      unsubSubs: 0,
      totalPosts: 1,
      publishedPosts: 1,
      viewsSum: 10,
      broadcasts: [],
      subscriberGrowth: [],
    });
    assert.strictEqual(result.success, true);
    if (!result.success) throw new Error("Expected success");
    assert.deepStrictEqual(result.data.broadcasts, []);
  });
});
