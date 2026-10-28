/**
 * GCS-backed implementation of core's feed-archive port — MONEY-1085.
 *
 * `@usemoney/storage` depends on `@usemoney/core`, so core cannot import it.
 * Core owns the port + decision logic (`market-data/feed-archive.ts`); this
 * module supplies the GCS half and registers it, which is why the adapter lives
 * in the worker rather than in core.
 *
 * The archive is written to the PRIVATE content bucket (`GCP_STORAGE_BUCKET`) —
 * `isPublic: false`. These are public exchange files, but there is no reason to
 * serve them from our infrastructure, and a public object would need the public
 * bucket + a URL nobody consumes.
 */

import { downloadFile, uploadFile } from "@usemoney/storage";
import {
  type FeedArchiveStore,
  FEED_ARCHIVE_WRITE_TIMEOUT_MS,
  resolveFeedArchiveMode,
  setFeedArchiveStore,
} from "@usemoney/core/market-data";
// Local console shim, matching the ingest processors (bhavcopy-sync et al.).
// `@usemoney/logger`'s getLogger() is keyed to a fixed LoggerModule union that
// has no entry for this module.
const log = {
  info: (...a: unknown[]) => console.log("[feed-archive]", ...a),
  warn: (...a: unknown[]) => console.warn("[feed-archive]", ...a),
};

const gcsFeedArchiveStore: FeedArchiveStore = {
  async get(key: string): Promise<Buffer | null> {
    // downloadFile already maps a 404 to null; anything else propagates and is
    // caught by core, which then falls back to the exchange.
    return downloadFile(key);
  },

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    // `folder` + `fileName` are concatenated by uploadFile, so split the key on
    // its last segment to preserve the full `feeds/...` path.
    const idx = key.lastIndexOf("/");
    const folder = idx === -1 ? undefined : key.slice(0, idx);
    const fileName = idx === -1 ? key : key.slice(idx + 1);

    await uploadFile({
      file: body,
      fileName,
      contentType,
      ...(folder ? { folder } : {}),
      isPublic: false,
      // MONEY-1157. Core already refuses to WAIT longer than this, but without
      // a request-level timeout the SDK would keep retrying the abandoned
      // upload in the background (its defaults are totalTimeout 600s /
      // maxRetries 3) inside a handler whose Pub/Sub ack deadline is also 600s.
      // Bounding both means a slow GCS costs us the archive copy and nothing
      // else.
      timeoutMs: FEED_ARCHIVE_WRITE_TIMEOUT_MS,
    });
  },
};

/**
 * Register the GCS archive store when a mode is configured.
 *
 * Called once at worker startup. A no-op when `FEED_ARCHIVE_MODE` is unset, so
 * local dev and any env that hasn't opted in keeps hitting the exchanges
 * directly — identical to pre-MONEY-1085 behaviour.
 */
export function initFeedArchive(): void {
  const mode = resolveFeedArchiveMode();
  if (mode === "off") {
    log.info("Feed archive disabled (FEED_ARCHIVE_MODE unset)");
    return;
  }

  if (!process.env.GCP_STORAGE_BUCKET) {
    log.warn(
      `FEED_ARCHIVE_MODE=${mode} but GCP_STORAGE_BUCKET is unset — feed archive stays OFF`,
    );
    return;
  }

  setFeedArchiveStore(gcsFeedArchiveStore);
  log.info(`Feed archive enabled: mode=${mode}`);
}
