/**
 * MONEY-1062 P1a Mobile-Parity HTTP Contract Tests — API Server
 *
 * Contract coverage for the parity-wave endpoints no other suite drives:
 * account deletion (POST /v1/me/delete-otp + DELETE /v1/me — the app-store
 * blocker; OTP email + Pub/Sub publish are ROUTE-layer seams exactly like the
 * web action), terms (GET/POST /v1/me/terms), trial (GET /v1/me/trial),
 * research/composer preferences (GET+PUT /v1/me/research-preferences,
 * GET /v1/me/composer-preferences), subscription access flags
 * (GET /v1/subscription/access — fail-to-FREE), FIRE chat
 * (POST /v1/fire/:id/chat) and Tradebook FYs (GET /v1/trades/fys).
 *
 * Uses the SAME ESM stubbing seam as money1062-hardening-contract.test.ts: a
 * CJS `require` seeded with a `@usemoney/services` Proxy (stable forwarder →
 * per-test impls) and a configurable `@clerk/backend` verifier, then the
 * apps/api/src modules are purged and re-required so their imports resolve to
 * the stubs. P1a additionally stubs the route-level side-effect seams the new
 * me.ts wires: `@usemoney/services/preferences` (same forwarder Proxy — the
 * research-prefs functions live on the subpath), `@usemoney/email`
 * (sendEmail + segment sync recorders), `@usemoney/email/templates` (the OTP
 * template becomes a marker object) and `@usemoney/pubsub/publish` (the
 * account-deletion publisher recorder). The services Proxy also special-cases
 * the `DEFAULT_FREE_ACCESS` VALUE export subscription.ts imports at load.
 *
 * Source: apps/api/src/routes/v1/{me,subscription,fire,trades}.ts
 *         apps/api/src/middleware/{auth,request-id}.ts
 *         packages/services/src/user.service.ts (terms pair)
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

// ── configurable @usemoney/services (+ /preferences subpath) ────────────────
const serviceImpls = new Map<string, (...args: unknown[]) => unknown>();
function setService(name: string, fn: (...args: unknown[]) => unknown): void {
  serviceImpls.set(name, fn);
}
// Marker fixture for the DEFAULT_FREE_ACCESS VALUE export (the route passes it
// through verbatim on a service failure — shape is opaque to the route).
const FREE_ACCESS_FIXTURE = {
  planId: "FREE",
  status: "none",
  canAccessAIQueries: false,
} as const;
const servicesStub = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop === "__esModule") return true;
    if (prop === "then") return undefined;
    if (prop === "default") return servicesStub;
    if (prop === "DEFAULT_FREE_ACCESS") return FREE_ACCESS_FIXTURE;
    return (...args: unknown[]) => {
      const impl = serviceImpls.get(prop);
      return impl
        ? impl(...args)
        : Promise.resolve({ success: false, error: `not-stubbed:${prop}` });
    };
  },
});

// ── @usemoney/email + templates recorders ───────────────────────────────────
let sendEmailImpl: (
  opts: Record<string, unknown>,
) => Promise<{ success: boolean; error?: string }>;
const emailCalls: Array<Record<string, unknown>> = [];
const segmentCalls: Array<{ op: "add" | "remove"; args: unknown[] }> = [];
const emailStub = {
  __esModule: true,
  sendEmail: (opts: Record<string, unknown>) => {
    emailCalls.push(opts);
    return sendEmailImpl(opts);
  },
  addContactToSegment: (...args: unknown[]) => {
    segmentCalls.push({ op: "add", args });
    return Promise.resolve({ success: true });
  },
  removeContactFromSegment: (...args: unknown[]) => {
    segmentCalls.push({ op: "remove", args });
    return Promise.resolve({ success: true });
  },
};
// me.ts calls the template function directly (no JSX/createElement in the API),
// so a marker-returning stub lets tests assert the props that reach the email.
const templatesStub = {
  __esModule: true,
  DeleteAccountOtpEmail: (props: Record<string, unknown>) => ({
    __otpEmail: props,
  }),
};

// ── @usemoney/pubsub/publish recorder ───────────────────────────────────────
let publishImpl: (msg: Record<string, unknown>) => Promise<string>;
const publishedJobs: Array<Record<string, unknown>> = [];
const publishStub = {
  __esModule: true,
  publishAccountDeletionJob: (msg: Record<string, unknown>) => {
    publishedJobs.push(msg);
    return publishImpl(msg);
  },
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
  setService("resolveUserId", async () => "mongo_1");
  sendEmailImpl = async () => ({ success: true });
  publishImpl = async () => "msg_1";
  emailCalls.length = 0;
  segmentCalls.length = 0;
  publishedJobs.length = 0;
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/me/delete-otp — OTP generate + route-layer email send (MONEY-1062 P1a)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/me/delete-otp (P1a)", () => {
  it("generates scoped to the caller and emails the OTP (200 + masked email)", async () => {
    let seenOtpInput: Record<string, unknown> | undefined;
    setService("getUserProfile", async () => PROFILE_OK);
    setService("generateDeleteOtp", async (input: unknown) => {
      seenOtpInput = input as Record<string, unknown>;
      return {
        success: true,
        data: {
          result: {
            maskedEmail: "s*****t@example.com",
            expiresAt: new Date("2026-07-10T10:10:00.000Z"),
          },
          otp: "123456",
        },
      };
    });

    const res = await app.request("/v1/me/delete-otp", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.maskedEmail, "s*****t@example.com");
    assert.equal(body.data.expiresAt, "2026-07-10T10:10:00.000Z");
    // OTP keyed on the RESOLVED Mongo id + the DB email (not client input)
    assert.deepEqual(seenOtpInput, {
      userId: "mongo_1",
      email: "shaswat@example.com",
    });
    // The email seam: awaited sendEmail with the OTP template props
    assert.equal(emailCalls.length, 1);
    const sent = emailCalls[0]!;
    assert.equal(sent.to, "shaswat@example.com");
    assert.equal(sent.template, "delete-account-otp");
    assert.equal(sent.subject, "Confirm your UseMoney account deletion");
    const react = sent.react as { __otpEmail: Record<string, unknown> };
    assert.equal(react.__otpEmail.otp, "123456");
    assert.equal(react.__otpEmail.name, "Shaswat Deep");
    assert.equal(react.__otpEmail.expiresInMinutes, 10);
  });

  it('treats the "Trader" placeholder name as no-name ("there") in the greeting', async () => {
    setService("getUserProfile", async () => ({
      success: true,
      data: { ...PROFILE_OK.data, name: "Trader" },
    }));
    setService("generateDeleteOtp", async () => ({
      success: true,
      data: {
        result: { maskedEmail: "s***@x.com", expiresAt: new Date() },
        otp: "654321",
      },
    }));
    const res = await app.request("/v1/me/delete-otp", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const react = emailCalls[0]!.react as {
      __otpEmail: Record<string, unknown>;
    };
    assert.equal(react.__otpEmail.name, "there");
  });

  it("profile DB failure (code INTERNAL) → 500; ghost session (no code) → 404 with NO OTP generated", async () => {
    let otpCalled = false;
    setService("generateDeleteOtp", async () => {
      otpCalled = true;
      return { success: true, data: {} };
    });

    setService("getUserProfile", async () => ({
      success: false,
      error: "Failed to fetch user profile",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/me/delete-otp", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(internal.status, 500);
    assert.equal((await internal.json()).error.code, "INTERNAL_ERROR");

    setService("getUserProfile", async () => ({
      success: false,
      error: "User not found",
    }));
    const ghost = await app.request("/v1/me/delete-otp", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(ghost.status, 404);
    assert.equal((await ghost.json()).error.code, "NOT_FOUND");
    assert.equal(otpCalled, false);
    assert.equal(emailCalls.length, 0);
  });

  it("the 3-per-hour rate limit maps to 429 RATE_LIMIT_EXCEEDED (email never sent)", async () => {
    setService("getUserProfile", async () => PROFILE_OK);
    setService("generateDeleteOtp", async () => ({
      success: false,
      error: "Too many OTP requests. Try again in an hour.",
    }));
    const res = await app.request("/v1/me/delete-otp", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, "RATE_LIMIT_EXCEEDED");
    assert.equal(emailCalls.length, 0);
  });

  it("a failed email delivery is a 500 (user must not wait for a code that never comes)", async () => {
    setService("getUserProfile", async () => PROFILE_OK);
    setService("generateDeleteOtp", async () => ({
      success: true,
      data: {
        result: { maskedEmail: "s***@x.com", expiresAt: new Date() },
        otp: "111111",
      },
    }));
    sendEmailImpl = async () => ({ success: false, error: "resend down" });
    const res = await app.request("/v1/me/delete-otp", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /v1/me — verify OTP → publish deletion job (MONEY-445 orchestration)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: DELETE /v1/me (P1a)", () => {
  it("rejects malformed JSON (400) and a non-6-digit otp (400) before any service call", async () => {
    let verifyCalled = false;
    setService("verifyDeleteOtp", async () => {
      verifyCalled = true;
      return { success: true, data: true };
    });

    const malformed = await app.request("/v1/me", {
      method: "DELETE",
      headers: JSON_HEADERS,
      body: "{bad",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_REQUEST");

    const badOtp = await app.request("/v1/me", {
      method: "DELETE",
      headers: JSON_HEADERS,
      body: JSON.stringify({ otp: "12ab56" }),
    });
    assert.equal(badOtp.status, 400);
    assert.equal((await badOtp.json()).error.code, "VALIDATION_ERROR");
    assert.equal(verifyCalled, false);
    assert.equal(publishedJobs.length, 0);
  });

  it("an incorrect/expired OTP → 400 and the deletion job is NEVER published", async () => {
    setService("getUserProfile", async () => PROFILE_OK);
    setService("verifyDeleteOtp", async () => ({
      success: false,
      error: "Incorrect OTP",
    }));
    const res = await app.request("/v1/me", {
      method: "DELETE",
      headers: JSON_HEADERS,
      body: JSON.stringify({ otp: "000000" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(publishedJobs.length, 0);
  });

  it("a valid OTP publishes the job (userId/clerkId/email/name/deletedBy/reason/forensics) → 200", async () => {
    let seenVerify: unknown[] = [];
    setService("getUserProfile", async () => PROFILE_OK);
    setService("verifyDeleteOtp", async (...args: unknown[]) => {
      seenVerify = args;
      return { success: true, data: true };
    });
    const res = await app.request("/v1/me", {
      method: "DELETE",
      headers: {
        ...JSON_HEADERS,
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
        "user-agent": "usemoney-ios/1.0",
      },
      body: JSON.stringify({ otp: "123456", reason: "moving abroad" }),
    });
    assert.equal(res.status, 200);
    // OTP verified against the RESOLVED Mongo id
    assert.deepEqual(seenVerify, ["mongo_1", "123456"]);
    assert.equal(publishedJobs.length, 1);
    const job = publishedJobs[0]!;
    assert.equal(job.userId, "mongo_1");
    assert.equal(job.clerkId, "clerk_default");
    assert.equal(job.email, "shaswat@example.com");
    assert.equal(job.name, "Shaswat Deep");
    assert.equal(job.deletedBy, "user");
    assert.equal(job.reason, "moving abroad");
    assert.equal(job.ipAddress, "203.0.113.9"); // first hop of x-forwarded-for
    assert.equal(job.userAgent, "usemoney-ios/1.0");
  });

  it("a Pub/Sub publish failure is surfaced as a retryable 500 (no silent success)", async () => {
    setService("getUserProfile", async () => PROFILE_OK);
    setService("verifyDeleteOtp", async () => ({ success: true, data: true }));
    publishImpl = async () => {
      throw new Error("pubsub unavailable");
    };
    const res = await app.request("/v1/me", {
      method: "DELETE",
      headers: JSON_HEADERS,
      body: JSON.stringify({ otp: "123456" }),
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });

  it("ghost session (profile no-code failure) → 404; profile INTERNAL → 500 — OTP untouched", async () => {
    let verifyCalled = false;
    setService("verifyDeleteOtp", async () => {
      verifyCalled = true;
      return { success: true, data: true };
    });

    setService("getUserProfile", async () => ({
      success: false,
      error: "User not found",
    }));
    const ghost = await app.request("/v1/me", {
      method: "DELETE",
      headers: JSON_HEADERS,
      body: JSON.stringify({ otp: "123456" }),
    });
    assert.equal(ghost.status, 404);

    setService("getUserProfile", async () => ({
      success: false,
      error: "Failed to fetch user profile",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/me", {
      method: "DELETE",
      headers: JSON_HEADERS,
      body: JSON.stringify({ otp: "123456" }),
    });
    assert.equal(internal.status, 500);
    assert.equal(verifyCalled, false);
    assert.equal(publishedJobs.length, 0);
  });

  it("full two-step flow: /delete-otp issues the code, DELETE / consumes it", async () => {
    setService("getUserProfile", async () => PROFILE_OK);
    setService("generateDeleteOtp", async () => ({
      success: true,
      data: {
        result: { maskedEmail: "s***@x.com", expiresAt: new Date() },
        otp: "424242",
      },
    }));
    const step1 = await app.request("/v1/me/delete-otp", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(step1.status, 200);
    const emailedOtp = (emailCalls[0]!.react as { __otpEmail: { otp: string } })
      .__otpEmail.otp;

    // The mobile client types the code from the email into DELETE /v1/me.
    let consumed: unknown[] = [];
    setService("verifyDeleteOtp", async (...args: unknown[]) => {
      consumed = args;
      return { success: true, data: true };
    });
    const step2 = await app.request("/v1/me", {
      method: "DELETE",
      headers: JSON_HEADERS,
      body: JSON.stringify({ otp: emailedOtp }),
    });
    assert.equal(step2.status, 200);
    assert.deepEqual(consumed, ["mongo_1", "424242"]);
    assert.equal(publishedJobs.length, 1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET/POST /v1/me/terms — terms acceptance (P1a)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/me/terms (P1a)", () => {
  it("returns the accepted flag scoped to the caller", async () => {
    let seen: unknown;
    setService("hasAcceptedTerms", async (userId: unknown) => {
      seen = userId;
      return { success: true, data: { accepted: true } };
    });
    const res = await app.request("/v1/me/terms", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seen, "mongo_1");
    assert.equal((await res.json()).data.accepted, true);
  });

  it("accepted:false passes through untouched (client shows the gate)", async () => {
    setService("hasAcceptedTerms", async () => ({
      success: true,
      data: { accepted: false },
    }));
    const res = await app.request("/v1/me/terms", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.accepted, false);
  });

  it("missing user (code-less failure) → 404; code INTERNAL → 500", async () => {
    setService("hasAcceptedTerms", async () => ({
      success: false,
      error: "User not found",
    }));
    const missing = await app.request("/v1/me/terms", { headers: AUTH });
    assert.equal(missing.status, 404);

    setService("hasAcceptedTerms", async () => ({
      success: false,
      error: "boom",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/me/terms", { headers: AUTH });
    assert.equal(internal.status, 500);
  });
});

describe("Contract: POST /v1/me/terms (P1a)", () => {
  it("rejects a non-boolean marketing flag with 400 (service untouched)", async () => {
    let called = false;
    setService("acceptTerms", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/me/terms", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ marketing: "yes" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("accepts with marketing opt-in → service scoped + fire-and-forget ADD segment sync", async () => {
    let seen: unknown[] = [];
    setService("acceptTerms", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: {
          email: "shaswat@example.com",
          name: "Shaswat Deep",
          marketing: true,
        },
      };
    });
    const res = await app.request("/v1/me/terms", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ marketing: true, analytics: false }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.accepted, true);
    assert.equal(seen[0], "mongo_1");
    assert.deepEqual(seen[1], { marketing: true, analytics: false });
    assert.equal(segmentCalls.length, 1);
    assert.equal(segmentCalls[0]!.op, "add");
    assert.equal(segmentCalls[0]!.args[0], "marketing");
    assert.deepEqual(segmentCalls[0]!.args[1], {
      email: "shaswat@example.com",
      firstName: "Shaswat",
      lastName: "Deep",
    });
  });

  it("an empty {} body is a valid accept (marketing defaults off → REMOVE segment sync)", async () => {
    setService("acceptTerms", async () => ({
      success: true,
      data: { email: "shaswat@example.com", name: null, marketing: false },
    }));
    const res = await app.request("/v1/me/terms", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.equal(segmentCalls.length, 1);
    assert.equal(segmentCalls[0]!.op, "remove");
    assert.equal(segmentCalls[0]!.args[0], "marketing");
    assert.equal(segmentCalls[0]!.args[1], "shaswat@example.com");
  });

  it("missing user → 404; code INTERNAL → 500 (no segment sync on failure)", async () => {
    setService("acceptTerms", async () => ({
      success: false,
      error: "User not found",
    }));
    const missing = await app.request("/v1/me/terms", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 404);

    setService("acceptTerms", async () => ({
      success: false,
      error: "Failed to accept terms",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/me/terms", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(internal.status, 500);
    assert.equal(segmentCalls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/me/trial — broker-sync trial window (P1a)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/me/trial (P1a)", () => {
  it("returns the service trial shape scoped to the caller", async () => {
    let seen: unknown;
    setService("getAccountTrialInfo", async (userId: unknown) => {
      seen = userId;
      return {
        success: true,
        data: { remainingDays: 12, isTrialActive: true },
      };
    });
    const res = await app.request("/v1/me/trial", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seen, "mongo_1");
    const body = await res.json();
    assert.equal(body.data.remainingDays, 12);
    assert.equal(body.data.isTrialActive, true);
  });

  it('"User not found" → 404; any other failure → 500 (retryable)', async () => {
    setService("getAccountTrialInfo", async () => ({
      success: false,
      error: "User not found",
    }));
    const missing = await app.request("/v1/me/trial", { headers: AUTH });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    setService("getAccountTrialInfo", async () => ({
      success: false,
      error: "Failed to fetch trial info",
    }));
    const internal = await app.request("/v1/me/trial", { headers: AUTH });
    assert.equal(internal.status, 500);
    assert.equal((await internal.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET/PUT /v1/me/research-preferences + GET /v1/me/composer-preferences (P1a)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/me/research-preferences (P1a)", () => {
  it("returns the service preferences scoped to the caller", async () => {
    let seen: unknown;
    setService("getResearchPreferences", async (userId: unknown) => {
      seen = userId;
      return { researchStyle: "auto", customSkills: [] };
    });
    const res = await app.request("/v1/me/research-preferences", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(seen, "mongo_1");
    assert.equal((await res.json()).data.researchStyle, "auto");
  });

  it("a service throw (this service has no ServiceResult wrapper) → 500", async () => {
    setService("getResearchPreferences", async () => {
      throw new Error("db down");
    });
    const res = await app.request("/v1/me/research-preferences", {
      headers: AUTH,
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

describe("Contract: PUT /v1/me/research-preferences (P1a)", () => {
  it("rejects an unknown researchStyle and an over-long focus with 400 (service untouched)", async () => {
    let called = false;
    setService("setResearchPreferences", async () => {
      called = true;
      return {};
    });

    const badStyle = await app.request("/v1/me/research-preferences", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ researchStyle: "bogus" }),
    });
    assert.equal(badStyle.status, 400);
    assert.equal((await badStyle.json()).error.code, "VALIDATION_ERROR");

    const longFocus = await app.request("/v1/me/research-preferences", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ researchFocus: "x".repeat(281) }),
    });
    assert.equal(longFocus.status, 400);
    assert.equal(called, false);
  });

  it("a valid partial reaches the service scoped and returns the merged prefs", async () => {
    let seen: unknown[] = [];
    setService("setResearchPreferences", async (...args: unknown[]) => {
      seen = args;
      return {
        researchStyle: "deep",
        customSkills: [],
        researchFocus: "margins",
      };
    });
    const res = await app.request("/v1/me/research-preferences", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ researchStyle: "deep", researchFocus: "margins" }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.deepEqual(seen[1], {
      researchStyle: "deep",
      researchFocus: "margins",
    });
    assert.equal((await res.json()).data.researchStyle, "deep");
  });

  it("a service-side ZodError (authoritative skill-enum gate) → 400, a generic throw → 500", async () => {
    setService("setResearchPreferences", async () => {
      const err = new Error("invalid skill id");
      err.name = "ZodError";
      throw err;
    });
    const zodRejected = await app.request("/v1/me/research-preferences", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ customSkills: ["not-a-real-skill"] }),
    });
    assert.equal(zodRejected.status, 400);
    assert.equal((await zodRejected.json()).error.code, "VALIDATION_ERROR");

    setService("setResearchPreferences", async () => {
      throw new Error("db down");
    });
    const internal = await app.request("/v1/me/research-preferences", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ researchStyle: "quick" }),
    });
    assert.equal(internal.status, 500);
  });
});

describe("Contract: GET /v1/me/composer-preferences (P1a)", () => {
  it("returns the composer namespaces scoped to the caller", async () => {
    let seen: unknown;
    setService("getComposerPreferences", async (userId: unknown) => {
      seen = userId;
      return { model: null, thinking: false, tools: { persona: null } };
    });
    const res = await app.request("/v1/me/composer-preferences", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(seen, "mongo_1");
    assert.equal((await res.json()).data.thinking, false);
  });

  it("a service throw → 500", async () => {
    setService("getComposerPreferences", async () => {
      throw new Error("db down");
    });
    const res = await app.request("/v1/me/composer-preferences", {
      headers: AUTH,
    });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/subscription/access — entitlement gates, fail-to-FREE (P1a)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/subscription/access (P1a)", () => {
  it("returns the computed access view scoped to the caller", async () => {
    let seen: unknown;
    setService("getSubscriptionAccessForUser", async (userId: unknown) => {
      seen = userId;
      return {
        success: true,
        data: {
          planId: "PREMIUM",
          status: "ACTIVE",
          canAccessAIQueries: true,
          creditsLimit: 300,
        },
      };
    });
    const res = await app.request("/v1/subscription/access", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seen, "mongo_1");
    const body = await res.json();
    assert.equal(body.data.planId, "PREMIUM");
    assert.equal(body.data.canAccessAIQueries, true);
  });

  it("a service FAILURE degrades to DEFAULT_FREE_ACCESS with 200 (fail-to-FREE, mirrors web)", async () => {
    setService("getSubscriptionAccessForUser", async () => ({
      success: false,
      error: "Failed to get subscription access",
    }));
    const res = await app.request("/v1/subscription/access", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.planId, "FREE");
    assert.equal(body.data.canAccessAIQueries, false);
  });

  it("a service THROW is a 500 (unexpected — the ServiceResult path never throws)", async () => {
    setService("getSubscriptionAccessForUser", async () => {
      throw new Error("boom");
    });
    const res = await app.request("/v1/subscription/access", { headers: AUTH });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/fire/:id/chat — append scenario chat message (P1a)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/fire/:id/chat (P1a)", () => {
  it("rejects malformed JSON (400) and a missing content (400) before the service", async () => {
    let called = false;
    setService("addFireChat", async () => {
      called = true;
      return { success: true, data: undefined };
    });

    const malformed = await app.request("/v1/fire/f1/chat", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{bad",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_REQUEST");

    const missingContent = await app.request("/v1/fire/f1/chat", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user" }),
    });
    assert.equal(missingContent.status, 400);
    assert.equal((await missingContent.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("a valid message reaches the service as (userId, scenarioId, {role, content})", async () => {
    let seen: unknown[] = [];
    setService("addFireChat", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: undefined };
    });
    const res = await app.request("/v1/fire/f9/chat", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user", content: "can I retire at 45?" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [
      "mongo_1",
      "f9",
      { role: "user", content: "can I retire at 45?" },
    ]);
  });

  it("a missing/foreign scenario → 404; a DB failure → 500", async () => {
    setService("addFireChat", async () => ({
      success: false,
      error: "Scenario not found",
    }));
    const missing = await app.request("/v1/fire/ghost/chat", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user", content: "hello" }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    setService("addFireChat", async () => ({
      success: false,
      error: "Failed to save chat",
    }));
    const internal = await app.request("/v1/fire/f1/chat", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: "user", content: "hello" }),
    });
    assert.equal(internal.status, 500);
    assert.equal((await internal.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/trades/fys — Tradebook financial years (P1a)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/trades/fys (P1a)", () => {
  it("returns the FY list scoped to the caller (not shadowed by /:id routes)", async () => {
    let seen: unknown;
    let listCalled = false;
    setService("getTrades", async () => {
      listCalled = true;
      return { success: true, data: { trades: [], total: 0, stats: {} } };
    });
    setService("getAvailableFYs", async (userId: unknown) => {
      seen = userId;
      return {
        success: true,
        data: {
          fys: [
            { fy: "FY 2025-26", from: "2025-04-01", to: "2026-03-31" },
            { fy: "FY 2024-25", from: "2024-04-01", to: "2025-03-31" },
          ],
        },
      };
    });
    const res = await app.request("/v1/trades/fys", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seen, "mongo_1");
    const body = await res.json();
    assert.equal(body.data.fys.length, 2);
    assert.equal(body.data.fys[0].fy, "FY 2025-26");
    // /fys resolves to the FY handler, not the list route
    assert.equal(listCalled, false);
  });

  it("an empty tradebook is a successful { fys: [] } — not a 404", async () => {
    setService("getAvailableFYs", async () => ({
      success: true,
      data: { fys: [] },
    }));
    const res = await app.request("/v1/trades/fys", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data.fys, []);
  });

  it("a DB failure → 500 (the endpoint has no not-found path)", async () => {
    setService("getAvailableFYs", async () => ({
      success: false,
      error: "Failed to load financial years",
    }));
    const res = await app.request("/v1/trades/fys", { headers: AUTH });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});
