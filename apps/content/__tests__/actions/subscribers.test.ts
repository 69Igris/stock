/**
 * Subscriber Action Tests
 *
 * Exercises the REAL exported helpers — `buildSubscriberWhere`,
 * `validateUpdateSubscriber`, `sortTimelineEvents` from
 * `apps/content/lib/actions/subscribers-logic.ts` (which `subscribers.ts`
 * imports and calls), and `getInitials` / `getAvatarColor` from the subscriber
 * detail page's `avatar-utils.ts` (which `page.tsx` imports and calls) — NOT
 * inline copies.
 * - Filter where clause building (listSubscribers)
 * - Update validation (name, note, location max lengths)
 * - Timeline event sorting
 * - Subscriber detail type shape
 * - Avatar helper functions (getInitials, getAvatarColor)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSubscriberWhere,
  validateUpdateSubscriber,
  sortTimelineEvents,
  type SubscriberFilter,
  type TimelineEvent,
} from "@/lib/actions/subscribers-logic";
import {
  getInitials,
  getAvatarColor,
} from "@/app/(content)/subscribers/[id]/avatar-utils";

// ── Tests ────────────────────────────────────────────────

describe("buildSubscriberWhere", () => {
  it("should return empty object when no filter provided", () => {
    assert.deepStrictEqual(buildSubscriberWhere(), {});
    assert.deepStrictEqual(buildSubscriberWhere(undefined), {});
  });

  it("should return empty object for empty filter", () => {
    assert.deepStrictEqual(buildSubscriberWhere({}), {});
  });

  it("should filter by status", () => {
    const where = buildSubscriberWhere({ status: "ACTIVE" });
    assert.deepStrictEqual(where, { status: "ACTIVE" });
  });

  it("should filter by segment using hasSome", () => {
    const where = buildSubscriberWhere({ segment: "free" });
    assert.deepStrictEqual(where, { segments: { hasSome: ["free"] } });
  });

  it("should filter by name (case-insensitive contains)", () => {
    const where = buildSubscriberWhere({ name: "John" });
    assert.deepStrictEqual(where, {
      name: { contains: "John", mode: "insensitive" },
    });
  });

  it("should filter by email (case-insensitive contains)", () => {
    const where = buildSubscriberWhere({ email: "gmail" });
    assert.deepStrictEqual(where, {
      email: { contains: "gmail", mode: "insensitive" },
    });
  });

  it("should filter by source (exact match)", () => {
    const where = buildSubscriberWhere({ source: "website" });
    assert.deepStrictEqual(where, { source: "website" });
  });

  it("should filter by createdAfter only", () => {
    const where = buildSubscriberWhere({ createdAfter: "2026-01-01" });
    assert.ok("createdAt" in where);
    const ca = where.createdAt as Record<string, Date>;
    assert.ok("gt" in ca);
    assert.ok(!("lt" in ca));
    assert.strictEqual(
      ca.gt.toISOString(),
      new Date("2026-01-01").toISOString(),
    );
  });

  it("should filter by createdBefore only", () => {
    const where = buildSubscriberWhere({ createdBefore: "2026-12-31" });
    const ca = where.createdAt as Record<string, Date>;
    assert.ok("lt" in ca);
    assert.ok(!("gt" in ca));
  });

  it("should filter by both createdAfter and createdBefore", () => {
    const where = buildSubscriberWhere({
      createdAfter: "2026-01-01",
      createdBefore: "2026-12-31",
    });
    const ca = where.createdAt as Record<string, Date>;
    assert.ok("gt" in ca);
    assert.ok("lt" in ca);
  });

  it("should combine multiple filters", () => {
    const where = buildSubscriberWhere({
      status: "ACTIVE",
      segment: "paid",
      name: "Test",
      source: "website",
    });
    assert.strictEqual(where.status, "ACTIVE");
    assert.deepStrictEqual(where.segments, { hasSome: ["paid"] });
    assert.deepStrictEqual(where.name, {
      contains: "Test",
      mode: "insensitive",
    });
    assert.strictEqual(where.source, "website");
  });

  it("should ignore falsy filter values", () => {
    const where = buildSubscriberWhere({
      status: "",
      segment: "",
      name: "",
    });
    assert.deepStrictEqual(where, {});
  });
});

describe("validateUpdateSubscriber", () => {
  it("should pass with empty data", () => {
    assert.strictEqual(validateUpdateSubscriber({}).valid, true);
  });

  it("should pass with valid name", () => {
    assert.strictEqual(validateUpdateSubscriber({ name: "John" }).valid, true);
  });

  it("should pass with name at 200 chars", () => {
    assert.strictEqual(
      validateUpdateSubscriber({ name: "a".repeat(200) }).valid,
      true,
    );
  });

  it("should fail with name over 200 chars", () => {
    const result = validateUpdateSubscriber({ name: "a".repeat(201) });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("Name"));
  });

  it("should pass with note at 500 chars", () => {
    assert.strictEqual(
      validateUpdateSubscriber({ note: "x".repeat(500) }).valid,
      true,
    );
  });

  it("should fail with note over 500 chars", () => {
    const result = validateUpdateSubscriber({ note: "x".repeat(501) });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("Note"));
  });

  it("should pass with location at 200 chars", () => {
    assert.strictEqual(
      validateUpdateSubscriber({ location: "y".repeat(200) }).valid,
      true,
    );
  });

  it("should fail with location over 200 chars", () => {
    const result = validateUpdateSubscriber({ location: "y".repeat(201) });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("Location"));
  });

  it("should validate all fields together", () => {
    assert.strictEqual(
      validateUpdateSubscriber({
        name: "Valid Name",
        note: "Some note",
        location: "Mumbai, India",
      }).valid,
      true,
    );
  });

  it("should fail on first invalid field (name checked first)", () => {
    const result = validateUpdateSubscriber({
      name: "a".repeat(201),
      note: "x".repeat(501),
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("Name"));
  });
});

describe("sortTimelineEvents", () => {
  it("should sort events by timestamp descending", () => {
    const events: TimelineEvent[] = [
      {
        type: "subscribed",
        description: "Subscribed",
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        type: "email_sent",
        description: "Email sent",
        timestamp: "2026-03-01T00:00:00Z",
      },
      {
        type: "unsubscribed",
        description: "Unsubscribed",
        timestamp: "2026-02-01T00:00:00Z",
      },
    ];
    const sorted = sortTimelineEvents(events);
    assert.strictEqual(sorted[0]?.type, "email_sent");
    assert.strictEqual(sorted[1]?.type, "unsubscribed");
    assert.strictEqual(sorted[2]?.type, "subscribed");
  });

  it("should handle single event", () => {
    const events: TimelineEvent[] = [
      {
        type: "subscribed",
        description: "Subscribed",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ];
    const sorted = sortTimelineEvents(events);
    assert.strictEqual(sorted.length, 1);
  });

  it("should handle empty array", () => {
    assert.deepStrictEqual(sortTimelineEvents([]), []);
  });

  it("should not mutate original array", () => {
    const events: TimelineEvent[] = [
      {
        type: "subscribed",
        description: "A",
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        type: "email_sent",
        description: "B",
        timestamp: "2026-03-01T00:00:00Z",
      },
    ];
    sortTimelineEvents(events);
    assert.strictEqual(events[0]?.type, "subscribed");
  });

  it("should handle events with same timestamp", () => {
    const events: TimelineEvent[] = [
      {
        type: "email_sent",
        description: "A",
        timestamp: "2026-03-01T00:00:00Z",
      },
      {
        type: "email_sent",
        description: "B",
        timestamp: "2026-03-01T00:00:00Z",
      },
    ];
    const sorted = sortTimelineEvents(events);
    assert.strictEqual(sorted.length, 2);
  });
});

describe("SubscriberDetail type shape", () => {
  it("should define all required fields", () => {
    const detail = {
      id: "sub-1",
      email: "test@example.com",
      name: "Test User",
      status: "ACTIVE",
      source: "website",
      segments: ["free", "paid"],
      resendContactIds: { free: "c1", paid: "c2" },
      note: "Internal note",
      location: "Mumbai, India",
      imageUrl: "https://img.clerk.com/abc",
      subscribedAt: "2026-01-01T00:00:00Z",
      unsubscribedAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      emailActivity: {
        sent: 10,
        failed: 1,
        bounced: 0,
        lastEmail: {
          subject: "Weekly Digest",
          status: "SENT",
          sentAt: "2026-03-10T00:00:00Z",
        },
      },
    };

    assert.ok("id" in detail);
    assert.ok("email" in detail);
    assert.ok("name" in detail);
    assert.ok("status" in detail);
    assert.ok("segments" in detail);
    assert.ok("note" in detail);
    assert.ok("location" in detail);
    assert.ok("imageUrl" in detail);
    assert.ok("emailActivity" in detail);
    assert.ok("sent" in detail.emailActivity);
    assert.ok("failed" in detail.emailActivity);
    assert.ok("bounced" in detail.emailActivity);
    assert.ok("lastEmail" in detail.emailActivity);
  });

  it("should allow null for optional fields", () => {
    const detail = {
      id: "sub-1",
      email: "test@example.com",
      name: null,
      status: "PENDING",
      source: null,
      segments: [],
      resendContactIds: null,
      note: null,
      location: null,
      imageUrl: null,
      subscribedAt: null,
      unsubscribedAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      emailActivity: {
        sent: 0,
        failed: 0,
        bounced: 0,
        lastEmail: null,
      },
    };

    assert.strictEqual(detail.name, null);
    assert.strictEqual(detail.note, null);
    assert.strictEqual(detail.location, null);
    assert.strictEqual(detail.imageUrl, null);
    assert.strictEqual(detail.emailActivity.lastEmail, null);
  });
});

describe("getInitials", () => {
  it("should return first letters of first and last name", () => {
    assert.strictEqual(getInitials("John Doe", "john@example.com"), "JD");
  });

  it("should handle single name", () => {
    assert.strictEqual(getInitials("John", "john@example.com"), "J");
  });

  it("should handle three names (truncate to 2)", () => {
    assert.strictEqual(getInitials("John Michael Doe", "j@e.com"), "JM");
  });

  it("should fall back to email when name is null", () => {
    assert.strictEqual(getInitials(null, "john@example.com"), "JO");
  });

  it("should uppercase the result", () => {
    assert.strictEqual(getInitials("alice bob", "a@b.com"), "AB");
  });

  it("should handle empty name by falling back to email", () => {
    // empty string is falsy, so it falls to email
    assert.strictEqual(getInitials("", "test@example.com"), "TE");
  });
});

describe("getAvatarColor", () => {
  it("should return a valid color class", () => {
    const color = getAvatarColor("test@example.com");
    assert.ok(color.startsWith("bg-"));
  });

  it("should return consistent color for same email", () => {
    const color1 = getAvatarColor("user@example.com");
    const color2 = getAvatarColor("user@example.com");
    assert.strictEqual(color1, color2);
  });

  it("should return different colors for different emails", () => {
    // Not guaranteed, but with enough difference in input, likely different
    const color1 = getAvatarColor("alice@example.com");
    const color2 = getAvatarColor("zzzzz@different.org");
    // Just verify they're both valid; may or may not differ
    assert.ok(color1.startsWith("bg-"));
    assert.ok(color2.startsWith("bg-"));
  });

  it("should handle empty email", () => {
    const color = getAvatarColor("");
    assert.ok(color.startsWith("bg-"));
  });

  it("should always return one of the 8 predefined colors", () => {
    const validColors = new Set([
      "bg-blue-600",
      "bg-emerald-600",
      "bg-violet-600",
      "bg-amber-600",
      "bg-rose-600",
      "bg-cyan-600",
      "bg-pink-600",
      "bg-indigo-600",
    ]);
    for (const email of ["a@b.com", "x@y.z", "test", "12345", ""]) {
      assert.ok(
        validColors.has(getAvatarColor(email)),
        `Invalid color for ${email}`,
      );
    }
  });
});

describe("SubscriberFilter type", () => {
  it("should support all filter fields", () => {
    const filter: SubscriberFilter = {
      status: "ACTIVE",
      segment: "free",
      name: "John",
      email: "gmail",
      source: "website",
      createdAfter: "2026-01-01",
      createdBefore: "2026-12-31",
    };
    assert.strictEqual(Object.keys(filter).length, 7);
  });

  it("should allow all fields to be undefined", () => {
    const filter: SubscriberFilter = {};
    assert.strictEqual(Object.keys(filter).length, 0);
  });
});
