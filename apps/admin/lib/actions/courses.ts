"use server";

import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import {
  validateCourseInput,
  buildCourseFilter,
  validateCourseId,
} from "./courses-logic";

export async function getCourses(filters?: {
  published?: boolean;
  level?: string;
}) {
  await requireAdmin();
  const where = buildCourseFilter(filters);

  return prisma.course.findMany({
    where,
    include: {
      _count: { select: { chapters: true, enrollments: true } },
    },
    orderBy: { order: "asc" },
  });
}

export async function getCourseById(courseId: string) {
  await requireAdmin();
  return prisma.course.findUnique({
    where: { id: courseId },
    include: {
      chapters: {
        include: {
          lessons: {
            include: { quizzes: { orderBy: { order: "asc" } } },
            orderBy: { order: "asc" },
          },
        },
        orderBy: { order: "asc" },
      },
      _count: { select: { enrollments: true } },
    },
  });
}

export async function createCourse(data: {
  slug: string;
  title: string;
  description: string;
  image?: string;
  level: string;
  duration: string;
  topics: string[];
  published?: boolean;
  order?: number;
}) {
  await requireAdmin();
  const validationError = validateCourseInput(data);
  if (validationError) {
    throw new Error(validationError);
  }
  return prisma.course.create({ data });
}

export async function updateCourse(
  courseId: string,
  data: Partial<{
    title: string;
    description: string;
    image: string;
    level: string;
    duration: string;
    topics: string[];
    published: boolean;
    order: number;
  }>,
) {
  await requireAdmin();
  const validationError = validateCourseId(courseId);
  if (validationError) throw new Error(validationError);
  return prisma.course.update({ where: { id: courseId }, data });
}

export async function deleteCourse(courseId: string) {
  await requireAdmin();
  const validationError = validateCourseId(courseId);
  if (validationError) throw new Error(validationError);
  return prisma.course.delete({ where: { id: courseId } });
}

export async function publishCourse(courseId: string, published: boolean) {
  await requireAdmin();
  return prisma.course.update({
    where: { id: courseId },
    data: { published },
  });
}
