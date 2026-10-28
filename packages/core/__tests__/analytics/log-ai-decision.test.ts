/**
 * AI decision logger — never-throw + no-PII-leak contract (MONEY-786).
 *
 * `logAiDecision` dual-sinks to Mongo (gated on `DATABASE_URL`) and PostHog
 * (gated on `POSTHOG_API_KEY`, via raw `fetch`). The two guarantees that matter
 * for safety:
 *
 *   1. It NEVER throws — both sinks are best-effort, so a logging failure can
 *      never break the user request that produced the decision. We assert this
 *      with both sinks unconfigured AND with a `fetch` that rejects.
 *   2. It never leaks the prompt `input`/`output`, holdings, or secrets to the
 *      third-party analytics vendor. We stub `fetch`, drive the PostHog path,
 *      and assert the captured body carries ONLY bounded telemetry — and that a
 *      non-serializable `metadata` value is normalized (not thrown on).
 *
 * The DB write path is integration-shaped and not unit-tested here (asserting
 * it never throws with `DATABASE_URL` unset covers the safe path).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { logAiDecision, toJsonSafe } from "../../src/analytics/index";

const ORIGINAL_FETCH = globalThis.fetch;

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("logAiDecision — never throws", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("resolves when neither DATABASE_URL nor POSTHOG_API_KEY is set (full no-op)", async () => {
    const saved = {
      DATABASE_URL: process.env.DATABASE_URL,
      POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
    };
    delete process.env.DATABASE_URL;
    delete process.env.POSTHOG_API_KEY;
    try {
      await assert.doesNotReject(
        logAiDecision({
          decisionType: "CHAT_REPLY",
          model: "gemini-2.5-flash",
          input: { prompt: "secret prompt" },
          output: { text: "answer" },
          rationale: "test",
        }),
      );
    } finally {
      restoreEnv(saved);
    }
  });

  it("swallows a rejecting fetch on the PostHog path (never throws into the caller)", async () => {
    const saved = { POSTHOG_API_KEY: process.env.POSTHOG_API_KEY };
    process.env.POSTHOG_API_KEY = "phc_test";
    globalThis.fetch = (() =>
      Promise.reject(new Error("network down"))) as typeof fetch;
    try {
      await assert.doesNotReject(
        logAiDecision({
          decisionType: "RESEARCH_RUN",
          model: "gemini-2.5-pro",
          input: { prompt: "x" },
          output: { text: "y" },
          rationale: "test",
        }),
      );
    } finally {
      restoreEnv(saved);
    }
  });
});

describe("logAiDecision — PostHog payload carries no PII / prompt content", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  async function captureBody(
    input: Parameters<typeof logAiDecision>[0],
  ): Promise<{
    event: string;
    properties: Record<string, unknown>;
    distinct_id: string;
  }> {
    const saved = {
      POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
      DATABASE_URL: process.env.DATABASE_URL,
    };
    process.env.POSTHOG_API_KEY = "phc_test";
    delete process.env.DATABASE_URL; // skip the DB sink entirely
    let captured: unknown = null;
    globalThis.fetch = ((_url: string, init?: { body?: string }) => {
      captured = JSON.parse(init!.body as string);
      return Promise.resolve({ ok: true } as Response);
    }) as unknown as typeof fetch;
    try {
      await logAiDecision(input);
    } finally {
      globalThis.fetch = ORIGINAL_FETCH;
      restoreEnv(saved);
    }
    return captured as {
      event: string;
      properties: Record<string, unknown>;
      distinct_id: string;
    };
  }

  it("emits only bounded telemetry — no prompt input/output, no rationale", async () => {
    const body = await captureBody({
      decisionType: "CHAT_REPLY",
      provider: "ANTHROPIC",
      model: "claude-3-5-sonnet",
      userId: "user-42",
      input: { prompt: "USER HOLDS 500 SHARES OF INFY — secret" },
      output: { text: "do not leak me" },
      rationale: "internal reasoning that should not ship to posthog",
      outcome: "ok",
      sessionId: "sess-1",
      qualityScore: 0.8,
      usage: { inputTokens: 10, outputTokens: 20, latencyMs: 5, costUsd: 0.01 },
    });

    assert.equal(body.event, "ai_decision");
    assert.equal(body.distinct_id, "user-42");

    const serialized = JSON.stringify(body);
    // The prompt input/output and rationale must NOT be present anywhere.
    assert.ok(!serialized.includes("secret"), "prompt input leaked");
    assert.ok(!serialized.includes("do not leak me"), "output leaked");
    assert.ok(
      !serialized.includes("internal reasoning"),
      "rationale leaked to vendor",
    );
    assert.ok(!("input" in body.properties), "raw input property present");
    assert.ok(!("output" in body.properties), "raw output property present");
    assert.ok(!("rationale" in body.properties), "rationale property present");

    // The bounded telemetry IS present.
    assert.equal(body.properties.decisionType, "CHAT_REPLY");
    assert.equal(body.properties.provider, "ANTHROPIC");
    assert.equal(body.properties.model, "claude-3-5-sonnet");
    assert.equal(body.properties.inputTokens, 10);
    assert.equal(body.properties.costUsd, 0.01);
  });

  it("falls back to distinct_id 'system' when no userId is given", async () => {
    const body = await captureBody({
      decisionType: "NUDGE",
      model: "gemini-2.5-flash",
      input: {},
      output: {},
      rationale: "r",
    });
    assert.equal(body.distinct_id, "system");
  });

  it("normalizes a non-serializable metadata value instead of throwing", async () => {
    // A circular metadata object would blow up a naive `JSON.stringify(body)`;
    // `toJsonSafe` must neutralize it so the capture body still serializes.
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const body = await captureBody({
      decisionType: "SCAN",
      model: "gemini-2.5-flash",
      input: {},
      output: {},
      rationale: "r",
      metadata: circular,
    });
    // We got a body back at all ⇒ no throw; the circular ref was stripped.
    assert.equal(body.event, "ai_decision");
    assert.ok(typeof body.properties === "object" && body.properties !== null);
  });

  it("spreads only serializable metadata fields (functions/BigInt dropped)", async () => {
    const body = await captureBody({
      decisionType: "REBALANCE_INSIGHT",
      model: "gemini-2.5-flash",
      input: {},
      output: {},
      rationale: "r",
      metadata: {
        safeTag: "ok",
        fn: (() => 1) as unknown as string,
      },
    });
    assert.equal(body.properties.safeTag, "ok");
    assert.ok(!("fn" in body.properties), "non-serializable fn leaked");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// toJsonSafe — the shared Prisma-Json normaliser (MONEY-807)
// ════════════════════════════════════════════════════════════════════════════
// Now EXPORTED so the per-result feedback action reuses it instead of inlining a
// copy or casting a raw `Record<string, unknown>` to `Prisma.InputJsonValue`.
// These assert the round-trip contract that makes it safe to feed a
// caller-supplied feedback `metadata` blob straight into a Prisma Json column.

describe("toJsonSafe — feedback-metadata round-trip (real export)", () => {
  it("passes a plain serializable feedback metadata blob through unchanged", () => {
    const meta = {
      variantId: "detailed",
      outcome: "UP",
      reasons: ["accurate", "clear"],
      score: 0.92,
      nested: { intent: "stock_analysis", symbols: ["TCS", "INFY"] },
    };
    assert.deepStrictEqual(toJsonSafe(meta), meta);
  });

  it("drops function / undefined fields and stringifies a Date (JSON round-trip)", () => {
    const out = toJsonSafe({
      keep: "yes",
      fn: () => 1,
      gone: undefined,
      when: new Date("2026-06-15T00:00:00.000Z"),
    }) as Record<string, unknown>;
    assert.equal(out.keep, "yes");
    assert.ok(!("fn" in out), "function field must be dropped");
    assert.ok(!("gone" in out), "undefined field must be dropped");
    assert.equal(out.when, "2026-06-15T00:00:00.000Z");
  });

  it("never throws on a circular metadata blob — falls back to a wrapper", () => {
    const circular: Record<string, unknown> = { variantId: "concise" };
    circular.self = circular;
    // JSON.stringify on a circular ref throws; toJsonSafe must catch + wrap.
    const out = toJsonSafe(circular) as Record<string, unknown>;
    assert.ok(
      "unserializable" in out,
      "circular blob should degrade to the { unserializable } wrapper",
    );
  });

  it("normalises a nullish blob to JSON null (a valid Prisma Json value)", () => {
    assert.strictEqual(toJsonSafe(undefined), null);
    assert.strictEqual(toJsonSafe(null), null);
  });

  it("the round-trip output re-serializes cleanly (safe for a Prisma Json column)", () => {
    const out = toJsonSafe({ variantId: "detailed", outcome: "DOWN", n: 3 });
    assert.doesNotThrow(() => JSON.stringify(out));
  });
});
