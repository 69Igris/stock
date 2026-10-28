/**
 * feedback.service + feedback-logic — REAL exports, injected prisma (MONEY-402).
 *
 * Pins the two SECURITY-relevant behaviours + the mobile HTTP contract codes:
 *   - the plan-based monthly quota (FREE=3 … PREMIUM=unlimited) with a
 *     `QUOTA_EXCEEDED` code the route maps to 429,
 *   - the IDOR attachment guard — only the caller's own `feedback/{userId}/`
 *     paths persist (forged/foreign/traversal paths are dropped),
 *   - the type allow-list (`INVALID_INPUT` code → 400 at the route),
 *   - every read/write scoped to the caller's userId; a thrown query fails
 *     closed to a sanitised error.
 *
 * Source: packages/services/src/feedback.service.ts + feedback-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkFeedbackQuota,
  resolveFeedbackLimit,
  filterOwnedImagePaths,
  isValidFeedbackType,
  isValidFeedbackStatus,
  monthStartUtc,
} from "../src/feedback-logic";
import {
  submitFeedback,
  getUserFeedback,
  type FeedbackServiceDeps,
} from "../src/feedback.service";

// ── pure logic ───────────────────────────────────────────────────────────────

describe("feedback-logic quota", () => {
  it("FREE allows up to 3/month then blocks", () => {
    assert.equal(checkFeedbackQuota("FREE", 2).allowed, true);
    const blocked = checkFeedbackQuota("FREE", 3);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.reason?.includes("limit"));
  });

  it("PREMIUM/ULTIMATE are unlimited (-1)", () => {
    assert.equal(resolveFeedbackLimit("PREMIUM"), -1);
    assert.equal(checkFeedbackQuota("PREMIUM", 9999).allowed, true);
  });

  it("unknown plan defaults to 3; a non-finite count → 0 used", () => {
    assert.equal(resolveFeedbackLimit("MYSTERY"), 3);
    assert.equal(checkFeedbackQuota("FREE", Number.NaN).used, 0);
  });
});

describe("feedback-logic IDOR attachment filter", () => {
  it("keeps only the caller's own paths, drops foreign/traversal/dupes and caps at 3", () => {
    const out = filterOwnedImagePaths(
      [
        "feedback/u1/a.png",
        "feedback/u2/secret.png", // foreign → drop
        "feedback/u1/../u2/x.png", // traversal → drop
        "feedback/u1/a.png", // dup → drop
        "feedback/u1/b.png",
        "feedback/u1/c.png",
        "feedback/u1/d.png", // over cap → drop
      ],
      "u1",
    );
    assert.deepEqual(out, [
      "feedback/u1/a.png",
      "feedback/u1/b.png",
      "feedback/u1/c.png",
    ]);
  });

  it("returns [] for a non-array or missing userId", () => {
    assert.deepEqual(filterOwnedImagePaths("nope", "u1"), []);
    assert.deepEqual(filterOwnedImagePaths(["feedback/u1/a.png"], ""), []);
  });

  it("isValidFeedbackType allow-lists the enum", () => {
    assert.equal(isValidFeedbackType("BUG"), true);
    assert.equal(isValidFeedbackType("OTHER"), true);
    assert.equal(isValidFeedbackType("HACK"), false);
    assert.equal(isValidFeedbackType(42), false);
  });

  it("isValidFeedbackStatus allow-lists the enum", () => {
    assert.equal(isValidFeedbackStatus("OPEN"), true);
    assert.equal(isValidFeedbackStatus("DUPLICATE"), true);
    assert.equal(isValidFeedbackStatus("open"), false); // case-sensitive
    assert.equal(isValidFeedbackStatus("GARBAGE"), false);
    assert.equal(isValidFeedbackStatus(undefined), false);
  });

  it("monthStartUtc pins to the 1st at 00:00 UTC", () => {
    const d = monthStartUtc(new Date("2026-07-17T09:30:00Z"));
    assert.equal(d.toISOString(), "2026-07-01T00:00:00.000Z");
  });
});

// ── service (injected prisma + clock) ────────────────────────────────────────

interface Call {
  where?: unknown;
  data?: Record<string, unknown>;
  select?: unknown;
  include?: unknown;
  skip?: number;
  take?: number;
  orderBy?: unknown;
}
function fake(delegates: Record<string, (args: Call) => unknown>): {
  prisma: FeedbackServiceDeps["prisma"];
  calls: Record<string, Call[]>;
} {
  const calls: Record<string, Call[]> = {};
  const db: Record<string, Record<string, (a: Call) => unknown>> = {};
  for (const key of Object.keys(delegates)) {
    const [model, method] = key.split(".");
    db[model] ??= {};
    db[model][method] = async (args: Call) => {
      (calls[key] ??= []).push(args);
      return delegates[key](args);
    };
  }
  return { prisma: db as unknown as FeedbackServiceDeps["prisma"], calls };
}

const FIXED = () => new Date("2026-07-10T00:00:00Z");

describe("feedback.service submitFeedback", () => {
  it("rejects an invalid type with INVALID_INPUT before any DB work", async () => {
    let touched = false;
    const { prisma } = fake({
      "subscription.findUnique": () => {
        touched = true;
        return null;
      },
    });
    const res = await submitFeedback(
      "u1",
      { type: "HACK", title: "t", description: "d" },
      { prisma, now: FIXED },
    );
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "INVALID_INPUT");
    assert.equal(touched, false); // returned before the subscription lookup
  });

  it("blocks over-quota with QUOTA_EXCEEDED and never creates", async () => {
    let created = false;
    const { prisma } = fake({
      "subscription.findUnique": () => ({ planId: "FREE" }),
      "feedback.count": () => 3,
      "feedback.create": () => {
        created = true;
        return {};
      },
    });
    const res = await submitFeedback(
      "u1",
      { type: "BUG", title: "t", description: "d" },
      { prisma, now: FIXED },
    );
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "QUOTA_EXCEEDED");
    assert.equal(created, false);
  });

  it("creates with filtered images + scoped userId on the happy path", async () => {
    const { prisma, calls } = fake({
      "subscription.findUnique": () => ({ planId: "PRO" }),
      "feedback.count": () => 0,
      "feedback.create": (a) => ({
        id: "f1",
        userId: "u1",
        type: (a.data?.type as string) ?? "BUG",
        title: "t",
        description: "d",
        images: a.data?.images ?? [],
        status: "OPEN",
        priority: "MEDIUM",
        page: null,
        adminNote: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    });
    const res = await submitFeedback(
      "u1",
      {
        type: "BUG",
        title: "t",
        description: "d",
        images: ["feedback/u1/ok.png", "feedback/u2/evil.png"],
      },
      { prisma, now: FIXED },
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.id, "f1");
      assert.equal(res.data.replyCount, 0);
    }
    const data = calls["feedback.create"]?.[0]?.data;
    assert.equal(data?.userId, "u1");
    assert.deepEqual(data?.images, ["feedback/u1/ok.png"]); // foreign path dropped
  });

  it("fails closed with a sanitised error when create throws", async () => {
    const { prisma } = fake({
      "subscription.findUnique": () => ({ planId: "PRO" }),
      "feedback.count": () => 0,
      "feedback.create": () => {
        throw new Error("write conflict");
      },
    });
    const res = await submitFeedback(
      "u1",
      { type: "BUG", title: "t", description: "d" },
      { prisma, now: FIXED },
    );
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.error, "Failed to submit feedback");
  });
});

describe("feedback.service getUserFeedback", () => {
  it("scopes the WHERE to the caller and maps replyCount + total", async () => {
    const { prisma, calls } = fake({
      "feedback.findMany": () => [
        {
          id: "f1",
          userId: "u1",
          type: "BUG",
          title: "t",
          description: "d",
          images: [],
          status: "OPEN",
          priority: null,
          page: null,
          adminNote: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          _count: { replies: 2 },
        },
      ],
      "feedback.count": () => 1,
    });
    const res = await getUserFeedback("u1", { status: "OPEN" }, { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.total, 1);
      assert.equal(res.data.items[0]?.replyCount, 2);
    }
    const where = calls["feedback.findMany"]?.[0]?.where as Record<
      string,
      unknown
    >;
    assert.equal(where.userId, "u1"); // IDOR: always scoped
    assert.equal(where.status, "OPEN");
  });

  it("drops an invalid ?status/?type filter instead of 500-ing on the enum", async () => {
    const { prisma, calls } = fake({
      "feedback.findMany": () => [],
      "feedback.count": () => 0,
    });
    // A garbage status/type passed straight into a Prisma enum column throws
    // ("Invalid enum value") → 500. The service must drop the invalid filter and
    // still return (unfiltered), never surface a 500 for a bad query param.
    const res = await getUserFeedback(
      "u1",
      { status: "garbage", type: "nope" },
      { prisma },
    );
    assert.equal(res.success, true);
    const where = calls["feedback.findMany"]?.[0]?.where as Record<
      string,
      unknown
    >;
    assert.equal(where.userId, "u1");
    assert.equal(where.status, undefined); // invalid → dropped
    assert.equal(where.type, undefined); // invalid → dropped
  });

  it("fails closed with a sanitised error when the query throws", async () => {
    const { prisma } = fake({
      "feedback.findMany": () => {
        throw new Error("Mongo down");
      },
      "feedback.count": () => 0,
    });
    const res = await getUserFeedback("u1", {}, { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.error, "Failed to fetch feedback");
  });
});
