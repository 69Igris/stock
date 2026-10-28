/**
 * Learning Service
 *
 * Handles courses, lessons, enrollment, and glossary.
 * Source: apps/web/lib/actions/learning.ts
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import {
  calculateProgressPercent,
  canAccessLessonContent,
  clampPagination,
  shouldGateAdvancedCourse,
} from "./learning-logic";

// ── Service Functions ──────────────────────────────────────────────

export async function getCourses(
  filters: {
    level?: string;
    search?: string;
    limit?: number;
    skip?: number;
  } = {},
): Promise<ServiceResult<unknown[]>> {
  try {
    const where: Record<string, unknown> = { published: true };
    if (filters.level && filters.level !== "all") where.level = filters.level;
    if (filters.search) {
      where.OR = [
        { title: { contains: filters.search, mode: "insensitive" } },
        { description: { contains: filters.search, mode: "insensitive" } },
      ];
    }

    // Clamp untrusted limit/skip so a NaN/negative/huge page can't 500 Prisma
    // or page the whole table into memory.
    const { take, skip } = clampPagination(filters.limit, filters.skip);

    const courses = await prisma.course.findMany({
      where,
      include: {
        chapters: {
          orderBy: { order: "asc" },
          include: {
            lessons: { orderBy: { order: "asc" }, select: { id: true } },
          },
        },
        _count: { select: { enrollments: true } },
      },
      orderBy: { order: "asc" },
      take,
      skip,
    });

    return { success: true, data: courses };
  } catch (error) {
    logger.error({ error }, "Get courses service error");
    return { success: false, error: "Failed to fetch courses" };
  }
}

export async function getCourseBySlug(
  slug: string,
  userId?: string,
  planId?: string | null,
): Promise<ServiceResult<unknown>> {
  try {
    const course = await prisma.course.findUnique({
      where: { slug },
      include: {
        chapters: {
          orderBy: { order: "asc" },
          include: {
            lessons: {
              orderBy: { order: "asc" },
              select: {
                id: true,
                title: true,
                type: true,
                duration: true,
                order: true,
              },
            },
          },
        },
      },
    });

    if (!course) {
      return { success: false, error: "Course not found" };
    }

    // IDOR-safe: the enrollment is fetched by the COMPOSITE (userId, courseId)
    // key, so a caller can only ever read THEIR OWN enrollment/progress for this
    // course — never another user's by guessing an id.
    let enrollment = null;
    if (userId) {
      enrollment = await prisma.enrollment.findUnique({
        where: { userId_courseId: { userId, courseId: course.id } },
        include: { lessonProgress: true },
      });
    }

    // `locked` lets the UI gate ADVANCED-course content for an unentitled plan.
    // The actual content gate is enforced server-side in getLessonById (the
    // slug payload only carries lesson metadata, not the lesson body).
    const locked = shouldGateAdvancedCourse(course.level, planId);

    return { success: true, data: { ...course, enrollment, locked } };
  } catch (error) {
    logger.error({ error, slug }, "Get course by slug service error");
    return {
      success: false,
      error: "Failed to fetch course",
      code: "INTERNAL",
    };
  }
}

export async function getLessonById(
  lessonId: string,
  planId?: string | null,
): Promise<ServiceResult<unknown>> {
  try {
    const lesson = await prisma.courseLesson.findUnique({
      where: { id: lessonId },
      include: {
        quizzes: true,
        chapter: {
          select: {
            id: true,
            title: true,
            courseId: true,
            course: { select: { title: true, slug: true, level: true } },
          },
        },
      },
    });

    if (!lesson) {
      return { success: false, error: "Lesson not found" };
    }

    // Fail-closed premium gate (defence in depth): an ADVANCED course's lesson
    // body (content / videoUrl / quiz answers) is NEVER served to a
    // FREE/unentitled caller. Hiding a lock in the UI is not a security control,
    // so we refuse to return the payload here.
    const courseLevel = lesson.chapter?.course?.level;
    if (!canAccessLessonContent(courseLevel, planId)) {
      return {
        success: false,
        error: "This lesson requires a premium subscription.",
        code: "PREMIUM_REQUIRED",
      };
    }

    return { success: true, data: lesson };
  } catch (error) {
    logger.error({ error, lessonId }, "Get lesson service error");
    // MONEY-1062 (Round C / C1#3): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to fetch lesson",
      code: "INTERNAL",
    };
  }
}

export async function enrollInCourse(
  userId: string,
  courseId: string,
): Promise<ServiceResult<unknown>> {
  try {
    const existing = await prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
    });
    if (existing) {
      return { success: true, data: existing };
    }

    // MONEY-1062 (Round C / C2#5): verify the Course exists BEFORE creating the
    // Enrollment. Enrollment.course is a required relation, so enrolling against
    // a ghost courseId would persist a dangling row that makes every later
    // getUserEnrollments include-join throw for this user.
    const course = await prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true },
    });
    if (!course) {
      return { success: false, error: "Course not found", code: "NOT_FOUND" };
    }

    const enrollment = await prisma.enrollment.create({
      data: { userId, courseId },
    });

    return { success: true, data: enrollment };
  } catch (error) {
    logger.error({ error, userId, courseId }, "Enroll service error");
    return { success: false, error: "Failed to enroll in course" };
  }
}

export async function updateLessonProgress(
  userId: string,
  enrollmentId: string,
  lessonId: string,
  completed: boolean,
  quizScore?: number,
): Promise<ServiceResult<unknown>> {
  try {
    // Verify ownership
    const enrollment = await prisma.enrollment.findFirst({
      where: { id: enrollmentId, userId },
      include: {
        course: {
          include: {
            chapters: {
              include: { lessons: { select: { id: true } } },
            },
          },
        },
      },
    });

    if (!enrollment) {
      return {
        success: false,
        error: "Enrollment not found",
        code: "NOT_FOUND",
      };
    }

    // Upsert lesson progress
    await prisma.courseLessonProgress.upsert({
      where: {
        enrollmentId_lessonId: { enrollmentId, lessonId },
      },
      create: {
        enrollmentId,
        lessonId,
        userId,
        completed,
        quizScore,
        completedAt: completed ? new Date() : null,
      },
      update: {
        completed,
        quizScore,
        completedAt: completed ? new Date() : null,
      },
    });

    // Recalculate progress percentage. calculateProgressPercent guards the
    // div-by-zero (0 lessons → 0%), clamps a stale `completed > total` row so it
    // can't exceed 100%, and neutralises any non-finite count (no `NaN%`).
    const totalLessons = enrollment.course.chapters.reduce(
      (sum: number, ch: { lessons: { id: string }[] }) =>
        sum + ch.lessons.length,
      0,
    );
    const completedLessons = await prisma.courseLessonProgress.count({
      where: { enrollmentId, completed: true },
    });
    const progress = calculateProgressPercent(completedLessons, totalLessons);

    await prisma.enrollment.update({
      where: { id: enrollmentId },
      data: { progress },
    });

    return { success: true, data: { progress } };
  } catch (error) {
    logger.error({ error, userId, lessonId }, "Update lesson progress error");
    return {
      success: false,
      error: "Failed to update progress",
      code: "INTERNAL",
    };
  }
}

export async function getUserEnrollments(
  userId: string,
  pagination: { limit?: number; skip?: number } = {},
): Promise<ServiceResult<unknown[]>> {
  try {
    // IDOR-safe: enrollments are always scoped to the caller's own `userId`.
    const { take, skip } = clampPagination(pagination.limit, pagination.skip);
    const enrollments = await prisma.enrollment.findMany({
      where: { userId },
      include: {
        course: {
          select: {
            id: true,
            title: true,
            slug: true,
            image: true,
            level: true,
          },
        },
        lessonProgress: true,
      },
      orderBy: { updatedAt: "desc" },
      take,
      skip,
    });

    return { success: true, data: enrollments };
  } catch (error) {
    logger.error({ error, userId }, "Get enrollments service error");
    return { success: false, error: "Failed to fetch enrollments" };
  }
}

export async function getGlossaryTerms(
  search?: string,
  pagination: { limit?: number; skip?: number } = {},
): Promise<ServiceResult<unknown[]>> {
  try {
    const where: Record<string, unknown> = {};
    if (search) {
      where.OR = [
        { term: { contains: search, mode: "insensitive" } },
        { definition: { contains: search, mode: "insensitive" } },
      ];
    }

    const { take, skip } = clampPagination(pagination.limit, pagination.skip);
    const terms = await prisma.glossaryTerm.findMany({
      where,
      orderBy: { term: "asc" },
      take,
      skip,
    });

    return { success: true, data: terms };
  } catch (error) {
    logger.error({ error }, "Get glossary terms service error");
    return { success: false, error: "Failed to fetch glossary terms" };
  }
}
