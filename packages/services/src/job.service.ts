/**
 * Job Service (MONEY-731)
 *
 * User-scoped BackgroundJob status polling for the API/mobile client. Mirrors
 * the web reader (`apps/web/app/api/jobs/[jobId]/route.ts`) so both surfaces
 * return the same status view for the same job.
 *
 * SECURITY (IDOR): `getJobStatus` takes the caller's internal `userId` and
 * scopes the lookup to it (`where: { jobId, userId }`). A job owned by another
 * user — even with a correctly-guessed `jobId` — matches ZERO rows and returns a
 * "not found" ServiceResult (the route maps that to 404), so job existence and
 * results never leak across users.
 *
 * The status view is a whitelist: the job's `payload` (raw input, which may echo
 * request data) is deliberately NOT selected — only status/progress/result and
 * timestamps are returned.
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";

/** The polling-safe projection of a BackgroundJob returned to the client. */
export interface JobStatusView {
  jobId: string;
  jobType: string;
  status: string;
  progress: number;
  result: unknown;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

const JOB_STATUS_SELECT = {
  jobId: true,
  jobType: true,
  status: true,
  progress: true,
  result: true,
  errorMessage: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
} as const;

/**
 * Injectable IO seam. `@usemoney/services` runs its suite as ESM (no
 * `require.cache` prisma injection), so tests pass a fake prisma via `deps`
 * rather than module-mocking. Production omits it → the shared client is used.
 */
export interface GetJobStatusDeps {
  prisma?: typeof prisma;
}

/**
 * Fetch a background job's status for the owning user.
 *
 * @param userId internal Mongo user id (the caller's own id, resolved upstream).
 * @param jobId  the public job handle (BackgroundJob.jobId).
 * @returns the {@link JobStatusView} on success; `{ success: false }` when the
 *   job does not exist OR is not owned by `userId` (indistinguishable to the
 *   caller — no cross-user existence oracle).
 */
export async function getJobStatus(
  userId: string,
  jobId: string,
  deps: GetJobStatusDeps = {},
): Promise<ServiceResult<JobStatusView>> {
  const db = deps.prisma ?? prisma;
  try {
    const job = await db.backgroundJob.findFirst({
      where: { jobId, userId },
      select: JOB_STATUS_SELECT,
    });

    if (!job) {
      return { success: false, error: "Job not found", code: "NOT_FOUND" };
    }

    return { success: true, data: job as JobStatusView };
  } catch (error) {
    logger.error({ error, userId, jobId }, "Get job status service error");
    // Distinguish a transient DB error from a genuine not-found: the route maps
    // this INTERNAL code to 500 (retryable) rather than 404 (which tells the
    // client the job vanished, so it stops polling).
    return {
      success: false,
      error: "Failed to fetch job status",
      code: "INTERNAL",
    };
  }
}
