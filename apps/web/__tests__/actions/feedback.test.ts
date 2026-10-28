/**
 * MONEY-620 — feedback server actions END-TO-END (real handlers, real Zod).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a textbook SHADOW: under "// VALIDATION LOGIC
 * (mirrors …)" + "// SIMULATED ACTION LOGIC (mirrors feedback.ts)" it re-declared
 * `validateCreateFeedback`, `validateFeedbackFilters`, `simulateSubmitFeedback`,
 * `simulateGetUserFeedback`, `simulateGetFeedbackCounts` (and a parallel
 * in-memory store) — then asserted the COPIES. It imported NOTHING from
 * `lib/actions/feedback.ts`. So every gate that actually protects a user's
 * feedback (the auth gate, the real `CreateFeedbackSchema`/`FeedbackFilterSchema`
 * Zod parse, the plan-based monthly LIMIT, and — most importantly — the IDOR
 * walls that scope every read/write to `user.userId` and verify thread/reply
 * ownership via `findFirst({ where: { id, userId } })`) were unexercised.
 *
 * This rewrite drives the REAL exported actions through the `require.cache` seam
 * with `@usemoney/validation` kept REAL (genuine Zod), asserting the action's
 * OWN logic — NOT a reimplementation:
 *   - submitFeedbackAction: unauth → Unauthorized (no DB); real Zod rejects
 *     short title / short description / bad type / >5 images BEFORE any write;
 *     plan limit (FREE=3) blocks the 4th submission this month; PREMIUM is
 *     unlimited; the created row carries the CALLER userId (IDOR).
 *   - getUserFeedbackAction: unauth gate; the findMany/count WHERE is scoped to
 *     the caller userId (IDOR) + forwards status/type/skip/limit.
 *   - getFeedbackThreadAction / addFeedbackReplyAction / closeUserFeedbackAction:
 *     the ownership lookup is `findFirst({ where: { id, userId: caller } })`; a
 *     miss yields "Feedback not found" and NO reply create / NO status update /
 *     NO signed URL — the load-bearing IDOR wall a reimplementation never sees.
 *   - getFeedbackCountsAction: unauth gate; every count is caller-scoped.
 *
 * `@/lib/auth`, `@usemoney/database`, `@/lib/storage/signed-urls` are recorded
 * stubs. (`@usemoney/email` is dynamically imported only on the PREMIUM email
 * path, fire-and-forget; we keep PREMIUM out of the create assertions to avoid
 * loading it, and never await it.)
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/feedback.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── recorders ───────────────────────────────────────────────────────────────

interface PrismaCall {
  model: string;
  method: string;
  args: unknown;
}

interface Harness {
  user: { userId: string } | null;
  /** subscription.findUnique result (controls plan limits) */
  subscription: { planId: string } | null;
  /** user.findUnique result (email/name for metadata) */
  dbUser: { email: string | null; name: string | null } | null;
  /** feedback.count return, keyed by a label we infer from the where clause */
  feedbackCount: number;
  /** feedback.create return row */
  createdFeedback: Record<string, unknown>;
  /** feedback.findFirst result (ownership lookup) — null = not owned/not found */
  ownedFeedback: Record<string, unknown> | null;
  /** feedback.findMany result */
  feedbackList: Array<Record<string, unknown>>;
  /** feedbackReply.create return */
  createdReply: Record<string, unknown>;
  prismaCalls: PrismaCall[];
  signedUrlCalls: string[];
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}

const ACTION_REL = "../../lib/actions/feedback";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

function freshHarness(): Harness {
  return {
    user: { userId: "internal-user-1" },
    subscription: { planId: "FREE" },
    dbUser: { email: "u@x.com", name: "User" },
    feedbackCount: 0,
    createdFeedback: {
      id: "fb-1",
      userId: "internal-user-1",
      type: "BUG",
      title: "A valid title",
      description: "A valid description here",
      images: [],
      status: "OPEN",
      priority: null,
      page: null,
      adminNote: null,
      createdAt: new Date("2026-02-01T00:00:00Z"),
      updatedAt: new Date("2026-02-01T00:00:00Z"),
    },
    ownedFeedback: null,
    feedbackList: [],
    createdReply: {
      id: "reply-1",
      message: "a reply",
      images: [],
      isAdmin: false,
      createdAt: new Date("2026-02-01T00:00:00Z"),
    },
    prismaCalls: [],
    signedUrlCalls: [],
  };
}

interface ActionResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

interface FeedbackModule {
  submitFeedbackAction: (data: unknown) => Promise<ActionResponse<unknown>>;
  getUserFeedbackAction: (
    filters?: unknown
  ) => Promise<ActionResponse<{ items: unknown[]; total: number }>>;
  getFeedbackThreadAction: (id: string) => Promise<ActionResponse<unknown>>;
  addFeedbackReplyAction: (data: unknown) => Promise<ActionResponse<unknown>>;
  closeUserFeedbackAction: (
    id: string
  ) => Promise<ActionResponse<{ id: string; status: string }>>;
  getFeedbackCountsAction: () => Promise<ActionResponse<unknown>>;
}

function makeRecordingPrisma(h: Harness): unknown {
  return {
    subscription: {
      findUnique: (args: unknown) => {
        h.prismaCalls.push({
          model: "subscription",
          method: "findUnique",
          args,
        });
        return Promise.resolve(h.subscription);
      },
    },
    user: {
      findUnique: (args: unknown) => {
        h.prismaCalls.push({ model: "user", method: "findUnique", args });
        return Promise.resolve(h.dbUser);
      },
    },
    feedback: {
      count: (args: unknown) => {
        h.prismaCalls.push({ model: "feedback", method: "count", args });
        return Promise.resolve(h.feedbackCount);
      },
      create: (args: unknown) => {
        h.prismaCalls.push({ model: "feedback", method: "create", args });
        return Promise.resolve(h.createdFeedback);
      },
      findFirst: (args: unknown) => {
        h.prismaCalls.push({ model: "feedback", method: "findFirst", args });
        return Promise.resolve(h.ownedFeedback);
      },
      findMany: (args: unknown) => {
        h.prismaCalls.push({ model: "feedback", method: "findMany", args });
        return Promise.resolve(h.feedbackList);
      },
      update: (args: unknown) => {
        h.prismaCalls.push({ model: "feedback", method: "update", args });
        const data = (args as { data?: Record<string, unknown> }).data ?? {};
        return Promise.resolve({ id: "fb-1", status: "COMPLETED", ...data });
      },
    },
    feedbackReply: {
      create: (args: unknown) => {
        h.prismaCalls.push({
          model: "feedbackReply",
          method: "create",
          args,
        });
        return Promise.resolve(h.createdReply);
      },
    },
  };
}

function loadAction(h: Harness): FeedbackModule {
  const cache = moduleCache();

  const authPath = require.resolve("../../lib/auth");
  const dbPath = require.resolve("@usemoney/database");
  const signedPath = require.resolve("../../lib/storage/signed-urls");
  const actionPath = require.resolve(ACTION_REL);

  for (const p of [authPath, dbPath, signedPath]) snapshotOnce(p);

  cache[authPath] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: () => Promise.resolve(h.user),
    },
  };
  const prismaDouble = makeRecordingPrisma(h);
  cache[dbPath] = {
    exports: {
      __esModule: true,
      prisma: prismaDouble,
      default: prismaDouble,
    },
  };
  cache[signedPath] = {
    exports: {
      __esModule: true,
      generateSignedUrl: (path: string) => {
        h.signedUrlCalls.push(path);
        return Promise.resolve(`https://signed.example/${path}`);
      },
    },
  };

  delete cache[actionPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as FeedbackModule;
}

const validCreate = {
  type: "BUG" as const,
  title: "Submit button broken",
  description: "The submit button does not respond to clicks at all",
};

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — feedback actions (real handlers, real Zod, mocked I/O)", () => {
  let h: Harness;
  beforeEach(() => {
    h = freshHarness();
  });
  after(() => {
    restoreCache();
  });

  describe("submitFeedbackAction", () => {
    it("unauthenticated → Unauthorized, nothing written", async () => {
      h.user = null;
      const action = loadAction(h);
      const res = await action.submitFeedbackAction(validCreate);
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Unauthorized/);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("real Zod rejects a short title before any DB write", async () => {
      const action = loadAction(h);
      const res = await action.submitFeedbackAction({
        ...validCreate,
        title: "Hi",
      });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /at least 5 characters/);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("real Zod rejects a short description before any DB write", async () => {
      const action = loadAction(h);
      const res = await action.submitFeedbackAction({
        ...validCreate,
        description: "short",
      });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /at least 10 characters/);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("real Zod rejects an invalid feedback type", async () => {
      const action = loadAction(h);
      const res = await action.submitFeedbackAction({
        ...validCreate,
        type: "NONSENSE",
      });
      assert.equal(res.success, false);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("real Zod rejects more than 5 images", async () => {
      const action = loadAction(h);
      const res = await action.submitFeedbackAction({
        ...validCreate,
        images: ["a", "b", "c", "d", "e", "f"],
      });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Maximum 5 images/);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("FREE plan: blocks the submission once the monthly limit (3) is reached", async () => {
      h.subscription = { planId: "FREE" };
      h.feedbackCount = 3; // already at the cap this month
      const action = loadAction(h);
      const res = await action.submitFeedbackAction(validCreate);
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /monthly feedback limit/);
      // No feedback.create when the limit is hit.
      assert.equal(
        h.prismaCalls.some(
          (c) => c.model === "feedback" && c.method === "create"
        ),
        false
      );
    });

    it("FREE plan under the limit: creates the row under the CALLER userId (IDOR)", async () => {
      h.subscription = { planId: "FREE" };
      h.feedbackCount = 1;
      const action = loadAction(h);
      const res = await action.submitFeedbackAction(validCreate);
      assert.equal(res.success, true);
      const create = h.prismaCalls.find(
        (c) => c.model === "feedback" && c.method === "create"
      );
      assert.ok(create);
      const data = (create!.args as { data: Record<string, unknown> }).data;
      assert.equal(data.userId, "internal-user-1");
      assert.equal(data.type, "BUG");
      // The monthly count was scoped to the caller too.
      const count = h.prismaCalls.find(
        (c) => c.model === "feedback" && c.method === "count"
      );
      assert.equal(
        (count!.args as { where: { userId: string } }).where.userId,
        "internal-user-1"
      );
    });

    it("PREMIUM plan: unlimited — no monthly count gate at all", async () => {
      h.subscription = { planId: "PREMIUM" };
      h.dbUser = { email: "", name: "User" }; // empty email → email path no-ops
      const action = loadAction(h);
      const res = await action.submitFeedbackAction(validCreate);
      assert.equal(res.success, true);
      // PREMIUM skips the monthly feedback.count entirely (limit === -1).
      assert.equal(
        h.prismaCalls.some(
          (c) => c.model === "feedback" && c.method === "count"
        ),
        false,
        "unlimited plan must not run the monthly count"
      );
    });
  });

  describe("getUserFeedbackAction", () => {
    it("unauthenticated → Unauthorized, no DB", async () => {
      h.user = null;
      const action = loadAction(h);
      const res = await action.getUserFeedbackAction({});
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Unauthorized/);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("IDOR: the findMany + count WHERE is scoped to the caller userId", async () => {
      h.feedbackList = [];
      const action = loadAction(h);
      const res = await action.getUserFeedbackAction({
        status: "OPEN",
        skip: 5,
        limit: 10,
      });
      assert.equal(res.success, true);
      const findMany = h.prismaCalls.find((c) => c.method === "findMany");
      const where = (findMany!.args as { where: Record<string, unknown> })
        .where;
      assert.equal(where.userId, "internal-user-1");
      assert.equal(where.status, "OPEN");
      assert.equal((findMany!.args as { skip: number; take: number }).skip, 5);
      assert.equal((findMany!.args as { take: number }).take, 10);
    });

    it("real Zod rejects a limit over 50 (Invalid filters)", async () => {
      const action = loadAction(h);
      const res = await action.getUserFeedbackAction({ limit: 100 });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Invalid filters/);
      assert.equal(h.prismaCalls.length, 0);
    });
  });

  describe("getFeedbackThreadAction (IDOR ownership wall)", () => {
    it("a not-owned / not-found thread → 'Feedback not found', NO signed URL", async () => {
      h.ownedFeedback = null;
      const action = loadAction(h);
      const res = await action.getFeedbackThreadAction("someone-elses");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found/i);
      assert.equal(h.signedUrlCalls.length, 0);
      // The lookup was scoped to the caller.
      const find = h.prismaCalls.find((c) => c.method === "findFirst");
      const where = (find!.args as { where: Record<string, unknown> }).where;
      assert.equal(where.id, "someone-elses");
      assert.equal(where.userId, "internal-user-1");
    });

    it("an owned thread mints signed image URLs for its images", async () => {
      h.ownedFeedback = {
        id: "fb-1",
        userId: "internal-user-1",
        type: "BUG",
        title: "t",
        description: "d",
        images: ["feedback/img-a.png"],
        status: "OPEN",
        priority: null,
        page: null,
        adminNote: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        replies: [],
        _count: { replies: 0 },
      };
      const action = loadAction(h);
      const res = await action.getFeedbackThreadAction("fb-1");
      assert.equal(res.success, true);
      assert.deepEqual(h.signedUrlCalls, ["feedback/img-a.png"]);
    });
  });

  describe("addFeedbackReplyAction (IDOR ownership wall)", () => {
    it("a not-owned feedback → 'Feedback not found', NO reply created", async () => {
      h.ownedFeedback = null;
      const action = loadAction(h);
      const res = await action.addFeedbackReplyAction({
        feedbackId: "someone-elses",
        message: "trying to reply",
      });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found/i);
      assert.equal(
        h.prismaCalls.some((c) => c.model === "feedbackReply"),
        false,
        "must not create a reply on a feedback the caller does not own"
      );
    });

    it("real Zod rejects an empty message before the ownership lookup", async () => {
      const action = loadAction(h);
      const res = await action.addFeedbackReplyAction({
        feedbackId: "fb-1",
        message: "",
      });
      assert.equal(res.success, false);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("an owned feedback: creates the reply under the caller userId (IDOR)", async () => {
      h.ownedFeedback = { id: "fb-1" };
      const action = loadAction(h);
      const res = await action.addFeedbackReplyAction({
        feedbackId: "fb-1",
        message: "here is my reply",
      });
      assert.equal(res.success, true);
      const create = h.prismaCalls.find((c) => c.model === "feedbackReply");
      const data = (create!.args as { data: Record<string, unknown> }).data;
      assert.equal(data.userId, "internal-user-1");
      assert.equal(data.feedbackId, "fb-1");
      assert.equal(data.isAdmin, false);
    });
  });

  describe("closeUserFeedbackAction (IDOR + already-closed guard)", () => {
    it("a not-owned feedback → 'Feedback not found', NO update", async () => {
      h.ownedFeedback = null;
      const action = loadAction(h);
      const res = await action.closeUserFeedbackAction("someone-elses");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found/i);
      assert.equal(
        h.prismaCalls.some(
          (c) => c.model === "feedback" && c.method === "update"
        ),
        false
      );
      const find = h.prismaCalls.find((c) => c.method === "findFirst");
      assert.equal(
        (find!.args as { where: { userId: string } }).where.userId,
        "internal-user-1"
      );
    });

    it("an already-closed (COMPLETED) ticket → 'already closed', NO update", async () => {
      h.ownedFeedback = { id: "fb-1", status: "COMPLETED" };
      const action = loadAction(h);
      const res = await action.closeUserFeedbackAction("fb-1");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /already closed/);
      assert.equal(
        h.prismaCalls.some(
          (c) => c.model === "feedback" && c.method === "update"
        ),
        false
      );
    });

    it("an open owned ticket is set to COMPLETED", async () => {
      h.ownedFeedback = { id: "fb-1", status: "OPEN" };
      const action = loadAction(h);
      const res = await action.closeUserFeedbackAction("fb-1");
      assert.equal(res.success, true);
      assert.equal(res.data!.status, "COMPLETED");
      const update = h.prismaCalls.find(
        (c) => c.model === "feedback" && c.method === "update"
      );
      assert.equal(
        (update!.args as { data: { status: string } }).data.status,
        "COMPLETED"
      );
    });
  });

  describe("getFeedbackCountsAction", () => {
    it("unauthenticated → Unauthorized, no DB", async () => {
      h.user = null;
      const action = loadAction(h);
      const res = await action.getFeedbackCountsAction();
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Unauthorized/);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("IDOR: every count query is scoped to the caller userId", async () => {
      h.feedbackCount = 4;
      const action = loadAction(h);
      const res = await action.getFeedbackCountsAction();
      assert.equal(res.success, true);
      const counts = h.prismaCalls.filter(
        (c) => c.model === "feedback" && c.method === "count"
      );
      assert.equal(counts.length, 5, "total + 4 statuses");
      for (const c of counts) {
        const where = (c.args as { where: Record<string, unknown> }).where;
        assert.equal(where.userId, "internal-user-1");
      }
    });
  });
});
