/**
 * Roast Processor Tests (workers/src/processors/roast.ts) — DE-SHADOWED.
 *
 * Previously this file re-declared a `processRoast` copy plus inline
 * `parseStepTimeout` / `parseTotalTimeout` / `shouldCreateNotification` /
 * `buildNotification` and asserted the copies — a shadow that stayed green even
 * if the real env-parse, notify gate, or notification payload regressed.
 *
 * Those bits now live in `workers/src/processors/roast-logic.ts`, which
 * `roast.ts` imports and CALLS; this test asserts the REAL exports and drives
 * the agent-creation + notification flow through a thin harness over the SAME
 * real `resolveRoastTimeouts` / `shouldNotifyRoast` / `buildRoastCompleteNotification`.
 *
 * BUG REGRESSION (MONEY-620): `parseTimeoutMs` now rejects NaN / 0 / negative to
 * the safe default. The old `parseInt(env || "60000")` only caught empty/unset,
 * so a misconfigured `ROAST_STEP_TIMEOUT_MS="abc"` produced a NaN timeout →
 * the RoastAgent's setTimeout fired immediately → every roast instantly "timed
 * out". (This is why the old "returns NaN"/"returns 0" assertions are replaced.)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// REAL worker logic under test (no shadow). roast.ts CALLS these.
import {
  parseTimeoutMs,
  resolveRoastTimeouts,
  shouldNotifyRoast,
  buildRoastCompleteNotification,
  DEFAULT_ROAST_STEP_TIMEOUT_MS,
  DEFAULT_ROAST_TOTAL_TIMEOUT_MS,
  type RoastNotification,
  type RoastTimeouts,
} from "../../../../workers/src/processors/roast-logic";

// ── RoastJobMessage shape (mirrors @usemoney/types) ──────────────────

interface RoastJobMessage {
  jobId: string;
  userId: string;
  sessionId: string;
  mode: "overall" | "broker";
  broker?: string;
  assetType: "stocks" | "mf" | "all";
}

function makeJobMessage(
  overrides: Partial<RoastJobMessage> = {}
): RoastJobMessage {
  return {
    jobId: "job-001",
    userId: "user-123",
    sessionId: "session-abc",
    mode: "overall",
    assetType: "all",
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════
// parseTimeoutMs (real export) — hardened against NaN / 0 / negative
// ══════════════════════════════════════════════════════════════════════

describe("parseTimeoutMs (real export)", () => {
  it("defaults when undefined", () => {
    assert.strictEqual(parseTimeoutMs(undefined, 60000), 60000);
  });

  it("defaults when empty string", () => {
    assert.strictEqual(parseTimeoutMs("", 60000), 60000);
  });

  it("parses a valid numeric string", () => {
    assert.strictEqual(parseTimeoutMs("120000", 60000), 120000);
    assert.strictEqual(parseTimeoutMs("1000", 60000), 1000);
  });

  it("parses leading digits of mixed strings (parseInt behavior)", () => {
    assert.strictEqual(parseTimeoutMs("45abc", 60000), 45);
  });

  // ── BUG REGRESSION: NaN / 0 / negative must NOT become the timeout ──

  it("falls back to the default for a non-numeric value (was NaN → instant timeout)", () => {
    assert.strictEqual(parseTimeoutMs("not-a-number", 60000), 60000);
  });

  it("falls back to the default for 0 (was 0 → instant timeout)", () => {
    assert.strictEqual(parseTimeoutMs("0", 60000), 60000);
  });

  it("falls back to the default for a negative value", () => {
    assert.strictEqual(parseTimeoutMs("-5000", 60000), 60000);
  });
});

// ══════════════════════════════════════════════════════════════════════
// resolveRoastTimeouts (real export)
// ══════════════════════════════════════════════════════════════════════

describe("resolveRoastTimeouts (real export)", () => {
  it("uses both defaults when env vars are unset", () => {
    assert.deepStrictEqual(resolveRoastTimeouts({}), {
      stepTimeoutMs: DEFAULT_ROAST_STEP_TIMEOUT_MS,
      totalTimeoutMs: DEFAULT_ROAST_TOTAL_TIMEOUT_MS,
    });
    assert.strictEqual(DEFAULT_ROAST_STEP_TIMEOUT_MS, 60000);
    assert.strictEqual(DEFAULT_ROAST_TOTAL_TIMEOUT_MS, 300000);
  });

  it("reads a custom step timeout from env", () => {
    assert.strictEqual(
      resolveRoastTimeouts({ ROAST_STEP_TIMEOUT_MS: "90000" }).stepTimeoutMs,
      90000
    );
  });

  it("reads a custom total timeout from env", () => {
    assert.strictEqual(
      resolveRoastTimeouts({ ROAST_TOTAL_TIMEOUT_MS: "600000" }).totalTimeoutMs,
      600000
    );
  });

  it("reads both custom timeouts", () => {
    assert.deepStrictEqual(
      resolveRoastTimeouts({
        ROAST_STEP_TIMEOUT_MS: "30000",
        ROAST_TOTAL_TIMEOUT_MS: "180000",
      }),
      { stepTimeoutMs: 30000, totalTimeoutMs: 180000 }
    );
  });

  it("keeps a misconfigured timeout from becoming 0/NaN (regression)", () => {
    assert.deepStrictEqual(
      resolveRoastTimeouts({
        ROAST_STEP_TIMEOUT_MS: "abc",
        ROAST_TOTAL_TIMEOUT_MS: "0",
      }),
      {
        stepTimeoutMs: DEFAULT_ROAST_STEP_TIMEOUT_MS,
        totalTimeoutMs: DEFAULT_ROAST_TOTAL_TIMEOUT_MS,
      }
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// shouldNotifyRoast (real export)
// ══════════════════════════════════════════════════════════════════════

describe("shouldNotifyRoast (real export)", () => {
  it("is true for a non-empty userId", () => {
    assert.strictEqual(shouldNotifyRoast("user-1"), true);
  });

  it("is false for an empty userId", () => {
    assert.strictEqual(shouldNotifyRoast(""), false);
  });

  it("is false for null/undefined", () => {
    assert.strictEqual(shouldNotifyRoast(null), false);
    assert.strictEqual(shouldNotifyRoast(undefined), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildRoastCompleteNotification (real export)
// ══════════════════════════════════════════════════════════════════════

describe("buildRoastCompleteNotification (real export)", () => {
  it("builds the completion payload", () => {
    const n = buildRoastCompleteNotification("user-42", "ses-abc");
    assert.strictEqual(n.userId, "user-42");
    assert.strictEqual(n.type, "ROAST_COMPLETE");
    assert.strictEqual(n.title, "Portfolio Roast Complete");
    assert.strictEqual(n.message, "Your portfolio roast is ready to view!");
  });

  it("derives the link as /roast/{sessionId}", () => {
    assert.strictEqual(
      buildRoastCompleteNotification("u", "session-12345").metadata.link,
      "/roast/session-12345"
    );
  });

  it("has exactly sessionId + link in metadata", () => {
    const keys = Object.keys(buildRoastCompleteNotification("u", "s").metadata);
    assert.deepStrictEqual(keys.sort(), ["link", "sessionId"]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Orchestration harness — mirrors processRoast's success path using the SAME
// real exports (the real processor boots Prisma + RoastAgent at import).
// ══════════════════════════════════════════════════════════════════════

interface RoastHarnessDeps {
  createAgent: (opts: RoastTimeouts) => {
    run: (d: RoastJobMessage) => Promise<void>;
  };
  createNotification: (n: RoastNotification) => Promise<void>;
  env: { ROAST_STEP_TIMEOUT_MS?: string; ROAST_TOTAL_TIMEOUT_MS?: string };
}

async function runRoast(
  data: RoastJobMessage,
  deps: RoastHarnessDeps
): Promise<void> {
  const agent = deps.createAgent(resolveRoastTimeouts(deps.env));
  await agent.run(data);
  if (shouldNotifyRoast(data.userId)) {
    await deps.createNotification(
      buildRoastCompleteNotification(data.userId, data.sessionId)
    );
  }
}

describe("roast success path (real exports)", () => {
  let notifications: RoastNotification[];
  let agentRunCalls: RoastJobMessage[];
  let capturedOpts: RoastTimeouts[];

  function deps(over: Partial<RoastHarnessDeps> = {}): RoastHarnessDeps {
    return {
      createAgent: (opts) => {
        capturedOpts.push(opts);
        return { run: async (d) => void agentRunCalls.push(d) };
      },
      createNotification: async (n) => void notifications.push(n),
      env: {},
      ...over,
    };
  }

  beforeEach(() => {
    notifications = [];
    agentRunCalls = [];
    capturedOpts = [];
  });

  it("creates the agent with env-derived timeouts and runs it", async () => {
    await runRoast(
      makeJobMessage(),
      deps({ env: { ROAST_STEP_TIMEOUT_MS: "90000" } })
    );
    assert.strictEqual(capturedOpts[0]!.stepTimeoutMs, 90000);
    assert.strictEqual(capturedOpts[0]!.totalTimeoutMs, 300000);
    assert.strictEqual(agentRunCalls.length, 1);
  });

  it("passes the job data unchanged to agent.run", async () => {
    const data = makeJobMessage({
      jobId: "j-42",
      broker: "ZERODHA",
      mode: "broker",
    });
    await runRoast(data, deps());
    assert.deepStrictEqual(agentRunCalls[0], data);
  });

  it("notifies on completion when userId is present", async () => {
    await runRoast(
      makeJobMessage({ userId: "user-42", sessionId: "ses-9" }),
      deps()
    );
    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0]!.userId, "user-42");
    assert.strictEqual(notifications[0]!.metadata.link, "/roast/ses-9");
  });

  it("still runs the agent but skips the notification when userId is empty", async () => {
    await runRoast(makeJobMessage({ userId: "" }), deps());
    assert.strictEqual(agentRunCalls.length, 1);
    assert.strictEqual(notifications.length, 0);
  });
});
