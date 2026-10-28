/**
 * Pure logic for chapter actions (extracted from chapters.ts).
 *
 * These helpers hold the input-validation and ordering rules that the
 * server actions in `chapters.ts` call. They live in a separate module with
 * no `"use server"` directive and no Prisma/Clerk imports so they can be unit
 * tested directly (importing the action would drag server-only deps).
 *
 * @see apps/admin/__tests__/actions/chapters.test.ts
 */

export interface ChapterInput {
  courseId: string;
  title: string;
  order?: number;
}

export interface ChapterOrderRecord {
  id: string;
  courseId: string;
  title: string;
  order: number;
}

/**
 * Validates required fields for createChapter.
 * Returns the error message when invalid, or null when valid.
 */
export function validateChapterInput(
  data: Partial<ChapterInput>,
): string | null {
  if (!data.courseId || !data.title) {
    return "Missing required fields: courseId, title";
  }
  return null;
}

/**
 * Computes the next order value for a new chapter given existing chapters.
 */
export function getNextChapterOrder(
  existingChapters: ChapterOrderRecord[],
): number {
  if (existingChapters.length === 0) return 0;
  const maxOrder = Math.max(...existingChapters.map((c) => c.order));
  return maxOrder + 1;
}

/**
 * Reorders chapters after one is deleted.
 * Returns new order assignments: [{ id, newOrder }].
 */
export function reorderAfterDelete(
  chapters: ChapterOrderRecord[],
  deletedId: string,
): Array<{ id: string; newOrder: number }> {
  return chapters
    .filter((c) => c.id !== deletedId)
    .sort((a, b) => a.order - b.order)
    .map((c, index) => ({ id: c.id, newOrder: index }));
}
