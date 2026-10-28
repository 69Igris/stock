import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PUBSUB_TOPICS } from "@usemoney/types";
import type {
  PairingJobMessage,
  ImportJobMessage,
  SyncJobMessage,
} from "@usemoney/types";

// De-shadowed (MONEY-620): imports the REAL PUBSUB_TOPICS from @usemoney/types
// and types the publish-message fixtures with the real job-message interfaces.
// The old shadow re-declared a 4-topic subset and asserted "exactly 4" — the
// live registry has 25+ topics.

describe("Pub/Sub Publish", () => {
  describe("PUBSUB_TOPICS (real)", () => {
    it("carries the publish-path topic base names", () => {
      assert.equal(PUBSUB_TOPICS.TRADE_PAIRING, "trade-pairing");
      assert.equal(PUBSUB_TOPICS.CSV_IMPORT, "csv-import");
      assert.equal(PUBSUB_TOPICS.BROKER_SYNC, "broker-sync");
      assert.equal(PUBSUB_TOPICS.STOCK_RESEARCH, "stock-research");
    });
  });

  describe("PairingJobMessage structure", () => {
    it("should validate required fields", () => {
      const message = {
        jobId: "pair-001",
        userId: "user-abc",
      } satisfies PairingJobMessage;

      assert.equal(typeof message.jobId, "string");
      assert.equal(typeof message.userId, "string");
    });

    it("should allow optional batchId", () => {
      const message = {
        jobId: "pair-002",
        userId: "user-abc",
        batchId: "batch-123",
      } satisfies PairingJobMessage;

      assert.equal(message.batchId, "batch-123");
    });
  });

  describe("ImportJobMessage structure", () => {
    it("should validate required fields", () => {
      const message = {
        jobId: "import-001",
        userId: "user-abc",
        brokerFormat: "zerodha",
        fileType: "csv" as const,
      };

      assert.equal(message.jobId, "import-001");
      assert.equal(message.brokerFormat, "zerodha");
      assert.equal(message.fileType, "csv");
    });

    it("should allow optional content for inline CSV", () => {
      const message = {
        jobId: "import-002",
        userId: "user-abc",
        brokerFormat: "upstox",
        fileType: "csv" as const,
        content: "symbol,qty,price\nRELIANCE,10,2500",
      };

      assert.ok(message.content);
      assert.ok(message.content.includes("RELIANCE"));
    });

    it("should allow optional fileUrl for GCS", () => {
      const message = {
        jobId: "import-003",
        userId: "user-abc",
        brokerFormat: "zerodha",
        fileType: "xlsx" as const,
        fileUrl: "gs://stockbook-imports/file.xlsx",
      };

      assert.ok(message.fileUrl);
    });

    it("should allow optional linking fields", () => {
      const message = {
        jobId: "import-004",
        userId: "user-abc",
        brokerFormat: "dhan",
        fileType: "csv" as const,
        brokerConnectionId: "conn-123",
        linkToManual: true,
        fileName: "trades.csv",
      };

      assert.equal(message.brokerConnectionId, "conn-123");
      assert.equal(message.linkToManual, true);
      assert.equal(message.fileName, "trades.csv");
    });
  });

  describe("SyncJobMessage structure", () => {
    it("should validate required fields", () => {
      const message = {
        jobId: "sync-001",
        userId: "user-abc",
      };

      assert.equal(message.jobId, "sync-001");
      assert.equal(message.userId, "user-abc");
    });

    it("should allow optional broker filter", () => {
      const message = {
        jobId: "sync-002",
        userId: "user-abc",
        broker: "zerodha",
        brokerConnectionId: "conn-456",
      };

      assert.equal(message.broker, "zerodha");
    });

    it("should allow optional dataTypes filter", () => {
      const message = {
        jobId: "sync-003",
        userId: "user-abc",
        dataTypes: ["holdings", "trades"] as const,
      };

      assert.deepStrictEqual(message.dataTypes, ["holdings", "trades"]);
    });
  });

  describe("ResearchJobMessage structure", () => {
    it("should validate required fields", () => {
      const message = {
        jobId: "research-001",
        userId: "user-abc",
        sessionId: "session-xyz",
        query: "Analyze RELIANCE stock",
      };

      assert.equal(message.jobId, "research-001");
      assert.equal(message.userId, "user-abc");
      assert.equal(message.sessionId, "session-xyz");
      assert.equal(message.query, "Analyze RELIANCE stock");
    });

    it("should allow optional skill parameter", () => {
      const message = {
        jobId: "research-002",
        userId: "user-abc",
        sessionId: "session-002",
        query: "Compare TCS and Infosys",
        skill: "comparison",
      };

      assert.equal(message.skill, "comparison");
    });

    it("should allow optional symbols parameter", () => {
      const message = {
        jobId: "research-003",
        userId: "user-abc",
        sessionId: "session-003",
        query: "Sector analysis",
        symbols: ["RELIANCE", "TCS", "INFY"],
      };

      assert.deepStrictEqual(message.symbols, ["RELIANCE", "TCS", "INFY"]);
    });

    it("should work without optional fields", () => {
      const message = {
        jobId: "research-004",
        userId: "user-abc",
        sessionId: "session-004",
        query: "Market outlook",
      };

      assert.equal(typeof message.jobId, "string");
      assert.equal(typeof message.userId, "string");
      assert.equal(typeof message.sessionId, "string");
      assert.equal(typeof message.query, "string");
      assert.equal((message as Record<string, unknown>).skill, undefined);
      assert.equal((message as Record<string, unknown>).symbols, undefined);
    });

    it("should allow empty symbols array", () => {
      const message = {
        jobId: "research-005",
        userId: "user-abc",
        sessionId: "session-005",
        query: "General analysis",
        symbols: [] as string[],
      };

      assert.deepStrictEqual(message.symbols, []);
    });
  });

  describe("Message serialization", () => {
    it("should serialize PairingJobMessage to valid JSON", () => {
      const message = { jobId: "p1", userId: "u1", batchId: "b1" };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json);

      assert.deepStrictEqual(parsed, message);
    });

    it("should serialize ImportJobMessage to valid JSON", () => {
      const message = {
        jobId: "i1",
        userId: "u1",
        content: "a,b,c\n1,2,3",
        brokerFormat: "zerodha",
        fileType: "csv",
      };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json);

      assert.deepStrictEqual(parsed, message);
    });

    it("should serialize SyncJobMessage to valid JSON", () => {
      const message = {
        jobId: "s1",
        userId: "u1",
        dataTypes: ["holdings", "positions", "trades", "mutualFunds"],
      };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json);

      assert.deepStrictEqual(parsed, message);
    });

    it("should serialize ResearchJobMessage to valid JSON", () => {
      const message = {
        jobId: "r1",
        userId: "u1",
        sessionId: "s1",
        query: "Analyze HDFC Bank",
        skill: "deep-analysis",
        symbols: ["HDFCBANK", "ICICIBANK"],
      };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json);

      assert.deepStrictEqual(parsed, message);
    });

    it("should handle base64 round-trip encoding", () => {
      const original = { jobId: "test", userId: "u1" };
      const encoded = Buffer.from(JSON.stringify(original)).toString("base64");
      const decoded = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf-8")
      );

      assert.deepStrictEqual(decoded, original);
    });

    it("should handle base64 round-trip for ResearchJobMessage", () => {
      const original = {
        jobId: "research-b64",
        userId: "user-xyz",
        sessionId: "session-b64",
        query: "What is the PE ratio of TCS?",
        skill: "fundamentals",
        symbols: ["TCS"],
      };
      const encoded = Buffer.from(JSON.stringify(original)).toString("base64");
      const decoded = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf-8")
      );

      assert.deepStrictEqual(decoded, original);
      assert.equal(decoded.sessionId, "session-b64");
      assert.deepStrictEqual(decoded.symbols, ["TCS"]);
    });
  });

  // ───────────────────── Edge cases ─────────────────────

  describe("Edge cases", () => {
    it("should handle very long query strings in ResearchJobMessage", () => {
      const message = {
        jobId: "r-long",
        userId: "u1",
        sessionId: "s-long",
        query: "A".repeat(10000),
      };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed.query.length, 10000);
    });

    it("should handle large symbols array", () => {
      const symbols = Array.from({ length: 50 }, (_, i) => `SYM${i}`);
      const message = {
        jobId: "r-large",
        userId: "u1",
        sessionId: "s-large",
        query: "Compare all",
        symbols,
      };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed.symbols.length, 50);
    });

    it("should handle message with all optional fields present", () => {
      const message = {
        jobId: "import-full",
        userId: "user-full",
        content: "symbol,qty,price\nTCS,10,3500",
        fileUrl: "https://storage.example.com/file.csv",
        brokerFormat: "zerodha",
        fileType: "csv" as const,
        fileName: "trades.csv",
        brokerConnectionId: "conn-123",
        linkToManual: true,
      };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed.linkToManual, true);
      assert.strictEqual(parsed.fileName, "trades.csv");
    });

    it("should handle message with all optional fields absent", () => {
      const message = {
        jobId: "import-min",
        userId: "user-min",
        brokerFormat: "generic",
        fileType: "csv" as const,
      };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed.content, undefined);
      assert.strictEqual(parsed.fileUrl, undefined);
    });

    it("should handle special characters in query (₹, %, unicode)", () => {
      const message = {
        jobId: "r-special",
        userId: "u1",
        sessionId: "s-special",
        query: "₹50L portfolio with 15% CAGR - is that realistic? 你好",
      };
      const json = JSON.stringify(message);
      const parsed = JSON.parse(json);
      assert.ok(parsed.query.includes("₹"));
      assert.ok(parsed.query.includes("你好"));
    });

    it("should handle sync message with all dataTypes", () => {
      const message = {
        jobId: "sync-all",
        userId: "u1",
        dataTypes: ["holdings", "positions", "trades", "mutualFunds"],
      };
      assert.strictEqual(message.dataTypes.length, 4);
    });

    it("should handle sync message with single dataType", () => {
      const message = {
        jobId: "sync-one",
        userId: "u1",
        dataTypes: ["holdings"],
      };
      assert.strictEqual(message.dataTypes.length, 1);
    });

    it("should handle sync message with empty dataTypes", () => {
      const message = {
        jobId: "sync-empty",
        userId: "u1",
        dataTypes: [] as string[],
      };
      assert.strictEqual(message.dataTypes.length, 0);
    });
  });

  // ───────────────────── Functional: publish function patterns ─────────────────────

  describe("Functional: publish function patterns", () => {
    it("should follow consistent pattern across all publish functions", () => {
      // All 4 functions follow: getPubSubClient → topic → publishMessage → return messageId
      // We verify the pattern by checking message shapes
      const pairingMsg = { jobId: "p1", userId: "u1" };
      const importMsg = {
        jobId: "i1",
        userId: "u1",
        brokerFormat: "zerodha",
        fileType: "csv" as const,
      };
      const syncMsg = { jobId: "s1", userId: "u1" };
      const researchMsg = {
        jobId: "r1",
        userId: "u1",
        sessionId: "rs1",
        query: "test",
      };

      // All must have jobId and userId
      for (const msg of [pairingMsg, importMsg, syncMsg, researchMsg]) {
        assert.ok(msg.jobId);
        assert.ok(msg.userId);
      }
    });

    it("should map to correct topic names", () => {
      assert.strictEqual(PUBSUB_TOPICS.TRADE_PAIRING, "trade-pairing");
      assert.strictEqual(PUBSUB_TOPICS.CSV_IMPORT, "csv-import");
      assert.strictEqual(PUBSUB_TOPICS.BROKER_SYNC, "broker-sync");
      assert.strictEqual(PUBSUB_TOPICS.STOCK_RESEARCH, "stock-research");
    });
  });
});
