/**
 * Phase C P4-B HTTP Contract Tests — engagement WRITE surface (MONEY-402)
 *
 * Drives the REAL Hono middleware + route handlers via `app.request(...)` for the
 * 4 extracted domains (quiz, feedback, alerts, consent) + the profile PATCH
 * endpoints (/v1/me/persona, /v1/me/preferences). Same ESM stubbing seam as the
 * other contract suites (a flat `@usemoney/services` Proxy + a configurable
 * `@clerk/backend` verifier).
 *
 * Per domain: happy path, ownership/quota → 404/429, 400 on bad input, and the
 * feedback attachment paths forwarded to the service (the IDOR filter itself is
 * unit-tested in feedback-service.test.ts; the signed UPLOAD flow is deferred).
 *
 * Source: apps/api/src/routes/v1/{quiz,feedback,alerts,consent,me}.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type ModuleCache = Record<string, { exports: unknown } | undefined>;
const cache = (require as unknown as { cache: ModuleCache }).cache;

let verifyImpl: (token: string) => Promise<{ sub?: string }>;
const clerkStub = {
  __esModule: true,
  verifyToken: (token: string) => verifyImpl(token),
};

const serviceImpls = new Map<string, (...args: unknown[]) => unknown>();
function setService(name: string, fn: (...args: unknown[]) => unknown): void {
  serviceImpls.set(name, fn);
}
const servicesStub = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop === "__esModule") return true;
    if (prop === "then") return undefined;
    if (prop === "default") return servicesStub;
    // VALUE export (not a service fn): me.ts builds `z.enum(VALID_DEFAULT_PAGES)`
    // at module load, so the Proxy must hand back the REAL array (mirror of
    // packages/services/src/user-logic.ts:103), not a forwarder function.
    if (prop === "VALID_DEFAULT_PAGES") return ["dashboard", "stocksage"];
    return (...args: unknown[]) => {
      const impl = serviceImpls.get(prop);
      return impl
        ? impl(...args)
        : Promise.resolve({ success: false, error: `not-stubbed:${prop}` });
    };
  },
});

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
  stub(require.resolve("@clerk/backend"), clerkStub);
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

beforeEach(() => {
  verifyImpl = async () => ({ sub: "clerk_default" });
  serviceImpls.clear();
  setService("resolveUserId", async () => "mongo_1");
});

// ── quiz ─────────────────────────────────────────────────────────────────────

describe("Contract: /v1/quizzes", () => {
  it("lists quiz-carrying lessons scoped to the caller", async () => {
    let seenUser: unknown;
    setService("listQuizzes", async (uid: unknown) => {
      seenUser = uid;
      return {
        success: true,
        data: [{ lessonId: "l1", title: "T", questionCount: 3 }],
      };
    });
    const res = await app.request("/v1/quizzes", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seenUser, "mongo_1");
    assert.equal((await res.json()).data[0].lessonId, "l1");
  });

  it("a lesson with no quiz → 404", async () => {
    setService("getQuiz", async () => ({
      success: false,
      error: "Quiz not found",
    }));
    const res = await app.request("/v1/quizzes/l9", { headers: AUTH });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });

  it("submit scores a valid positional payload (userId + lessonId + answers forwarded)", async () => {
    let seen: unknown[] = [];
    setService("submitQuiz", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { scorePct: 100, correctCount: 1 } };
    });
    const res = await app.request("/v1/quizzes/l1/submit", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ answers: [1, null, 0] }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.equal(seen[1], "l1");
    assert.deepEqual(seen[2], { answers: [1, null, 0] });
  });

  it("submit rejects a non-array answers payload with 400 (never reaches the service)", async () => {
    let called = false;
    setService("submitQuiz", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/quizzes/l1/submit", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ answers: "1,2,3" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });
});

// ── feedback ─────────────────────────────────────────────────────────────────

describe("Contract: /v1/feedback", () => {
  it("submits a ticket (201) and forwards the attachment paths to the service", async () => {
    let seenInput: { images?: string[] } | undefined;
    setService("submitFeedback", async (_uid: unknown, input: unknown) => {
      seenInput = input as { images?: string[] };
      return { success: true, data: { id: "f1", replyCount: 0 } };
    });
    const res = await app.request("/v1/feedback", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        type: "BUG",
        title: "Broken",
        description: "It broke",
        images: ["feedback/mongo_1/a.png"],
      }),
    });
    assert.equal(res.status, 201);
    // Attachment paths reach the service (which re-applies the IDOR filter).
    assert.deepEqual(seenInput?.images, ["feedback/mongo_1/a.png"]);
  });

  it("maps the plan quota to 429 (QUOTA_EXCEEDED)", async () => {
    setService("submitFeedback", async () => ({
      success: false,
      error: "Monthly limit reached",
      code: "QUOTA_EXCEEDED",
    }));
    const res = await app.request("/v1/feedback", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ type: "BUG", title: "t", description: "d" }),
    });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, "RATE_LIMIT_EXCEEDED");
  });

  it("rejects an unknown type with 400 (never reaches the service)", async () => {
    let called = false;
    setService("submitFeedback", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/feedback", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ type: "HACK", title: "t", description: "d" }),
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  it("lists the caller's tickets paginated", async () => {
    setService("getUserFeedback", async () => ({
      success: true,
      data: { items: [{ id: "f1" }], total: 1 },
    }));
    const res = await app.request("/v1/feedback?limit=10", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, [{ id: "f1" }]);
    assert.equal(body.meta.total, 1);
  });

  it("forwards valid ?status/?type filters to the service (C3#12)", async () => {
    let seenFilters: { status?: string; type?: string } | undefined;
    setService("getUserFeedback", async (_uid: unknown, filters: unknown) => {
      seenFilters = filters as { status?: string; type?: string };
      return { success: true, data: { items: [], total: 0 } };
    });
    const res = await app.request("/v1/feedback?status=OPEN&type=BUG", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(seenFilters?.status, "OPEN");
    assert.equal(seenFilters?.type, "BUG");

    // Empty params still mean "no filter" (not a 400).
    const empty = await app.request("/v1/feedback?status=&type=", {
      headers: AUTH,
    });
    assert.equal(empty.status, 200);
    assert.equal(seenFilters?.status, undefined);
    assert.equal(seenFilters?.type, undefined);
  });

  it("rejects an unknown ?status / ?type with 400 (C3#12 — was a silent service drop → unfiltered 200)", async () => {
    let called = false;
    setService("getUserFeedback", async () => {
      called = true;
      return { success: true, data: { items: [], total: 0 } };
    });
    for (const qs of [
      "status=open", // wrong case
      "status=RESOLVED", // not a FeedbackStatus
      "type=HACK", // not a FeedbackType
      "status=OPEN&type=hack", // one good, one bad → still 400
    ]) {
      const res = await app.request(`/v1/feedback?${qs}`, { headers: AUTH });
      assert.equal(res.status, 400, `${qs} must 400`);
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(called, false);
  });
});

// ── alerts ───────────────────────────────────────────────────────────────────

describe("Contract: /v1/alerts", () => {
  it("lists the caller's alerts", async () => {
    let seenUser: unknown;
    setService("listAlerts", async (uid: unknown) => {
      seenUser = uid;
      return { success: true, data: [{ id: "a1", kind: "PRICE" }] };
    });
    const res = await app.request("/v1/alerts", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seenUser, "mongo_1");
  });

  it("creates an alert (201) and forwards the validated body", async () => {
    let seen: unknown[] = [];
    setService("createAlert", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { id: "a1" } };
    });
    const res = await app.request("/v1/alerts", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        kind: "PRICE",
        symbol: "TCS",
        conditions: { thresholdPrice: 100, direction: "above" },
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(seen[0], "mongo_1");
    assert.equal((seen[1] as { kind: string }).kind, "PRICE");
  });

  it("rejects an invalid kind with 400 (never reaches the service)", async () => {
    let called = false;
    setService("createAlert", async () => {
      called = true;
      return { success: true, data: { id: "x" } };
    });
    const res = await app.request("/v1/alerts", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: "HACK", conditions: {} }),
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  it("PATCH a foreign/absent id resolves as 404", async () => {
    setService("updateAlert", async () => ({
      success: false,
      error: "Alert not found",
    }));
    const res = await app.request("/v1/alerts/ghost", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: "PAUSED" }),
    });
    assert.equal(res.status, 404);
  });

  it("DELETE a foreign/absent id resolves as 404; an owned id succeeds", async () => {
    setService("deleteAlert", async () => ({
      success: false,
      error: "Alert not found",
    }));
    const gone = await app.request("/v1/alerts/ghost", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(gone.status, 404);

    setService("deleteAlert", async () => ({
      success: true,
      data: { id: "a1" },
    }));
    const ok = await app.request("/v1/alerts/a1", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(ok.status, 200);
  });
});

// ── consent ──────────────────────────────────────────────────────────────────

describe("Contract: /v1/consent", () => {
  it("GET composes the acceptance status + the exportable ledger", async () => {
    setService("getBrokerConsentStatus", async () => ({
      success: true,
      data: { accepted: true, version: "2026-05-30" },
    }));
    setService("getConsentRecords", async () => ({
      success: true,
      data: [
        {
          kind: "AI_ADVISORY",
          version: "2026-05-30",
          acceptedAt: new Date(),
          source: null,
        },
      ],
    }));
    const res = await app.request("/v1/consent", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.accepted, true);
    assert.equal(body.data.version, "2026-05-30");
    assert.equal(body.data.records.length, 1);
  });

  it("POST records consent and forwards the source", async () => {
    let seen: unknown[] = [];
    setService("recordBrokerConsent", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { accepted: true, version: "2026-05-30" } };
    });
    const res = await app.request("/v1/consent", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ source: "settings" }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.equal(seen[1], "settings");
  });

  it("POST rejects a non-string source with 400", async () => {
    const res = await app.request("/v1/consent", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ source: 123 }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
  });
});

// ── me PATCH ─────────────────────────────────────────────────────────────────

describe("Contract: PATCH /v1/me/persona", () => {
  it("sets a valid persona and returns it", async () => {
    let seen: unknown[] = [];
    setService("setComposerPreferences", async (...args: unknown[]) => {
      seen = args;
      return { tools: { persona: "marks" } };
    });
    const res = await app.request("/v1/me/persona", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ persona: "marks" }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.deepEqual(seen[1], { tools: { persona: "marks" } });
    assert.equal((await res.json()).data.persona, "marks");
  });

  it("accepts null (clear persona)", async () => {
    setService("setComposerPreferences", async () => ({
      tools: { persona: null },
    }));
    const res = await app.request("/v1/me/persona", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ persona: null }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.persona, null);
  });

  it("rejects an unknown persona with 400 (never reaches the service)", async () => {
    let called = false;
    setService("setComposerPreferences", async () => {
      called = true;
      return { tools: { persona: null } };
    });
    const res = await app.request("/v1/me/persona", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ persona: "buffett" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });
});

describe("Contract: PATCH /v1/me/preferences", () => {
  it("updates editable settings (mass-assignment guarded in the service)", async () => {
    let seen: unknown[] = [];
    setService("updateUserSettings", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { id: "mongo_1", name: "Ada", preferredCurrency: "USD" },
      };
    });
    const res = await app.request("/v1/me/preferences", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Ada", preferredCurrency: "USD" }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.deepEqual(seen[1], { name: "Ada", preferredCurrency: "USD" });
    assert.equal((await res.json()).data.name, "Ada");
  });

  it("rejects a malformed JSON body with 400 (never reaches the service)", async () => {
    let called = false;
    setService("updateUserSettings", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/me/preferences", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: "{ not json ",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "BAD_REQUEST");
    assert.equal(called, false);
  });

  it("echoes a just-set defaultPage in the PATCH response (C1#6 — D8 was write-only)", async () => {
    let seenPatch: unknown;
    setService("updateUserSettings", async (_uid: unknown, patch: unknown) => {
      seenPatch = patch;
      // The real service returns the UserProfile shape, which does NOT
      // include preferences.defaultPage — the route composes the echo.
      return {
        success: true,
        data: { id: "mongo_1", name: "Ada", preferredCurrency: "INR" },
      };
    });
    const res = await app.request("/v1/me/preferences", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ defaultPage: "stocksage" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seenPatch, { defaultPage: "stocksage" });
    const body = await res.json();
    assert.equal(body.data.defaultPage, "stocksage"); // input echo
    assert.equal(body.data.name, "Ada"); // profile fields preserved
  });

  it("omits defaultPage from the PATCH response when the patch didn't set it", async () => {
    setService("updateUserSettings", async () => ({
      success: true,
      data: { id: "mongo_1", name: "Ada", preferredCurrency: "USD" },
    }));
    const res = await app.request("/v1/me/preferences", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ preferredCurrency: "USD" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // The stored value is unknown without a service read — never invent one.
    assert.equal("defaultPage" in body.data, false);
  });

  it("rejects a defaultPage outside VALID_DEFAULT_PAGES with 400", async () => {
    let called = false;
    setService("updateUserSettings", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/me/preferences", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ defaultPage: "admin" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });
});
