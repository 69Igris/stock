/**
 * Analysis Routes (MONEY-1062 P2b)
 *
 * L3/L4 comprehensive analysis: start → poll status → read result → cancel.
 * Thin wrappers over analysis.service; every read/mutate is userId-scoped
 * (IDOR-safe) in the service.
 *
 * START (`POST /v1/analysis`) mirrors apps/web/lib/actions/analysis.ts:128
 * `startComprehensiveAnalysisAction` via `startComprehensiveAnalysis(userId, …)`:
 * one-concurrent guard → consumeCredits (the gate) → create the AnalysisSession
 * → publishL3AnalysisJob(segment 0); a publish failure marks FAILED + refunds.
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
  startComprehensiveAnalysis,
  getAnalysisStatus,
  getAnalysisResult,
  cancelAnalysis,
  type AnalysisType,
} from "@usemoney/services";

const analysisRoutes = new Hono<AppContext>();

/**
 * The REAL analysis catalogue — the exact keys of `ANALYSIS_COSTS` in
 * packages/services/src/credit-reservation.service.ts (the `AnalysisType`
 * union). An unknown key reaches `estimateAnalysisCost` as
 * `ANALYSIS_COSTS[analysisType] === undefined` and TypeErrors deep in the
 * start flow (`config.baseCredits`) → 500, so the route rejects it up front
 * with a 400. The `satisfies` clause keeps this tuple in compile-time
 * lockstep with the service union (a typo or a removed key fails the build);
 * a NEWLY added service key must be appended here to become reachable.
 */
const ANALYSIS_TYPES = [
  "comprehensive_stock",
  "multi_comparison",
  "portfolio_optimization",
  "portfolio_roast",
  "l4_comprehensive",
  "mf_analysis",
  "mf_comparison_deep",
  "mf_comparison_comprehensive",
  "mf_comparison_advanced",
  "mf_comparison_custom",
] as const satisfies readonly AnalysisType[];

/**
 * Body for POST /v1/analysis (mirrors startComprehensiveAnalysisAction's input:
 * an analysisType from the real catalogue, a required query, optional symbols).
 */
const StartAnalysisSchema = z.object({
  analysisType: z.enum(ANALYSIS_TYPES),
  symbols: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  query: z.string().trim().min(1, "query is required").max(2000),
});

/**
 * POST /v1/analysis
 * Start an async comprehensive analysis → 202 { sessionId, estimatedMinutes,
 * creditsReserved, totalSegments }. Code mapping: CONFLICT (one already
 * running) → 409; NO_CREDITS → 403; INTERNAL → 500.
 */
analysisRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  const parsed = await safeJson(c);
  if (!parsed.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const validated = zodParse(StartAnalysisSchema, parsed.data);
  if (!validated.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid analysis request",
        validated.issues,
      ),
      400,
    );
  }

  try {
    const result = await startComprehensiveAnalysis(userId, validated.data);
    if (!result.success) {
      switch (result.code) {
        case "CONFLICT":
          return c.json(error(ErrorCodes.CONFLICT, result.error), 409);
        case "NO_CREDITS":
          return c.json(error(ErrorCodes.FORBIDDEN, result.error), 403);
        case "NOT_FOUND":
          return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
        default:
          return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      }
    }
    return c.json(success(result.data), 202);
  } catch (err) {
    console.error("Analysis start error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to start analysis"),
      500,
    );
  }
});

/**
 * GET /v1/analysis/:sessionId/status
 * Segment-level status/progress poll for an analysis the caller owns. Mirrors
 * getAnalysisStatusAction — userId-scoped so a foreign/missing sessionId → 404.
 */
analysisRoutes.get("/:sessionId/status", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sessionId");

  const result = await getAnalysisStatus(userId, sessionId);
  if (!result.success) {
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  return c.json(success(result.data));
});

/**
 * GET /v1/analysis/:sessionId/result
 * Full report for a COMPLETED analysis the caller owns. Mirrors
 * getAnalysisResultAction: missing/foreign → 404; exists-but-not-complete → 409
 * (client should keep polling status); DB error → 500.
 */
analysisRoutes.get("/:sessionId/result", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sessionId");

  const result = await getAnalysisResult(userId, sessionId);
  if (!result.success) {
    switch (result.code) {
      case "CONFLICT":
        return c.json(error(ErrorCodes.CONFLICT, result.error), 409);
      case "INTERNAL":
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      default:
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
  }

  return c.json(success(result.data));
});

/**
 * POST /v1/analysis/:sessionId/cancel
 * Cancel a running analysis the caller owns and refund. Mirrors
 * cancelAnalysisAction: missing/foreign → 404; already COMPLETED/CANCELLED →
 * 409; success → 200 { refunded }.
 */
analysisRoutes.post("/:sessionId/cancel", async (c) => {
  const userId = c.get("userId");
  const sessionId = c.req.param("sessionId");

  const result = await cancelAnalysis(userId, sessionId);
  if (!result.success) {
    switch (result.code) {
      case "CONFLICT":
        return c.json(error(ErrorCodes.CONFLICT, result.error), 409);
      case "INTERNAL":
        return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
      default:
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
  }

  return c.json(success(result.data));
});

export default analysisRoutes;
