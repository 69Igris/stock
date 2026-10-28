/**
 * Quiz scoring — pure logic (no Prisma, no server-only deps).
 *
 * The DB-backed quiz surface (a `CourseLesson`'s `Quiz[]` question set) needs
 * two pure operations that must never touch a service or the network:
 *   - stripping the answer key before a quiz is served to the client
 *     ({@link toPublicQuestion}) so the correct index / explanation is only
 *     revealed on submit, and
 *   - scoring a submission ({@link scoreQuiz}) with a finite-guarded percentage
 *     (a 0-question quiz can never produce `NaN%`).
 *
 * The AI-GENERATED quiz path (`apps/web/lib/actions/quiz.ts`, topic → Gemini)
 * is DEFERRED to MONEY-1067 — it is web/Gemini-coupled and out of scope here.
 * This module owns only the non-AI CRUD/score seam.
 *
 * @see packages/services/src/quiz.service.ts
 * @see packages/services/__tests__/quiz-service.test.ts
 */

/** A quiz question row as stored (answer key included). */
export interface QuizQuestionRow {
  id: string;
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string | null;
  order: number;
}

/** A quiz question SAFE to serve pre-submit (answer key stripped). */
export interface PublicQuizQuestion {
  id: string;
  question: string;
  options: string[];
  order: number;
}

/** Per-question outcome after scoring a submission. */
export interface QuizAnswerResult {
  questionId: string;
  /** The index the caller picked, or `null` when unanswered / invalid. */
  selected: number | null;
  correctAnswer: number;
  correct: boolean;
  /** Revealed only in the score result (never in the pre-submit read). */
  explanation: string | null;
}

/** The scored result of a whole submission. */
export interface QuizScore {
  total: number;
  answered: number;
  correctCount: number;
  /** Integer percent in `[0, 100]`; a 0-question quiz scores 0 (no `NaN%`). */
  scorePct: number;
  results: QuizAnswerResult[];
}

/** Order questions deterministically (by `order`, then `id` as a tiebreak). */
export function sortByOrder(questions: QuizQuestionRow[]): QuizQuestionRow[] {
  return [...questions].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
}

/** Strip the answer key (correctAnswer + explanation) for the pre-submit read. */
export function toPublicQuestion(q: QuizQuestionRow): PublicQuizQuestion {
  return {
    id: q.id,
    question: q.question,
    options: q.options,
    order: q.order,
  };
}

/** Clamp a raw percentage into an integer `[0, 100]` (non-finite → 0). */
export function clampPct(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 100) return 100;
  return Math.round(n);
}

/**
 * Score a positional submission against the (order-sorted) question set.
 *
 * `answers[i]` is the index the caller picked for the i-th ordered question; a
 * non-integer / out-of-array / missing entry counts as unanswered (`null`,
 * never correct). The percentage is finite-guarded — an empty question set
 * yields `scorePct: 0`, not `NaN`.
 */
export function scoreQuiz(
  questions: QuizQuestionRow[],
  answers: ReadonlyArray<number | null | undefined>,
): QuizScore {
  const sorted = sortByOrder(questions);
  const total = sorted.length;

  const results: QuizAnswerResult[] = sorted.map((q, i) => {
    const raw = Array.isArray(answers) ? answers[i] : undefined;
    const selected =
      typeof raw === "number" && Number.isInteger(raw) ? raw : null;
    return {
      questionId: q.id,
      selected,
      correctAnswer: q.correctAnswer,
      correct: selected !== null && selected === q.correctAnswer,
      explanation: q.explanation ?? null,
    };
  });

  const correctCount = results.filter((r) => r.correct).length;
  const answered = results.filter((r) => r.selected !== null).length;
  const scorePct = clampPct(total > 0 ? (correctCount / total) * 100 : 0);

  return { total, answered, correctCount, scorePct, results };
}
