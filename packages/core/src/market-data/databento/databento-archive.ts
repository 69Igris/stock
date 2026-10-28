/**
 * The raw-archive PORT for Databento downloads — MONEY-1373.
 *
 * ## Why a port and not a direct GCS call
 *
 * `@usemoney/storage` depends on `@usemoney/core`, so core CANNOT import it —
 * that is a cycle. Core therefore owns the port and every decision made around
 * it; the worker registers a GCS-backed adapter at startup. Exactly the
 * arrangement `candle-cold-store.ts` and `feed-archive.ts` use, reused rather
 * than reinvented so a unit test can inject a fake and nothing here needs GCP.
 *
 * ## Where the bytes go, and why it is NOT under `feeds/`
 *
 * `databento/{dataset}/{schema}/{yyyy}/{jobId}/{filename}`.
 *
 * The prod→QA mirror rsyncs the WHOLE `feeds/` prefix twice daily. This harvest
 * is hundreds of gigabytes and QA receives it as ROWS — `candles` is a
 * REFERENCE_COLLECTION and reaches QA by mongorestore — so mirroring the bytes
 * would copy a warehouse to an environment that already has the answer. `edgar/`
 * sits outside `feeds/` for the same reason and at the same scale, and this
 * prefix follows it deliberately rather than by coincidence.
 *
 * ## The archive is NEVER deleted
 *
 * Its lifecycle rule is a Nearline transition at 30 days and nothing else. A
 * re-derivation must never cost a second purchase: if the loader is later found
 * wrong, the fix is a re-load from these bytes, and a Delete rule would turn
 * that into a re-buy of a Standard month. `scripts/ops/setup-gcs-lifecycle.sh`
 * refuses a Delete rule whose prefix would sweep a protected root, and
 * `databento/` is on that list.
 *
 * ## Streams, not Buffers
 *
 * A single harvest file runs to hundreds of megabytes and the job holds one in
 * flight per slot. `put` takes a `Readable` and `getStream` returns one, so
 * nothing on the archive path ever materialises a whole object — the
 * MONEY-1337 lesson, where a converter that buffered whole objects died twice
 * on "The configured memory limit was reached".
 */

import type { Readable } from "node:stream";

/** Storage port. Implemented by the worker over GCS; faked in tests. */
export interface DatabentoArchiveStore {
  /** Persist `body` at `key`. May throw. Returns the byte count written. */
  put(
    key: string,
    body: Readable,
    contentType: string,
  ): Promise<{ bytes: number }>;
  /** A read stream for `key`, or `null` when the object genuinely is absent. */
  getStream(key: string): Promise<Readable | null>;
  /** Whether `key` exists. */
  exists(key: string): Promise<boolean>;
  /** Remove `key`. Used ONLY to clean up a failed (checksum-mismatched) write. */
  delete(key: string): Promise<void>;
}

/** The one prefix this store owns. Asserted by the deploy-contract test. */
export const DATABENTO_ARCHIVE_PREFIX = "databento/";

/**
 * Content type by extension.
 *
 * `application/zstd` is the registered type (RFC 8878). It matters beyond
 * tidiness: `gcloud storage cp` and the console decide whether to attempt a
 * decompressive transcode from it, and a `.csv.zst` served as `text/csv` is an
 * object whose bytes change under a reader that did not ask for that.
 */
export function databentoContentType(filename: string): string {
  if (filename.endsWith(".csv.zst")) return "application/zstd";
  if (filename.endsWith(".zst")) return "application/zstd";
  if (filename.endsWith(".json")) return "application/json";
  if (filename.endsWith(".csv")) return "text/csv";
  return "application/octet-stream";
}

let store: DatabentoArchiveStore | null = null;

/**
 * Register (or clear, with `null`) the archive backend.
 *
 * Without a registration the client REFUSES to download rather than fetching
 * into nowhere — see `downloadToArchive`. That is the opposite of the feed
 * archive's posture, and deliberately: a missed feed archive costs one extra
 * scrape of a free public file, while a Databento download that lands nowhere
 * has spent metered money and produced nothing, and the run would report
 * success. The BSE job is the record of what that looks like (59 rows with an
 * empty `gcsPath`, MONEY-1258).
 */
export function setDatabentoArchiveStore(
  next: DatabentoArchiveStore | null,
): void {
  store = next;
}

/** The registered store, or null. */
export function getDatabentoArchiveStore(): DatabentoArchiveStore | null {
  return store;
}
