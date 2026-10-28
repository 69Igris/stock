"use server";

/**
 * Learning Server Actions
 *
 * Thin wrappers over @usemoney/services learning functions.
 * Auth required for enrollment and progress operations.
 */

import { getAuthenticatedUser } from "@/lib/auth";
import type { ActionResponse } from "@usemoney/validation";
import {
  getCourses as getCoursesService,
  getCourseBySlug as getCourseBySlugService,
  getLessonById as getLessonByIdService,
  enrollInCourse as enrollInCourseService,
  updateLessonProgress as updateLessonProgressService,
  getUserEnrollments as getUserEnrollmentsService,
  getGlossaryTerms as getGlossaryTermsService,
  getSubscription as getSubscriptionService,
} from "@usemoney/services";
import { isDemoSession } from "@/lib/demo/session";
import { demoCourses } from "@/lib/demo/data";

/**
 * MONEY-1062: resolve the caller's plan for the premium content gate — the SAME
 * source apps/api uses (apps/api/src/routes/v1/learning.ts#resolvePlanId →
 * getSubscription().data.planId) so web and api gate an ADVANCED course/lesson
 * IDENTICALLY. getLessonById/getCourseBySlug apply a fail-closed
 * `hasFeatureAccess(planId, "advancedCourses")` gate; passing NO planId locked
 * every ADVANCED lesson for ALL web users, paying PREMIUM/ULTIMATE included.
 *
 * Why getSubscription (raw planId) and not the subscription-ACCESS view: the
 * gate's hasFeatureAccess resolves legacy ids (e.g. "AI_UNLIMITED" → PREMIUM),
 * but the access view collapses an id absent from PLAN_CONFIG to FREE and would
 * wrongly re-lock such a user — so only getSubscription gates identically to
 * apps/api. Best-effort → null; the service gate then fails CLOSED for ADVANCED.
 */
async function resolvePlanId(userId: string): Promise<string | null> {
  const sub = await getSubscriptionService(userId);
  return sub.success ? sub.data.planId : null;
}

/**
 * Get published courses with enrollment info
 */
export async function getCoursesAction(filters?: {
  level?: string;
  search?: string;
}): Promise<ActionResponse<unknown[]>> {
  if (await isDemoSession()) {
    return {
      success: true,
      data: demoCourses as unknown as unknown[],
    };
  }

  return getCoursesService(filters);
}

/**
 * Get course by slug with full chapter/lesson tree
 */
export async function getCourseBySlugAction(
  slug: string
): Promise<ActionResponse<unknown>> {
  const authUser = await getAuthenticatedUser();
  // MONEY-1062: resolve + forward planId so an ADVANCED course renders `locked`
  // for the RIGHT plans (was locked for everyone). Unauthenticated → undefined
  // (gate stays closed for ADVANCED, correct).
  const planId = authUser ? await resolvePlanId(authUser.userId) : undefined;
  return getCourseBySlugService(slug, authUser?.userId, planId);
}

/**
 * Get lesson by ID with quiz and chapter context
 */
export async function getLessonByIdAction(
  lessonId: string
): Promise<ActionResponse<unknown>> {
  const authUser = await getAuthenticatedUser();
  // MONEY-1062: resolve + forward planId so the fail-closed premium gate in
  // getLessonById unlocks ADVANCED lessons for entitled (PREMIUM/ULTIMATE)
  // callers. Unauthenticated → undefined (gate stays closed for ADVANCED).
  const planId = authUser ? await resolvePlanId(authUser.userId) : undefined;
  return getLessonByIdService(lessonId, planId);
}

/**
 * Enroll user in a course (with premium gating for ADVANCED)
 */
export async function enrollInCourseAction(
  courseId: string
): Promise<ActionResponse<unknown>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) return { success: false, error: "Please sign in to enroll" };

  return enrollInCourseService(authUser.userId, courseId);
}

/**
 * Update lesson progress
 */
export async function updateLessonProgressAction(
  enrollmentId: string,
  lessonId: string,
  completed: boolean,
  quizScore?: number
): Promise<ActionResponse<unknown>> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) return { success: false, error: "Please sign in" };

  return updateLessonProgressService(
    authUser.userId,
    enrollmentId,
    lessonId,
    completed,
    quizScore
  );
}

/**
 * Get user enrollments with progress
 */
export async function getUserEnrollmentsAction(): Promise<
  ActionResponse<unknown[]>
> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) return { success: true, data: [] };

  return getUserEnrollmentsService(authUser.userId);
}

/**
 * Get glossary terms
 */
export async function getGlossaryTermsAction(
  search?: string
): Promise<ActionResponse<unknown[]>> {
  return getGlossaryTermsService(search);
}
