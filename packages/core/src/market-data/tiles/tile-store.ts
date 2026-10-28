/**
 * The tile store PORT. MONEY-1467 (data-platform A2).
 *
 * Core owns the interface; the builder job registers a GCS adapter. Same
 * arrangement as `candles/candle-cold-store.ts`, and for the same reason: this
 * package must not depend on `@usemoney/storage`, or every consumer of
 * `@usemoney/core` — including `apps/web` — pulls a GCS client into its bundle.
 *
 * ## TILES ARE NOT PUBLIC OBJECTS
 *
 * The adapter MUST register with `isPublic: false`. `uploadFile` defaults to
 * `isPublic: true`, and a public upload resolves to a `storage.googleapis.com`
 * URL that anyone can read — for price history that is the whole warehouse
 * handed over for free, and nothing about it looks wrong from the inside.
 * Tiles are served THROUGH `apps/market-data`, which is what applies the CDN
 * policy, the CORS allowlist and (from A5) the token check.
 *
 * ## THE READ NEVER LISTS
 *
 * Inherited from the cold store, and it is the rule that matters most here.
 * `listFiles` FAILS OPEN to `[]`, so an empty listing is indistinguishable from
 * a credentials blip — and a reader that decided "which years exist" from a
 * listing would return a silently truncated price series on every transient
 * error. So the reader computes the candidate year keys from the requested
 * range and `get`s each one, because `get` can be trusted in both directions:
 * `null` is a genuine 404, and anything else throws.
 */

/**
 * The port.
 *
 * `cacheControl` is here and absent from `CandleColdStore` deliberately: a cold
 * candle shard is read by our own job, while a tile is read by the market-data
 * service and handed to a CDN. The header has to be decided by the writer that
 * knows whether the object is immutable (a closed year) or rebuilt nightly
 * (the 5y), and that is this call site.
 */
export interface TileStore {
  /** Bytes at `key`, or `null` when the object genuinely does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** Persist bytes at `key`. May throw. */
  put(
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl: string,
  ): Promise<void>;
}

/**
 * `Cache-Control` for a CLOSED year tile.
 *
 * Immutable by construction — a closed year's bars only change if an adjustment
 * changes, and that rewrites the object under a new `built_at` after a manifest
 * decision. `immutable` tells the CDN it never needs to revalidate.
 */
export const YEAR_TILE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * `Cache-Control` for the 5y tile.
 *
 * NOT immutable: it is rebuilt nightly and its last bar moves every session.
 * One hour with a day of stale-while-revalidate, so a CDN keeps serving through
 * a builder outage rather than falling through to the origin for every chart.
 */
export const FIVE_Y_TILE_CACHE_CONTROL =
  "public, max-age=3600, stale-while-revalidate=86400";

/** The manifest is read by the BUILDER, not by the edge. */
export const MANIFEST_CACHE_CONTROL = "no-store";

export const TILE_CONTENT_TYPE = "application/json";

let store: TileStore | null = null;

/**
 * Register (or clear, with `null`) the backend.
 *
 * Without a registration the reader simply has no tiles — it does NOT error.
 * That is the correct default for local dev and for any environment before the
 * builder has run, and it is what lets `apps/web` import `@usemoney/core`
 * without ever touching GCS.
 */
export function setTileStore(next: TileStore | null): void {
  store = next;
}

/** The registered store, or null. Exported for assertions in tests. */
export function getTileStore(): TileStore | null {
  return store;
}

/**
 * Three outcomes, not two.
 *
 * `absent` and `failed` are different facts and the caller must be able to tell
 * them apart: an absent year tile is a listing that did not trade that year (or
 * has not been built yet) and is normal; a FAILED read is an outage, and
 * treating it as absence is how a chart quietly loses a decade of history and
 * reports nothing. The candle cold store draws the same distinction for the
 * same reason.
 */
export type TileReadOutcome =
  | { status: "present"; body: Buffer }
  | { status: "absent" }
  | { status: "failed"; error: Error };

/** Read one tile, never throwing — the outcome carries the distinction. */
export async function readTile(key: string): Promise<TileReadOutcome> {
  const backend = store;
  if (!backend) return { status: "absent" };
  try {
    const body = await backend.get(key);
    return body === null ? { status: "absent" } : { status: "present", body };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
