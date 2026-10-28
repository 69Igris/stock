/**
 * Learning Service — pure-logic + LIVE-service tests (MONEY-620).
 *
 * DE-SHADOWED. The previous version of this file reimplemented the ENTIRE
 * learning logic inline (buildCourseFilter, calculateLessonCount,
 * calculateProgress, shouldGateCourse, buildSearchFilter, shouldMarkCompleted,
 * buildLessonProgressData) and asserted the COPIES — a textbook shadow. It was
 * green while testing nothing real, and its inline `shouldGateCourse` had
 * already drifted: it hard-coded `["PREMIUM","ULTIMATE"].includes(planId)` and
 * so silently MISSED legacy-plan resolution (`AI_UNLIMITED` → PREMIUM), and it
 * never executed the live progress recompute (which had a real `>100%` /
 * `NaN%` bug) or any IDOR / premium-content gate.
 *
 * This rewrite asserts the REAL exported logic two ways:
 *
 *   1. PURE LOGIC — imports the real exports from
 *      `packages/services/src/learning-logic.ts` (a pure, Prisma-free module the
 *      live service CALLS) via a relative path, and drives them with adversarial
 *      fixtures: 0-lesson div-by-zero, completed>total >100%, non-finite counts,
 *      garbage/legacy plan ids on the gate, NaN/negative/huge pagination,
 *      Invalid-Date completedAt.
 *
 *   2. LIVE SERVICE — drives the REAL learning.service functions (getCourses,
 *      getCourseBySlug, getLessonById, updateLessonProgress, getUserEnrollments,
 *      getGlossaryTerms) against a RECORDING prisma stub injected at the
 *      `@usemoney/database` module boundary via `require.cache` (the established
 *      subscription-service-edge-cases / demo-routes seam). So the production
 *      access-control path and these tests execute the SAME code — including the
 *      fail-closed premium-content gate, the IDOR (userId-scoped) reads/writes,
 *      the progress-% fix, and the pagination clamp passed to Prisma.
 *
 * Source under test:
 *   - packages/services/src/learning-logic.ts
 *   - packages/services/src/learning.service.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── REAL pure logic (relative import — module is pure, no DB side-effects) ──
import {
  finite,
  clampPagination,
  DEFAULT_LEARNING_LIMIT,
  MAX_LEARNING_LIMIT,
  calculateProgressPercent,
  isCourseCompleted,
  COURSE_COMPLETE_PERCENT,
  countTotalLessons,
  sortByOrder,
  shouldGateAdvancedCourse,
  canAccessLessonContent,
  GATED_COURSE_LEVEL,
  isValidDate,
  safeIsoDate,
} from "../../../../packages/services/src/learning-logic";

// ════════════════════════════════════════════════════════════════════
// PART 1 — PURE LEARNING LOGIC (real exports)
// ════════════════════════════════════════════════════════════════════

describe("learning-logic: finite (non-finite guard)", () => {
  it("passes finite numbers through unchanged", () => {
    assert.equal(finite(0), 0);
    assert.equal(finite(42), 42);
    assert.equal(finite(-7.5), -7.5);
  });

  it("collapses null/undefined/NaN/±Infinity to the fallback (default 0)", () => {
    assert.equal(finite(null), 0);
    assert.equal(finite(undefined), 0);
    assert.equal(finite(NaN), 0);
    assert.equal(finite(Number.POSITIVE_INFINITY), 0);
    assert.equal(finite(Number.NEGATIVE_INFINITY), 0);
    assert.equal(finite(NaN, 99), 99);
  });
});

describe("learning-logic: calculateProgressPercent", () => {
  // Behaviour preserved for the normal 0 ≤ completed ≤ total, total > 0 case.
  it("0 of 10 → 0%", () => {
    assert.equal(calculateProgressPercent(0, 10), 0);
  });

  it("5 of 10 → 50%", () => {
    assert.equal(calculateProgressPercent(5, 10), 50);
  });

  it("10 of 10 → 100%", () => {
    assert.equal(calculateProgressPercent(10, 10), 100);
  });

  it("1 of 1 → 100% (single-lesson course)", () => {
    assert.equal(calculateProgressPercent(1, 1), 100);
  });

  it("rounds to the nearest integer (1 of 3 → 33, 2 of 3 → 67)", () => {
    assert.equal(calculateProgressPercent(1, 3), 33);
    assert.equal(calculateProgressPercent(2, 3), 67);
    assert.equal(calculateProgressPercent(3, 7), 43);
  });

  // ── BUG: div-by-zero (0 lessons) ──
  it("[bug:div-by-zero] 0 of 0 lessons → 0% (NOT NaN%)", () => {
    // Failing input before the guard: total=0 → completed/total = 0/0 = NaN →
    // Math.round(NaN) = NaN → "NaN%" rendered. Guarded to 0%.
    assert.equal(calculateProgressPercent(0, 0), 0);
    assert.equal(Number.isNaN(calculateProgressPercent(0, 0)), false);
  });

  it("[bug:div-by-zero] 3 'completed' against 0 total → 0% (no Infinity)", () => {
    // 3/0 = Infinity → Math.round(Infinity) = Infinity. Guarded to 0.
    const p = calculateProgressPercent(3, 0);
    assert.equal(p, 0);
    assert.equal(Number.isFinite(p), true);
  });

  it("[bug:div-by-zero] negative total → 0%", () => {
    assert.equal(calculateProgressPercent(0, -1), 0);
    assert.equal(calculateProgressPercent(5, -10), 0);
  });

  // ── BUG: completed > total → >100% ──
  it("[bug:over-100] 12 of 10 (stale orphaned progress) → 100%, never 120%", () => {
    // Failing input before the clamp: 12/10*100 = 120. Stale CourseLessonProgress
    // rows can outnumber the lessons after a lesson is deleted. Clamped to 100.
    assert.equal(calculateProgressPercent(12, 10), 100);
  });

  it("[bug:over-100] completed equal to a huge multiple of total still caps at 100", () => {
    assert.equal(calculateProgressPercent(1000, 4), 100);
  });

  it("[edge] negative completed → 0% (clamped, never negative)", () => {
    assert.equal(calculateProgressPercent(-5, 10), 0);
  });

  // ── BUG: non-finite counts ──
  it("[bug:non-finite] NaN completed → 0% (NOT NaN%)", () => {
    assert.equal(calculateProgressPercent(NaN, 10), 0);
  });

  it("[bug:non-finite] Infinity completed → capped at 100%", () => {
    // finite(Infinity)=0 → clamp keeps 0 → 0%. The point: never Infinity%.
    const p = calculateProgressPercent(Number.POSITIVE_INFINITY, 10);
    assert.equal(Number.isFinite(p), true);
    assert.ok(p >= 0 && p <= 100);
  });

  it("[bug:non-finite] non-finite total → 0%", () => {
    assert.equal(calculateProgressPercent(5, NaN), 0);
    assert.equal(calculateProgressPercent(5, Number.POSITIVE_INFINITY), 0);
  });

  it("[bug:non-finite] null/undefined counts → 0% (no throw)", () => {
    assert.equal(calculateProgressPercent(null, null), 0);
    assert.equal(calculateProgressPercent(undefined, 10), 0);
    assert.equal(calculateProgressPercent(5, undefined), 0);
  });

  it("[consumer-safety] result is ALWAYS a finite integer in [0,100]", () => {
    const inputs: Array<
      [number | null | undefined, number | null | undefined]
    > = [
      [0, 0],
      [12, 10],
      [NaN, NaN],
      [Infinity, 3],
      [-3, 10],
      [1, 3],
      [null, undefined],
      [7, 9],
    ];
    for (const [c, t] of inputs) {
      const p = calculateProgressPercent(c, t);
      assert.equal(
        Number.isInteger(p),
        true,
        `not integer for ${c}/${t}: ${p}`
      );
      assert.ok(p >= 0 && p <= 100, `out of range for ${c}/${t}: ${p}`);
    }
  });
});

describe("learning-logic: isCourseCompleted", () => {
  it("≥ 100% is complete; below is not", () => {
    assert.equal(isCourseCompleted(100), true);
    assert.equal(isCourseCompleted(99.9), false);
    assert.equal(isCourseCompleted(0), false);
    assert.equal(isCourseCompleted(50), false);
  });

  it("exactly the COURSE_COMPLETE_PERCENT threshold is complete", () => {
    assert.equal(isCourseCompleted(COURSE_COMPLETE_PERCENT), true);
  });

  it("[edge] non-finite/null progress fails closed to NOT complete", () => {
    // finite(NaN/±Infinity) collapses to 0, so 0 >= 100 is false everywhere —
    // we never fabricate a completion from a corrupt percentage.
    assert.equal(isCourseCompleted(NaN), false);
    assert.equal(isCourseCompleted(Number.POSITIVE_INFINITY), false);
    assert.equal(isCourseCompleted(Number.NEGATIVE_INFINITY), false);
    assert.equal(isCourseCompleted(null), false);
    assert.equal(isCourseCompleted(undefined), false);
  });

  it("composes with calculateProgressPercent (10/10 done → complete; 9/10 → not)", () => {
    assert.equal(isCourseCompleted(calculateProgressPercent(10, 10)), true);
    assert.equal(isCourseCompleted(calculateProgressPercent(9, 10)), false);
    // The over-100 stale row still reads as complete (capped at 100), not 120.
    assert.equal(isCourseCompleted(calculateProgressPercent(12, 10)), true);
  });
});

describe("learning-logic: countTotalLessons", () => {
  it("sums lessons across chapters", () => {
    const chapters = [
      { lessons: [{ id: "a" }, { id: "b" }, { id: "c" }] },
      { lessons: [{ id: "d" }, { id: "e" }] },
    ];
    assert.equal(countTotalLessons(chapters), 5);
  });

  it("[empty-course] no chapters → 0", () => {
    assert.equal(countTotalLessons([]), 0);
    assert.equal(countTotalLessons(null), 0);
    assert.equal(countTotalLessons(undefined), 0);
  });

  it("[no-lessons] chapters with empty lesson arrays → 0", () => {
    assert.equal(countTotalLessons([{ lessons: [] }, { lessons: [] }]), 0);
  });

  it("mixed empty and non-empty chapters", () => {
    assert.equal(
      countTotalLessons([
        { lessons: [] },
        { lessons: [{ id: "x" }, { id: "y" }] },
        { lessons: [] },
        { lessons: [{ id: "z" }] },
      ]),
      3
    );
  });

  it("[consumer-safety] feeds a safe denominator into the progress %", () => {
    // empty course → 0 lessons → progress of any 'completed' is 0%, never NaN.
    const total = countTotalLessons([]);
    assert.equal(calculateProgressPercent(0, total), 0);
    assert.equal(calculateProgressPercent(3, total), 0);
  });
});

describe("learning-logic: sortByOrder (lesson/chapter ordering)", () => {
  it("sorts ascending by order, does not mutate input", () => {
    const input = [
      { id: "c", order: 2 },
      { id: "a", order: 0 },
      { id: "b", order: 1 },
    ];
    const out = sortByOrder(input);
    assert.deepEqual(
      out.map((x) => x.id),
      ["a", "b", "c"]
    );
    // original untouched
    assert.deepEqual(
      input.map((x) => x.id),
      ["c", "a", "b"]
    );
  });

  it("is a stable sort for equal orders (preserves insertion order)", () => {
    const input = [
      { id: "first", order: 1 },
      { id: "second", order: 1 },
      { id: "third", order: 1 },
    ];
    assert.deepEqual(
      sortByOrder(input).map((x) => x.id),
      ["first", "second", "third"]
    );
  });

  it("[edge] null/NaN order sinks to the end instead of corrupting the sort", () => {
    const input = [
      { id: "nullord", order: null },
      { id: "two", order: 2 },
      { id: "nanord", order: NaN },
      { id: "one", order: 1 },
    ];
    const out = sortByOrder(input).map((x) => x.id);
    // real orders first (1,2), then the non-finite ones (in their relative order)
    assert.deepEqual(out.slice(0, 2), ["one", "two"]);
    assert.ok(out.indexOf("nullord") >= 2);
    assert.ok(out.indexOf("nanord") >= 2);
  });

  it("empty array → empty array", () => {
    assert.deepEqual(sortByOrder([]), []);
  });
});

describe("learning-logic: shouldGateAdvancedCourse (premium gate, fail closed)", () => {
  it("does NOT gate BEGINNER/INTERMEDIATE for any plan (free for all)", () => {
    assert.equal(shouldGateAdvancedCourse("BEGINNER", "FREE"), false);
    assert.equal(shouldGateAdvancedCourse("BEGINNER", "PRO"), false);
    assert.equal(shouldGateAdvancedCourse("INTERMEDIATE", "FREE"), false);
    assert.equal(shouldGateAdvancedCourse("INTERMEDIATE", "PRO"), false);
  });

  it("GATES ADVANCED for FREE and PRO (no advancedCourses entitlement)", () => {
    assert.equal(shouldGateAdvancedCourse(GATED_COURSE_LEVEL, "FREE"), true);
    assert.equal(shouldGateAdvancedCourse("ADVANCED", "PRO"), true);
  });

  it("does NOT gate ADVANCED for PREMIUM / ULTIMATE (entitled)", () => {
    assert.equal(shouldGateAdvancedCourse("ADVANCED", "PREMIUM"), false);
    assert.equal(shouldGateAdvancedCourse("ADVANCED", "ULTIMATE"), false);
  });

  it("[drift-fix] resolves LEGACY plan ids via core (AI_UNLIMITED/AI_PRO → PREMIUM ⇒ unlocked)", () => {
    // The old shadow's inline `["PREMIUM","ULTIMATE"].includes(planId)` returned
    // `true` (gated) for these legacy ids — a real entitlement bug. The live
    // core map resolves them to PREMIUM, so ADVANCED is correctly UNLOCKED.
    assert.equal(shouldGateAdvancedCourse("ADVANCED", "AI_UNLIMITED"), false);
    assert.equal(shouldGateAdvancedCourse("ADVANCED", "AI_PRO"), false);
  });

  it("[SECURITY] null/undefined/empty/garbage plan → GATED (fail closed)", () => {
    assert.equal(shouldGateAdvancedCourse("ADVANCED", null), true);
    assert.equal(shouldGateAdvancedCourse("ADVANCED", undefined), true);
    assert.equal(shouldGateAdvancedCourse("ADVANCED", ""), true);
    assert.equal(shouldGateAdvancedCourse("ADVANCED", "premium"), true); // wrong case
    assert.equal(shouldGateAdvancedCourse("ADVANCED", "SUPER_ADMIN"), true);
    assert.equal(shouldGateAdvancedCourse("ADVANCED", "QUERY_PACK"), true); // addon, not a tier
  });

  it("[SECURITY] an unrecognised course level is treated as free (not gated)", () => {
    assert.equal(shouldGateAdvancedCourse("EXPERT", "FREE"), false);
    assert.equal(shouldGateAdvancedCourse(null, "FREE"), false);
    assert.equal(shouldGateAdvancedCourse(undefined, "FREE"), false);
  });
});

describe("learning-logic: canAccessLessonContent (inverse gate)", () => {
  it("is the exact inverse of shouldGateAdvancedCourse", () => {
    const cases: Array<[string | null, string | null]> = [
      ["ADVANCED", "FREE"],
      ["ADVANCED", "PREMIUM"],
      ["BEGINNER", "FREE"],
      ["ADVANCED", null],
      ["ADVANCED", "AI_UNLIMITED"],
      [null, "FREE"],
    ];
    for (const [level, plan] of cases) {
      assert.equal(
        canAccessLessonContent(level, plan),
        !shouldGateAdvancedCourse(level, plan),
        `mismatch for ${level}/${plan}`
      );
    }
  });

  it("[SECURITY] FREE/unentitled CANNOT access ADVANCED content (fail closed)", () => {
    assert.equal(canAccessLessonContent("ADVANCED", "FREE"), false);
    assert.equal(canAccessLessonContent("ADVANCED", "PRO"), false);
    assert.equal(canAccessLessonContent("ADVANCED", null), false);
    assert.equal(canAccessLessonContent("ADVANCED", "garbage"), false);
  });

  it("PREMIUM/ULTIMATE CAN access ADVANCED content; everyone can access free levels", () => {
    assert.equal(canAccessLessonContent("ADVANCED", "PREMIUM"), true);
    assert.equal(canAccessLessonContent("ADVANCED", "ULTIMATE"), true);
    assert.equal(canAccessLessonContent("BEGINNER", "FREE"), true);
    assert.equal(canAccessLessonContent("INTERMEDIATE", "FREE"), true);
  });
});

describe("learning-logic: clampPagination (list 500 guard, mirrors notifications)", () => {
  it("defaults when limit/skip are omitted", () => {
    assert.deepEqual(clampPagination(), {
      take: DEFAULT_LEARNING_LIMIT,
      skip: 0,
    });
  });

  it("passes a normal in-range limit/skip through", () => {
    assert.deepEqual(clampPagination(25, 10), { take: 25, skip: 10 });
  });

  it("[bug:500] NaN limit → default; NaN skip → 0 (Prisma would THROW on NaN)", () => {
    assert.deepEqual(clampPagination(NaN, NaN), {
      take: DEFAULT_LEARNING_LIMIT,
      skip: 0,
    });
  });

  it("[bug:500] negative limit → default; negative skip → 0", () => {
    assert.deepEqual(clampPagination(-5, -100), {
      take: DEFAULT_LEARNING_LIMIT,
      skip: 0,
    });
  });

  it("[bug:500] ±Infinity limit/skip → default/0", () => {
    assert.deepEqual(
      clampPagination(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
      {
        take: DEFAULT_LEARNING_LIMIT,
        skip: 0,
      }
    );
    assert.deepEqual(clampPagination(Number.NEGATIVE_INFINITY, 0), {
      take: DEFAULT_LEARNING_LIMIT,
      skip: 0,
    });
  });

  it("[bug:memory] a huge limit is capped to MAX_LEARNING_LIMIT", () => {
    assert.equal(clampPagination(10_000, 0).take, MAX_LEARNING_LIMIT);
    assert.equal(
      clampPagination(MAX_LEARNING_LIMIT + 1, 0).take,
      MAX_LEARNING_LIMIT
    );
  });

  it("zero limit → default; floats truncated toward zero", () => {
    assert.equal(clampPagination(0, 0).take, DEFAULT_LEARNING_LIMIT);
    assert.deepEqual(clampPagination(25.9, 10.9), { take: 25, skip: 10 });
  });

  it("[type-safety] non-number inputs (string/null/object) → safe defaults", () => {
    assert.deepEqual(clampPagination("50" as unknown, "5" as unknown), {
      take: DEFAULT_LEARNING_LIMIT,
      skip: 0,
    });
    assert.deepEqual(clampPagination(null, null), {
      take: DEFAULT_LEARNING_LIMIT,
      skip: 0,
    });
    assert.deepEqual(clampPagination({} as unknown, [] as unknown), {
      take: DEFAULT_LEARNING_LIMIT,
      skip: 0,
    });
  });
});

describe("learning-logic: isValidDate / safeIsoDate (Invalid-Date completedAt)", () => {
  it("isValidDate accepts a real Date, rejects null/non-Date/Invalid Date", () => {
    assert.equal(isValidDate(new Date("2026-01-01T00:00:00.000Z")), true);
    assert.equal(isValidDate(null), false);
    assert.equal(isValidDate(undefined), false);
    assert.equal(isValidDate("2026-01-01" as unknown as Date), false);
    assert.equal(isValidDate(new Date("garbage")), false);
    assert.equal(isValidDate(new Date(NaN)), false);
  });

  it("safeIsoDate returns YYYY-MM-DD for a valid completedAt", () => {
    assert.equal(
      safeIsoDate(new Date("2026-03-15T10:30:00.000Z")),
      "2026-03-15"
    );
  });

  it("[bug:toISOString-throw] Invalid-Date completedAt → null, never throws RangeError", () => {
    // `new Date("garbage").toISOString()` throws RangeError; a corrupt
    // completedAt row must surface null, not crash the serializer.
    assert.doesNotThrow(() => safeIsoDate(new Date("garbage")));
    assert.equal(safeIsoDate(new Date("garbage")), null);
    assert.equal(safeIsoDate(new Date(NaN)), null);
    assert.equal(safeIsoDate(null), null);
    assert.equal(safeIsoDate(undefined), null);
  });
});

// ════════════════════════════════════════════════════════════════════
// PART 2 — LIVE SERVICE via recording-prisma seam (require.cache)
// ════════════════════════════════════════════════════════════════════

// ── Minimal row shapes the live service reads ──────────────────────────

interface LessonRow {
  id: string;
  title: string;
  content: string;
  videoUrl: string | null;
  type: string;
  order: number;
  chapter: {
    id: string;
    title: string;
    courseId: string;
    course: { title: string; slug: string; level: string };
  } | null;
  quizzes: Array<{ id: string; question: string }>;
}

interface CourseRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  level: string;
  published: boolean;
  order: number;
  chapters: Array<{
    id: string;
    order: number;
    lessons: Array<{ id: string }>;
  }>;
  _count?: { enrollments: number };
}

interface EnrollmentRow {
  id: string;
  userId: string;
  courseId: string;
  progress: number;
  completedAt: Date | null;
  course?: {
    chapters: Array<{ lessons: Array<{ id: string }> }>;
  };
}

interface GlossaryRow {
  id: string;
  term: string;
  definition: string;
}

interface FindManyArgs {
  where?: Record<string, unknown>;
  take?: number;
  skip?: number;
}

interface PrismaRecorder {
  courses: CourseRow[];
  lessons: Map<string, LessonRow>;
  // enrollments keyed by `${userId}::${courseId}` (the composite unique)
  enrollments: Map<string, EnrollmentRow>;
  // enrollments keyed by id (for the findFirst ownership check in updateProgress)
  enrollmentsById: Map<string, EnrollmentRow>;
  glossary: GlossaryRow[];
  // completed-progress count per enrollmentId
  completedCounts: Map<string, number>;
  // recorded calls
  courseFindManyArgs: FindManyArgs[];
  enrollmentFindManyArgs: FindManyArgs[];
  glossaryFindManyArgs: FindManyArgs[];
  enrollmentFindFirstArgs: Array<{ id?: string; userId?: string }>;
  lessonProgressUpserts: Array<{
    where: { enrollmentId: string; lessonId: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }>;
  enrollmentUpdates: Array<{ id: string; data: Record<string, unknown> }>;
}

function newRecorder(): PrismaRecorder {
  return {
    courses: [],
    lessons: new Map(),
    enrollments: new Map(),
    enrollmentsById: new Map(),
    glossary: [],
    completedCounts: new Map(),
    courseFindManyArgs: [],
    enrollmentFindManyArgs: [],
    glossaryFindManyArgs: [],
    enrollmentFindFirstArgs: [],
    lessonProgressUpserts: [],
    enrollmentUpdates: [],
  };
}

/**
 * A recording prisma double for the learning models. Reads are honoured against
 * the recorder's in-memory stores so the live service's IDOR scoping
 * (`where: { userId }`, the composite `userId_courseId` key) is exercised for
 * real: a lookup for userA can never return userB's enrollment.
 */
function makePrismaStub(rec: PrismaRecorder) {
  return {
    course: {
      findMany: async (args: FindManyArgs) => {
        rec.courseFindManyArgs.push(args);
        return rec.courses.map((c) => ({ ...c }));
      },
      findUnique: async (args: { where: { slug: string } }) => {
        const c = rec.courses.find((x) => x.slug === args.where.slug);
        return c ? { ...c } : null;
      },
    },
    courseLesson: {
      findUnique: async (args: { where: { id: string } }) => {
        const l = rec.lessons.get(args.where.id);
        return l ? { ...l } : null;
      },
    },
    enrollment: {
      findUnique: async (args: {
        where: { userId_courseId: { userId: string; courseId: string } };
      }) => {
        const { userId, courseId } = args.where.userId_courseId;
        const e = rec.enrollments.get(`${userId}::${courseId}`);
        return e ? { ...e } : null;
      },
      findFirst: async (args: { where: { id: string; userId: string } }) => {
        rec.enrollmentFindFirstArgs.push({
          id: args.where.id,
          userId: args.where.userId,
        });
        const e = rec.enrollmentsById.get(args.where.id);
        // CRITICAL: only return it when the caller's userId matches (IDOR guard).
        if (!e || e.userId !== args.where.userId) return null;
        return { ...e };
      },
      findMany: async (args: FindManyArgs) => {
        rec.enrollmentFindManyArgs.push(args);
        const userId = (args.where as { userId?: string } | undefined)?.userId;
        const all = [...rec.enrollments.values()].filter(
          (e) => e.userId === userId
        );
        return all.map((e) => ({ ...e }));
      },
      create: async (args: { data: { userId: string; courseId: string } }) => {
        const row: EnrollmentRow = {
          id: `enr-${args.data.userId}-${args.data.courseId}`,
          userId: args.data.userId,
          courseId: args.data.courseId,
          progress: 0,
          completedAt: null,
        };
        rec.enrollments.set(`${row.userId}::${row.courseId}`, row);
        rec.enrollmentsById.set(row.id, row);
        return { ...row };
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        rec.enrollmentUpdates.push({ id: args.where.id, data: args.data });
        const e = rec.enrollmentsById.get(args.where.id);
        if (!e) throw new Error("no enrollment to update");
        Object.assign(e, args.data);
        return { ...e };
      },
    },
    courseLessonProgress: {
      upsert: async (args: {
        where: {
          enrollmentId_lessonId: { enrollmentId: string; lessonId: string };
        };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        rec.lessonProgressUpserts.push({
          where: args.where.enrollmentId_lessonId,
          create: args.create,
          update: args.update,
        });
        return { id: "lp-1" };
      },
      count: async (args: {
        where: { enrollmentId: string; completed: boolean };
      }) => {
        return rec.completedCounts.get(args.where.enrollmentId) ?? 0;
      },
    },
    glossaryTerm: {
      findMany: async (args: FindManyArgs) => {
        rec.glossaryFindManyArgs.push(args);
        return rec.glossary.map((g) => ({ ...g }));
      },
    },
  };
}

// ── module-boundary injection ───────────────────────────────────────

type ServiceModule =
  typeof import("../../../../packages/services/src/learning.service");

const dbPath = require.resolve("@usemoney/database");
const logPath = require.resolve("@usemoney/logger");
const svcPath =
  require.resolve("../../../../packages/services/src/learning.service");

function cacheMap(): Record<string, unknown> {
  return (require as unknown as { cache: Record<string, unknown> }).cache;
}

/**
 * Inject the recording prisma + a silent logger at the module boundary, then
 * (re)require the REAL learning service so it binds to our stub. The pure
 * `learning-logic` module (and its `@usemoney/core` import) loads for real —
 * only the DB + logger boundaries are swapped.
 */
function loadServiceWith(rec: PrismaRecorder): ServiceModule {
  const cache = cacheMap();
  delete cache[svcPath];
  delete cache[dbPath];
  delete cache[logPath];
  cache[dbPath] = {
    exports: {
      __esModule: true,
      prisma: makePrismaStub(rec),
      PlanType: {},
      Prisma: {},
    },
  };
  cache[logPath] = {
    exports: {
      __esModule: true,
      dbLogger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../../../packages/services/src/learning.service") as ServiceModule;
}

function clearSeam(): void {
  const cache = cacheMap();
  delete cache[svcPath];
  delete cache[dbPath];
  delete cache[logPath];
}

// ── helpers ──

function makeLesson(over: Partial<LessonRow> & { id: string }): LessonRow {
  return {
    title: "Lesson",
    content: "SECRET BODY",
    videoUrl: "https://video.example/secret.m3u8",
    type: "VIDEO",
    order: 0,
    quizzes: [{ id: "q1", question: "What is a stock?" }],
    chapter: {
      id: "ch-1",
      title: "Chapter 1",
      courseId: "course-1",
      course: { title: "Course", slug: "course", level: "BEGINNER" },
    },
    ...over,
  };
}

function makeCourse(
  over: Partial<CourseRow> & { id: string; slug: string }
): CourseRow {
  return {
    title: "Course",
    description: "desc",
    level: "BEGINNER",
    published: true,
    order: 0,
    chapters: [{ id: "ch-1", order: 0, lessons: [{ id: "l1" }, { id: "l2" }] }],
    _count: { enrollments: 0 },
    ...over,
  };
}

describe("learning.service (LIVE) — getLessonById premium content gate", () => {
  let rec: PrismaRecorder;
  let svc: ServiceModule;

  beforeEach(() => {
    rec = newRecorder();
    svc = loadServiceWith(rec);
  });
  afterEach(clearSeam);

  it("[SECURITY][live] FREE caller is DENIED an ADVANCED lesson body (no content leak)", async () => {
    rec.lessons.set(
      "adv-1",
      makeLesson({
        id: "adv-1",
        chapter: {
          id: "ch",
          title: "Adv Ch",
          courseId: "c-adv",
          course: { title: "Adv", slug: "adv", level: "ADVANCED" },
        },
      })
    );
    const res = await svc.getLessonById("adv-1", "FREE");
    assert.equal(res.success, false);
    assert.equal(!res.success && res.code, "PREMIUM_REQUIRED");
    // The secret content/videoUrl are NOT present anywhere in the response.
    assert.ok(!("data" in res));
    assert.ok(!JSON.stringify(res).includes("SECRET BODY"));
    assert.ok(!JSON.stringify(res).includes("secret.m3u8"));
  });

  it("[SECURITY][live] PRO caller is ALSO denied ADVANCED content (PREMIUM+ only)", async () => {
    rec.lessons.set(
      "adv-2",
      makeLesson({
        id: "adv-2",
        chapter: {
          id: "ch",
          title: "Adv Ch",
          courseId: "c-adv",
          course: { title: "Adv", slug: "adv", level: "ADVANCED" },
        },
      })
    );
    const res = await svc.getLessonById("adv-2", "PRO");
    assert.equal(res.success, false);
    assert.equal(!res.success && res.code, "PREMIUM_REQUIRED");
  });

  it("[SECURITY][live] missing/garbage plan is denied ADVANCED content (fail closed)", async () => {
    rec.lessons.set(
      "adv-3",
      makeLesson({
        id: "adv-3",
        chapter: {
          id: "ch",
          title: "Adv Ch",
          courseId: "c-adv",
          course: { title: "Adv", slug: "adv", level: "ADVANCED" },
        },
      })
    );
    for (const plan of [undefined, null, "", "HACKER"]) {
      const res = await svc.getLessonById("adv-3", plan);
      assert.equal(res.success, false, `plan=${plan} must be denied`);
    }
  });

  it("[live] PREMIUM caller IS served the ADVANCED lesson body", async () => {
    rec.lessons.set(
      "adv-4",
      makeLesson({
        id: "adv-4",
        content: "PREMIUM CONTENT",
        chapter: {
          id: "ch",
          title: "Adv Ch",
          courseId: "c-adv",
          course: { title: "Adv", slug: "adv", level: "ADVANCED" },
        },
      })
    );
    const res = await svc.getLessonById("adv-4", "PREMIUM");
    assert.ok(res.success);
    assert.equal((res.data as { content: string }).content, "PREMIUM CONTENT");
  });

  it("[live] BEGINNER lesson is served to a FREE caller (free level, not gated)", async () => {
    rec.lessons.set("beg-1", makeLesson({ id: "beg-1" })); // default level BEGINNER
    const res = await svc.getLessonById("beg-1", "FREE");
    assert.ok(res.success);
    assert.equal((res.data as { id: string }).id, "beg-1");
  });

  it("[live] BEGINNER lesson served even with no plan passed (back-compat)", async () => {
    rec.lessons.set("beg-2", makeLesson({ id: "beg-2" }));
    const res = await svc.getLessonById("beg-2");
    assert.ok(res.success);
  });

  it("[live] a missing lesson returns 'Lesson not found' (before any gate)", async () => {
    const res = await svc.getLessonById("does-not-exist", "FREE");
    assert.equal(res.success, false);
    assert.equal(!res.success && res.error, "Lesson not found");
  });
});

describe("learning.service (LIVE) — getCourseBySlug IDOR + locked flag", () => {
  let rec: PrismaRecorder;
  let svc: ServiceModule;

  beforeEach(() => {
    rec = newRecorder();
    svc = loadServiceWith(rec);
  });
  afterEach(clearSeam);

  it("[IDOR][live] returns ONLY the caller's own enrollment for the course", async () => {
    rec.courses.push(makeCourse({ id: "course-1", slug: "intro" }));
    // Two users enrolled in the same course.
    rec.enrollments.set("alice::course-1", {
      id: "enr-alice",
      userId: "alice",
      courseId: "course-1",
      progress: 80,
      completedAt: null,
    });
    rec.enrollments.set("bob::course-1", {
      id: "enr-bob",
      userId: "bob",
      courseId: "course-1",
      progress: 10,
      completedAt: null,
    });

    const aliceRes = await svc.getCourseBySlug("intro", "alice");
    assert.ok(aliceRes.success);
    const aliceEnr = (aliceRes.data as { enrollment: EnrollmentRow | null })
      .enrollment;
    assert.ok(aliceEnr);
    assert.equal(aliceEnr.id, "enr-alice");
    assert.equal(aliceEnr.progress, 80);

    const bobRes = await svc.getCourseBySlug("intro", "bob");
    assert.ok(bobRes.success);
    const bobEnr = (bobRes.data as { enrollment: EnrollmentRow | null })
      .enrollment;
    assert.equal(bobEnr!.id, "enr-bob");
    // Alice never sees bob's row and vice-versa.
    assert.notEqual(aliceEnr.id, bobEnr!.id);
  });

  it("[IDOR][live] a user with no enrollment gets enrollment=null, never another user's", async () => {
    rec.courses.push(makeCourse({ id: "course-1", slug: "intro" }));
    rec.enrollments.set("bob::course-1", {
      id: "enr-bob",
      userId: "bob",
      courseId: "course-1",
      progress: 55,
      completedAt: null,
    });
    const res = await svc.getCourseBySlug("intro", "carol");
    assert.ok(res.success);
    assert.equal(
      (res.data as { enrollment: EnrollmentRow | null }).enrollment,
      null
    );
  });

  it("[live] locked=true on an ADVANCED course for FREE; false for PREMIUM", async () => {
    rec.courses.push(
      makeCourse({ id: "c-adv", slug: "adv", level: "ADVANCED" })
    );
    const free = await svc.getCourseBySlug("adv", "u1", "FREE");
    assert.ok(free.success);
    assert.equal((free.data as { locked: boolean }).locked, true);

    const prem = await svc.getCourseBySlug("adv", "u1", "PREMIUM");
    assert.ok(prem.success);
    assert.equal((prem.data as { locked: boolean }).locked, false);
  });

  it("[live] locked=false on a BEGINNER course regardless of plan", async () => {
    rec.courses.push(
      makeCourse({ id: "c-beg", slug: "beg", level: "BEGINNER" })
    );
    const res = await svc.getCourseBySlug("beg", "u1", "FREE");
    assert.ok(res.success);
    assert.equal((res.data as { locked: boolean }).locked, false);
  });

  it("[live] unknown slug returns 'Course not found'", async () => {
    const res = await svc.getCourseBySlug("nope", "u1");
    assert.equal(res.success, false);
    assert.equal(!res.success && res.error, "Course not found");
  });
});

describe("learning.service (LIVE) — updateLessonProgress (IDOR + progress fix)", () => {
  let rec: PrismaRecorder;
  let svc: ServiceModule;

  beforeEach(() => {
    rec = newRecorder();
    svc = loadServiceWith(rec);
  });
  afterEach(clearSeam);

  function seedEnrollment(
    userId: string,
    enrollmentId: string,
    totalLessons: number
  ): void {
    const lessons = Array.from({ length: totalLessons }, (_, i) => ({
      id: `l${i}`,
    }));
    const row: EnrollmentRow = {
      id: enrollmentId,
      userId,
      courseId: "course-1",
      progress: 0,
      completedAt: null,
      course: { chapters: [{ lessons }] },
    };
    rec.enrollments.set(`${userId}::course-1`, row);
    rec.enrollmentsById.set(enrollmentId, row);
  }

  it("[IDOR][live] a user CANNOT update progress on another user's enrollment", async () => {
    seedEnrollment("owner", "enr-1", 10);
    rec.completedCounts.set("enr-1", 5);
    // 'attacker' tries to write to owner's enrollment id.
    const res = await svc.updateLessonProgress("attacker", "enr-1", "l0", true);
    assert.equal(res.success, false);
    assert.equal(!res.success && res.error, "Enrollment not found");
    // The ownership findFirst was scoped to the ATTACKER's userId.
    assert.ok(
      rec.enrollmentFindFirstArgs.some(
        (a) => a.id === "enr-1" && a.userId === "attacker"
      )
    );
    // No progress write happened.
    assert.equal(rec.lessonProgressUpserts.length, 0);
    assert.equal(rec.enrollmentUpdates.length, 0);
  });

  it("[live] the owner CAN update progress; computed % is persisted", async () => {
    seedEnrollment("owner", "enr-2", 10);
    rec.completedCounts.set("enr-2", 5); // 5 of 10 completed
    const res = await svc.updateLessonProgress("owner", "enr-2", "l0", true);
    assert.ok(res.success);
    assert.equal((res.data as { progress: number }).progress, 50);
    // Persisted to the enrollment row.
    const wrote = rec.enrollmentUpdates.find((u) => u.id === "enr-2");
    assert.ok(wrote);
    assert.equal(wrote!.data.progress, 50);
  });

  it("[bug:over-100][live] a stale completed-count > total lessons caps progress at 100", async () => {
    seedEnrollment("owner", "enr-3", 10);
    rec.completedCounts.set("enr-3", 12); // orphaned rows: 12 completed of 10
    const res = await svc.updateLessonProgress("owner", "enr-3", "l0", true);
    assert.ok(res.success);
    assert.equal(
      (res.data as { progress: number }).progress,
      100,
      "must cap at 100, NOT 120"
    );
    assert.equal(
      rec.enrollmentUpdates.find((u) => u.id === "enr-3")!.data.progress,
      100
    );
  });

  it("[bug:div-by-zero][live] an empty course (0 lessons) yields 0% (NOT NaN%)", async () => {
    // enrollment whose course has a chapter with no lessons.
    const row: EnrollmentRow = {
      id: "enr-4",
      userId: "owner",
      courseId: "course-1",
      progress: 0,
      completedAt: null,
      course: { chapters: [{ lessons: [] }] },
    };
    rec.enrollments.set("owner::course-1", row);
    rec.enrollmentsById.set("enr-4", row);
    rec.completedCounts.set("enr-4", 0);
    const res = await svc.updateLessonProgress("owner", "enr-4", "l0", true);
    assert.ok(res.success);
    const progress = (res.data as { progress: number }).progress;
    assert.equal(progress, 0);
    assert.equal(Number.isNaN(progress), false);
    assert.equal(
      rec.enrollmentUpdates.find((u) => u.id === "enr-4")!.data.progress,
      0
    );
  });

  it("[live] completing the last lesson reports 100% (10 of 10)", async () => {
    seedEnrollment("owner", "enr-5", 10);
    rec.completedCounts.set("enr-5", 10);
    const res = await svc.updateLessonProgress("owner", "enr-5", "l9", true);
    assert.ok(res.success);
    assert.equal((res.data as { progress: number }).progress, 100);
  });

  it("[live] the upsert writes completedAt as a Date when completed=true, null when false", async () => {
    seedEnrollment("owner", "enr-6", 4);
    rec.completedCounts.set("enr-6", 1);
    await svc.updateLessonProgress("owner", "enr-6", "l0", true, 85);
    const up = rec.lessonProgressUpserts.find(
      (u) => u.where.enrollmentId === "enr-6"
    );
    assert.ok(up);
    assert.ok(up!.create.completedAt instanceof Date);
    assert.equal(up!.create.quizScore, 85);
    assert.equal(up!.create.userId, "owner"); // progress row is owner-scoped

    rec.lessonProgressUpserts.length = 0;
    await svc.updateLessonProgress("owner", "enr-6", "l1", false);
    const up2 = rec.lessonProgressUpserts.find(
      (u) => u.where.enrollmentId === "enr-6"
    );
    assert.equal(up2!.create.completedAt, null);
    assert.equal(up2!.update.completedAt, null);
  });
});

describe("learning.service (LIVE) — list pagination clamp reaches Prisma", () => {
  let rec: PrismaRecorder;
  let svc: ServiceModule;

  beforeEach(() => {
    rec = newRecorder();
    svc = loadServiceWith(rec);
  });
  afterEach(clearSeam);

  it("[bug:500][live] getCourses with NaN limit / negative skip clamps to safe take/skip", async () => {
    const res = await svc.getCourses({
      limit: NaN as unknown as number,
      skip: -10 as unknown as number,
    });
    assert.ok(res.success);
    const args = rec.courseFindManyArgs.at(-1)!;
    assert.equal(args.take, DEFAULT_LEARNING_LIMIT); // not NaN (Prisma would throw)
    assert.equal(args.skip, 0); // not negative
    assert.equal(Number.isFinite(args.take!), true);
  });

  it("[bug:memory][live] getCourses caps a huge limit at MAX_LEARNING_LIMIT", async () => {
    const res = await svc.getCourses({ limit: 999_999 });
    assert.ok(res.success);
    assert.equal(rec.courseFindManyArgs.at(-1)!.take, MAX_LEARNING_LIMIT);
  });

  it("[live] getCourses default page when no pagination is given", async () => {
    const res = await svc.getCourses({ level: "BEGINNER" });
    assert.ok(res.success);
    const args = rec.courseFindManyArgs.at(-1)!;
    assert.equal(args.take, DEFAULT_LEARNING_LIMIT);
    assert.equal(args.skip, 0);
  });

  it("[IDOR+pagination][live] getUserEnrollments is userId-scoped AND clamps pagination", async () => {
    rec.enrollments.set("alice::c1", {
      id: "e-a",
      userId: "alice",
      courseId: "c1",
      progress: 1,
      completedAt: null,
    });
    rec.enrollments.set("bob::c1", {
      id: "e-b",
      userId: "bob",
      courseId: "c1",
      progress: 2,
      completedAt: null,
    });
    const res = await svc.getUserEnrollments("alice", {
      limit: Number.POSITIVE_INFINITY as unknown as number,
      skip: -5 as unknown as number,
    });
    assert.ok(res.success);
    // Only alice's enrollment came back.
    const data = res.data as EnrollmentRow[];
    assert.equal(data.length, 1);
    assert.equal(data[0]!.userId, "alice");
    // The findMany was scoped to alice and clamped.
    const args = rec.enrollmentFindManyArgs.at(-1)!;
    assert.equal((args.where as { userId: string }).userId, "alice");
    assert.equal(args.take, DEFAULT_LEARNING_LIMIT); // Infinity clamped
    assert.equal(args.skip, 0); // negative clamped
  });

  it("[bug:500][live] getGlossaryTerms clamps NaN/negative pagination", async () => {
    const res = await svc.getGlossaryTerms("nifty", {
      limit: NaN as unknown as number,
      skip: -3 as unknown as number,
    });
    assert.ok(res.success);
    const args = rec.glossaryFindManyArgs.at(-1)!;
    assert.equal(args.take, DEFAULT_LEARNING_LIMIT);
    assert.equal(args.skip, 0);
  });

  it("[live] getGlossaryTerms passes a valid in-range page straight through", async () => {
    rec.glossary.push({ id: "g1", term: "Alpha", definition: "..." });
    const res = await svc.getGlossaryTerms(undefined, { limit: 30, skip: 5 });
    assert.ok(res.success);
    const args = rec.glossaryFindManyArgs.at(-1)!;
    assert.equal(args.take, 30);
    assert.equal(args.skip, 5);
  });
});

// ════════════════════════════════════════════════════════════════════
// PART 3 — LIVE ACTION (apps/web/lib/actions/learning.ts) via require.cache
// ════════════════════════════════════════════════════════════════════
//
// MONEY-1062 Fix 1/2: getLessonByIdAction / getCourseBySlugAction previously
// called getLessonById(lessonId) / getCourseBySlug(slug, userId) WITHOUT a
// planId. The service's fail-closed premium gate then treated every web caller
// as unentitled → every ADVANCED lesson returned PREMIUM_REQUIRED and every
// ADVANCED course rendered locked, PAYING PREMIUM/ULTIMATE users included. The
// fix resolves the caller's planId via getSubscription — the SAME source apps/api
// uses (apps/api/src/routes/v1/learning.ts#resolvePlanId) — and FORWARDS it.
//
// These drive the REAL action module with a RECORDING @usemoney/services stub and
// assert the forwarded planId (getLessonById 2nd arg / getCourseBySlug 3rd arg)
// plus the resulting outcome. The stub's getLessonById/getCourseBySlug apply the
// REAL exported gate (canAccessLessonContent / shouldGateAdvancedCourse) against
// an ADVANCED level, so the forwarded planId genuinely decides the result — no
// shadow (the gate is the production function; only the Prisma read is faked).

type LearningActionModule = typeof import("../../lib/actions/learning");

interface ActionHarness {
  authUserId: string | null;
  /** planId getSubscription resolves for the user. */
  subPlanId: string | null;
  /** false → getSubscription returns a ServiceResult failure (planId → null). */
  subSuccess: boolean;
  isDemo: boolean;
  // recorded forwarded arguments
  getSubscriptionArgs: string[];
  getLessonByIdArgs: Array<{ lessonId: string; planId?: string | null }>;
  getCourseBySlugArgs: Array<{
    slug: string;
    userId?: string;
    planId?: string | null;
  }>;
}

const LEARNING_ACTION_REL = "../../lib/actions/learning";

function newActionHarness(over: Partial<ActionHarness> = {}): ActionHarness {
  return {
    authUserId: "user-1",
    subPlanId: "PREMIUM",
    subSuccess: true,
    isDemo: false,
    getSubscriptionArgs: [],
    getLessonByIdArgs: [],
    getCourseBySlugArgs: [],
    ...over,
  };
}

function loadLearningAction(h: ActionHarness): LearningActionModule {
  const cache = cacheMap();
  const resolve = (p: string) => require.resolve(p);

  // @/lib/auth wraps getAuthenticatedUser in React cache() at module load
  // (undefined outside the Next runtime) — stub so the require doesn't blow up.
  cache[resolve("@/lib/auth")] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: async () =>
        h.authUserId ? { userId: h.authUserId } : null,
    },
  };
  cache[resolve("@/lib/demo/session")] = {
    exports: { __esModule: true, isDemoSession: async () => h.isDemo },
  };
  cache[resolve("@/lib/demo/data")] = {
    exports: { __esModule: true, demoCourses: [] },
  };

  cache[resolve("@usemoney/services")] = {
    exports: {
      __esModule: true,
      getSubscription: async (userId: string) => {
        h.getSubscriptionArgs.push(userId);
        return h.subSuccess
          ? { success: true, data: { planId: h.subPlanId } }
          : { success: false, error: "sub read failed" };
      },
      getLessonById: async (lessonId: string, planId?: string | null) => {
        h.getLessonByIdArgs.push({ lessonId, planId });
        // REAL gate (imported at top) against an ADVANCED lesson — no shadow.
        if (!canAccessLessonContent("ADVANCED", planId)) {
          return {
            success: false,
            error: "This lesson requires a premium subscription.",
            code: "PREMIUM_REQUIRED",
          };
        }
        return { success: true, data: { id: lessonId, level: "ADVANCED" } };
      },
      getCourseBySlug: async (
        slug: string,
        userId?: string,
        planId?: string | null
      ) => {
        h.getCourseBySlugArgs.push({ slug, userId, planId });
        return {
          success: true,
          data: {
            slug,
            level: "ADVANCED",
            enrollment: null,
            locked: shouldGateAdvancedCourse("ADVANCED", planId),
          },
        };
      },
      // Other barrel exports learning.ts imports at top level (unused here).
      getCourses: async () => ({ success: true, data: [] }),
      enrollInCourse: async () => ({ success: true, data: {} }),
      updateLessonProgress: async () => ({ success: true, data: {} }),
      getUserEnrollments: async () => ({ success: true, data: [] }),
      getGlossaryTerms: async () => ({ success: true, data: [] }),
    },
  };

  delete cache[resolve(LEARNING_ACTION_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(LEARNING_ACTION_REL) as LearningActionModule;
}

function clearLearningActionSeam(): void {
  const cache = cacheMap();
  for (const p of [
    LEARNING_ACTION_REL,
    "@/lib/auth",
    "@/lib/demo/session",
    "@/lib/demo/data",
    "@usemoney/services",
  ]) {
    try {
      delete cache[require.resolve(p)];
    } catch {
      // ignore modules that never resolved
    }
  }
}

describe("learning.ts ACTION — getLessonByIdAction forwards resolved planId (MONEY-1062 Fix 1)", () => {
  afterEach(clearLearningActionSeam);

  it("resolves planId via getSubscription and forwards it as the 2nd arg", async () => {
    const h = newActionHarness({ authUserId: "user-1", subPlanId: "PREMIUM" });
    const mod = loadLearningAction(h);
    await mod.getLessonByIdAction("adv-lesson");
    // getSubscription was called with the resolved internal userId (apps/api source).
    assert.deepEqual(h.getSubscriptionArgs, ["user-1"]);
    // and the resolved planId reached getLessonById as the SECOND argument.
    assert.equal(h.getLessonByIdArgs.length, 1);
    assert.equal(h.getLessonByIdArgs[0]!.lessonId, "adv-lesson");
    assert.equal(h.getLessonByIdArgs[0]!.planId, "PREMIUM");
  });

  it("PREMIUM caller + ADVANCED lesson → success (no longer wrongly locked out)", async () => {
    const h = newActionHarness({ subPlanId: "PREMIUM" });
    const mod = loadLearningAction(h);
    const res = await mod.getLessonByIdAction("adv-lesson");
    assert.equal(res.success, true);
    assert.equal((res.data as { id: string }).id, "adv-lesson");
  });

  it("[regression] FREE caller + ADVANCED lesson → PREMIUM_REQUIRED (gate stays closed)", async () => {
    const h = newActionHarness({ subPlanId: "FREE" });
    const mod = loadLearningAction(h);
    const res = await mod.getLessonByIdAction("adv-lesson");
    assert.equal(res.success, false);
    assert.equal((res as { code?: string }).code, "PREMIUM_REQUIRED");
    assert.equal(h.getLessonByIdArgs[0]!.planId, "FREE");
  });

  it("unauthenticated caller → no subscription lookup, planId undefined forwarded (ADVANCED gated)", async () => {
    const h = newActionHarness({ authUserId: null });
    const mod = loadLearningAction(h);
    const res = await mod.getLessonByIdAction("adv-lesson");
    assert.equal(h.getSubscriptionArgs.length, 0);
    assert.equal(h.getLessonByIdArgs[0]!.planId, undefined);
    assert.equal(res.success, false);
  });

  it("a failed getSubscription → planId null forwarded (fails CLOSED for ADVANCED)", async () => {
    const h = newActionHarness({ subSuccess: false });
    const mod = loadLearningAction(h);
    const res = await mod.getLessonByIdAction("adv-lesson");
    assert.equal(h.getLessonByIdArgs[0]!.planId, null);
    assert.equal(res.success, false);
  });
});

describe("learning.ts ACTION — getCourseBySlugAction forwards planId → locked flag (MONEY-1062 Fix 2)", () => {
  afterEach(clearLearningActionSeam);

  it("PREMIUM caller → getCourseBySlug receives planId as the 3rd arg → locked=false", async () => {
    const h = newActionHarness({ authUserId: "user-1", subPlanId: "PREMIUM" });
    const mod = loadLearningAction(h);
    const res = await mod.getCourseBySlugAction("adv-course");
    assert.equal(h.getCourseBySlugArgs.length, 1);
    assert.equal(h.getCourseBySlugArgs[0]!.slug, "adv-course");
    assert.equal(h.getCourseBySlugArgs[0]!.userId, "user-1");
    assert.equal(h.getCourseBySlugArgs[0]!.planId, "PREMIUM");
    assert.equal((res.data as { locked: boolean }).locked, false);
  });

  it("FREE caller → planId forwarded → ADVANCED course locked=true", async () => {
    const h = newActionHarness({ subPlanId: "FREE" });
    const mod = loadLearningAction(h);
    const res = await mod.getCourseBySlugAction("adv-course");
    assert.equal(h.getCourseBySlugArgs[0]!.planId, "FREE");
    assert.equal((res.data as { locked: boolean }).locked, true);
  });

  it("unauthenticated → userId undefined + planId undefined (ADVANCED locked)", async () => {
    const h = newActionHarness({ authUserId: null });
    const mod = loadLearningAction(h);
    const res = await mod.getCourseBySlugAction("adv-course");
    assert.equal(h.getSubscriptionArgs.length, 0);
    assert.equal(h.getCourseBySlugArgs[0]!.userId, undefined);
    assert.equal(h.getCourseBySlugArgs[0]!.planId, undefined);
    assert.equal((res.data as { locked: boolean }).locked, true);
  });
});
