/**
 * The raw-tick archive — `feeds/TIINGO/ws/{date}/`.
 *
 * ## Why this file had to be written
 *
 * The prefix was described in the present tense in FIVE places — CLAUDE.md
 * ("RAW TICKS land at…"), the GCS lifecycle policy ("written as JSONL by the
 * always-on `tiingo-realtime-{env}` service"), the prod->QA rsync exclusion,
 * `scripts/README.md`, and the sink's own `toArchiveLine` — and NOTHING wrote
 * to it. `toArchiveLine` had zero callers. A lifecycle rule over an empty
 * prefix deletes nothing, so the whole arrangement was self-consistent and
 * inert, and the two agreement tests pinned the two CONFIG strings to each
 * other with no third anchor to a writer.
 *
 * ## What it is FOR, which decides its shape
 *
 * The lifecycle rule calls it "a re-derivation window, not an archive", and
 * deletes at 30 days. That is the whole design brief: if the aggregator is ever
 * found to be wrong, the last 30 days of bars can be rebuilt from the bytes the
 * feed actually sent, instead of being permanently wrong. It is NOT a record we
 * promise to keep, and nothing reads it on a request path.
 *
 * That is also why a dropped batch is a WARNING and not a failure. Losing a
 * minute of re-derivation material costs a hypothetical future rebuild some
 * coverage; failing the flush would cost live quotes. The bars themselves are
 * already written by `candle-sink.ts` on the same tick.
 *
 * ## Why buffered, and why one object per minute
 *
 * GCS has no append. Writing per frame would be one object per tick; writing on
 * the 5s flush cadence would be 720 objects an hour. One object per wall-clock
 * minute is 1,440 a day, gzipped, which is a shape the bucket and the mirror
 * both handle without thought.
 *
 * The buffer is BOUNDED. An archive that grows without limit when GCS is
 * unreachable would turn a storage outage into an OOM on the one process
 * holding the socket — trading a degraded nice-to-have for the live feed, which
 * is exactly the wrong way round.
 */

import { gzipSync } from "node:zlib";
import { uploadFile } from "@usemoney/storage";
import { toArchiveLine } from "@usemoney/core/market-data/tiingo/tiingo-rt-sink-logic";

/** The prefix. Must match the lifecycle rule and the rsync exclusion exactly. */
export const TICK_ARCHIVE_PREFIX = "feeds/TIINGO/ws";

/** One object per wall-clock minute. */
export const ARCHIVE_FLUSH_MS = 60_000;

/**
 * Hard ceiling on buffered lines.
 *
 * At the documented cap of 3,000 symbols a busy minute is well under this;
 * reaching it means flushes are failing, and dropping the oldest is the right
 * trade because the newest ticks are the ones a re-derivation is most likely to
 * need. Sized so the buffer cannot outgrow a small container: ~200 bytes a line
 * puts the ceiling near 40 MB.
 */
export const MAX_BUFFERED_LINES = 200_000;

export interface TickArchiveCounters {
  buffered: number;
  linesWritten: number;
  objectsWritten: number;
  droppedOverflow: number;
  flushFailures: number;
}

export function emptyTickArchiveCounters(): TickArchiveCounters {
  return {
    buffered: 0,
    linesWritten: 0,
    objectsWritten: 0,
    droppedOverflow: 0,
    flushFailures: 0,
  };
}

/**
 * Is the archive configured at all?
 *
 * UNSET is a legitimate state — local development, and any environment that has
 * not been given a bucket. It must be a silent no-op rather than an error,
 * exactly as `FEED_ARCHIVE_MODE` unset means "passthrough" elsewhere in this
 * repo.
 */
export function archiveEnabled(): boolean {
  return (
    process.env.TIINGO_RT_ARCHIVE !== "off" &&
    Boolean(process.env.GCP_STORAGE_BUCKET)
  );
}

/**
 * `feeds/TIINGO/ws/2026-09-01/14/2026-09-01T14-07-00Z-<pid>.jsonl.gz`
 *
 * Date and hour are separate path segments so a re-derivation can list one hour
 * without scanning a day, and the pid suffix keeps two overlapping revisions
 * from overwriting each other during a deploy — the same window the leader lock
 * exists for, where both processes are briefly alive.
 */
export function archiveKey(atMs: number, pid: number): string {
  const iso = new Date(atMs).toISOString();
  const date = iso.slice(0, 10);
  const hour = iso.slice(11, 13);
  const stamp = iso.slice(0, 19).replace(/:/g, "-");
  return `${TICK_ARCHIVE_PREFIX}/${date}/${hour}/${stamp}Z-${pid}.jsonl.gz`;
}

export class TickArchive {
  private buffer: string[] = [];
  private lastFlushMs = 0;

  constructor(readonly counters: TickArchiveCounters = emptyTickArchiveCounters()) {}

  /** Record one raw frame. Cheap and synchronous — this is on the tick path. */
  add(raw: string, receivedAtMs: number): void {
    if (!archiveEnabled()) return;
    if (this.buffer.length >= MAX_BUFFERED_LINES) {
      // Drop the OLDEST. See MAX_BUFFERED_LINES: the newest ticks are the ones
      // a re-derivation needs, and an unbounded buffer would take the socket
      // down to protect a re-derivation window.
      this.buffer.shift();
      this.counters.droppedOverflow++;
    }
    this.buffer.push(toArchiveLine({ receivedAtMs, raw }));
    this.counters.buffered = this.buffer.length;
  }

  dueForFlush(nowMs: number): boolean {
    if (this.buffer.length === 0) return false;
    return nowMs - this.lastFlushMs >= ARCHIVE_FLUSH_MS;
  }

  /**
   * Write the buffer to one gzipped object. Never throws.
   *
   * The buffer is TAKEN before the await, not after: an `add` arriving during
   * the upload belongs to the next object, and clearing afterwards would
   * silently discard it.
   */
  async flush(nowMs: number): Promise<void> {
    if (this.buffer.length === 0 || !archiveEnabled()) return;
    const batch = this.buffer;
    this.buffer = [];
    this.lastFlushMs = nowMs;
    this.counters.buffered = 0;

    try {
      const body = gzipSync(Buffer.from(batch.join("\n") + "\n", "utf8"));
      await uploadFile({
        file: body,
        fileName: archiveKey(nowMs, process.pid),
        contentType: "application/gzip",
        // PRIVATE. These are raw vendor bytes under a licence that permits
        // internal use only — a public object would be redistribution.
        isPublic: false,
      });
      this.counters.linesWritten += batch.length;
      this.counters.objectsWritten++;
    } catch (err) {
      // Deliberately NOT re-buffered. A retry queue here would grow during
      // exactly the outage it is meant to survive, and this is a
      // re-derivation window rather than a record we promise to keep — the
      // bars for these ticks are already written.
      this.counters.flushFailures++;
      console.warn(
        `[tiingo-rt] tick archive flush failed, dropping ${batch.length} line(s): ${String(err)}`,
      );
    }
  }
}
