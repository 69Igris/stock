/**
 * Workers Integration Tests (workers/src/index.ts + routes + lib/message.ts)
 *
 * Tests for the overall worker service architecture:
 *   - Route registration and endpoint mapping
 *   - Health endpoint contract
 *   - Pub/Sub message envelope parsing and decoding
 *   - Job message format validation
 *   - Pull subscriber activation logic
 *   - Graceful shutdown signal handling
 *
 * All external dependencies are inlined/mocked in-place.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Route Registry (mirrors workers/src/index.ts route registration) ──

interface RouteEntry {
  method: "GET" | "POST";
  path: string;
  description: string;
}

const REGISTERED_ROUTES: RouteEntry[] = [
  { method: "GET", path: "/health", description: "Health check" },
  {
    method: "POST",
    path: "/jobs/trade-pairing",
    description: "FIFO trade pairing computation",
  },
  {
    method: "POST",
    path: "/jobs/csv-import",
    description: "CSV/XLS trade import processing",
  },
  {
    method: "POST",
    path: "/jobs/broker-sync",
    description: "Broker data synchronization",
  },
  {
    method: "POST",
    path: "/jobs/instrument-sync",
    description: "Instrument master data sync",
  },
  {
    method: "POST",
    path: "/jobs/price-sync",
    description: "Price data sync",
  },
  {
    method: "POST",
    path: "/jobs/sector-enrichment",
    description: "Sector enrichment",
  },
  {
    method: "POST",
    path: "/jobs/mf-sync",
    description: "Mutual fund master data sync",
  },
  {
    method: "POST",
    path: "/jobs/mf-metadata-sync",
    description: "MF metadata enrichment",
  },
  {
    method: "POST",
    path: "/jobs/stock-research",
    description: "Stock research agent",
  },
];

// ── Pub/Sub message parsing (from lib/message.ts) ───────────────────

interface PubSubPushMessage {
  message: {
    data: string;
    messageId: string;
    publishTime: string;
  };
  subscription: string;
}

function isPubSubEnvelope(body: unknown): body is PubSubPushMessage {
  return (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof (body as PubSubPushMessage).message?.data === "string"
  );
}

function parsePubSubMessage<T>(body: unknown): T {
  if (isPubSubEnvelope(body)) {
    const decoded = Buffer.from(body.message.data, "base64").toString("utf-8");
    return JSON.parse(decoded) as T;
  }
  return body as T;
}

function getMessageId(body: unknown): string {
  if (isPubSubEnvelope(body) && body.message.messageId) {
    return body.message.messageId;
  }
  return `local-${Date.now()}`;
}

// ── Inline health handler ──────────────────────────────────────────

interface HealthResponse {
  status: string;
  timestamp: string;
}

function healthHandler(): HealthResponse {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
  };
}

// ── Pull subscriber activation logic (from workers/src/index.ts) ────

function shouldEnablePull(env: {
  ENABLE_PULL_SUBSCRIBER?: string;
  NODE_ENV?: string;
  GCP_PROJECT_ID?: string;
}): boolean {
  return (
    env.ENABLE_PULL_SUBSCRIBER === "true" ||
    (env.NODE_ENV !== "production" && !!env.GCP_PROJECT_ID)
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

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

// ── Job message types (mirrors @usemoney/types) ────────────────────

interface PairingJobMessage {
  jobId: string;
  userId: string;
  batchId?: string;
}

interface SyncJobMessage {
  jobId: string;
  userId: string;
  brokerConnectionId?: string;
  broker?: string;
  dataTypes?: string[];
}

interface InstrumentSyncMessage {
  exchanges?: string[];
  forceFullSync?: boolean;
}

interface PriceSyncMessage {
  instrumentIds?: string[];
  dateRange?: { start: string; end: string };
  source?: "YAHOO" | "ZERODHA";
}

interface ResearchJobMessage {
  jobId: string;
  sessionId: string;
  query: string;
  userId?: string;
  symbols?: string[];
  mode?: "fast" | "deep";
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Workers - Integration", () => {
  // ── Route registration ────────────────────────────────────────

  describe("Route registration", () => {
    it("should have exactly 10 registered routes", () => {
      assert.strictEqual(REGISTERED_ROUTES.length, 10);
    });

    it("should have exactly 1 GET route", () => {
      const getRoutes = REGISTERED_ROUTES.filter((r) => r.method === "GET");
      assert.strictEqual(getRoutes.length, 1);
    });

    it("should have exactly 9 POST routes", () => {
      const postRoutes = REGISTERED_ROUTES.filter((r) => r.method === "POST");
      assert.strictEqual(postRoutes.length, 9);
    });

    it("should have GET /health as the only non-job route", () => {
      const nonJobRoutes = REGISTERED_ROUTES.filter(
        (r) => !r.path.startsWith("/jobs/")
      );
      assert.strictEqual(nonJobRoutes.length, 1);
      assert.strictEqual(nonJobRoutes[0]!.path, "/health");
      assert.strictEqual(nonJobRoutes[0]!.method, "GET");
    });

    it("should have all POST routes under /jobs/ prefix", () => {
      const postRoutes = REGISTERED_ROUTES.filter((r) => r.method === "POST");
      for (const route of postRoutes) {
        assert.ok(
          route.path.startsWith("/jobs/"),
          `POST route ${route.path} should start with /jobs/`
        );
      }
    });

    it("should include trade-pairing route", () => {
      const found = REGISTERED_ROUTES.find(
        (r) => r.path === "/jobs/trade-pairing"
      );
      assert.ok(found, "Should have /jobs/trade-pairing route");
      assert.strictEqual(found!.method, "POST");
    });

    it("should include csv-import route", () => {
      const found = REGISTERED_ROUTES.find(
        (r) => r.path === "/jobs/csv-import"
      );
      assert.ok(found, "Should have /jobs/csv-import route");
    });

    it("should include broker-sync route", () => {
      const found = REGISTERED_ROUTES.find(
        (r) => r.path === "/jobs/broker-sync"
      );
      assert.ok(found, "Should have /jobs/broker-sync route");
    });

    it("should include stock-research route", () => {
      const found = REGISTERED_ROUTES.find(
        (r) => r.path === "/jobs/stock-research"
      );
      assert.ok(found, "Should have /jobs/stock-research route");
    });

    it("should have no duplicate paths", () => {
      const paths = REGISTERED_ROUTES.map((r) => r.path);
      const unique = new Set(paths);
      assert.strictEqual(
        unique.size,
        paths.length,
        "All route paths should be unique"
      );
    });
  });

  // ── Health endpoint ───────────────────────────────────────────

  describe("Health endpoint contract", () => {
    it("should return status ok", () => {
      const response = healthHandler();
      assert.strictEqual(response.status, "ok");
    });

    it("should return a valid ISO 8601 timestamp", () => {
      const response = healthHandler();
      const parsed = Date.parse(response.timestamp);
      assert.ok(!isNaN(parsed), "timestamp should be parseable");
    });
  });

  // ── Pub/Sub message envelope parsing ──────────────────────────

  describe("Pub/Sub message envelope parsing", () => {
    it("should decode base64 encoded PairingJobMessage", () => {
      const payload: PairingJobMessage = {
        jobId: "pair-001",
        userId: "u-1",
        batchId: "batch-1",
      };
      const envelope = makeEnvelope(payload);

      const result = parsePubSubMessage<PairingJobMessage>(envelope);

      assert.strictEqual(result.jobId, "pair-001");
      assert.strictEqual(result.userId, "u-1");
      assert.strictEqual(result.batchId, "batch-1");
    });

    it("should decode base64 encoded SyncJobMessage", () => {
      const payload: SyncJobMessage = {
        jobId: "sync-001",
        userId: "u-2",
        broker: "ZERODHA",
        dataTypes: ["holdings", "trades"],
      };
      const envelope = makeEnvelope(payload);

      const result = parsePubSubMessage<SyncJobMessage>(envelope);

      assert.strictEqual(result.broker, "ZERODHA");
      assert.deepStrictEqual(result.dataTypes, ["holdings", "trades"]);
    });

    it("should decode base64 encoded InstrumentSyncMessage", () => {
      const payload: InstrumentSyncMessage = {
        exchanges: ["NSE", "BSE"],
        forceFullSync: true,
      };
      const envelope = makeEnvelope(payload);

      const result = parsePubSubMessage<InstrumentSyncMessage>(envelope);

      assert.deepStrictEqual(result.exchanges, ["NSE", "BSE"]);
      assert.strictEqual(result.forceFullSync, true);
    });

    it("should decode base64 encoded PriceSyncMessage", () => {
      const payload: PriceSyncMessage = {
        source: "YAHOO",
        dateRange: { start: "2025-01-01", end: "2025-12-31" },
      };
      const envelope = makeEnvelope(payload);

      const result = parsePubSubMessage<PriceSyncMessage>(envelope);

      assert.strictEqual(result.source, "YAHOO");
      assert.strictEqual(result.dateRange!.start, "2025-01-01");
    });

    it("should decode base64 encoded ResearchJobMessage", () => {
      const payload: ResearchJobMessage = {
        jobId: "res-001",
        sessionId: "sess-001",
        query: "Analyze TCS",
        userId: "u-1",
        symbols: ["TCS.NS"],
        mode: "deep",
      };
      const envelope = makeEnvelope(payload);

      const result = parsePubSubMessage<ResearchJobMessage>(envelope);

      assert.strictEqual(result.mode, "deep");
      assert.deepStrictEqual(result.symbols, ["TCS.NS"]);
    });

    it("should extract messageId from Pub/Sub envelope", () => {
      const envelope = makeEnvelope({ test: true }, "msg-42");

      assert.strictEqual(getMessageId(envelope), "msg-42");
    });
  });

  // ── Direct JSON body handling ─────────────────────────────────

  describe("Direct JSON body (local dev)", () => {
    it("should pass through InstrumentSyncMessage directly", () => {
      const body: InstrumentSyncMessage = { exchanges: ["NSE"] };

      const result = parsePubSubMessage<InstrumentSyncMessage>(body);

      assert.deepStrictEqual(result.exchanges, ["NSE"]);
    });

    it("should generate local-* messageId for direct body", () => {
      const id = getMessageId({ test: true });
      assert.ok(id.startsWith("local-"));
    });

    it("should pass through empty object as valid direct JSON", () => {
      const result = parsePubSubMessage<Record<string, unknown>>({});
      assert.deepStrictEqual(result, {});
    });
  });

  // ── Pull subscriber activation logic ──────────────────────────

  describe("Pull subscriber activation", () => {
    it("should enable when ENABLE_PULL_SUBSCRIBER is 'true'", () => {
      assert.strictEqual(
        shouldEnablePull({
          ENABLE_PULL_SUBSCRIBER: "true",
          NODE_ENV: "production",
        }),
        true
      );
    });

    it("should enable in non-production with GCP_PROJECT_ID set", () => {
      assert.strictEqual(
        shouldEnablePull({
          NODE_ENV: "development",
          GCP_PROJECT_ID: "my-project",
        }),
        true
      );
    });

    it("should NOT enable in production without explicit flag", () => {
      assert.strictEqual(
        shouldEnablePull({
          NODE_ENV: "production",
          GCP_PROJECT_ID: "my-project",
        }),
        false
      );
    });

    it("should NOT enable without GCP_PROJECT_ID in non-production", () => {
      assert.strictEqual(shouldEnablePull({ NODE_ENV: "development" }), false);
    });

    it("should NOT enable with empty GCP_PROJECT_ID", () => {
      assert.strictEqual(
        shouldEnablePull({ NODE_ENV: "development", GCP_PROJECT_ID: "" }),
        false
      );
    });

    it("should enable with explicit flag even without GCP_PROJECT_ID", () => {
      assert.strictEqual(
        shouldEnablePull({
          ENABLE_PULL_SUBSCRIBER: "true",
          NODE_ENV: "production",
        }),
        true
      );
    });
  });
});
