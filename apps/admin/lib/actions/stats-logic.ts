/**
 * Pure logic for content-stats action (extracted from stats.ts).
 *
 * Holds the count → ContentStats computation used by getContentStats, plus
 * display/validation helpers over that shape. Extracted so it can be unit
 * tested without importing the action (which drags Prisma + Clerk).
 * getContentStats calls `computeContentStats`.
 *
 * Note: the real stats surface does NOT track glossary terms — the shape here
 * matches getContentStats's actual return value (courses, publishedCourses,
 * draftCourses, chapters, lessons, enrollments).
 *
 * @see apps/admin/__tests__/actions/stats.test.ts
 */

export interface ContentStats {
  courses: number;
  publishedCourses: number;
  draftCourses: number;
  chapters: number;
  lessons: number;
  enrollments: number;
}

export interface RawCounts {
  courses: number;
  publishedCourses: number;
  chapters: number;
  lessons: number;
  enrollments: number;
}

/**
 * Computes the full ContentStats object from raw count values.
 * `draftCourses` is derived as `courses - publishedCourses`.
 */
export function computeContentStats(raw: RawCounts): ContentStats {
  return {
    courses: raw.courses,
    publishedCourses: raw.publishedCourses,
    draftCourses: raw.courses - raw.publishedCourses,
    chapters: raw.chapters,
    lessons: raw.lessons,
    enrollments: raw.enrollments,
  };
}

/**
 * Validates that draftCourses = courses - publishedCourses.
 */
export function validateDraftCalculation(stats: ContentStats): boolean {
  return stats.draftCourses === stats.courses - stats.publishedCourses;
}

/**
 * Returns a summary string for stats display.
 */
export function formatStatsSummary(stats: ContentStats): string {
  return `${stats.courses} courses (${stats.publishedCourses} published, ${stats.draftCourses} drafts), ${stats.chapters} chapters, ${stats.lessons} lessons, ${stats.enrollments} enrollments`;
}
