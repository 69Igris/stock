/**
 * GCS-backed implementation of core's candle cold-store port — MONEY-980 C5.
 *
 * `@usemoney/storage` depends on `@usemoney/core`, so core cannot import it.
 * Core owns the port and every decision made around it
 * (`market-data/candles/candle-cold-store.ts`); this module supplies the GCS
 * half and registers it, which is why the adapter lives in the worker rather
 * than in core. It is the same arrangement as `feed-archive-store.ts`, reused
 * rather than reinvented.
 *
 * ## WHY THIS FILE EXISTS AT ALL
 *
 * `setCandleColdStore()` had ZERO callers outside tests. `writeColdShard` throws
 * "no cold store registered" without one and `readColdShard` answers `absent`
 * for every key, so the whole cold tier — defined, exported, documented — had
 * never executed in any runtime. That is the shape this repo pays for over and
 * over: a mechanism that compiles, reads as finished, and is wired to nothing
 * (MONEY-1214 disabled a job for months by an env var that was merely absent).
 *
 * ## The three traps, each of which has already cost a bug
 *
 *   1. `uploadFile` DEFAULTS `isPublic: true`, and a public upload resolves
 *      `GCP_PUBLIC_STORAGE_BUCKET` — a different bucket from
 *      `GCP_STORAGE_BUCKET`. `isPublic: false` is mandatory here and is not a
 *      preference: these are licensed price series on a plan whose licence is
 *      INTERNAL USE ONLY, and a public object is a redistribution act.
 *      MONEY-865 is the record of what happens when the wrong bucket answers.
 *   2. `uploadFile` takes `(folder, fileName)` and CONCATENATES them, so a key
 *      handed over whole would land at the bucket root as a single object named
 *      `candles/US/D1/AAPL/2014`. Split on the LAST `/`.
 *   3. `downloadFile` maps a 404 to `null` and rethrows everything else. That
 *      distinction is the entire contract of the port: `null` is an ANSWER
 *      ("this year is genuinely not archived") and a throw is the ABSENCE of
 *      one. Swallowing the throw would collapse `failed` into `absent`, which
 *      is why `apps/web` must NOT register this store — its own `downloadFile`
 *      wrapper returns `null` on error.
 *
 * There is deliberately NO `list`. The port omits it because `listFiles` in
 * `@usemoney/storage` FAILS OPEN to `[]` on an auth or network failure
 * (MONEY-941), so a listing-driven read would report "this security has no
 * history" for a credentials problem. The read computes candidate year keys
 * from the requested range and `get`s each one.
 */

import { downloadFile, uploadFile } from "@usemoney/storage";
import {
  CANDLE_COLD_TIMEOUT_MS,
  getCandleColdStore,
  setCandleColdStore,
  type CandleColdStore,
} from "@usemoney/core/market-data/candles";

// Local console shim, matching feed-archive-store.ts and the ingest processors.
// `@usemoney/logger`'s getLogger() is keyed to a fixed LoggerModule union with
// no entry for this module.
const log = {
  info: (...a: unknown[]) => console.log("[candles-cold]", ...a),
  warn: (...a: unknown[]) => console.warn("[candles-cold]", ...a),
};

const gcsCandleColdStore: CandleColdStore = {
  async get(key: string): Promise<Buffer | null> {
    // Already maps 404 -> null and rethrows everything else, which is exactly
    // the two-way answer the port requires. Nothing is caught here: a swallowed
    // error would become an absent year, and an absent year is indistinguishable
    // from a shorter chart.
    return downloadFile(key);
  },

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    // `folder` + `fileName` are concatenated by uploadFile, so split the key on
    // its last segment to preserve the full `candles/...` path.
    const idx = key.lastIndexOf("/");
    const folder = idx === -1 ? undefined : key.slice(0, idx);
    const fileName = idx === -1 ? key : key.slice(idx + 1);

    await uploadFile({
      file: body,
      fileName,
      contentType,
      ...(folder ? { folder } : {}),
      // MANDATORY. See trap 1 in the header — the default is `true`, and `true`
      // resolves a different bucket.
      isPublic: false,
      // MONEY-1157. Core already refuses to WAIT longer than this, but without a
      // request-level timeout the SDK would keep retrying the abandoned upload
      // in the background (defaults: totalTimeout 600s / maxRetries 3) inside a
      // handler whose Pub/Sub ack deadline is also 600s. Bounding both means a
      // slow GCS costs us one shard and not the run.
      timeoutMs: CANDLE_COLD_TIMEOUT_MS,
    });
  },
};

/**
 * Register the GCS cold store. Called once at worker startup.
 *
 * ## Why the bucket check is a hard gate and not a warning-and-continue
 *
 * `feed-archive-store.ts` has the same guard for a feed archive, where a miss
 * costs one extra scrape. Here the consequence is different in kind: with no
 * store registered, `writeColdShard` THROWS, and the backfill has been built to
 * fail closed on that rather than walk 72,685 symbols archiving nothing. Both
 * halves of that arrangement are deliberate — this returns `false` so a caller
 * can act on it, and the throw downstream is what stops a silent no-op run.
 *
 * Idempotent: `setCandleColdStore` re-resolves its options on every call, so a
 * second registration (a script that also calls this after the worker boot has)
 * is harmless.
 *
 * @returns whether a store is registered after this call.
 */
export function initCandleColdStore(): boolean {
  if (!process.env.GCP_STORAGE_BUCKET) {
    log.warn(
      "GCP_STORAGE_BUCKET is unset — the candle cold store stays OFF. " +
        "Reads answer `absent` for every year and writeColdShard() THROWS; " +
        "a backfill must fail closed rather than archive nothing.",
    );
    return getCandleColdStore() !== null;
  }

  setCandleColdStore(gcsCandleColdStore);
  log.info(
    `Candle cold store enabled: bucket=${process.env.GCP_STORAGE_BUCKET} ` +
      `timeout=${CANDLE_COLD_TIMEOUT_MS}ms`,
  );
  return true;
}
