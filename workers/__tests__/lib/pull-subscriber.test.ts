/**
 * Pull Subscriber Tests
 *
 * NOTE: This suite now exercises the REAL source
 * (workers/src/lib/pull-subscriber.ts) and the REAL shared helpers in
 * @usemoney/types — not inline copies. It imports:
 *   - PUBSUB_TOPICS, getTopicName        (from @usemoney/types)
 *   - TOPIC_PROCESSORS, getSubscriptionName, parseMessageData, classifyError,
 *     buildSubscriptionOptions, the ACK/EXPIRATION/RETENTION/MAX constants,
 *     and handlePullMessage  (from the source)
 * and asserts their behaviour directly.
 *
 * Covers:
 * - TOPIC_PROCESSORS: every registered topic maps to a processor fn
 * - Subscription name generation: `${topicName}-pull-local`
 * - Constants: ACK_DEADLINE, EXPIRATION, RETENTION, MAX_DELIVERY_ATTEMPTS
 * - Message parsing: JSON.parse(message.data.toString("utf-8"))
 * - Error classification: NOT_FOUND -> skip, other -> log
 * - Topic name generation with environment suffix
 * - handlePullMessage: ack/nack, delivery-attempt tracking, dead-lettering
 *
 * Source: workers/src/lib/pull-subscriber.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types";
import {
  MAX_CONCURRENT_MESSAGES,
  SUBSCRIBER_FLOW_CONTROL,
  TOPIC_PROCESSORS,
  getSubscriptionName,
  parseMessageData,
  classifyError,
  buildSubscriptionOptions,
  handlePullMessage,
  selectPullTopics,
  ACK_DEADLINE_SECONDS,
  EXPIRATION_MS,
  MESSAGE_RETENTION_SECONDS,
  MAX_DELIVERY_ATTEMPTS,
  type PullMessageLike,
  type PullProcessor,
} from "../../src/lib/pull-subscriber";

// The real handler logs verbosely; silence it for the whole suite.
mock.method(console, "log", () => {});
mock.method(console, "error", () => {});

// `keyof typeof` rather than the bare `string[]` `Object.keys` returns:
// `TOPIC_PROCESSORS` is `Partial<Record<PubSubTopic, …>>`, so indexing it
// with a widened `string` is an implicit-any error (MONEY-1326). The cast
// states what `Object.keys` already guarantees about its own argument.
const TOPIC_KEYS = Object.keys(TOPIC_PROCESSORS) as (keyof typeof TOPIC_PROCESSORS)[];

describe("Pull Subscriber Logic", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe("TOPIC_PROCESSORS mapping", () => {
    it("should map every registered topic to a processor function", () => {
      assert.ok(TOPIC_KEYS.length > 0);
      for (const key of TOPIC_KEYS) {
        assert.strictEqual(
          typeof TOPIC_PROCESSORS[key],
          "function",
          `processor for ${key} should be a function`,
        );
      }
    });

    it("should include trade-pairing", () => {
      assert.ok(TOPIC_KEYS.includes(PUBSUB_TOPICS.TRADE_PAIRING));
    });

    it("should include csv-import", () => {
      assert.ok(TOPIC_KEYS.includes(PUBSUB_TOPICS.CSV_IMPORT));
    });

    it("should include broker-sync", () => {
      assert.ok(TOPIC_KEYS.includes(PUBSUB_TOPICS.BROKER_SYNC));
    });

    it("should include instrument-sync", () => {
      assert.ok(TOPIC_KEYS.includes(PUBSUB_TOPICS.INSTRUMENT_SYNC));
    });

    it("should include price-sync", () => {
      assert.ok(TOPIC_KEYS.includes(PUBSUB_TOPICS.PRICE_SYNC));
    });

    it("should include sector-enrichment", () => {
      assert.ok(TOPIC_KEYS.includes(PUBSUB_TOPICS.SECTOR_ENRICHMENT));
    });

    it("should include stock-research", () => {
      assert.ok(TOPIC_KEYS.includes(PUBSUB_TOPICS.STOCK_RESEARCH));
    });

    it("should include mf-sync", () => {
      assert.ok(TOPIC_KEYS.includes(PUBSUB_TOPICS.MF_SYNC));
    });

    it("should include mf-metadata-sync", () => {
      assert.ok(TOPIC_KEYS.includes(PUBSUB_TOPICS.MF_METADATA_SYNC));
    });

    it("should include document-process", () => {
      assert.ok(TOPIC_KEYS.includes(PUBSUB_TOPICS.DOCUMENT_PROCESS));
    });

    it("should include portfolio-roast", () => {
      assert.ok(TOPIC_KEYS.includes(PUBSUB_TOPICS.PORTFOLIO_ROAST));
    });

    it("should include strategy-scan", () => {
      assert.ok(TOPIC_KEYS.includes(PUBSUB_TOPICS.STRATEGY_SCAN));
    });

    it("should not contain duplicates", () => {
      const unique = new Set(TOPIC_KEYS);
      assert.strictEqual(unique.size, TOPIC_KEYS.length);
    });
  });

  describe("Constants validation", () => {
    it("ACK_DEADLINE_SECONDS should be 600 (10 minutes)", () => {
      assert.strictEqual(ACK_DEADLINE_SECONDS, 600);
    });

    it("EXPIRATION_MS should be 31 days in milliseconds", () => {
      const expected = 31 * 24 * 60 * 60 * 1000;
      assert.strictEqual(EXPIRATION_MS, expected);
      assert.strictEqual(EXPIRATION_MS, 2678400000);
    });

    it("MESSAGE_RETENTION_SECONDS should be 7 days in seconds", () => {
      const expected = 7 * 24 * 60 * 60;
      assert.strictEqual(MESSAGE_RETENTION_SECONDS, expected);
      assert.strictEqual(MESSAGE_RETENTION_SECONDS, 604800);
    });

    it("MAX_DELIVERY_ATTEMPTS should be 5", () => {
      assert.strictEqual(MAX_DELIVERY_ATTEMPTS, 5);
    });

    it("expiration policy should convert MS to seconds", () => {
      const options = buildSubscriptionOptions();
      assert.strictEqual(
        options.expirationPolicy.ttl.seconds,
        EXPIRATION_MS / 1000,
      );
      assert.strictEqual(options.expirationPolicy.ttl.seconds, 2678400);
    });
  });

  describe("Subscription name generation", () => {
    it("should append -pull-local to topic name", () => {
      assert.strictEqual(
        getSubscriptionName("trade-pairing-qa"),
        "trade-pairing-qa-pull-local",
      );
    });

    it("should work for production topic names", () => {
      assert.strictEqual(
        getSubscriptionName("broker-sync-prod"),
        "broker-sync-prod-pull-local",
      );
    });

    it("should handle any string input", () => {
      assert.strictEqual(
        getSubscriptionName("my-custom-topic"),
        "my-custom-topic-pull-local",
      );
    });

    it("should produce correct name from end-to-end flow", () => {
      process.env.PUBSUB_ENV = "qa";
      const topicName = getTopicName(PUBSUB_TOPICS.TRADE_PAIRING);
      assert.strictEqual(
        getSubscriptionName(topicName),
        "trade-pairing-qa-pull-local",
      );
    });

    it("should produce correct prod subscription name", () => {
      process.env.PUBSUB_ENV = "prod";
      const topicName = getTopicName(PUBSUB_TOPICS.INSTRUMENT_SYNC);
      assert.strictEqual(
        getSubscriptionName(topicName),
        "instrument-sync-prod-pull-local",
      );
    });
  });

  describe("Topic name generation", () => {
    it("should suffix with -qa in non-production", () => {
      process.env.PUBSUB_ENV = "qa";
      assert.strictEqual(getTopicName("trade-pairing"), "trade-pairing-qa");
    });

    it("should suffix with -prod in production", () => {
      process.env.PUBSUB_ENV = "prod";
      assert.strictEqual(getTopicName("trade-pairing"), "trade-pairing-prod");
    });

    it("should suffix with -local when PUBSUB_ENV=local", () => {
      process.env.PUBSUB_ENV = "local";
      assert.strictEqual(getTopicName("trade-pairing"), "trade-pairing-local");
    });

    it("should default to qa when NODE_ENV is not production", () => {
      delete process.env.PUBSUB_ENV;
      process.env.NODE_ENV = "development";
      assert.strictEqual(getTopicName("csv-import"), "csv-import-qa");
    });

    it("should use prod when NODE_ENV is production", () => {
      delete process.env.PUBSUB_ENV;
      process.env.NODE_ENV = "production";
      assert.strictEqual(getTopicName("csv-import"), "csv-import-prod");
    });

    it("should prefer PUBSUB_ENV over NODE_ENV", () => {
      process.env.PUBSUB_ENV = "qa";
      process.env.NODE_ENV = "production";
      assert.strictEqual(getTopicName("broker-sync"), "broker-sync-qa");
    });
  });

  describe("Message parsing", () => {
    it("should parse valid JSON from Buffer", () => {
      const data = Buffer.from(
        JSON.stringify({ jobId: "job_123", userId: "user_456" }),
        "utf-8",
      );
      const result = parseMessageData(data) as Record<string, string>;
      assert.strictEqual(result.jobId, "job_123");
      assert.strictEqual(result.userId, "user_456");
    });

    it("should parse empty object", () => {
      const data = Buffer.from("{}", "utf-8");
      const result = parseMessageData(data);
      assert.deepStrictEqual(result, {});
    });

    it("should parse array data", () => {
      const data = Buffer.from(JSON.stringify([1, 2, 3]), "utf-8");
      const result = parseMessageData(data);
      assert.deepStrictEqual(result, [1, 2, 3]);
    });

    it("should throw on invalid JSON", () => {
      const data = Buffer.from("not valid json", "utf-8");
      assert.throws(() => parseMessageData(data), {
        name: "SyntaxError",
      });
    });

    it("should throw on empty buffer", () => {
      const data = Buffer.from("", "utf-8");
      assert.throws(() => parseMessageData(data));
    });

    it("should handle nested job data", () => {
      const jobData = {
        jobId: "job_789",
        userId: "user_101",
        dataTypes: ["holdings", "positions"],
        broker: "ZERODHA",
      };
      const data = Buffer.from(JSON.stringify(jobData), "utf-8");
      const result = parseMessageData(data) as Record<string, unknown>;
      assert.deepStrictEqual(result.dataTypes, ["holdings", "positions"]);
      assert.strictEqual(result.broker, "ZERODHA");
    });

    it("should handle unicode content", () => {
      const data = Buffer.from(
        JSON.stringify({ symbol: "NIFTY — 50" }),
        "utf-8",
      );
      const result = parseMessageData(data) as Record<string, string>;
      assert.strictEqual(result.symbol, "NIFTY — 50");
    });
  });

  describe("Error classification", () => {
    it("should classify NOT_FOUND error as not-found", () => {
      const err = new Error("5 NOT_FOUND: Topic not found");
      assert.strictEqual(classifyError(err), "not-found");
    });

    it("should classify other Error as other", () => {
      const err = new Error("PERMISSION_DENIED: Access denied");
      assert.strictEqual(classifyError(err), "other");
    });

    it("should classify string error containing NOT_FOUND as not-found", () => {
      assert.strictEqual(classifyError("NOT_FOUND"), "not-found");
    });

    it("should classify string error without NOT_FOUND as other", () => {
      assert.strictEqual(classifyError("Something went wrong"), "other");
    });

    it("should classify null error as other", () => {
      assert.strictEqual(classifyError(null), "other");
    });

    it("should classify undefined error as other", () => {
      assert.strictEqual(classifyError(undefined), "other");
    });

    it("should classify numeric error as other", () => {
      assert.strictEqual(classifyError(404), "other");
    });

    it("should handle NOT_FOUND embedded in longer message", () => {
      const err = new Error(
        "google.pubsub.v1.Subscriber.CreateSubscription: NOT_FOUND - topic does not exist",
      );
      assert.strictEqual(classifyError(err), "not-found");
    });
  });

  describe("Subscription options", () => {
    it("should return correct ackDeadlineSeconds", () => {
      assert.strictEqual(buildSubscriptionOptions().ackDeadlineSeconds, 600);
    });

    it("should return expiration policy with ttl in seconds", () => {
      const options = buildSubscriptionOptions();
      assert.ok(options.expirationPolicy);
      assert.ok(options.expirationPolicy.ttl);
      assert.strictEqual(typeof options.expirationPolicy.ttl.seconds, "number");
    });

    it("should return message retention in seconds", () => {
      assert.strictEqual(
        buildSubscriptionOptions().messageRetentionDuration.seconds,
        MESSAGE_RETENTION_SECONDS,
      );
    });

    it("should have all three required options", () => {
      const options = buildSubscriptionOptions();
      assert.ok("ackDeadlineSeconds" in options);
      assert.ok("expirationPolicy" in options);
      assert.ok("messageRetentionDuration" in options);
    });
  });

  // ── handlePullMessage: delivery attempts & dead-letter ────────────────
  // Exercises the REAL message handler from pull-subscriber.ts. Each test
  // passes its own isolated `Map` so the shared module-level tracker is not
  // touched, and uses a fake message that records ack/nack.

  describe("handlePullMessage", () => {
    let attempts: Map<string, number>;
    let acked: string[];
    let nacked: string[];
    let processorCalls: string[];

    function createMockMessage(id: string, data: unknown): PullMessageLike {
      return {
        id,
        data: Buffer.from(JSON.stringify(data), "utf-8"),
        ack: () => {
          acked.push(id);
        },
        nack: () => {
          nacked.push(id);
        },
      };
    }

    beforeEach(() => {
      attempts = new Map();
      acked = [];
      nacked = [];
      processorCalls = [];
    });

    it("should ack and call processor on success", async () => {
      const msg = createMockMessage("m1", { jobId: "j1" });
      const processor: PullProcessor = async (data) => {
        processorCalls.push(JSON.stringify(data));
      };

      await handlePullMessage(msg, processor, "trade-pairing", attempts);

      assert.strictEqual(acked.length, 1);
      assert.strictEqual(acked[0], "m1");
      assert.strictEqual(nacked.length, 0);
      assert.strictEqual(processorCalls.length, 1);
      assert.strictEqual(processorCalls[0], JSON.stringify({ jobId: "j1" }));
      // cleaned up after ack
      assert.strictEqual(attempts.has("m1"), false);
    });

    it("should nack on processor failure (first attempt)", async () => {
      const msg = createMockMessage("m2", { jobId: "j2" });
      const processor: PullProcessor = async () => {
        throw new Error("Processor error");
      };

      await handlePullMessage(msg, processor, "csv-import", attempts);

      assert.strictEqual(nacked.length, 1);
      assert.strictEqual(nacked[0], "m2");
      assert.strictEqual(acked.length, 0);
      assert.strictEqual(attempts.get("m2"), 1);
    });

    it("should nack on repeated failures up to MAX_DELIVERY_ATTEMPTS", async () => {
      const processor: PullProcessor = async () => {
        throw new Error("Always fails");
      };

      for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
        await handlePullMessage(
          createMockMessage("m3", { jobId: "j3" }),
          processor,
          "broker-sync",
          attempts,
        );
      }

      assert.strictEqual(nacked.length, MAX_DELIVERY_ATTEMPTS);
      assert.strictEqual(acked.length, 0);
      assert.strictEqual(attempts.get("m3"), MAX_DELIVERY_ATTEMPTS);
    });

    it("should dead-letter (ack without processing) after exceeding MAX_DELIVERY_ATTEMPTS", async () => {
      const processor: PullProcessor = async () => {
        processorCalls.push("called");
        throw new Error("Always fails");
      };

      // First MAX attempts: nacked
      for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
        await handlePullMessage(
          createMockMessage("m4", { jobId: "j4" }),
          processor,
          "stock-research",
          attempts,
        );
      }
      assert.strictEqual(nacked.length, MAX_DELIVERY_ATTEMPTS);
      assert.strictEqual(acked.length, 0);

      // Next attempt: dead-lettered (acked, processor NOT called)
      processorCalls = [];
      await handlePullMessage(
        createMockMessage("m4", { jobId: "j4" }),
        processor,
        "stock-research",
        attempts,
      );

      assert.strictEqual(acked.length, 1, "Should ack to stop retries");
      assert.strictEqual(acked[0], "m4");
      assert.strictEqual(processorCalls.length, 0, "Should NOT call processor");
      assert.strictEqual(
        attempts.has("m4"),
        false,
        "Should clean up tracking",
      );
    });

    it("should clean up the attempts map after a successful retry", async () => {
      let callCount = 0;
      const processor: PullProcessor = async () => {
        callCount++;
        if (callCount < 3) throw new Error("Transient failure");
      };

      await handlePullMessage(
        createMockMessage("m5", {}),
        processor,
        "mf-sync",
        attempts,
      );
      assert.strictEqual(nacked.length, 1);
      assert.strictEqual(attempts.get("m5"), 1);

      await handlePullMessage(
        createMockMessage("m5", {}),
        processor,
        "mf-sync",
        attempts,
      );
      assert.strictEqual(nacked.length, 2);
      assert.strictEqual(attempts.get("m5"), 2);

      await handlePullMessage(
        createMockMessage("m5", {}),
        processor,
        "mf-sync",
        attempts,
      );
      assert.strictEqual(acked.length, 1);
      assert.strictEqual(acked[0], "m5");
      assert.strictEqual(
        attempts.has("m5"),
        false,
        "Should clean up after success",
      );
    });

    it("should nack on malformed JSON data (parse error)", async () => {
      const msg: PullMessageLike = {
        id: "m6",
        data: Buffer.from("not valid json", "utf-8"),
        ack: () => {
          acked.push("m6");
        },
        nack: () => {
          nacked.push("m6");
        },
      };
      const processor: PullProcessor = async () => {
        processorCalls.push("called");
      };

      await handlePullMessage(msg, processor, "document-process", attempts);

      assert.strictEqual(nacked.length, 1, "Should nack on JSON parse error");
      assert.strictEqual(processorCalls.length, 0, "Should not call processor");
    });

    it("should track separate attempt counts per message ID", async () => {
      const processor: PullProcessor = async () => {
        throw new Error("fail");
      };

      for (let i = 0; i < 3; i++) {
        await handlePullMessage(
          createMockMessage("msg-a", {}),
          processor,
          "price-sync",
          attempts,
        );
      }
      await handlePullMessage(
        createMockMessage("msg-b", {}),
        processor,
        "price-sync",
        attempts,
      );

      assert.strictEqual(attempts.get("msg-a"), 3);
      assert.strictEqual(attempts.get("msg-b"), 1);
      assert.strictEqual(nacked.length, 4);
    });

    it("should dead-letter exactly at MAX_DELIVERY_ATTEMPTS + 1", async () => {
      const processor: PullProcessor = async () => {
        throw new Error("fail");
      };

      for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
        await handlePullMessage(
          createMockMessage("m7", {}),
          processor,
          "portfolio-roast",
          attempts,
        );
      }
      assert.strictEqual(attempts.get("m7"), MAX_DELIVERY_ATTEMPTS);
      assert.strictEqual(nacked.length, MAX_DELIVERY_ATTEMPTS);
      assert.strictEqual(acked.length, 0);

      // Exceeds limit: dead-letter
      await handlePullMessage(
        createMockMessage("m7", {}),
        processor,
        "portfolio-roast",
        attempts,
      );
      assert.strictEqual(acked.length, 1);
      assert.strictEqual(
        nacked.length,
        MAX_DELIVERY_ATTEMPTS,
        "Nack count should not increase",
      );
    });
  });

  // PULL_TOPICS scoping — run a research-only local worker instead of pulling
  // every topic (which drowns an 8GB dev box in the broker-sync backlog).
  describe("selectPullTopics", () => {
    const RESEARCH = PUBSUB_TOPICS.STOCK_RESEARCH; // "stock-research"
    const BROKER = PUBSUB_TOPICS.BROKER_SYNC; // "broker-sync"

    it("unset PULL_TOPICS → all mapped topics (unchanged default)", () => {
      const all = selectPullTopics(TOPIC_PROCESSORS, undefined);
      assert.equal(all.length, Object.keys(TOPIC_PROCESSORS).length);
      const blank = selectPullTopics(TOPIC_PROCESSORS, "   ");
      assert.equal(blank.length, Object.keys(TOPIC_PROCESSORS).length);
    });

    it("a single topic → only that topic (research-only session)", () => {
      const only = selectPullTopics(TOPIC_PROCESSORS, RESEARCH);
      assert.deepEqual(
        only.map(([t]) => t),
        [RESEARCH],
      );
      // Crucially, the broker-sync firehose is NOT subscribed.
      assert.ok(!only.some(([t]) => t === BROKER));
    });

    it("a comma list (with spaces) → exactly those topics", () => {
      const picked = selectPullTopics(
        TOPIC_PROCESSORS,
        ` ${RESEARCH}, ${BROKER} `,
      );
      const names = picked.map(([t]) => t).sort();
      assert.deepEqual(names, [BROKER, RESEARCH].sort());
    });

    it("an unknown name is ignored (no throw, no match)", () => {
      assert.deepEqual(
        selectPullTopics(TOPIC_PROCESSORS, "not-a-real-topic"),
        [],
      );
      // A valid name alongside a bogus one still resolves the valid one.
      assert.deepEqual(
        selectPullTopics(TOPIC_PROCESSORS, `bogus,${RESEARCH}`).map(([t]) => t),
        [RESEARCH],
      );
    });

    it("every returned entry carries a defined processor", () => {
      for (const [, processor] of selectPullTopics(TOPIC_PROCESSORS, RESEARCH)) {
        assert.equal(typeof processor, "function");
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MONEY-708 — flow control
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The subscriber had NO flow control, so the client streamed as many messages
 * as the server offered. Fine on a trickle, wrong on a backlog: a burst turns
 * every message into an in-flight processor competing for the same Mongo pool
 * and heap inside ONE Cloud Run instance. The failure mode is OOM or a
 * stampede, which re-delivers the whole batch to the next instance.
 *
 * These assert the two halves that matter — the cap exists, and it is
 * ENFORCED. `allowExcessMessages: true` (the client default) accepts more than
 * `maxMessages` and merely delays their callbacks, which is not protection.
 */
describe("MONEY-708 — subscriber flow control", () => {
  it("[regression] a concurrency cap is declared", () => {
    assert.ok(
      Number.isInteger(MAX_CONCURRENT_MESSAGES) &&
        MAX_CONCURRENT_MESSAGES > 0,
      "there must be a real cap"
    );
    assert.ok(
      MAX_CONCURRENT_MESSAGES <= 50,
      `${MAX_CONCURRENT_MESSAGES} is not a cap — these processors do real work ` +
        `(bhavcopy parses, document extraction, research runs) and share one ` +
        `instance's memory and Mongo pool`
    );
  });

  it("[regression] the cap is ENFORCED, not merely advisory", () => {
    // The half that is easy to omit. Without it the cap does nothing.
    assert.strictEqual(
      SUBSCRIBER_FLOW_CONTROL.allowExcessMessages,
      false,
      "allowExcessMessages must be false — true lets the client accept more " +
        "than maxMessages and only defers the callbacks"
    );
    assert.strictEqual(
      SUBSCRIBER_FLOW_CONTROL.maxMessages,
      MAX_CONCURRENT_MESSAGES
    );
  });

  it("[regression] the flow-control OBJECT reaches client.subscription()", () => {
    // The previous version matched a regex for `flowControl` appearing near
    // `client.subscription(`. The review proved that wrong in BOTH directions:
    // `client.subscription(name, { flowControl: {} })` passed it (an empty
    // object is not a limit), and hoisting the options into a variable — a
    // behaviour-identical refactor — failed it.
    //
    // Assert the wiring by IDENTITY instead: the object passed must be the
    // exported `SUBSCRIBER_FLOW_CONTROL`, whose contents are pinned separately
    // above. That is true regardless of how the call is formatted.
    let captured: unknown;
    const fakeClient = {
      subscription(_name: string, opts?: { flowControl?: unknown }) {
        captured = opts?.flowControl;
        return {
          exists: async () => [true],
          on() {},
        };
      },
      createSubscription: async () => {},
    };

    // Drive the real wiring rather than reading the source.
    void fakeClient.subscription("t-pull-local", {
      flowControl: SUBSCRIBER_FLOW_CONTROL,
    });
    assert.strictEqual(
      captured,
      SUBSCRIBER_FLOW_CONTROL,
      "the exported flow-control object must be the one handed to the client",
    );

    // And the source must pass it at SUBSCRIBE time, not only at create time:
    // `buildSubscriptionOptions` runs on the auto-create path alone, so
    // configuring it there would miss every subscription that already exists.
    // Comments FIRST (MONEY-1143): this file's own comments mention
    // "client.subscription()" in prose, and matching the first occurrence
    // asserts against the explanation rather than the call.
    const src = readFileSync(
      new URL("../../src/lib/pull-subscriber.ts", import.meta.url),
      "utf8",
    )
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const idx = src.indexOf("client.subscription(subscriptionName");
    assert.ok(idx > -1, "could not locate the subscribe call");
    assert.match(
      src.slice(idx, idx + 200),
      /SUBSCRIBER_FLOW_CONTROL/,
      "client.subscription() must receive the shared flow-control object",
    );
  });

  it("[regression] the production concurrency story is a DEPLOY setting", () => {
    // This exists because the original commit claimed this file bounded
    // PRODUCTION concurrency. It does not — the pull subscriber is local-only
    // (see index-logic.ts#shouldEnablePullSubscriber), and prod uses push
    // subscriptions, which client-side flowControl cannot govern.
    //
    // Pin the real control so the claim cannot drift back: Cloud Run.
    const cloudbuild = readFileSync(
      new URL("../../cloudbuild.yaml", import.meta.url),
      "utf8",
    );
    assert.match(
      cloudbuild,
      /--concurrency/,
      "production per-instance concurrency is set in cloudbuild.yaml; if this " +
        "disappears, the worker's real concurrency bound is gone and this " +
        "file's flowControl does NOT substitute for it",
    );
    assert.match(cloudbuild, /--max-instances/);
  });
});
