/**
 * The GCS adapter for the Databento raw archive — MONEY-1373.
 *
 * Core owns the PORT (`@usemoney/core/market-data/databento/databento-archive`)
 * and every decision around it; this registers a GCS-backed implementation at
 * worker/job startup. Same arrangement as `candle-cold-store-gcs.ts` and
 * `feed-archive-store.ts`, and reused rather than reinvented: core cannot
 * import `@usemoney/storage` (that package depends on core, so it would be a
 * cycle), and a port is what lets a unit test inject a fake.
 *
 * The three traps `candle-cold-store-gcs.ts` documents apply here too, and two
 * of them are avoided by construction rather than by remembering:
 *
 *   - `uploadStream` is ALWAYS private and has no `isPublic` parameter, so the
 *     MONEY-865 wrong-bucket trap (a public upload resolves
 *     `GCP_PUBLIC_STORAGE_BUCKET`) cannot be reached from here at all.
 *   - `downloadStream` maps a missing object to `null` and rethrows everything
 *     else, so a credentials failure can never be read as an empty archive.
 *   - The key is passed whole; `uploadStream` splits it, so the `folder` +
 *     `fileName` concatenation happens in one place.
 */

import {
  deleteFile,
  downloadStream,
  fileExists,
  uploadStream,
} from "@usemoney/storage";
import {
  getDatabentoArchiveStore,
  setDatabentoArchiveStore,
  type DatabentoArchiveStore,
} from "@usemoney/core/market-data/databento/databento-archive";
import type { Readable } from "node:stream";

const log = {
  info: (...a: unknown[]) => console.log("[databento-archive]", ...a),
  warn: (...a: unknown[]) => console.warn("[databento-archive]", ...a),
};

/**
 * How long a single object transfer may take.
 *
 * These are the largest objects this repo moves — a harvest file runs to
 * hundreds of megabytes — so the bound is generous where the cold-shard store's
 * is tight. It exists at all for the reason that store gives: without a
 * request-level timeout the SDK keeps retrying an abandoned transfer in the
 * background (defaults: totalTimeout 600s, maxRetries 3), and these jobs have a
 * task budget to respect even though they are not behind a Pub/Sub ack
 * deadline.
 */
export const DATABENTO_ARCHIVE_TIMEOUT_MS = 15 * 60_000;

const gcsDatabentoArchiveStore: DatabentoArchiveStore = {
  async put(key: string, body: Readable, contentType: string) {
    const idx = key.lastIndexOf("/");
    await uploadStream({
      fileName: idx === -1 ? key : key.slice(idx + 1),
      ...(idx === -1 ? {} : { folder: key.slice(0, idx) }),
      contentType,
      body,
      timeoutMs: DATABENTO_ARCHIVE_TIMEOUT_MS,
    });
    // The byte count is the CALLER's — it hashes the stream on the way past and
    // knows exactly how many bytes it saw. Reporting a second, independently
    // derived number here would be a second source of truth for one fact.
    return { bytes: 0 };
  },

  async getStream(key: string) {
    return (await downloadStream(key)) as Readable | null;
  },

  async exists(key: string) {
    return fileExists(key);
  },

  async delete(key: string) {
    await deleteFile(key);
  },
};

/**
 * Register the archive backend. Called once at job startup.
 *
 * ## Why the missing-bucket case is a HARD failure downstream
 *
 * `feed-archive-store.ts` warns and continues, because a missed feed archive
 * costs one extra scrape of a free public file. Here the consequence differs in
 * kind: a Databento download that lands nowhere has spent metered money and
 * produced nothing, and the run would report success. `bse-backfill` is the
 * written record of what that looks like — 59 rows stored with an empty
 * `gcsPath` (MONEY-1258).
 *
 * So this returns `false` and the job REFUSES to `--apply` on it, the same
 * fail-closed arrangement `initCandleColdStore` has with the Tiingo backfill.
 *
 * @returns whether a store is registered after this call.
 */
export function initDatabentoArchiveStore(): boolean {
  if (!process.env.GCP_STORAGE_BUCKET) {
    log.warn(
      "GCP_STORAGE_BUCKET is unset — the Databento archive stays OFF. A " +
        "download would spend metered money and store nothing, so the jobs " +
        "refuse to apply without it.",
    );
    return getDatabentoArchiveStore() !== null;
  }
  setDatabentoArchiveStore(gcsDatabentoArchiveStore);
  log.info(
    `enabled: bucket=${process.env.GCP_STORAGE_BUCKET} ` +
      `timeout=${DATABENTO_ARCHIVE_TIMEOUT_MS}ms`,
  );
  return true;
}
