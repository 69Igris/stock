/**
 * Pure logic for quiz actions (extracted from quizzes.ts).
 *
 * Holds the create-input validation and the generated-question → create-data
 * mapping used by the quiz server actions, plus the option/answer validators.
 * Extracted so they can be unit tested without importing the action (which
 * drags Prisma + Clerk). The actions in quizzes.ts call these helpers.
 *
 * @see apps/admin/__tests__/actions/quizzes.test.ts
 */

export interface QuizInput {
  lessonId: string;
  question: string;
  options: string[];
  correctAnswer: number;
  explanation?: string;
  order?: number;
}

/**
 * Shape of an AI-generated quiz question (matches `QuizQuestion` from
 * @usemoney/content-engine). Declared locally so this module stays free of the
 * content-engine's Gemini imports.
 */
export interface GeneratedQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
}

/**
 * Validates required fields for createQuiz.
 * Returns the error message when invalid, or null when valid.
 */
export function validateQuizInput(data: Partial<QuizInput>): string | null {
  if (!data.lessonId || !data.question) {
    return "Missing required fields: lessonId, question";
  }
  return null;
}

/**
 * Maps generated quiz questions to create-data format, assigning the
 * positional index as the lesson order.
 */
export function mapGeneratedQuestions(
  lessonId: string,
  questions: GeneratedQuestion[],
): QuizInput[] {
  return questions.map((q, i) => ({
    lessonId,
    question: q.question,
    options: q.options,
    correctAnswer: q.correctAnswer,
    explanation: q.explanation,
    order: i,
  }));
}

/**
 * Validates quiz options structure.
 * Options must be an array with at least 2 items, all non-empty strings.
 */
export function validateQuizOptions(options: unknown): string | null {
  if (!Array.isArray(options)) return "Options must be an array";
  if (options.length < 2) return "Options must have at least 2 items";
  if (
    options.some((opt: unknown) => typeof opt !== "string" || opt.trim() === "")
  ) {
    return "All options must be non-empty strings";
  }
  return null;
}

/**
 * Validates a correctAnswer index against the options array.
 */
export function validateCorrectAnswer(
  correctAnswer: number,
  options: string[],
): string | null {
  if (typeof correctAnswer !== "number")
    return "correctAnswer must be a number";
  if (correctAnswer < 0) return "correctAnswer must be non-negative";
  if (correctAnswer >= options.length)
    return "correctAnswer index out of bounds";
  if (!Number.isInteger(correctAnswer))
    return "correctAnswer must be an integer";
  return null;
}
