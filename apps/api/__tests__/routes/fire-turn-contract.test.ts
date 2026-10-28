/**
 * POST /v1/fire/:id/turn — HTTP CONTRACT tests (MONEY-1091 / MONEY-1079).
 *
 * The Ask FIRE turn endpoint: the single /v1 route that mutates a saved plan,
 * calls a model, AND charges credits. `endpoint-contract-coverage.test.ts`
 * flagged it as the one untested endpoint that may never be allowlisted, so
 * this file is the reason that assertion can stay.
 *
 * ## What is stubbed, and why exactly there
 *
 * The LLM boundary ONLY — `makeApiFireGenerate()`. Everything downstream of the
 * route is the real thing: the real deterministic parser, the real tool
 * executor, the real ServerFireActions plan, the real `createScenarioOps`
 * save-retargeting. Stubbing `runFireChatTurn` instead would have been easier
 * and worthless: the assertions would describe the mock, not the endpoint. With
 * only `generate` replaced, "which tier ran" is a genuine outcome of the real
 * parser rather than something the test dictates — which matters because that
 * one branch decides both the reported `source` and whether the caller is
 * BILLED.
 *
 * ## The invariants worth a test
 *
 *   tiering      an unambiguous command must never reach the model (free), and
 *                a question must (paid) — asserted via a generate() that
 *                records whether it was called at all.
 *   credit       charge ONLY a pure-answer LLM turn. A tool turn mutates the
 *                user's plan and is free; charging it would bill people for
 *                edits. Both directions are asserted, not just the charge.
 *   retargeting  a turn that LOADS another scenario must persist THERE. The
 *                path-scenario write is permanent data loss (scenarioTarget.ts
 *                documents it) — so this asserts the target id AND the
 *                persisted values, since the id alone passes even if the wrong
 *                plan is written to the right row.
 *
 * Uses the same CJS require-cache stubbing seam as
 * parity-p1a-contract.test.ts, with one addition: `src/lib/fire-generate.ts` is
 * stubbed AFTER the apps/api purge loop, so the freshly re-required route
 * resolves its import to the fake.
 *
 * Source: apps/api/src/routes/v1/fire.ts (POST /:id/turn)
 *         packages/fire/src/{serverTurn,scenarioTarget,parser}.ts
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

// ── configurable @usemoney/services ─────────────────────────────────────────
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
    return (...args: unknown[]) => {
      const impl = serviceImpls.get(prop);
      return impl
        ? impl(...args)
        : Promise.resolve({ success: false, error: `not-stubbed:${prop}` });
    };
  },
});

// ── the LLM seam ────────────────────────────────────────────────────────────
// The engine's `generate` contract: (contents, snapshot) → {text, functionCalls}.
interface GenReply {
  text: string | null;
  functionCalls: Array<{
    id?: string;
    name: string;
    args: Record<string, unknown>;
  }>;
}
/** Every model hop this turn, so "was the model used at all" is observable. */
let generateCalls: Array<{ contents: unknown; snapshot: unknown }> = [];
let generateImpl: (snapshot: unknown, hop: number) => GenReply;
const fireGenerateStub = {
  __esModule: true,
  makeApiFireGenerate: () => async (contents: unknown, snapshot: unknown) => {
    const hop = generateCalls.length;
    generateCalls.push({ contents, snapshot });
    return generateImpl(snapshot, hop);
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
  for (const key of Object.keys(cache)) {
    if (key.includes("/apps/api/src/")) {
      saved.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // AFTER the purge: the route must resolve this import to the fake, and the
  // loop above would otherwise delete the entry we just wrote.
  stub(require.resolve("../../src/lib/fire-generate.ts"), fireGenerateStub);

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

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A stored scenario, in the shape the /fire page persists (typed arrays as
 * JSON). Allocations sum to 100 so the post-turn rebalance is a no-op unless a
 * test deliberately changes one.
 */
function scenario(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sc_path",
    name: "Base",
    currentAge: 30,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 1_800_000,
    monthlySavings: 60_000,
    withdrawalRate: 4,
    taxRate: 30,
    salaryIncrement: 10,
    savingsIncrement: 8,
    assetClasses: [
      { name: "Equity", allocation: 60, expectedReturn: 12 },
      { name: "Gold", allocation: 15, expectedReturn: 8 },
      { name: "Fixed Deposits", allocation: 25, expectedReturn: 7 },
    ],
    expenses: [{ category: "Housing", amount: 25_000, inflation: 5 }],
    oneTimeExpenses: [],
    ...over,
  };
}

/** The other saved plan, deliberately different in every asserted field. */
const OTHER = scenario({
  id: "sc_other",
  name: "Conservative",
  currentAge: 41,
  retirementAge: 60,
  currentCorpus: 5_000_000,
  monthlySavings: 20_000,
});

/** Recorded saveFireScenario calls: [userId, input, targetId?]. */
let saveCalls: unknown[][] = [];
/** Recorded consumeCredits calls: [userId, feature, meta]. */
let creditCalls: unknown[][] = [];

beforeEach(() => {
  verifyImpl = async () => ({ sub: "clerk_default" });
  serviceImpls.clear();
  generateCalls = [];
  saveCalls = [];
  creditCalls = [];
  generateImpl = () => ({ text: "ok", functionCalls: [] });

  setService("resolveUserId", async () => "mongo_1");
  setService("getFireScenario", async () => ({
    success: true,
    data: scenario(),
  }));
  setService("getFireScenarios", async () => ({
    success: true,
    data: [scenario(), OTHER],
  }));
  setService("saveFireScenario", async (...args: unknown[]) => {
    saveCalls.push(args);
    return { success: true, data: { id: "sc_path" } };
  });
  setService("consumeCredits", async (...args: unknown[]) => {
    creditCalls.push(args);
    return { success: true };
  });
});

const turn = (id: string, body: unknown) =>
  app.request(`/v1/fire/${id}/turn`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/fire/:id/turn (MONEY-1091)", () => {
  it("requires auth — an unauthenticated turn never reaches the scenario", async () => {
    let loaded = false;
    setService("getFireScenario", async () => {
      loaded = true;
      return { success: true, data: scenario() };
    });
    const res = await app.request("/v1/fire/sc_path/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: "retire at 45" }),
    });
    assert.equal(res.status, 401);
    assert.equal(loaded, false);
  });

  it("rejects malformed JSON (400) and an empty/oversize request (400) before the scenario load", async () => {
    let loaded = false;
    setService("getFireScenario", async () => {
      loaded = true;
      return { success: true, data: scenario() };
    });

    const malformed = await turn("sc_path", "{bad");
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_REQUEST");

    const empty = await turn("sc_path", { request: "" });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, "VALIDATION_ERROR");

    const oversize = await turn("sc_path", { request: "x".repeat(2001) });
    assert.equal(oversize.status, 400);
    assert.equal((await oversize.json()).error.code, "VALIDATION_ERROR");

    // The route validates before spending a query — and before a model hop.
    assert.equal(loaded, false);
    assert.equal(generateCalls.length, 0);
  });

  it("distinguishes a missing/foreign scenario (404) from a DB failure (500)", async () => {
    // The service scopes the read to userId, so another user's id reads as
    // absent — `data: null` with success, NOT an error.
    setService("getFireScenario", async () => ({ success: true, data: null }));
    const missing = await turn("sc_ghost", { request: "retire at 45" });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    setService("getFireScenario", async () => ({
      success: false,
      error: "connection reset",
    }));
    const broken = await turn("sc_path", { request: "retire at 45" });
    assert.equal(broken.status, 500);
    assert.equal((await broken.json()).error.code, "INTERNAL_ERROR");

    assert.equal(saveCalls.length, 0);
  });

  it("an unambiguous command runs the FREE deterministic tier: no model hop, no credit, persisted to the path scenario", async () => {
    const res = await turn("sc_path", { request: "retire at 45" });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.data.source, "deterministic");
    assert.equal(body.data.mutated, true);
    // The whole point of tier 1 — the model is never consulted, so it is never
    // billed. Asserted as "zero hops", not as "source said deterministic".
    assert.equal(generateCalls.length, 0);
    assert.deepEqual(creditCalls, []);

    // Persisted to the path scenario, carrying the parsed value.
    assert.equal(saveCalls.length, 1);
    const [userId, input, targetId] = saveCalls[0]!;
    assert.equal(userId, "mongo_1");
    assert.equal(targetId, "sc_path");
    assert.equal((input as { retirementAge: number }).retirementAge, 45);
    assert.equal((input as { name: string }).name, "Base");
    // The response snapshot reflects the mutation, not the stored row.
    assert.equal(body.data.plan.parameters.retirementAge, 45);
  });

  it("a pure-answer LLM turn charges fire_chat once and reports source=llm", async () => {
    generateImpl = () => ({
      text: "At 4% you'd need about ₹2.4 Cr.",
      functionCalls: [],
    });

    const res = await turn("sc_path", {
      request: "should I retire early or keep working?",
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.data.source, "llm");
    assert.equal(body.data.mutated, false);
    assert.equal(body.data.reply, "At 4% you'd need about ₹2.4 Cr.");
    assert.equal(generateCalls.length, 1);

    assert.equal(creditCalls.length, 1);
    const [userId, feature, meta] = creditCalls[0]!;
    assert.equal(userId, "mongo_1");
    assert.equal(feature, "fire_chat");
    assert.equal(
      (meta as { query: string }).query,
      "should I retire early or keep working?",
    );
    // An answer changed nothing, so nothing is written.
    assert.equal(saveCalls.length, 0);
  });

  it("an LLM turn that CALLS A TOOL is free — the edit is persisted but never billed", async () => {
    // Hop 0 edits the plan, hop 1 answers. `usedLlm` is true either way; what
    // makes it free is that a tool ran. Billing this path would charge users
    // for edits the deterministic tier gives away.
    generateImpl = (_snapshot, hop) =>
      hop === 0
        ? {
            text: null,
            functionCalls: [
              { name: "setMonthlySavings", args: { amount: 95_000 } },
            ],
          }
        : { text: "Raised your monthly savings.", functionCalls: [] };

    const res = await turn("sc_path", {
      request: "bump savings a bit if that helps",
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.data.source, "llm");
    assert.equal(body.data.mutated, true);
    assert.equal(generateCalls.length, 2);
    assert.deepEqual(creditCalls, []);

    assert.equal(saveCalls.length, 1);
    assert.equal(
      (saveCalls[0]![1] as { monthlySavings: number }).monthlySavings,
      95_000,
    );
  });

  it("an exhausted balance is a 402 — the answer is withheld, not given away", async () => {
    generateImpl = () => ({ text: "Here's the analysis…", functionCalls: [] });
    setService("consumeCredits", async (...args: unknown[]) => {
      creditCalls.push(args);
      return { success: false, error: "Out of credits" };
    });

    const res = await turn("sc_path", { request: "should I retire early?" });
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error.code, "FORBIDDEN");
    assert.match(body.error.message, /credit/i);
    // The generated text must not leak in the failure envelope.
    assert.ok(!JSON.stringify(body).includes("Here's the analysis"));
  });

  it("a turn that LOADS another scenario persists THERE — target id and values both", async () => {
    // The data-loss invariant scenarioTarget.ts exists for: "load my
    // Conservative plan" against /v1/fire/sc_path/turn must not overwrite
    // sc_path with Conservative's numbers.
    const res = await turn("sc_path", { request: "load Conservative" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.mutated, true);

    assert.equal(saveCalls.length, 1);
    const [, input, targetId] = saveCalls[0]!;
    assert.equal(targetId, "sc_other");
    assert.equal((input as { name: string }).name, "Conservative");
    // The id alone would pass even if the WRONG plan were written to the right
    // row, so the loaded values are asserted too.
    assert.equal((input as { currentAge: number }).currentAge, 41);
    assert.equal((input as { retirementAge: number }).retirementAge, 60);
    assert.equal((input as { currentCorpus: number }).currentCorpus, 5_000_000);
  });

  it("a failed persist is a 500 — a mutated plan is never reported as saved", async () => {
    setService("saveFireScenario", async (...args: unknown[]) => {
      saveCalls.push(args);
      return { success: false, error: "write conflict" };
    });
    const res = await turn("sc_path", { request: "retire at 45" });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
    assert.equal(saveCalls.length, 1);
  });
});
