/**
 * GCS-backed implementation of core's 13F cold-store port — MONEY-979.
 *
 * `@usemoney/storage` depends on `@usemoney/core`, so core cannot import it.
 * Core owns the port and every decision made around it
 * (`us-fundamentals/cold-holdings.ts`); this module supplies the GCS half and
 * registers it, which is why the adapter lives in the worker rather than in
 * core. It is the same arrangement as `feed-archive-store.ts` and
 * `candle-cold-store-gcs.ts`, reused rather than reinvented.
 *
 * ## WHY THIS FILE EXISTS AT ALL
 *
 * `setUsColdStore()` had ZERO callers outside tests — the definition, the barrel
 * export, and `repository.test.ts`. With no registration
 * `readThirteenFColdShard` answers `absent` for every key, so the entire cold
 * tier — defined, exported, three-state, documented — had never executed in any
 * runtime. That is the third instance of this exact shape found on this branch,
 * and it is the same one `candle-cold-store-gcs.ts` was written to close for
 * candles. A mechanism that compiles, reads as finished and is wired to nothing
 * is this repo's most expensive recurring defect (MONEY-1214 disabled a whole
 * job for months on an env var that was merely absent).
 *
 * ## READ ONLY — there is no `put`
 *
 * The shards are written by the PYTHON evictor (`services/us-fundamentals`
 * `app/jobs/evict.py`), not from TypeScript. `UsColdStore` therefore declares
 * `get` alone, so this adapter cannot grow a writer by accident and no
 * TypeScript caller can race the evictor for the same key.
 *
 * ## The contract this adapter exists to preserve: `null` is an ANSWER
 *
 * `@usemoney/storage`'s `downloadFile` maps a MISSING OBJECT to `null` and
 * RETHROWS everything else. That distinction is the whole port:
 *
 *   `null`  -> this quarter is genuinely not archived (`absent`)
 *   throw   -> we do not know what this quarter holds (`failed`)
 *
 * "Missing object", not "404", and the difference was a live defect. GCS
 * answers 404 for a nonexistent BUCKET exactly as it does for a nonexistent
 * object — measured against the live API and against `@google-cloud/storage`
 * 7.18, which builds one `ApiError` with `code === 404` for both. The old guard
 * tested only that code, so a misspelled, deleted or rotated
 * `GCP_STORAGE_BUCKET` returned `null` for EVERY key: every manager holding
 * nothing, diagnosed as `COLD_SHARD_ABSENT`, with no throw and no log naming
 * the bucket. `downloadFile` now discriminates on the message and a missing
 * bucket propagates, so it arrives here as `failed` — see `isBucketNotFound`
 * and `packages/storage/__tests__/download-404.test.ts`.
 *
 * Nothing is caught here. Swallowing the throw would collapse `failed` into
 * `absent`, and `absent` renders as an empty holdings list — a manager who sold
 * everything. That is not visibly wrong, which is what makes it expensive:
 * MONEY-941 (`listFiles` failing open to `[]` and reading as "0 files
 * archived"), MONEY-1189 (a checkpoint recording DONE for work that never
 * happened), MONEY-1126 (a fail-open FREE cached into Redis) are all the same
 * bug, and this one would be worse than any of them.
 *
 * A shard that IS there and holds no rows is a third thing again, and core owns
 * it: `readThirteenFColdShard` answers `empty` rather than `present` with an
 * empty array, because the evictor has no `if not rows` guard and a 20-byte
 * gzip of the empty string decodes perfectly into zero holdings.
 *
 * **`apps/web` must NOT register this store.** Its own `downloadFile`
 * (`apps/web/lib/storage/gcp-client.ts:219`) catches every error, logs it and
 * returns `null` — so a web-side adapter built on it would report a credentials
 * failure as an empty 13F portfolio. Verified, not assumed: that function's
 * `catch` has no 404 branch at all.
 *
 * There is deliberately NO `list` in the port either, for the MONEY-941 reason
 * above: `listFiles` fails open to `[]`, so a listing is never proof of
 * absence. The reader computes the ONE key it wants and `get`s it.
 */

import { downloadFile } from "@usemoney/storage";
import {
  getUsColdStore,
  setUsColdStore,
  US_COLD_TIMEOUT_MS,
  type UsColdStore,
} from "@usemoney/core/us-fundamentals";

// Local console shim, matching feed-archive-store.ts and candle-cold-store-gcs.
// `@usemoney/logger`'s getLogger() is keyed to a fixed LoggerModule union with
// no entry for this module.
const log = {
  info: (...a: unknown[]) => console.log("[us-13f-cold]", ...a),
  warn: (...a: unknown[]) => console.warn("[us-13f-cold]", ...a),
};

const gcsUsColdStore: UsColdStore = {
  async get(key: string): Promise<Buffer | null> {
    // Already maps 404 -> null and rethrows everything else, which is exactly
    // the two-way answer the port requires. NOTHING is caught: a swallowed
    // error would become an absent quarter, and an absent quarter is
    // indistinguishable from a manager who liquidated the whole portfolio.
    return downloadFile(key);
  },
};

/**
 * Register the GCS 13F cold store. Called once at worker startup.
 *
 * ## Why an unset bucket is a warning here and a hard gate for candles
 *
 * `candle-cold-store-gcs.ts` returns `false` and lets `writeColdShard` THROW,
 * because a backfill that walks 72,685 symbols archiving nothing must fail
 * closed. This port has no writer at all, so there is nothing to fail closed:
 * with no registration every cold read answers `absent`, and core already
 * reports that as DEGRADED with `COLD_STORE_NOT_REGISTERED` — a named reason
 * that says "this process has no cold backend", not "this manager holds
 * nothing". The unconfigured environment is therefore already honest, and the
 * warning is here so the reason is findable in a log rather than only in a
 * result envelope.
 *
 * Idempotent: `setUsColdStore` re-resolves its options on every call.
 *
 * @returns whether a store is registered after this call.
 */
export function initUsColdStore(): boolean {
  if (!process.env.GCP_STORAGE_BUCKET) {
    log.warn(
      "GCP_STORAGE_BUCKET is unset — the 13F cold store stays OFF. Reads of " +
        "an EVICTED quarter answer `absent`, which getManagerHoldings reports " +
        "as degraded with COLD_STORE_NOT_REGISTERED rather than as an empty " +
        "portfolio.",
    );
    return getUsColdStore() !== null;
  }

  setUsColdStore(gcsUsColdStore);
  log.info(
    `US 13F cold store enabled: bucket=${process.env.GCP_STORAGE_BUCKET} ` +
      `timeout=${US_COLD_TIMEOUT_MS}ms`,
  );
  return true;
}
