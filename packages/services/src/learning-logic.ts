/**
 * Learning pure-logic helpers (service layer).
 *
 * Side-effect-free calculation / gating helpers used by `learning.service.ts`
 * (courses & lessons list, enrollment progress %, course-completion status,
 * lesson ordering, list pagination, and the premium/entitlement gate). They are
 * isolated here — away from the Prisma-importing service — so they can be
 * unit-tested without opening a DB connection at import time, and, critically,
 * so the LIVE learning path runs the SAME hardened math/gate the unit tests
 * assert (no shadow). The previous `apps/web/__tests__/actions/learning.test.ts`
 * reimplemented all of this inline and asserted the copies; this module is the
 * real, exported source both the service and the test now call.
 *
 * Behaviour here is identical, for FINITE / in-range inputs, to the logic that
 * previously lived inline in the service. The only intentional behavioural
 * differences are defensive:
 *   - progress % can no longer be `NaN`/`Infinity`/negative or exceed 100 when a
 *     corrupt count (0 total, completed > total, non-finite) is fed in;
 *   - locked ADVANCED-course content fails CLOSED for FREE/unentitled callers;
 *   - an Invalid-Date `completedAt` no longer throws `RangeError` on
 *     `.toISOString()` (it surfaces `null`).
 */

import { hasFeatureAccess } from "@usemoney/core";

// ---------------------------------------------------------------------------
// Non-finite guard (local copy — mirrors dashboard-logic.ts#finite)
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 * `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback` (default 0).
 * Used so a corrupt lesson/enrollment count can never poison a ratio or a
 * `Math.round` that ends up rendered to the user.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Pagination (mirrors notifications-pagination.ts#clampPagination)
// ---------------------------------------------------------------------------

/** Default page size for a learning list when `limit` is omitted/unusable. */
export const DEFAULT_LEARNING_LIMIT = 50;

/**
 * Hard ceiling on a single learning-list page. Bounds memory + payload
 * regardless of what a caller (or a hand-crafted `?limit=` query) asks for.
 */
export const MAX_LEARNING_LIMIT = 200;

export interface PaginationBounds {
  /** Safe `take`: integer in [1, MAX_LEARNING_LIMIT]. */
  take: number;
  /** Safe `skip`: non-negative integer. */
  skip: number;
}

/**
 * Coerce a possibly-untrusted numeric input to a finite integer, or `null` when
 * it can't be (NaN, ±Infinity, non-number). Floats are truncated toward zero.
 */
function toFiniteInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/**
 * Clamp a (limit, skip) pair into safe Prisma `take`/`skip` bounds.
 *
 * Without clamping a `NaN` / negative / absurd `take`|`skip` flows straight to
 * `prisma.*.findMany`. Prisma 5 THROWS on a non-finite or negative `take`/`skip`
 * (`Invalid value … Expected Int`), turning a stray query string into a 500, and
 * an un-capped `take` lets a single request page the entire table into memory.
 *
 * - `limit`: NaN / Infinity / non-number / ≤ 0 → DEFAULT_LEARNING_LIMIT;
 *   anything above MAX_LEARNING_LIMIT is capped to it; floats truncated.
 * - `skip`: NaN / Infinity / non-number / negative → 0; floats truncated.
 *
 * Pure + total: never throws, always returns finite positive `take` and
 * non-negative `skip`.
 */
export function clampPagination(
  limit: unknown = DEFAULT_LEARNING_LIMIT,
  skip: unknown = 0,
): PaginationBounds {
  const rawLimit = toFiniteInt(limit);
  const take =
    rawLimit === null || rawLimit <= 0
      ? DEFAULT_LEARNING_LIMIT
      : Math.min(rawLimit, MAX_LEARNING_LIMIT);

  const rawSkip = toFiniteInt(skip);
  const safeSkip = rawSkip === null || rawSkip < 0 ? 0 : rawSkip;

  return { take, skip: safeSkip };
}

// ---------------------------------------------------------------------------
// Progress %
// ---------------------------------------------------------------------------

/** A course is considered complete at (and above) this progress percentage. */
export const COURSE_COMPLETE_PERCENT = 100;

/**
 * Course/enrollment progress as an integer percentage in `[0, 100]`.
 *
 * The live recalculation did `total > 0 ? Math.round((done/total)*100) : 0`,
 * which guards the div-by-zero (0 lessons → 0%) but NOT:
 *   - `completed > total` → e.g. 12/10 → 120% (a stale orphaned progress row
 *     after lessons were deleted), and
 *   - a non-finite `done`/`total` → `Math.round(NaN)` → `NaN%`.
 *
 * This hardened version funnels both counts through {@link finite}, treats a
 * non-positive total as 0% (no lessons yet ⇒ nothing to complete), clamps the
 * completed count to `[0, total]` so the ratio can never exceed 1, and rounds
 * to an integer in `[0, 100]`. Behaviour is identical for the normal
 * `0 ≤ completed ≤ total`, `total > 0` case.
 */
export function calculateProgressPercent(
  completed: number | null | undefined,
  total: number | null | undefined,
): number {
  const totalSafe = finite(total);
  if (totalSafe <= 0) return 0;
  // Clamp completed into [0, total] so a corrupt/stale row can't yield >100% or
  // a negative percentage.
  const completedSafe = Math.min(Math.max(finite(completed), 0), totalSafe);
  return Math.round((completedSafe / totalSafe) * 100);
}

/**
 * Whether a given progress percentage means the course is complete (≥ 100%).
 * Non-finite input fails closed to "not complete" (we never fabricate a
 * completion from a `NaN`).
 */
export function isCourseCompleted(
  progressPercent: number | null | undefined,
): boolean {
  return finite(progressPercent) >= COURSE_COMPLETE_PERCENT;
}

// ---------------------------------------------------------------------------
// Lesson / chapter counting & ordering
// ---------------------------------------------------------------------------

/** Minimal chapter shape carrying its lessons (or just a lesson count). */
export interface ChapterWithLessons {
  lessons: { id: string }[];
}

/**
 * Total lesson count across all chapters of a course — the denominator the
 * service uses for the progress %. An empty `chapters` array (or chapters with
 * empty `lessons`) yields 0 (so {@link calculateProgressPercent} short-circuits
 * to 0% rather than dividing by zero).
 */
export function countTotalLessons(
  chapters: ReadonlyArray<ChapterWithLessons> | null | undefined,
): number {
  if (!chapters || chapters.length === 0) return 0;
  return chapters.reduce(
    (sum, ch) => sum + (Array.isArray(ch.lessons) ? ch.lessons.length : 0),
    0,
  );
}

/** Minimal shape for anything carried in an explicit display order. */
export interface Ordered {
  order: number | null | undefined;
}

/**
 * Stable ascending sort by `order` (chapters within a course, lessons within a
 * chapter). The DB query already `orderBy: { order: "asc" }`, but callers that
 * assemble/merge lists (e.g. demo data, or progress merged into the tree)
 * re-sort with this so ordering is deterministic and a `null`/`NaN` order sinks
 * to the end instead of throwing the comparator into NaN-land. Does not mutate
 * the input.
 */
export function sortByOrder<T extends Ordered>(items: ReadonlyArray<T>): T[] {
  return [...items].sort((a, b) => {
    const ao = Number.isFinite(a.order as number)
      ? (a.order as number)
      : Number.POSITIVE_INFINITY;
    const bo = Number.isFinite(b.order as number)
      ? (b.order as number)
      : Number.POSITIVE_INFINITY;
    return ao - bo;
  });
}

// ---------------------------------------------------------------------------
// Premium / entitlement gate (fail closed)
// ---------------------------------------------------------------------------

/** Course levels that are free for everyone. ADVANCED is the gated tier. */
export const FREE_COURSE_LEVELS = ["BEGINNER", "INTERMEDIATE"] as const;

/** The level string that requires a paid entitlement to unlock. */
export const GATED_COURSE_LEVEL = "ADVANCED";

/**
 * Whether a course of `courseLevel` must be gated behind the `advancedCourses`
 * entitlement for `planId`.
 *
 * Only `ADVANCED` courses are gated; BEGINNER/INTERMEDIATE (and any
 * unrecognised level) are free. The entitlement check delegates to the SINGLE
 * SOURCE OF TRUTH (`@usemoney/core` `hasFeatureAccess(planId, "advancedCourses")`
 * → PREMIUM/ULTIMATE), so the inline `["PREMIUM","ULTIMATE"].includes(planId)`
 * copy in the old shadow test (which also missed legacy-plan resolution like
 * `AI_UNLIMITED`) can no longer drift from production.
 *
 * Fails CLOSED: a `null`/`undefined`/garbage `planId` resolves to no access, so
 * the ADVANCED course is gated.
 */
export function shouldGateAdvancedCourse(
  courseLevel: string | null | undefined,
  planId: string | null | undefined,
): boolean {
  if (courseLevel !== GATED_COURSE_LEVEL) return false;
  return !hasFeatureAccess(planId ?? "", "advancedCourses");
}

/**
 * Whether a caller on `planId` may be served the *content* of a lesson that
 * belongs to a course of `courseLevel`. This is the inverse of
 * {@link shouldGateAdvancedCourse} and is the fail-closed gate the service uses
 * before returning a lesson's `content` / `videoUrl`: a locked ADVANCED lesson
 * is NEVER served to a FREE/unentitled user (defence in depth — the UI hiding a
 * lock is not a security control).
 */
export function canAccessLessonContent(
  courseLevel: string | null | undefined,
  planId: string | null | undefined,
): boolean {
  return !shouldGateAdvancedCourse(courseLevel, planId);
}

// ---------------------------------------------------------------------------
// Invalid-Date-safe completion timestamp (consumer safety)
// ---------------------------------------------------------------------------

/**
 * True when `d` is a usable, finite calendar date (not `null`, not
 * `new Date("garbage")`). Guards every downstream `.toISOString()` that would
 * otherwise throw `RangeError`.
 */
export function isValidDate(d: Date | null | undefined): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/**
 * A `YYYY-MM-DD` string for a valid `completedAt` (or any date), else `null`.
 * Never throws — an Invalid-Date `completedAt` (a corrupt row) surfaces an
 * honest `null` instead of crashing the course/enrollment serializer.
 */
export function safeIsoDate(d: Date | null | undefined): string | null {
  if (!isValidDate(d)) return null;
  return d.toISOString().split("T")[0] ?? null;
}
