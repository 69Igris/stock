/**
 * `triggerCompositionExtractionAction` — the guards. MONEY-1405 A1.
 *
 * ## The exposure
 *
 * The action was a bare pass-through to `triggerCompositionExtractionService`:
 * no `auth()`, no userId, no demo refusal, no limiter. Each call spends a
 * `gemini-2.5-pro` THINKING call, and the action is reachable by anyone
 * holding a valid `sb_demo` cookie. `/compare` made that concrete by
 * auto-firing an extraction for every fund on mount — up to five per page
 * load, for ETFs, in demo mode — bypassing `shouldAutoExtractComposition`
 * (packages/core), which refuses exactly those cases.
 *
 * ## What is pinned here
 *
 *   1. no Clerk userId          → refused, service NOT called;
 *   2. demo session             → refused with a DISTINCT message, NOT called;
 *   3. the 6th call in an hour  → refused, NOT called;
 *   4. `app/compare/client.tsx` has no auto-firing effect, and the explicit
 *      button survives.
 *
 * The real action runs: Clerk, the demo session and the service are stubbed at
 * module resolution (the `require.cache` pattern from
 * `__tests__/actions/fire-chat-action.test.ts`), and the LIMITER is NOT
 * stubbed — case 3 drives the real `createRateLimiter` LRU.
 *
 * Every case is mutation-verified; the mutation is recorded on the case.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

// ── module stubs ────────────────────────────────────────────────────

interface ServiceCall {
  fundType: string;
  fundId: string;
}

interface CreditCall {
  userId: string;
  action: string;
  arg?: unknown;
}

const captured: {
  serviceCalls: ServiceCall[];
  charges: CreditCall[];
  refunds: CreditCall[];
  /**
   * One interleaved log, because ORDER is the assertion and three separate
   * counters cannot express it: "charged once and extracted once" is true
   * whichever way round they ran.
   */
  order: string[];
} = { serviceCalls: [], charges: [], refunds: [], order: [] };

/**
 * The stubs READ from this, they do not close over `inject`'s arguments: under
 * tsx/CJS the action captures the stub's exports object once at require time,
 * so swapping `require.cache` afterwards would leave it holding the old one.
 * Mutating what the stub reads is the only way to change the caller mid-test
 * while keeping ONE limiter instance alive.
 */
const current: {
  userId: string | null;
  isDemo: boolean;
  /** What `consumeCredits` answers. `null` = enough credits. */
  creditError: string | null;
  /** What the extraction service answers. */
  serviceFails: boolean;
} = {
  userId: null,
  isDemo: false,
  creditError: null,
  serviceFails: false,
};

type ActionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
};

type CompositionModule = {
  triggerCompositionExtractionAction: (
    fundType: "MF" | "ETF" | "INDEX",
    fundId: string
  ) => Promise<ActionResult>;
};

/**
 * Fresh action module per call, so the module-scope limiter starts empty.
 * A test that needs to exhaust the limiter must therefore inject ONCE and
 * call the returned action repeatedly.
 */
function inject(opts: {
  userId: string | null;
  isDemo?: boolean;
  creditError?: string | null;
  serviceFails?: boolean;
}): CompositionModule {
  captured.serviceCalls = [];
  captured.charges = [];
  captured.refunds = [];
  captured.order = [];
  current.userId = opts.userId;
  current.isDemo = opts.isDemo ?? false;
  current.creditError = opts.creditError ?? null;
  current.serviceFails = opts.serviceFails ?? false;

  const cache = (require as unknown as { cache: Record<string, unknown> })
    .cache;
  const clerkPath = require.resolve("@clerk/nextjs/server");
  const sessionPath = require.resolve("../../lib/demo/session");
  const servicesPath = require.resolve("@usemoney/services");
  const rateLimitPath = require.resolve("@usemoney/security/rate-limit");
  const authPath = require.resolve("../../lib/auth");
  const actionPath = require.resolve("../../lib/actions/fund-composition");

  for (const p of [
    clerkPath,
    sessionPath,
    servicesPath,
    rateLimitPath, // fresh LRU per inject
    authPath,
    actionPath, // fresh action (and fresh limiter) per inject
  ]) {
    delete cache[p];
  }

  // The DURABLE meter's identity. `auth()` above answers "is there a session";
  // this answers "which user's balance" — credits key on the INTERNAL id.
  cache[authPath] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: async () =>
        current.userId ? { userId: `db_${current.userId}` } : null,
    },
  };

  cache[clerkPath] = {
    exports: {
      __esModule: true,
      auth: async () => ({ userId: current.userId }),
    },
  };
  cache[sessionPath] = {
    exports: {
      __esModule: true,
      isDemoSession: async () => current.isDemo,
    },
  };
  cache[servicesPath] = {
    exports: {
      __esModule: true,
      getFundComposition: async () => ({ success: true, data: null }),
      triggerCompositionExtraction: async (
        fundType: string,
        fundId: string
      ) => {
        captured.serviceCalls.push({ fundType, fundId });
        captured.order.push("extract");
        return current.serviceFails
          ? { success: false, error: "Extraction failed. Please try again." }
          : { success: true, data: { holdings: [] } };
      },
      consumeCredits: async (
        userId: string,
        action: string,
        metadata?: unknown
      ) => {
        captured.charges.push({ userId, action, arg: metadata });
        captured.order.push("charge");
        return current.creditError
          ? { success: false, error: current.creditError }
          : { success: true, data: { remaining: 3, creditsUsed: 2 } };
      },
      refundCredits: async (
        userId: string,
        action: string,
        amount?: number
      ) => {
        captured.refunds.push({ userId, action, arg: amount });
        captured.order.push("refund");
        return { success: true, data: { refunded: amount ?? 0 } };
      },
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../../lib/actions/fund-composition") as CompositionModule;
}

describe("MONEY-1405 A1 — triggerCompositionExtractionAction is guarded", () => {
  it("[security] refuses a request with no Clerk userId, and does not call the service", async () => {
    // MUTATION: delete `if (!userId) { return { success: false, error: "Unauthorized" }; }`
    // from lib/actions/fund-composition.ts →
    //   AssertionError: Expected values to be strictly equal: true !== false
    //   (the service ran for a signed-out caller).
    const { triggerCompositionExtractionAction } = inject({ userId: null });

    const res = await triggerCompositionExtractionAction("MF", "120503");

    assert.strictEqual(res.success, false, "a signed-out caller is refused");
    assert.ok(res.error, "the refusal carries a message");
    assert.strictEqual(
      captured.serviceCalls.length,
      0,
      "no Gemini extraction is spent on an unauthenticated caller"
    );
  });

  it("[security] refuses a demo session with a distinct message, and does not call the service", async () => {
    // MUTATION: delete the `if (await isDemoSession(userId)) { ... }` block →
    //   the userId below is non-null, so the action falls straight through to
    //   the service:
    //   AssertionError: Expected values to be strictly equal: true !== false
    const { triggerCompositionExtractionAction } = inject({
      userId: "user_demo",
      isDemo: true,
    });

    const res = await triggerCompositionExtractionAction("MF", "120503");

    assert.strictEqual(res.success, false, "a demo caller is refused");
    assert.match(
      res.error ?? "",
      /demo/i,
      "the demo refusal is distinguishable from the auth refusal"
    );
    assert.strictEqual(
      captured.serviceCalls.length,
      0,
      "demo renders fabricated data — an extraction there is pure spend"
    );
  });

  it("[security] the demo check runs BEFORE the userId guard, so a cookie-only demo caller still gets the demo message", async () => {
    // A real demo session has NO Clerk userId. `isDemoSession(null)` is the
    // branch that reads the cookie, so checking demo after `!userId` would
    // make it dead code — this is the ordering, not a second demo test.
    // MUTATION: move the demo block below the `if (!userId)` guard →
    //   AssertionError: /demo/i does not match "Unauthorized".
    const { triggerCompositionExtractionAction } = inject({
      userId: null,
      isDemo: true,
    });

    const res = await triggerCompositionExtractionAction("MF", "120503");

    assert.strictEqual(res.success, false);
    assert.match(res.error ?? "", /demo/i);
    assert.strictEqual(captured.serviceCalls.length, 0);
  });

  it("[security] allows 5 extractions in the hour and refuses the 6th (real limiter)", async () => {
    // MUTATION: delete the `compositionRateLimiter.check(...)` block →
    //   AssertionError: Expected values to be strictly equal: true !== false
    //   (call #6 succeeded), and serviceCalls.length is 6, not 5.
    const { triggerCompositionExtractionAction } = inject({
      userId: "user_live",
    });

    for (let i = 1; i <= 5; i++) {
      const ok = await triggerCompositionExtractionAction("MF", `fund-${i}`);
      assert.strictEqual(ok.success, true, `call #${i} is inside the budget`);
    }

    const sixth = await triggerCompositionExtractionAction("MF", "fund-6");

    assert.strictEqual(
      sixth.success,
      false,
      "the 6th call in the hour is refused"
    );
    assert.match(sixth.error ?? "", /try again/i);
    assert.strictEqual(
      captured.serviceCalls.length,
      5,
      "exactly five extractions reached the service"
    );
  });

  it("[regression] the budget is per-user — a second user is not charged for the first user's spend", async () => {
    // Guards the token: `createRateLimitKey("fund-composition", userId)`.
    // MUTATION: drop `userId` from the key (a constant token) →
    //   AssertionError: the second user's first call is refused.
    const { triggerCompositionExtractionAction } = inject({
      userId: "user_a",
    });
    for (let i = 1; i <= 5; i++) {
      await triggerCompositionExtractionAction("MF", `fund-${i}`);
    }
    assert.strictEqual(
      (await triggerCompositionExtractionAction("MF", "x")).success,
      false,
      "user_a is now exhausted"
    );

    // Same module instance, same limiter — only the signed-in user changes.
    current.userId = "user_b";

    const fresh = await triggerCompositionExtractionAction("MF", "y");
    assert.strictEqual(fresh.success, true, "user_b starts with a full budget");
  });
});

describe("MONEY-1401 F6 — the paid call is metered against the DURABLE budget", () => {
  /**
   * The LRU above is a module-scope `LRUCache`. On Vercel that is per WARM
   * LAMBDA INSTANCE, so the real ceiling was 5 × instances per hour, resetting
   * on every cold start and every deploy — with no entitlement check of any
   * kind behind it. `/compare`'s "Analyse all holdings" loops up to five funds,
   * so one click spent a whole instance-budget. `/api/chat` meters the same
   * class of spend — a `gemini-2.5-pro` thinking call — against the user's
   * durable credit balance, and now so does this.
   */
  it("[security] charges credits BEFORE the model call, with an explicit non-zero cost", async () => {
    // THE COST IS THE ASSERTION. `getCreditCost(action)` is
    // `CREDIT_COSTS[action] ?? 0`, and `consumeCredits` treats cost 0 as a FREE
    // action that is ALWAYS ALLOWED — so an id missing from that table is a
    // meter that silently authorises everything while reading like a guard.
    // `fund_composition_extract` is not in `plans.ts` (out of this change's
    // scope), so the cost is passed explicitly.
    //
    // MUTATION: drop `{ costOverride: CREDIT_COST }` from the consumeCredits
    //   call → AssertionError: undefined !== 2. VERIFIED red.
    // MUTATION: move the consumeCredits call AFTER the service call →
    //   AssertionError on the ordering assertion below. VERIFIED red.
    const { triggerCompositionExtractionAction } = inject({
      userId: "user_paid",
    });
    const res = await triggerCompositionExtractionAction("MF", "119598");

    assert.strictEqual(res.success, true);
    assert.strictEqual(captured.charges.length, 1, "charged exactly once");
    assert.strictEqual(captured.charges[0]!.userId, "db_user_paid");
    assert.strictEqual(captured.charges[0]!.action, "fund_composition_extract");
    assert.strictEqual(
      (captured.charges[0]!.arg as { costOverride?: number }).costOverride,
      2,
      "a 0-cost action is a free action — consumeCredits allows it outright"
    );
    assert.strictEqual(
      captured.refunds.length,
      0,
      "a success keeps the charge"
    );

    // Ordering, asserted as ORDER. Three counters cannot say it: "charged once
    // and extracted once" is true whichever way round they ran.
    assert.deepStrictEqual(captured.order, ["charge", "extract"]);
  });

  it("[security] out of credits → refused, and the model is NEVER called", async () => {
    // MUTATION: ignore `charged.success` (proceed regardless) →
    //   AssertionError: 1 !== 0 (the extraction ran unpaid). VERIFIED red.
    const { triggerCompositionExtractionAction } = inject({
      userId: "user_broke",
      creditError: "Not enough credits. You need 2 but have 0 remaining.",
    });

    const res = await triggerCompositionExtractionAction("MF", "119598");

    assert.strictEqual(res.success, false);
    assert.match(res.error ?? "", /credits/i);
    assert.strictEqual(
      captured.serviceCalls.length,
      0,
      "a gemini-2.5-pro thinking call must not be spent off-budget"
    );
    assert.strictEqual(
      captured.refunds.length,
      0,
      "nothing was charged to refund"
    );
  });

  it("a failed extraction REFUNDS the same amount it charged", async () => {
    // `refundCredits`' third argument is a plain NUMBER and it falls back to
    // `getCreditCost(action)` — 0 for an id not in the table — and a 0 refund
    // returns `{ refunded: 0 }` SUCCESSFULLY. So the charge and the refund have
    // to read the same constant or a failed extraction quietly keeps the user's
    // credits with no error anywhere.
    //
    // MUTATION: drop the third argument from the refundCredits call →
    //   AssertionError: undefined !== 2. VERIFIED red.
    // MUTATION: refund unconditionally (drop `if (!result.success)`) →
    //   AssertionError in the success case above: 1 !== 0. VERIFIED red.
    const { triggerCompositionExtractionAction } = inject({
      userId: "user_unlucky",
      serviceFails: true,
    });

    const res = await triggerCompositionExtractionAction("MF", "119598");

    assert.strictEqual(res.success, false);
    assert.strictEqual(captured.charges.length, 1);
    assert.strictEqual(captured.refunds.length, 1);
    assert.strictEqual(captured.refunds[0]!.userId, "db_user_unlucky");
    assert.strictEqual(captured.refunds[0]!.action, "fund_composition_extract");
    assert.strictEqual(captured.refunds[0]!.arg, 2, "refund the cost, not 0");
    assert.deepStrictEqual(captured.order, ["charge", "extract", "refund"]);
  });

  it("[security] the CHEAP guards all run before a credit is touched", async () => {
    // Order is demo → userId → LRU → credits → spend, cheapest refusal first.
    // A demo or signed-out caller must not reach the durable meter at all —
    // charging then refusing would debit a balance for a call we never make.
    //
    // MUTATION: move the consumeCredits call above the demo/auth guards →
    //   AssertionError: 1 !== 0 on the first case. VERIFIED red.
    for (const opts of [
      { userId: null },
      { userId: "user_demo", isDemo: true },
    ]) {
      const { triggerCompositionExtractionAction } = inject(opts);
      await triggerCompositionExtractionAction("MF", "119598");
      assert.strictEqual(
        captured.charges.length,
        0,
        `refused caller ${JSON.stringify(opts)} must not be charged`
      );
    }
  });

  it("[security] the LRU burst guard still refuses the 6th, WITHOUT charging for it", async () => {
    // Both meters, in the right order: the free one first. A rate-limited call
    // that had already been debited would cost a credit for a refusal.
    //
    // MUTATION: move the LRU check below consumeCredits → AssertionError:
    //   6 !== 5 (the refused 6th call was charged). VERIFIED red.
    const { triggerCompositionExtractionAction } = inject({
      userId: "user_burst",
    });
    for (let i = 1; i <= 5; i++) {
      await triggerCompositionExtractionAction("MF", `fund-${i}`);
    }
    const sixth = await triggerCompositionExtractionAction("MF", "fund-6");

    assert.strictEqual(sixth.success, false);
    assert.strictEqual(captured.charges.length, 5, "the refusal is free");
    assert.strictEqual(captured.serviceCalls.length, 5);
  });
});

// ── source scan: /compare must not auto-fire ────────────────────────

/** LINE before BLOCK — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Balanced-paren bodies of every `useEffect(` call in `src`. */
function useEffectBodies(src: string): string[] {
  const out: string[] = [];
  const needle = "useEffect(";
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) {
    let depth = 0;
    for (let j = i + needle.length - 1; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") {
        depth--;
        if (depth === 0) {
          out.push(src.slice(i, j + 1));
          break;
        }
      }
    }
  }
  return out;
}

describe("MONEY-1405 A1 — /compare does not auto-extract composition", () => {
  const src = stripComments(
    readFileSync(join(ROOT, "app/compare/client.tsx"), "utf8")
  );

  it("[regression] no useEffect calls runAnalyse", () => {
    // The deleted effect was:
    //   useEffect(() => {
    //     if (funds.length > 0 && !hasCompositions && !isAnalysing) runAnalyse();
    //   }, []);
    // …which fired up to five gemini-2.5-pro calls per page load, for ETFs,
    // in demo mode. /compare has no per-fund disclosure lookup, so it cannot
    // supply `hasOfficialDisclosure` to `shouldAutoExtractComposition`
    // honestly — an auto-trigger that cannot evaluate the gate must not run.
    //
    // MUTATION: restore that effect in app/compare/client.tsx →
    //   AssertionError: a useEffect in /compare calls runAnalyse …
    for (const body of useEffectBodies(src)) {
      assert.ok(
        !body.includes("runAnalyse"),
        `a useEffect in /compare calls runAnalyse — auto-extraction is back:\n${body}`
      );
    }
  });

  it("[regression] the explicit button is the only call site", () => {
    // Deleting `runAnalyse` outright would pass the case above vacuously.
    // MUTATION: remove the onClick → AssertionError (no call site left).
    assert.match(
      src,
      /onClick=\{\(\) => void runAnalyse\(\)\}/,
      "the Analyse-all-holdings button must keep the manual entry point"
    );
    assert.strictEqual(
      (src.match(/runAnalyse\(/g) ?? []).length,
      1,
      "exactly one call site: the button"
    );
  });
});
