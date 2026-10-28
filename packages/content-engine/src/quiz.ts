import { getVertexAIClient, isGeminiEnabled } from "@usemoney/core/gemini";
import type { GenerateQuizOptions, QuizQuestion } from "./types";

/**
 * Generate quiz questions using Gemini AI
 */
export async function generateQuizQuestions(
  options: GenerateQuizOptions,
): Promise<QuizQuestion[]> {
  if (!isGeminiEnabled()) {
    throw new Error("Gemini AI is not enabled. Set USE_GEMINI=true.");
  }

  const { topic, difficulty, count = 5 } = options;

  const client = getVertexAIClient();
  const model = client.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 4096,
    },
  });

  const prompt = `Generate ${count} multiple-choice quiz questions about "${topic}" for ${difficulty} level learners.

Context: Indian stock markets (NSE, BSE), SEBI regulations, Indian companies, and INR-based examples.

Requirements:
- Each question should have exactly 4 options
- Only one correct answer per question
- Include a brief explanation for the correct answer
- Questions should progressively increase in difficulty
- Use practical, real-world scenarios relevant to Indian investors

Return ONLY a valid JSON array (no markdown, no code blocks):
[
  {
    "question": "<question text>",
    "options": ["<option A>", "<option B>", "<option C>", "<option D>"],
    "correctAnswer": <0-3 index of correct option>,
    "explanation": "<brief explanation of correct answer>"
  }
]`;

  const result = await model.generateContent(prompt);
  const response = result.response;
  const text = response.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error("No quiz response from Gemini");
  }

  const jsonStr = text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  const questions = JSON.parse(jsonStr) as QuizQuestion[];

  return questions;
}
