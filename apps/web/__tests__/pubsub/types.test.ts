/**
 * Pub/Sub Types & Constants Tests
 *
 * De-shadowed (MONEY-620): imports the REAL PUBSUB_TOPICS + getTopicName from
 * @usemoney/types (it loads clean under node:test — pure constants/helpers).
 * The message-structure fixtures are typed with the REAL job-message interfaces
 * via `satisfies` so they pin the actual wire contract.
 *
 * The old shadow re-declared a STALE 6-topic subset and asserted "exactly 6
 * topics" — the real registry has 25+ topics, so that copy was green while
 * testing a fraction of the surface.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PUBSUB_TOPICS,
  getTopicName,
  // MONEY-841 broker-sync shard config
  DEFAULT_SYNC_BUCKET_COUNT,
  getSyncBucketCount,
  syncBucketFor,
} from "@usemoney/types";
import type {
  PairingJobMessage,
  ImportJobMessage,
  SyncJobMessage,
  InstrumentSyncMessage,
  PriceSyncMessage,
  SectorEnrichmentMessage,
  MfSyncMessage,
  PubSubPushMessage,
} from "@usemoney/types";

// ── Tests ────────────────────────────────────────────────────────

describe("Pub/Sub Types & Constants", () => {
  describe("PUBSUB_TOPICS (real registry)", () => {
    it("carries the core topics with their kebab-case base names", () => {
      assert.strictEqual(PUBSUB_TOPICS.TRADE_PAIRING, "trade-pairing");
      assert.strictEqual(PUBSUB_TOPICS.CSV_IMPORT, "csv-import");
      assert.strictEqual(PUBSUB_TOPICS.BROKER_SYNC, "broker-sync");
      assert.strictEqual(PUBSUB_TOPICS.INSTRUMENT_SYNC, "instrument-sync");
      assert.strictEqual(PUBSUB_TOPICS.PRICE_SYNC, "price-sync");
      assert.strictEqual(PUBSUB_TOPICS.SECTOR_ENRICHMENT, "sector-enrichment");
    });

    it("has grown well beyond the original 6 (regression guard on the real set)", () => {
      assert.ok(
        Object.keys(PUBSUB_TOPICS).length >= 12,
        `expected the live registry to have ≥12 topics, got ${Object.keys(PUBSUB_TOPICS).length}`
      );
    });

    it("every topic base name is kebab-case", () => {
      for (const value of Object.values(PUBSUB_TOPICS)) {
        assert.ok(
          /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value),
          `Topic "${value}" is not kebab-case`
        );
      }
    });

    it("every topic value is unique", () => {
      const values = Object.values(PUBSUB_TOPICS);
      assert.strictEqual(values.length, new Set(values).size);
    });

    it("every topic key is SCREAMING_SNAKE_CASE", () => {
      for (const key of Object.keys(PUBSUB_TOPICS)) {
        assert.ok(
          /^[A-Z0-9]+(_[A-Z0-9]+)*$/.test(key),
          `Key "${key}" is not SCREAMING_SNAKE_CASE`
        );
      }
    });
  });

  describe("getTopicName (env suffixing)", () => {
    it("appends the env suffix to a base topic", () => {
      const name = getTopicName(PUBSUB_TOPICS.TRADE_PAIRING);
      assert.match(name, /^trade-pairing-(qa|prod)$/);
    });
  });

  // ── MONEY-841: broker-sync shard hashing (real exports) ────────────────
  describe("syncBucketFor + getSyncBucketCount (MONEY-841 sharding)", () => {
    // A spread of realistic 24-hex Mongo ObjectId-style userIds. Built by
    // string concatenation (a fixed 16-hex prefix + an 8-hex counter) — NOT
    // numeric addition, which would overflow Number.MAX_SAFE_INTEGER and collapse
    // every id to the same string.
    const userIds = Array.from(
      { length: 2000 },
      (_, i) => "507f1f77bcf86cd7" + i.toString(16).padStart(8, "0")
    );

    it("DEFAULT_SYNC_BUCKET_COUNT is 64 and is the unset default", () => {
      assert.strictEqual(DEFAULT_SYNC_BUCKET_COUNT, 64);
      // No SYNC_BUCKET_COUNT in the test env → falls back to the default.
      const prev = process.env.SYNC_BUCKET_COUNT;
      delete process.env.SYNC_BUCKET_COUNT;
      try {
        assert.strictEqual(getSyncBucketCount(), 64);
      } finally {
        if (prev !== undefined) process.env.SYNC_BUCKET_COUNT = prev;
      }
    });

    it("getSyncBucketCount honors a valid SYNC_BUCKET_COUNT override", () => {
      const prev = process.env.SYNC_BUCKET_COUNT;
      try {
        process.env.SYNC_BUCKET_COUNT = "128";
        assert.strictEqual(getSyncBucketCount(), 128);
        // Invalid values (0, negative, NaN, non-integer, empty) → default 64.
        for (const bad of ["0", "-5", "abc", "", "12.5"]) {
          process.env.SYNC_BUCKET_COUNT = bad;
          assert.strictEqual(
            getSyncBucketCount(),
            64,
            `"${bad}" should fall back to 64`
          );
        }
      } finally {
        if (prev === undefined) delete process.env.SYNC_BUCKET_COUNT;
        else process.env.SYNC_BUCKET_COUNT = prev;
      }
    });

    it("is DETERMINISTIC — same userId always yields the same bucket", () => {
      for (const id of userIds.slice(0, 100)) {
        const a = syncBucketFor(id, 64);
        const b = syncBucketFor(id, 64);
        assert.strictEqual(a, b);
      }
    });

    it("is always IN RANGE [0, count) — for several counts", () => {
      for (const count of [1, 7, 16, 64, 128, 257]) {
        for (const id of userIds) {
          const bucket = syncBucketFor(id, count);
          assert.ok(
            Number.isInteger(bucket) && bucket >= 0 && bucket < count,
            `bucket ${bucket} out of range for count ${count}`
          );
        }
      }
    });

    it("is non-negative even for high-bit hashes (>>> 0 unsigned coercion)", () => {
      // Strings chosen to exercise large high-bit FNV results; modulo must
      // never go negative.
      for (const id of ["￿￿￿", "zzzzzzzzzzzz", "~~~~~~~~"]) {
        const bucket = syncBucketFor(id, 64);
        assert.ok(bucket >= 0 && bucket < 64);
      }
    });

    it("DISTRIBUTES evenly — 2000 ids over 64 buckets, no clumping", () => {
      const counts = new Array<number>(64).fill(0);
      for (const id of userIds) counts[syncBucketFor(id, 64)]++;
      const used = counts.filter((n) => n > 0).length;
      const max = Math.max(...counts);
      const ideal = userIds.length / 64; // ~31
      // Every bucket should get at least one id, and the worst bucket should be
      // well under 3x the ideal load (a bad/biased hash clumps far worse).
      assert.ok(used === 64, `expected all 64 buckets used, got ${used}`);
      assert.ok(
        max < ideal * 3,
        `worst bucket ${max} too heavy vs ideal ${ideal.toFixed(1)}`
      );
    });

    it("uses Math.random for NOTHING — repeated process-wide calls are stable", () => {
      // Re-import-free stability check: call across the whole set twice and diff.
      const first = userIds.map((id) => syncBucketFor(id, 64));
      const second = userIds.map((id) => syncBucketFor(id, 64));
      assert.deepStrictEqual(first, second);
    });
  });

  describe("Message Structure Validation (typed against real interfaces)", () => {
    it("PairingJobMessage — with and without optional batchId", () => {
      const withBatch = {
        jobId: "j1",
        userId: "u1",
        batchId: "b1",
      } satisfies PairingJobMessage;
      const without = { jobId: "j1", userId: "u1" } satisfies PairingJobMessage;
      assert.strictEqual(withBatch.batchId, "b1");
      assert.strictEqual(without.jobId, "j1");
    });

    it("ImportJobMessage — required + all optional fields", () => {
      const msg = {
        jobId: "j1",
        userId: "u1",
        content: "symbol,qty\nRELIANCE,10",
        fileUrl: "gs://bucket/file.csv",
        brokerFormat: "zerodha",
        fileType: "csv",
        fileName: "trades.csv",
        brokerConnectionId: "bc1",
        linkToManual: true,
      } satisfies ImportJobMessage;
      assert.ok(msg.fileType === "csv" || msg.fileType === "xlsx");
      assert.strictEqual(msg.linkToManual, true);
    });

    it("SyncJobMessage — dataTypes array", () => {
      const msg = {
        jobId: "j1",
        userId: "u1",
        dataTypes: ["holdings", "positions"],
      } satisfies SyncJobMessage;
      assert.ok(msg.dataTypes?.includes("holdings"));
    });

    it("SyncJobMessage — MONEY-841 fan-out trigger vs per-shard leaf", () => {
      // Explicit annotation (not `satisfies`) so `.syncBucket` is accessible as
      // the interface's optional field, including on the trigger that omits it.
      // Fan-out trigger: scheduled, no syncBucket.
      const trigger: SyncJobMessage = {
        jobId: "cron",
        userId: "*",
        isScheduled: true,
      };
      // Per-shard leaf: scheduled WITH a syncBucket.
      const leaf: SyncJobMessage = {
        jobId: "shard-3",
        userId: "*",
        isScheduled: true,
        syncBucket: 3,
      };
      assert.strictEqual(trigger.syncBucket, undefined);
      assert.strictEqual(leaf.syncBucket, 3);
    });

    it("InstrumentSyncMessage — populated and empty (all optional)", () => {
      const full = {
        exchanges: ["NSE", "BSE"],
        forceFullSync: true,
      } satisfies InstrumentSyncMessage;
      const empty = {} satisfies InstrumentSyncMessage;
      assert.ok(Array.isArray(full.exchanges));
      assert.deepStrictEqual(empty, {});
    });

    it("PriceSyncMessage — MONEY-566 source narrowed to YAHOO", () => {
      const msg = {
        instrumentIds: ["id1", "id2"],
        dateRange: { start: "2025-01-01", end: "2026-01-01" },
        source: "YAHOO",
      } satisfies PriceSyncMessage;
      assert.strictEqual(msg.source, "YAHOO");
      assert.strictEqual(msg.dateRange?.start, "2025-01-01");
    });

    it("SectorEnrichmentMessage — all fields", () => {
      const msg = {
        batchSize: 100,
        exchanges: ["NSE"],
        forceReEnrich: false,
        delayMs: 2000,
      } satisfies SectorEnrichmentMessage;
      assert.strictEqual(msg.batchSize, 100);
    });

    it("MfSyncMessage — forceFullSync", () => {
      const msg = { forceFullSync: true } satisfies MfSyncMessage;
      assert.strictEqual(msg.forceFullSync, true);
    });

    it("PubSubPushMessage — Cloud Run envelope round-trips base64 JSON", () => {
      const envelope = {
        message: {
          data: "eyJ0ZXN0IjogdHJ1ZX0=", // base64 of {"test": true}
          messageId: "12345",
          publishTime: "2026-02-04T00:00:00Z",
        },
        subscription: "projects/my-project/subscriptions/price-sync-push-qa",
      } satisfies PubSubPushMessage;

      const decoded = Buffer.from(envelope.message.data, "base64").toString(
        "utf-8"
      );
      assert.strictEqual(JSON.parse(decoded).test, true);
    });
  });
});
