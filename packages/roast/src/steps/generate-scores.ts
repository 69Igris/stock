/**
 * Step 4: Generate Scores (LLM)
 *
 * Uses Gemini 3 Pro with JSON mode to generate the 4 score categories
 * based on the combined stock + MF analysis.
 */

import { getVertexAIClient } from "@usemoney/core/gemini";
import { geminiLogger as logger } from "@usemoney/logger";
import { buildScoresPrompt } from "../prompts";
import { parseLLMJson } from "../lib/parse-llm-json";
import { assembleScores } from "../lib/score-utils";
import type {
  PortfolioData,
  StockAnalysisResult,
  MfAnalysisResult,
  ScoresResult,
} from "../types";

export async function generateScores(
  stockAnalysis: StockAnalysisResult | null,
  mfAnalysis: MfAnalysisResult | null,
  portfolio: PortfolioData,
  timeoutMs = 60000,
): Promise<ScoresResult> {
  const prompt = buildScoresPrompt(stockAnalysis, mfAnalysis, portfolio);

  const vertexAI = getVertexAIClient();
  const model = vertexAI.getGenerativeModel({
    model: "gemini-2.5-pro",
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  });

  const result = await Promise.race([
    model.generateContent(prompt),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Score generation timed out")),
        timeoutMs,
      ),
    ),
  ]);

  const text = (result.response.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");

  if (!text) {
    throw new Error("No response from Gemini for score generation");
  }

  logger.info({ responseLength: text.length }, "Scores LLM response received");

  // MONEY-488: resilient parse — degrades to all 50s if JSON is
  // unrecoverable. assembleScores() treats undefined/NaN as 50, so the empty
  // fallback yields a "neutral" score card rather than failing the roast.
  const parsed = parseLLMJson<Partial<ScoresResult>>(
    text,
    {},
    "generate-scores",
  );

  // MONEY-620: validate + clamp via the shared pure helper so the production
  // path and the unit tests execute the SAME score-shaping logic (no shadow).
  return assembleScores(parsed);
}
