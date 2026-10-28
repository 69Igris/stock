/**
 * MONEY-620 — generateStrategyAction END-TO-END (real handler).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a SHADOW: under "// EXTRACTED PURE FUNCTIONS (mirrors
 * strategy.ts)" it re-declared `validateStrategyInput`, `parseStrategyJSON`,
 * `validateStrategy`, `processStrategyResponse` — then asserted the COPIES. It
 * imported NOTHING from `lib/actions/strategy.ts`. So the real auth gate, the
 * real prompt-length gates, the actual fenced-code-block stripping + JSON.parse
 * on the model output, the incomplete-strategy guard, and the SyntaxError →
 * friendly-message path were never exercised on the shipping code.
 *
 * This rewrite drives the REAL exported `generateStrategyAction` through the
 * `require.cache` seam, stubbing only the Gemini boundary (`getGeminiModel` +
 * `generateWithTimeout`) and Clerk `currentUser`. Everything the action OWNS —
 * auth, both length gates, the ```json fence strip, JSON.parse, the
 * name/rules.entry/rules.exit completeness gate, the SyntaxError branch, and the
 * generic catch — runs for real.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/strategy.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

interface Harness {
  user: { id: string } | null;
  /**
   * MONEY-1142 — the plan the `aiStrategies` tier gate resolves. Defaults to
   * an entitled plan: this file's subject is prompt construction and response
   * parsing, not entitlement. "FREE" exercises the denial.
   */
  planId: string;
  /** What generateWithTimeout resolves to (the raw model text). */
  modelResponse: string;
  /** If set, generateWithTimeout rejects. */
  modelThrows?: Error;
  generateCalls: Array<{ prompt: string; timeout: number }>;
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

const ACTION_REL = "../../lib/actions/strategy";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

interface GeneratedStrategy {
  name: string;
  description: string;
  type: string;
  risk: string;
  timeframe: string;
  rules: { entry: string; exit: string; stopLoss: string };
  params?: Record<string, unknown>;
  overlays?: string[];
}

interface StrategyModule {
  generateStrategyAction: (prompt: string) => Promise<{
    success: boolean;
    data?: GeneratedStrategy;
    error?: string;
  }>;
}

function freshHarness(): Harness {
  return {
    user: { id: "user-1" },
    planId: "PREMIUM",
    modelResponse: "",
    generateCalls: [],
  };
}

function loadAction(h: Harness): StrategyModule {
  const cache = moduleCache();

  // MONEY-1142 — the action now resolves the INTERNAL user via `@/lib/auth`
  // rather than Clerk's `currentUser()`, because the tier gate looks a
  // subscription up by internal id (a Clerk id matches nothing and would deny
  // everyone). Stubbing Clerk here would leave `getAuthenticatedUser` real.
  const authPath = require.resolve("../../lib/auth");
  const servicesPath = require.resolve("@usemoney/services");
  const modelsPath = require.resolve("../../lib/gemini/models");
  const actionPath = require.resolve(ACTION_REL);
  // `premium-gate` imports services at module scope, so it must be evicted
  // with the action or it keeps the binding it first saw and ignores the stub.
  const gatePath = require.resolve("../../lib/actions/premium-gate");

  for (const p of [authPath, servicesPath, modelsPath]) snapshotOnce(p);

  cache[authPath] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: () =>
        Promise.resolve(h.user ? { userId: h.user.id } : null),
    },
  };
  cache[servicesPath] = {
    exports: {
      __esModule: true,
      getSubscription: (userId: string) =>
        Promise.resolve({ success: true, data: { userId, planId: h.planId } }),
    },
  };
  cache[modelsPath] = {
    exports: {
      __esModule: true,
      getGeminiModel: () => ({ __fake: "model" }),
      generateWithTimeout: (
        _model: unknown,
        prompt: string,
        timeout: number
      ) => {
        h.generateCalls.push({ prompt, timeout });
        if (h.modelThrows) return Promise.reject(h.modelThrows);
        return Promise.resolve(h.modelResponse);
      },
    },
  };

  delete cache[actionPath];
  delete cache[gatePath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as StrategyModule;
}

const validStrategy: GeneratedStrategy = {
  name: "RSI Reversal",
  description: "Buy oversold stocks using RSI",
  type: "MeanReversion",
  risk: "Medium",
  timeframe: "Short Term (Days)",
  rules: {
    entry: "RSI crosses above 30",
    exit: "RSI crosses above 70",
    stopLoss: "5% below entry",
  },
  overlays: ["RSI"],
  params: { rsiPeriod: 14 },
};

const GOOD_PROMPT =
  "Buy Nifty 50 stocks when RSI crosses above 30 with SMA 200 support";

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — generateStrategyAction (real handler, mocked Gemini)", () => {
  let h: Harness;
  beforeEach(() => {
    h = freshHarness();
  });
  after(() => {
    restoreCache();
  });

  describe("auth + input gates (run BEFORE the model)", () => {
    it("unauthenticated → Authentication required, model never called", async () => {
      h.user = null;
      const action = loadAction(h);
      const res = await action.generateStrategyAction(GOOD_PROMPT);
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Authentication required/);
      assert.equal(h.generateCalls.length, 0);
    });

    it("prompt under 10 chars → rejected before the model", async () => {
      const action = loadAction(h);
      const res = await action.generateStrategyAction("Buy RSI");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /more detailed/);
      assert.equal(h.generateCalls.length, 0);
    });

    it("empty prompt → rejected before the model", async () => {
      const action = loadAction(h);
      const res = await action.generateStrategyAction("");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /more detailed/);
      assert.equal(h.generateCalls.length, 0);
    });

    it("prompt over 2000 chars → rejected before the model", async () => {
      const action = loadAction(h);
      const res = await action.generateStrategyAction("a".repeat(2001));
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /too long/);
      assert.equal(h.generateCalls.length, 0);
    });

    it("exactly 10 chars passes the gate and reaches the model", async () => {
      h.modelResponse = JSON.stringify(validStrategy);
      const action = loadAction(h);
      const res = await action.generateStrategyAction("1234567890");
      assert.equal(res.success, true);
      assert.equal(h.generateCalls.length, 1);
    });
  });

  describe("model output parsing (real fence-strip + JSON.parse)", () => {
    it("plain JSON → success with the parsed strategy", async () => {
      h.modelResponse = JSON.stringify(validStrategy);
      const action = loadAction(h);
      const res = await action.generateStrategyAction(GOOD_PROMPT);
      assert.equal(res.success, true);
      assert.equal(res.data!.name, "RSI Reversal");
      assert.equal(res.data!.rules.entry, "RSI crosses above 30");
      // The action forwards the 15s timeout to the model boundary.
      assert.equal(h.generateCalls[0]!.timeout, 15000);
    });

    it("```json fenced output is stripped and parsed", async () => {
      h.modelResponse = "```json\n" + JSON.stringify(validStrategy) + "\n```";
      const action = loadAction(h);
      const res = await action.generateStrategyAction(GOOD_PROMPT);
      assert.equal(res.success, true);
      assert.equal(res.data!.name, "RSI Reversal");
    });

    it("bare ``` fence (no json tag) is stripped and parsed", async () => {
      h.modelResponse = "```\n" + JSON.stringify(validStrategy) + "\n```";
      const action = loadAction(h);
      const res = await action.generateStrategyAction(GOOD_PROMPT);
      assert.equal(res.success, true);
    });

    it("non-JSON output → SyntaxError branch → friendly parse error", async () => {
      h.modelResponse = "This is not valid JSON at all";
      const action = loadAction(h);
      const res = await action.generateStrategyAction(GOOD_PROMPT);
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Failed to parse AI response/);
    });

    it("valid JSON but incomplete strategy (no name/rules) → incomplete error", async () => {
      h.modelResponse = JSON.stringify({ description: "no name or rules" });
      const action = loadAction(h);
      const res = await action.generateStrategyAction(GOOD_PROMPT);
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /incomplete strategy/);
    });

    it("valid JSON but missing rules.exit → incomplete error", async () => {
      h.modelResponse = JSON.stringify({
        ...validStrategy,
        rules: { entry: "x", exit: "", stopLoss: "y" },
      });
      const action = loadAction(h);
      const res = await action.generateStrategyAction(GOOD_PROMPT);
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /incomplete strategy/);
    });

    it("a thrown model call → generic 'Failed to generate strategy'", async () => {
      h.modelThrows = new Error("vertex 500");
      const action = loadAction(h);
      const res = await action.generateStrategyAction(GOOD_PROMPT);
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Failed to generate strategy/);
    });
  });

  it("[MONEY-1142] a FREE plan is refused before the model is called", () => {
    // `/strategies` requires `aiStrategies` (PREMIUM/ULTIMATE). Before
    // MONEY-1142 this action checked auth only, so the paywall was the client
    // PageGuard alone. It also generates against a paid model, making an
    // ungated action a direct cost leak as well as a revenue one.
    const h = freshHarness();
    h.planId = "FREE";
    const action = loadAction(h);
    return action
      .generateStrategyAction("a detailed enough strategy idea")
      .then((res) => {
        assert.equal(res.success, false);
        // The message is what a user READS, so assert it is prose rather than a
        // machine token — `app/risk/client.tsx` throws `new Error(result.error)`
        // straight into a toast, and "UPGRADE_REQUIRED" as a toast is a bug.
        assert.match(res.error ?? "", /paid plan|Upgrade/i);
        assert.doesNotMatch(
          res.error ?? "",
          /^UPGRADE_REQUIRED$/,
          "a raw token must not reach the user"
        );
        assert.equal(
          h.generateCalls.length,
          0,
          "the gate must precede the model call — otherwise we pay for it anyway"
        );
      });
  });
});
