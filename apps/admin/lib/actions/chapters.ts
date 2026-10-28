"use server";

import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { validateChapterInput } from "./chapters-logic";

export async function createChapter(data: {
  courseId: string;
  title: string;
  order?: number;
}) {
  await requireAdmin();
  const validationError = validateChapterInput(data);
  if (validationError) {
    throw new Error(validationError);
  }
  return prisma.chapter.create({ data });
}

export async function updateChapter(
  chapterId: string,
  data: Partial<{ title: string; order: number }>,
) {
  await requireAdmin();
  return prisma.chapter.update({ where: { id: chapterId }, data });
}

export async function deleteChapter(chapterId: string) {
  await requireAdmin();
  return prisma.chapter.delete({ where: { id: chapterId } });
}
