/**
 * Learning Routes
 *
 * Courses / lessons / progress. Course + lesson bodies are premium-gated at the
 * SERVICE layer (fail-closed): getLessonById refuses an ADVANCED lesson body to
 * an unentitled plan (PREMIUM_REQUIRED → 403 here). The plan is resolved from
 * the caller's subscription (same composition as GET /v1/me).
 *
 * SIGNED-URL NOTE: no service generates a signed HLS/PDF url — a lesson's stored
 * videoUrl/content is returned inline in the JSON envelope (a REFERENCE, never
 * proxied bytes). Signed streaming URLs live in the apps/web content path and
 * are out of scope for this thin wiring.
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
  getCourses,
  getCourseBySlug,
  getLessonById,
  getUserEnrollments,
  updateLessonProgress,
  enrollInCourse,
  getGlossaryTerms,
  getSubscription,
} from "@usemoney/services";
import { parsePagination } from "./pagination";

const learningRoutes = new Hono<AppContext>();

/** Resolve the caller's plan for the premium content gate (best-effort → null). */
async function resolvePlanId(userId: string): Promise<string | null> {
  const sub = await getSubscription(userId);
  return sub.success ? sub.data.planId : null;
}

const ProgressSchema = z.object({
  enrollmentId: z.string().min(1),
  lessonId: z.string().min(1),
  completed: z.boolean(),
  quizScore: z.number().optional(),
});

const EnrollSchema = z.object({
  // Mongo ObjectId shape (24 hex chars). Course ids are Prisma-minted
  // ObjectIds, so anything else can never match a course — reject it as a 400
  // instead of letting a garbage id reach the service (where a malformed
  // ObjectId makes Prisma throw on the findUnique → 500).
  courseId: z
    .string()
    .regex(/^[0-9a-f]{24}$/i, "courseId must be a 24-hex Mongo ObjectId"),
});

/**
 * GET /v1/learning/courses
 * Published courses. Optional ?level / ?search filters, paginated.
 */
learningRoutes.get("/courses", async (c) => {
  const { skip, limit } = parsePagination({
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });

  const result = await getCourses({
    level: c.req.query("level"),
    search: c.req.query("search"),
    skip,
    limit,
  });
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/learning/courses/:slug
 * Course detail (chapters + lesson metadata) with the caller's enrollment. The
 * lookup key is the course SLUG (getCourseBySlug). The `locked` flag reflects
 * the plan gate; the lesson BODY gate is enforced in the lesson read below.
 */
learningRoutes.get("/courses/:slug", async (c) => {
  const userId = c.get("userId");
  const slug = c.req.param("slug");

  const planId = await resolvePlanId(userId);
  const result = await getCourseBySlug(slug, userId, planId);
  if (!result.success) {
    // A DB error (code "INTERNAL") is a 500; a missing course → 404.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/learning/lessons/:id
 * Lesson body (incl. the stored videoUrl/content reference). Fail-closed premium
 * gate → 403 PREMIUM_REQUIRED; a missing lesson → 404.
 */
learningRoutes.get("/lessons/:id", async (c) => {
  const userId = c.get("userId");
  const lessonId = c.req.param("id");

  const planId = await resolvePlanId(userId);
  const result = await getLessonById(lessonId, planId);
  if (!result.success) {
    const code = (result as { code?: string }).code;
    if (code === "PREMIUM_REQUIRED") {
      return c.json(error(ErrorCodes.FORBIDDEN, result.error), 403);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/learning/progress
 * The caller's enrollments + per-lesson progress (userId-scoped), paginated.
 */
learningRoutes.get("/progress", async (c) => {
  const userId = c.get("userId");
  const { skip, limit } = parsePagination({
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });

  const result = await getUserEnrollments(userId, { skip, limit });
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * POST /v1/learning/progress
 * Upsert lesson progress for an enrollment the caller owns (updateLessonProgress
 * verifies ownership → foreign/missing enrollment resolves as 404).
 */
learningRoutes.post("/progress", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(ProgressSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid progress payload",
        parsed.issues,
      ),
      400,
    );
  }

  const { enrollmentId, lessonId, completed, quizScore } = parsed.data;
  const result = await updateLessonProgress(
    userId,
    enrollmentId,
    lessonId,
    completed,
    quizScore,
  );
  if (!result.success) {
    // MONEY-1183 — a DB failure is a 500. It used to share this branch with
    // genuine client errors, so a failed write was reported as the caller's
    // fault and never retried. The service now tags INTERNAL; anything
    // un-coded keeps this route's previous status.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }
  return c.json(success(result.data));
});

/**
 * POST /v1/learning/enroll
 * Enroll the caller in a course (idempotent — an existing enrollment is
 * returned unchanged). Mirrors enrollInCourseAction (apps/web
 * lib/actions/learning.ts:92). courseId is shape-gated to a Mongo ObjectId
 * (24-hex) → 400. A service NOT_FOUND (course-existence check) → 404; any
 * other failure (DB error, code-less catch) → 500.
 */
learningRoutes.post("/enroll", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(EnrollSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid enroll payload",
        parsed.issues,
      ),
      400,
    );
  }

  const result = await enrollInCourse(userId, parsed.data.courseId);
  if (!result.success) {
    // A missing/unpublished course → 404 when the service emits the
    // NOT_FOUND code (existence check); today's code-less DB-error failure
    // stays a 500 — this mapping degrades to the old behaviour if the code
    // is absent.
    if ((result as { code?: string }).code === "NOT_FOUND") {
      return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

/**
 * GET /v1/learning/glossary
 * Glossary terms (global, alphabetical). Optional ?search filter, paginated.
 * Mirrors getGlossaryTermsAction (apps/web lib/actions/learning.ts:151) —
 * getGlossaryTerms(search?, { limit, skip }).
 */
learningRoutes.get("/glossary", async (c) => {
  const { skip, limit } = parsePagination({
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });

  const result = await getGlossaryTerms(c.req.query("search"), { skip, limit });
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }
  return c.json(success(result.data));
});

export default learningRoutes;
