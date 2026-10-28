/**
 * P4e user/me + feedback-thread services — REAL exports, injected prisma
 * (MONEY-1062 P4e).
 *
 * Pins the DB-half behaviours the apps/api /v1/me + /v1/feedback routes wrap:
 *   - email prefs/segments raw read + write (effective-merge stays route-side),
 *   - login-briefing read + IDOR-guarded mark-viewed,
 *   - walkthrough state + seen/reset/snooze with the mirrored version allow-list,
 *   - feedback thread read (with an INJECTED image signer), reply (IDOR
 *     attachment filter), and close (already-closed guard).
 *
 * ESM suite → inject a fake prisma (and signer) via `deps`.
 *
 * Source: packages/services/src/user.service.ts + user-logic.ts + feedback.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getRawEmailPreferences,
  writeEmailPreferences,
  getEmailSegmentState,
  setNewsletterSubscription,
  getLatestBriefing,
  markBriefingViewed,
  getWalkthroughState,
  markWalkthroughSeen,
  resetWalkthrough,
  snoozeWalkthrough,
} from "../src/user.service";
import {
  getFeedbackThread,
  addFeedbackReply,
  closeUserFeedback,
} from "../src/feedback.service";

// ── flexible fake prisma ─────────────────────────────────────────────────────
// Each test supplies the table methods it needs; a spies array records calls so
// we can assert IDOR scoping + write payloads.
function fakePrisma(tables: Record<string, Record<string, unknown>>) {
  return tables as never;
}

// ════════════════════════════════════════════════════════════════════════════
// Email preferences (raw read/write) + segments
// ════════════════════════════════════════════════════════════════════════════

describe("getRawEmailPreferences", () => {
  it("returns the raw JSON scoped to the caller", async () => {
    let whereSeen: unknown;
    const prisma = fakePrisma({
      user: {
        findUnique: async (args: { where: unknown }) => {
          whereSeen = args.where;
          return { emailPreferences: { marketingEmails: false } };
        },
      },
    });
    const res = await getRawEmailPreferences("u1", { prisma });
    assert.ok(res.success);
    assert.deepEqual(res.success && res.data.emailPreferences, {
      marketingEmails: false,
    });
    assert.deepEqual(whereSeen, { id: "u1" });
  });

  it("404s a missing user", async () => {
    const prisma = fakePrisma({ user: { findUnique: async () => null } });
    const res = await getRawEmailPreferences("u1", { prisma });
    assert.equal(!res.success && res.code, "NOT_FOUND");
  });
});

describe("writeEmailPreferences", () => {
  it("persists the prefs verbatim and returns contact + previous/updated", async () => {
    let writtenData: unknown;
    const prisma = fakePrisma({
      user: {
        findUnique: async () => ({
          email: "a@b.com",
          name: "A B",
          emailPreferences: { marketingEmails: false },
        }),
        update: async (args: { data: { emailPreferences: unknown } }) => {
          writtenData = args.data.emailPreferences;
          return { emailPreferences: args.data.emailPreferences };
        },
      },
    });
    const next = { marketingEmails: true, aiInsights: true };
    const res = await writeEmailPreferences("u1", next, { prisma });
    assert.ok(res.success);
    assert.deepEqual(writtenData, next);
    assert.equal(res.success && res.data.email, "a@b.com");
    assert.deepEqual(res.success && res.data.previous, {
      marketingEmails: false,
    });
    assert.deepEqual(res.success && res.data.updated, next);
  });
});

describe("getEmailSegmentState", () => {
  it("reports newsletter ACTIVE + returns raw prefs (marketing derived route-side)", async () => {
    const prisma = fakePrisma({
      user: {
        findUnique: async () => ({
          email: "a@b.com",
          emailPreferences: { marketingEmails: true },
        }),
      },
      newsletterSubscriber: {
        findUnique: async () => ({ status: "ACTIVE" }),
      },
    });
    const res = await getEmailSegmentState("u1", { prisma });
    assert.ok(res.success);
    assert.equal(res.success && res.data.newsletterActive, true);
    assert.deepEqual(res.success && res.data.emailPreferences, {
      marketingEmails: true,
    });
  });

  it("newsletter is inactive when there is no ACTIVE subscriber row", async () => {
    const prisma = fakePrisma({
      user: {
        findUnique: async () => ({ email: "a@b.com", emailPreferences: {} }),
      },
      newsletterSubscriber: { findUnique: async () => null },
    });
    const res = await getEmailSegmentState("u1", { prisma });
    assert.ok(res.success);
    assert.equal(res.success && res.data.newsletterActive, false);
  });
});

describe("setNewsletterSubscription", () => {
  it("upserts an ACTIVE subscriber on subscribe", async () => {
    let upsertArgs:
      | { update: Record<string, unknown>; create: Record<string, unknown> }
      | undefined;
    const prisma = fakePrisma({
      user: { findUnique: async () => ({ email: "a@b.com", name: "A B" }) },
      newsletterSubscriber: {
        upsert: async (args: {
          update: Record<string, unknown>;
          create: Record<string, unknown>;
        }) => {
          upsertArgs = args;
          return {};
        },
      },
    });
    const res = await setNewsletterSubscription("u1", true, {
      prisma,
      now: () => new Date("2026-07-11T00:00:00Z"),
    });
    assert.ok(res.success);
    assert.equal(upsertArgs?.update.status, "ACTIVE");
    assert.deepEqual(upsertArgs?.update.segments, ["newsletter"]);
  });

  it("404s when the user has no email", async () => {
    const prisma = fakePrisma({
      user: { findUnique: async () => ({ email: null, name: null }) },
    });
    const res = await setNewsletterSubscription("u1", false, { prisma });
    assert.equal(!res.success && res.code, "NOT_FOUND");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Login briefing
// ════════════════════════════════════════════════════════════════════════════

describe("getLatestBriefing", () => {
  it("returns today's unread briefing (ISO timestamps)", async () => {
    const prisma = fakePrisma({
      loginBriefing: {
        findFirst: async () => ({
          id: "b1",
          summary: "s",
          sections: [{ x: 1 }],
          portfolioValue: 100,
          dayChange: -2,
          briefingDate: new Date("2026-07-11T00:00:00.000Z"),
          completedAt: new Date("2026-07-11T06:00:00.000Z"),
        }),
      },
    });
    const res = await getLatestBriefing("u1", { prisma });
    assert.ok(res.success);
    assert.equal(res.success && res.data?.id, "b1");
    assert.equal(
      res.success && res.data?.briefingDate,
      "2026-07-11T00:00:00.000Z",
    );
    assert.equal(
      res.success && res.data?.completedAt,
      "2026-07-11T06:00:00.000Z",
    );
  });

  it("returns null (success) when there is no briefing", async () => {
    const prisma = fakePrisma({
      loginBriefing: { findFirst: async () => null },
    });
    const res = await getLatestBriefing("u1", { prisma });
    assert.ok(res.success);
    assert.equal(res.success && res.data, null);
  });
});

describe("markBriefingViewed", () => {
  it("marks viewed for the owner", async () => {
    let updated = false;
    const prisma = fakePrisma({
      loginBriefing: {
        findUnique: async () => ({ userId: "u1" }),
        update: async () => {
          updated = true;
          return {};
        },
      },
    });
    const res = await markBriefingViewed("u1", "b1", { prisma });
    assert.ok(res.success);
    assert.equal(updated, true);
  });

  it("IDOR: refuses a briefing owned by another user (404, no update)", async () => {
    let updated = false;
    const prisma = fakePrisma({
      loginBriefing: {
        findUnique: async () => ({ userId: "someone_else" }),
        update: async () => {
          updated = true;
          return {};
        },
      },
    });
    const res = await markBriefingViewed("u1", "b1", { prisma });
    assert.equal(!res.success && res.code, "NOT_FOUND");
    assert.equal(updated, false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Walkthrough
// ════════════════════════════════════════════════════════════════════════════

describe("getWalkthroughState", () => {
  it("returns seen versions + snooze map + current version", async () => {
    const prisma = fakePrisma({
      user: {
        findUnique: async () => ({
          walkthroughVersionsSeen: ["v1-core"],
          preferences: {
            walkthrough: {
              snoozedUntil: { "v1-core": "2026-08-01T00:00:00.000Z" },
            },
          },
        }),
      },
    });
    const res = await getWalkthroughState("u1", { prisma });
    assert.ok(res.success);
    assert.deepEqual(res.success && res.data.seenVersions, ["v1-core"]);
    assert.deepEqual(res.success && res.data.snoozedUntil, {
      "v1-core": "2026-08-01T00:00:00.000Z",
    });
    assert.equal(res.success && res.data.currentVersion, "v1-core");
  });
});

describe("markWalkthroughSeen", () => {
  it("rejects an unknown version (INVALID_INPUT) BEFORE any DB read", async () => {
    let read = false;
    const prisma = fakePrisma({
      user: {
        findUnique: async () => {
          read = true;
          return null;
        },
      },
    });
    const res = await markWalkthroughSeen("u1", "v9-ghost", { prisma });
    assert.equal(!res.success && res.code, "INVALID_INPUT");
    assert.equal(read, false);
  });

  it("is an idempotent no-op when the version was already seen", async () => {
    let updated = false;
    const prisma = fakePrisma({
      user: {
        findUnique: async () => ({ walkthroughVersionsSeen: ["v1-core"] }),
        update: async () => {
          updated = true;
          return { walkthroughVersionsSeen: ["v1-core"] };
        },
      },
    });
    const res = await markWalkthroughSeen("u1", "v1-core", { prisma });
    assert.ok(res.success);
    assert.equal(updated, false); // no write on a repeat
  });

  it("pushes a newly-seen version", async () => {
    let pushed: unknown;
    const prisma = fakePrisma({
      user: {
        findUnique: async () => ({ walkthroughVersionsSeen: [] }),
        update: async (args: {
          data: { walkthroughVersionsSeen: unknown };
        }) => {
          pushed = args.data.walkthroughVersionsSeen;
          return { walkthroughVersionsSeen: ["v1-core"] };
        },
      },
    });
    const res = await markWalkthroughSeen("u1", "v1-core", { prisma });
    assert.ok(res.success);
    assert.deepEqual(pushed, { push: "v1-core" });
  });
});

describe("resetWalkthrough", () => {
  it("removes the version from seen and clears its snooze", async () => {
    let data:
      | {
          walkthroughVersionsSeen: unknown;
          preferences: Record<string, unknown>;
        }
      | undefined;
    const prisma = fakePrisma({
      user: {
        findUnique: async () => ({
          walkthroughVersionsSeen: ["v1-core"],
          preferences: {
            walkthrough: {
              snoozedUntil: { "v1-core": "2026-08-01T00:00:00.000Z" },
            },
          },
        }),
        update: async (args: { data: typeof data }) => {
          data = args.data;
          return { walkthroughVersionsSeen: [] };
        },
      },
    });
    const res = await resetWalkthrough("u1", "v1-core", { prisma });
    assert.ok(res.success);
    assert.deepEqual(data?.walkthroughVersionsSeen, { set: [] });
    const wt = data?.preferences.walkthrough as {
      snoozedUntil: Record<string, string>;
    };
    assert.deepEqual(wt.snoozedUntil, {}); // snooze cleared for the version
  });
});

describe("snoozeWalkthrough", () => {
  it("rejects an un-parseable timestamp (INVALID_INPUT)", async () => {
    const prisma = fakePrisma({
      user: { findUnique: async () => ({ preferences: {} }) },
    });
    const res = await snoozeWalkthrough("u1", "v1-core", "not-a-date", {
      prisma,
    });
    assert.equal(!res.success && res.code, "INVALID_INPUT");
  });

  it("writes the snooze into preferences without clobbering siblings", async () => {
    let written: Record<string, unknown> | undefined;
    const prisma = fakePrisma({
      user: {
        findUnique: async () => ({
          preferences: { research: { style: "deep" } },
        }),
        update: async (args: {
          data: { preferences: Record<string, unknown> };
        }) => {
          written = args.data.preferences;
          return {};
        },
      },
    });
    const res = await snoozeWalkthrough(
      "u1",
      "v1-core",
      "2026-08-01T00:00:00.000Z",
      { prisma },
    );
    assert.ok(res.success);
    // sibling namespace preserved
    assert.deepEqual(written?.research, { style: "deep" });
    const wt = written?.walkthrough as { snoozedUntil: Record<string, string> };
    assert.equal(wt.snoozedUntil["v1-core"], "2026-08-01T00:00:00.000Z");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Feedback thread
// ════════════════════════════════════════════════════════════════════════════

describe("getFeedbackThread", () => {
  it("IDOR-scopes the read and resolves signed image URLs via the injected signer", async () => {
    let whereSeen: unknown;
    const prisma = fakePrisma({
      feedback: {
        findFirst: async (args: { where: unknown }) => {
          whereSeen = args.where;
          return {
            id: "f1",
            userId: "u1",
            type: "BUG",
            title: "T",
            description: "D",
            images: ["feedback/u1/a.png"],
            status: "OPEN",
            priority: null,
            page: null,
            adminNote: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            replies: [
              {
                id: "r1",
                message: "hi",
                images: ["feedback/u1/b.png"],
                isAdmin: false,
                createdAt: new Date(),
              },
            ],
            _count: { replies: 1 },
          };
        },
      },
    });
    const signed: string[] = [];
    const res = await getFeedbackThread("u1", "f1", {
      prisma,
      signImageUrl: async (p) => {
        signed.push(p);
        return `https://signed/${p}`;
      },
    });
    assert.ok(res.success);
    assert.deepEqual(whereSeen, { id: "f1", userId: "u1" }); // IDOR
    assert.deepEqual(res.success && res.data.feedback.imageUrls, [
      "https://signed/feedback/u1/a.png",
    ]);
    assert.equal(
      res.success && res.data.replies[0].imageUrls[0],
      "https://signed/feedback/u1/b.png",
    );
    assert.equal(res.success && res.data.feedback.replyCount, 1);
  });

  it("404s a non-owned / absent ticket", async () => {
    const prisma = fakePrisma({ feedback: { findFirst: async () => null } });
    const res = await getFeedbackThread("u1", "f1", {
      prisma,
      signImageUrl: async () => "",
    });
    assert.equal(!res.success && res.code, "NOT_FOUND");
  });
});

describe("addFeedbackReply", () => {
  it("verifies ownership, IDOR-filters reply images, and touches the parent", async () => {
    let createdImages: unknown;
    let touched = false;
    const prisma = fakePrisma({
      feedback: {
        findFirst: async () => ({ id: "f1" }),
        update: async () => {
          touched = true;
          return {};
        },
      },
      feedbackReply: {
        create: async (args: { data: { images: unknown } }) => {
          createdImages = args.data.images;
          return {
            id: "r1",
            message: "thanks",
            images: args.data.images,
            isAdmin: false,
            createdAt: new Date(),
          };
        },
      },
    });
    const res = await addFeedbackReply(
      "u1",
      {
        feedbackId: "f1",
        message: "thanks",
        images: [
          "feedback/u1/ok.png", // own → kept
          "feedback/u2/foreign.png", // foreign → dropped
        ],
      },
      { prisma, signImageUrl: async (p) => `https://signed/${p}` },
    );
    assert.ok(res.success);
    // IDOR attachment filter kept ONLY the caller's own path.
    assert.deepEqual(createdImages, ["feedback/u1/ok.png"]);
    assert.equal(touched, true); // parent updatedAt bumped
    assert.equal(
      res.success && res.data.imageUrls[0],
      "https://signed/feedback/u1/ok.png",
    );
  });

  it("404s when the parent ticket is not the caller's", async () => {
    const prisma = fakePrisma({ feedback: { findFirst: async () => null } });
    const res = await addFeedbackReply(
      "u1",
      { feedbackId: "f1", message: "hi" },
      { prisma },
    );
    assert.equal(!res.success && res.code, "NOT_FOUND");
  });

  it("rejects an empty/whitespace message (INVALID_INPUT) before any DB work", async () => {
    let read = false;
    const prisma = fakePrisma({
      feedback: {
        findFirst: async () => {
          read = true;
          return { id: "f1" };
        },
      },
    });
    const res = await addFeedbackReply(
      "u1",
      { feedbackId: "f1", message: "   " },
      { prisma },
    );
    assert.equal(!res.success && res.code, "INVALID_INPUT");
    assert.equal(read, false);
  });
});

describe("closeUserFeedback", () => {
  it("closes an open ticket (COMPLETED)", async () => {
    const prisma = fakePrisma({
      feedback: {
        findFirst: async () => ({ id: "f1", status: "OPEN" }),
        update: async () => ({ id: "f1", status: "COMPLETED" }),
      },
    });
    const res = await closeUserFeedback("u1", "f1", { prisma });
    assert.ok(res.success);
    assert.equal(res.success && res.data.status, "COMPLETED");
  });

  it("guards an already-closed ticket (ALREADY_CLOSED, no update)", async () => {
    let updated = false;
    const prisma = fakePrisma({
      feedback: {
        findFirst: async () => ({ id: "f1", status: "COMPLETED" }),
        update: async () => {
          updated = true;
          return {};
        },
      },
    });
    const res = await closeUserFeedback("u1", "f1", { prisma });
    assert.equal(!res.success && res.code, "ALREADY_CLOSED");
    assert.equal(updated, false);
  });

  it("404s a non-owned ticket", async () => {
    const prisma = fakePrisma({ feedback: { findFirst: async () => null } });
    const res = await closeUserFeedback("u1", "f1", { prisma });
    assert.equal(!res.success && res.code, "NOT_FOUND");
  });
});
