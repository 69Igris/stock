/**
 * Pure logic for lesson actions (extracted from lessons.ts).
 *
 * Holds the create-input validation and the default resolution for `type` and
 * `order` used by the lesson server actions, plus the lesson-type constants.
 * Extracted so they can be unit tested without importing the action (which
 * drags Prisma + Clerk). The actions in lessons.ts call these helpers.
 *
 * @see apps/admin/__tests__/actions/lessons.test.ts
 */

export interface LessonInput {
  chapterId: string;
  title: string;
  content: string;
  type?: string;
  videoUrl?: string;
  duration?: string;
  order?: number;
}

export const VALID_LESSON_TYPES = [
  "TEXT",
  "VIDEO",
  "AUDIO",
  "DOCUMENT",
] as const;

/**
 * Validates required fields for createLesson.
 * Returns the error message when invalid, or null when valid.
 */
export function validateLessonInput(data: Partial<LessonInput>): string | null {
  if (!data.chapterId || !data.title || !data.type) {
    return "Missing required fields: chapterId, title, type";
  }
  return null;
}

/**
 * Returns the default order value for a lesson when none is specified.
 * Mirrors: `data.order || 0` from source.
 */
export function resolveDefaultOrder(order: number | undefined): number {
  return order || 0;
}

/**
 * Returns the default type for a lesson when none is specified.
 * Mirrors: `data.type || "TEXT"` from source.
 */
export function resolveDefaultType(type: string | undefined): string {
  return type || "TEXT";
}

/**
 * Validates the lesson type against allowed values.
 */
export function isValidLessonType(type: string): boolean {
  return (VALID_LESSON_TYPES as readonly string[]).includes(type);
}

/**
 * Checks if a VIDEO lesson has a videoUrl.
 */
export function videoLessonRequiresUrl(
  type: string,
  videoUrl: string | undefined,
): boolean {
  if (type === "VIDEO" && !videoUrl) return false;
  return true;
}
