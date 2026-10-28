/**
 * @usemoney/pubsub — job publishers.
 *
 * Strengthened port of apps/web/__tests__/pubsub/publish.test.ts (which only
 * type-checked message shapes). Here we inject a FAKE PubSub via the
 * __setPubSubClientForTests seam and drive the REAL publish functions,
 * asserting each one:
 *   - resolves the correct env-suffixed topic (getTopicName(PUBSUB_TOPICS.*)),
 *   - rides the payload under `{ json: data }`,
 *   - returns the Pub/Sub messageId,
 * plus the error path (a publish failure propagates).
 */

import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import type { PubSub } from "@google-cloud/pubsub";

import { __setPubSubClientForTests } from "../src/client";
import {
  publishPairingJob,
  publishImportJob,
  publishSyncJob,
  publishResearchJob,
  publishResearchPreviewPlanJob,
  publishDocumentProcessJob,
  publishRoastJob,
  publishComparisonJob,
  publishLoginBriefingJob,
  publishL3AnalysisJob,
  publishStrategyScanJob,
  publishAccountDeletionJob,
  publishClerkDeleteSweepJob,
} from "../src/publish";
import { PUBSUB_TOPICS } from "@usemoney/types";

let savedEnv: string | undefined;

before(() => {
  savedEnv = process.env.PUBSUB_ENV;
});
beforeEach(() => {
  // Deterministic topic suffix for the assertions below.
  process.env.PUBSUB_ENV = "qa";
});
afterEach(() => {
  __setPubSubClientForTests(null);
});
after(() => {
  if (savedEnv === undefined) delete process.env.PUBSUB_ENV;
  else process.env.PUBSUB_ENV = savedEnv;
  __setPubSubClientForTests(null);
});

/** Inject a fresh recording fake, run `publish(data)`, assert the contract. */
async function expectPublish<T>(
  publish: (d: T) => Promise<string>,
  data: T,
  expectedBaseTopic: string,
): Promise<void> {
  const published: Array<{ topic: string; json: unknown }> = [];
  const fake = {
    topic(name: string) {
      return {
        async publishMessage({ json }: { json: unknown }) {
          published.push({ topic: name, json });
          return "msg-id-123";
        },
      };
    },
  };
  __setPubSubClientForTests(fake as unknown as PubSub);

  const id = await publish(data);

  assert.equal(id, "msg-id-123", "returns the pubsub messageId");
  assert.equal(published.length, 1, "publishes exactly once");
  assert.equal(
    published[0]!.topic,
    `${expectedBaseTopic}-qa`,
    "publishes to the env-suffixed topic",
  );
  assert.deepEqual(published[0]!.json, data, "payload rides under { json }");
}

describe("publish helpers → topic + payload", () => {
  it("publishPairingJob → trade-pairing", async () => {
    await expectPublish(
      publishPairingJob,
      { jobId: "p1", userId: "u1", batchId: "b1" },
      PUBSUB_TOPICS.TRADE_PAIRING,
    );
  });

  it("publishImportJob → csv-import", async () => {
    await expectPublish(
      publishImportJob,
      {
        jobId: "i1",
        userId: "u1",
        brokerFormat: "zerodha",
        fileType: "csv" as const,
        content: "a,b,c\n1,2,3",
      },
      PUBSUB_TOPICS.CSV_IMPORT,
    );
  });

  it("publishSyncJob → broker-sync", async () => {
    await expectPublish(
      publishSyncJob,
      { jobId: "s1", userId: "u1", broker: "zerodha" },
      PUBSUB_TOPICS.BROKER_SYNC,
    );
  });

  it("publishResearchJob → stock-research", async () => {
    await expectPublish(
      publishResearchJob,
      {
        jobId: "r1",
        userId: "u1",
        sessionId: "sess1",
        query: "Analyze RELIANCE",
      },
      PUBSUB_TOPICS.STOCK_RESEARCH,
    );
  });

  it("publishResearchPreviewPlanJob → research-preview-plan", async () => {
    await expectPublish(
      publishResearchPreviewPlanJob,
      { jobId: "rp1", userId: "u1", query: "q", deterministic: {} },
      PUBSUB_TOPICS.RESEARCH_PREVIEW_PLAN,
    );
  });

  it("publishDocumentProcessJob → document-process", async () => {
    await expectPublish(
      publishDocumentProcessJob,
      {
        jobId: "d1",
        userId: "u1",
        documentId: "doc1",
        action: "extract_text" as const,
      },
      PUBSUB_TOPICS.DOCUMENT_PROCESS,
    );
  });

  it("publishRoastJob → portfolio-roast", async () => {
    await expectPublish(
      publishRoastJob,
      {
        jobId: "ro1",
        userId: "u1",
        sessionId: "sess1",
        mode: "overall" as const,
        assetType: "all" as const,
      },
      PUBSUB_TOPICS.PORTFOLIO_ROAST,
    );
  });

  it("publishComparisonJob → comparison-analysis", async () => {
    await expectPublish(
      publishComparisonJob,
      {
        jobId: "c1",
        userId: "u1",
        sessionId: "sess1",
        kind: "stock" as const,
        depth: "deep",
        symbols: ["TCS", "INFY"],
      },
      PUBSUB_TOPICS.COMPARISON_ANALYSIS,
    );
  });

  it("publishLoginBriefingJob → login-briefing", async () => {
    await expectPublish(
      publishLoginBriefingJob,
      { userId: "u1", briefingId: "brief1" },
      PUBSUB_TOPICS.LOGIN_BRIEFING,
    );
  });

  it("publishL3AnalysisJob → l3-analysis", async () => {
    await expectPublish(
      publishL3AnalysisJob,
      { jobId: "l1", userId: "u1", sessionId: "sess1", segmentIndex: 0 },
      PUBSUB_TOPICS.L3_ANALYSIS,
    );
  });

  it("publishStrategyScanJob → strategy-scan", async () => {
    await expectPublish(
      publishStrategyScanJob,
      {
        jobId: "sc1",
        userId: "u1",
        scanId: "scan1",
        strategyId: "strat1",
        isBuiltIn: false,
        filters: [],
        logic: "AND",
        scanType: "custom",
        limit: 50,
      },
      PUBSUB_TOPICS.STRATEGY_SCAN,
    );
  });

  it("publishAccountDeletionJob → account-deletion", async () => {
    await expectPublish(
      publishAccountDeletionJob,
      {
        userId: "u1",
        clerkId: "clerk_1",
        email: "user@example.com",
        name: "User",
        deletedBy: "user" as const,
      },
      PUBSUB_TOPICS.ACCOUNT_DELETION,
    );
  });

  it("publishClerkDeleteSweepJob → clerk-delete-sweep (defaults to empty payload)", async () => {
    await expectPublish(
      publishClerkDeleteSweepJob,
      { batchSize: 100 },
      PUBSUB_TOPICS.CLERK_DELETE_SWEEP,
    );
  });
});

describe("publish error path", () => {
  it("propagates a publishMessage failure", async () => {
    const fake = {
      topic() {
        return {
          async publishMessage() {
            throw new Error("pubsub unavailable");
          },
        };
      },
    };
    __setPubSubClientForTests(fake as unknown as PubSub);
    await assert.rejects(
      () => publishPairingJob({ jobId: "p", userId: "u" }),
      /pubsub unavailable/,
    );
  });
});
