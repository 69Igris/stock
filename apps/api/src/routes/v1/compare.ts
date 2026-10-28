/**
 * Compare Routes (MONEY-1062 P2b)
 *
 * Async deep stock/MF comparison: start → poll status → read result. Thin
 * wrappers over comparison.service; every read is userId-scoped (IDOR-safe) in
 * the service.
 *
 * START (`POST /v1/compare`) mirrors apps/web/lib/actions/comparison.ts:77
 * `startComparisonAction` via the new `startComparison(userId, …)` service:
 * feature gate → validate → reserveCredits (the gate) → createComparisonSession
 * (refund reservation on failure) → publishComparisonJob (refund + FAILED on
 * failure). The route never inlines pubsub/credit logic.
 *
 * Body mirrors the ASYNC action's real signature `startComparisonAction(kind,
 * symbols, depth)` — a single `kind` for all items + a symbols array — NOT the
 * unrelated discover `mf-compare` `TYPE:id` shape (that route is a different,
 * synchronous feature).
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
import {
  startComparison,
  getComparisonStatus,
  getComparisonBySessionId,
} from "@usemoney/services";

const compareRoutes = new Hono<AppContext>();

/**
 * Body for POST /v1/compare (mirrors startComparisonAction(kind, symbols,
 * depth)). 2..5 items of the same kind; the service re-validates the count
 * AFTER de-duplication (a dedup below 2 → INVALID_INPUT).
 */
const StartComparisonSchema = z.object({
  kind: z.enum(["stock", "mf"]),
  symbols: z.array(z.string().trim().min(1).max(50)).min(2).max(5),
  depth: z
    .enum(["deep", "comprehensive", "advanced", "custom"])
    .optional()
    .default("deep"),
});

/**
 * POST /v1/compare
 * Start an async deep comparison → 202 { sessionId }. Poll via
 * GET /v1/compare/:sessionId/status; read via /result. Code mapping:
 * UPGRADE_REQUIRED / NO_CREDITS → 403; INVALID_INPUT → 400; INTERNAL → 500.
 */
compareRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  const parsed = await safeJson(c);
  if (!parsed.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const validated = zodParse(StartComparisonSchema, parsed.data);
  if (!validated.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid comparison request",
        validated.issues,
      ),
      400,
    );
  }

  try {
    const result = await startComparison(userId, validated.data);
    if (!result.success) {
      switch (result.code) {
        case "UPGRADE_REQUIRED":
        case "NO_CREDITS":
          return c.json(error(ErrorCodes.FORBIDDEN, result.error), 403);
        case "INVALID_INPUT":
          return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
        case "NOT_FOUND":
          return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
        default:
          return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
    }
    return c.json(success(result.data), 202);
  } catch (err) {
    console.error("Comparison start error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to start comparison"),
      500,
    );
  }
});

/**
 * GET /v1/compare/:sessionId/status
 * Lightweight status/progress poll for a comparison the caller owns. Mirrors
 * getComparisonStatusAction — getComparisonStatus(sessionId, userId), sessionId
 * FIRST, userId-scoped so a foreign/missing sessionId → 404.
 */
compareRoutes.get("/:sessionId/status", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sessionId");

  const result = await getComparisonStatus(sessionId, userId);
  if (!result.success) {
    // The read service tags no code today, so a missing/foreign session → 404;
    // a future INTERNAL code maps to 500.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  return c.json(success(result.data));
});

/**
 * GET /v1/compare/:sessionId/result
 * Full comparison record (result) for a session the caller owns. Mirrors
 * getComparisonResultAction — getComparisonBySessionId(sessionId, userId),
 * userId-scoped so a guessed sessionId → 404 (no cross-user leak).
 */
compareRoutes.get("/:sessionId/result", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sessionId");

  const result = await getComparisonBySessionId(sessionId, userId);
  if (!result.success) {
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  return c.json(success(result.data));
});

export default compareRoutes;
