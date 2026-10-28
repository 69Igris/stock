/**
 * Pub/Sub Message Parser Tests (workers/src/lib/message.ts)
 *
 * Tests for parsePubSubMessage and getMessageId utilities
 * that handle both Pub/Sub push envelopes and direct JSON bodies.
 *
 * The parser supports two paths:
 *   1. Pub/Sub envelope: { message: { data: "<base64>", messageId, publishTime } }
 *   2. Direct JSON: any other object (for local dev / manual trigger)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed: import the REAL worker exports. `lib/message.ts` is pure
// (only `Buffer`/`JSON`), so importing it boots no Prisma/Redis/socket.
// `isPubSubEnvelope` is intentionally NOT exported by the source (it is an
// internal predicate); its behaviour is fully observable through the two
// public exports, so the former inline `isPubSubEnvelope` assertions are
// re-expressed below in terms of `parsePubSubMessage` / `getMessageId`.
import {
  parsePubSubMessage,
  getMessageId,
} from "../../../../workers/src/lib/message";

// ── Helper: build a valid Pub/Sub envelope ──────────────────────────

function makeEnvelope(
  payload: unknown,
  messageId = "msg-001",
  subscription = "test-sub"
) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload)).toString("base64"),
      messageId,
      publishTime: new Date().toISOString(),
    },
    subscription,
  };
}

// ── Behavioural observer for the internal `isPubSubEnvelope` predicate ──
//
// The predicate is not exported, but it is fully observable through the real
// `parsePubSubMessage`: an envelope is base64-DECODED (so the result is a NEW
// value, never the input reference), whereas a non-envelope is returned by
// identity (`return body as T`). We therefore probe the REAL export with a
// sentinel `data` and classify by whether the body was decoded or passed
// through unchanged — exercising the source's branch, not a copy of it.
const ENVELOPE_SENTINEL = { __probe__: "decoded" } as const;

function treatedAsEnvelope(body: unknown): boolean {
  // If `body` is an object with a `message.data` we control, inject the
  // sentinel so a decode yields a value distinguishable from the input.
  let probe = body;
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof (body as { message?: { data?: unknown } }).message === "object" &&
    (body as { message: Record<string, unknown> }).message !== null &&
    typeof (body as { message: { data?: unknown } }).message.data === "string"
  ) {
    probe = {
      ...(body as Record<string, unknown>),
      message: {
        ...(body as { message: Record<string, unknown> }).message,
        data: Buffer.from(JSON.stringify(ENVELOPE_SENTINEL)).toString("base64"),
      },
    };
  }
  let result: unknown;
  try {
    result = parsePubSubMessage<unknown>(probe);
  } catch {
    // A throw only happens on the decode/JSON.parse path → it WAS an envelope.
    return true;
  }
  // Decoded envelope → equals the sentinel; pass-through → identity with probe.
  if (result === probe) return false;
  return JSON.stringify(result) === JSON.stringify(ENVELOPE_SENTINEL);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Workers - Pub/Sub Message Parser", () => {
  // ── isPubSubEnvelope (observed via the real parsePubSubMessage) ─────

  describe("isPubSubEnvelope", () => {
    it("should return true for valid Pub/Sub envelope", () => {
      const envelope = makeEnvelope({ test: true });
      assert.strictEqual(treatedAsEnvelope(envelope), true);
    });

    it("should return false for null", () => {
      assert.strictEqual(treatedAsEnvelope(null), false);
    });

    it("should return false for undefined", () => {
      assert.strictEqual(treatedAsEnvelope(undefined), false);
    });

    it("should return false for a plain string", () => {
      assert.strictEqual(treatedAsEnvelope("hello"), false);
    });

    it("should return false for a number", () => {
      assert.strictEqual(treatedAsEnvelope(42), false);
    });

    it("should return false for an empty object", () => {
      assert.strictEqual(treatedAsEnvelope({}), false);
    });

    it("should return false when message is null", () => {
      assert.strictEqual(treatedAsEnvelope({ message: null }), false);
    });

    it("should return false when message.data is a number", () => {
      assert.strictEqual(
        treatedAsEnvelope({ message: { data: 12345, messageId: "x" } }),
        false
      );
    });

    it("should return false when message.data is missing", () => {
      assert.strictEqual(
        treatedAsEnvelope({ message: { messageId: "x" } }),
        false
      );
    });

    it("should return true when data is any string (even non-base64)", () => {
      // isPubSubEnvelope only checks typeof data === "string"
      const body = {
        message: { data: "not-base64-but-a-string", messageId: "m1" },
        subscription: "s",
      };
      assert.strictEqual(treatedAsEnvelope(body), true);
    });

    it("should return false for an array", () => {
      assert.strictEqual(treatedAsEnvelope([1, 2, 3]), false);
    });

    it("should return false when message is a string", () => {
      assert.strictEqual(
        treatedAsEnvelope({ message: "not-an-object" }),
        false
      );
    });
  });

  // ── parsePubSubMessage ────────────────────────────────────────────

  describe("parsePubSubMessage", () => {
    it("should parse a valid Pub/Sub envelope with base64-encoded data", () => {
      const payload = { jobId: "job-1", userId: "user-1" };
      const envelope = makeEnvelope(payload);

      const result = parsePubSubMessage<typeof payload>(envelope);

      assert.deepStrictEqual(result, payload);
    });

    it("should handle nested objects inside the encoded data", () => {
      const payload = {
        instrumentIds: ["i-1", "i-2"],
        dateRange: { start: "2025-01-01", end: "2026-01-01" },
        source: "YAHOO",
      };
      const envelope = makeEnvelope(payload);

      const result = parsePubSubMessage<typeof payload>(envelope);

      assert.deepStrictEqual(result.instrumentIds, ["i-1", "i-2"]);
      assert.strictEqual(result.dateRange.start, "2025-01-01");
      assert.strictEqual(result.source, "YAHOO");
    });

    it("should handle arrays as encoded data", () => {
      const payload = ["NSE", "BSE"];
      const envelope = makeEnvelope(payload);

      const result = parsePubSubMessage<string[]>(envelope);

      assert.deepStrictEqual(result, ["NSE", "BSE"]);
    });

    it("should handle encoded boolean values", () => {
      const payload = true;
      const envelope = makeEnvelope(payload);

      const result = parsePubSubMessage<boolean>(envelope);
      assert.strictEqual(result, true);
    });

    it("should handle encoded numeric values", () => {
      const payload = 42;
      const envelope = makeEnvelope(payload);

      const result = parsePubSubMessage<number>(envelope);
      assert.strictEqual(result, 42);
    });

    it("should handle encoded null value", () => {
      const envelope = makeEnvelope(null);

      const result = parsePubSubMessage<null>(envelope);
      assert.strictEqual(result, null);
    });

    it("should handle encoded string value", () => {
      const envelope = makeEnvelope("hello world");

      const result = parsePubSubMessage<string>(envelope);
      assert.strictEqual(result, "hello world");
    });

    it("should fall back to direct JSON body when not an envelope (object)", () => {
      const directBody = { exchanges: ["NSE"], forceFullSync: true };

      const result = parsePubSubMessage<typeof directBody>(directBody);

      assert.deepStrictEqual(result, directBody);
    });

    it("should fall back to direct JSON body for InstrumentSyncMessage", () => {
      const body = { exchanges: ["NSE", "BSE"], forceFullSync: false };
      const result = parsePubSubMessage<typeof body>(body);

      assert.deepStrictEqual(result.exchanges, ["NSE", "BSE"]);
      assert.strictEqual(result.forceFullSync, false);
    });

    it("should fall back to direct JSON body for SectorEnrichmentMessage", () => {
      const body = {
        batchSize: 50,
        exchanges: ["NSE"],
        forceReEnrich: true,
        delayMs: 3000,
      };
      const result = parsePubSubMessage<typeof body>(body);

      assert.strictEqual(result.batchSize, 50);
      assert.strictEqual(result.forceReEnrich, true);
      assert.strictEqual(result.delayMs, 3000);
    });

    it("should return empty object as-is for direct JSON path", () => {
      const result = parsePubSubMessage<Record<string, unknown>>({});
      assert.deepStrictEqual(result, {});
    });

    it("should return null as-is for direct JSON path", () => {
      const result = parsePubSubMessage<null>(null);
      assert.strictEqual(result, null);
    });

    it("should return undefined as-is for direct JSON path", () => {
      const result = parsePubSubMessage<undefined>(undefined);
      assert.strictEqual(result, undefined);
    });

    it("should throw when envelope contains invalid base64 JSON", () => {
      const envelope = {
        message: {
          data: Buffer.from("this is not valid json!!!").toString("base64"),
          messageId: "msg-bad",
          publishTime: "2026-02-01T00:00:00Z",
        },
        subscription: "test-sub",
      };

      assert.throws(() => parsePubSubMessage(envelope), SyntaxError);
    });

    it("should handle envelope where data decodes to valid but empty JSON object", () => {
      const envelope = makeEnvelope({});
      const result = parsePubSubMessage<Record<string, unknown>>(envelope);
      assert.deepStrictEqual(result, {});
    });

    it("should handle malformed envelope with message.data as a number (falls through to direct path)", () => {
      const body = { message: { data: 12345, messageId: "x" } };
      // data is not a string, so isPubSubEnvelope returns false => direct JSON path
      const result = parsePubSubMessage<typeof body>(body);
      assert.deepStrictEqual(result, body);
    });

    it("should handle malformed envelope with message = null (falls through to direct path)", () => {
      const body = { message: null };
      const result = parsePubSubMessage<typeof body>(body);
      assert.deepStrictEqual(result, body);
    });

    it("should handle envelope missing data field (falls through to direct path)", () => {
      const body = { message: { messageId: "x", publishTime: "2026-01-01" } };
      const result = parsePubSubMessage<typeof body>(body);
      assert.deepStrictEqual(result, body);
    });

    it("should correctly type-cast the generic parameter for PairingJobMessage", () => {
      interface PairingJobMessage {
        jobId: string;
        userId: string;
        batchId?: string;
      }

      const payload: PairingJobMessage = {
        jobId: "pair-001",
        userId: "u-42",
        batchId: "batch-7",
      };
      const envelope = makeEnvelope(payload);

      const result = parsePubSubMessage<PairingJobMessage>(envelope);

      assert.strictEqual(result.jobId, "pair-001");
      assert.strictEqual(result.userId, "u-42");
      assert.strictEqual(result.batchId, "batch-7");
    });

    it("should handle deeply nested JSON structures in encoded data", () => {
      const payload = {
        level1: {
          level2: {
            level3: {
              value: "deep",
              numbers: [1, 2, 3],
            },
          },
        },
      };
      const envelope = makeEnvelope(payload);
      const result = parsePubSubMessage<typeof payload>(envelope);
      assert.strictEqual(result.level1.level2.level3.value, "deep");
      assert.deepStrictEqual(result.level1.level2.level3.numbers, [1, 2, 3]);
    });

    it("should handle special characters in encoded data", () => {
      const payload = {
        name: 'Test "quoted" value',
        path: "some/path/with\\backslash",
        unicode: "\u00e9\u00e8\u00ea",
      };
      const envelope = makeEnvelope(payload);
      const result = parsePubSubMessage<typeof payload>(envelope);
      assert.strictEqual(result.name, 'Test "quoted" value');
      assert.strictEqual(result.unicode, "\u00e9\u00e8\u00ea");
    });

    it("should handle large payloads without issue", () => {
      const payload = {
        items: Array.from({ length: 1000 }, (_, i) => ({
          id: `item-${i}`,
          value: i * 100,
        })),
      };
      const envelope = makeEnvelope(payload);
      const result = parsePubSubMessage<typeof payload>(envelope);
      assert.strictEqual(result.items.length, 1000);
      assert.strictEqual(result.items[999]!.id, "item-999");
    });
  });

  // ── getMessageId ──────────────────────────────────────────────────

  describe("getMessageId", () => {
    it("should extract messageId from a valid Pub/Sub envelope", () => {
      const envelope = makeEnvelope({ foo: 1 }, "msg-99999");

      assert.strictEqual(getMessageId(envelope), "msg-99999");
    });

    it("should extract numeric-style messageId from envelope", () => {
      const envelope = makeEnvelope({ foo: 1 }, "1234567890");

      assert.strictEqual(getMessageId(envelope), "1234567890");
    });

    it("should extract long messageId from envelope", () => {
      const longId =
        "projects/myproject/subscriptions/sub1/messages/abcdef123456";
      const envelope = makeEnvelope({ foo: 1 }, longId);
      assert.strictEqual(getMessageId(envelope), longId);
    });

    it("should return local-* for direct JSON body (no envelope)", () => {
      const before = Date.now();
      const id = getMessageId({ exchanges: ["NSE"] });
      const after = Date.now();

      assert.ok(id.startsWith("local-"));
      const ts = parseInt(id.replace("local-", ""), 10);
      assert.ok(ts >= before, "timestamp should be >= before");
      assert.ok(ts <= after, "timestamp should be <= after");
    });

    it("should return local-* for null body", () => {
      const id = getMessageId(null);
      assert.ok(id.startsWith("local-"));
    });

    it("should return local-* for undefined body", () => {
      const id = getMessageId(undefined);
      assert.ok(id.startsWith("local-"));
    });

    it("should return local-* for empty object", () => {
      const id = getMessageId({});
      assert.ok(id.startsWith("local-"));
    });

    it("should return local-* when envelope has message.data but no messageId", () => {
      const body = {
        message: {
          data: "dGVzdA==", // valid base64 string => isPubSubEnvelope = true
          // messageId is missing
          publishTime: "2026-01-01T00:00:00Z",
        },
        subscription: "test-sub",
      };

      // isPubSubEnvelope passes (data is string), but messageId is falsy
      const id = getMessageId(body);
      assert.ok(id.startsWith("local-"));
    });

    it("should return local-* when envelope has empty string messageId", () => {
      const body = {
        message: {
          data: "dGVzdA==",
          messageId: "",
          publishTime: "2026-01-01T00:00:00Z",
        },
        subscription: "test-sub",
      };

      // empty string is falsy
      const id = getMessageId(body);
      assert.ok(id.startsWith("local-"));
    });

    it("should generate unique-ish IDs on successive calls", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 5; i++) {
        ids.add(getMessageId({}));
      }
      // All IDs start with local-. They may collide if called in same ms,
      // so just verify format rather than strict uniqueness.
      for (const id of Array.from(ids)) {
        assert.ok(id.startsWith("local-"));
      }
    });

    it("should return local-* for a boolean body", () => {
      const id = getMessageId(true);
      assert.ok(id.startsWith("local-"));
    });

    it("should return local-* for a number body", () => {
      const id = getMessageId(42);
      assert.ok(id.startsWith("local-"));
    });

    it("should return local-* for an array body", () => {
      const id = getMessageId([1, 2, 3]);
      assert.ok(id.startsWith("local-"));
    });
  });

  // ── Integration: parsePubSubMessage + getMessageId combined ────────

  describe("Integration: parsePubSubMessage + getMessageId combined", () => {
    it("should parse data and extract messageId from the same envelope", () => {
      const payload = { jobId: "j-1", userId: "u-1" };
      const envelope = makeEnvelope(payload, "msg-integration-1");

      const data = parsePubSubMessage<typeof payload>(envelope);
      const msgId = getMessageId(envelope);

      assert.deepStrictEqual(data, payload);
      assert.strictEqual(msgId, "msg-integration-1");
    });

    it("should handle direct JSON body consistently across both functions", () => {
      const body = { exchanges: ["NSE"] };

      const data = parsePubSubMessage<typeof body>(body);
      const msgId = getMessageId(body);

      assert.deepStrictEqual(data, body);
      assert.ok(msgId.startsWith("local-"));
    });

    it("should work with PriceSyncMessage envelope", () => {
      const payload = {
        instrumentIds: ["inst-1"],
        dateRange: { start: "2025-01-01", end: "2025-12-31" },
        source: "YAHOO" as const,
      };
      const envelope = makeEnvelope(payload, "price-sync-msg-1");

      const data = parsePubSubMessage<typeof payload>(envelope);
      const msgId = getMessageId(envelope);

      assert.strictEqual(data.source, "YAHOO");
      assert.strictEqual(data.dateRange.start, "2025-01-01");
      assert.strictEqual(msgId, "price-sync-msg-1");
    });

    it("should work with SyncJobMessage envelope", () => {
      const payload = {
        jobId: "sync-1",
        userId: "u-1",
        broker: "ZERODHA",
        dataTypes: ["holdings", "trades"],
      };
      const envelope = makeEnvelope(payload, "sync-msg-1");

      const data = parsePubSubMessage<typeof payload>(envelope);
      assert.strictEqual(data.broker, "ZERODHA");
      assert.deepStrictEqual(data.dataTypes, ["holdings", "trades"]);
    });
  });
});
