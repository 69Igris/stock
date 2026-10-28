/**
 * Quiz Routes (MONEY-402 mobile-parity)
 *
 * The non-AI, DB-backed quiz surface: list lessons carrying a quiz, read a
 * lesson's quiz (answer key stripped), and score a submission. Thin wrappers
 * over quiz.service — auth is enforced upstream; quizzes are GLOBAL catalog data
 * (nothing user-owned to scope), so a missing lesson/quiz is a plain 404.
 *
 * DEFERRED: the AI-GENERATED quiz path (topic → Gemini) is web/Gemini-coupled →
 * MONEY-1067.
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
import { listQuizzes, getQuiz, submitQuiz } from "@usemoney/services";
import { parsePagination } from "./pagination";

const quizRoutes = new Hono<AppContext>();

const SubmitSchema = z.object({
  answers: z.array(z.number().int().nullable()),
});

/** GET /v1/quizzes — lessons that carry a quiz (paginated catalogue). */
quizRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const { skip, limit } = parsePagination({
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });

  const result = await listQuizzes(userId, { skip, limit });
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/** GET /v1/quizzes/:lessonId — a lesson's quiz with the answer key stripped. */
quizRoutes.get("/:lessonId", async (c) => {
  const userId = c.get("userId");
  const result = await getQuiz(userId, c.req.param("lessonId"));
  if (!result.success) {
    // A DB error (code "INTERNAL") is a 500; a missing lesson/quiz → 404.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }
  return c.json(success(result.data));
});

/** POST /v1/quizzes/:lessonId/submit — score a positional answer submission. */
quizRoutes.post("/:lessonId/submit", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(SubmitSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid answers payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await submitQuiz(userId, c.req.param("lessonId"), parsed.data);
  if (!result.success) {
    // A DB error (code "INTERNAL") is a 500; a missing lesson/quiz → 404.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }
  return c.json(success(result.data));
});

export default quizRoutes;
