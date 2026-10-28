/**
 * Quiz Service (MONEY-402 mobile-parity)
 *
 * The non-AI, DB-backed quiz surface: list the lessons that carry a quiz, read a
 * lesson's quiz (answer key stripped), and score a submission. A "quiz" here is a
 * `CourseLesson`'s `Quiz[]` question set, keyed by `lessonId`.
 *
 * DEFERRED: the AI-GENERATED quiz path (topic → Gemini) in
 * `apps/web/lib/actions/quiz.ts` is web/Gemini-coupled → MONEY-1067.
 *
 * DATA MODEL NOTE: quiz content is GLOBAL catalog data (like courses / lessons /
 * glossary in `learning.service`), not per-user rows — there is nothing to
 * ownership-scope on a read. `userId` is still threaded through (route auth is
 * enforced upstream) and used for audit logging. Submit scoring is STATELESS:
 * recording the score into `CourseLessonProgress.quizScore` needs an
 * enrollment/course context the mobile submit contract does not carry, so
 * persistence stays with `learning.service.updateLessonProgress` (deferred here).
 *
 * @see packages/services/src/quiz-logic.ts (pure scoring / answer-strip seam)
 * @see packages/services/__tests__/quiz-service.test.ts
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import {
  scoreQuiz,
  sortByOrder,
  toPublicQuestion,
  type PublicQuizQuestion,
  type QuizQuestionRow,
  type QuizScore,
} from "./quiz-logic";

/** A lesson that carries a quiz, for the catalogue list. */
export interface QuizSummary {
  lessonId: string;
  title: string;
  questionCount: number;
}

/** A lesson's quiz served to the client (answer key stripped). */
export interface QuizDetail {
  lessonId: string;
  title: string;
  questions: PublicQuizQuestion[];
}

/** Positional answer submission (aligned to the order-sorted question set). */
export interface SubmitQuizInput {
  answers: ReadonlyArray<number | null>;
}

/**
 * Injectable IO seam. `@usemoney/services` runs its suite as ESM (no
 * `require.cache` prisma injection), so tests pass a fake prisma via `deps`.
 */
export interface QuizServiceDeps {
  prisma?: typeof prisma;
}

const QUIZ_SELECT = {
  id: true,
  question: true,
  options: true,
  correctAnswer: true,
  explanation: true,
  order: true,
} as const;

/**
 * List the lessons that carry at least one quiz (catalogue read, paginated).
 */
export async function listQuizzes(
  userId: string,
  input: { limit?: number; skip?: number } = {},
  deps: QuizServiceDeps = {},
): Promise<ServiceResult<QuizSummary[]>> {
  const db = deps.prisma ?? prisma;
  const take = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const skip = Math.max(input.skip ?? 0, 0);
  try {
    const lessons = await db.courseLesson.findMany({
      where: { quizzes: { some: {} } },
      select: { id: true, title: true, _count: { select: { quizzes: true } } },
      orderBy: { order: "asc" },
      take,
      skip,
    });
    return {
      success: true,
      data: lessons.map((l) => ({
        lessonId: l.id,
        title: l.title,
        questionCount: l._count.quizzes,
      })),
    };
  } catch (error) {
    logger.error({ error, userId }, "List quizzes service error");
    return { success: false, error: "Failed to fetch quizzes" };
  }
}

/**
 * Read a lesson's quiz with the answer key STRIPPED (correct index +
 * explanation are revealed only by {@link submitQuiz}).
 */
export async function getQuiz(
  userId: string,
  lessonId: string,
  deps: QuizServiceDeps = {},
): Promise<ServiceResult<QuizDetail>> {
  const db = deps.prisma ?? prisma;
  try {
    const lesson = await db.courseLesson.findUnique({
      where: { id: lessonId },
      select: {
        id: true,
        title: true,
        quizzes: { select: QUIZ_SELECT },
      },
    });
    if (!lesson || lesson.quizzes.length === 0) {
      return { success: false, error: "Quiz not found" };
    }
    return {
      success: true,
      data: {
        lessonId: lesson.id,
        title: lesson.title,
        questions: sortByOrder(lesson.quizzes as QuizQuestionRow[]).map(
          toPublicQuestion,
        ),
      },
    };
  } catch (error) {
    logger.error({ error, userId, lessonId }, "Get quiz service error");
    return { success: false, error: "Failed to fetch quiz", code: "INTERNAL" };
  }
}

/**
 * Score a positional submission for a lesson's quiz. Stateless: returns the
 * per-question outcome (with the now-revealed answer key) but does NOT persist.
 */
export async function submitQuiz(
  userId: string,
  lessonId: string,
  input: SubmitQuizInput,
  deps: QuizServiceDeps = {},
): Promise<ServiceResult<QuizScore>> {
  const db = deps.prisma ?? prisma;
  try {
    const questions = await db.quiz.findMany({
      where: { lessonId },
      select: QUIZ_SELECT,
    });
    if (questions.length === 0) {
      return { success: false, error: "Quiz not found" };
    }
    const answers = Array.isArray(input?.answers) ? input.answers : [];
    return {
      success: true,
      data: scoreQuiz(questions as QuizQuestionRow[], answers),
    };
  } catch (error) {
    logger.error({ error, userId, lessonId }, "Submit quiz service error");
    return { success: false, error: "Failed to score quiz", code: "INTERNAL" };
  }
}
