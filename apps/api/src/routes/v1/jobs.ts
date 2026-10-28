/**
 * Jobs Routes (MONEY-731)
 *
 * User-scoped background-job status polling. The mobile client triggers async
 * work (broker sync, CSV import, research, roast) that returns a `jobId`, then
 * polls `GET /v1/jobs/:jobId` for progress/result.
 *
 * Ownership is enforced in the service (`getJobStatus(userId, jobId)` scopes the
 * lookup to the caller): a job that doesn't exist OR belongs to another user
 * both map to 404 — never leaking another user's job.
 */

import { Hono } from "hono";
import type { AppContext } from "../../app";
import { success, error, ErrorCodes } from "../../lib/response";
import { getJobStatus } from "@usemoney/services";

const jobsRoutes = new Hono<AppContext>();

/**
 * GET /v1/jobs/:jobId
 * Poll the status of a background job the caller owns.
 */
jobsRoutes.get("/:jobId", async (c) => {
  const userId = c.get("userId");
  const jobId = c.req.param("jobId");

  if (!jobId) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "jobId is required"), 400);
  }

  try {
    const result = await getJobStatus(userId, jobId);
    if (!result.success) {
      // A transient DB error (code "INTERNAL") is a retryable 500 — mapping it to
      // 404 would tell the client the job vanished and stop it polling. Only a
      // genuine not-found is a 404.
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Job status error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch job status"),
      500,
    );
  }
});

export default jobsRoutes;
