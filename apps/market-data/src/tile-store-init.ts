/**
 * Register the GCS tile store for the SERVICE. MONEY-1467 (A2).
 *
 * ## WHY THIS FILE EXISTS AT ALL
 *
 * Without it `/udf/history` answers `{s:"no_data"}` for every symbol, in
 * production, forever — and nothing anywhere reports a problem.
 *
 * `readTile` returns `{status:"absent"}` when no backend is registered, which
 * is the correct default (local dev, and any environment before the first
 * build). The reader then takes its empty-bars path and emits `no_data`, which
 * TradingView draws as a blank chart with no message — indistinguishable from a
 * delisted instrument. The route's own header is written against exactly that
 * failure and the service still shipped with no store: the builder job
 * registered one, the SERVICE did not, and `history.test.ts` passed because the
 * test calls `setTileStore` itself.
 *
 * A test that supplies the very dependency production is missing cannot see
 * that production is missing it. `tile-store-wired.test.ts` asserts the call
 * exists on the real boot path instead.
 *
 * ## IT READS ONLY
 *
 * The service is a reader. `put` throws rather than silently succeeding: a
 * request path that could write to the lake is a request path that can corrupt
 * it, and nothing in this service has any reason to.
 */
import { downloadFile } from "@usemoney/storage";
import {
  setTileStore,
  type TileStore,
} from "@usemoney/core/market-data/tiles/tile-store";

/**
 * The lake bucket for an environment.
 *
 * `LAKE_ENV` FIRST, then `DD_ENV`. Both, in that order, for two reasons:
 *
 *   - IT WAS ALREADY THE DOCUMENTED CONTRACT AND THE CODE DID NOT HONOUR IT.
 *     `setup-tile-build-job.sh` says "LAKE_ENV is what `initTileStore()` reads
 *     to pick the lake" and `tile-build-d1.ts` refuses with "LAKE_ENV/DD_ENV
 *     must be qa or prod" — while this function read DD_ENV alone. The jobs
 *     happen to set BOTH, so it worked by coincidence; anything setting only
 *     LAKE_ENV got a silently disabled tile store, which is a blank chart.
 *   - IT LETS LOCAL DEV POINT AT A LAKE WITHOUT LYING ABOUT THE ENVIRONMENT.
 *     DD_ENV is a Datadog TAG: setting `DD_ENV=qa` on a laptop to get tiles
 *     files every local trace, span and metric under qa. `LAKE_ENV=qa` says the
 *     one thing meant — which bucket to read — and leaves telemetry honest.
 *
 * Must agree with `bucketForPrefix`, which is the authority on naming.
 *
 * NOTE `production`, not `prod`: that is the tag every Datadog monitor filters
 * on and the value the specs set. Accepting both is deliberate belt-and-braces
 * — resolving to `null` here would silently disable the reader.
 */
export function lakeBucketName(
  env = process.env.LAKE_ENV ?? process.env.DD_ENV,
): string | null {
  const e = (env ?? "").toLowerCase();
  if (e === "production" || e === "prod") return "stockbook-lake-prod";
  if (e === "qa") return "stockbook-lake-qa";
  return null;
}

export function initTileStore(): boolean {
  const bucketName = lakeBucketName();
  if (!bucketName) {
    // NAMED, not silent. This is the state in which every chart is blank.
    console.warn(
      "[market-data] neither LAKE_ENV nor DD_ENV is qa/production — the tile store is OFF, " +
        "so /udf/history will answer no_data for EVERY symbol. That renders as a " +
        "blank chart with no error.",
    );
    return false;
  }

  const store: TileStore = {
    async get(key: string): Promise<Buffer | null> {
      // Maps 404 -> null and rethrows everything else, which is the two-way
      // answer the port requires. Nothing is caught here: a swallowed error
      // becomes an absent tile, and an absent tile is a shorter chart.
      return downloadFile(key, { bucketName });
    },
    async put(): Promise<void> {
      throw new Error(
        "the market-data service is READ-ONLY; tiles are written by tile-build-d1",
      );
    },
  };

  setTileStore(store);
  console.log(`[market-data] tile store enabled: bucket=${bucketName}`);
  return true;
}
