/**
 * Research Routes
 *
 * AI research session status and history.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app";
import {
  success,
  error,
  ErrorCodes,
  safeJson,
  zodParse,
} from "../../lib/response";
import { parsePage, parseLimit } from "./pagination";
import {
  getResearchStatus,
  getResearchResult,
  getRunningResearch,
  getResearchHistory,
  cancelResearch,
  deleteResearch,
  startResearchJob,
} from "@usemoney/services";

const researchRoutes = new Hono<AppContext>();

/**
 * Body for POST /v1/research (mirrors the inputs startResearchAction accepts:
 * query 1..2000, optional skill, ≤20 symbols, optional mode).
 */
const StartResearchSchema = z.object({
  query: z.string().trim().min(1, "query is required").max(2000),
  skill: z.string().trim().min(1).max(100).optional(),
  symbols: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  mode: z.enum(["fast", "advanced"]).optional(),
});

/**
 * POST /v1/research
 * Start an async research session → 202 { sessionId }. Poll via
 * GET /v1/research/:sessionId/status. Mirrors startResearchAction: the credit
 * gate runs BEFORE the session/job is created, and a publish failure refunds
 * (all inside startResearchJob). NO_CREDITS → 403, INTERNAL → 500.
 */
researchRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  const parsed = await safeJson(c);
  if (!parsed.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const validated = zodParse(StartResearchSchema, parsed.data);
  if (!validated.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid research request",
        validated.issues,
      ),
      400,
    );
  }

  try {
    const result = await startResearchJob(userId, validated.data);
    if (!result.success) {
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      if (result.code === "NO_CREDITS") {
        return c.json(error(ErrorCodes.FORBIDDEN, result.error), 403);
      }
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data), 202);
  } catch (err) {
    console.error("Research start error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to start research"),
      500,
    );
  }
});

/**
 * GET /v1/research
 * Get research history
 */
researchRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  try {
    // getResearchHistory(userId, page = 1, pageSize = 20). The 2nd arg is the
    // PAGE, not the limit — passing the limit here requested page 20 (skip 380),
    // which is empty for every user. Read both params into their correct slots
    // via the shared NaN-safe helpers (default pageSize 20 preserved).
    const page = parsePage(c.req.query("page"));
    const pageSize = parseLimit(c.req.query("limit"), 20);
    const result = await getResearchHistory(userId, page, pageSize);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Research history error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch research history"),
      500,
    );
  }
});

/**
 * GET /v1/research/running
 * Get in-progress research sessions
 */
researchRoutes.get("/running", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getRunningResearch(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Running research error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch running research"),
      500,
    );
  }
});

/**
 * GET /v1/research/:sessionId/status
 * Get research session status
 */
researchRoutes.get("/:sessionId/status", async (c) => {
  const sessionId = c.req.param("sessionId");
  // MONEY-286: scope lookup to the authenticated user - a guessed
  // sessionId from another user must resolve as 404, not as readable.
  // P1.1 (MONEY-1062): c.get("userId") is now the internal Mongo _id (resolved
  // in authMiddleware), matching every other route + what research.service
  // expects — previously this alone read the Clerk id (IDOR-inconsistency).
  const userId = c.get("userId");

  try {
    const result = await getResearchStatus(sessionId, undefined, userId);
    if (!result.success) {
      // MONEY-1183 — a DB failure is a 500, not a 404. Both outcomes shared
      // this branch and answered 404, telling the client the row is gone so
      // it stopped retrying a blip that would have succeeded.
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Research status error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch research status"),
      500,
    );
  }
});

/**
 * GET /v1/research/:sessionId/result
 * Get research session result (report)
 */
researchRoutes.get("/:sessionId/result", async (c) => {
  const sessionId = c.req.param("sessionId");
  // MONEY-286: same IDOR guard as /status - scope to authenticated user.
  const userId = c.get("userId");

  try {
    const result = await getResearchResult(sessionId, userId);
    if (!result.success) {
      // MONEY-1183 — three distinct outcomes shared one 404.
      //
      // NOT_READY is the interesting one: the session EXISTS and belongs to
      // the caller, it just has no result yet. Answering 404 told a polling
      // client the research had vanished, so it stopped polling a run that
      // was about to finish. 409 says "exists, not in a state to serve this".
      if (result.code === "NOT_READY") {
        return c.json(error(ErrorCodes.CONFLICT, result.error), 409);
      }
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Research result error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch research result"),
      500,
    );
  }
});

/**
 * POST /v1/research/:sessionId/cancel
 * Cancel a running research session
 */
researchRoutes.post("/:sessionId/cancel", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sessionId");

  try {
    const result = await cancelResearch(userId, sessionId);
    if (!result.success) {
      // Missing/foreign session → 404; a DB error → 500; an "already finished"
      // state conflict stays a 400 validation error.
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }

    return c.json(success({ message: "Research cancelled" }));
  } catch (err) {
    console.error("Research cancel error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to cancel research"),
      500,
    );
  }
});

/**
 * DELETE /v1/research/:sessionId
 * Delete a research session
 */
researchRoutes.delete("/:sessionId", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sessionId");

  try {
    const result = await deleteResearch(userId, sessionId);
    if (!result.success) {
      // MONEY-1180 — a DB failure is a 500, not a 404. Both outcomes used
      // to collapse into this one branch and answer 404, which told the
      // client the row does not exist and it stopped retrying a delete
      // that would have worked. Un-coded failures keep the 404 default.
      if (result.code === "INTERNAL") {
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }

    return c.json(success({ message: "Research session deleted" }));
  } catch (err) {
    console.error("Research delete error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to delete research session"),
      500,
    );
  }
});

export default researchRoutes;
