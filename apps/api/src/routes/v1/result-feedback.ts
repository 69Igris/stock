/**
 * Result Feedback Routes (MONEY-1062 P4b)
 *
 * Per-result 👍/👎 feedback on an AI result (chat message / research session /
 * roast), with an optional comment. Thin wrappers over result-feedback.service;
 * every read/write is scoped to the caller's resolved Mongo userId (IDOR-safe).
 *
 * SUBMIT (`POST /`) mirrors apps/web/lib/actions/result-feedback.ts:32
 * `submitResultFeedbackAction` — it Zod-validates the SAME canonical
 * `SubmitResultFeedbackSchema` the action uses, then the service performs the
 * upsert AND the MONEY-800 bandit outcome side effect (recordVariantOutcome →
 * metadata).
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
  SubmitResultFeedbackSchema,
  ResultFeedbackSurfaceEnum,
} from "@usemoney/validation";
import {
  submitResultFeedback,
  clearResultFeedback,
  getResultFeedback,
} from "@usemoney/services";

const resultFeedbackRoutes = new Hono<AppContext>();

/**
 * POST /v1/result-feedback
 * Submit (or update) a thumbs rating. Upserts on (userId, surface, refId), so a
 * re-rate flips the row; records the bandit outcome. → 200 { rating, comment }.
 * The service degrades silently on a write failure → 500 (never blocks the UI).
 */
resultFeedbackRoutes.post("/", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(SubmitResultFeedbackSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid feedback", parsed.issues),
      400,
    );
  }

  const result = await submitResultFeedback(userId, parsed.data);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * DELETE /v1/result-feedback?surface=&refId=
 * Remove a previously-submitted rating (toggle the thumb off). → 200 { cleared }.
 */
const ClearQuerySchema = z.object({
  surface: ResultFeedbackSurfaceEnum,
  refId: z.string().min(1, "refId is required").max(120),
});

resultFeedbackRoutes.delete("/", async (c) => {
  const userId = c.get("userId");

  const parsed = zodParse(ClearQuerySchema, {
    surface: c.req.query("surface"),
    refId: c.req.query("refId"),
  });
  if (!parsed.ok) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid request", parsed.issues),
      400,
    );
  }

  const result = await clearResultFeedback(
    userId,
    parsed.data.surface,
    parsed.data.refId,
  );
  if (!result.success) {
    if (result.code === "INVALID_INPUT") {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, result.error), 400);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/result-feedback?surface=&refIds=a,b,c
 * Hydrate the caller's existing ratings for a set of result ids (chat reload).
 * → 200 { [refId]: { rating, comment } }. Empty `refIds` → {} (never an error).
 * The service caps to 200 ids.
 */
const GetQuerySchema = z.object({
  surface: ResultFeedbackSurfaceEnum,
  refIds: z.array(z.string().min(1).max(120)).max(500).optional(),
});

resultFeedbackRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  const raw = c.req.query("refIds");
  const refIds = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const parsed = zodParse(GetQuerySchema, {
    surface: c.req.query("surface"),
    refIds,
  });
  if (!parsed.ok) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, "Invalid request", parsed.issues),
      400,
    );
  }

  const result = await getResultFeedback(
    userId,
    parsed.data.surface,
    parsed.data.refIds ?? [],
  );
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

export default resultFeedbackRoutes;
