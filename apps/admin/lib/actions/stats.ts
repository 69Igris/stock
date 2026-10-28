"use server";

import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { computeContentStats } from "./stats-logic";

export async function getContentStats() {
  await requireAdmin();
  const [courses, chapters, lessons, enrollments] = await Promise.all([
    prisma.course.count(),
    prisma.chapter.count(),
    prisma.courseLesson.count(),
    prisma.enrollment.count(),
  ]);

  const publishedCourses = await prisma.course.count({
    where: { published: true },
  });

  return computeContentStats({
    courses,
    publishedCourses,
    chapters,
    lessons,
    enrollments,
  });
}
