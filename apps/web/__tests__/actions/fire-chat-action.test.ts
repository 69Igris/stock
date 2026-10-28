/**
 * fireChatTurnAction — SERVER ACTION end-to-end tests (MONEY-1079).
 *
 * Migrated from `__tests__/api/fire-chat-route.test.ts` when MONEY-1079 deleted
 * the POST /api/fire-chat route: the /fire page now calls this server action
 * directly (repo convention — web mutations go through server actions). The
 * CLASSIFICATION logic is unchanged from the route, so every behavioural branch
 * the route suite pinned is re-pinned here against the action:
 *   - auth layering: dev-open; production requires Clerk OR a demo session;
 *   - config pre-check (no GOOGLE_GENAI_API_KEY and no GCP_PROJECT_ID) with
 *     dev-only remediation detail;
 *   - input validation: missing/empty contents, missing snapshot;
 *   - Tier 1 deterministic fast path (no model built, no credit);
 *   - credits: you pay to THINK, not to ACT;
 *   - Gemini response mapping (id passthrough, empty-name filtering);
 *   - failure surface, with dev-only `detail` and a generic prod message.
 *
 * TRANSPORT DIFFERENCES from the route suite (deliberate, not lost coverage):
 *   - HTTP status codes are gone; the action returns `{ error, detail? }`
 *     objects, so the assertions check those instead of 401/400/402/503/502.
 *   - The route's "invalid JSON body → 400" case has NO analogue: a server
 *     action receives typed arguments, so there is no request body to
 *     mis-parse. That branch was deleted with the route rather than faked.
 *   - The action rate-limits via `next/headers` (no NextRequest), so the
 *     limiter and headers are stubbed here too.
 *
 * No UI, no network: Clerk, the demo session, the Gemini client, credits, the
 * db-user lookup, headers and the rate limiter are stubbed at module
 * resolution; the action itself runs for real.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── stubs via require.cache ─────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
}

interface CapturedModelOpts {
  model?: string;
  systemInstruction?: string;
  tools?: unknown;
  generationConfig?: unknown;
}

interface GeminiStubConfig {
  parts?: GeminiPart[];
  throwError?: Error;
  /** MONEY-1240 — candidate finishReason; defaults to "STOP" when omitted. */
  finishReason?: string;
}

interface CreditCall {
  fn: "consume" | "refund";
  userId: string;
  action: string;
}

const captured: {
  modelOpts: CapturedModelOpts | null;
  credits: CreditCall[];
  rateLimitToken: string | null;
} = { modelOpts: null, credits: [], rateLimitToken: null };

/** The Mongo id `getOrCreateDbUser` resolves a Clerk id to (see credits). */
const DB_USER_ID = "mongo_abc123";

type FireChatResult =
  | {
      text: string | null;
      functionCalls: {
        id?: string;
        name: string;
        args: Record<string, unknown>;
      }[];
      source: "deterministic" | "llm";
    }
  | { error: string; detail?: string };

function inject(opts: {
  userId: string | null;
  isDemo?: boolean;
  gemini?: GeminiStubConfig;
  creditsOk?: boolean; // does consumeCredits succeed? (default true)
  rateLimitOk?: boolean; // does the limiter allow it? (default true)
  dbUser?: { id: string } | null; // getOrCreateDbUser result (default present)
}) {
  captured.modelOpts = null; // so tests can assert the model was NOT built
  captured.credits = [];
  captured.rateLimitToken = null;
  const cache = (require as unknown as { cache: Record<string, unknown> })
    .cache;
  const clerkPath = require.resolve("@clerk/nextjs/server");
  const sessionPath = require.resolve("../../lib/demo/session");
  const geminiPath = require.resolve("../../lib/gemini/client");
  const servicesPath = require.resolve("@usemoney/services");
  const dbUserPath = require.resolve("../../lib/db/user");
  const headersPath = require.resolve("next/headers");
  const rateLimitPath = require.resolve("@usemoney/security/rate-limit");
  const actionPath = require.resolve("../../lib/actions/fire-chat");

  for (const p of [
    clerkPath,
    sessionPath,
    geminiPath,
    servicesPath,
    dbUserPath,
    headersPath,
    rateLimitPath,
    actionPath, // fresh action import per test
  ]) {
    delete cache[p];
  }

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
    exports: {
      __esModule: true,
      auth: async () => ({ userId: opts.userId }),
    },
  };
  cache[sessionPath] = {
    exports: {
      __esModule: true,
      isDemoSession: async () => opts.isDemo ?? false,
    },
  };
  cache[dbUserPath] = {
    exports: {
      __esModule: true,
      getOrCreateDbUser: async () =>
        opts.dbUser === undefined ? { id: DB_USER_ID } : opts.dbUser,
    },
  };
  cache[headersPath] = {
    exports: {
      __esModule: true,
      headers: async () => new Map<string, string>(),
    },
  };
  cache[rateLimitPath] = {
    exports: {
      __esModule: true,
      apiRateLimiter: {
        check: async (_limit: number, token: string) => {
          captured.rateLimitToken = token;
          return opts.rateLimitOk === false
            ? { success: false, remaining: 0, reset: 60 }
            : { success: true, remaining: 89, reset: 60 };
        },
      },
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
                      // MONEY-1240: real candidates always carry a
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
  return require("../../lib/actions/fire-chat") as {
    fireChatTurnAction: (
      contents: unknown[],
      snapshot: unknown
    ) => Promise<FireChatResult>;
  };
}

// ── fixtures ────────────────────────────────────────────────────────

const SNAPSHOT = {
  parameters: {
    currentAge: 30,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 1_800_000,
    monthlySavings: 60_000,
    safeWithdrawalRate: 4,
    taxRate: 30,
    salaryIncrement: 10,
    savingsIncrement: 8,
  },
  assetClasses: [{ name: "Equity", allocation: 100, expectedReturn: 12 }],
  expenses: [{ category: "Housing", amount: 25000, inflation: 5 }],
  oneTimeGoals: [],
  savedScenarios: [],
  computed: {
    fireNumber: 10_000_000,
    yearsToFire: 12,
    corpusAtRetirement: 12_000_000,
    fireAchievedAtRetirement: true,
    surplusAtRetirement: 2_000_000,
    sustainableMonthlySpend: 80_000,
    swrComparisonFireNumber: 9_000_000,
    firstShortfallAge: null,
  },
};

// Deliberately ambiguous (a question) so it falls through Tier 1 to the LLM —
// the auth / mapping / failure suites below exercise the Gemini path.
const QUESTION = [
  { role: "user", parts: [{ text: "how am I doing overall?" }] },
];

const isErr = (r: FireChatResult): r is { error: string; detail?: string } =>
  "error" in r;

function okOf(r: FireChatResult) {
  assert.ok(
    !isErr(r),
    `expected success, got error: ${isErr(r) ? r.error : ""}`
  );
  return r as Exclude<FireChatResult, { error: string }>;
}

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

describe("fire-chat action — auth layering", () => {
  it("production + no user + no demo → Unauthorized", async () => {
    setEnv({ nodeEnv: "production", apiKey: "k" });
    const { fireChatTurnAction } = inject({ userId: null, isDemo: false });
    const res = await fireChatTurnAction(QUESTION, SNAPSHOT);
    assert.ok(isErr(res));
    assert.equal(res.error, "Unauthorized");
  });

  it("production + demo session (no Clerk) → passes auth", async () => {
    setEnv({ nodeEnv: "production", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: null,
      isDemo: true,
      gemini: { parts: [{ text: "ok" }] },
    });
    const res = await fireChatTurnAction(QUESTION, SNAPSHOT);
    assert.ok(!isErr(res));
  });

  it("dev + no user + no demo → still open (local testing)", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: null,
      isDemo: false,
      gemini: { parts: [{ text: "ok" }] },
    });
    const res = await fireChatTurnAction(QUESTION, SNAPSHOT);
    assert.ok(!isErr(res));
  });
});

describe("fire-chat action — rate limiting (before any work)", () => {
  it("a limiter rejection short-circuits BEFORE the model is built", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      rateLimitOk: false,
      gemini: { parts: [{ text: "never reached" }] },
    });
    const res = await fireChatTurnAction(QUESTION, SNAPSHOT);
    assert.ok(isErr(res));
    assert.match(res.error, /Too many requests/i);
    assert.equal(captured.modelOpts, null, "must not reach Gemini");
  });

  it("an authed user is limited per-user, not per-IP", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "ok" }] },
    });
    await fireChatTurnAction(QUESTION, SNAPSHOT);
    assert.equal(captured.rateLimitToken, "fire:user:user_1");
  });
});

describe("fire-chat action — config & input validation", () => {
  it("no GOOGLE_GENAI_API_KEY and no GCP_PROJECT_ID → not-configured with dev detail", async () => {
    setEnv({ nodeEnv: "test", apiKey: undefined, project: undefined });
    const { fireChatTurnAction } = inject({ userId: "user_1" });
    const res = await fireChatTurnAction(QUESTION, SNAPSHOT);
    assert.ok(isErr(res));
    assert.match(res.error, /not configured/i);
    assert.match(res.detail ?? "", /GOOGLE_GENAI_API_KEY/);
  });

  it("missing contents / empty contents / missing snapshot → validation error", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({ userId: "user_1" });

    for (const [contents, snapshot] of [
      [undefined, SNAPSHOT],
      [[], SNAPSHOT],
      [QUESTION, undefined],
    ] as [unknown[] | undefined, unknown][]) {
      const res = await fireChatTurnAction(contents as unknown[], snapshot);
      assert.ok(
        isErr(res),
        `expected an error for ${JSON.stringify(contents)}`
      );
      assert.match(res.error, /required/i);
    }
    // never reached Gemini on a malformed call
    assert.equal(captured.modelOpts, null);
  });
});

describe("fire-chat action — Tier 1 deterministic fast path", () => {
  it("an unambiguous command returns tool calls WITHOUT calling Gemini", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({ userId: "user_1" }); // no gemini stub
    const res = okOf(
      await fireChatTurnAction(
        [{ role: "user", parts: [{ text: "set my retirement age to 45" }] }],
        SNAPSHOT
      )
    );
    assert.equal(res.source, "deterministic");
    assert.deepEqual(res.functionCalls, [
      { name: "setRetirementAge", args: { age: 45 } },
    ]);
    assert.equal(res.text, null);
    // the whole point: no model was built → no credit, no latency
    assert.equal(captured.modelOpts, null);
  });

  it("an ambiguous message falls through to the LLM (source llm)", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "You're doing great." }] },
    });
    const res = okOf(await fireChatTurnAction(QUESTION, SNAPSHOT));
    assert.equal(res.source, "llm");
    assert.notEqual(captured.modelOpts, null); // model WAS built
  });

  it("a follow-up turn (functionResponse) never short-circuits — goes to LLM", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "Done — retirement age is now 45." }] },
    });
    const res = okOf(
      await fireChatTurnAction(
        [
          { role: "user", parts: [{ text: "set my retirement age to 45" }] },
          {
            role: "model",
            parts: [
              { functionCall: { name: "setRetirementAge", args: { age: 45 } } },
            ],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "setRetirementAge",
                  response: { result: "ok" },
                },
              },
            ],
          },
        ],
        SNAPSHOT
      )
    );
    assert.equal(res.source, "llm");
    assert.notEqual(captured.modelOpts, null);
  });
});

describe("fire-chat action — credits (you pay to THINK, not to ACT)", () => {
  it("a PURE-ANSWER LLM turn charges one 'fire_chat' credit — keyed on the MONGO id", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "You're doing great." }] }, // no functionCall
    });
    await fireChatTurnAction(QUESTION, SNAPSHOT);
    const consumes = captured.credits.filter((c) => c.fn === "consume");
    assert.equal(consumes.length, 1);
    // MONEY-1079 bug fix: consumeCredits keys the subscription on the internal
    // Mongo user id. The deleted route passed the raw Clerk id ("user_1"), so
    // every charged turn failed with "Failed to consume credits".
    assert.deepEqual(consumes[0], {
      fn: "consume",
      userId: DB_USER_ID,
      action: "fire_chat",
    });
    assert.notEqual(consumes[0]?.userId, "user_1", "must not use the Clerk id");
  });

  it("an LLM turn that RETURNS tool calls is FREE (functions → no credit)", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: {
        parts: [
          { functionCall: { name: "setRetirementAge", args: { age: 45 } } },
        ],
      },
    });
    await fireChatTurnAction(QUESTION, SNAPSHOT);
    assert.equal(captured.credits.length, 0);
  });

  it("the deterministic fast path charges NOTHING", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({ userId: "user_1" });
    await fireChatTurnAction(
      [{ role: "user", parts: [{ text: "set my retirement age to 45" }] }],
      SNAPSHOT
    );
    assert.equal(captured.credits.length, 0);
  });

  it("a follow-up hop (functionResponse) is a FREE continuation", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "All set." }] },
    });
    await fireChatTurnAction(
      [
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "setRetirementAge",
                response: { result: "ok" },
              },
            },
          ],
        },
      ],
      SNAPSHOT
    );
    assert.equal(captured.credits.length, 0);
  });

  it("insufficient credits on a pure-answer turn → error (charged post-response)", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      creditsOk: false,
      gemini: { parts: [{ text: "You're doing great." }] },
    });
    const res = await fireChatTurnAction(QUESTION, SNAPSHOT);
    assert.ok(isErr(res));
    assert.match(res.error, /credits/i);
  });

  it("a Gemini failure charges nothing (credit is only taken post-success)", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: { throwError: new Error("upstream exploded") },
    });
    await fireChatTurnAction(QUESTION, SNAPSHOT);
    assert.equal(captured.credits.length, 0);
  });

  it("a demo user (no Clerk id) is not charged", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: null,
      isDemo: true,
      gemini: { parts: [{ text: "You're doing great." }] },
    });
    await fireChatTurnAction(QUESTION, SNAPSHOT);
    assert.equal(captured.credits.length, 0);
  });

  it("a missing db user skips the charge rather than failing the turn", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      dbUser: null,
      gemini: { parts: [{ text: "You're doing great." }] },
    });
    const res = await fireChatTurnAction(QUESTION, SNAPSHOT);
    assert.ok(!isErr(res), "turn must still succeed");
    assert.equal(captured.credits.length, 0);
  });
});

describe("fire-chat action — Gemini response mapping", () => {
  it("returns text + functionCalls (id passthrough, empty names filtered)", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: {
        parts: [
          { text: "Updating " },
          { text: "your plan." },
          {
            functionCall: {
              id: "call_1",
              name: "setRetirementAge",
              args: { age: 45 },
            },
          },
          { functionCall: { name: "", args: {} } }, // empty name → filtered
        ],
      },
    });
    const res = okOf(await fireChatTurnAction(QUESTION, SNAPSHOT));
    assert.equal(res.text, "Updating your plan.");
    assert.equal(res.functionCalls.length, 1);
    assert.equal(res.functionCalls[0]?.id, "call_1");
    assert.equal(res.functionCalls[0]?.name, "setRetirementAge");
  });

  it("no parts → text null, functionCalls empty", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: { parts: [] },
    });
    const res = okOf(await fireChatTurnAction(QUESTION, SNAPSHOT));
    assert.equal(res.text, null);
    assert.deepEqual(res.functionCalls, []);
  });

  it("builds the model with FIRE tools + a snapshot-bearing system prompt", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "ok" }] },
    });
    await fireChatTurnAction(QUESTION, SNAPSHOT);
    const opts = captured.modelOpts;
    assert.ok(opts, "model was not built");
    assert.ok(Array.isArray(opts.tools));
    // the live plan is injected so the model can answer "how am I doing?"
    assert.match(String(opts.systemInstruction), /CURRENT PLAN/);
    assert.match(String(opts.systemInstruction), /60000|60,000/);
  });
});

describe("fire-chat action — failure surface", () => {
  it("Gemini throw → error with dev detail", async () => {
    setEnv({ nodeEnv: "test", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: { throwError: new Error("upstream exploded") },
    });
    const res = await fireChatTurnAction(QUESTION, SNAPSHOT);
    assert.ok(isErr(res));
    assert.match(res.error, /unavailable/i);
    assert.equal(res.detail, "upstream exploded");
  });

  it("Gemini throw in production → generic message, NO detail leak", async () => {
    setEnv({ nodeEnv: "production", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: { throwError: new Error("secret internal path /var/creds") },
    });
    const res = await fireChatTurnAction(QUESTION, SNAPSHOT);
    assert.ok(isErr(res));
    assert.equal(res.detail, undefined);
    assert.ok(!res.error.includes("/var/creds"), "must not leak internals");
  });
});

/**
 * MONEY-1240 — a truncated candidate must not pass as a finished answer.
 *
 * Ask FIRE replies were stopping mid-sentence, always exactly where a computed
 * figure belonged: "…and you would achieve it" with no age, "…you would need"
 * with no rupee amount. Two defects stacked. `maxOutputTokens` was 1024, which
 * a projection answer overruns; and `finishReason` was never read, so a
 * candidate that stopped on MAX_TOKENS was indistinguishable from one that
 * finished. The fragment rendered as a confident, complete reply.
 *
 * Reading finishReason is the load-bearing half — without it, raising the cap
 * only moves the cliff, and the next long answer truncates just as silently.
 */
describe("fireChatTurnAction — truncation (MONEY-1240)", () => {
  // env restore is handled by the file-level afterEach above.

  it("[regression] MAX_TOKENS on a text-only turn is an error, NOT a reply", async () => {
    setEnv({ nodeEnv: "development", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: {
        parts: [{ text: "…and you would achieve it" }],
        finishReason: "MAX_TOKENS",
      },
    });
    const res = await fireChatTurnAction(QUESTION, SNAPSHOT);

    assert.ok(isErr(res), "a truncated candidate must not return as text");
    // The half-sentence must not reach the user dressed as an answer.
    assert.ok(
      !("text" in res),
      "the fragment must not be returned as a normal reply"
    );
  });

  it("[regression] a truncated turn is NOT charged", async () => {
    setEnv({ nodeEnv: "development", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: {
        parts: [{ text: "…you would need" }],
        finishReason: "MAX_TOKENS",
      },
    });
    await fireChatTurnAction(QUESTION, SNAPSHOT);

    // You pay to THINK, not to be cut off — the guard returns before
    // consumeCredits, so a user is never billed for half an answer.
    const consumes = captured.credits.filter((c) => c.fn === "consume");
    assert.equal(consumes.length, 0, "must not charge for a truncated answer");
  });

  it("MAX_TOKENS alongside tool calls still returns — the loop continues", async () => {
    setEnv({ nodeEnv: "development", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: {
        parts: [
          { text: "Updating your plan" },
          { functionCall: { name: "updateRetirementAge", args: { age: 55 } } },
        ],
        finishReason: "MAX_TOKENS",
      },
    });
    const res = await fireChatTurnAction(QUESTION, SNAPSHOT);

    // The client executes the call and hops again, so the truncated prose is
    // not the final word. Failing here would strand an applied tool call.
    assert.ok(!isErr(res), "a tool-bearing turn must still return");
    assert.equal(res.functionCalls.length, 1);
  });

  it("a normal STOP finish is unaffected", async () => {
    setEnv({ nodeEnv: "development", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "You reach ₹10 crore at age 52." }] },
    });
    const res = await fireChatTurnAction(QUESTION, SNAPSHOT);

    assert.ok(!isErr(res));
    assert.equal(res.text, "You reach ₹10 crore at age 52.");
  });

  it("the output budget is large enough for a projection answer", async () => {
    setEnv({ nodeEnv: "development", apiKey: "k" });
    const { fireChatTurnAction } = inject({
      userId: "user_1",
      gemini: { parts: [{ text: "ok" }] },
    });
    await fireChatTurnAction(QUESTION, SNAPSHOT);

    // 1024 was the shipped value that truncated in production.
    const cfg = captured.modelOpts?.generationConfig as
      | { maxOutputTokens?: number }
      | undefined;
    assert.ok(
      (cfg?.maxOutputTokens ?? 0) > 1024,
      `maxOutputTokens must exceed the 1024 that truncated; got ${cfg?.maxOutputTokens}`
    );
  });
});
