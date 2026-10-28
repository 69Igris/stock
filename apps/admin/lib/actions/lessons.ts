"use server";

import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import {
  validateLessonInput,
  resolveDefaultType,
  resolveDefaultOrder,
} from "./lessons-logic";

export async function createLesson(data: {
  chapterId: string;
  title: string;
  content: string;
  type?: string;
  videoUrl?: string;
  duration?: string;
  order?: number;
}) {
  await requireAdmin();
  const validationError = validateLessonInput(data);
  if (validationError) {
    throw new Error(validationError);
  }
  return prisma.courseLesson.create({
    data: {
      chapterId: data.chapterId,
      title: data.title,
      content: data.content,
      type: resolveDefaultType(data.type),
      videoUrl: data.videoUrl,
      duration: data.duration,
      order: resolveDefaultOrder(data.order),
    },
  });
}

export async function updateLesson(
  lessonId: string,
  data: Partial<{
    title: string;
    content: string;
    type: string;
    videoUrl: string;
    duration: string;
    order: number;
  }>,
) {
  await requireAdmin();
  return prisma.courseLesson.update({ where: { id: lessonId }, data });
}

export async function deleteLesson(lessonId: string) {
  await requireAdmin();
  return prisma.courseLesson.delete({ where: { id: lessonId } });
}

export async function getLessonById(lessonId: string) {
  await requireAdmin();
  return prisma.courseLesson.findUnique({
    where: { id: lessonId },
    include: {
      quizzes: { orderBy: { order: "asc" } },
      chapter: { include: { course: true } },
    },
  });
}
