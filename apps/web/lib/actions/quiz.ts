"use server";

import { getAuthenticatedUser } from "@/lib/auth";
import { requireFeature } from "./premium-gate";
import { getGeminiModel, generateWithTimeout } from "@/lib/gemini/models";
import {
  clampCount,
  processQuizResponse,
  validateQuizInput,
  type GenerateQuizInput,
  type QuizQuestion,
  type QuizResult,
} from "./quiz-logic";

export async function generateQuizAction(
  input: GenerateQuizInput
): Promise<QuizResult> {
  try {
    // MONEY-1142 — resolve the INTERNAL user, not the Clerk one: the tier gate
    // below looks up a subscription by internal id, and a Clerk id would match
    // nothing and deny everyone. `validateQuizInput` only needs `{ id }` and
    // only checks truthiness, so the shape is preserved.
    const authUser = await getAuthenticatedUser();

    const validationError = validateQuizInput(
      authUser ? { id: authUser.userId } : null,
      input
    );
    if (validationError) {
      return validationError;
    }

    // `/quizzes` maps to the `advancedCourses` feature. Non-null assertion is
    // safe: `validateQuizInput` returns early on a null user.
    const denied = await requireFeature(authUser!.userId, "advancedCourses");
    if (denied) return denied;

    const { topic, difficulty, count } = input;
    const questionCount = clampCount(count);

    const model = getGeminiModel("fast");

    const prompt = `You are a financial education quiz generator specializing in Indian stock markets (NSE/BSE).

Generate ${questionCount} multiple-choice questions about "${topic}" at ${difficulty} difficulty level.

Return ONLY valid JSON array (no markdown, no code blocks):
[
  {
    "question": "Question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": 0,
    "explanation": "Brief explanation of the correct answer"
  }
]

Rules:
- Each question must have exactly 4 options
- correctAnswer is a 0-based index (0, 1, 2, or 3)
- Explanations should be concise and educational
- Questions should be relevant to Indian market context where applicable
- ${difficulty} level: ${difficulty === "Beginner" ? "Basic concepts, definitions, simple scenarios" : difficulty === "Intermediate" ? "Application of concepts, analysis scenarios, moderate complexity" : "Complex scenarios, advanced concepts, multi-step reasoning"}`;

    const response = await generateWithTimeout(model, prompt, 20000);

    // Parse + validate the AI response (markdown-fence stripping, per-question
    // validation, error-message mapping) via the shared pure helper.
    return processQuizResponse(response);
  } catch {
    return {
      success: false,
      error: "Failed to generate quiz. Please try again.",
    };
  }
}

// Re-export the shared types so existing importers of this module keep working.
export type { QuizQuestion, GenerateQuizInput };
