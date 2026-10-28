/**
 * Roast Route Tests (workers/src/routes/roast.ts) — DE-SHADOWED.
 *
 * Previously this file re-declared inline copies of `parsePubSubMessage` and
 * `getMessageId` "(mirrors workers/src/lib/message.ts)" and asserted the copies —
 * a shadow that stayed green even if the real Pub/Sub envelope parser regressed.
 *
 * `parsePubSubMessage` / `getMessageId` are REAL exports in
 * `workers/src/lib/message.ts` (the route imports them). This test asserts those
 * real exports and exercises the route's parse → process → 200/500 contract
 * through a harness wired to the SAME real parser (the real `roastRoute` boots
 * Prisma + the RoastAgent at import, so the processor is injected here).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL Pub/Sub envelope parser the route uses (no shadow).
import {
  parsePubSubMessage,
  getMessageId,
} from "../../../../workers/src/lib/message";

interface RoastJobMessage {
  jobId: string;
  userId: string;
  sessionId: string;
  mode: "overall" | "broker";
  broker?: string;
  assetType: "stocks" | "mf" | "all";
}

// ══════════════════════════════════════════════════════════════════════
// parsePubSubMessage (real export)
// ══════════════════════════════════════════════════════════════════════

function makeEnvelope(payload: unknown, messageId = "msg-001") {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload)).toString("base64"),
      messageId,
    },
  };
}

describe("parsePubSubMessage (real export)", () => {
  it("decodes a base64 Pub/Sub envelope", () => {
    const job: RoastJobMessage = {
      jobId: "j-1",
      userId: "u-1",
      sessionId: "s-1",
      mode: "overall",
      assetType: "all",
    };
    const parsed = parsePubSubMessage<RoastJobMessage>(makeEnvelope(job));
    assert.deepStrictEqual(parsed, job);
  });

  it("falls back to a direct-JSON body (local-dev path)", () => {
    const job = { jobId: "j-2", sessionId: "s-2" };
    assert.deepStrictEqual(parsePubSubMessage(job), job);
  });
});

describe("getMessageId (real export)", () => {
  it("returns the envelope messageId", () => {
    assert.strictEqual(getMessageId(makeEnvelope({}, "abc-123")), "abc-123");
  });

  it("returns a generated local-* id for a direct body", () => {
    assert.ok(getMessageId({ jobId: "x" }).startsWith("local-"));
  });
});

// ══════════════════════════════════════════════════════════════════════
// Route contract — parse(real) → process(injected) → 200/500, error sanitized.
// Mirrors routes/roast.ts (the real route imports the same parser + getMessageId).
// ══════════════════════════════════════════════════════════════════════

interface RouteResult {
  body: Record<string, unknown>;
  status: number;
}

async function handleRoastRoute(
  rawBody: unknown,
  jsonThrows: boolean,
  processor: (data: RoastJobMessage) => Promise<void>
): Promise<RouteResult> {
  try {
    // The real route does `try { body = await c.req.json() } catch { body = {} }`.
    let body: unknown;
    try {
      if (jsonThrows) throw new Error("invalid json");
      body = rawBody;
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<RoastJobMessage>(body);
    getMessageId(body);
    await processor(data);
    return { body: { success: true }, status: 200 };
  } catch {
    return { body: { error: "Processing failed" }, status: 500 };
  }
}

describe("roast route contract (real parser)", () => {
  it("returns 200 { success: true } on success", async () => {
    const result = await handleRoastRoute(
      makeEnvelope({ jobId: "j", sessionId: "s" }),
      false,
      async () => {}
    );
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body, { success: true });
  });

  it("returns 500 { error: 'Processing failed' } when the processor throws", async () => {
    const result = await handleRoastRoute(makeEnvelope({}), false, async () => {
      throw new Error("roast boom");
    });
    assert.strictEqual(result.status, 500);
    assert.deepStrictEqual(result.body, { error: "Processing failed" });
  });

  it("defaults the body to {} when JSON parsing fails, still processing", async () => {
    let receivedKeys: string[] = [];
    const result = await handleRoastRoute("not-json", true, async (d) => {
      // `Object.keys` takes any object — no cast needed (an interface has no
      // implicit index signature, so `as Record<string, unknown>` never held).
      receivedKeys = Object.keys(d);
    });
    // Body defaulted to {}, real parser returns it as-is (direct-JSON path).
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(receivedKeys, []);
  });

  it("never leaks internal error details", async () => {
    const result = await handleRoastRoute(makeEnvelope({}), false, async () => {
      throw new Error("SECRET: db creds");
    });
    assert.strictEqual(result.body.error, "Processing failed");
  });

  it("passes the decoded job to the processor", async () => {
    let captured: RoastJobMessage | null = null;
    await handleRoastRoute(
      makeEnvelope({ jobId: "j-9", sessionId: "s-9", userId: "u-9" }),
      false,
      async (d) => {
        captured = d;
      }
    );
    assert.strictEqual(captured!.jobId, "j-9");
    assert.strictEqual(captured!.sessionId, "s-9");
  });
});
