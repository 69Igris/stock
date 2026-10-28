/**
 * Pub/Sub `messageId` idempotency — the Prisma wiring (MONEY-1204, 14a.5b).
 *
 * All behaviour lives in `pubsub-dedupe-logic.ts`, which is driven by an
 * injected `RawCommandRunner`. This file supplies the real one and nothing else,
 * so importing the logic module in a test never loads Prisma.
 *
 * ## Why a dedicated collection instead of `MarketDataSyncLog` / `BackgroundJob`
 *
 * The obvious move is to reuse an existing marker table. Neither works, and the
 * reason is a measurement, not a preference:
 *
 *   `marketDataSyncLog` — written by 5 processors (bhavcopy-sync, intraday-sync,
 *   ownership-sync, price-sync, report-archive-sync);
 *   `backgroundJob`     — written by 4 (document-process, import, pairing, sync).
 *
 * Nine of ~55 job routes between them, and the two sets are DISJOINT — there is
 * no "the one every job already writes". Both are also semantic tables that
 * other code reads: MONEY-1189's completeness checks aggregate
 * `market_data_sync_logs`, and one dedupe row per delivery would land in the
 * middle of them. `BackgroundJob` additionally requires a `userId` ObjectId and
 * a `JobType` enum member, neither of which a cron sync has.
 *
 * So: a dedicated, single-purpose collection with a UNIQUE index (what makes
 * the claim atomic) and a TTL index (markers are garbage, not history). It is
 * undeclared in `schema.prisma` on purpose — nothing needs a typed model for
 * it, and `$runCommandRaw` is the established way this repo touches Mongo
 * directly (`scripts/migrations/*.ts`). The collection and index names in the
 * logic module are the contract if it is ever declared.
 *
 * @see workers/src/lib/pubsub-dedupe-logic.ts
 */

import { prisma } from "@usemoney/database";
import type { Prisma } from "@prisma/client";
import {
  DEFAULT_LEASE_MS,
  createDedupeMiddleware,
  createDedupeStore,
  dedupeIndexCommand,
  type ClaimDecision,
  type DedupeStore,
  type RawCommandRunner,
} from "./pubsub-dedupe-logic";

/** Lease length in ms, overridable per deployment. Falls back on a bad value
 *  rather than letting a NaN propagate into a lease comparison — `NaN <= now`
 *  is FALSE, which would read as a permanently live lease. */
function leaseMs(): number {
  const raw = Number(process.env.PUBSUB_DEDUPE_LEASE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEASE_MS;
}

/** `PUBSUB_DEDUPE=off` disables the mechanism without a code change. */
export function dedupeEnabled(): boolean {
  return (process.env.PUBSUB_DEDUPE ?? "").toLowerCase() !== "off";
}

const runCommand: RawCommandRunner = (command) =>
  prisma.$runCommandRaw(command as Prisma.InputJsonObject);

// ── Index bootstrap ──────────────────────────────────────────────────────

let indexPromise: Promise<void> | null = null;

/**
 * Create the unique + TTL indexes once per process.
 *
 * Best-effort by design. If it fails, `claim()` still runs — it just cannot
 * rely on the unique index, so a conflicting insert would SUCCEED rather than
 * raise E11000 and the dedupe would quietly stop deduping. That is the
 * fail-open posture the logic module argues for, and it is logged loudly rather
 * than swallowed. `createIndexes` is idempotent: an identical existing index is
 * a no-op.
 */
export function ensureDedupeIndexes(): Promise<void> {
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    try {
      await runCommand(dedupeIndexCommand());
    } catch (err) {
      console.error(
        "[pubsub-dedupe] createIndexes failed — dedupe will NOT be atomic " +
          "until the unique index exists; deliveries may double-run",
        err,
      );
    }
  })();
  return indexPromise;
}

const store = createDedupeStore({
  runCommand,
  leaseMs,
  logError: (m, err) => console.error(m, err),
});

/**
 * The production store.
 *
 * Wraps the logic-module store with the two process-level concerns it should
 * not own: the kill switch and the one-time index bootstrap.
 */
export const prismaDedupeStore: DedupeStore = {
  async claim(messageId: string, route: string): Promise<ClaimDecision> {
    if (!dedupeEnabled()) {
      return { action: "RUN_UNTRACKED", reason: "dedupe_disabled" };
    }
    await ensureDedupeIndexes();
    return store.claim(messageId, route);
  },
  async release(
    messageId: string,
    outcome: "COMPLETED" | "FAILED",
  ): Promise<void> {
    if (!dedupeEnabled()) return;
    await store.release(messageId, outcome);
  },
};

/**
 * The `/jobs/*` idempotency middleware, wired to the real store.
 *
 * Register it AFTER the OIDC gate in `index.ts` — see the ordering note on
 * `createDedupeMiddleware`.
 */
export const pubsubDedupeMiddleware = createDedupeMiddleware({
  store: prismaDedupeStore,
  log: (m) => console.log(m),
  logError: (m, err) => console.error(m, err),
});

/** Convenience re-exports for callers that dedupe outside the middleware
 *  (the dead-letter consumer). */
export const claimMessage = prismaDedupeStore.claim;
export const releaseMessage = prismaDedupeStore.release;
