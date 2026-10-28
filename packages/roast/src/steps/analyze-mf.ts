/**
 * Step 3: Analyze Mutual Funds (LLM)
 *
 * Uses Gemini 3 Pro with JSON mode to analyze MF holdings
 * for category overlap, performance, and expense concerns.
 */

import { getVertexAIClient } from "@usemoney/core/gemini";
import { geminiLogger as logger } from "@usemoney/logger";
import { buildMfAnalysisPrompt } from "../prompts";
import { parseLLMJson } from "../lib/parse-llm-json";
import type { PortfolioData, MfAnalysisResult } from "../types";

export async function analyzeMf(
  portfolio: PortfolioData,
  timeoutMs = 60000,
): Promise<MfAnalysisResult> {
  const prompt = buildMfAnalysisPrompt(portfolio);

  const vertexAI = getVertexAIClient();
  const model = vertexAI.getGenerativeModel({
    model: "gemini-2.5-pro",
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
    },
  });

  const result = await Promise.race([
    model.generateContent(prompt),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("MF analysis timed out")), timeoutMs),
    ),
  ]);

  const text = (result.response.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");

  if (!text) {
    throw new Error("No response from Gemini for MF analysis");
  }

  logger.info(
    { responseLength: text.length },
    "MF analysis LLM response received",
  );

  // MONEY-488: resilient parse — empty fallback rather than throwing.
  const parsed = parseLLMJson<Partial<MfAnalysisResult>>(
    text,
    {},
    "analyze-mf",
  );
  return {
    categoryOverlap: parsed.categoryOverlap || [],
    performanceVerdict: parsed.performanceVerdict || "Unable to assess",
    expenseIssues: parsed.expenseIssues || [],
    mfHighlights: parsed.mfHighlights || [],
  };
}
