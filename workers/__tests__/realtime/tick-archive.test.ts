/**
 * The raw-tick archive — `feeds/TIINGO/ws/`.
 *
 * This prefix was described in the PRESENT TENSE in five places (CLAUDE.md, the
 * GCS lifecycle policy, the prod->QA rsync exclusion, scripts/README.md, and
 * the sink's own `toArchiveLine`) while nothing wrote to it. `toArchiveLine`
 * had zero callers. A Delete rule over an empty prefix deletes nothing, so the
 * arrangement was perfectly self-consistent and completely inert — and the two
 * agreement tests pinned the two CONFIG strings to each other, with no third
 * anchor to a writer.
 *
 * These cases exist so the writer is the anchor.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TickArchive,
  archiveKey,
  archiveEnabled,
  TICK_ARCHIVE_PREFIX,
  MAX_BUFFERED_LINES,
  ARCHIVE_FLUSH_MS,
} from "../../src/realtime/tick-archive";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const saved = {
  bucket: process.env.GCP_STORAGE_BUCKET,
  off: process.env.TIINGO_RT_ARCHIVE,
};

describe("tick archive — the prefix the infra already describes", () => {
  it("THE AGREEMENT: the writer's prefix is the one the lifecycle rule deletes", () => {
    // The whole point. Three files name this prefix and no compiler sees all
    // three; without this the writer could drift to `feeds/tiingo/ws/` and the
    // Delete rule would silently stop covering it — a bucket that grows
    // forever, with a lifecycle rule that looks correct in isolation.
    const policyPath = join(REPO, "scripts/ops/gcs-lifecycle.json");
    assert.ok(existsSync(policyPath), "the lifecycle policy is gone");
    const policy = readFileSync(policyPath, "utf8");

    assert.ok(
      policy.includes(`${TICK_ARCHIVE_PREFIX}/`),
      `the lifecycle policy does not name ${TICK_ARCHIVE_PREFIX}/ — the writer and the ` +
        "Delete rule have drifted apart",
    );
  });

  it("THE AGREEMENT: the rsync exclusion covers what the writer writes", () => {
    // QA must not receive raw ticks. The exclusion is a regex RELATIVE to the
    // rsync source (`feeds/`), so it cannot be compared to the absolute prefix
    // by string equality — it is reconstructed instead.
    const syncPath = join(REPO, "scripts/ops/sync-prod-to-qa.sh");
    const sync = readFileSync(syncPath, "utf8");
    const relative = TICK_ARCHIVE_PREFIX.replace(/^feeds\//, "");
    assert.ok(
      sync.includes(`^${relative}/`),
      `the rsync exclusion does not cover ${relative}/ — QA would receive raw ticks`,
    );
  });

  it("keys are date- and hour-partitioned so one hour can be listed alone", () => {
    const key = archiveKey(Date.UTC(2026, 8, 1, 14, 7, 30), 4242);
    assert.ok(key.startsWith(`${TICK_ARCHIVE_PREFIX}/2026-09-01/14/`), key);
    assert.ok(key.endsWith(".jsonl.gz"), key);
  });

  it("the key carries the pid, so overlapping revisions cannot overwrite", () => {
    // Cloud Run overlaps revisions on deploy — the same window the leader lock
    // exists for. Two processes flushing the same minute must produce two
    // objects, not one truncated one.
    const at = Date.UTC(2026, 8, 1, 14, 7, 0);
    assert.notEqual(archiveKey(at, 1), archiveKey(at, 2));
  });
});

describe("tick archive — buffering", () => {
  beforeEach(() => {
    process.env.GCP_STORAGE_BUCKET = "test-bucket";
    delete process.env.TIINGO_RT_ARCHIVE;
  });
  afterEach(() => {
    if (saved.bucket === undefined) delete process.env.GCP_STORAGE_BUCKET;
    else process.env.GCP_STORAGE_BUCKET = saved.bucket;
    if (saved.off === undefined) delete process.env.TIINGO_RT_ARCHIVE;
    else process.env.TIINGO_RT_ARCHIVE = saved.off;
  });

  it("buffers frames and reports the depth", () => {
    const a = new TickArchive();
    a.add('{"messageType":"A"}', 1);
    a.add('{"messageType":"A"}', 2);
    assert.equal(a.counters.buffered, 2);
  });

  it("is a silent no-op when no bucket is configured", () => {
    // UNSET is a legitimate state — local dev, and any env not yet given a
    // bucket. It must not throw and must not accumulate.
    delete process.env.GCP_STORAGE_BUCKET;
    assert.equal(archiveEnabled(), false);
    const a = new TickArchive();
    a.add('{"messageType":"A"}', 1);
    assert.equal(a.counters.buffered, 0);
  });

  it("TIINGO_RT_ARCHIVE=off disables it even with a bucket present", () => {
    process.env.TIINGO_RT_ARCHIVE = "off";
    assert.equal(archiveEnabled(), false);
  });

  it("the buffer is BOUNDED, dropping the oldest", () => {
    // An unbounded buffer turns a GCS outage into an OOM on the one process
    // holding the socket — trading the live feed for a re-derivation window,
    // which is exactly the wrong way round. The newest ticks are kept because
    // they are the ones a rebuild is most likely to need.
    const a = new TickArchive();
    for (let i = 0; i < MAX_BUFFERED_LINES + 25; i++) a.add(`{"n":${i}}`, i);
    assert.equal(a.counters.buffered, MAX_BUFFERED_LINES);
    assert.equal(a.counters.droppedOverflow, 25);
  });

  it("does not flush before its cadence, and never flushes an empty buffer", () => {
    const a = new TickArchive();
    assert.equal(a.dueForFlush(Date.now()), false, "empty buffer must never flush");
    a.add('{"messageType":"A"}', 1);
    assert.equal(a.dueForFlush(0), false, "must not flush before the cadence elapses");
    assert.equal(a.dueForFlush(ARCHIVE_FLUSH_MS + 1), true);
  });

  it("a failed flush drops the batch rather than growing a retry queue", async () => {
    // No bucket credentials here, so the upload throws. The buffer must come
    // back EMPTY: re-buffering would grow during exactly the outage it is
    // meant to survive, and the bars for these ticks are already written.
    const a = new TickArchive();
    a.add('{"messageType":"A"}', 1);
    await a.flush(Date.now());
    assert.equal(a.counters.buffered, 0, "the batch must not be re-buffered");
    assert.equal(a.counters.flushFailures, 1, "the failure must be counted, not swallowed");
    assert.equal(a.counters.objectsWritten, 0);
  });

  it("frames arriving DURING a flush belong to the next object", async () => {
    // The buffer is taken before the await, not cleared after — clearing
    // afterwards would silently discard whatever arrived in between.
    const a = new TickArchive();
    a.add('{"n":1}', 1);
    const flushing = a.flush(Date.now());
    a.add('{"n":2}', 2);
    await flushing;
    assert.equal(a.counters.buffered, 1, "the frame that arrived mid-flush must survive");
  });
});
