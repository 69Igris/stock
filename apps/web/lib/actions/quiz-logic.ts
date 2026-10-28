/**
 * Quiz generation — pure logic (no server-only deps).
 *
 * Extracted from `lib/actions/quiz.ts` (a `"use server"` action that drags in
 * Clerk + the Gemini client) so the input validation, the question-count clamp,
 * the AI-response JSON parsing (markdown-fence stripping), the per-question
 * validation filter, and the response assembly can be unit-tested against the
 * REAL exported symbols instead of inline copies.
 *
 * The server action owns auth + the Gemini call and imports everything here.
 * This module imports nothing server-only, so the tests stay pure and exit
 * cleanly.
 *
 * @see apps/web/__tests__/actions/quiz.test.ts
 */

export interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
}

export interface GenerateQuizInput {
  topic: string;
  difficulty: "Beginner" | "Intermediate" | "Advanced";
  count: number;
}

export interface QuizResult {
  success: boolean;
  data?: QuizQuestion[];
  error?: string;
}

/** Default question count when `count` is absent / falsy. */
export const DEFAULT_QUESTION_COUNT = 5;
/** Inclusive question-count bounds. */
export const MIN_QUESTION_COUNT = 3;
export const MAX_QUESTION_COUNT = 10;

/**
 * Validate the request preconditions. Returns an error `QuizResult` when invalid
 * (auth missing, topic too short / empty / too long), or `null` when the input
 * passes and generation may proceed.
 */
export function validateQuizInput(
  user: { id: string } | null,
  input: GenerateQuizInput
): QuizResult | null {
  if (!user) {
    return { success: false, error: "Authentication required" };
  }

  const { topic } = input;

  if (!topic || topic.length < 3) {
    return { success: false, error: "Please provide a more specific topic" };
  }

  if (topic.length > 500) {
    return { success: false, error: "Topic too long (max 500 chars)" };
  }

  return null; // valid
}

/**
 * Clamp the requested question count into [3, 10], defaulting a falsy value
 * (0 / NaN / undefined) to 5.
 * Mirrors: `Math.min(Math.max(count || 5, 3), 10)`.
 */
export function clampCount(count: number | undefined): number {
  return Math.min(
    Math.max(count || DEFAULT_QUESTION_COUNT, MIN_QUESTION_COUNT),
    MAX_QUESTION_COUNT
  );
}

/**
 * Parse the raw Gemini response into questions, stripping a leading
 * ```` ```json ```` / ```` ``` ```` fence and a trailing ```` ``` ```` fence.
 * Throws `SyntaxError` on malformed JSON (handled by the caller).
 */
export function parseQuizJSON(response: string): QuizQuestion[] {
  let jsonStr = response.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return JSON.parse(jsonStr) as QuizQuestion[];
}

/**
 * A question is well-formed iff it has non-empty text, exactly 4 options, a
 * numeric `correctAnswer` index in [0, 3], and a non-empty explanation.
 */
export function isValidQuestion(q: QuizQuestion): boolean {
  return Boolean(
    q.question &&
    Array.isArray(q.options) &&
    q.options.length === 4 &&
    typeof q.correctAnswer === "number" &&
    q.correctAnswer >= 0 &&
    q.correctAnswer <= 3 &&
    q.explanation
  );
}

/**
 * Validate the parsed questions array, dropping malformed entries. Returns an
 * error `QuizResult` when the array is empty / not an array, or when no question
 * survives validation; otherwise the success result with the valid subset.
 */
export function validateQuestions(questions: unknown): QuizResult {
  if (!Array.isArray(questions) || questions.length === 0) {
    return {
      success: false,
      error: "AI generated an invalid quiz. Please try again.",
    };
  }

  const validQuestions = (questions as QuizQuestion[]).filter(isValidQuestion);

  if (validQuestions.length === 0) {
    return {
      success: false,
      error: "AI generated invalid questions. Please try again.",
    };
  }

  return { success: true, data: validQuestions };
}

/**
 * Parse + validate a raw Gemini response into a `QuizResult`, mapping a JSON
 * `SyntaxError` to the parse-failure message and any other error to the generic
 * generation-failure message.
 */
export function processQuizResponse(response: string): QuizResult {
  try {
    const questions = parseQuizJSON(response);
    return validateQuestions(questions);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        success: false,
        error: "Failed to parse AI response. Please try again.",
      };
    }
    return {
      success: false,
      error: "Failed to generate quiz. Please try again.",
    };
  }
}
