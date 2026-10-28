/**
 * Pure logic for course actions (extracted from courses.ts).
 *
 * Holds the create-input validation, the Prisma `where`-clause builder, and
 * the courseId guard used by the course server actions. Extracted so they can
 * be unit tested without importing the action (which drags Prisma + Clerk).
 * The actions in courses.ts call these helpers.
 *
 * @see apps/admin/__tests__/actions/courses.test.ts
 */

export interface CourseInput {
  slug: string;
  title: string;
  description: string;
  image?: string;
  level: string;
  duration: string;
  topics: string[];
  published?: boolean;
  order?: number;
}

export interface CourseFilter {
  published?: boolean;
  level?: string;
}

/**
 * Validates required fields for createCourse.
 * Returns the error message when invalid, or null when valid.
 */
export function validateCourseInput(data: Partial<CourseInput>): string | null {
  if (
    !data.slug ||
    !data.title ||
    !data.description ||
    !data.level ||
    !data.duration
  ) {
    return "Missing required fields: slug, title, description, level, duration";
  }
  return null;
}

/**
 * Builds the Prisma `where` clause from filter params.
 */
export function buildCourseFilter(
  filters?: CourseFilter,
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (filters?.published !== undefined) where.published = filters.published;
  if (filters?.level) where.level = filters.level;
  return where;
}

/**
 * Validates courseId for update/delete operations.
 */
export function validateCourseId(
  courseId: string | undefined | null,
): string | null {
  if (!courseId) return "courseId is required";
  return null;
}
