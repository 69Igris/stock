/**
 * Step 2: Analyze Stocks (LLM)
 *
 * Uses Gemini 3 Pro with JSON mode to analyze stock holdings
 * for diversification, risk, and quality.
 */

import { getVertexAIClient } from "@usemoney/core/gemini";
import { geminiLogger as logger } from "@usemoney/logger";
import { buildStockAnalysisPrompt } from "../prompts";
import { parseLLMJson } from "../lib/parse-llm-json";
import type { PortfolioData, StockAnalysisResult } from "../types";

export async function analyzeStocks(
  portfolio: PortfolioData,
  timeoutMs = 60000,
): Promise<StockAnalysisResult> {
  const prompt = buildStockAnalysisPrompt(portfolio);

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
      setTimeout(
        () => reject(new Error("Stock analysis timed out")),
        timeoutMs,
      ),
    ),
  ]);

  const text = (result.response.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");

  if (!text) {
    throw new Error("No response from Gemini for stock analysis");
  }

  logger.info(
    { responseLength: text.length },
    "Stock analysis LLM response received",
  );

  // MONEY-488: resilient parse — empty fallback rather than throwing on
  // truncated / malformed JSON. Each missing array degrades gracefully via
  // the `|| []` defaults below.
  const parsed = parseLLMJson<Partial<StockAnalysisResult>>(
    text,
    {},
    "analyze-stocks",
  );
  return {
    diversificationIssues: parsed.diversificationIssues || [],
    sectorConcentration: parsed.sectorConcentration || [],
    topPicks: parsed.topPicks || [],
    bottomPicks: parsed.bottomPicks || [],
    riskFlags: parsed.riskFlags || [],
  };
}
