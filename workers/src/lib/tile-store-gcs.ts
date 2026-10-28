/**
 * The GCS adapter for the D1 tile store. MONEY-1467 (A2).
 *
 * Core owns the port (`@usemoney/core/market-data/tiles/tile-store`); this
 * registers the only implementation. Mirrors `candle-cold-store-gcs.ts`, with
 * ONE difference that matters more than it looks:
 *
 * ## TILES LIVE IN THE LAKE BUCKET, NOT THE CONTENT BUCKET
 *
 * `docs/reference/lake-layout.md` routes the `tiles/` prefix to
 * `stockbook-lake-{env}`, and `bucketForPrefix` is the machine-checked
 * statement of that. Every other GCS caller in this repo writes to
 * `GCP_STORAGE_BUCKET`, which is the CONTENT bucket — so both halves take an
 * explicit `bucketName` here.
 *
 * Getting that wrong is silent in the worst way: the builder would write
 * thousands of objects into the content bucket (which succeeds — it has write
 * access), the reader would 404 every key, and `/udf/history` would report an
 * empty lake. That is indistinguishable from "the nightly build has not run
 * yet", so it would be diagnosed as a scheduling problem for as long as anyone
 * cared to look.
 *
 * ## isPublic: false IS MANDATORY
 *
 * `uploadFile` defaults `isPublic: true`, and a public upload resolves a
 * DIFFERENT bucket and a `storage.googleapis.com` URL anyone can read. For a
 * price warehouse that is the whole asset handed over for free, and nothing
 * about it looks wrong from the inside. Tiles are served through
 * `apps/market-data`, which is what applies the CDN policy and (from A5) the
 * token check.
 */

import { downloadFile, uploadFile } from "@usemoney/storage";
import {
  getTileStore,
  setTileStore,
  type TileStore,
} from "@usemoney/core/market-data/tiles/tile-store";

// Local console shim, matching candle-cold-store-gcs.ts: `@usemoney/logger`'s
// getLogger() is keyed to a fixed LoggerModule union with no entry for this.
const log = {
  info: (...a: unknown[]) => console.log("[tiles]", ...a),
  warn: (...a: unknown[]) => console.warn("[tiles]", ...a),
};

/**
 * The lake bucket for an environment.
 *
 * Deliberately derived from `LAKE_ENV` (or `DD_ENV`) rather than read from a
 * bucket-name variable of its own: a second env var naming the same bucket is
 * a second thing to get wrong, and the lake contract already states the
 * naming. `bucketForPrefix` is the authority — this must agree with it.
 */
export function lakeBucketName(): string | null {
  const env = (process.env.LAKE_ENV || process.env.DD_ENV || "").toLowerCase();
  if (env === "prod" || env === "production") return "stockbook-lake-prod";
  if (env === "qa") return "stockbook-lake-qa";
  return null;
}

function makeStore(bucketName: string): TileStore {
  return {
    async get(key: string): Promise<Buffer | null> {
      // `downloadFile` maps a 404 to null and rethrows everything else, which
      // is exactly the two-way answer the port requires. Nothing is caught
      // here: a swallowed error becomes an absent tile, and an absent tile is
      // indistinguishable from a shorter chart.
      return downloadFile(key, { bucketName });
    },

    async put(
      key: string,
      body: Buffer,
      contentType: string,
      cacheControl: string,
    ): Promise<void> {
      // `folder` + `fileName` are concatenated by uploadFile, so split on the
      // LAST separator to preserve the full `tiles/...` path.
      const idx = key.lastIndexOf("/");
      const folder = idx === -1 ? undefined : key.slice(0, idx);
      const fileName = idx === -1 ? key : key.slice(idx + 1);

      await uploadFile({
        file: body,
        fileName,
        contentType,
        ...(folder ? { folder } : {}),
        bucketName,
        // MANDATORY — see the header. The default is `true`.
        isPublic: false,
        cacheControl,
      });
    },
  };
}

/**
 * Register the GCS tile store. Called once at job startup.
 *
 * Returns whether a store is registered afterwards, so the caller can fail
 * CLOSED. A build that runs with no store does not error per tile — the port's
 * reader answers `absent` — so it would walk every listing, "succeed", and
 * write nothing. The job refuses to start instead.
 */
export function initTileStore(): boolean {
  const bucketName = lakeBucketName();
  if (!bucketName) {
    log.warn(
      "LAKE_ENV/DD_ENV is neither qa nor prod — the tile store stays OFF. " +
        "Reads answer `absent` for every key and no tile is ever written, so a " +
        "build would walk every listing and report success having stored nothing.",
    );
    return getTileStore() !== null;
  }
  setTileStore(makeStore(bucketName));
  log.info(`Tile store enabled: bucket=${bucketName}`);
  return true;
}
