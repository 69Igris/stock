/**
 * Step 5: Generate Roast Content (LLM)
 *
 * Uses Gemini 3 Pro with higher temperature for creativity.
 * Generates the roast highlights, performers, sector verdicts, advice, and narrative.
 */

import { getVertexAIClient } from "@usemoney/core/gemini";
import { geminiLogger as logger } from "@usemoney/logger";
import { buildRoastPrompt } from "../prompts";
import { parseLLMJson } from "../lib/parse-llm-json";
import type {
  PortfolioData,
  StockAnalysisResult,
  MfAnalysisResult,
  ScoresResult,
  RoastContentResult,
} from "../types";

export async function generateRoast(
  stockAnalysis: StockAnalysisResult | null,
  mfAnalysis: MfAnalysisResult | null,
  scores: ScoresResult,
  portfolio: PortfolioData,
  timeoutMs = 90000,
  scope: "PORTFOLIO" | "TRADEBOOK" = "PORTFOLIO",
): Promise<RoastContentResult> {
  const prompt = buildRoastPrompt(
    stockAnalysis,
    mfAnalysis,
    scores,
    portfolio,
    scope,
  );

  const vertexAI = getVertexAIClient();
  const model = vertexAI.getGenerativeModel({
    model: "gemini-2.5-pro",
    generationConfig: {
      temperature: 0.9,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    },
  });

  const result = await Promise.race([
    model.generateContent(prompt),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Roast generation timed out")),
        timeoutMs,
      ),
    ),
  ]);

  const text = (result.response.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");

  if (!text) {
    throw new Error("No response from Gemini for roast generation");
  }

  logger.info(
    { responseLength: text.length },
    "Roast content LLM response received",
  );

  // Resilient parse: returns the empty fallback if JSON is unrecoverable
  // (the agent then continues with a barebones roast rather than failing
  // the whole session with a "Unterminated string at position N" error).
  const parsed = parseLLMJson<Partial<RoastContentResult>>(
    text,
    {},
    "generate-roast",
  );
  return {
    roastHighlights: parsed.roastHighlights || [],
    topPerformers: parsed.topPerformers || [],
    worstPerformers: parsed.worstPerformers || [],
    sectorAnalysis: parsed.sectorAnalysis || [],
    constructiveAdvice: parsed.constructiveAdvice || [],
    roastNarrative:
      parsed.roastNarrative ||
      "The AI couldn't generate a narrative this time.",
  };
}
