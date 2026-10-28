/**
 * Broker-connection server actions — PURE, side-effect-free helpers.
 *
 * Extracted out of `broker-connection.ts` (a `"use server"` module, which may
 * ONLY export async functions) so these synchronous helpers can be both EXPORTED
 * and unit-tested by their real import — without dragging the action's Prisma /
 * Clerk / `next/cache` / `@usemoney/services` graph into a pure test at module
 * load. `broker-connection.ts` imports and CALLS each export here, so the
 * production path and the tests execute the SAME code (no shadow). Mirrors the
 * existing precedent `stock-sector-logic.ts` / `oauth-url.ts` / `dashboard-logic.ts`.
 *
 * @see apps/web/lib/actions/broker-connection.ts (caller)
 * @see apps/web/__tests__/actions/broker-connection-logic.test.ts (tests)
 */

// ── Historical-backfill window ─────────────────────────────────────────

/** Default historical-backfill window (days): ~10 years (full retail history). */
export const DEFAULT_HISTORICAL_SYNC_DAYS = 3650;

/**
 * MONEY-846: parse the `BROKER_HISTORICAL_SYNC_DAYS` env override into a SANE
 * positive window, falling back to {@link DEFAULT_HISTORICAL_SYNC_DAYS}.
 *
 * The old `Number(raw) || 3650` let a NEGATIVE value slip through (`Number("-5")`
 * is `-5`, which is truthy), so `fromDate = now - (-5)d` landed in the FUTURE and
 * the worker's year-by-year backfill loop never ran — silently disabled. We now
 * reject anything that isn't a finite value > 0 (negative, 0, NaN, "", garbage)
 * and fall back to the default; a valid positive value passes through unchanged.
 */
export function parseHistoricalSyncDays(
  raw: string | undefined,
  fallback: number = DEFAULT_HISTORICAL_SYNC_DAYS
): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── In-flight broker-sync job tracking ─────────────────────────────────

// MONEY-846: a broker-sync job that hasn't reached a terminal status within this
// window is treated as STALE and ignored by the "syncing…" loader, so a job that
// died without reporting completion can never wedge the spinner on "in progress".
export const STALE_BROKER_JOB_MS = 15 * 60 * 1000; // 15 minutes

/**
 * MONEY-846: the `queuedAt >= cutoff` boundary for the in-flight-job query — any
 * PENDING/PROCESSING row queued before this is stale. Pure + exported so the
 * 15-minute cutoff is testable without booting the action's Prisma/Clerk deps.
 */
export function staleBrokerJobCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - STALE_BROKER_JOB_MS);
}

/** The terminal/working status the brokers-page poller renders. */
export type BrokerSyncJobStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "UNKNOWN";

/** The shape the brokers-page poller consumes (status + parsed result counts). */
export interface BrokerSyncJobStatusResult {
  status: BrokerSyncJobStatus;
  synced?: Record<string, number>;
  total?: number;
  error?: string;
}

/**
 * MONEY-846: map a raw BackgroundJob row → the poller's status payload.
 *
 * Extracted out of `getBrokerSyncJobStatusAction` so the three fiddly bits are
 * unit-testable without the action's auth/DB shell:
 *   - `result` is a Prisma Json column → parse DEFENSIVELY ({ synced, total }),
 *     treating a malformed / legacy / array / null value as "no counts" instead
 *     of throwing.
 *   - CANCELLED is a terminal non-success → surface it down the FAILED path so
 *     the spinner can't hang waiting for a status that will never change.
 *   - a missing row (`null`) → UNKNOWN ("keep waiting").
 */
export function mapBrokerSyncJobStatus(
  job: {
    status: string;
    result: unknown;
    errorMessage: string | null;
  } | null
): BrokerSyncJobStatusResult {
  if (!job) return { status: "UNKNOWN" };

  // The worker writes `result = { success, synced: {holdings,…}, total }`.
  let synced: Record<string, number> | undefined;
  let total: number | undefined;
  const r = job.result;
  if (r && typeof r === "object" && !Array.isArray(r)) {
    const obj = r as Record<string, unknown>;
    if (
      obj.synced &&
      typeof obj.synced === "object" &&
      !Array.isArray(obj.synced)
    ) {
      synced = obj.synced as Record<string, number>;
    }
    if (typeof obj.total === "number") total = obj.total;
  }

  const status: BrokerSyncJobStatus =
    job.status === "CANCELLED" ? "FAILED" : (job.status as BrokerSyncJobStatus);

  return { status, synced, total, error: job.errorMessage ?? undefined };
}
