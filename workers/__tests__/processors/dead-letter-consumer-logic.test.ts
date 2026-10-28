/**
 * UNIT TEST — dead-letter consumer payload shaping (MONEY-1204, 14a.5a).
 *
 * Exercises the REAL exports from
 * `workers/src/processors/dead-letter-consumer-logic.ts`.
 *
 * The central property under test is TOTALITY. The consumer acks on the
 * strength of this module returning: a throw anywhere here becomes a 5xx, which
 * nacks, which puts the message back on the dead-letter queue — the one queue
 * with no further backstop. So every malformed, empty, huge, cyclic and
 * non-JSON input below must produce a record rather than an exception, and the
 * assertions say so explicitly rather than relying on the test merely not
 * crashing.
 *
 * ## The fixtures are SYNTHETIC
 *
 * No dead letter was captured from a live subscription. The
 * `CloudPubSubDeadLetterSource*` attribute names are Google's documented ones
 * and are pinned as constants precisely so a typo shows up here; the payloads
 * are hand-written to pin the SHAPER's tolerance, not Pub/Sub's exact contract.
 * Treat a real capture as an ADDITION to these, never a replacement.
 *
 * Pure functions only: no Prisma, no Pub/Sub, no timers — nothing here can
 * orphan the runner.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DLQ_ALERT_EMAILS,
  DLQ_ATTR_DELIVERY_COUNT,
  DLQ_ATTR_SOURCE_PROJECT,
  DLQ_ATTR_SOURCE_PUBLISH_TIME,
  DLQ_ATTR_SOURCE_SUBSCRIPTION,
  MAX_NOTIFICATION_PAYLOAD_CHARS,
  MAX_PAYLOAD_CHARS,
  MAX_REDACT_ARRAY_ITEMS,
  MAX_REDACT_DEPTH,
  REDACTED,
  buildDeadLetterNotification,
  buildDeadLetterRecord,
  decodePayload,
  isSensitiveKey,
  jobNameFromSubscription,
  looksSensitive,
  parseDeliveryCount,
  redactAttributes,
  redactString,
  redactValue,
  resolveDlqAlertEmails,
  safeStringify,
  truncate,
} from "../../src/processors/dead-letter-consumer-logic";

const b64 = (v: unknown): string =>
  Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf-8").toString(
    "base64",
  );

function envelope(
  payload: unknown,
  attrs: Record<string, string> = {},
  over: Record<string, unknown> = {},
): unknown {
  return {
    message: {
      data: b64(payload),
      messageId: "dlq-1",
      publishTime: "2026-08-16T09:00:00Z",
      attributes: {
        [DLQ_ATTR_SOURCE_SUBSCRIPTION]:
          "projects/stock-book-483718/subscriptions/price-sync-prod-push",
        [DLQ_ATTR_SOURCE_PROJECT]: "stock-book-483718",
        [DLQ_ATTR_SOURCE_PUBLISH_TIME]: "2026-08-16T08:00:00Z",
        [DLQ_ATTR_DELIVERY_COUNT]: "5",
        ...attrs,
      },
      ...over,
    },
    subscription:
      "projects/stock-book-483718/subscriptions/dead-letter-prod-push",
  };
}

// ── Attribute names ──────────────────────────────────────────────────────

describe("Pub/Sub dead-letter attribute names", () => {
  it("pins Google's exact spellings", () => {
    // These are not ours. A typo would silently yield "unknown" for every
    // field, which reads identically to "Pub/Sub did not report it".
    assert.equal(
      DLQ_ATTR_SOURCE_SUBSCRIPTION,
      "CloudPubSubDeadLetterSourceSubscription",
    );
    assert.equal(
      DLQ_ATTR_SOURCE_PROJECT,
      "CloudPubSubDeadLetterSourceSubscriptionProject",
    );
    assert.equal(
      DLQ_ATTR_SOURCE_PUBLISH_TIME,
      "CloudPubSubDeadLetterSourceTopicPublishTime",
    );
    assert.equal(
      DLQ_ATTR_DELIVERY_COUNT,
      "CloudPubSubDeadLetterSourceDeliveryCount",
    );
  });
});

// ── Redaction ────────────────────────────────────────────────────────────

describe("redaction", () => {
  it("flags secret-bearing key names", () => {
    for (const k of [
      "accessToken",
      "refreshToken",
      "apiKey",
      "api_key",
      "clientSecret",
      "password",
      "passwd",
      "Authorization",
      "sessionId",
      "cookie",
      "privateKey",
      "encryptedPayload",
      "signature",
      "otp",
      "pin",
      "checksum",
      "credentials",
    ]) {
      assert.equal(isSensitiveKey(k), true, `${k} must be treated as secret`);
    }
  });

  it("does not flag ordinary job-payload keys", () => {
    for (const k of [
      "symbol",
      "exchange",
      "userId",
      "jobId",
      "windows",
      "date",
    ]) {
      assert.equal(isSensitiveKey(k), false, `${k} must stay readable`);
    }
  });

  it("redacts a value by its SHAPE even under an innocent key", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert.equal(looksSensitive(jwt), true);
    assert.equal(
      looksSensitive("mongodb+srv://user:pw@cluster0.mongodb.net/db"),
      true,
    );
    assert.equal(looksSensitive("Bearer abcdef1234567890"), true);
    assert.equal(looksSensitive("sk_live_abcdef1234567890"), true);
    assert.equal(looksSensitive("AIzaSyA1234567890abcdef"), true);
    assert.equal(looksSensitive("RELIANCE"), false);

    const out = redactValue({ note: `connect via ${jwt} please` }) as {
      note: string;
    };
    assert.ok(out.note.includes(REDACTED));
    assert.ok(!out.note.includes("dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
  });

  it("redacts every occurrence, not just the first", () => {
    const s = redactString(
      "a mongodb://x:y@h/d and another postgres://p:q@h/d here",
    );
    assert.equal(s.includes("x:y@h"), false);
    assert.equal(s.includes("p:q@h"), false);
  });

  it("replaces the VALUE under a sensitive key without walking into it", () => {
    const out = redactValue({
      symbol: "TCS",
      accessToken: { nested: "still-secret", deeper: { x: 1 } },
    }) as Record<string, unknown>;
    assert.equal(out.symbol, "TCS");
    assert.equal(out.accessToken, REDACTED);
    assert.equal(JSON.stringify(out).includes("still-secret"), false);
  });

  it("bounds depth, array width and key count", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < MAX_REDACT_DEPTH + 4; i++) deep = { d: deep };
    const rendered = JSON.stringify(redactValue(deep));
    assert.ok(rendered.includes("[depth-limit]"));
    assert.equal(rendered.includes("leaf"), false);

    const wide = redactValue(
      Array.from({ length: MAX_REDACT_ARRAY_ITEMS + 7 }, (_, i) => i),
    ) as unknown[];
    assert.equal(wide.length, MAX_REDACT_ARRAY_ITEMS + 1);
    assert.equal(wide[MAX_REDACT_ARRAY_ITEMS], "…+7 more");
  });

  it("survives a cyclic payload without hanging or throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = JSON.stringify(redactValue(a));
    assert.ok(out.includes("[circular]"));
  });

  it("does not mislabel a DAG (same object on two branches) as circular", () => {
    const shared = { symbol: "INFY" };
    const out = redactValue({ left: shared, right: shared }) as {
      left: unknown;
      right: unknown;
    };
    assert.deepEqual(out.left, { symbol: "INFY" });
    assert.deepEqual(out.right, { symbol: "INFY" });
  });

  it("handles BigInt, functions and symbols instead of throwing", () => {
    const out = redactValue({
      big: BigInt(9007199254740993n),
      fn: () => 1,
      sym: Symbol("x"),
    }) as Record<string, unknown>;
    assert.equal(out.big, "9007199254740993n");
    assert.equal(out.fn, "[function]");
    assert.equal(out.sym, "[symbol]");
  });
});

describe("truncate / safeStringify", () => {
  it("marks truncation with a countable suffix, never a bare ellipsis", () => {
    const out = truncate("x".repeat(50), 10);
    assert.ok(out.startsWith("x".repeat(10)));
    assert.ok(out.includes("truncated 40 of 50 chars"));
    assert.equal(truncate("short", 10), "short");
  });

  it("never throws on a value JSON.stringify rejects", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    assert.equal(typeof safeStringify(cyc, 100), "string");
    assert.equal(typeof safeStringify(BigInt(1n), 100), "string");
  });
});

// ── Payload decoding ─────────────────────────────────────────────────────

describe("decodePayload", () => {
  it("decodes and redacts base64 JSON", () => {
    const r = decodePayload(b64({ symbol: "TCS", accessToken: "kite-abc" }));
    assert.equal(r.decodable, true);
    assert.ok(r.excerpt.includes("TCS"));
    assert.equal(r.excerpt.includes("kite-abc"), false);
    assert.ok(r.excerpt.includes(REDACTED));
  });

  it("keeps non-JSON payloads (that is often WHY the job died)", () => {
    const r = decodePayload(b64("<!DOCTYPE html><html>NSE error page"));
    assert.equal(r.decodable, false);
    assert.ok(r.excerpt.includes("NSE error page"));
  });

  it("redacts secrets in a non-JSON payload too", () => {
    const r = decodePayload(b64("DATABASE_URL=mongodb+srv://u:p@h/db failed"));
    assert.equal(r.excerpt.includes("u:p@h"), false);
    assert.ok(r.excerpt.includes(REDACTED));
  });

  it("caps a HUGE payload — a 10MB message must not become a logging incident", () => {
    const huge = {
      rows: Array.from({ length: 200_000 }, (_, i) => `row-${i}`),
    };
    const r = decodePayload(b64(huge));
    assert.ok(
      r.excerpt.length <= MAX_PAYLOAD_CHARS + 80,
      `excerpt was ${r.excerpt.length} chars`,
    );
    assert.ok(
      r.bytes > MAX_PAYLOAD_CHARS,
      "the ORIGINAL size is still reported",
    );
  });

  it("handles absent, empty and non-string data", () => {
    for (const bad of [undefined, null, "", 42, {}]) {
      const r = decodePayload(bad);
      assert.equal(r.decodable, false);
      assert.equal(typeof r.excerpt, "string");
    }
  });
});

// ── Subscription / attribute parsing ─────────────────────────────────────

describe("jobNameFromSubscription", () => {
  it("recovers the job name from each env's naming convention", () => {
    assert.equal(
      jobNameFromSubscription(
        "projects/p/subscriptions/market-movers-sync-prod-push",
      ),
      "market-movers-sync",
    );
    assert.equal(
      jobNameFromSubscription("projects/p/subscriptions/price-sync-qa-push"),
      "price-sync",
    );
  });

  it("returns an unrecognised name unmangled rather than guessing", () => {
    // A wrong-but-confident job name sends a responder to the wrong processor.
    assert.equal(jobNameFromSubscription("weird-name"), "weird-name");
    assert.equal(jobNameFromSubscription(""), "unknown");
  });
});

describe("parseDeliveryCount", () => {
  it("distinguishes 'not reported' (null) from zero", () => {
    assert.equal(parseDeliveryCount(undefined), null);
    assert.equal(parseDeliveryCount("not-a-number"), null);
    assert.equal(parseDeliveryCount("5"), 5);
    assert.equal(parseDeliveryCount("0"), 0);
  });
});

describe("redactAttributes", () => {
  it("drops the system DLQ attrs (hoisted to named fields) and redacts the rest", () => {
    const out = redactAttributes({
      [DLQ_ATTR_SOURCE_SUBSCRIPTION]: "projects/p/subscriptions/x-prod-push",
      [DLQ_ATTR_DELIVERY_COUNT]: "5",
      traceId: "abc-123",
      authToken: "super-secret",
      note: "Bearer aaaaaaaaaaaaaaaa",
    });
    assert.equal(out[DLQ_ATTR_SOURCE_SUBSCRIPTION], undefined);
    assert.equal(out[DLQ_ATTR_DELIVERY_COUNT], undefined);
    assert.equal(out.traceId, "abc-123");
    assert.equal(out.authToken, REDACTED);
    assert.ok(out.note?.includes(REDACTED));
  });

  it("returns {} for non-object input instead of throwing", () => {
    assert.deepEqual(redactAttributes(null), {});
    assert.deepEqual(redactAttributes("nope"), {});
    assert.deepEqual(redactAttributes([1, 2]), {});
  });
});

// ── buildDeadLetterRecord: the totality property ─────────────────────────

describe("buildDeadLetterRecord", () => {
  it("shapes a well-formed dead letter", () => {
    const r = buildDeadLetterRecord(envelope({ symbols: ["TCS"] }));
    assert.equal(r.messageId, "dlq-1");
    assert.equal(r.sourceJob, "price-sync");
    assert.equal(
      r.sourceSubscription,
      "projects/stock-book-483718/subscriptions/price-sync-prod-push",
    );
    assert.equal(r.sourceProject, "stock-book-483718");
    assert.equal(r.originalPublishTime, "2026-08-16T08:00:00Z");
    assert.equal(r.deliveryCount, 5);
    assert.ok(r.payloadDecodable);
    assert.ok(r.payloadExcerpt.includes("TCS"));
  });

  it("prefers the ORIGINAL publish time over the DLQ republish time", () => {
    // `message.publishTime` on a dead letter is when Pub/Sub re-published it to
    // the DLQ, not when the job was queued — reporting it would misdate the
    // incident by however long the retries took.
    const r = buildDeadLetterRecord(envelope({}));
    assert.equal(r.originalPublishTime, "2026-08-16T08:00:00Z");
    assert.notEqual(r.originalPublishTime, "2026-08-16T09:00:00Z");
  });

  it("falls back to message.publishTime when the attribute is absent", () => {
    const body = envelope({}) as {
      message: { attributes: Record<string, string> };
    };
    delete body.message.attributes[DLQ_ATTR_SOURCE_PUBLISH_TIME];
    assert.equal(
      buildDeadLetterRecord(body).originalPublishTime,
      "2026-08-16T09:00:00Z",
    );
  });

  it("NEVER throws on a malformed, empty or hostile body", () => {
    const inputs: unknown[] = [
      undefined,
      null,
      {},
      "",
      "a string",
      42,
      [],
      [1, 2, 3],
      { message: null },
      { message: "not-an-object" },
      { message: [] },
      { message: { data: 42 } },
      { message: { data: "!!!not-base64!!!" } },
      { message: { messageId: 99, attributes: "nope" } },
      { message: { attributes: { [DLQ_ATTR_DELIVERY_COUNT]: "abc" } } },
      { message: { data: b64("{ unclosed json") } },
      { message: { data: b64("") } },
    ];

    for (const input of inputs) {
      let record;
      try {
        record = buildDeadLetterRecord(input);
      } catch (err) {
        assert.fail(
          `threw on ${JSON.stringify(input)} — a throw here nacks the message ` +
            `straight back onto the DLQ: ${String(err)}`,
        );
      }
      assert.equal(typeof record.messageId, "string");
      assert.equal(typeof record.sourceJob, "string");
      assert.equal(typeof record.payloadExcerpt, "string");
      assert.equal(typeof record.attributes, "object");
    }
  });

  it("reports an empty messageId (rather than inventing one) when absent", () => {
    // The consumer uses this to decide it cannot dedupe. A synthesised id
    // would make every malformed delivery look like a distinct message.
    assert.equal(buildDeadLetterRecord({ message: {} }).messageId, "");
    assert.equal(buildDeadLetterRecord({}).messageId, "");
  });

  it("does not leak a token from a huge, deeply nested, secret-bearing payload", () => {
    const payload = {
      user: { id: "u1", broker: { accessToken: "kite-SECRET-TOKEN" } },
      rows: Array.from({ length: 5_000 }, (_, i) => ({
        symbol: `SYM${i}`,
        refreshToken: "refresh-SECRET",
      })),
    };
    const r = buildDeadLetterRecord(envelope(payload));
    assert.equal(r.payloadExcerpt.includes("kite-SECRET-TOKEN"), false);
    assert.equal(r.payloadExcerpt.includes("refresh-SECRET"), false);
    assert.ok(r.payloadExcerpt.length <= MAX_PAYLOAD_CHARS + 80);
  });
});

// ── Notification ─────────────────────────────────────────────────────────

describe("buildDeadLetterNotification", () => {
  it("names the job, the attempt count, and that nothing will retry it", () => {
    const n = buildDeadLetterNotification(
      buildDeadLetterRecord(envelope({ symbols: ["TCS"] })),
    );
    assert.equal(n.title, "Job dead-lettered: price-sync");
    assert.ok(n.message.includes("5 delivery attempts"));
    assert.ok(
      /will NOT be retried automatically/i.test(n.message),
      "a reader who assumes the queue will get to it takes no action",
    );
    assert.equal(n.metadata.sourceJob, "price-sync");
    assert.equal(n.metadata.deliveryCount, 5);
  });

  it("degrades to prose when the delivery count is unreported", () => {
    const body = envelope({}) as {
      message: { attributes: Record<string, string> };
    };
    delete body.message.attributes[DLQ_ATTR_DELIVERY_COUNT];
    const n = buildDeadLetterNotification(buildDeadLetterRecord(body));
    assert.ok(n.message.includes("the configured maximum number of"));
    assert.equal(n.metadata.deliveryCount, null);
  });

  it("caps the persisted excerpt tighter than the log excerpt", () => {
    // This one lands on a DB row and renders in the notification UI.
    const r = buildDeadLetterRecord(
      envelope({ rows: Array.from({ length: 50_000 }, (_, i) => `r${i}`) }),
    );
    const n = buildDeadLetterNotification(r);
    const excerpt = n.metadata.payloadExcerpt as string;
    assert.ok(excerpt.length <= MAX_NOTIFICATION_PAYLOAD_CHARS + 80);
    assert.ok(MAX_NOTIFICATION_PAYLOAD_CHARS < MAX_PAYLOAD_CHARS);
  });

  it("builds a notification from a totally malformed record without throwing", () => {
    const n = buildDeadLetterNotification(buildDeadLetterRecord({}));
    assert.equal(typeof n.title, "string");
    assert.equal(typeof n.message, "string");
  });
});

describe("resolveDlqAlertEmails", () => {
  it("prefers DLQ_ALERT_EMAILS, then ADMIN_EMAILS, then the founder", () => {
    assert.deepEqual(
      resolveDlqAlertEmails({
        DLQ_ALERT_EMAILS: "a@x.com, B@X.com ",
        ADMIN_EMAILS: "ignored@x.com",
      }),
      ["a@x.com", "b@x.com"],
    );
    assert.deepEqual(resolveDlqAlertEmails({ ADMIN_EMAILS: "c@x.com" }), [
      "c@x.com",
    ]);
    assert.deepEqual(resolveDlqAlertEmails({}), DEFAULT_DLQ_ALERT_EMAILS);
  });

  it("never returns an empty list from a blank or comma-only value", () => {
    // An empty recipient list would silently disable the alert.
    assert.deepEqual(
      resolveDlqAlertEmails({ DLQ_ALERT_EMAILS: "" }),
      DEFAULT_DLQ_ALERT_EMAILS,
    );
    assert.deepEqual(
      resolveDlqAlertEmails({ DLQ_ALERT_EMAILS: " , , " }),
      DEFAULT_DLQ_ALERT_EMAILS,
    );
  });
});
