/**
 * MONEY-1062 P4e Parity HTTP Contract Tests — API Server
 *
 * Contract coverage for the ADDITIVE parity endpoints wired in P4e:
 *
 *   Subscription mgmt (subscription.ts):
 *     POST /v1/subscription/downgrade          ← downgradeWithGracePeriodAction
 *     POST /v1/subscription/refresh-pending    ← refreshPendingPaymentsAction
 *     POST /v1/subscription/schedule-cancel    ← scheduleCancelAction
 *     POST /v1/subscription/schedule-downgrade ← scheduleDowngradeAction
 *     POST /v1/subscription/unschedule         ← unscheduleChangeAction
 *     GET  /v1/subscription/preview-change     ← previewPlanChangeAction
 *     GET  /v1/subscription/ai-credits         ← checkAICreditsAction
 *   Feedback thread (feedback.ts):
 *     GET  /v1/feedback/:id/thread             ← getFeedbackThreadAction
 *     POST /v1/feedback/:id/replies            ← addFeedbackReplyAction
 *     POST /v1/feedback/:id/close              ← closeUserFeedbackAction
 *   Me surface (me.ts):
 *     GET|PATCH /v1/me/email-preferences       ← get/updateEmailPreferencesAction
 *     GET|POST  /v1/me/email-segments          ← get/toggleEmailSegmentSubscriptionAction
 *     GET  /v1/me/briefing + POST /viewed       ← get/markBriefingViewedAction
 *     GET|POST  /v1/me/walkthrough             ← walkthrough.ts (seen/reset/snooze)
 *     GET|PUT   /v1/me/gst-profile             ← get/setMyGstProfileAction
 *
 * Same ESM stubbing seam as parity-p1a-contract: `require.cache` seeded with a
 * `@usemoney/services` Proxy (+ a nested `gst` namespace Proxy), a
 * `@usemoney/email` recorder (segment + audience sync + effective-prefs merge),
 * `@usemoney/email/templates`, `@usemoney/pubsub/publish`, and a configurable
 * `@clerk/backend` verifier — then the apps/api/src modules are purged and
 * re-required so their imports resolve to the stubs.
 *
 * The Dodo client is NEVER touched here: subscription-management Dodo I/O lives
 * in the SERVICE (stubbed away by the services Proxy). The "no Dodo call on a
 * gate failure" assertion lives in the service test.
 *
 * Source: apps/api/src/routes/v1/{subscription,feedback,me}.ts
 *         apps/api/src/middleware/{auth,request-id}.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type ModuleCache = Record<string, { exports: unknown } | undefined>;
const cache = (require as unknown as { cache: ModuleCache }).cache;

// ── configurable Clerk verifier ─────────────────────────────────────────────
let verifyImpl: (token: string) => Promise<{ sub?: string }>;
const clerkStub = {
  __esModule: true,
  verifyToken: (token: string) => verifyImpl(token),
};

// ── configurable @usemoney/services (+ nested gst namespace) ────────────────
const serviceImpls = new Map<string, (...args: unknown[]) => unknown>();
function setService(name: string, fn: (...args: unknown[]) => unknown): void {
  serviceImpls.set(name, fn);
}
const gstImpls = new Map<string, (...args: unknown[]) => unknown>();
function setGst(name: string, fn: (...args: unknown[]) => unknown): void {
  gstImpls.set(name, fn);
}
const gstStub = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop === "__esModule") return true;
    if (prop === "then") return undefined;
    return (...args: unknown[]) => {
      const impl = gstImpls.get(prop);
      if (!impl) return Promise.reject(new Error(`gst-not-stubbed:${prop}`));
      return impl(...args);
    };
  },
});
const servicesStub = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop === "__esModule") return true;
    if (prop === "then") return undefined;
    if (prop === "default") return servicesStub;
    if (prop === "gst") return gstStub;
    return (...args: unknown[]) => {
      const impl = serviceImpls.get(prop);
      return impl
        ? impl(...args)
        : Promise.resolve({ success: false, error: `not-stubbed:${prop}` });
    };
  },
});

// ── @usemoney/email recorder ─────────────────────────────────────────────────
// A tiny effective-prefs merge (mirror of the real one: raw over defaults) so
// the route's GET/PATCH have a real shape to return, plus segment + audience
// sync recorders. EMAIL_SEGMENTS is a STABLE array whose element fields tests
// mutate (a not-configured segment sets audienceId = undefined).
const DEFAULT_EMAIL_PREFERENCES = {
  brokerNotifications: true,
  tradeAlerts: true,
  paymentNotifications: true,
  aiInsights: true,
  marketingEmails: true,
  tipsEducation: true,
  partnerOffers: false,
  usageAnalytics: true,
} as const;
type EmailPrefs = Record<string, boolean>;
function effective(raw: unknown): EmailPrefs {
  const out: EmailPrefs = { ...DEFAULT_EMAIL_PREFERENCES };
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(DEFAULT_EMAIL_PREFERENCES)) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}
const segmentCalls: Array<{
  op: "add" | "remove";
  segment: string;
  args: unknown[];
}> = [];
const audienceCalls: Array<{
  op: "add" | "remove";
  segment: string;
  input: unknown;
}> = [];
// Configurable audience-sync outcome (C3#5): the REAL helpers never throw —
// failure is `{ ok: false, error }` — so tests flip this to drive the
// route's fail-the-toggle branch. Reset to ok in beforeEach.
let audienceSyncResult: { ok: boolean; error?: string } = { ok: true };
const EMAIL_SEGMENTS: Array<{ id: string; audienceId: string | undefined }> = [
  { id: "newsletter", audienceId: "aud_news" },
  { id: "marketing", audienceId: "aud_mkt" },
];
const emailStub = {
  __esModule: true,
  getEffectivePreferences: (raw: unknown) => effective(raw),
  DEFAULT_EMAIL_PREFERENCES,
  EMAIL_SEGMENTS,
  sendEmail: () => Promise.resolve({ success: true }),
  addContactToSegment: (...args: unknown[]) => {
    segmentCalls.push({ op: "add", segment: String(args[0]), args });
    return Promise.resolve({ success: true });
  },
  removeContactFromSegment: (...args: unknown[]) => {
    segmentCalls.push({ op: "remove", segment: String(args[0]), args });
    return Promise.resolve({ success: true });
  },
  addToAudience: (segment: string, input: unknown) => {
    audienceCalls.push({ op: "add", segment, input });
    return Promise.resolve(audienceSyncResult);
  },
  removeFromAudience: (segment: string, input: unknown) => {
    audienceCalls.push({ op: "remove", segment, input });
    return Promise.resolve(audienceSyncResult);
  },
};
const templatesStub = {
  __esModule: true,
  DeleteAccountOtpEmail: (props: Record<string, unknown>) => ({ __otp: props }),
};
const publishStub = {
  __esModule: true,
  publishAccountDeletionJob: () => Promise.resolve("msg_1"),
};

// ── install stubs + load the REAL app pieces via require() ──────────────────
const saved: Array<[string, { exports: unknown } | undefined]> = [];
function stub(path: string, exports: unknown): void {
  saved.push([path, cache[path]]);
  cache[path] = { exports };
}

interface Harness {
  request: (input: string, init?: RequestInit) => Promise<Response>;
}
let app: Harness;

before(() => {
  stub(require.resolve("@usemoney/services"), servicesStub);
  stub(require.resolve("@usemoney/services/preferences"), servicesStub);
  stub(require.resolve("@clerk/backend"), clerkStub);
  stub(require.resolve("@usemoney/email"), emailStub);
  stub(require.resolve("@usemoney/email/templates"), templatesStub);
  stub(require.resolve("@usemoney/pubsub/publish"), publishStub);
  for (const key of Object.keys(cache)) {
    if (key.includes("/apps/api/src/")) {
      saved.push([key, cache[key]]);
      delete cache[key];
    }
  }

  const { Hono } = require("hono") as {
    Hono: new () => Harness & Record<string, (...a: unknown[]) => unknown>;
  };
  const { authMiddleware } = require("../../src/middleware/auth.ts");
  const { requestIdMiddleware } = require("../../src/middleware/request-id.ts");
  const v1Routes = (
    require("../../src/routes/v1/index.ts") as { default: unknown }
  ).default;

  const instance = new Hono();
  instance.use("*", requestIdMiddleware);
  instance.use("/v1/*", authMiddleware);
  instance.route("/v1", v1Routes);
  app = instance as unknown as Harness;
});

after(() => {
  for (const [path, prior] of saved) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  saved.length = 0;
});

const AUTH = { Authorization: "Bearer test-token" } as const;
const JSON_HEADERS = { ...AUTH, "Content-Type": "application/json" } as const;

const PROFILE_OK = {
  success: true,
  data: {
    id: "mongo_1",
    email: "shaswat@example.com",
    name: "Shaswat Deep",
    preferredCurrency: "INR",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
} as const;

beforeEach(() => {
  verifyImpl = async () => ({ sub: "clerk_default" });
  serviceImpls.clear();
  gstImpls.clear();
  setService("resolveUserId", async () => "mongo_1");
  segmentCalls.length = 0;
  audienceCalls.length = 0;
  audienceSyncResult = { ok: true };
  // Reset EMAIL_SEGMENTS to fully-provisioned before each test.
  EMAIL_SEGMENTS[0].audienceId = "aud_news";
  EMAIL_SEGMENTS[1].audienceId = "aud_mkt";
});

// ════════════════════════════════════════════════════════════════════════════
// Subscription management
// ════════════════════════════════════════════════════════════════════════════

describe("P4e Contract: POST /v1/subscription/downgrade", () => {
  it("returns the grace-period end date on success", async () => {
    setService("downgradeWithGracePeriod", async (userId: unknown) => {
      assert.equal(userId, "mongo_1"); // scoped to the resolved Mongo id
      return {
        success: true,
        data: { gracePeriodEndDate: "2026-08-01T00:00:00.000Z" },
      };
    });
    const res = await app.request("/v1/subscription/downgrade", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(
      (await res.json()).data.gracePeriodEndDate,
      "2026-08-01T00:00:00.000Z",
    );
  });

  it("passes through an undefined gracePeriodEndDate (immediate FREE)", async () => {
    setService("downgradeWithGracePeriod", async () => ({
      success: true,
      data: {},
    }));
    const res = await app.request("/v1/subscription/downgrade", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.gracePeriodEndDate, undefined);
  });

  it("maps a service failure to 500", async () => {
    setService("downgradeWithGracePeriod", async () => ({
      success: false,
      error: "No active subscription found",
    }));
    const res = await app.request("/v1/subscription/downgrade", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 500);
  });
});

describe("P4e Contract: POST /v1/subscription/refresh-pending", () => {
  it("returns the updated count", async () => {
    setService("refreshPendingPayments", async () => ({
      success: true,
      data: { updated: 3 },
    }));
    const res = await app.request("/v1/subscription/refresh-pending", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.updated, 3);
  });
});

describe("P4e Contract: POST /v1/subscription/schedule-cancel", () => {
  it("returns scheduledEffectiveAt on success", async () => {
    setService("scheduleSubscriptionCancel", async () => ({
      success: true,
      data: { scheduledEffectiveAt: "2026-08-01T00:00:00.000Z" },
    }));
    const res = await app.request("/v1/subscription/schedule-cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(
      (await res.json()).data.scheduledEffectiveAt,
      "2026-08-01T00:00:00.000Z",
    );
  });

  it("maps NOT_FOUND → 404", async () => {
    setService("scheduleSubscriptionCancel", async () => ({
      success: false,
      error: "No active subscription found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/subscription/schedule-cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });

  it("maps ALREADY_FREE → 409", async () => {
    setService("scheduleSubscriptionCancel", async () => ({
      success: false,
      error: "You are already on the Free plan",
      code: "ALREADY_FREE",
    }));
    const res = await app.request("/v1/subscription/schedule-cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "CONFLICT");
  });

  it("maps NO_TERM_END → 409", async () => {
    setService("scheduleSubscriptionCancel", async () => ({
      success: false,
      error:
        "Could not determine your billing period end date. Please contact support.",
      code: "NO_TERM_END",
    }));
    const res = await app.request("/v1/subscription/schedule-cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 409);
  });
});

describe("P4e Contract: POST /v1/subscription/schedule-downgrade", () => {
  it("forwards a valid body to the service", async () => {
    let seen: unknown[] = [];
    setService("scheduleSubscriptionDowngrade", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { scheduledEffectiveAt: "2026-08-01T00:00:00.000Z" },
      };
    });
    const res = await app.request("/v1/subscription/schedule-downgrade", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ targetPlanId: "PRO", targetCycle: "monthly" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "PRO", "monthly"]);
  });

  it("rejects a bad targetPlanId with 400 BEFORE any service call", async () => {
    let called = false;
    setService("scheduleSubscriptionDowngrade", async () => {
      called = true;
      return { success: true, data: { scheduledEffectiveAt: "x" } };
    });
    const res = await app.request("/v1/subscription/schedule-downgrade", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ targetPlanId: "FREE", targetCycle: "monthly" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("maps NOT_FOUND → 404", async () => {
    setService("scheduleSubscriptionDowngrade", async () => ({
      success: false,
      error: "No active subscription found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/subscription/schedule-downgrade", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ targetPlanId: "PRO", targetCycle: "annual" }),
    });
    assert.equal(res.status, 404);
  });
});

describe("P4e Contract: POST /v1/subscription/unschedule", () => {
  it("returns unscheduled:true on success", async () => {
    setService("unscheduleSubscriptionChange", async () => ({
      success: true,
      data: { unscheduled: true },
    }));
    const res = await app.request("/v1/subscription/unschedule", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.unscheduled, true);
  });

  it("maps COUPON_GRANT → 409", async () => {
    setService("unscheduleSubscriptionChange", async () => ({
      success: false,
      error:
        "This plan was granted by a coupon and ends at the end of its term — it can't be extended.",
      code: "COUPON_GRANT",
    }));
    const res = await app.request("/v1/subscription/unschedule", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 409);
  });
});

describe("P4e Contract: GET /v1/subscription/preview-change", () => {
  it("forwards targetPlanId + targetCycle and returns the preview", async () => {
    let seen: unknown[] = [];
    setService("previewSubscriptionChange", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: {
          kind: "tier_upgrade",
          daysRemaining: 10,
          bonusDays: 4,
          newTermDays: 34,
          willChargeToday: true,
        },
      };
    });
    const res = await app.request(
      "/v1/subscription/preview-change?targetPlanId=PREMIUM&targetCycle=monthly",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.kind, "tier_upgrade");
    assert.deepEqual(seen, ["mongo_1", "PREMIUM", "monthly"]);
  });

  it("treats an omitted targetCycle as null (e.g. cancel/FREE)", async () => {
    let seen: unknown[] = [];
    setService("previewSubscriptionChange", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: {
          kind: "cancel",
          daysRemaining: 5,
          effectiveAt: null,
          willChargeToday: false,
        },
      };
    });
    const res = await app.request(
      "/v1/subscription/preview-change?targetPlanId=FREE",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "FREE", null]);
  });

  it("rejects a missing targetPlanId with 400", async () => {
    const res = await app.request("/v1/subscription/preview-change", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
  });

  it("rejects a bad targetCycle with 400", async () => {
    const res = await app.request(
      "/v1/subscription/preview-change?targetPlanId=PRO&targetCycle=weekly",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
  });
});

describe("P4e Contract: GET /v1/subscription/ai-credits", () => {
  it("composes getSubscription + the credit pre-flight verdict", async () => {
    setService("getSubscription", async () => ({
      success: true,
      data: { planId: "PRO", creditsLimit: 50, creditsUsed: 10 },
    }));
    setService("computeAiCreditsPreflight", () => ({
      allowed: true,
      reason: "ok",
      planId: "PRO",
    }));
    const res = await app.request("/v1/subscription/ai-credits", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.allowed, true);
    assert.equal(body.data.reason, "ok");
    assert.equal(body.data.planId, "PRO");
  });

  it("fails closed to the FREE verdict (200) on a subscription read failure", async () => {
    setService("getSubscription", async () => ({
      success: false,
      error: "db down",
    }));
    const res = await app.request("/v1/subscription/ai-credits", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.allowed, false);
    assert.equal(body.data.reason, "free");
    assert.equal(body.data.planId, "FREE");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Feedback thread
// ════════════════════════════════════════════════════════════════════════════

describe("P4e Contract: GET /v1/feedback/:id/thread", () => {
  it("returns the thread on success", async () => {
    let seen: unknown[] = [];
    setService("getFeedbackThread", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: {
          feedback: { id: "f1", title: "T", imageUrls: [] },
          replies: [{ id: "r1", message: "hi", imageUrls: [], isAdmin: false }],
        },
      };
    });
    const res = await app.request("/v1/feedback/f1/thread", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.feedback.id, "f1");
    assert.equal(body.data.replies.length, 1);
    assert.deepEqual(seen, ["mongo_1", "f1"]); // (userId, feedbackId)
  });

  it("maps NOT_FOUND → 404 (IDOR / non-owned id)", async () => {
    setService("getFeedbackThread", async () => ({
      success: false,
      error: "Feedback not found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/feedback/other/thread", {
      headers: AUTH,
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });
});

describe("P4e Contract: POST /v1/feedback/:id/replies", () => {
  it("creates a reply and returns 201", async () => {
    let seen: unknown[] = [];
    setService("addFeedbackReply", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { id: "r2", message: "thanks", imageUrls: [] },
      };
    });
    const res = await app.request("/v1/feedback/f1/replies", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        message: "thanks",
        images: ["feedback/mongo_1/a.png"],
      }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).data.id, "r2");
    assert.deepEqual(seen[0], "mongo_1");
    assert.deepEqual(seen[1], {
      feedbackId: "f1",
      message: "thanks",
      images: ["feedback/mongo_1/a.png"],
    });
  });

  it("rejects an empty message with 400 BEFORE any service call", async () => {
    let called = false;
    setService("addFeedbackReply", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/feedback/f1/replies", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ message: "" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("maps NOT_FOUND → 404", async () => {
    setService("addFeedbackReply", async () => ({
      success: false,
      error: "Feedback not found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/feedback/x/replies", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ message: "hi" }),
    });
    assert.equal(res.status, 404);
  });
});

describe("P4e Contract: POST /v1/feedback/:id/close", () => {
  it("closes the ticket on success", async () => {
    setService("closeUserFeedback", async () => ({
      success: true,
      data: { id: "f1", status: "COMPLETED" },
    }));
    const res = await app.request("/v1/feedback/f1/close", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.status, "COMPLETED");
  });

  it("maps ALREADY_CLOSED → 409", async () => {
    setService("closeUserFeedback", async () => ({
      success: false,
      error: "Ticket already closed",
      code: "ALREADY_CLOSED",
    }));
    const res = await app.request("/v1/feedback/f1/close", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 409);
  });

  it("maps NOT_FOUND → 404", async () => {
    setService("closeUserFeedback", async () => ({
      success: false,
      error: "Feedback not found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/feedback/z/close", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Me — email preferences + segments
// ════════════════════════════════════════════════════════════════════════════

describe("P4e Contract: GET /v1/me/email-preferences", () => {
  it("returns the effective prefs merged over defaults", async () => {
    setService("getRawEmailPreferences", async () => ({
      success: true,
      data: { emailPreferences: { marketingEmails: false } },
    }));
    const res = await app.request("/v1/me/email-preferences", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.marketingEmails, false); // overridden
    assert.equal(body.data.aiInsights, true); // default
  });

  it("maps NOT_FOUND → 404", async () => {
    setService("getRawEmailPreferences", async () => ({
      success: false,
      error: "User not found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/me/email-preferences", {
      headers: AUTH,
    });
    assert.equal(res.status, 404);
  });
});

describe("P4e Contract: PATCH /v1/me/email-preferences", () => {
  const fullPrefs = (over: Record<string, boolean> = {}) => ({
    ...DEFAULT_EMAIL_PREFERENCES,
    ...over,
  });

  it("persists and fires the marketing sync when the flag flips ON", async () => {
    setService(
      "writeEmailPreferences",
      async (_u: unknown, prefs: unknown) => ({
        success: true,
        data: {
          email: "shaswat@example.com",
          name: "Shaswat Deep",
          previous: { marketingEmails: false },
          updated: prefs,
        },
      }),
    );
    const res = await app.request("/v1/me/email-preferences", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(fullPrefs({ marketingEmails: true })),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.marketingEmails, true);
    // marketing flipped false→true → an add-to-segment call was recorded.
    assert.equal(segmentCalls.length, 1);
    assert.equal(segmentCalls[0].op, "add");
    assert.equal(segmentCalls[0].segment, "marketing");
  });

  it("does NOT fire the segment sync when marketing is unchanged", async () => {
    setService(
      "writeEmailPreferences",
      async (_u: unknown, prefs: unknown) => ({
        success: true,
        data: {
          email: "shaswat@example.com",
          name: "Shaswat Deep",
          previous: { marketingEmails: true },
          updated: prefs,
        },
      }),
    );
    const res = await app.request("/v1/me/email-preferences", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(fullPrefs({ marketingEmails: true })),
    });
    assert.equal(res.status, 200);
    assert.equal(segmentCalls.length, 0);
  });

  it("rejects a non-boolean key with 400 BEFORE any service call", async () => {
    let called = false;
    setService("writeEmailPreferences", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const bad = { ...fullPrefs(), aiInsights: "yes" };
    const res = await app.request("/v1/me/email-preferences", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(bad),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });
});

describe("P4e Contract: GET /v1/me/email-segments", () => {
  it("returns newsletter + derived marketing state", async () => {
    setService("getEmailSegmentState", async () => ({
      success: true,
      data: {
        email: "shaswat@example.com",
        newsletterActive: true,
        emailPreferences: { marketingEmails: false },
      },
    }));
    const res = await app.request("/v1/me/email-segments", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.newsletter, true);
    assert.equal(body.data.marketing, false);
  });
});

describe("P4e Contract: POST /v1/me/email-segments", () => {
  it("newsletter subscribe → audience add + newsletter persist", async () => {
    setService("getUserProfile", async () => PROFILE_OK);
    let persistArgs: unknown[] = [];
    setService("setNewsletterSubscription", async (...args: unknown[]) => {
      persistArgs = args;
      return {
        success: true,
        data: { email: "shaswat@example.com", name: "Shaswat Deep" },
      };
    });
    const res = await app.request("/v1/me/email-segments", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ segment: "newsletter", subscribed: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(audienceCalls.length, 1);
    assert.equal(audienceCalls[0].op, "add");
    assert.equal(audienceCalls[0].segment, "newsletter");
    assert.deepEqual(persistArgs, ["mongo_1", true]);
  });

  it("marketing subscribe → audience add + merged prefs write", async () => {
    setService("getUserProfile", async () => PROFILE_OK);
    setService("getRawEmailPreferences", async () => ({
      success: true,
      data: { emailPreferences: { marketingEmails: false } },
    }));
    let writtenPrefs: Record<string, unknown> | undefined;
    setService("writeEmailPreferences", async (_u: unknown, prefs: unknown) => {
      writtenPrefs = prefs as Record<string, unknown>;
      return {
        success: true,
        data: { email: null, name: null, previous: null, updated: prefs },
      };
    });
    const res = await app.request("/v1/me/email-segments", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ segment: "marketing", subscribed: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(audienceCalls[0].segment, "marketing");
    assert.equal(writtenPrefs?.marketingEmails, true); // merged flag written
  });

  it("a not-configured segment → 409 with NO audience call", async () => {
    EMAIL_SEGMENTS[1].audienceId = undefined; // marketing not provisioned
    setService("getUserProfile", async () => PROFILE_OK);
    const res = await app.request("/v1/me/email-segments", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ segment: "marketing", subscribed: true }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.message, "marketing-not-configured");
    assert.equal(audienceCalls.length, 0);
  });

  it("a failed audience sync ({ok:false}) FAILS the toggle → 500 with NO DB persist (C3#5)", async () => {
    // addToAudience/removeFromAudience NEVER throw — the {ok:false} return
    // used to be ignored, silently diverging DB-vs-Resend. Now it 500s
    // (retry-able) BEFORE the DB write.
    audienceSyncResult = { ok: false, error: "resend 503" };
    setService("getUserProfile", async () => PROFILE_OK);
    let persisted = false;
    setService("setNewsletterSubscription", async () => {
      persisted = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/me/email-segments", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ segment: "newsletter", subscribed: true }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.match(body.error.message, /try again/i); // retry-able message
    assert.equal(audienceCalls.length, 1); // the sync WAS attempted…
    assert.equal(persisted, false); // …but nothing hit the DB
  });

  it("an UNSUBSCRIBE with a failed removeFromAudience also 500s before the prefs write (compliance direction)", async () => {
    audienceSyncResult = { ok: false, error: "resend timeout" };
    setService("getUserProfile", async () => PROFILE_OK);
    let readRaw = false;
    let wrote = false;
    setService("getRawEmailPreferences", async () => {
      readRaw = true;
      return { success: true, data: { emailPreferences: {} } };
    });
    setService("writeEmailPreferences", async () => {
      wrote = true;
      return {
        success: true,
        data: { email: null, name: null, previous: null, updated: {} },
      };
    });
    const res = await app.request("/v1/me/email-segments", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ segment: "marketing", subscribed: false }),
    });
    assert.equal(res.status, 500);
    assert.equal(audienceCalls[0]?.op, "remove");
    // The user must not be told "unsubscribed" while still in the audience:
    // no prefs read-merge-write happened.
    assert.equal(readRaw, false);
    assert.equal(wrote, false);
  });

  it("rejects an invalid body with 400", async () => {
    const res = await app.request("/v1/me/email-segments", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ segment: "spam", subscribed: true }),
    });
    assert.equal(res.status, 400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Me — briefing
// ════════════════════════════════════════════════════════════════════════════

describe("P4e Contract: GET /v1/me/briefing", () => {
  it("returns the briefing payload", async () => {
    setService("getLatestBriefing", async () => ({
      success: true,
      data: {
        id: "b1",
        summary: "hi",
        sections: [],
        portfolioValue: 1,
        dayChange: 0,
        briefingDate: "2026-07-11T00:00:00.000Z",
        completedAt: null,
      },
    }));
    const res = await app.request("/v1/me/briefing", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.id, "b1");
  });

  it("passes through a null (no briefing) as data:null", async () => {
    setService("getLatestBriefing", async () => ({
      success: true,
      data: null,
    }));
    const res = await app.request("/v1/me/briefing", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data, null);
  });
});

describe("P4e Contract: POST /v1/me/briefing/viewed", () => {
  it("marks viewed on success", async () => {
    let seen: unknown[] = [];
    setService("markBriefingViewed", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: undefined };
    });
    const res = await app.request("/v1/me/briefing/viewed", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ briefingId: "b1" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.viewed, true);
    assert.deepEqual(seen, ["mongo_1", "b1"]);
  });

  it("maps NOT_FOUND → 404 (non-owned briefing)", async () => {
    setService("markBriefingViewed", async () => ({
      success: false,
      error: "Briefing not found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/me/briefing/viewed", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ briefingId: "nope" }),
    });
    assert.equal(res.status, 404);
  });

  it("rejects a missing briefingId with 400", async () => {
    const res = await app.request("/v1/me/briefing/viewed", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Me — walkthrough
// ════════════════════════════════════════════════════════════════════════════

describe("P4e Contract: GET /v1/me/walkthrough", () => {
  it("returns the walkthrough state", async () => {
    setService("getWalkthroughState", async () => ({
      success: true,
      data: {
        seenVersions: ["v1-core"],
        snoozedUntil: {},
        currentVersion: "v1-core",
      },
    }));
    const res = await app.request("/v1/me/walkthrough", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data.seenVersions, ["v1-core"]);
  });
});

describe("P4e Contract: POST /v1/me/walkthrough", () => {
  it("action=seen → markWalkthroughSeen", async () => {
    let seen: unknown[] = [];
    setService("markWalkthroughSeen", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { seenVersions: ["v1-core"] } };
    });
    const res = await app.request("/v1/me/walkthrough", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ action: "seen", version: "v1-core" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "v1-core"]);
  });

  it("action=reset → resetWalkthrough", async () => {
    let called = false;
    setService("resetWalkthrough", async () => {
      called = true;
      return { success: true, data: { seenVersions: [] } };
    });
    const res = await app.request("/v1/me/walkthrough", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ action: "reset", version: "v1-core" }),
    });
    assert.equal(res.status, 200);
    assert.equal(called, true);
  });

  it("action=snooze WITHOUT until → 400 (no service call)", async () => {
    let called = false;
    setService("snoozeWalkthrough", async () => {
      called = true;
      return { success: true, data: { snoozedUntil: {} } };
    });
    const res = await app.request("/v1/me/walkthrough", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ action: "snooze", version: "v1-core" }),
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  it("action=snooze WITH until → snoozeWalkthrough", async () => {
    let seen: unknown[] = [];
    setService("snoozeWalkthrough", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { snoozedUntil: { "v1-core": "2026-08-01T00:00:00.000Z" } },
      };
    });
    const res = await app.request("/v1/me/walkthrough", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        action: "snooze",
        version: "v1-core",
        until: "2026-08-01T00:00:00.000Z",
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "v1-core", "2026-08-01T00:00:00.000Z"]);
  });

  it("maps INVALID_INPUT (unknown version) → 400", async () => {
    setService("markWalkthroughSeen", async () => ({
      success: false,
      error: "Unknown walkthrough version",
      code: "INVALID_INPUT",
    }));
    const res = await app.request("/v1/me/walkthrough", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ action: "seen", version: "v9-ghost" }),
    });
    assert.equal(res.status, 400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Me — GST profile
// ════════════════════════════════════════════════════════════════════════════

describe("P4e Contract: GET /v1/me/gst-profile", () => {
  it("returns the profile (or null) via the gst service", async () => {
    setGst("getUserGstProfile", async (userId: unknown) => {
      assert.equal(userId, "mongo_1");
      return { legalName: "Acme", address: "…", stateCode: "27" };
    });
    const res = await app.request("/v1/me/gst-profile", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.legalName, "Acme");
  });

  it("passes a null profile through", async () => {
    setGst("getUserGstProfile", async () => null);
    const res = await app.request("/v1/me/gst-profile", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data, null);
  });
});

describe("P4e Contract: PUT /v1/me/gst-profile", () => {
  it("saves a valid profile", async () => {
    let seen: unknown[] = [];
    setGst("setUserGstProfile", async (...args: unknown[]) => {
      seen = args;
      return {
        legalName: "Acme",
        address: "12 Main Street, Mumbai",
        stateCode: "27",
      };
    });
    const res = await app.request("/v1/me/gst-profile", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        legalName: "Acme",
        address: "12 Main Street, Mumbai",
        stateCode: "27",
      }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.legalName, "Acme");
    assert.equal(seen[0], "mongo_1");
  });

  it("maps a service ZodError → 400 with the field message", async () => {
    setGst("setUserGstProfile", async () => {
      const e = new Error("Invalid GSTIN format");
      e.name = "ZodError";
      (e as unknown as { issues: unknown }).issues = [
        { message: "Invalid GSTIN format" },
      ];
      throw e;
    });
    const res = await app.request("/v1/me/gst-profile", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        legalName: "Acme",
        address: "12 Main Street, Mumbai",
        stateCode: "27",
        gstin: "BADGSTIN",
      }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, "Invalid GSTIN format");
  });

  it("rejects a missing legalName with 400 (shape gate)", async () => {
    const res = await app.request("/v1/me/gst-profile", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ address: "12 Main Street", stateCode: "27" }),
    });
    assert.equal(res.status, 400);
  });
});
