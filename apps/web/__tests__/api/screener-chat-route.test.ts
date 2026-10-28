/**
 * /api/screener-chat — route END-TO-END tests (MONEY-1078).
 *
 * Drives the REAL route handler through every branch with stubs injected
 * via require.cache (same pattern as ../actions/fire-chat-action.test.ts):
 *   - auth layering: dev-open; production requires Clerk OR demo session;
 *   - 503 config pre-check (no GOOGLE_GENAI_API_KEY and no GCP_PROJECT_ID)
 *     with dev-only remediation detail;
 *   - 400s: invalid JSON, missing contents/snapshot;
 *   - 200: text + functionCalls extraction from Gemini candidate parts
 *     (id passthrough, empty-name filtering, text concatenation);
 *   - credit policy: charged ONLY on a pure-answer turn by a signed-in
 *     user — never on tool turns, follow-up hops, or demo sessions;
 *   - 402 when credits run out; 502 on a Gemini throw (dev-only detail);
 *   - the model is built with the screener tools + a prompt carrying the
 *     live snapshot.
 *
 * No UI, no network: Gemini and Clerk are stubbed at module resolution;
 * the handler itself runs for real.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// ── stubs via require.cache ─────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
}

interface CapturedModelOpts {
  model?: string;
  systemInstruction?: string;
  tools?: { functionDeclarations?: { name: string }[] }[];
  generationConfig?: unknown;
}

interface CreditCall {
  fn: "consume" | "refund";
  userId: string;
  action: string;
}

const captured: {
  modelOpts: CapturedModelOpts | null;
  credits: CreditCall[];
} = { modelOpts: null, credits: [] };

/**
 * The INTERNAL Mongo user the Clerk id resolves to. Deliberately
 * ObjectId-shaped and unlike the Clerk `user_*` ids the tests sign in with,
 * so an assertion can tell the two apart.
 */
const DB_USER = { id: "665f1a2b3c4d5e6f70819200" };

function inject(opts: {
  userId: string | null;
  isDemo?: boolean;
  gemini?: {
    parts?: GeminiPart[];
    throwError?: Error;
    /** MONEY-1243 — candidate finishReason; defaults to "STOP" when omitted. */
    finishReason?: string;
  };
  creditsOk?: boolean;
  /**
   * The Mongo user the Clerk id resolves to. `null` models the
   * shouldn't-happen missing-dbUser case (the turn must still succeed,
   * uncharged). Defaults to DB_USER.
   */
  dbUser?: { id: string } | null;
}) {
  captured.modelOpts = null;
  captured.credits = [];
  const cache = (require as unknown as { cache: Record<string, unknown> })
    .cache;
  const clerkPath = require.resolve("@clerk/nextjs/server");
  const sessionPath = require.resolve("../../lib/demo/session");
  const geminiPath = require.resolve("../../lib/gemini/client");
  const servicesPath = require.resolve("@usemoney/services");
  const dbUserPath = require.resolve("../../lib/db/user");
  const routePath = require.resolve("../../app/api/screener-chat/route");

  delete cache[clerkPath];
  delete cache[sessionPath];
  delete cache[geminiPath];
  delete cache[servicesPath];
  delete cache[dbUserPath];
  delete cache[routePath]; // fresh route import per test

  cache[dbUserPath] = {
    exports: {
      __esModule: true,
      getOrCreateDbUser: async () =>
        opts.dbUser === undefined ? DB_USER : opts.dbUser,
    },
  };

  cache[servicesPath] = {
    exports: {
      __esModule: true,
      consumeCredits: async (userId: string, action: string) => {
        captured.credits.push({ fn: "consume", userId, action });
        return opts.creditsOk === false
          ? { success: false, error: "Not enough credits remaining." }
          : { success: true, data: { remaining: 9, creditsUsed: 1 } };
      },
      refundCredits: async (userId: string, action: string) => {
        captured.credits.push({ fn: "refund", userId, action });
        return { success: true, data: { refunded: 1 } };
      },
    },
  };

  cache[clerkPath] = {
    exports: { __esModule: true, auth: async () => ({ userId: opts.userId }) },
  };
  cache[sessionPath] = {
    exports: {
      __esModule: true,
      isDemoSession: async () => opts.isDemo ?? false,
    },
  };
  cache[geminiPath] = {
    exports: {
      __esModule: true,
      getVertexAIClient: () => ({
        getGenerativeModel: (modelOpts: CapturedModelOpts) => {
          captured.modelOpts = modelOpts;
          return {
            async generateContent() {
              if (opts.gemini?.throwError) throw opts.gemini.throwError;
              return {
                response: {
                  candidates: [
                    {
                      content: { parts: opts.gemini?.parts ?? [] },
                      // MONEY-1243: real candidates always carry a
                      // finishReason. Default to the healthy value so every
                      // pre-existing case keeps its meaning, and let a test
                      // opt into MAX_TOKENS.
                      finishReason: opts.gemini?.finishReason ?? "STOP",
                    },
                  ],
                },
              };
            },
          };
        },
      }),
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../../app/api/screener-chat/route") as {
    POST: (req: NextRequest) => Promise<Response>;
  };
}

// ── request helpers ─────────────────────────────────────────────────

const SNAPSHOT = {
  mode: "stocks" as const,
  query: "",
  sort: "match",
  filters: { minRoe: 20 },
  resultTotal: 37,
  topResults: [
    {
      symbol: "INFY",
      name: "Infosys",
      sector: "IT",
      ltp: 1500,
      pe: 24,
      roe: 30,
      marketCap: 600000,
    },
  ],
  available: { sectors: ["IT", "Banking"] },
};

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/screener-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID_BODY = {
  contents: [{ role: "user", parts: [{ text: "what am I looking at?" }] }],
  snapshot: SNAPSHOT,
};

/** A follow-up hop: the client returning functionResponse parts. */
const FOLLOWUP_BODY = {
  contents: [
    { role: "user", parts: [{ text: "IT stocks under PE 25" }] },
    {
      role: "model",
      parts: [{ functionCall: { name: "setStockFilters", args: {} } }],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "setStockFilters",
            response: { result: "ok" },
          },
        },
      ],
    },
  ],
  snapshot: SNAPSHOT,
};

// ── env bookkeeping ─────────────────────────────────────────────────

const ORIG_ENV = process.env.NODE_ENV;
const ORIG_KEY = process.env.GOOGLE_GENAI_API_KEY;
const ORIG_PROJECT = process.env.GCP_PROJECT_ID;

function setEnv(opts: {
  nodeEnv?: string;
  apiKey?: string | undefined;
  project?: string | undefined;
}) {
  (process.env as Record<string, string | undefined>).NODE_ENV =
    opts.nodeEnv ?? "test";
  if ("apiKey" in opts) {
    if (opts.apiKey === undefined) delete process.env.GOOGLE_GENAI_API_KEY;
    else process.env.GOOGLE_GENAI_API_KEY = opts.apiKey;
  }
  if ("project" in opts) {
    if (opts.project === undefined) delete process.env.GCP_PROJECT_ID;
    else process.env.GCP_PROJECT_ID = opts.project;
  }
}

afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = ORIG_ENV;
  if (ORIG_KEY === undefined) delete process.env.GOOGLE_GENAI_API_KEY;
  else process.env.GOOGLE_GENAI_API_KEY = ORIG_KEY;
  if (ORIG_PROJECT === undefined) delete process.env.GCP_PROJECT_ID;
  else process.env.GCP_PROJECT_ID = ORIG_PROJECT;
});

// ── tests ───────────────────────────────────────────────────────────

describe("screener-chat route — auth layering", () => {
  it("production + no user + no demo → 401", async () => {
    setEnv({ nodeEnv: "production", apiKey: "k" });
    const { POST } = inject({ userId: null, isDemo: false });
    const res = await POST(makeReq(VALID_BODY));
    assert.equal(res.status, 401);
  });

  it("production + demo session (no Clerk) → passes auth", async () => {
    setEnv({ nodeEnv: "production", apiKey: "k" });
    const { POST } = inject({
      userId: null,
      isDemo: true,
      gemini: { parts: [{ text: "ok" }] },
    });
    const res = await POST(makeReq(VALID_BODY));
    assert.equal(res.status, 200);
  });

  it("dev + no user + no demo → still open (local testing)", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: null,
      isDemo: false,
      gemini: { parts: [{ text: "ok" }] },
    });
    const res = await POST(makeReq(VALID_BODY));
    assert.equal(res.status, 200);
  });
});

describe("screener-chat route — config & input validation", () => {
  it("no GOOGLE_GENAI_API_KEY and no GCP_PROJECT_ID → 503 with dev detail", async () => {
    setEnv({ nodeEnv: "test", apiKey: undefined, project: undefined });
    const { POST } = inject({ userId: "user_1" });
    const res = await POST(makeReq(VALID_BODY));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { detail?: string };
    assert.match(body.detail ?? "", /GOOGLE_GENAI_API_KEY/);
  });

  it("GCP_PROJECT_ID alone satisfies the config pre-check (Vertex path)", async () => {
    setEnv({ nodeEnv: "test", apiKey: undefined, project: "proj-1" });
    const { POST } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "ok" }] },
    });
    const res = await POST(makeReq(VALID_BODY));
    assert.equal(res.status, 200);
  });

  it("invalid JSON body → 400", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({ userId: "user_1" });
    const res = await POST(makeReq("not json"));
    assert.equal(res.status, 400);
  });

  it("missing contents → 400", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({ userId: "user_1" });
    const res = await POST(makeReq({ snapshot: SNAPSHOT }));
    assert.equal(res.status, 400);
  });

  it("empty contents array → 400", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({ userId: "user_1" });
    const res = await POST(makeReq({ contents: [], snapshot: SNAPSHOT }));
    assert.equal(res.status, 400);
  });

  it("missing snapshot → 400", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({ userId: "user_1" });
    const res = await POST(makeReq({ contents: VALID_BODY.contents }));
    assert.equal(res.status, 400);
  });
});

describe("screener-chat route — request size caps", () => {
  // The snapshot is stringified into the system prompt and `contents` is
  // forwarded verbatim, so without ceilings an authenticated client could
  // drive multi-MB prompts at the rate limit — and tool turns are never
  // credit-charged, so nothing else bounds the cost.

  it("over-long conversation → 413, no Gemini call", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({ userId: "user_1" });
    const contents = Array.from({ length: 101 }, () => ({
      role: "user",
      parts: [{ text: "hi" }],
    }));
    const res = await POST(makeReq({ contents, snapshot: SNAPSHOT }));
    assert.equal(res.status, 413);
    assert.equal(captured.modelOpts, null, "must reject before calling Gemini");
  });

  it("oversized snapshot → 413, no Gemini call", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({ userId: "user_1" });
    const fat = { ...SNAPSHOT, query: "x".repeat(100_001) };
    const res = await POST(
      makeReq({ contents: VALID_BODY.contents, snapshot: fat })
    );
    assert.equal(res.status, 413);
    assert.equal(captured.modelOpts, null);
  });

  it("a normal-sized request passes the caps", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "ok" }] },
    });
    // The real client caps history at 24 turns; well under the limit.
    const contents = Array.from({ length: 24 }, () => ({
      role: "user",
      parts: [{ text: "hi" }],
    }));
    const res = await POST(makeReq({ contents, snapshot: SNAPSHOT }));
    assert.equal(res.status, 200);
  });
});

describe("screener-chat route — Gemini response mapping", () => {
  it("returns concatenated text with no function calls", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "37 IT " }, { text: "stocks match." }] },
    });
    const res = await POST(makeReq(VALID_BODY));
    const body = (await res.json()) as {
      text: string;
      functionCalls: unknown[];
      source: string;
    };
    assert.equal(body.text, "37 IT stocks match.");
    assert.deepEqual(body.functionCalls, []);
    assert.equal(body.source, "llm");
  });

  it("maps function calls, passing through the call id", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: {
        parts: [
          {
            functionCall: {
              id: "call_1",
              name: "setStockFilters",
              args: { minRoe: 20 },
            },
          },
          {
            functionCall: { name: "setSort", args: { sort: "mcap-desc" } },
          },
        ],
      },
    });
    const res = await POST(makeReq(VALID_BODY));
    const body = (await res.json()) as {
      functionCalls: { id?: string; name: string; args: unknown }[];
    };
    assert.equal(body.functionCalls.length, 2);
    assert.equal(body.functionCalls[0]!.id, "call_1");
    assert.deepEqual(body.functionCalls[0]!.args, { minRoe: 20 });
    assert.equal(body.functionCalls[1]!.id, undefined);
  });

  it("drops nameless function-call parts", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: { parts: [{ functionCall: { args: {} } }, { text: "hi" }] },
    });
    const res = await POST(makeReq(VALID_BODY));
    const body = (await res.json()) as { functionCalls: unknown[] };
    assert.deepEqual(body.functionCalls, []);
  });

  it("returns null text when the model emits only tool calls", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: {
        parts: [{ functionCall: { name: "clearFilters", args: {} } }],
      },
    });
    const res = await POST(makeReq(VALID_BODY));
    const body = (await res.json()) as { text: string | null };
    assert.equal(body.text, null);
  });

  it("pins an explicit thinking budget (empty-candidate guard)", async () => {
    // NOT a style preference. With `thinkingConfig` omitted,
    // gemini-2.5-flash returns an EMPTY candidate for this prompt+toolset
    // (finishReason STOP, 0 output tokens, no text and no functionCall),
    // which the UI shows as a silent no-op. Verified live 2026-07-21:
    // "sort by market cap high to low" was EMPTY 3/3 without a budget and
    // produced the tool call 3/3 with one. This test exists so a future
    // cleanup can't quietly delete the budget and re-break the feature.
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "ok" }] },
    });
    await POST(makeReq(VALID_BODY));
    const gc = captured.modelOpts?.generationConfig as
      | { thinkingConfig?: { thinkingBudget?: number } }
      | undefined;
    assert.equal(
      typeof gc?.thinkingConfig?.thinkingBudget,
      "number",
      "generationConfig.thinkingConfig.thinkingBudget must stay set"
    );
  });

  it("builds the model with the screener tools and snapshot prompt", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "ok" }] },
    });
    await POST(makeReq(VALID_BODY));
    const names =
      captured.modelOpts?.tools?.[0]?.functionDeclarations?.map(
        (d) => d.name
      ) ?? [];
    assert.ok(names.includes("setStockFilters"));
    assert.ok(names.includes("setEtfFilters"));
    assert.match(captured.modelOpts?.systemInstruction ?? "", /INFY/);
    assert.match(captured.modelOpts?.systemInstruction ?? "", /Ask Screener/);
  });
});

describe("screener-chat route — credit policy", () => {
  it("charges once for a pure-answer turn by a signed-in user", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "answer" }] },
    });
    const res = await POST(makeReq(VALID_BODY));
    assert.equal(res.status, 200);
    assert.deepEqual(
      captured.credits.map((c) => [c.fn, c.action]),
      [["consume", "screener_chat"]]
    );
  });

  it("charges the INTERNAL Mongo user id, never the Clerk id", async () => {
    // Regression: Subscription.userId is an @db.ObjectId FK to User.id, so a
    // raw Clerk id makes Prisma throw "Malformed ObjectID" — which
    // consumeCredits catches and returns as a generic failure, 402'ing every
    // pure-answer turn for a user with credits to spare. The same bug was
    // already fixed once in lib/actions/fire-chat.ts.
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_clerk_abc",
      gemini: { parts: [{ text: "answer" }] },
    });
    const res = await POST(makeReq(VALID_BODY));
    assert.equal(res.status, 200);
    assert.equal(captured.credits.length, 1);
    assert.equal(captured.credits[0]?.userId, DB_USER.id);
    assert.notEqual(captured.credits[0]?.userId, "user_clerk_abc");
  });

  it("skips the charge (but still answers) when the Clerk id has no db user", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      dbUser: null,
      gemini: { parts: [{ text: "answer" }] },
    });
    const res = await POST(makeReq(VALID_BODY));
    assert.equal(res.status, 200);
    assert.deepEqual(captured.credits, []);
  });

  it("does NOT charge a tool-producing turn", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: {
        parts: [{ functionCall: { name: "setStockFilters", args: {} } }],
      },
    });
    await POST(makeReq(VALID_BODY));
    assert.deepEqual(captured.credits, []);
  });

  it("does NOT charge a follow-up hop (functionResponse tail)", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "applied" }] },
    });
    await POST(makeReq(FOLLOWUP_BODY));
    assert.deepEqual(captured.credits, []);
  });

  it("does NOT charge a demo/anonymous session", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: null,
      isDemo: true,
      gemini: { parts: [{ text: "answer" }] },
    });
    await POST(makeReq(VALID_BODY));
    assert.deepEqual(captured.credits, []);
  });

  it("out of credits → 402", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      creditsOk: false,
      gemini: { parts: [{ text: "answer" }] },
    });
    const res = await POST(makeReq(VALID_BODY));
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /credits/i);
  });
});

describe("screener-chat route — failure handling", () => {
  it("Gemini throw → 502 with dev-only detail", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: { throwError: new Error("model exploded") },
    });
    const res = await POST(makeReq(VALID_BODY));
    assert.equal(res.status, 502);
    const body = (await res.json()) as { error: string; detail?: string };
    assert.match(body.error, /unavailable/i);
    assert.equal(body.detail, "model exploded");
  });

  it("production hides the failure detail", async () => {
    setEnv({ nodeEnv: "production", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: { throwError: new Error("secret internals") },
    });
    const res = await POST(makeReq(VALID_BODY));
    assert.equal(res.status, 502);
    const body = (await res.json()) as { detail?: string };
    assert.equal(body.detail, undefined);
  });

  it("never charges a credit for a failed turn", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: { throwError: new Error("boom") },
    });
    await POST(makeReq(VALID_BODY));
    assert.deepEqual(captured.credits, []);
  });
});

/**
 * MONEY-1243 — a truncated candidate must not pass as a finished answer.
 *
 * Same defect pair as MONEY-1240 (Ask FIRE), and worse here: `maxOutputTokens`
 * COUNTS the thinking budget, and this route pins `thinkingBudget: 512`, so at
 * the old cap of 1024 roughly half the allowance was spent before a single
 * visible character was produced. Answers stopped mid-sentence.
 *
 * `finishReason` was never read — it appeared only inside a comment about
 * empty candidates — so a candidate that stopped on MAX_TOKENS was
 * indistinguishable from one that finished, and the fragment rendered as a
 * complete reply. Reading it is the load-bearing half: without it, raising the
 * cap only moves the cliff.
 */
describe("screener-chat — truncation (MONEY-1243)", () => {
  it("[regression] MAX_TOKENS on a text-only turn is an error, NOT a reply", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: {
        parts: [{ text: "Filtering to IT stocks with a P/E under" }],
        finishReason: "MAX_TOKENS",
      },
    });
    const res = await POST(makeReq(VALID_BODY));

    assert.equal(res.ok, false, "a truncated candidate must not return 2xx");
    const body = (await res.json()) as { error?: string; text?: string };
    assert.ok(body.error, "must surface an error");
    assert.equal(
      body.text,
      undefined,
      "the fragment must not be returned as a reply"
    );
  });

  it("[regression] a truncated turn is NOT charged", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: {
        parts: [{ text: "Sorting by market cap" }],
        finishReason: "MAX_TOKENS",
      },
    });
    await POST(makeReq(VALID_BODY));

    // You pay to THINK, not to be cut off — the guard returns before
    // consumeCredits, so a user is never billed for half an answer.
    const consumes = captured.credits.filter((c) => c.fn === "consume");
    assert.equal(consumes.length, 0, "must not charge for a truncated answer");
  });

  it("MAX_TOKENS alongside tool calls still returns — the loop continues", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: {
        parts: [
          { text: "Applying that screen" },
          { functionCall: { name: "clearFilters", args: {} } },
        ],
        finishReason: "MAX_TOKENS",
      },
    });
    const res = await POST(makeReq(VALID_BODY));

    // The client executes the call and hops again, so the truncated prose is
    // not the final word. Failing here would strand an applied screen change.
    assert.equal(res.ok, true, "a tool-bearing turn must still return 2xx");
    const body = (await res.json()) as { functionCalls: unknown[] };
    assert.equal(body.functionCalls.length, 1);
  });

  it("the output budget leaves room for an answer AFTER the thinking budget", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { POST } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "ok" }] },
    });
    await POST(makeReq(VALID_BODY));

    const gc = captured.modelOpts?.generationConfig as
      | {
          maxOutputTokens?: number;
          thinkingConfig?: { thinkingBudget?: number };
        }
      | undefined;
    const cap = gc?.maxOutputTokens ?? 0;
    const think = gc?.thinkingConfig?.thinkingBudget ?? 0;

    // 1024 was the shipped value that truncated in production.
    assert.ok(cap > 1024, `maxOutputTokens must exceed 1024; got ${cap}`);
    // The cap INCLUDES thinking, so what matters is the remainder.
    assert.ok(
      cap - think >= 2048,
      `only ${cap - think} tokens left for the answer after a ${think}-token thinking budget`
    );
  });
});
